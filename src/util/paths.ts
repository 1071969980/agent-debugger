import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const SESSION_DIR = join(homedir(), ".agent-debugger");
const SOCKET_PATH = join(SESSION_DIR, "daemon.sock");
const PID_FILE = join(SESSION_DIR, "daemon.pid");

export { SESSION_DIR, SOCKET_PATH, PID_FILE };

/** Generate a short random session ID (8 hex chars). */
export function generateSessionId(): string {
  return randomBytes(4).toString("hex");
}
