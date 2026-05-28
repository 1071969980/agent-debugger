/** Background daemon — holds multiple DAP sessions, accepts CLI commands via Unix socket. */

import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { SESSION_DIR, SOCKET_PATH, PID_FILE, generateSessionId } from "./util/paths.js";
import { Session } from "./session.js";
import { Command, type CommandResult, type SessionInfo } from "./protocol.js";

class Daemon {
  private sessions = new Map<string, Session>();
  /** Track which PID each session has attached to, to prevent double-attach. */
  private pidMap = new Map<number, string>(); // pid → sessionId
  private server: Server | null = null;
  private isShuttingDown = false;
  /** Per-session command serialization queue. */
  private sessionQueues = new Map<string, Promise<CommandResult>>();

  /** Parse a path-based session_id like "abc/p12345" into parent + subprocess parts. */
  private parseSessionPath(sessionId: string): { parentId: string; subprocessId?: string } {
    const idx = sessionId.indexOf("/");
    if (idx === -1) return { parentId: sessionId };
    return {
      parentId: sessionId.substring(0, idx),
      subprocessId: sessionId.substring(idx + 1) || undefined,
    };
  }

  start(): void {
    mkdirSync(SESSION_DIR, { recursive: true });

    // Clean stale socket
    if (existsSync(SOCKET_PATH)) {
      unlinkSync(SOCKET_PATH);
    }

    // Write PID
    writeFileSync(PID_FILE, String(process.pid));

    // Create Unix socket server
    this.server = createServer((conn) => { this.handleConnection(conn); });
    this.server.listen(SOCKET_PATH);

    // Auto-cleanup terminated sessions every 60 seconds
    setInterval(() => this.cleanupTerminated(), 60_000).unref();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      process.stderr.write(`Daemon received ${signal}, shutting down...\n`);
      await this.cleanup();
    };

    process.on("SIGTERM", () => {
      shutdown("SIGTERM");
      setTimeout(() => process.exit(1), 30_000).unref();
    });
    process.on("SIGINT", () => {
      shutdown("SIGINT");
      setTimeout(() => process.exit(1), 30_000).unref();
    });
    process.on("uncaughtException", (err) => {
      process.stderr.write(`Daemon uncaught exception: ${err.message}\n`);
      shutdown("uncaughtException");
    });
  }

  private handleConnection(conn: Socket): void {
    let data = "";
    let processed = false;

    conn.on("data", (chunk) => {
      if (processed) return;
      data += chunk.toString();

      const nlIdx = data.indexOf("\n");
      const toParse = nlIdx !== -1 ? data.substring(0, nlIdx) : data;

      try {
        const raw = JSON.parse(toParse) as Record<string, unknown>;
        processed = true;
        this.processRawCommand(raw, conn);
      } catch {
        // Wait for more data
      }
    });

    conn.on("end", () => {
      if (!processed && data.trim()) {
        try {
          const raw = JSON.parse(data.trim()) as Record<string, unknown>;
          processed = true;
          this.processRawCommand(raw, conn);
        } catch {
          this.sendResponse(conn, { error: "Invalid JSON" });
        }
      }
    });

    conn.on("error", () => {
      // Client disconnected
    });
  }

  /**
   * Accept both old-style commands (flat JSON with `action`) and
   * new-style envelopes (`{ session_id, command: { action, ... } }`).
   */
  private async processRawCommand(raw: Record<string, unknown>, conn: Socket): Promise<void> {
    try {
      let sessionId: string | undefined;
      let cmdObj: Record<string, unknown>;

      if (raw.action) {
        // Old-style flat command (backward compatible)
        cmdObj = raw;
      } else if (raw.command && typeof raw.command === "object") {
        // New-style envelope
        const envelope = raw as { session_id?: string; command: Record<string, unknown> };
        sessionId = envelope.session_id;
        cmdObj = envelope.command;
      } else {
        this.sendResponse(conn, { error: "Invalid command: must have 'action' or 'command'" });
        return;
      }

      const parsed = Command.safeParse(cmdObj);
      if (!parsed.success) {
        this.sendResponse(conn, { error: `Invalid command: ${parsed.error.message}` });
        return;
      }

      const cmd = parsed.data;
      let result: CommandResult;

      switch (cmd.action) {
        case "list":
          result = this.listSessions();
          break;
        case "shutdown":
          this.sendResponse(conn, { status: "shutdown" });
          await this.cleanup();
          return;
        case "start":
          result = await this.handleStart(cmd);
          break;
        case "attach":
          result = await this.handleAttach(cmd, sessionId);
          break;
        case "close": {
          const targetId = sessionId ?? this.resolveSingleSession();
          if (!targetId) {
            result = { error: "No active session" };
          } else {
            const { parentId, subprocessId } = this.parseSessionPath(targetId);
            if (subprocessId) {
              // Close subprocess only
              const session = this.sessions.get(parentId);
              if (!session) {
                result = { error: `Session not found: ${parentId}` };
              } else {
                result = await session.handleSubprocessCommand(subprocessId, cmd);
              }
            } else {
              result = await this.enqueueCommand(targetId, cmd);
              if (!result.error) {
                this.removeSession(targetId);
              }
            }
          }
          break;
        }
        case "subprocess": {
          const subTargetId = sessionId ?? this.resolveSingleSession();
          if (!subTargetId) {
            result = { error: "No active session. Start or attach first." };
          } else {
            const session = this.sessions.get(subTargetId);
            if (!session) {
              result = { error: `Session not found: ${subTargetId}` };
            } else {
              result = session.listSubprocesses();
            }
          }
          break;
        }
        default: {
          const id = sessionId ?? this.resolveSingleSession();
          if (!id) {
            result = { error: "No active session. Start or attach first." };
          } else {
            const { parentId, subprocessId } = this.parseSessionPath(id);
            if (subprocessId) {
              result = await this.enqueueSubprocessCommand(parentId, subprocessId, cmd);
              const parent = this.sessions.get(parentId);
              if (parent && parent.state === "terminated") {
                this.removeSession(parentId);
              }
            } else {
              result = await this.enqueueCommand(id, cmd);
              const session = this.sessions.get(id);
              if (session && session.state === "terminated") {
                this.removeSession(id);
              }
            }
          }
        }
      }

      this.sendResponse(conn, result as unknown as Record<string, unknown>);
    } catch (err) {
      this.sendResponse(conn, { error: (err as Error).message });
    }
  }

  private async handleStart(cmd: Extract<Command, { action: "start" }>): Promise<CommandResult> {
    const sessionId = generateSessionId();
    const session = new Session();
    const result = await this.enqueueCommand(sessionId, cmd, session);

    if (result.error) {
      return result;
    }

    this.sessions.set(sessionId, session);
    result.session_id = sessionId;
    return result;
  }

  private async handleAttach(cmd: Extract<Command, { action: "attach" }>, _sessionId?: string): Promise<CommandResult> {
    // PID dedup: prevent double-attach to same PID
    if (cmd.pid) {
      const existingId = this.pidMap.get(cmd.pid);
      if (existingId) {
        const existing = this.sessions.get(existingId);
        if (existing && existing.state !== "terminated") {
          return { error: `PID ${cmd.pid} already has an active session (${existingId})` };
        }
        this.pidMap.delete(cmd.pid);
      }
    }

    const sessionId = generateSessionId();
    const session = new Session();
    const result = await this.enqueueCommand(sessionId, cmd, session);

    if (result.error) {
      return result;
    }

    this.sessions.set(sessionId, session);
    if (cmd.pid) {
      this.pidMap.set(cmd.pid, sessionId);
    }
    result.session_id = sessionId;
    return result;
  }

  /**
   * Serialize commands per session to prevent concurrent DAP state corruption.
   * Each session has a Promise chain; new commands are appended to it.
   */
  private enqueueCommand(
    sessionId: string,
    cmd: Command,
    session?: Session,
  ): Promise<CommandResult> {
    const s = session ?? this.sessions.get(sessionId);
    if (!s) {
      return Promise.resolve({ error: `Session not found: ${sessionId}` });
    }

    const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve({} as CommandResult);
    const next = prev.then(async () => {
      return s.handleCommand(cmd);
    });

    this.sessionQueues.set(sessionId, next.catch((err) => ({
      error: `Session ${sessionId} error: ${(err as Error).message}`,
    })));

    return next;
  }

  /**
   * Serialize subprocess commands on the parent session's queue.
   */
  private async enqueueSubprocessCommand(
    parentId: string,
    subprocessId: string,
    cmd: Command,
  ): Promise<CommandResult> {
    const s = this.sessions.get(parentId);
    if (!s) {
      return { error: `Session not found: ${parentId}` };
    }

    const prev = this.sessionQueues.get(parentId) ?? Promise.resolve({} as CommandResult);
    const next = prev.then(async () => {
      return s.handleSubprocessCommand(subprocessId, cmd);
    });

    this.sessionQueues.set(parentId, next.catch((err) => ({
      error: `Session ${parentId} subprocess error: ${(err as Error).message}`,
    })));

    return next;
  }

  private removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionQueues.delete(sessionId);
    // Clean up PID mapping
    for (const [pid, id] of this.pidMap) {
      if (id === sessionId) {
        this.pidMap.delete(pid);
      }
    }
  }

  /**
   * For backward compatibility: if there's exactly one session, use it;
   * if there are multiple, require an explicit session_id.
   */
  private resolveSingleSession(): string | undefined {
    const active = Array.from(this.sessions.entries())
      .filter(([, s]) => s.state !== "terminated");

    if (active.length === 0) return undefined;
    if (active.length === 1) return active[0]![0];

    // Multiple sessions — ambiguous
    return undefined;
  }

  /** Remove terminated sessions to prevent memory leaks. */
  private cleanupTerminated(): void {
    for (const [id, session] of this.sessions) {
      if (session.state === "terminated") {
        this.removeSession(id);
      }
    }
  }

  private listSessions(): CommandResult {
    const sessions: SessionInfo[] = [];
    for (const [id, session] of this.sessions) {
      const info: SessionInfo = {
        session_id: id,
        state: session.state,
        script: session.scriptPath ?? undefined,
      };
      const subResult = session.listSubprocesses();
      if (subResult.subprocesses?.length) {
        info.subprocesses = subResult.subprocesses;
      }
      sessions.push(info);
    }
    return { sessions, count: sessions.length };
  }

  private sendResponse(conn: Socket, result: Record<string, unknown>): void {
    try {
      conn.write(JSON.stringify(result) + "\n");
      conn.end();
    } catch {
      // Client may have disconnected
    }
  }

  private async cleanup(): Promise<void> {
    const closePromises = Array.from(this.sessions.values()).map(s =>
      s.close().catch(() => {}),
    );
    await Promise.all(closePromises);
    this.sessions.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
    try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch { /* ignore */ }

    process.exitCode = 0;
  }
}

// Entry point when run as a separate process
const daemon = new Daemon();
daemon.start();
