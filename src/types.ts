/**
 * Shared types for molt's core.
 *
 * Nothing in this file imports React, Ink, or the filesystem. Every module
 * that carries proof logic depends only on these types, so the whole
 * verification path is testable without mounting a terminal.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
};

/**
 * A conversation message. `molt` carries molt's own bookkeeping and is
 * stripped before anything goes on the wire — earlier versions sniffed a
 * string prefix to identify digests, which broke the moment a user pasted
 * text that started the same way.
 */
export type Msg = {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  molt?: MsgMeta;
};

export type MsgMeta = {
  /** True for a mechanically-generated digest of shed context. */
  digest?: true;
  /** True for context deliberately re-attached from the archive. */
  regrown?: true;
  /** True for a bar-failure notice injected by the proof loop. */
  barFailure?: true;
};

export type Bom = {
  systemTokens: number;
  toolSchemaTokens: number;
  historyTokens: number;
  requestTotalEst: number;
  sessionPromptTokens: number;
  sessionCompletionTokens: number;
  costUsd?: number;
  budgetTokens?: number;
};

/** A single verifiable condition from `.molt/done.yml`. */
export type Check =
  | {
      name: string;
      kind: "command";
      run: string;
      timeoutMs: number;
      expectExit: number;
      /** Portable selection labels, e.g. fast, slow, ci, local, manual. */
      tags: string[];
    }
  | {
      name: string;
      kind: "builtin";
      builtin: BuiltinCheck;
      tags: string[];
    };

export type BuiltinCheck = "files-changed" | "record-intact" | "claims-grounded";

export type Bar = {
  version: 1;
  checks: Check[];
};

export type CheckResult = {
  name: string;
  tags?: string[];
  kind: "command" | "builtin";
  /** The command run, or the builtin's identifier. */
  detail: string;
  ok: boolean;
  exitCode?: number;
  /** Truncated combined output, or the builtin's explanation. */
  output: string;
  durationMs: number;
};

export type BarResult = {
  ok: boolean;
  results: CheckResult[];
  durationMs: number;
};

/**
 * Records what a file looked like immediately before molt wrote it, so a
 * later check can prove the write actually landed and survived.
 */
export type LedgerEntry = {
  path: string;
  /** sha256 before the write, or null if the file did not exist. */
  before: string | null;
  /** sha256 molt observed immediately after writing. */
  after: string;
  /**
   * The tool call that performed this write. Used to decide whether the
   * entry travels with a shed batch.
   *
   * Deliberately not a message index: indices shift when shedding replaces a
   * dropped prefix with a digest, so any index has to be rebased and a
   * missed rebase silently misfiles evidence. A call id is stable for the
   * life of the session and matches exactly one message.
   */
  callId: string;
};

export type EngineEvent =
  | { kind: "assistant_text"; text: string }
  /** A fragment as it arrives. Render incrementally; do not accumulate twice. */
  | { kind: "delta"; text: string }
  | { kind: "cancelled" }
  // Emitted before the tool runs, so a UI can say what is happening while it
  // happens. `tool` still follows on completion and carries the outcome.
  | { kind: "tool_start"; name: string; detail: string }
  | { kind: "tool"; name: string; detail: string; note?: string; durationMs?: number }
  | {
      kind: "usage";
      promptTokens: number;
      completionTokens: number;
      sessionTokens: number;
      costUsd?: number;
    }
  | { kind: "proof_start"; checks: number }
  | { kind: "proof_result"; result: BarResult; attempt: number }
  | { kind: "proof_refused"; result: BarResult; attempt: number }
  | { kind: "proof_exhausted"; result: BarResult; attempts: number }
  | { kind: "receipt"; path: string }
  | { kind: "shed"; before: number; after: number; dropped: number; path: string }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export type Confirm = (name: string, detail: string) => Promise<boolean>;

/** Honest estimate (≈ chars/4). Real usage comes from the API response. */
export const estTokens = (s: string): number => Math.ceil(s.length / 4);
