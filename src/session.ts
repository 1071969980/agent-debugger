/** Debug session state machine + command handlers. */

import { resolve as pathResolve, dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import { DAPClient } from "./dap-client.js";
import type { AdapterConfig, SubprocessInfo } from "./adapters/base.js";
import { getAdapterForFile, getAdapter } from "./adapters/registry.js";
import { SubprocessSession } from "./subprocess-session.js";
import { DebugController } from "./debug-controller.js";
import { generateSessionId } from "./util/paths.js";
import type { Command, CommandResult } from "./protocol.js";
import { STOP_REASON, isExceptionReason } from "./protocol.js";

export type SessionState = "idle" | "starting" | "running" | "paused" | "terminated";

export class Session {
  private _state: SessionState = "idle";
  get state(): SessionState {
    return this.controller?.state ?? this._state;
  }
  private client: DAPClient | null = null;
  private adapter: AdapterConfig | null = null;
  private adapterProcess: ChildProcess | null = null;
  private _scriptPath: string | null = null;
  /** Path of the debugged script (set in launch mode). */
  get scriptPath(): string | null { return this._scriptPath; }
  /** True when connected via attach (don't kill the debuggee on close). */
  private attachedMode = false;
  /** Subprocess sessions managed by this parent session. */
  private subprocessSessions = new Map<string, SubprocessSession>();
  /** Stored runtime path for spawning subprocess adapters later. */
  private runtimePath: string | undefined;
  /** Connection host/port for startDebugging reverse request subprocess handling. */
  private connectHost: string | null = null;
  private connectPort: number | null = null;
  /** Debug controller — created after client connects. */
  private controller: DebugController | null = null;

  async handleCommand(cmd: Command): Promise<CommandResult> {
    switch (cmd.action) {
      case "start":
        return this.startSession(cmd);
      case "attach":
        return this.attachSession(cmd);
      case "close":
        return this.close();
      case "list":
      case "shutdown":
      case "subprocess":
        return { error: `Action '${cmd.action}' is handled by the daemon, not a session` };
      default:
        if (!this.controller) return { error: "No active debug session" };
        return this.controller.handleCommand(cmd);
    }
  }

  private async startSession(cmd: Extract<Command, { action: "start" }>): Promise<CommandResult> {
    if (this._state !== "idle") {
      return { error: "Session already active. Run 'agent-debugger close' first." };
    }

    const script = pathResolve(cmd.script);
    this._scriptPath = script;
    this._state = "starting";

    // Detect language and get adapter
    const language = cmd.language;
    if (language) {
      this.adapter = getAdapter(language);
    } else {
      this.adapter = getAdapterForFile(script);
    }
    if (!this.adapter) {
      this._state = "idle";
      return { error: `Unsupported file type: ${script}. Supported: .py, .js, .ts, .go, .rs, .c, .cpp` };
    }

    // Check adapter is installed
    const installErr = await this.adapter.checkInstalled(cmd.runtime);
    if (installErr) {
      this._state = "idle";
      return { error: installErr };
    }

    // Spawn debug adapter
    let adapterPort: number;
    try {
      const spawnResult = await this.adapter.spawn({
        program: script,
        args: cmd.args,
        cwd: cmd.cwd || dirname(script),
        stopOnEntry: cmd.stop_on_entry,
        runtimePath: cmd.runtime,
      });
      this.adapterProcess = spawnResult.process;
      adapterPort = spawnResult.port;

      // Connect DAP client
      this.client = new DAPClient();
      await this.client.connect("127.0.0.1", adapterPort);
    } catch (err) {
      this._state = "idle";
      return { error: `Failed to start debug adapter: ${(err as Error).message}` };
    }

    // Create debug controller (start in "starting" state until initFlow completes)
    this.controller = new DebugController(this.client, this.adapter, "starting", {
      onBreakpointsChanged: (file) => this.broadcastBreakpoints(file),
      bgExtraHandler: () => this.handleSubprocessEvents(),
    });

    // Parse breakpoints
    const breakpoints = this.parseBreakpoints(cmd.breakpoints || []);
    this.runtimePath = cmd.runtime;
    this.connectHost = "127.0.0.1";
    this.connectPort = adapterPort;

    // Run adapter-specific init flow
    const result = await this.adapter.initFlow(this.client, {
      program: script,
      args: cmd.args,
      cwd: cmd.cwd || dirname(script),
      stopOnEntry: cmd.stop_on_entry,
      runtimePath: cmd.runtime,
      host: "127.0.0.1",
      port: adapterPort,
      breakpoints,
      exceptionFilters: cmd.exception_filters,
      onSubprocess: (info) => { this.registerSubprocess(info); },
    });

    if (result.error) {
      this._state = "idle";
      await this.cleanup();
      return result;
    }

    if (result.status === "paused") {
      this.controller.setState("paused");
      const body = (this.client.drainEvents("stopped")[0]?.body || {}) as { threadId?: number };
      this.controller.setThreadId(body.threadId ?? 1);
      await this.controller.updateFrame();
      result.location = await this.controller.currentLocation();
      if (isExceptionReason(result.reason)) {
        result.exception = await this.controller.fetchExceptionInfo();
      }
      // Drain any startDebugging reverse requests that arrived during init
      await this.handleSubprocessEvents();
    } else if (result.status === "terminated") {
      this.controller.setState("terminated");
    } else {
      this.controller.setState("running");
      this.controller.startBgEventLoop(() => this.handleSubprocessEvents());
    }

    // Load initial breakpoints into tracker
    if (result.breakpoints) {
      this.controller.loadTrackedBreakpoints(result.breakpoints);
    }

    return result;
  }

  private async attachSession(cmd: Extract<Command, { action: "attach" }>): Promise<CommandResult> {
    if (this._state !== "idle") {
      return { error: "Session already active. Run 'agent-debugger close' first." };
    }

    if (!cmd.port && !cmd.pid) {
      return { error: "Either port or --pid is required" };
    }

    this._state = "starting";

    // Get adapter (default to python)
    const language = cmd.language || "python";
    this.adapter = getAdapter(language);
    if (!this.adapter) {
      this._state = "idle";
      return { error: `Unknown language: ${language}` };
    }

    if (!this.adapter.attachFlow) {
      this._state = "idle";
      return { error: `Attach not supported for ${this.adapter.name}` };
    }

    let host = cmd.host || "127.0.0.1";
    let port = cmd.port;

    // PID mode: inject debugpy into the running process (lldb on macOS, gdb on Linux)
    if (cmd.pid) {
      if (!this.adapter.inject) {
        this._state = "idle";
        return { error: `PID injection not supported for ${this.adapter.name}` };
      }

      try {
        const injectResult = await this.adapter.inject(cmd.pid, cmd.runtime);
        port = injectResult.debuggeePort ?? injectResult.port;
        host = "127.0.0.1";
      } catch (err) {
        this._state = "idle";
        return { error: `Failed to inject into PID ${cmd.pid}: ${(err as Error).message}` };
      }
    }

    // Connect DAP client directly to the debugpy server
    try {
      this.client = new DAPClient();
      await this.client.connect(host, port!);
    } catch (err) {
      this._state = "idle";
      this.client = null;
      return { error: `Failed to connect to ${host}:${port}: ${(err as Error).message}` };
    }

    // Create debug controller (start in "starting" state until attachFlow completes)
    this.controller = new DebugController(this.client, this.adapter, "starting", {
      onBreakpointsChanged: (file) => this.broadcastBreakpoints(file),
      bgExtraHandler: () => this.handleSubprocessEvents(),
    });

    // Store connection info for startDebugging reverse requests
    this.connectHost = host;
    this.connectPort = port!;

    // Parse breakpoints
    const breakpoints = this.parseBreakpoints(cmd.breakpoints || []);
    this.runtimePath = cmd.runtime;

    // Run adapter-specific attach flow
    const result = await this.adapter.attachFlow(this.client, {
      host,
      port: port!,
      runtimePath: cmd.runtime,
      breakpoints,
      exceptionFilters: cmd.exception_filters,
      onSubprocess: (info) => { this.registerSubprocess(info); },
    });

    if (result.error) {
      this._state = "idle";
      await this.cleanup();
      return result;
    }

    // After attach, program is running (breakpoints set, waiting for trigger)
    this.controller.setState("running");
    this.attachedMode = true;
    this.controller.startBgEventLoop(() => this.handleSubprocessEvents());

    // Load initial breakpoints into tracker
    if (result.breakpoints) {
      this.controller.loadTrackedBreakpoints(result.breakpoints);
    }

    return result;
  }

  private parseBreakpoints(raw: string[]): Array<{ file: string; lines: number[]; conditions: Array<string | null> }> {
    const byFile = new Map<string, { lines: number[]; conditions: Array<string | null> }>();

    for (const bp of raw) {
      const parts = bp.split(":");
      if (parts.length < 2) continue;
      const file = pathResolve(parts[0]!);
      const line = parseInt(parts[1]!, 10);
      if (isNaN(line)) continue;
      const condition = parts.length > 2 ? parts.slice(2).join(":") : null;

      let entry = byFile.get(file);
      if (!entry) {
        entry = { lines: [], conditions: [] };
        byFile.set(file, entry);
      }
      entry.lines.push(line);
      entry.conditions.push(condition);
    }

    return Array.from(byFile.entries()).map(([file, data]) => ({
      file,
      lines: data.lines,
      conditions: data.conditions,
    }));
  }

  async close(): Promise<CommandResult> {
    if (this.controller) {
      this.controller.stopBgEventLoop();
    }
    await this.cleanup();
    this._state = "idle";
    this.controller = null;
    this._scriptPath = null;
    this.attachedMode = false;
    this.connectHost = null;
    this.connectPort = null;
    return { status: "closed" };
  }

  /** Register a subprocess adapter as a full debug session. */
  private registerSubprocess(info: SubprocessInfo): void {
    const id = info.pid != null ? `p${info.pid}` : generateSessionId();
    if (this.subprocessSessions.has(id)) return; // dedup
    const sub = new SubprocessSession({
      subprocessId: id,
      client: info.client,
      adapter: this.adapter!,
      adapterProcess: info.process,
    });
    this.subprocessSessions.set(id, sub);
    sub.start();
  }

  /** Route a command to a specific subprocess session. */
  async handleSubprocessCommand(subprocessId: string, cmd: Command): Promise<CommandResult> {
    const sub = this.subprocessSessions.get(subprocessId);
    if (!sub) {
      return { error: `Subprocess '${subprocessId}' not found in session` };
    }

    const result = await sub.handleCommand(cmd);

    // Auto-cleanup terminated subprocess
    if (sub.terminated) {
      this.subprocessSessions.delete(subprocessId);
    }

    return result;
  }

  /** List all subprocesses in this session. */
  listSubprocesses(): CommandResult {
    const subprocesses: Array<{ subprocess_id: string; state: string }> = [];
    for (const [id, sub] of this.subprocessSessions) {
      subprocesses.push({ subprocess_id: id, state: sub.state });
    }
    return { subprocesses, count: subprocesses.length };
  }

  /** Propagate breakpoint changes to all subprocess sessions. */
  private async broadcastBreakpoints(file: string): Promise<void> {
    const allBps = this.controller!.getCurrentBreakpoints();
    const fileBps = allBps.find(bp => bp.file === file);
    if (!fileBps) return;
    for (const [, sub] of this.subprocessSessions) {
      try {
        await sub.syncBreakpointsFromFile(file, fileBps);
      } catch (err) {
        process.stderr.write(`agent-debugger: bp sync error: ${(err as Error).message}\n`);
      }
    }
  }

  /** Handle subprocess events from the bg event loop. */
  private async handleSubprocessEvents(): Promise<void> {
    if (!this.controller || !this.client || !this.adapter) return;
    if (!this.adapter.drainSubprocessEvents) return;

    await this.adapter.drainSubprocessEvents(this.client, {
      host: this.connectHost ?? undefined,
      port: this.connectPort ?? undefined,
      runtimePath: this.runtimePath,
      breakpoints: this.controller.getCurrentBreakpoints(),
      exceptionFilters: [],
      onSubprocess: (info) => { this.registerSubprocess(info); },
    });
  }

  private async cleanup(): Promise<void> {
    // Clean up subprocess sessions
    for (const [, sub] of this.subprocessSessions) {
      try { await sub.close(); } catch { /* best effort */ }
    }
    this.subprocessSessions.clear();

    if (this.controller) {
      try {
        await this.controller.disconnect(!this.attachedMode);
      } catch {
        // Best effort
      }
      this.controller = null;
    }
    this.client = null;

    if (this.adapterProcess) {
      try {
        this.adapterProcess.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try { this.adapterProcess?.kill("SIGKILL"); } catch { /* ignore */ }
            resolve();
          }, 3000);
          this.adapterProcess!.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } catch {
        // Best effort
      }
      this.adapterProcess = null;
    }
  }
}
