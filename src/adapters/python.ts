/** Python debug adapter — debugpy. */

import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import { DAPClient } from "../dap-client.js";
import type { StackFrame, Variable } from "../dap-types.js";
import type { CommandResult } from "../protocol.js";
import type { AdapterConfig, SpawnResult, InjectResult, LaunchOpts, InitFlowOpts, AttachFlowOpts, SubprocessInfo } from "./base.js";
import type { DAPRequest } from "../dap-types.js";
import { getFreePort } from "../util/ports.js";

export class PythonAdapter implements AdapterConfig {
  name = "python";

  async checkInstalled(runtimePath?: string): Promise<string | null> {
    const python = runtimePath || "python3";
    try {
      await execCheck(python, ["-m", "debugpy", "--version"]);
      return null;
    } catch {
      return `debugpy not found. Run: ${python} -m pip install debugpy`;
    }
  }

  async spawn(opts: LaunchOpts): Promise<SpawnResult> {
    const python = opts.runtimePath || "python3";
    const port = await getFreePort();
    const proc = cpSpawn(
      python,
      ["-Xfrozen_modules=off", "-m", "debugpy.adapter", "--host", "127.0.0.1", "--port", String(port)],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    return { process: proc, port };
  }

  /**
   * Inject debugpy into a running Python process by PID.
   *
   * Uses the native debugger (lldb on macOS, gdb on Linux) to call Python C API
   * functions (PyGILState_Ensure/PyRun_SimpleString/PyGILState_Release) directly.
   * No architecture-specific dylibs needed — works on macOS ARM64 and Linux.
   *
   * Auto-detects the target Python runtime and installs debugpy if missing.
   * debugpy.listen() spawns its own adapter subprocess, so the returned port
   * is where the adapter is serving DAP for clients to connect to.
   */
  async inject(pid: number, runtimePath?: string): Promise<InjectResult> {
    const debuggeePort = await getFreePort();

    // The injection code auto-installs debugpy if missing using sys.executable,
    // which is always correct regardless of symlinks or venv resolution.
    // This avoids macOS issues where `ps` resolves venv symlinks to the real binary.
    const code = [
      "import importlib.util, subprocess, sys",
      "subprocess.call([sys.executable, '-m', 'pip', 'install', '-q', 'debugpy']) if not importlib.util.find_spec('debugpy') else None",
      "import debugpy",
      `debugpy.listen(('127.0.0.1', ${debuggeePort}))`,
    ].join("; ");

    const injectorProc = process.platform === "darwin"
      ? spawnLldbInject(pid, code)
      : spawnGdbInject(pid, code);

    // Wait for the injector to finish (may take longer if pip install runs)
    const output = await waitForProcess(injectorProc);

    // Verify PyRun_SimpleString returned 0 (success)
    // In lldb, the PyRun_SimpleString result is $1; in gdb it's $2
    const failPattern = process.platform === "darwin" ? "$1 = -1" : "$2 = -1";
    if (output.includes(failPattern)) {
      const hint = runtimePath || "python3";
      throw new Error(
        `Failed to inject debugpy into process. Ensure pip is available: ${hint} -m pip install debugpy`,
      );
    }

    // Wait for debugpy to initialize its adapter subprocess.
    // Don't poll the port — debugpy's single-client DAP slot would be consumed.
    await new Promise(resolve => setTimeout(resolve, 2000));

    return { process: injectorProc, port: debuggeePort };
  }

  initializeArgs(): Record<string, unknown> {
    return {
      clientID: "agent-debugger",
      clientName: "agent-debugger",
      adapterID: "debugpy",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: true,
    };
  }

  launchArgs(opts: LaunchOpts): Record<string, unknown> {
    const args: Record<string, unknown> = {
      type: "debugpy",
      request: "launch",
      program: opts.program,
      console: "internalConsole",
      stopOnEntry: opts.stopOnEntry ?? false,
      justMyCode: true,
      subProcess: true,
    };
    if (opts.runtimePath) {
      args.python = [opts.runtimePath, "-Xfrozen_modules=off"];
    }
    if (opts.args?.length) {
      args.args = opts.args;
    }
    if (opts.cwd) {
      args.cwd = opts.cwd;
    }
    return args;
  }

  /**
   * debugpy-specific init flow:
   * 1. initialize
   * 2. launch (async — response deferred until configurationDone)
   * 3. wait for initialized event
   * 4. setBreakpoints
   * 5. setExceptionBreakpoints
   * 6. configurationDone
   * 7. wait for deferred launch response
   * 8. wait for stopped event
   */
  async initFlow(client: DAPClient, opts: InitFlowOpts): Promise<CommandResult> {
    // 1. Initialize
    const initResp = await client.request("initialize", this.initializeArgs());
    if (!initResp.success) {
      return { error: `Initialize failed: ${initResp.message || "unknown"}` };
    }

    // 2. Launch (async — debugpy defers response until configurationDone)
    const launchSeq = client.requestAsync("launch", this.launchArgs(opts));

    // 3. Wait for initialized event
    const initialized = await client.waitForEvent("initialized", 10000);
    if (!initialized) {
      return { error: "Timeout waiting for initialized event" };
    }

    // 3b. Handle subprocess events that arrived during init
    await this.drainSubprocessEvents(client, opts);

    // 4. Set breakpoints
    const bpResults: Array<{ file: string; line: number; verified: boolean }> = [];
    if (opts.breakpoints?.length) {
      for (const bp of opts.breakpoints) {
        const bpArgs: Record<string, unknown> = {
          source: { path: bp.file },
          breakpoints: bp.lines.map((line, i) => {
            const entry: Record<string, unknown> = { line };
            if (bp.conditions?.[i]) entry.condition = bp.conditions[i];
            return entry;
          }),
        };
        const resp = await client.request("setBreakpoints", bpArgs);
        if (resp.success && resp.body) {
          const bps = (resp.body as { breakpoints?: Array<{ line?: number; verified?: boolean }> }).breakpoints;
          if (bps) {
            for (const b of bps) {
              bpResults.push({
                file: bp.file,
                line: b.line ?? 0,
                verified: b.verified ?? false,
              });
            }
          }
        }
      }
    }

    // 5. Exception breakpoints
    await client.request("setExceptionBreakpoints", { filters: opts.exceptionFilters || [] });

    // 6. configurationDone
    await client.request("configurationDone");

    // 7. Wait for the deferred launch response
    const launchResp = await client.waitForResponse(launchSeq, 15000);
    if (!launchResp.success) {
      return { error: `Launch failed: ${launchResp.message || "unknown"}` };
    }

    // 8. Wait for stopped event (breakpoint hit or entry)
    const stopped = await client.waitForEvent("stopped", 15000);
    if (stopped) {
      const body = (stopped.body || {}) as { reason?: string; threadId?: number; text?: string; description?: string };
      const detail = body.reason === "exception" && body.text
        ? `${body.text}: ${body.description || ""}`.trim()
        : body.reason;
      return {
        status: "paused",
        reason: detail || "unknown",
        breakpoints: bpResults,
      };
    }

    // Program may have finished without hitting breakpoint
    const terminated = client.drainEvents("terminated");
    if (terminated.length) {
      return { status: "terminated", message: "Program finished without hitting breakpoint" };
    }

    return { status: "running", breakpoints: bpResults };
  }

  /**
   * Attach flow for debugpy — connects to a debugpy.listen() DAP server.
   *
   * debugpy.listen() starts a debug server that speaks DAP, but after the
   * `attach` request it emits `debugpyWaitingForServer` — requiring a
   * debugpy.adapter process to connect to an internal port before proceeding.
   *
   * Flow: initialize -> attach (async) -> debugpyWaitingForServer event
   *       -> spawn adapter -> initialized event -> setBreakpoints
   *       -> configurationDone -> attach response -> program running
   */
  async attachFlow(client: DAPClient, opts: AttachFlowOpts): Promise<CommandResult> {
    // 1. Initialize
    const initResp = await client.request("initialize", this.initializeArgs());
    if (!initResp.success) {
      return { error: `Initialize failed: ${initResp.message || "unknown"}` };
    }

    // 2. Attach (async — response deferred until configurationDone)
    const attachArgs: Record<string, unknown> = {
      type: "debugpy",
      request: "attach",
      justMyCode: true,
      subProcess: true,
    };
    const attachSeq = client.requestAsync("attach", attachArgs);

    // 3. Wait for initialized event.
    //    debugpy.listen() spawns its own adapter subprocess with the access token.
    //    After the adapter connects to the internal server, the initialized event fires.
    //    We drain debugpyWaitingForServer and other internal events along the way.
    const initialized = await client.waitForEvent("initialized", 15000);
    if (!initialized) {
      return { error: "Timeout waiting for initialized event from debugpy" };
    }

    // 5b. Handle subprocess events that arrived during attach
    await this.drainSubprocessEvents(client, opts);

    // 6. Set breakpoints
    const bpResults: Array<{ file: string; line: number; verified: boolean }> = [];
    if (opts.breakpoints?.length) {
      for (const bp of opts.breakpoints) {
        const bpArgs: Record<string, unknown> = {
          source: { path: bp.file },
          breakpoints: bp.lines.map((line, i) => {
            const entry: Record<string, unknown> = { line };
            if (bp.conditions?.[i]) entry.condition = bp.conditions[i];
            return entry;
          }),
        };
        const resp = await client.request("setBreakpoints", bpArgs);
        if (resp.success && resp.body) {
          const bps = (resp.body as { breakpoints?: Array<{ line?: number; verified?: boolean }> }).breakpoints;
          if (bps) {
            for (const b of bps) {
              bpResults.push({
                file: bp.file,
                line: b.line ?? 0,
                verified: b.verified ?? false,
              });
            }
          }
        }
      }
    }

    // 7. Exception breakpoints
    await client.request("setExceptionBreakpoints", { filters: opts.exceptionFilters || [] });

    // 8. configurationDone
    await client.request("configurationDone");

    // 9. Wait for the deferred attach response
    const attachResp = await client.waitForResponse(attachSeq, 15000);
    if (!attachResp.success) {
      return { error: `Attach failed: ${attachResp.message || "unknown"}` };
    }

    // Program is already running — don't wait for stopped event.
    return { status: "running", breakpoints: bpResults };
  }

  /**
   * Spawn a debugpy adapter for a subprocess.
   * Uses --for-server-port to connect to the child's internal debugpy server.
   */
  private async spawnSubprocessAdapter(
    internalPort: number,
    runtimePath?: string,
  ): Promise<{ process: ChildProcess; port: number }> {
    const python = runtimePath || "python3";
    const externalPort = await getFreePort();
    const proc = cpSpawn(
      python,
      [
        "-Xfrozen_modules=off",
        "-m", "debugpy.adapter",
        "--host", "127.0.0.1",
        "--port", String(externalPort),
        "--for-server-port", String(internalPort),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    return { process: proc, port: externalPort };
  }

  /**
   * Handle a debugpyWaitingForServer event by spawning a relay adapter
   * for the subprocess and completing the DAP handshake.
   */
  async handleSubprocessEvent(
    event: { body?: Record<string, unknown> },
    opts: {
      runtimePath?: string;
      breakpoints?: Array<{ file: string; lines: number[]; conditions?: Array<string | null> }>;
      exceptionFilters?: string[];
    },
  ): Promise<SubprocessInfo | null> {
    const body = event.body || {};
    const internalPort = body.port as number | undefined;
    const pid = body.processId as number | undefined;
    if (!internalPort) {
      process.stderr.write("agent-debugger: debugpyWaitingForServer event missing port\n");
      return null;
    }

    let adapterProc: ChildProcess | undefined;
    let client: DAPClient | null = null;
    let handedOff = false;

    try {
      const spawnResult = await this.spawnSubprocessAdapter(internalPort, opts.runtimePath);
      adapterProc = spawnResult.process;

      const sc = new DAPClient();
      client = sc;
      await sc.connect("127.0.0.1", spawnResult.port);

      const initResp = await sc.request("initialize", this.initializeArgs());
      if (!initResp.success) {
        process.stderr.write(`agent-debugger: subprocess init failed: ${initResp.message}\n`);
        return null;
      }

      const attachSeq = sc.requestAsync("attach", {
        type: "debugpy",
        request: "attach",
        justMyCode: true,
        subProcess: true,
      });

      const initialized = await sc.waitForEvent("initialized", 10000);
      if (!initialized) {
        process.stderr.write("agent-debugger: subprocess initialized timeout\n");
        return null;
      }

      if (opts.breakpoints?.length) {
        for (const bp of opts.breakpoints) {
          const bpArgs: Record<string, unknown> = {
            source: { path: bp.file },
            breakpoints: bp.lines.map((line, i) => {
              const entry: Record<string, unknown> = { line };
              if (bp.conditions?.[i]) entry.condition = bp.conditions[i];
              return entry;
            }),
          };
          await sc.request("setBreakpoints", bpArgs);
        }
      }

      await sc.request("setExceptionBreakpoints", { filters: opts.exceptionFilters || [] });
      await sc.request("configurationDone");
      await sc.waitForResponse(attachSeq, 10000);

      handedOff = true;
      return { process: adapterProc, client: sc, pid };
    } catch (err) {
      process.stderr.write(`agent-debugger: subprocess handler error: ${(err as Error).message}\n`);
      return null;
    } finally {
      if (!handedOff) {
        if (client) {
          try { await client.disconnect(false); } catch { /* best effort */ }
        }
        adapterProc?.kill();
      }
    }
  }

  /**
   * Drain and handle any debugpyWaitingForServer events from the client.
   */
  async drainSubprocessEvents(
    client: DAPClient,
    opts: {
      host?: string;
      port?: number;
      runtimePath?: string;
      breakpoints?: Array<{ file: string; lines: number[]; conditions?: Array<string | null> }>;
      exceptionFilters?: string[];
      onSubprocess?: (info: SubprocessInfo) => void;
    },
  ): Promise<void> {
    // Prefer startDebugging reverse requests (works across port-forward)
    if (opts.host && opts.port) {
      const startDebugReqs = client.drainReverseRequests("startDebugging");
      for (const req of startDebugReqs) {
        try {
          const result = await this.handleStartDebugging(req, {
            host: opts.host,
            port: opts.port,
            breakpoints: opts.breakpoints,
            exceptionFilters: opts.exceptionFilters,
          }, client);
          if (result && opts.onSubprocess) opts.onSubprocess(result);
        } catch (err) {
          process.stderr.write(`agent-debugger: startDebugging error: ${(err as Error).message}\n`);
        }
      }
    }
    // Fallback: debugpyWaitingForServer (local debugging, older debugpy)
    const waitingEvents = client.drainEvents("debugpyWaitingForServer");
    for (const evt of waitingEvents) {
      try {
        const result = await this.handleSubprocessEvent(evt, opts);
        if (result && opts.onSubprocess) opts.onSubprocess(result);
      } catch (err) {
        process.stderr.write(`agent-debugger: subprocess handler error: ${(err as Error).message}\n`);
      }
    }
  }

  /**
   * Handle a startDebugging reverse request from debugpy.
   * Creates a new DAP connection to the same host:port and sends attach with subProcessId.
   * This works across port-forwarded connections (e.g. kubectl port-forward).
   */
  async handleStartDebugging(
    req: DAPRequest,
    opts: {
      host: string;
      port: number;
      breakpoints?: Array<{ file: string; lines: number[]; conditions?: Array<string | null> }>;
      exceptionFilters?: string[];
    },
    parentClient: DAPClient,
  ): Promise<SubprocessInfo | null> {
    const config = (req.arguments?.configuration ?? {}) as Record<string, unknown>;
    const subProcessId = config.subProcessId as number | undefined;
    let subClient: DAPClient | null = null;
    let handedOff = false;

    try {
      // 1. New DAP connection to the same host:port (already forwarded)
      const sc = new DAPClient();
      subClient = sc;
      await sc.connect(opts.host, opts.port);

      // 2. initialize → attach(subProcessId) → initialized → breakpoints → configurationDone
      const initResp = await sc.request("initialize", this.initializeArgs());
      if (!initResp.success) {
        process.stderr.write(`agent-debugger: startDebugging init failed: ${initResp.message}\n`);
        parentClient.sendResponse(req.seq, req.command, false);
        return null;
      }

      const attachArgs: Record<string, unknown> = {
        type: "debugpy",
        request: "attach",
        justMyCode: true,
        subProcess: true,
      };
      if (subProcessId != null) {
        attachArgs.subProcessId = subProcessId;
      }
      const attachSeq = sc.requestAsync("attach", attachArgs);

      const initialized = await sc.waitForEvent("initialized", 10000);
      if (!initialized) {
        process.stderr.write("agent-debugger: startDebugging initialized timeout\n");
        parentClient.sendResponse(req.seq, req.command, false);
        return null;
      }

      // Set breakpoints
      if (opts.breakpoints?.length) {
        for (const bp of opts.breakpoints) {
          const bpArgs: Record<string, unknown> = {
            source: { path: bp.file },
            breakpoints: bp.lines.map((line, i) => {
              const entry: Record<string, unknown> = { line };
              if (bp.conditions?.[i]) entry.condition = bp.conditions[i];
              return entry;
            }),
          };
          await sc.request("setBreakpoints", bpArgs);
        }
      }

      await sc.request("setExceptionBreakpoints", { filters: opts.exceptionFilters || [] });
      await sc.request("configurationDone");
      await sc.waitForResponse(attachSeq, 10000);

      // 3. Send success response to the adapter
      parentClient.sendResponse(req.seq, req.command, true);

      // 4. Return SubprocessInfo (no adapter process — connection reuses existing adapter)
      handedOff = true;
      return { client: sc, pid: subProcessId };
    } catch (err) {
      process.stderr.write(`agent-debugger: startDebugging error: ${(err as Error).message}\n`);
      try { parentClient.sendResponse(req.seq, req.command, false); } catch { /* best effort */ }
      return null;
    } finally {
      if (!handedOff && subClient) {
        try { await subClient.disconnect(false); } catch { /* best effort */ }
      }
    }
  }

  isInternalFrame(frame: StackFrame): boolean {
    const path = frame.source?.path || "";
    return path.includes("debugpy") || path.includes("pydevd") || path.includes("<frozen");
  }

  isInternalVariable(v: Variable): boolean {
    return v.name.startsWith("__") || v.name === "special variables" || v.name === "function variables";
  }
}

// --- Helper functions ---

/** Spawn lldb to inject Python code into a process (macOS). */
function spawnLldbInject(pid: number, code: string): ChildProcess {
  return cpSpawn("lldb", [
    "--batch",
    "-o", `process attach --pid ${pid}`,
    "-o", `expr (int) PyGILState_Ensure()`,
    "-o", `expr (int) PyRun_SimpleString("${code}")`,
    // $0 = GIL state from PyGILState_Ensure — must pass it back to properly release
    "-o", `expr (void) PyGILState_Release($0)`,
    "-o", `detach`,
  ], { stdio: ["pipe", "pipe", "pipe"] });
}

/** Spawn gdb to inject Python code into a process (Linux). */
function spawnGdbInject(pid: number, code: string): ChildProcess {
  return cpSpawn("gdb", [
    "-batch",
    "-p", String(pid),
    "-ex", `call (int)PyGILState_Ensure()`,
    "-ex", `call (int)PyRun_SimpleString("${code}")`,
    // $1 = GIL state from first call — gdb numbers results starting at $1
    "-ex", `call (void)PyGILState_Release($1)`,
    "-ex", `detach`,
  ], { stdio: ["pipe", "pipe", "pipe"] });
}

/** Wait for a child process to exit and return its stdout. */
function waitForProcess(proc: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("exit", (exitCode) => {
      if (exitCode !== 0) {
        const tool = process.platform === "darwin" ? "lldb" : "gdb";
        reject(new Error(`${tool} failed (exit ${exitCode}): ${stderr.trim()}`));
      } else {
        resolve(stdout);
      }
    });
    proc.on("error", (err) => {
      const tool = process.platform === "darwin" ? "lldb" : "gdb";
      reject(new Error(`${tool} not found: ${err.message}`));
    });
  });
}

function execCheck(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = cpSpawn(cmd, args, { stdio: "pipe" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}
