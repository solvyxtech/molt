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
  /** Prompt tokens the provider said it served from its cache. */
  sessionCachedTokens: number;
  costUsd?: number;
  /** True when any part of the cost rests on molt's own token estimate. */
  costEstimated?: boolean;
  budgetTokens?: number;
};

/**
 * What a turn cost, and how much of that molt actually knows.
 *
 * `estimated` is the whole point of the shape. A cost derived from token
 * counts molt guessed is a different kind of number from one the provider
 * billed, and a meter that renders them identically is lying by omission.
 */
export type Spend = {
  promptTokens: number;
  completionTokens: number;
  /** Cached prompt tokens, when the provider itemises them. */
  cachedTokens: number;
  costUsd?: number;
  /** True when token counts came from molt's estimator, not the provider. */
  estimated: boolean;
  /** True when the provider itself reported the dollar figure. */
  billed: boolean;
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
  | {
      kind: "tool";
      name: string;
      detail: string;
      note?: string;
      durationMs?: number;
      /** Exact arguments the model sent, as JSON. Capped, never reworded. */
      args?: string;
      /** Bytes of result handed back to the model. */
      bytes?: number;
      /** Head of that result, verbatim. Truncated, never summarized. */
      preview?: string;
    }
  | {
      kind: "usage";
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      sessionTokens: number;
      costUsd?: number;
      /** True when these counts are molt's estimate rather than the provider's. */
      estimated: boolean;
      /** True when the provider reported the dollar figure directly. */
      billed: boolean;
    }
  /**
   * A request is about to go out. Carries only what molt can state as fact
   * before the answer exists — size, destination, and whether the estimate
   * is an estimate.
   */
  | {
      kind: "request";
      step: number;
      messages: number;
      estTokens: number;
      model: string;
      stream: boolean;
    }
  /**
   * One pass of the loop, closed out. Emitted after every step so a reader
   * never has to infer what a step did from the tool lines that scrolled
   * past — and so the running total is reconciled step by step rather than
   * only at the end.
   */
  | {
      kind: "step_summary";
      step: number;
      /** Tool names called this step, in call order. */
      tools: string[];
      spend: Spend;
      sessionTokens: number;
      sessionCostUsd?: number;
      durationMs: number;
      /** What the model did with the step: called tools, or claimed done. */
      outcome: "tools" | "claim";
      /** Provider-reported stop reason, when one was given. */
      finishReason?: string;
    }
  | { kind: "proof_start"; checks: number; names: string[] }
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
