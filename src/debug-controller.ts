/** Shared debug state machine — owns DAP client, state, and all debug operations. */

import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { DAPClient } from "./dap-client.js";
import type { AdapterConfig } from "./adapters/base.js";
import type { Command, CommandResult, LocationInfo, ExceptionDetail, BreakpointInfo } from "./protocol.js";
import type { SessionState } from "./session.js";

export class DebugController {
  state: SessionState;
  private client: DAPClient;
  private adapter: AdapterConfig;
  private threadId: number | null = null;
  private frameId: number | null = null;
  private bgLoop: Promise<void> | null = null;
  private bgLoopAbort = false;
  private bgStopReason: string | null = null;
  private bgExtraHandler?: () => Promise<void>;
  private breakpoints = new Map<string, Array<{ line: number; condition: string | null }>>();
  private onBreakpointsChanged?: (file: string) => Promise<void>;

  get terminated(): boolean {
    return this.state === "terminated";
  }

  constructor(client: DAPClient, adapter: AdapterConfig, initialState?: SessionState, opts?: { onBreakpointsChanged?: (file: string) => Promise<void>; bgExtraHandler?: () => Promise<void> }) {
    this.client = client;
    this.adapter = adapter;
    this.state = initialState ?? "running";
    this.onBreakpointsChanged = opts?.onBreakpointsChanged;
    this.bgExtraHandler = opts?.bgExtraHandler;
  }

  // --- Lifecycle methods (for owner) ---

  setState(s: SessionState): void {
    this.state = s;
  }

  setThreadId(id: number | null): void {
    this.threadId = id;
  }

  startBgEventLoop(extraHandler?: () => Promise<void>): void {
    if (this.bgLoop) return;
    this.bgLoopAbort = false;
    if (extraHandler !== undefined) {
      this.bgExtraHandler = extraHandler;
    }

    this.bgLoop = (async () => {
      while (!this.bgLoopAbort && this.state === "running") {
        const stopped = await this.client.waitForEvent("stopped", 1000);
        if (this.bgLoopAbort) break;

        if (stopped) {
          this.state = "paused";
          const body = (stopped.body || {}) as { reason?: string; threadId?: number; text?: string; description?: string };
          this.threadId = body.threadId ?? this.threadId;
          this.bgStopReason = body.reason === "exception" && body.text
            ? `${body.text}: ${body.description || ""}`.trim()
            : (body.reason || "unknown");
          await this.updateFrame();
          if (this.bgExtraHandler) await this.bgExtraHandler();
          return;
        }

        const terminated = this.client.drainEvents("terminated");
        const exited = this.client.drainEvents("exited");
        if (terminated.length || exited.length) {
          this.state = "terminated";
          return;
        }

        this.client.drainEvents("output");

        if (this.bgExtraHandler) {
          await this.bgExtraHandler();
        }
      }
    })().catch(() => { /* swallow */ });
  }

  stopBgEventLoop(): void {
    this.bgLoopAbort = true;
    this.bgLoop = null;
    this.bgStopReason = null;
  }

  async disconnect(terminate = true): Promise<void> {
    try {
      await this.client.disconnect(terminate);
    } catch {
      // Best effort
    }
  }

  // --- Init helpers (for owner during start/attach) ---

  async updateFrame(): Promise<void> {
    if (this.threadId === null) return;
    const resp = await this.client.request("stackTrace", {
      threadId: this.threadId,
      startFrame: 0,
      levels: 20,
    });
    if (resp.success && resp.body) {
      const frames = (resp.body as { stackFrames?: Array<{ id: number }> }).stackFrames;
      if (frames?.length) {
        this.frameId = frames[0]!.id;
      }
    }
  }

  async currentLocation(): Promise<LocationInfo | null> {
    if (this.threadId === null) return null;
    const resp = await this.client.request("stackTrace", {
      threadId: this.threadId,
      startFrame: 0,
      levels: 20,
    });
    if (resp.success && resp.body) {
      const frames = (resp.body as {
        stackFrames?: Array<{
          name: string;
          line: number;
          source?: { path?: string };
        }>;
      }).stackFrames;
      if (frames?.length) {
        const f = frames[0]!;
        return {
          file: f.source?.path || "?",
          line: f.line,
          function: f.name,
        };
      }
    }
    return null;
  }

  async fetchExceptionInfo(): Promise<ExceptionDetail | null> {
    if (this.threadId === null) return null;
    try {
      const resp = await this.client.request("exceptionInfo", { threadId: this.threadId });
      if (!resp.success || !resp.body) return null;
      const body = resp.body as {
        exceptionId?: string;
        description?: string;
        details?: {
          message?: string;
          typeName?: string;
          fullTypeName?: string;
          stackTrace?: string;
        };
      };
      const details = body.details;
      if (!details) return null;
      return {
        typeName: details.typeName || details.fullTypeName || body.exceptionId || "Unknown",
        description: details.message || body.description || "",
        stackTrace: details.stackTrace || "",
      };
    } catch {
      return null;
    }
  }

  loadTrackedBreakpoints(bps: Array<{ file: string; line: number; verified?: boolean; condition?: string | null }>): void {
    for (const bp of bps) {
      let list = this.breakpoints.get(bp.file);
      if (!list) {
        list = [];
        this.breakpoints.set(bp.file, list);
      }
      list.push({ line: bp.line, condition: bp.condition ?? null });
    }
  }

  getCurrentBreakpoints(): Array<{ file: string; lines: number[]; conditions: Array<string | null> }> {
    const result: Array<{ file: string; lines: number[]; conditions: Array<string | null> }> = [];
    for (const [file, list] of this.breakpoints) {
      if (list.length) {
        result.push({
          file,
          lines: list.map(bp => bp.line),
          conditions: list.map(bp => bp.condition),
        });
      }
    }
    return result;
  }

  /** Sync breakpoints for a specific file from an external source (e.g. parent session). */
  async syncBreakpointsForFile(
    file: string,
    bps: { lines: number[]; conditions: Array<string | null> },
  ): Promise<void> {
    this.breakpoints.set(file, bps.lines.map((line, i) => ({
      line, condition: bps.conditions[i] ?? null,
    })));
    await this.syncBreakpointsToFile(file);
  }

  // --- Command dispatch ---

  async handleCommand(cmd: Command): Promise<CommandResult> {
    switch (cmd.action) {
      case "vars":
        return this.getVariables();
      case "stack":
        return this.getStack();
      case "eval":
        return this.evalExpression(cmd.expression);
      case "step":
        return this.step(cmd.kind || "over", cmd.wait, cmd.force);
      case "continue":
        return this.continueExecution(cmd.wait, cmd.force);
      case "break": {
        const breakCmd = cmd as Extract<Command, { action: "break" }>;
        switch (breakCmd.sub) {
          case "add": return this.addBreakpoint(breakCmd.file!, breakCmd.line!, breakCmd.condition);
          case "list": return this.listBreakpoints();
          case "rm": return this.removeBreakpoint(breakCmd.file!, breakCmd.line!);
          case "clear": return this.clearBreakpoints();
        }
        return { error: "Unknown break subcommand" };
      }
      case "source":
        return this.getSource(cmd.file, cmd.line);
      case "status":
        return this.getStatusAsync();
      default:
        return { error: `Unknown action '${(cmd as { action: string }).action}'` };
    }
  }

  // --- Debug methods ---

  private async getVariables(): Promise<CommandResult> {
    if (this.state !== "paused") return { error: "Not paused" };

    await this.updateFrame();
    if (this.frameId === null) return { error: "No frame available" };

    const resp = await this.client.request("scopes", { frameId: this.frameId });
    if (!resp.success) return { error: "Failed to get scopes" };

    const scopes = (resp.body as { scopes?: Array<{ name: string; variablesReference: number }> }).scopes || [];
    const result: Array<{ name: string; value: string; type: string }> = [];

    for (const scope of scopes) {
      if (scope.name !== "Locals" && scope.name !== "Local") continue;
      const varResp = await this.client.request("variables", {
        variablesReference: scope.variablesReference,
        count: 100,
      });
      if (varResp.success && varResp.body) {
        const vars = (varResp.body as {
          variables?: Array<{ name: string; value: string; type?: string; variablesReference: number }>;
        }).variables || [];
        for (const v of vars) {
          if (this.adapter.isInternalVariable(v as any)) continue;
          result.push({ name: v.name, value: v.value, type: v.type || "" });
        }
      }
    }

    const location = await this.currentLocation();
    return { variables: result, count: result.length, location };
  }

  private async getStack(): Promise<CommandResult> {
    if (this.state !== "paused") return { error: "Not paused" };
    if (this.threadId === null) return { error: "No thread" };

    const resp = await this.client.request("stackTrace", {
      threadId: this.threadId,
      startFrame: 0,
      levels: 50,
    });
    if (!resp.success) return { error: "Failed to get stack trace" };

    const rawFrames = (resp.body as {
      stackFrames?: Array<{
        id: number;
        name: string;
        line: number;
        column: number;
        source?: { path?: string };
      }>;
    }).stackFrames || [];

    const frames: LocationInfo[] = [];
    for (const f of rawFrames) {
      if (this.adapter.isInternalFrame(f as any)) continue;
      frames.push({
        function: f.name,
        file: f.source?.path || "",
        line: f.line,
      });
    }

    return { frames, count: frames.length };
  }

  private async evalExpression(expression: string): Promise<CommandResult> {
    if (this.state !== "paused") return { error: "Not paused" };
    if (!expression) return { error: "No expression provided" };

    const args: Record<string, unknown> = { expression, context: "repl" };
    if (this.frameId !== null) args.frameId = this.frameId;

    const resp = await this.client.request("evaluate", args);
    if (resp.success && resp.body) {
      const body = resp.body as { result: string; type?: string };
      return { result: body.result, type: body.type || "" };
    }
    return { error: resp.message || "Evaluation failed" };
  }

  private async step(kind: string, wait?: boolean, force?: boolean): Promise<CommandResult> {
    if (this.state !== "paused") return { error: "Not paused" };
    if (this.threadId === null) return { error: "No thread" };

    if (this.bgStopReason && !force) {
      return { error: "Paused by a background event. Run 'status' to inspect, or use --force to override." };
    }
    this.bgStopReason = null;

    const command = kind === "into" ? "stepIn" : kind === "out" ? "stepOut" : "next";
    this.stopBgEventLoop();
    await this.client.request(command, { threadId: this.threadId });
    this.state = "running";

    if (wait) return this.waitForStop();

    this.startBgEventLoop();
    return { status: "running", message: "Resumed." };
  }

  private async continueExecution(wait?: boolean, force?: boolean): Promise<CommandResult> {
    if (this.state === "running") {
      return wait ? this.waitForStop() : { status: "running", message: "Already running." };
    }
    if (this.state !== "paused") return { error: "Not paused" };
    if (this.threadId === null) return { error: "No thread" };

    if (this.bgStopReason && !force) {
      return { error: "Paused by a background event. Run 'status' to inspect, or use --force to override." };
    }
    this.bgStopReason = null;

    this.stopBgEventLoop();
    await this.client.request("continue", { threadId: this.threadId });
    this.state = "running";

    if (wait) return this.waitForStop();

    this.startBgEventLoop();
    return { status: "running", message: "Resumed." };
  }

  private async getSource(filePath?: string, line?: number): Promise<CommandResult> {
    let resolvedFile = filePath;
    let resolvedLine = line;

    if (!resolvedFile && this.state === "paused") {
      const loc = await this.currentLocation();
      if (loc) {
        resolvedFile = loc.file;
        resolvedLine = resolvedLine ?? loc.line;
      }
    }

    if (!resolvedFile) {
      return { error: "No file specified and not paused at a known location" };
    }

    resolvedFile = pathResolve(resolvedFile);

    let lines: string[];
    try {
      lines = readFileSync(resolvedFile, "utf-8").split("\n");
    } catch {
      return { error: `File not found: ${resolvedFile}` };
    }

    const center = (resolvedLine || 1) - 1;
    const start = Math.max(0, center - 5);
    const end = Math.min(lines.length, center + 6);
    const sourceLines: string[] = [];
    for (let i = start; i < end; i++) {
      const marker = i === center ? "\u2192" : " ";
      const lineNum = String(i + 1).padStart(4);
      sourceLines.push(`${marker} ${lineNum} \u2502 ${lines[i]}`);
    }

    return { file: resolvedFile, line: resolvedLine, source: sourceLines.join("\n") };
  }

  private async getStatusAsync(): Promise<CommandResult> {
    if (this.state === "paused") {
      const reason = this.bgStopReason;
      if (reason) {
        this.bgStopReason = null;
        return {
          status: "paused",
          reason,
          exception: reason !== "breakpoint" && reason !== "step" ? await this.fetchExceptionInfo() : null,
          location: await this.currentLocation(),
        };
      }
      return { state: this.state, location: await this.currentLocation() };
    }
    return { state: this.state };
  }

  // --- Breakpoint methods ---

  private async syncBreakpointsToFile(absPath: string): Promise<{ success: boolean; verified: boolean[] }> {
    const list = this.breakpoints.get(absPath) || [];
    const bpArgs: Record<string, unknown> = {
      source: { path: absPath },
      breakpoints: list.map(bp => {
        const entry: Record<string, unknown> = { line: bp.line };
        if (bp.condition) entry.condition = bp.condition;
        return entry;
      }),
    };
    const resp = await this.client.request("setBreakpoints", bpArgs);
    if (!resp.success || !resp.body) return { success: false, verified: [] };
    const bps = (resp.body as { breakpoints?: Array<{ line?: number; verified?: boolean }> }).breakpoints || [];
    return { success: true, verified: bps.map(b => b.verified ?? false) };
  }

  private async addBreakpoint(filePath: string, line: number, condition?: string): Promise<CommandResult> {
    const absPath = pathResolve(filePath);
    let list = this.breakpoints.get(absPath);
    if (list?.some(bp => bp.line === line)) {
      return { error: `Breakpoint already exists at ${absPath}:${line}` };
    }
    if (!list) {
      list = [];
      this.breakpoints.set(absPath, list);
    }
    list.push({ line, condition: condition ?? null });

    const sync = await this.syncBreakpointsToFile(absPath);
    if (!sync.success) {
      list.pop();
      if (list.length === 0) this.breakpoints.delete(absPath);
      return { error: "Failed to set breakpoint" };
    }

    const idx = list.length - 1;
    if (this.onBreakpointsChanged) await this.onBreakpointsChanged(absPath);
    return { file: absPath, line, verified: sync.verified[idx] ?? false, condition: condition ?? null };
  }

  private listBreakpoints(): CommandResult {
    const result: BreakpointInfo[] = [];
    for (const [file, list] of this.breakpoints) {
      for (const bp of list) {
        result.push({ file, line: bp.line, verified: true, condition: bp.condition });
      }
    }
    return { breakpoints: result, count: result.length };
  }

  private async removeBreakpoint(filePath: string, line: number): Promise<CommandResult> {
    const absPath = pathResolve(filePath);
    const list = this.breakpoints.get(absPath);
    if (!list) return { error: `No breakpoints in ${absPath}` };

    const idx = list.findIndex(bp => bp.line === line);
    if (idx === -1) return { error: `No breakpoint at ${absPath}:${line}` };

    list.splice(idx, 1);
    if (list.length === 0) this.breakpoints.delete(absPath);

    await this.syncBreakpointsToFile(absPath);
    if (this.onBreakpointsChanged) await this.onBreakpointsChanged(absPath);
    return { status: "removed", file: absPath, line };
  }

  private async clearBreakpoints(): Promise<CommandResult> {
    let count = 0;
    const files = [...this.breakpoints.keys()];
    for (const file of files) {
      count += this.breakpoints.get(file)!.length;
      this.breakpoints.set(file, []);
      await this.syncBreakpointsToFile(file);
      if (this.onBreakpointsChanged) await this.onBreakpointsChanged(file);
    }
    this.breakpoints.clear();
    return { status: "cleared", count };
  }

  // --- Internal ---

  private async waitForStop(): Promise<CommandResult> {
    while (true) {
      if (this.state === "paused") {
        if (this.bgExtraHandler) await this.bgExtraHandler();
        const reason = this.bgStopReason;
        this.bgStopReason = null;
        const loc = await this.currentLocation();
        const exception = reason !== "breakpoint" ? await this.fetchExceptionInfo() : null;
        return {
          status: "paused",
          reason: reason || "breakpoint",
          location: loc,
          exception,
        };
      }
      if (this.state === "terminated") {
        return { status: "terminated" };
      }

      const stopped = await this.client.waitForEvent("stopped", 1000);
      if (stopped) {
        this.state = "paused";
        this.stopBgEventLoop();
        const body = (stopped.body || {}) as { reason?: string; threadId?: number; text?: string; description?: string };
        this.threadId = body.threadId ?? this.threadId;
        await this.updateFrame();
        if (this.bgExtraHandler) await this.bgExtraHandler();
        const detail = body.reason === "exception" && body.text
          ? `${body.text}: ${body.description || ""}`.trim()
          : body.reason;
        const exception = body.reason === "exception" ? await this.fetchExceptionInfo() : null;
        return {
          status: "paused",
          reason: detail || "unknown",
          location: await this.currentLocation(),
          exception,
        };
      }

      const terminated = this.client.drainEvents("terminated");
      const exited = this.client.drainEvents("exited");
      if (terminated.length || exited.length) {
        this.state = "terminated";
        let exitCode: number | null = null;
        if (exited.length) {
          exitCode = (exited[0]!.body as { exitCode?: number })?.exitCode ?? null;
        }
        return { status: "terminated", exitCode };
      }

      this.client.drainEvents("output");
    }
  }
}
