/** Debug session for a subprocess — thin wrapper around DebugController. */

import type { ChildProcess } from "node:child_process";
import type { DAPClient } from "./dap-client.js";
import type { AdapterConfig } from "./adapters/base.js";
import type { Command, CommandResult } from "./protocol.js";
import type { SessionState } from "./session.js";
import { DebugController } from "./debug-controller.js";

export class SubprocessSession {
  readonly id: string;
  private controller: DebugController;
  private adapterProcess?: ChildProcess;

  get state(): SessionState {
    return this.controller.state;
  }

  get terminated(): boolean {
    return this.controller.terminated;
  }

  constructor(opts: {
    subprocessId: string;
    client: DAPClient;
    adapter: AdapterConfig;
    adapterProcess?: ChildProcess;
  }) {
    this.id = opts.subprocessId;
    this.adapterProcess = opts.adapterProcess;
    this.controller = new DebugController(opts.client, opts.adapter);
  }

  /** Start background event polling. Called by parent session after registration. */
  start(): void {
    this.controller.startBgEventLoop();
  }

  /** Sync breakpoints from parent session for a specific file. */
  async syncBreakpointsFromFile(
    file: string,
    bps: { file: string; lines: number[]; conditions: Array<string | null> },
  ): Promise<void> {
    await this.controller.syncBreakpointsForFile(file, bps);
  }

  async handleCommand(cmd: Command): Promise<CommandResult> {
    switch (cmd.action) {
      case "close":
        return this.close();
      case "start":
      case "attach":
        return { error: `Action '${cmd.action}' is not supported on subprocess sessions` };
      default:
        return this.controller.handleCommand(cmd);
    }
  }

  async close(): Promise<CommandResult> {
    this.controller.stopBgEventLoop();
    await this.cleanup();
    return { status: "closed" };
  }

  private async cleanup(): Promise<void> {
    try {
      await this.controller.disconnect(true);
    } catch {
      // Best effort
    }

    if (this.adapterProcess) {
      const proc = this.adapterProcess;
      try {
        proc.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch { /* ignore */ }
            resolve();
          }, 3000);
          proc.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } catch {
        // Best effort
      }
    }
  }
}
