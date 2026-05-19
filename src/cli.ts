#!/usr/bin/env node
/** CLI entry point — thin stateless client that talks to the daemon. */

import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_DIR, SOCKET_PATH, PID_FILE } from "./util/paths.js";
import type { CommandResult } from "./protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function isDaemonRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    process.kill(pid, 0); // Check if process exists
    return true;
  } catch {
    // Clean up stale files
    for (const p of [PID_FILE, SOCKET_PATH]) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
    return false;
  }
}

function ensureDaemon(): Promise<void> {
  if (isDaemonRunning()) return Promise.resolve();

  // Spawn daemon as a detached background process
  const daemonScript = pathResolve(__dirname, "daemon.js");
  const child = spawn("node", [daemonScript], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  // Wait for socket to appear
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (existsSync(SOCKET_PATH)) {
        resolve();
        return;
      }
      attempts++;
      if (attempts > 30) {
        reject(new Error("Daemon failed to start"));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function sendCommand(
  cmd: Record<string, unknown>,
  sessionId?: string,
): Promise<CommandResult> {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureDaemon();
    } catch (err) {
      reject(err);
      return;
    }

    // Build envelope or flat command
    const payload = sessionId
      ? { session_id: sessionId, command: cmd }
      : cmd;

    const sock: Socket = connect(SOCKET_PATH);
    let data = "";

    sock.on("connect", () => {
      sock.write(JSON.stringify(payload) + "\n");
    });

    sock.on("data", (chunk) => {
      data += chunk.toString();
    });

    sock.on("end", () => {
      try {
        resolve(JSON.parse(data.trim()));
      } catch {
        resolve({ error: "Invalid response from daemon" });
      }
    });

    sock.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        // Daemon died, clean up
        for (const p of [PID_FILE, SOCKET_PATH]) {
          try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
        }
        resolve({ error: "Daemon not running. Try again." });
      } else {
        reject(err);
      }
    });
  });
}

function formatResult(result: CommandResult): string {
  if (result.error) {
    return `Error: ${result.error}`;
  }

  // Session ID (from start/attach)
  const sessionId = result.session_id;

  // Session list
  if (result.sessions) {
    if (!result.sessions.length) {
      return "  No active sessions.";
    }
    const lines: string[] = [];
    for (const s of result.sessions) {
      const script = s.script ? `  script: ${s.script}` : "";
      const subs = s.subprocesses?.length
        ? `  (${s.subprocesses.length} subprocess${s.subprocesses.length > 1 ? "es" : ""})`
        : "";
      lines.push(`  ${s.session_id}  state: ${s.state}${script}${subs}`);
      if (s.subprocesses) {
        for (const sub of s.subprocesses) {
          lines.push(`    ${s.session_id}/${sub.subprocess_id}  state: ${sub.state}`);
        }
      }
    }
    return lines.join("\n");
  }

  // Subprocess list
  if (result.subprocesses && !result.sessions) {
    if (!result.subprocesses.length) {
      return "  No subprocesses.";
    }
    const lines: string[] = [`  Subprocesses (${result.count}):`];
    for (const sub of result.subprocesses) {
      lines.push(`    ${sub.subprocess_id}  state: ${sub.state}`);
    }
    return lines.join("\n");
  }

  // Variables
  if (result.variables) {
    const loc = result.location;
    const lines: string[] = [];
    if (loc) {
      lines.push(`  at ${loc.file}:${loc.line} in ${loc.function}`);
    }
    for (const v of result.variables) {
      const typeSuffix = v.type ? ` (${v.type})` : "";
      lines.push(`  ${v.name} = ${v.value}${typeSuffix}`);
    }
    if (!result.variables.length) {
      lines.push("  (no local variables)");
    }
    return lines.join("\n");
  }

  // Status (check before location since status also has location)
  if (result.state) {
    const lines = [`State: ${result.state}`];
    const loc = result.location as CommandResult["location"];
    if (loc) {
      lines.push(`  ${loc.file}:${loc.line} in ${loc.function}`);
    }
    return lines.join("\n");
  }

  // Start / step / continue (has status + location)
  if (result.location) {
    const loc = result.location;
    const out: string[] = [];
    if (sessionId) out.push(`Session ID: ${sessionId}`);
    if (result.status) {
      const reason = result.reason ? ` (${result.reason})` : "";
      out.push(`Status: ${result.status}${reason}`);
    }
    if (result.exception) {
      const ex = result.exception;
      out.push(`Exception: ${ex.typeName}: ${ex.description}`);
      if (ex.stackTrace) {
        for (const line of ex.stackTrace.split("\n")) {
          out.push(`  ${line}`);
        }
      }
    }
    out.push(`  ${loc.file}:${loc.line} in ${loc.function}`);
    if (result.breakpoints) {
      for (const bp of result.breakpoints) {
        const v = bp.verified ? "verified" : "pending";
        out.push(`  Breakpoint: ${bp.file}:${bp.line} (${v})`);
      }
    }
    return out.join("\n");
  }

  // Stack trace
  if (result.frames) {
    const lines: string[] = [];
    for (let i = 0; i < result.frames.length; i++) {
      const f = result.frames[i]!;
      const marker = i === 0 ? "\u2192" : " ";
      lines.push(`  ${marker} ${f.function} at ${f.file}:${f.line}`);
    }
    return lines.length ? lines.join("\n") : "  (empty stack)";
  }

  // Eval result
  if (result.result !== undefined) {
    const typeSuffix = result.type ? ` (${result.type})` : "";
    return `  ${result.result}${typeSuffix}`;
  }

  // Source
  if (result.source) {
    return result.source;
  }

  // Breakpoint set (break add)
  if (result.verified !== undefined) {
    const v = result.verified ? "verified" : "pending";
    const cond = result.condition ? `  condition: ${result.condition}` : "";
    return `  Breakpoint: ${result.file}:${result.line} (${v})${cond}`;
  }

  // Breakpoint removed
  if (result.status === "removed") {
    return `  Removed breakpoint: ${result.file}:${result.line}`;
  }

  // Breakpoints cleared
  if (result.status === "cleared") {
    return `  Cleared ${result.count} breakpoint(s).`;
  }

  // Breakpoint list (when returned as standalone, not part of start/attach)
  if (result.breakpoints && result.count !== undefined && !result.status) {
    if (result.count === 0) return "  No breakpoints.";
    const out: string[] = [`  Breakpoints (${result.count}):`];
    for (const bp of result.breakpoints) {
      const v = bp.verified ? "verified" : "pending";
      const cond = bp.condition ? `  condition: ${bp.condition}` : "";
      out.push(`  ${bp.file}:${bp.line} (${v})${cond}`);
    }
    return out.join("\n");
  }

  // Running (e.g. after attach — breakpoints set, waiting for trigger)
  if (result.status === "running") {
    const out: string[] = [];
    if (sessionId) out.push(`Session ID: ${sessionId}`);
    out.push("Attached. Program is running.");
    if (result.breakpoints) {
      for (const bp of result.breakpoints) {
        const v = bp.verified ? "verified" : "pending";
        out.push(`  Breakpoint: ${bp.file}:${bp.line} (${v})`);
      }
    }
    out.push("  Background monitoring active. Check state with 'agent-debugger status'.");
    return out.join("\n");
  }

  // Terminated
  if (result.status === "terminated") {
    const exitStr = result.exitCode !== undefined && result.exitCode !== null ? ` (exit code: ${result.exitCode})` : "";
    const prefix = sessionId ? `Session ID: ${sessionId}\n` : "";
    return `${prefix}Status: terminated${exitStr}`;
  }

  // Closed
  if (result.status === "closed") {
    return "Session closed.";
  }

  // Shutdown
  if (result.status === "shutdown") {
    return "Daemon shut down.";
  }

  // Generic
  return JSON.stringify(result, null, 2);
}

const HELP = `agent-debugger \u2014 CLI debugger for AI agents

Usage:
  agent-debugger start <script> [-b file:line]... [--catch [filter]] [--runtime path] [--args ...]
  agent-debugger attach --pid <PID> [-b file:line]... [--catch [filter]]
  agent-debugger attach [host:]port [-b file:line]... [--catch [filter]]
  agent-debugger vars                        Get local variables
  agent-debugger eval <expression>           Evaluate expression
  agent-debugger step [into|out]             Step over/into/out
  agent-debugger continue                    Resume execution (blocks until next stop)
  agent-debugger stack                       Show call stack
  agent-debugger break add <file:line[:cond]>  Add breakpoint
  agent-debugger break list                     List breakpoints
  agent-debugger break rm <file:line>           Remove breakpoint
  agent-debugger break clear                    Clear all breakpoints
  agent-debugger source [file] [line]        Show source code
  agent-debugger status                      Show session state
  agent-debugger close                       Close a debug session
  agent-debugger list                        List all active sessions
  agent-debugger shutdown                    Shut down the daemon
  agent-debugger subprocess list [--session <id>]  List subprocesses in a session

Session targeting:
  --session <id>       Target a specific session or subprocess
                      Use <session_id>/<subprocess_id> to target a subprocess
                      When only one session exists, it is used automatically.
                      When multiple sessions exist, --session is required.

Start options:
  -b, --break <file:line[:cond]>  Set a breakpoint (repeatable)
  --catch [filter]                Pause on exceptions (repeatable, default: uncaught)
  --runtime <path>                Path to language runtime (e.g. python, node)
  --stop-on-entry                 Pause on the first line
  --args <...>                    Arguments to pass to the script

Attach options:
  --pid <PID>                     Attach to a running process by PID
  --runtime <path>                Path to language runtime
  --language <name>               Language adapter (default: python)

Exception filters (language-specific):
  Python:  raised, uncaught, userUnhandled
  Node.js: all, uncaught
  Go:      all, uncaught
  Rust:    panic`;

/** Extract --session <id> from args and return remaining args. */
function extractSessionId(args: string[]): { sessionId?: string; rest: string[] } {
  const rest: string[] = [];
  let sessionId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" && i + 1 < args.length) {
      sessionId = args[i + 1];
      i++; // skip value
    } else {
      rest.push(args[i]!);
    }
  }

  return { sessionId, rest };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (!rawArgs.length || rawArgs[0] === "-h" || rawArgs[0] === "--help" || rawArgs[0] === "help") {
    console.log(HELP);
    return;
  }

  // Extract --session flag globally
  const { sessionId: cliSessionId, rest: args } = extractSessionId(rawArgs);

  const command = args[0]!;
  let result: CommandResult;

  switch (command) {
    case "list":
      result = await sendCommand({ action: "list" });
      break;

    case "shutdown":
      result = await sendCommand({ action: "shutdown" });
      break;

    case "subprocess": {
      const sub = args[1];
      if (!sub || sub === "list") {
        result = await sendCommand({ action: "subprocess", sub: "list" }, cliSessionId);
      } else {
        process.stderr.write(`Error: unknown subprocess subcommand '${sub}'. Use: list\n`);
        process.exit(1);
      }
      break;
    }

    case "start": {
      if (args.length < 2) {
        process.stderr.write("Error: missing script path. Usage: agent-debugger start <script>\n");
        process.exit(1);
      }
      const script = args[1]!;
      const breakpoints: string[] = [];
      const exceptionFilters: string[] = [];
      let runtimePath: string | undefined;
      let scriptArgs: string[] | undefined;
      let stopOnEntry = false;

      let i = 2;
      while (i < args.length) {
        if ((args[i] === "--break" || args[i] === "-b") && i + 1 < args.length) {
          breakpoints.push(args[i + 1]!);
          i += 2;
        } else if (args[i] === "--catch") {
          if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
            exceptionFilters.push(args[i + 1]!);
            i += 2;
          } else {
            exceptionFilters.push("uncaught");
            i += 1;
          }
        } else if ((args[i] === "--runtime" || args[i] === "--python") && i + 1 < args.length) {
          runtimePath = args[i + 1]!;
          i += 2;
        } else if (args[i] === "--stop-on-entry") {
          stopOnEntry = true;
          i += 1;
        } else if (args[i] === "--args") {
          scriptArgs = args.slice(i + 1);
          break;
        } else {
          // Treat as breakpoint if it looks like file:line
          const val = args[i]!;
          if (val.includes(":") && /:\d+/.test(val)) {
            breakpoints.push(val);
          }
          i += 1;
        }
      }

      const cmd: Record<string, unknown> = {
        action: "start",
        script: pathResolve(script),
        breakpoints,
        stop_on_entry: stopOnEntry,
      };
      if (exceptionFilters.length) cmd.exception_filters = exceptionFilters;
      if (runtimePath) cmd.runtime = pathResolve(runtimePath);
      if (scriptArgs) cmd.args = scriptArgs;
      result = await sendCommand(cmd);
      break;
    }

    case "attach": {
      const attachBreakpoints: string[] = [];
      const attachExceptionFilters: string[] = [];
      let attachHost: string | undefined;
      let attachPort: number | undefined;
      let attachPid: number | undefined;
      let attachLanguage: string | undefined;
      let attachRuntime: string | undefined;

      let ai = 1;
      while (ai < args.length) {
        if ((args[ai] === "--break" || args[ai] === "-b") && ai + 1 < args.length) {
          attachBreakpoints.push(args[ai + 1]!);
          ai += 2;
        } else if (args[ai] === "--catch") {
          if (ai + 1 < args.length && !args[ai + 1]!.startsWith("-")) {
            attachExceptionFilters.push(args[ai + 1]!);
            ai += 2;
          } else {
            attachExceptionFilters.push("uncaught");
            ai += 1;
          }
        } else if (args[ai] === "--pid" && ai + 1 < args.length) {
          attachPid = parseInt(args[ai + 1]!, 10);
          ai += 2;
        } else if (args[ai] === "--language" && ai + 1 < args.length) {
          attachLanguage = args[ai + 1]!;
          ai += 2;
        } else if ((args[ai] === "--runtime" || args[ai] === "--python") && ai + 1 < args.length) {
          attachRuntime = args[ai + 1]!;
          ai += 2;
        } else if (!attachPort && !args[ai]!.startsWith("-")) {
          // Positional: [host:]port
          const target = args[ai]!;
          if (target.includes(":")) {
            const lastColon = target.lastIndexOf(":");
            attachHost = target.substring(0, lastColon);
            attachPort = parseInt(target.substring(lastColon + 1), 10);
          } else {
            attachPort = parseInt(target, 10);
          }
          ai += 1;
        } else {
          const val = args[ai]!;
          if (val.includes(":") && /:\d+/.test(val)) {
            attachBreakpoints.push(val);
          }
          ai += 1;
        }
      }

      if (!attachPort && !attachPid) {
        process.stderr.write("Error: provide a port or --pid. Usage:\n  agent-debugger attach [host:]port [--break file:line]\n  agent-debugger attach --pid <PID> [--break file:line]\n");
        process.exit(1);
      }

      const attachCmd: Record<string, unknown> = {
        action: "attach",
        breakpoints: attachBreakpoints,
      };
      if (attachPort) attachCmd.port = attachPort;
      if (attachPid) attachCmd.pid = attachPid;
      if (attachHost) attachCmd.host = attachHost;
      if (attachLanguage) attachCmd.language = attachLanguage;
      if (attachRuntime) attachCmd.runtime = attachRuntime;
      if (attachExceptionFilters.length) attachCmd.exception_filters = attachExceptionFilters;
      result = await sendCommand(attachCmd);
      break;
    }

    case "close": {
      result = await sendCommand({ action: "close" }, cliSessionId);
      break;
    }

    case "vars":
    case "eval":
    case "step":
    case "continue":
    case "cont":
    case "c":
    case "stack":
    case "break":
    case "bp":
    case "source":
    case "status": {
      const sid = cliSessionId; // no file fallback — purely stateless

      if (command === "eval") {
        const expr = args.slice(1).join(" ");
        if (!expr) {
          process.stderr.write("Error: missing expression. Usage: agent-debugger eval <expression>\n");
          process.exit(1);
        }
        result = await sendCommand({ action: "eval", expression: expr }, sid);
      } else if (command === "step") {
        result = await sendCommand({ action: "step", kind: args[1] || "over" }, sid);
      } else if (command === "continue" || command === "cont" || command === "c") {
        result = await sendCommand({ action: "continue" }, sid);
      } else if (command === "break" || command === "bp") {
        const sub = args[1];
        if (!sub || sub.startsWith("-")) {
          process.stderr.write("Error: missing subcommand. Usage: agent-debugger break <add|list|rm|clear> ...\n");
          process.exit(1);
        }
        if (sub === "list") {
          result = await sendCommand({ action: "break", sub: "list" }, sid);
        } else if (sub === "clear") {
          result = await sendCommand({ action: "break", sub: "clear" }, sid);
        } else if (sub === "rm") {
          if (!args[2]) {
            process.stderr.write("Error: missing location. Usage: agent-debugger break rm <file:line>\n");
            process.exit(1);
          }
          const parts = args[2]!.split(":");
          if (parts.length < 2) {
            process.stderr.write("Error: invalid format. Use file:line\n");
            process.exit(1);
          }
          result = await sendCommand({ action: "break", sub: "rm", file: parts[0]!, line: parseInt(parts[1]!, 10) }, sid);
        } else if (sub === "add") {
          if (!args[2]) {
            process.stderr.write("Error: missing location. Usage: agent-debugger break add <file:line[:condition]>\n");
            process.exit(1);
          }
          const parts = args[2]!.split(":");
          if (parts.length < 2) {
            process.stderr.write("Error: invalid format. Use file:line or file:line:condition\n");
            process.exit(1);
          }
          const bpCmd: Record<string, unknown> = { action: "break", sub: "add", file: parts[0]!, line: parseInt(parts[1]!, 10) };
          if (parts.length > 2) bpCmd.condition = parts.slice(2).join(":");
          result = await sendCommand(bpCmd, sid);
        } else {
          process.stderr.write(`Error: unknown subcommand '${sub}'. Use: add, list, rm, clear\n`);
          process.exit(1);
        }
      } else if (command === "source") {
        const srcCmd: Record<string, unknown> = { action: "source" };
        if (args.length > 1) srcCmd.file = args[1]!;
        if (args.length > 2) srcCmd.line = parseInt(args[2]!, 10);
        result = await sendCommand(srcCmd, sid);
      } else if (command === "vars") {
        result = await sendCommand({ action: "vars" }, sid);
      } else if (command === "stack") {
        result = await sendCommand({ action: "stack" }, sid);
      } else {
        // status
        result = await sendCommand({ action: "status" }, sid);
      }
      break;
    }

    default:
      process.stderr.write(`Unknown command: ${command}. Run 'agent-debugger --help' for usage.\n`);
      process.exit(1);
  }

  console.log(formatResult(result));
  if (result.error) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
