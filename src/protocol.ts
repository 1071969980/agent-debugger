/** Daemon <-> CLI protocol schemas. Newline-delimited JSON. */

import { z } from "zod";

// --- Envelope ---

/** Multi-session envelope: wraps a command with a session ID. */
export const Envelope = z.object({
  session_id: z.string().optional(),
  command: z.record(z.unknown()),
});

export type Envelope = z.infer<typeof Envelope>;

// --- Commands (CLI -> Daemon) ---

export const StartCommand = z.object({
  action: z.literal("start"),
  script: z.string(),
  language: z.string().optional(),
  breakpoints: z.array(z.string()).optional(),
  exception_filters: z.array(z.string()).optional(),
  runtime: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  stop_on_entry: z.boolean().optional(),
});

export const AttachCommand = z.object({
  action: z.literal("attach"),
  host: z.string().optional(),
  port: z.number().optional(),
  pid: z.number().optional(),
  language: z.string().optional(),
  runtime: z.string().optional(),
  breakpoints: z.array(z.string()).optional(),
  exception_filters: z.array(z.string()).optional(),
});

export const VarsCommand = z.object({ action: z.literal("vars") });
export const StackCommand = z.object({ action: z.literal("stack") });

export const EvalCommand = z.object({
  action: z.literal("eval"),
  expression: z.string(),
});

export const StepCommand = z.object({
  action: z.literal("step"),
  kind: z.enum(["over", "into", "out"]).optional(),
});

export const ContinueCommand = z.object({ action: z.literal("continue") });

export const BreakCommand = z.object({
  action: z.literal("break"),
  file: z.string(),
  line: z.number(),
  condition: z.string().optional(),
});

export const SourceCommand = z.object({
  action: z.literal("source"),
  file: z.string().optional(),
  line: z.number().optional(),
});

export const StatusCommand = z.object({ action: z.literal("status") });
export const CloseCommand = z.object({ action: z.literal("close") });
export const ListCommand = z.object({ action: z.literal("list") });
export const ShutdownCommand = z.object({ action: z.literal("shutdown") });

export const Command = z.discriminatedUnion("action", [
  StartCommand,
  AttachCommand,
  VarsCommand,
  StackCommand,
  EvalCommand,
  StepCommand,
  ContinueCommand,
  BreakCommand,
  SourceCommand,
  StatusCommand,
  CloseCommand,
  ListCommand,
  ShutdownCommand,
]);

export type Command = z.infer<typeof Command>;

// --- Results (Daemon -> CLI) ---

export interface LocationInfo {
  file: string;
  line: number;
  function: string;
}

export interface BreakpointInfo {
  file: string;
  line: number;
  verified: boolean;
}

export interface VariableInfo {
  name: string;
  value: string;
  type: string;
}

export interface SessionInfo {
  session_id: string;
  state: string;
  script?: string;
  pid?: number;
}

export interface ExceptionDetail {
  typeName: string;
  description: string;
  stackTrace: string;
}

export interface CommandResult {
  error?: string;
  status?: string;
  reason?: string;
  session_id?: string;
  location?: LocationInfo | null;
  breakpoints?: BreakpointInfo[];
  variables?: VariableInfo[];
  count?: number;
  frames?: LocationInfo[];
  result?: string;
  type?: string;
  exitCode?: number | null;
  source?: string;
  file?: string;
  line?: number;
  verified?: boolean;
  state?: string;
  message?: string;
  sessions?: SessionInfo[];
  exception?: ExceptionDetail | null;
}
