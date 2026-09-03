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
  /**
   * True for a note molt wrote to the model about the model's own behaviour
   * — an empty turn, or a step that only repeated itself. Distinct from a
   * bar failure: nothing was checked, and nothing is being demanded.
   */
  nudge?: true;
  /**
   * True for the standing note of what this turn is for.
   *
   * Shedding is mechanical and lossy by design, and the thing it loses first
   * is intent: after a compaction the model reads a digest of its own past and
   * re-derives what it was doing, usually by re-reading the files it had just
   * finished with. A few hundred tokens that never get shed are cheaper than
   * that, every time.
   */
  pinned?: true;
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
/**
 * A check that reports but does not block.
 *
 * Not every condition worth running is a condition worth refusing over. A
 * linter's opinion, a coverage delta, a bundle-size trend — a failing one is
 * information, and treating it as a broken contract teaches people to take
 * checks out of the bar rather than to read them.
 *
 * An advisory failure is shown on screen and recorded in the receipt. It is
 * deliberately NOT put in the message that goes back to the model, which says
 * "fix these and claim again" — a check that does not gate has no business in
 * that list, or the model spends tokens fixing theatre.
 */
export type Advisory = { advisory?: boolean };

export type Check = Advisory &
  (
    | {
        name: string;
        kind: "command";
        run: string;
        timeoutMs: number;
        expectExit: number;
        /** Portable selection labels, e.g. fast, slow, ci, local, manual. */
        tags: string[];
        /**
         * What this check reads, as globs.
         *
         * Declaring it lets molt skip a re-run when none of those files
         * changed — four proof attempts against a ten-second suite is forty
         * seconds of the inner loop spent re-proving the same thing. molt
         * does not guess the scope: an undeclared check is fingerprinted
         * against the whole project, which is correct and almost never
         * reusable, and that is the right default for a verification tool.
         */
        watch?: string[];
      }
    | {
        name: string;
        kind: "builtin";
        builtin: BuiltinCheck;
        tags: string[];
        /**
         * `comment-only: allow` on a files-changed check.
         *
         * Lets a diff of pure comments count as work landing. Off by default:
         * the failure it guards is a model adding a comment so the gate goes
         * green, which is how receipt 0025 was issued for no work at all.
         */
        commentOnly?: "allow";
        /** `spec-intact` only: this turn is allowed to delete an assertion. */
        removals?: "allow";
        /**
         * `tree-accounted` only: files may change outside the tools.
         *
         * Off by default. A project whose task is running a generator or an
         * install can say so here; everywhere else a change on disk that no
         * tool call wrote is a change nothing can prove or judge.
         */
        outside?: "allow";
        /**
         * Where to read lcov from, for `diff-covered`.
         *
         * Required, and deliberately not defaulted: a missing file makes the
         * check fail rather than pass, so guessing the path would turn a
         * misconfiguration into a permanent red.
         */
        lcov?: string;
        /** For `mutation`: the command that should fail when code is broken. */
        run?: string;
        /** For `mutation`: how many changed lines to break. Each costs a run. */
        sample?: number;
        /** For `mutation`: per-run timeout in ms. */
        timeoutMs?: number;
      }
  );

export type BuiltinCheck =
  | "files-changed"
  | "record-intact"
  | "claims-grounded"
  /**
   * No assertion was deleted from a test file.
   *
   * A turn may add tests freely. Taking one away is a change to what the
   * project promises, and a model that does it while fixing a bug has usually
   * rewritten the specification to agree with its own change rather than the
   * other way round. Set `removals: allow` on the check when a test really is
   * obsolete — deliberately awkward, because that should be a decision
   * somebody makes on purpose.
   */
  | "spec-intact"
  /**
   * Every file that changed on disk this turn was written through a tool.
   *
   * The ledger sees the tools; this sees the disk. A script the model wrote
   * and ran, `sed -i`, `cp /dev/null` — none has a ledger entry, and every
   * ledger-reading check was blind to them. Compares a snapshot of the tree
   * taken when the turn began against the tree when the claim is made.
   */
  | "tree-accounted"
  /**
   * Every line this turn added is executed by the tests, and every branch on
   * those lines is taken.
   *
   * The gap the other builtins leave. `files-changed` proves a file moved and
   * `substance` proves the movement was not only comments; neither can tell
   * whether the new code does anything. A constant referenced nowhere and a
   * guard no test trips pass all of them.
   *
   * Reads lcov the project's own tests produced — it does not run coverage
   * itself, because the command differs per project and a check that guesses
   * would be wrong more often than useful.
   */
  | "diff-covered"
  /**
   * Break each new line and confirm a test notices.
   *
   * The rung above diff-covered. Coverage proves a line runs; it cannot prove
   * anything checks what the line does, and a test that executes code while
   * asserting nothing satisfies it completely. Expensive — one run of the
   * command per mutation — so it belongs on a slow tag, not the inner loop.
   */
  | "mutation";

export type Bar = {
  version: 1;
  checks: Check[];
};

export type CheckResult = {
  name: string;
  /**
   * True when this result was reused rather than re-run.
   *
   * Surfaced everywhere a result is, because a reused pass presented as a
   * fresh one is exactly the quiet claim this tool exists to refuse.
   */
  cached?: boolean;
  /** True when a failure here reports rather than refuses. */
  advisory?: boolean;
  /**
   * True when the command never ran: not found, or not executable.
   *
   * It still counts as unmet — a check nobody can run is not a licence to
   * accept the claim — but it is described as a broken check rather than as
   * failing work, because sending a model to satisfy a command that does not
   * exist is how a gate teaches a model to invent the wrong change.
   */
  didNotRun?: boolean;
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
  /** True when every check that can block a completion passed. */
  ok: boolean;
  /**
   * True when the run was aborted before every check had answered.
   *
   * A check killed by ctrl+C exits non-zero, and that used to read as the
   * suite being red: a refused receipt, the failure sent back to the model,
   * another request, and the killed result cached as a failure until a
   * watched file moved. None of that is a verdict on the work.
   */
  cancelled?: boolean;
  /** Advisory checks that failed. Reported, never blocking. */
  warnings?: CheckResult[];
  results: CheckResult[];
  durationMs: number;
};

/**
 * Records what a file looked like immediately before molt wrote it, so a
 * later check can prove the write actually landed and survived.
 */
export type LedgerEntry = {
  path: string;
  /**
   * Assertions this write deleted from a test file.
   *
   * Read by `spec-intact`. Present only when a test file lost an assertion,
   * which is rare and always worth a person's attention: it is the difference
   * between fixing code so it meets its specification and editing the
   * specification so it meets the code.
   */
  specRemoved?: string[];
  /** sha256 before the write, or null if the file did not exist. */
  before: string | null;
  /** sha256 molt observed immediately after writing. */
  after: string;
  /**
   * Changed lines that are neither blank nor a comment.
   *
   * `work-landed` proves a write landed; it cannot, from a pair of hashes,
   * tell a fix from a sentence added to make it pass. This is what it reads to
   * decide. Optional because entries restored from an older archive predate
   * the field, and an absent count is treated as unknown rather than as zero.
   */
  substance?: number;
  /**
   * Which lines this write added or changed, 1-indexed into the file as it now
   * stands. Blank and comment lines excluded.
   *
   * Recorded so a check can ask whether the tests execute them. "A file
   * changed" and "the change is exercised by anything" are different claims,
   * and only the second is evidence that the work does something.
   */
  changedLines?: number[];
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
  /**
   * The model's final answer for the turn — the one event that says a turn
   * produced an answer at all, which is why `molt run` reads its exit code
   * from this and not from the deltas.
   *
   * `streamed` means the same text already went out as `delta` events. The
   * text is still carried here (redacted, and whole) so a caller that ignored
   * the deltas is not left without it, but a surface that rendered them must
   * not render it again — doing so is what printed the final answer twice in
   * `molt run`.
   */
  | { kind: "assistant_text"; text: string; streamed?: boolean }
  /** A fragment as it arrives. Render incrementally; do not accumulate twice. */
  | { kind: "delta"; text: string }
  /**
   * The assistant's message for this step is complete.
   *
   * Streamed prose does not end in a newline, so without an explicit end a
   * surface cannot tell the model's last word from its next one. Both used to
   * guess and both guessed wrong: the TUI ran every step's narration into the
   * next ("…product defects.The workspace is…") and printed the lot below the
   * tools it was describing, and the CLI closed the line on whatever event
   * happened to come next. The boundary is the engine's to state — it is the
   * only party that knows where the message ended.
   *
   * Emitted once per step, after the message is on the transcript and before
   * the tool calls it asked for, so narration lands above the work it
   * introduces.
   */
  | { kind: "message_end" }
  /**
   * A turn was cancelled. The transcript is rolled back; the filesystem is
   * not, because molt cannot un-write a file it already wrote — so any paths
   * that changed are named rather than covered by a claim of "unchanged".
   */
  | { kind: "cancelled"; filesWritten?: string[] }
  /**
   * The model has begun emitting a call to `name`, mid-stream.
   *
   * Earlier than `tool_start`, which fires once the message is complete and the
   * call is about to run. This is the moment the intent becomes knowable — the
   * name arrives in the stream several hundred milliseconds before the
   * arguments finish — and it exists because the silence between narration
   * ending and a tool row appearing is where a person concludes the model has
   * stalled. Three runs in one session were cancelled in that gap, one of them
   * three seconds before its first `list_files` would have fired.
   *
   * Advisory: a surface may ignore it. `tool_start` and `tool` still tell the
   * whole story, and a call announced here is always followed by one of them.
   */
  | { kind: "tool_pending"; name: string }
  /**
   * Discard whatever text this step has streamed so far.
   *
   * A stream that dies partway is retried, and the retry produces the message
   * again from the beginning. Text already on screen cannot be un-shown, which
   * is why streaming was buffered until the attempt had stuck — at the cost of
   * showing nothing at all during a step that takes half a minute.
   *
   * This is the other way to keep that promise: show the text as it arrives,
   * and if the attempt is abandoned, say so and take it back. A surface that
   * ignores this will duplicate the abandoned text, so it is not optional for
   * anything that renders `delta`.
   */
  | { kind: "stream_reset"; why: string }
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
      /** True when autonomy let this run without asking. */
      auto?: boolean;
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
  /** A user turn begins. Everything until `job_end` belongs to this job. */
  | { kind: "job_start"; job: number; text: string }
  /**
   * A user turn is over, with what it cost.
   *
   * The session meter answers "what have I spent?"; this answers "what did
   * that one question cost?", which is the number people actually reason
   * about when deciding whether to ask another.
   */
  | {
      kind: "job_end";
      job: number;
      steps: number;
      spend: Spend;
      durationMs: number;
      outcome: JobOutcome;
    }
  | {
      kind: "step_summary";
      job: number;
      step: number;
      /** Tool names called this step, in call order. */
      tools: string[];
      spend: Spend;
      sessionTokens: number;
      sessionCostUsd?: number;
      durationMs: number;
      /**
       * What the model did with the step: called tools, claimed done, or
       * returned nothing at all. `empty` is its own outcome because it is
       * not a claim — see the empty-turn guard in engine.ts.
       */
      outcome: "tools" | "claim" | "empty";
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

/**
 * How a job ended, in molt's own terms.
 *
 * "verified" is reserved for a claim that survived the bar. An answer with
 * no bar to check it against is "unverified" — a distinction the whole tool
 * exists to make, so it is not collapsed here for tidiness.
 */
export type JobOutcome =
  | "verified"
  /**
   * A question that was answered. The bar ran advisory, because a turn that
   * wrote nothing cannot have broken anything, so no check could refuse it —
   * and an answer no check could refuse is not "verified". Five of this
   * project's sixteen "verified changes" were questions before this existed.
   */
  | "answered"
  | "unverified"
  | "not proven"
  | "cancelled"
  | "error"
  | "stopped";

export type Confirm = (name: string, detail: string) => Promise<boolean>;

/** Honest estimate (≈ chars/4). Real usage comes from the API response. */
export const estTokens = (s: string): number => Math.ceil(s.length / 4);
