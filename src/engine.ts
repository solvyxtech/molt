/**
 * molt's engine — a small agent loop that speaks the OpenAI-compatible
 * /chat/completions wire format, so one implementation covers OpenAI,
 * OpenRouter, Groq, Mistral, and — the point — local llama.cpp / Ollama /
 * vLLM servers. Any base URL, any key, any model.
 *
 * What makes it molt rather than one more harness is the proof gate. When
 * the model stops calling tools and produces a final answer, that answer
 * is treated as a CLAIM, not a result. molt runs the project's bar
 * (.molt/done.yml). If any check fails, the claim is refused, the exact
 * failures go back to the model, and the loop continues. The model does
 * not get to decide when it is finished.
 *
 * Design rules:
 *  - Three tools. Everything else is bash.
 *  - Every write is ledgered with before/after hashes, so a later check can
 *    prove the write landed and survived.
 *  - Shedding is two-phase: archive first, mutate second.
 *  - Nothing is summarized by a model, ever.
 */
import { runCommand } from "./run.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import type { ArchiveLike } from "./archive.js";
import { CheckCache, barFingerprint, formatBarFailure, runBar, type BarContext } from "./bar.js";
import {
  AUTONOMY_SUMMARY,
  DEFAULT_AUTONOMY,
  gate,
  insideProject,
  type Autonomy,
} from "./autonomy.js";
import { redact } from "./redact.js";
import {
  SKIP_DIRS,
  WALK_DEADLINE_MS,
  applyEdit,
  formatListing,
  formatMatches,
  grepFiles,
  substanceOf,
  walkAsync,
} from "./files.js";
import {
  isAnthropicNative,
  messagesUrl,
  readNativeStream,
  toMessage,
  toRequest,
  usageFor,
  finishReasonFor,
} from "./anthropic.js";
import { breakpoints, withCaching, refusedCaching, type CacheStyle, cacheStyle } from "./cache.js";
import { Journal } from "./journal.js";
import { authHeaders, isSelfHosted } from "./providers.js";
import { Receipts } from "./receipts.js";
import { readStream, type StreamAccumulator, type Usage } from "./stream.js";
import { Fragments, SafeStream } from "./live.js";
import { Transcript, toolDetail } from "./transcript.js";
import {
  estTokens,
  type Bar,
  type Check,
  type CheckResult,
  type BarResult,
  type Bom,
  type Confirm,
  type EngineEvent,
  type LedgerEntry,
  type JobOutcome,
  type Msg,
  type Spend,
} from "./types.js";

/** A reading of the session meter, for measuring one job against. */
type Meter = {
  prompt: number;
  completion: number;
  cached: number;
  billed: number;
  unbilledSteps: number;
  estimatedSteps: number;
  costUsd?: number;
};

export const SYSTEM_PROMPT = [
  "You are molt, a coding agent working in the current directory.",
  "Read only what you need. Be terse.",
  "",
  "Relative paths resolve against the working directory named below. Never guess",
  "an absolute path — a home directory you inferred from a username is a path you",
  "invented, and every call against it fails before it teaches you anything.",
  "",
  "Tool results stay in this conversation. Never read a file twice unless you changed",
  "it — scroll up. If you want a file you already have, you are done gathering: answer,",
  "or say what is blocking you.",
  "",
  "This project defines what 'done' means in .molt/done.yml. When you finish,",
  "those checks run automatically. If any fail you will be told exactly which,",
  "with their output, and you must fix the underlying problem and continue.",
  "Do not edit .molt/done.yml to make checks pass. Do not claim work you have",
  "not done — it will be checked against the full session record.",
  "",
  "If you are unsure whether something worked, say so and check it rather than",
  "asserting it. An unverified claim costs the same as a false one.",
].join("\n");

/**
 * The system prompt, with the one fact only the process knows.
 *
 * "Working in the current directory" told the model a directory existed and
 * not which one, so two sessions in a row invented a home from a username —
 * `/Users/erik`, then `/Users/daniel` — and spent eight tool calls proving
 * those paths were not there before either thought to run `pwd`. The
 * directory is a constant for the whole session, so it costs one line once
 * and stays inside the cached prefix.
 */
export function systemPromptFor(cwd: string): string {
  return `${SYSTEM_PROMPT}\n\nThe working directory is ${cwd} — that, and not a guess, is where relative paths land.`;
}

/**
 * How much of a tool result comes back.
 *
 * Tool results are the bulk of a session's tokens, because every one of them
 * is resent on every subsequent request — which argues for a tight cap. It
 * argued too well: at 2048 bytes for everything, reading a 17KB README took
 * nine round trips, and each of those round trips resent the entire
 * conversation. The tight cap cost more tokens than the large read it was
 * avoiding, and produced a session that looked exactly like a model looping.
 *
 * So the cap is per kind of result, sized to how the result is used:
 *
 *  - A file is read to be understood, and paging through one in 2KB slices
 *    is the expensive way to spend a context window. 16KB is roughly 4k
 *    tokens, which holds most source files whole.
 *  - Command output is mostly noise with a signal at one end, and a failing
 *    suite's first 8KB says what failed.
 *
 * Truncation is always visible, never silent, and a truncated read always
 * says how to continue.
 */
/**
 * What one turn may spend before molt stops it, unless told otherwise.
 *
 * There was no ceiling, only a 32-step guard — and a session that thrashed
 * inside those 32 steps spent 661,000 tokens and most of a dollar over
 * thirteen minutes before anything intervened. Steps are the wrong unit:
 * a step can cost a hundred tokens or thirty thousand.
 *
 * Deliberately generous enough for real work and far below "how did this cost
 * a dollar". `/budget` raises or removes it, and the message says so.
 */
/**
 * What one turn may spend before molt stops it, unless told otherwise.
 *
 * Denominated in money, because tokens are the wrong unit for this and it took
 * a user pointing at the arithmetic to see it. A token ceiling scales with
 * context size, so the same limit buys forty steps on a small project and four
 * on a large one — it punishes depth rather than waste. And it ignores
 * caching: 228,000 cumulative prompt tokens with 75% cache hits costs about
 * $0.22, while the token count says $0.68. Charging a budget for tokens the
 * provider is discounting is charging for work nobody did.
 *
 * Waste is caught by the guards that can actually recognise it — repeats,
 * drifting re-reads, steps that learn nothing. This is only the backstop for
 * a turn that is genuinely, expensively going somewhere it should not.
 *
 * The token fallback applies when no price is known, and is deliberately
 * generous: without a price, molt cannot tell an expensive turn from a long one.
 */
export const DEFAULT_TURN_USD = 1.0;
export const DEFAULT_TURN_TOKENS = 500_000;

/** Fractions of the ceiling at which molt says something, once each. */
const CEILING_WARNINGS = [0.5, 0.8];

/**
 * When working history gets compacted, unless told otherwise.
 *
 * Shedding was built for exactly the situation that broke a real session —
 * reading a whole codebase, where the conversation grows until every step
 * resends a hundred kilobytes — and it was off by default, so it never ran.
 * A feature that only works when configured is a feature most sessions do
 * not have.
 *
 * Safe as a default because of where verification reads from: the bar checks
 * the ledger, the disk, and the archive, never the transcript. Shedding costs
 * the model some working memory and costs molt's proof nothing, the full
 * original is preserved in `.molt/exuviae/`, `record-intact` fails if it is
 * not, and `/regrow` pulls it back by pattern.
 */
export const DEFAULT_AUTO_SHED_TOKENS = 60_000;

/**
 * A context-overflow refusal, and the window it named.
 *
 * Some endpoints answer an oversized request with the one number molt most
 * needs and has no other way to learn: how much context they actually serve.
 * A local llama.cpp says
 *
 *     request (17222 tokens) exceeds the available context size (16384
 *     tokens) ... "n_ctx": 16384
 *
 * molt was treating that as an ordinary 400 and ending the turn, having shed
 * nothing — its own threshold is 60,000 tokens, nearly four times a window it
 * had no idea was that small. But this is the most recoverable failure there
 * is: the fix is to carry less, the request has not been billed, and the
 * server has just said exactly how much less. Returns the window in tokens, or
 * 0 when the body says nothing about one.
 */
export type Overflow = {
  /** The window the server serves, or 0 when it did not say. */
  window: number;
  /**
   * How many tokens the server counted in the request molt just sent.
   *
   * The single most valuable number in the body, and it was being thrown away.
   * molt estimates tokens as characters/4, which is roughly right for prose and
   * badly wrong for code: one session shed its history to an estimated 11.6k
   * and the server counted the result at 24,307. Every decision about what to
   * drop was being made in a unit twice the size of the real one.
   *
   * Comparing this against molt's own estimate of the same request gives the
   * ratio between them, which is the only way to shed to a size that fits.
   */
  sent: number;
};

export function contextOverflow(body: string): Overflow | null {
  if (!/context|n_ctx|too many tokens|maximum context length/i.test(body)) return null;
  // Every field the common servers use, most specific first.
  const win =
    /"n_ctx"\s*:\s*(\d+)/.exec(body) ??
    /context size \((\d+)\s*tokens?\)/i.exec(body) ??
    /maximum context length is (\d+)/i.exec(body);
  const sent =
    /"n_prompt_tokens"\s*:\s*(\d+)/.exec(body) ??
    /request \((\d+)\s*tokens?\)/i.exec(body) ??
    /you requested (\d+)/i.exec(body);
  return { window: win ? Number(win[1]) : 0, sent: sent ? Number(sent[1]) : 0 };
}

/**
 * How many real tokens one of molt's estimated tokens is worth.
 *
 * `estTokens` counts characters/4. Real tokenizers disagree, and they disagree
 * most on exactly the content an agent carries: indented code, punctuation
 * runs, long identifiers, JSON. Measured against a local qwen3-coder, molt's
 * estimate was about half the truth.
 *
 * Clamped because this multiplies a size limit. Below 1 it would let molt
 * carry more than it measured; far above it, one strange response would shed
 * a whole session to nothing.
 */
export function tokenScale(reported: number, estimated: number): number {
  if (!(reported > 0) || !(estimated > 0)) return 1;
  return Math.min(8, Math.max(1, reported / estimated));
}

/**
 * The history budget, in molt's own estimate units, that fits a real window.
 *
 * Everything here has to cross between two units. The window is in the
 * server's tokens; `historyTokens()` and the auto-shed threshold are in molt's.
 * `scale` is the bridge.
 *
 * `fixedEst` is the system prompt plus the tool schemas — the part of a request
 * that shedding cannot touch. Subtracting it is the difference between a target
 * that fits and one that cannot: two thirds of a 16,384 window is 10,813, and
 * a session whose tools alone cost more than that will refuse forever, shedding
 * every message it has and still overflowing.
 *
 * Returns 0 when the fixed overhead cannot fit the window at all, which is not
 * a smaller number to try — it means this server cannot run molt at this size.
 */
export const REPLY_RESERVE = 0.35;

/**
 * How many shed-and-retry rounds one step may spend.
 *
 * Each round costs a refused request, which is not billed and not slow, and
 * teaches molt the real ratio between its estimate and the server's count. Three
 * is enough to converge from a 2x error; more would be a loop rather than a
 * correction.
 */
export const OVERFLOW_ROUNDS = 3;

/**
 * How many recent exchanges a shed keeps, on the nth overflow round.
 *
 * `shed()` drops everything older than the last `keepExchanges` and ignores
 * the token threshold entirely — so calling it twice with the same argument
 * finds nothing to drop the second time, and a lower threshold changes
 * nothing. That is why a second round appeared to do nothing: the threshold
 * was the only thing being lowered.
 *
 * Loosening the grip instead: two exchanges, then one. It stops at one rather
 * than zero because the exchange being shed for is the one the turn is in the
 * middle of, and dropping that leaves nothing to answer.
 */
export function keepForRound(round: number): number {
  return Math.max(1, 3 - round);
}

/**
 * How many recent messages a shed keeps, on the nth overflow round.
 *
 * The companion to `keepForRound`, and the one that actually bites. A turn
 * with one ask and forty tool calls has no user turn to cut on, so `planShed`
 * falls back to keeping a fixed number of recent messages — and a fixed number
 * drops the same messages every round. Six, then four, then two.
 */
export function keepRecentForRound(round: number): number {
  return Math.max(2, 8 - round * 2);
}

export function historyBudget(window: number, fixedEst: number, scale: number): number {
  if (!(window > 0)) return 0;
  // Room for the reply and the tool results the next step will add.
  const usableReal = window * (1 - REPLY_RESERVE);
  const usableEst = Math.floor(usableReal / Math.max(scale, 1));
  const target = usableEst - fixedEst;
  return target > 500 ? target : 0;
}

export const TOOL_RESULT_MAX_BYTES = 8192;
/**
 * How much of a file one `read_file` may return.
 *
 * A tuning decision rather than a bug fix, but it is spent money either way.
 * At 16KB — roughly four hundred lines — most real source files came back in
 * pieces, and a part is not cheaper than the whole: the file ends up in the
 * conversation regardless, only now across several steps, each of which
 * resends everything before it. Reading molt's own `src/` cost 36 round trips
 * at 16KB and costs 27 at 32KB, against a floor of 22 (one per file).
 *
 * Not larger than this, though the arithmetic keeps improving: 64KB saves only
 * three more trips and doubles what a single careless read can dump into the
 * context, and overflowing into a shed is far more expensive than the round
 * trip it saved — a shed throws away the prompt cache the whole session has
 * been riding on.
 */
export const READ_MAX_BYTES = 32_768;

/**
 * The largest share of a context window one tool result may occupy.
 *
 * A 32KB read is about 8,000 tokens by molt's count and more by a real
 * tokenizer's. Against a 128k window that is nothing. Against the 16,384 a
 * local llama.cpp serves by default it is most of the room in the request, and
 * two of them make the next step impossible — which is exactly what happened:
 * a shed freed 400 tokens out of 18,300 because the bulk was not in old
 * messages at all, it was in one result that shedding keeps by design.
 *
 * Shedding cannot repair that; nothing older is the problem. So the size of a
 * result is bounded by the window it has to fit inside, and the model is told
 * to page rather than handed something that cannot be carried.
 */
export const RESULT_WINDOW_SHARE = 0.2;

/**
 * How many bytes one tool result may return, given what the endpoint serves.
 *
 * `window` is in the server's tokens and `scale` converts molt's estimate into
 * them, so the arithmetic crosses back into bytes at four per estimated token.
 * An unknown window leaves the old cap alone — this narrows for small servers
 * and changes nothing for large ones.
 */
export function resultBudgetBytes(window: number, scale: number, cap = READ_MAX_BYTES): number {
  if (!(window > 0)) return cap;
  const realTokens = window * RESULT_WINDOW_SHARE;
  const estTokensAllowed = realTokens / Math.max(scale, 1);
  // A floor, because a result too small to contain a useful excerpt is a
  // different way of failing.
  return Math.max(2_048, Math.min(cap, Math.floor(estTokensAllowed * 4)));
}
export const MAX_STEPS = 32;
export const MAX_PROOF_ATTEMPTS = 4;
export const DEFAULT_BASH_TIMEOUT_MS = 60_000;

/**
 * How many times a failed request is retried before the turn gives up.
 *
 * A transient network failure is not evidence about the work, and treating it
 * as fatal is the most expensive possible reading of it: the turn's tokens are
 * already spent, and ending on the spot buys nothing with them.
 */
/**
 * Prompt size above which a collapsed cache is worth interrupting about.
 *
 * Below this the difference is pennies and the noise is not worth it; above it,
 * every step re-reads a conversation that was being served from cache a moment
 * ago.
 */
export const CACHE_WATCH_TOKENS = 10_000;

export const NETWORK_RETRIES = 3;
export const NETWORK_BACKOFF_MS = [500, 2_000, 5_000];

/**
 * How long a provider asked us to wait, from `Retry-After`.
 *
 * Sent as either a number of seconds or an HTTP date. Believed over the fixed
 * backoff when present: guessing shorter buys a second refusal, and guessing
 * longer spends the wait for nothing. Clamped, because a header saying "come
 * back in an hour" is not something to sit inside a turn for.
 */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers?.get?.("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, 30_000);
}

/** Wait, unless the turn is cancelled first — then return immediately. */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file. A long file arrives in parts; the result gives the offset that " +
        "continues it. Same arguments return the same part.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number", description: "First line, 0-based." },
          limit: { type: "number", description: "How many lines." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a file, or overwrite one whole. Use edit_file to change part of one.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List a directory, skipping build and dependency directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Default '.'." },
          depth: { type: "number", description: "Levels down. Default 1." },
          glob: { type: "string", description: "e.g. '**/*.ts'." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents by regular expression. Returns path:line: text.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Default '.'." },
          glob: { type: "string", description: "e.g. '**/*.ts'." },
          ignore_case: { type: "boolean" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace exact text. Copy old_text verbatim from a read; refused if absent, or if " +
        "ambiguous without replace_all.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command here. Use list_dir and grep instead of ls/grep/find.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
] as const;

const TOOL_SCHEMA_JSON = JSON.stringify(TOOLS);

const SECRET_ENV = [
  "MOLT_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
];

/** Per-turn options. Nothing here changes the session's configuration. */
export type RunOptions = {
  /**
   * Treat the turn as a question. Checks that cannot be satisfied without a
   * file change are not run — a lookup or an explanation can never satisfy
   * one, and refusing an honest answer for failing to invent work punishes
   * exactly the behaviour molt is built to encourage.
   */
  ask?: boolean;
  /**
   * Asked when a turn reaches its spending ceiling, before it stops.
   *
   * Returning true doubles the ceiling and carries on; anything else stops the
   * turn as it always did. Supplied only by an interactive session — a headless
   * run has nobody to ask, and a ceiling that could be waved through
   * unattended is not a ceiling.
   */
  onCeiling?: (spent: string) => Promise<boolean>;
  /**
   * What "done" means for THIS task, on top of what it means for the project.
   *
   * `.molt/done.yml` is deliberately per-project and deliberately not read
   * from the prompt: a bar the model can define is not a bar. But that makes it
   * blind in one direction — it verifies that the project is healthy, not that
   * the task was done. A comment added to a file passes `work-landed` and a
   * green suite, and neither knows what you asked for.
   *
   * These close that gap without handing over the pen. They are supplied by
   * the caller before the turn starts, frozen when it does, and never written
   * to done.yml. A model may *draft* them — it is good at "what would prove
   * this?" — but what it drafts is a proposal a person approves, and the
   * approval happens before any work exists to be judged.
   */
  taskChecks?: Check[];
  /**
   * Criteria stated in words rather than as commands.
   *
   * Recorded on the receipt and shown to the model, never treated as passed.
   * A sentence no machine checked is a statement of intent, and reporting one
   * as verified would be the exact failure this tool exists to refuse — so
   * these are carried through to the receipt labelled as unverified, and they
   * cannot make a turn succeed or fail.
   */
  taskNotes?: string[];
};

/**
 * The bar minus the checks that require a write to pass. Only
 * `files-changed` is inherently one: every other check reads state that a
 * read-only turn can still satisfy, so it stays.
 */
export function withoutWriteChecks(bar?: Bar | null): Bar | null {
  if (!bar) return null;
  return {
    ...bar,
    checks: bar.checks.filter((c) => !(c.kind === "builtin" && c.builtin === "files-changed")),
  };
}

/**
 * The bar as it applies to a question.
 *
 * Dropping `files-changed` was not enough, and the gap showed up the first
 * time someone asked a question in a real project: "ask only was ticked and I
 * still got bar not met". They had. The write check was gone, and `tests` had
 * run anyway and failed — on a turn that wrote nothing.
 *
 * That is a category error rather than a strict gate. The bar exists to stop a
 * model claiming work it did not do; a question claims no work, so there is
 * nothing to refuse. And the failure is not attributable: a turn that touched
 * no file cannot have broken a suite, so if the suite is red it was red before
 * the question was asked. Refusing the answer punishes the reader for the
 * state of the repository.
 *
 * So the remaining checks still run — knowing the suite is red is worth
 * having — but they run advisory. They report, and they do not refuse.
 *
 * `wroteNothing` is what keeps this from being a way out of the bar, which is
 * the reason it was not built this way to begin with. Ticking "ask" drops the
 * write *check*, not the ability to write: a turn in ask mode can still edit a
 * file and break the suite it is about to be judged by. So the softening
 * applies only to a turn whose ledger is empty. Change anything at all and the
 * bar is the bar, whichever box was ticked.
 */
/**
 * The project's bar plus this turn's criteria.
 *
 * Task checks go last so the cheap project checks fail first, and are prefixed
 * so a receipt never leaves you wondering whether `builds` was the project's
 * rule or this task's. A name collision resolves toward the project: its bar
 * is the one that outlives the turn.
 */
/**
 * A short, stable fingerprint of this turn's criteria.
 *
 * Written to the journal before the first request and to the receipt after the
 * last, so the two can be compared. If they differ, the criteria moved during
 * the turn — which they cannot, but a claim that rests on "cannot" is worth
 * less than one a reader can check.
 */
export function sealOf(checks: Check[], notes: string[]): string {
  const canon = JSON.stringify({
    checks: checks.map((c) => ({
      name: c.name,
      kind: c.kind,
      run: c.kind === "command" ? c.run : c.builtin,
    })),
    notes,
  });
  return createHash("sha256").update(canon, "utf8").digest("hex").slice(0, 16);
}

export function withTaskChecks(bar: Bar | null | undefined, task: Check[]): Bar | null {
  if (!task.length) return bar ?? null;
  const base = bar ?? { version: 1 as const, checks: [] };
  const taken = new Set(base.checks.map((c) => c.name));
  const added = task
    .map((c) => ({ ...c, name: c.name.startsWith("task:") ? c.name : `task:${c.name}` }))
    .filter((c) => !taken.has(c.name));
  return { ...base, checks: [...base.checks, ...added] };
}

export function asQuestion(bar: Bar | null | undefined, wroteNothing: boolean): Bar | null {
  const dropped = withoutWriteChecks(bar);
  if (!dropped || !wroteNothing) return dropped;
  return {
    ...dropped,
    checks: dropped.checks.map((c) => ({ ...c, advisory: true as const })),
  };
}

export type EngineConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  provider?: string;
  cwd?: string;
  priceInPerMtok?: number;
  priceOutPerMtok?: number;
  /**
   * USD per 1M cached prompt tokens. Every provider that caches bills those
   * tokens at a discount; charging them at the full rate is a wrong number,
   * not a conservative one. Undefined means "bill them as ordinary prompt
   * tokens", which is what molt did before it could tell them apart.
   */
  priceCachedInPerMtok?: number;
  /** Where the prices came from — an endpoint, or "set by hand". */
  priceSource?: string;
  bashTimeoutMs?: number;
  /**
   * Force the native Anthropic protocol on or off. Inferred from the endpoint
   * when unset; present so a test can drive either path against a fake.
   */
  nativeApi?: boolean;
  /**
   * Response ceiling for protocols that demand one. Anthropic's Messages API
   * requires `max_tokens`; the OpenAI shape treats it as optional.
   */
  maxTokens?: number;
  /**
   * Backoff between retries, in ms per attempt. Injectable so tests can prove
   * the retry policy without sitting through it — the real waits add half a
   * minute to a suite that runs on every proof, which is molt's own bar
   * charging the user for a nap.
   */
  retryBackoffMs?: number[];
  fetchFn?: typeof fetch;
  /** Stream tokens as they generate. On by default; a dead TUI reads as broken. */
  stream?: boolean;
  /** Project bar. When absent the proof gate is disabled and molt says so. */
  bar?: Bar | null;
  archive?: ArchiveLike;
  receipts?: Receipts;
  /** Append-only hash-chained record of everything this session did. */
  journal?: Journal;
  maxProofAttempts?: number;
  /**
   * Shed automatically once working history exceeds this many tokens.
   * Defaults to DEFAULT_AUTO_SHED_TOKENS; 0 disables it.
   */
  autoShedAtTokens?: number;
  /** Tokens one turn may spend when no price is known. 0 disables it. */
  maxTurnTokens?: number;
  /** USD one turn may spend when a price is known. 0 disables it. */
  maxTurnUsd?: number;
  /** Drop tool results that later work superseded. On by default. */
  elideSuperseded?: boolean;
  /** How much molt may do without asking. Defaults to asking about everything. */
  autonomy?: Autonomy;
};

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of SECRET_ENV) delete env[k];
  return env;
}

function sha256Of(p: string): string | null {
  if (!existsSync(p)) return null;
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/**
 * What a watcher is shown of a tool's arguments or its result.
 *
 * Everything the model got. Not a summary, not a head — the result was already
 * capped on its way to the model, and capping it again on its way to the
 * person watching means the two of you are looking at different things. That
 * is the one outcome a transparency view cannot have.
 *
 * The bound is the tool-result cap itself, so what you see is exactly what the
 * model saw, byte for byte.
 */
function capture(s: string): string {
  return s;
}

/**
 * Name the failing check when the ONLY thing standing between a turn and an
 * answer is a check that demands a write. Read-only work — a question, a
 * lookup, an explanation — can never satisfy one, so the refusal needs to
 * say that in the user's terms rather than read as molt malfunctioning.
 */
/**
 * Is this path build output rather than work?
 *
 * A write into a generated directory is not a change to the project, and
 * ledgering one has two consequences, both bad. `work-landed` counts it, so a
 * turn can satisfy the bar without touching anything a person wrote. And the
 * ledger then holds a file the next `npm run build` overwrites, so the check
 * fails on the *next* turn for a reason nobody can act on.
 *
 * Both happened. molt hit the second, correctly reported that a ledgered file
 * no longer matched disk — and then rewrote the compiled artifact so the
 * hashes would agree, satisfying the check rather than doing the work. It got
 * a green receipt in 34ms, because a path under `dist-test/` is outside every
 * `watch:` glob in the bar, so the expensive checks were reused as well.
 *
 * A route to "bar met" that involves no verification is the one defect this
 * product cannot carry. The write still happens — molt is not refusing to
 * touch these paths — it simply is not evidence of work.
 */
function isGenerated(rel: string): boolean {
  return rel
    .split(/[\\/]/)
    .some((seg) => seg === "dist" || seg === "dist-test" || SKIP_DIRS.has(seg));
}

function failedOnlyWriteChecks(result: BarResult): string | null {
  const failed = result.results.filter((r) => !r.ok);
  if (failed.length === 0) return null;
  return failed.every((r) => r.detail === "files-changed") ? failed.map((r) => r.name).join(", ") : null;
}

/**
 * A stable identity for a tool call, so "the same question" is recognised
 * however the model happens to spell it.
 */
function callKey(name: string, args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    // An explicit zero offset is the default, and says nothing new.
    .filter(([k, v]) => !((k === "offset" || k === "limit") && Number(v) === 0))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .sort();
  return `${name}(${parts.join(",")})`;
}

/** Dollars, for a message that has to be readable without a formatter. */
function fmtUsd(usd: number): string {
  return usd >= 0.1 ? `$${usd.toFixed(2)}` : usd >= 0.001 ? `$${usd.toFixed(3)}` : "<$0.001";
}

/** A tool argument that should be a non-empty string, or nothing. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** A tool argument that should be a non-negative integer, or its default. */
function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * One part of a file, and how to get the next.
 *
 * The old read_file took a path and nothing else, and every result was cut to
 * TOOL_RESULT_MAX_BYTES. For a 17KB README that meant the first 2KB and no way
 * on earth to reach the rest — so a model that needed more had exactly one
 * move available: call read_file again, and receive the same 2KB. That is not
 * a model looping. That is a dead end with a retry button, and it cost a real
 * session thirty steps and fifty cents.
 *
 * Paging turns the dead end into a path: every truncated result says how many
 * lines are left and the offset that continues it.
 */
function readPart(
  abs: string,
  shown: string,
  offset: number,
  limit: number,
  cap = READ_MAX_BYTES,
): string {
  const raw = readFileSync(abs, "utf8").split("\n");
  // A trailing newline is a terminator, not an empty last line. Counting it
  // reports 401 lines for a 400-line file, and every offset the model is told
  // to use is then one past what it means.
  const lines = raw.length > 1 && raw.at(-1) === "" ? raw.slice(0, -1) : raw;
  const from = Math.min(offset, lines.length);
  const until = Math.min(lines.length, from + limit);

  // The label and the continuation notice have to fit inside the same budget
  // as the content. Filling to the cap and appending them afterwards is how
  // the first version of this failed: truncateResult then cut the notice off
  // the end, so the model was handed a part of a file and no way to ask for
  // the rest — the dead end this function exists to remove, rebuilt one layer
  // up. The reserve uses the longest form either line can take.
  const label = `[molt: ${shown} lines ${from + 1}-${lines.length} of ${lines.length}]`;
  const notice = `[molt: ${lines.length} more line(s). Continue with read_file offset=${lines.length}.]`;
  const reserve = Buffer.byteLength(label + "\n" + notice + "\n", "utf8");
  const budget = Math.max(256, cap - reserve);

  const out: string[] = [];
  let bytes = 0;
  let i = from;
  let lineWasCapped = false;
  for (; i < until; i++) {
    const line = lines[i]!;
    const size = Buffer.byteLength(line, "utf8") + 1;
    // Always return at least one line, even an enormous one: a caller that
    // gets nothing back cannot tell "empty" from "too big to send". But
    // "enormous" is unbounded — a single line with no newline in it (a
    // minified bundle, a data dump, one runaway log line) can be megabytes
    // on its own, and returning it whole defeats the entire budget this
    // function exists to enforce. So the one line that would blow the
    // budget by itself is capped to it, not exempted from it.
    if (out.length > 0 && bytes + size > budget) break;
    if (size > budget) {
      out.push(capToBytes(line, budget));
      lineWasCapped = true;
      i++;
      break;
    }
    out.push(line);
    bytes += size;
  }

  const whole = from === 0 && i >= lines.length && !lineWasCapped;
  if (whole) return out.join("\n");

  // A part is labelled, because a model holding lines 40-80 of a file needs to
  // know that is what it is holding.
  const head = `[molt: ${shown} lines ${from + 1}-${i} of ${lines.length}]`;
  const cappedNotice = lineWasCapped
    ? `\n[molt: line ${i} is too long to show whole and was cut off; its rest is lost, not just unread.]`
    : "";
  const tail =
    i < lines.length
      ? `\n[molt: ${lines.length - i} more line(s). Continue with read_file offset=${i}.]`
      : "";
  return `${head}\n${out.join("\n")}${cappedNotice}${tail}`;
}

/** Cut a string to at most `maxBytes` of UTF-8, without splitting a character. */
function capToBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  // Buffer.toString("utf8") replaces a byte sequence split mid-character with
  // U+FFFD rather than throwing, so a naive slice is safe here.
  return buf.subarray(0, maxBytes).toString("utf8");
}

/**
 * How many lines a read_file result actually showed, as a 0-based exclusive
 * end.
 *
 * Partial reads carry a header `[molt: path lines X-Y of Z]` where Y is the
 * 1-based end of the content returned. That Y is exactly the 0-based
 * exclusive end the coverage map needs. Counting newlines in the whole
 * result instead counts the header and the continuation notice as file lines,
 * which made the map claim 1–2 extra lines were shown and told the model to
 * continue past what it had actually seen.
 */
function actualReadEnd(result: string, from: number, path: string): number {
  const escaped = path.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\[molt: ${escaped} lines \\d+-(\\d+) of \\d+\\]`);
  const m = re.exec(result);
  if (m) return Number(m[1]);
  // Whole-file reads have no header; count the lines they returned.
  return from + (result.match(/\n/g)?.length ?? 0) + 1;
}

function truncateResult(s: string, cap = TOOL_RESULT_MAX_BYTES): { text: string; note?: string } {
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= cap) return { text: s };
  const cut = Buffer.from(s, "utf8").subarray(0, cap).toString("utf8");
  return {
    text: cut + `\n[molt: truncated ${bytes - cap} bytes]`,
    note: `capped at ${cap}B (was ${bytes}B)`,
  };
}

export class Engine {
  cfg: EngineConfig;
  private transcript: Transcript;
  private ledger: LedgerEntry[] = [];
  /**
   * Real tokens per estimated token, learned from this endpoint.
   *
   * Starts at 1 — molt's estimate taken at face value — and only ever rises,
   * because the failure it guards against is carrying too much. Persisted for
   * the session so later steps size their sheds correctly without having to be
   * refused first.
   */
  private tokenScale = 1;
  /**
   * The context window this endpoint serves, once it has said so.
   *
   * Zero until an overflow names it. Used to bound tool results: a 32KB read is
   * nothing against 128k of context and most of the request against 16,384,
   * and no amount of shedding repairs the second case because the bulk sits in
   * a message the shed is keeping on purpose.
   */
  private contextWindow = 0;

  /** Bytes one tool result may return, given what this endpoint can hold. */
  private resultBudget(): number {
    return resultBudgetBytes(this.contextWindow, this.tokenScale);
  }
  private sessionPrompt = 0;
  private sessionCompletion = 0;
  private sessionCached = 0;
  /** Sum of the dollar figures the provider itself reported, when it does. */
  private sessionBilled = 0;
  /** Steps whose dollar figure the provider did not report. */
  private unbilledSteps = 0;
  /** Steps whose token counts molt had to estimate. */
  private estimatedSteps = 0;
  /**
   * Set once a provider rejects `stream_options`. Some OpenAI-compatible
   * servers 400 on request fields they do not implement, and re-sending a
   * field that has already been refused burns a round trip per step.
   */
  private streamUsageUnsupported = false;
  /** True once an endpoint has refused `cache_control`. Sticky per session. */
  private cachingUnsupported = false;
  /**
   * These three are derived from the endpoint, and the endpoint moves.
   *
   * They were fields, computed once in the constructor. `/model` then switched
   * the base URL and the key and left them pointing at the provider the
   * session started on, so choosing an Anthropic model sent the Anthropic key
   * to xAI and came back "Incorrect API key provided. You can obtain an API
   * key from console.x.ai". Getters cannot go stale.
   */
  private get cacheStyle(): CacheStyle {
    return cacheStyle(this.cfg.baseUrl, this.cfg.model);
  }

  /**
   * True when molt speaks Anthropic's own Messages API rather than the
   * OpenAI-compatible one. Chosen by endpoint, not by model: it is the *API*
   * that differs, and Anthropic's compatibility layer throws `cache_control`
   * away without a word, so a session there can never cache.
   */
  private get native(): boolean {
    return this.cfg.nativeApi ?? isAnthropicNative(this.cfg.baseUrl);
  }

  /** Where a completion request goes, which differs between the two APIs. */
  private get endpoint(): string {
    return this.native
      ? messagesUrl(this.cfg.baseUrl)
      : `${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  }
  /** Said once: this endpoint is not caching anything. */
  private warnedNoCache = false;
  /** True once a step has reused a serious share of the conversation. */
  private cacheWasWorking = false;
  /** Said once: a cache that was working has stopped. */
  private warnedCacheLost = false;
  /**
   * Every path the model read this session.
   *
   * Kept because reading a file is evidence it exists, and claims-grounded
   * needs that evidence: a correct assessment of source living outside the
   * project directory was refused as a fabrication, for naming files the model
   * had just read.
   */
  private readPaths = new Set<string>();
  /**
   * What the model did this turn, one line each, in order.
   *
   * The receipt is read by someone asking "what did it do, and should I
   * believe it finished?" — and until now the answer to the first half was
   * nowhere in the document.
   */
  private did: string[] = [];
  /**
   * Results reused while their watched files have not moved.
   *
   * One per session and never persisted: four proof attempts against a
   * ten-second suite is forty seconds of the inner loop spent re-proving the
   * same thing, and that is worth removing — but only within the process that
   * observed it.
   */
  private cache = new CheckCache();
  /** User turns handled this session. Numbers the jobs the meter reports. */
  private jobCount = 0;
  /**
   * Tool calls the model has been allowed to make since the bar last ran.
   *
   * The proof loop's premise is that the model can act on what failed. When
   * it has acted on nothing, the same bar is about to be run against the
   * same state — and molt was doing exactly that, four times, at the cost of
   * a full test suite each round.
   */
  private actsSinceBar = 0;
  budgetTokens?: number;
  /** Exact JSON body of the most recent request — the wire, unhidden. */
  lastRequestBody?: string;
  /** sha256 of .molt/done.yml as it stood when the session began. */
  private barHash: string | null;
  private inFlight?: AbortController;
  /** Aborts the command or bar check currently executing, if any. */
  private running?: AbortController;
  /**
   * How many write records this session handed to the archive. Kept in
   * memory and NOT derived from the archive, so it is an independent
   * expectation the archive can be checked against.
   */
  private archivedWrites = 0;

  constructor(cfg: EngineConfig) {
    this.cfg = cfg;
    this.transcript = new Transcript(systemPromptFor(this.cwd));
    this.barHash = barFingerprint(this.cwd);
    // The key molt was handed is the one secret it can mask exactly.
    cfg.journal?.protect(cfg.apiKey, process.env.MOLT_API_KEY);
    cfg.receipts?.protect(cfg.apiKey, process.env.MOLT_API_KEY);
  }

  get model(): string {
    return this.cfg.model;
  }
  /**
   * The key in use, so the model picker can ask this endpoint for its list.
   * Never rendered: the picker needs it to authenticate, not to show it.
   */
  get apiKey(): string | undefined {
    return this.cfg.apiKey;
  }

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }
  get provider(): string {
    return this.cfg.provider ?? new URL(this.cfg.baseUrl).hostname.split(".")[0];
  }
  get cwd(): string {
    return this.cfg.cwd ?? process.cwd();
  }
  get sessionTokens(): number {
    return this.sessionPrompt + this.sessionCompletion;
  }
  get shedBatches(): number {
    return this.transcript.shedCount;
  }
  get hasBar(): boolean {
    return Boolean(this.cfg.bar && this.cfg.bar.checks.length > 0);
  }
  get archive(): ArchiveLike | undefined {
    return this.cfg.archive;
  }
  get receipts(): Receipts | undefined {
    return this.cfg.receipts;
  }
  get journal(): Journal | undefined {
    return this.cfg.journal;
  }

  setModel(m: string): void {
    this.cfg.model = m;
  }
  setApiKey(k?: string): void {
    this.cfg.apiKey = k;
    this.cfg.journal?.protect(k);
  }
  /**
   * A session ceiling — and, since it is the knob people reach for when a turn
   * runs away, the turn ceiling too. A budget smaller than the default turn
   * ceiling would otherwise be unreachable, and a budget larger than it would
   * be silently overruled.
   */
  setBudget(tokens?: number): void {
    this.budgetTokens = tokens;
    this.cfg.maxTurnTokens = tokens === undefined ? 0 : tokens;
    // Clearing the budget clears the money ceiling too, or "/budget off"
    // would remove one limit and leave another one nobody mentioned.
    if (tokens === undefined) this.cfg.maxTurnUsd = 0;
  }

  /** A per-turn spending ceiling in dollars. 0 removes it. */
  setTurnBudgetUsd(usd: number): void {
    this.cfg.maxTurnUsd = usd;
  }
  setBar(bar: Bar | null): void {
    this.cfg.bar = bar;
    this.barHash = barFingerprint(this.cwd);
  }

  /**
   * Point at a different endpoint. Resets the session — different world.
   *
   * The model goes with it. A model name belongs to the endpoint that serves
   * it, so carrying `grok-4.6` across a login to Anthropic produced a status
   * line reading `anthropic · grok-4.6` — a combination that exists nowhere,
   * displayed as fact, on the row whose whole job is to answer "what am I
   * pointed at?". Better to say nothing and ask for a model.
   */
  setBaseUrl(url: string, apiKey?: string, provider?: string): void {
    if (url !== this.cfg.baseUrl) this.cfg.model = "";
    this.cfg.baseUrl = url;
    this.cfg.apiKey = apiKey;
    this.cfg.journal?.protect(apiKey);
    this.cfg.provider = provider;
    // Whatever the last endpoint would not accept says nothing about this one.
    this.cachingUnsupported = false;
    this.streamUsageUnsupported = false;
    this.cacheWasWorking = false;
    this.warnedCacheLost = false;
    this.reset();
  }

  reset(): void {
    this.transcript = new Transcript(systemPromptFor(this.cwd));
    this.ledger = [];
    this.archivedWrites = 0;
    this.sessionPrompt = 0;
    this.sessionCompletion = 0;
    this.sessionCached = 0;
    this.sessionBilled = 0;
    this.unbilledSteps = 0;
    this.estimatedSteps = 0;
    this.jobCount = 0;
  }

  /**
   * Abort an in-flight request. The assistant turn is only committed to the
   * transcript once a response is complete, so cancelling mid-stream leaves
   * the session exactly as it was rather than half-written.
   *
   * Also kills whatever command is running, which is a separate controller
   * because `inFlight` is cleared the moment the response lands — long before
   * the tools it asked for have run. A ctrl+C during a ten-minute test suite
   * that only cancelled the network would look like it had done nothing.
   */
  cancel(): void {
    this.inFlight?.abort();
    this.running?.abort();
  }

  get streaming(): boolean {
    return this.cfg.stream !== false;
  }

  /** Values that must not appear on screen or in a file molt writes. */
  private secrets(): (string | undefined)[] {
    return [this.cfg.apiKey, process.env.MOLT_API_KEY, process.env.OPENAI_API_KEY];
  }

  get autonomy(): Autonomy {
    return this.cfg.autonomy ?? DEFAULT_AUTONOMY;
  }

  /**
   * Change how much molt may do without asking.
   *
   * Journalled, because it is the one setting that changes what molt is
   * allowed to do to a machine. A record of a session that does not say when
   * the ceiling moved cannot explain why a command ran unattended.
   */
  setAutonomy(level: Autonomy): void {
    const from = this.autonomy;
    this.cfg.autonomy = level;
    if (from !== level) {
      this.cfg.journal?.append("autonomy", { from, to: level, means: AUTONOMY_SUMMARY[level] });
    }
  }

  get sessionCachedTokens(): number {
    return this.sessionCached;
  }

  /** True when any step's tokens were counted by molt rather than the provider. */
  get costEstimated(): boolean {
    return this.estimatedSteps > 0;
  }

  /** True when every step's dollar figure came from the provider itself. */
  get costBilled(): boolean {
    return this.sessionBilled > 0 && this.unbilledSteps === 0;
  }

  /**
   * What this session has cost so far, in USD.
   *
   * Three sources, in descending order of how much molt actually knows:
   *
   *   1. The provider billed it. Used only when EVERY step reported a
   *      figure — a total that mixes billed steps with priced ones is
   *      neither, and would be wrong in the direction of too small.
   *   2. Configured prices against reported token counts.
   *   3. Configured prices against molt's own token estimate, which is why
   *      `costEstimated` exists and why the meter marks it.
   *
   * Cached prompt tokens are billed at the cache rate when one is known.
   * They are already inside `sessionPrompt`, so they are subtracted out
   * before the standard rate is applied rather than counted twice.
   */
  costUsd(): number | undefined {
    if (this.costBilled) return this.sessionBilled;
    const { priceInPerMtok: pin, priceOutPerMtok: pout, priceCachedInPerMtok: pcache } = this.cfg;
    if (pin === undefined || pout === undefined) return undefined;
    const cached = pcache === undefined ? 0 : Math.min(this.sessionCached, this.sessionPrompt);
    const fresh = this.sessionPrompt - cached;
    return (fresh / 1e6) * pin + (cached / 1e6) * (pcache ?? pin) + (this.sessionCompletion / 1e6) * pout;
  }

  /** The prices in force, and where they came from. Backs /price. */
  pricing(): { in?: number; out?: number; cached?: number; source?: string } {
    return {
      in: this.cfg.priceInPerMtok,
      out: this.cfg.priceOutPerMtok,
      cached: this.cfg.priceCachedInPerMtok,
      source: this.cfg.priceSource,
    };
  }

  setPricing(p: { in?: number; out?: number; cached?: number; source?: string }): void {
    this.cfg.priceInPerMtok = p.in;
    this.cfg.priceOutPerMtok = p.out;
    this.cfg.priceCachedInPerMtok = p.cached;
    this.cfg.priceSource = p.source;
  }

  /**
   * Keep the standing note of this turn current.
   *
   * The request, the files changed so far, and the last thing the bar said —
   * a few hundred tokens that survive every compaction, so a shed costs the
   * model its notes and not its purpose.
   */
  private pinTask(request: string, lastFailure?: string): void {
    const written = [...new Set(this.ledger.map((e) => e.path))];
    this.transcript.pin(
      [
        "[molt] What this turn is for. This note is never compacted away.",
        `Request: ${request.replace(/\s+/g, " ").slice(0, 400)}`,
        written.length ? `Files you have changed: ${written.join(", ")}` : "Files changed so far: none",
        lastFailure ? `The bar last refused this claim: ${lastFailure}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  /** Everything the meter is made of, at this instant. */
  private meter(): Meter {
    return {
      prompt: this.sessionPrompt,
      completion: this.sessionCompletion,
      cached: this.sessionCached,
      billed: this.sessionBilled,
      unbilledSteps: this.unbilledSteps,
      estimatedSteps: this.estimatedSteps,
      costUsd: this.costUsd(),
    };
  }

  /** What has been spent since a snapshot, and how much of it molt knows. */
  private spendSince(before: Meter): Spend {
    const billedHere = this.sessionBilled - before.billed;
    const wasBilled = this.unbilledSteps === before.unbilledSteps && billedHere > 0;
    const now = this.costUsd();
    return {
      promptTokens: this.sessionPrompt - before.prompt,
      completionTokens: this.sessionCompletion - before.completion,
      cachedTokens: this.sessionCached - before.cached,
      costUsd: wasBilled
        ? billedHere
        : now === undefined
          ? undefined
          : now - (before.costUsd ?? 0),
      estimated: this.estimatedSteps > before.estimatedSteps,
      billed: wasBilled,
    };
  }

  bom(): Bom {
    const b = this.transcript.bom(TOOL_SCHEMA_JSON, {
      prompt: this.sessionPrompt,
      completion: this.sessionCompletion,
    });
    return {
      ...b,
      sessionCachedTokens: this.sessionCached,
      costUsd: this.costUsd(),
      costEstimated: this.costEstimated,
      budgetTokens: this.budgetTokens,
    };
  }

  /**
   * Every write this project can still prove: what is live in memory, plus
   * what the archive preserved from shed context and from earlier sessions.
   * Deduplicated by path — the earliest `before` with the latest `after`, so
   * the pair describes the whole effect on that file.
   */
  mergedLedger(): LedgerEntry[] {
    const archived = this.cfg.archive?.ledger?.() ?? [];
    const byPath = new Map<string, LedgerEntry>();
    for (const e of [...archived, ...this.ledger]) {
      const prior = byPath.get(e.path);
      byPath.set(e.path, prior ? { ...e, before: prior.before } : { ...e });
    }
    return [...byPath.values()];
  }

  barContext(claim?: string): BarContext {
    return {
      cwd: this.cwd,
      // So ctrl+C during a long suite kills the suite, not just the spinner.
      signal: this.running?.signal,
      record: this.transcript.record(),
      read: [...this.readPaths],
      cache: this.cache,
      ledger: this.mergedLedger(),
      liveLedger: [...this.ledger],
      archive: this.cfg.archive,
      archivedBatches: this.transcript.shedCount,
      expectedArchivedWrites: this.archivedWrites,
      expectedArchiveFiles: Journal.expectedArchives(this.cwd),
      claim,
    };
  }

  getLedger(): readonly LedgerEntry[] {
    return this.ledger;
  }

  getRecord(): Msg[] {
    return this.transcript.record();
  }

  /**
   * Shed context. Two-phase: the archive write happens between planning and
   * committing, so a throwing archive leaves the transcript untouched.
   */
  shed(
    keepExchanges = 2,
    keepRecent?: number,
  ): { before: number; after: number; dropped: number; path: string } | null {
    const plan = this.transcript.planShed(keepExchanges, keepRecent);
    if (!plan) return null;

    // Writes performed during the messages being shed travel with them. After
    // this, the only record of that work is the archive — which is what makes
    // "verification runs against preserved history" true rather than merely
    // architectural.
    const cut = plan.droppedCount;
    const departingCalls = new Set(
      plan.dropped.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)),
    );
    const departing = this.ledger.filter((e) => departingCalls.has(e.callId));
    const staying = this.ledger.filter((e) => !departingCalls.has(e.callId));

    if (!this.cfg.archive && departing.length > 0) {
      // Shedding without an archive would destroy write evidence. Refuse
      // rather than quietly lose the ability to prove earlier work.
      return null;
    }

    let path = "(not archived)";
    if (this.cfg.archive) {
      const firstAsk = plan.dropped.find((m) => m.role === "user")?.content ?? "";
      // If this throws, we never reach commitShed and nothing is lost.
      const entry = this.cfg.archive.write(plan.exuvia, cut, firstAsk, departing);
      path = entry.file;
      this.archivedWrites += departing.length;
    }

    this.transcript.commitShed(plan);

    this.ledger = staying;
    return {
      before: plan.beforeTokens,
      after: plan.afterTokens,
      dropped: plan.droppedCount,
      path,
    };
  }

  regrow(text: string): void {
    this.transcript.regrow(text);
  }

  /**
   * Pull archived context back into the working set by pattern. Lossless is
   * only meaningful if it is reversible on demand — this is the payoff for
   * having kept the original.
   */
  regrowMatching(pattern: string, limit = 3): { hits: number; attached: number; tokens: number } {
    if (!this.cfg.archive || typeof this.cfg.archive.grep !== "function") {
      return { hits: 0, attached: 0, tokens: 0 };
    }
    const hits = this.cfg.archive.grep(pattern);
    const take = hits.slice(0, limit);
    if (take.length === 0) return { hits: 0, attached: 0, tokens: 0 };
    const text = take.map((h) => `[exuvia ${h.index}]\n${h.excerpt}`).join("\n\n");
    this.transcript.regrow(text);
    return { hits: hits.length, attached: take.length, tokens: estTokens(text) };
  }

  /**
   * What a shed would do, without doing it. Backs `shed --explain`: the
   * preservation story only lands when someone can see the digest and the
   * original side by side.
   */
  explainShed(keepExchanges = 2): {
    droppedCount: number;
    beforeTokens: number;
    afterTokens: number;
    digest: string;
    exuvia: string;
  } | null {
    const plan = this.transcript.planShed(keepExchanges);
    if (!plan) return null;
    return {
      droppedCount: plan.droppedCount,
      beforeTokens: plan.beforeTokens,
      afterTokens: plan.afterTokens,
      digest: plan.digest,
      exuvia: plan.exuvia,
    };
  }

  private overBudget(): boolean {
    return this.budgetTokens !== undefined && this.sessionTokens >= this.budgetTokens;
  }

  /**
   * Async because `bash` is: it used to run through `execSync`, which stops
   * the event loop dead and froze the whole TUI for the life of the command.
   * Everything else here is filesystem work measured in milliseconds and stays
   * synchronous inside the promise.
   */
  private async runTool(
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<string> {
    switch (name) {
      case "read_file":
        this.readPaths.add(String(args.path ?? ""));
        return readPart(
          resolve(this.cwd, String(args.path ?? "")),
          String(args.path ?? ""),
          num(args.offset, 0),
          num(args.limit, Number.MAX_SAFE_INTEGER),
          this.resultBudget(),
        );

      case "write_file": {
        const rel = String(args.path ?? "");
        const abs = resolve(this.cwd, rel);
        const before = sha256Of(abs);
        // The text as well as the hash: a hash proves the file changed, and
        // only the text can say whether the change was a comment.
        let priorText = "";
        if (existsSync(abs)) {
          try {
            priorText = readFileSync(abs, "utf8");
          } catch {
            /* unreadable: the change scores as substantive, which never blocks work */
          }
        }
        mkdirSync(dirname(abs), { recursive: true });
        const content = String(args.content ?? "");
        writeFileSync(abs, content, "utf8");
        const after = createHash("sha256").update(content, "utf8").digest("hex");
        const at = isAbsolute(rel) ? relative(this.cwd, abs) : rel;
        if (!isGenerated(at)) {
          this.ledger.push({
            path: at,
            before,
            after,
            callId,
            substance: substanceOf(priorText, content),
          });
        }
        return (
          `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}` +
          (isGenerated(at)
            ? " [build output — written, but not counted as work: the next build overwrites it]"
            : "")
        );
      }

      case "list_dir": {
        const rel = String(args.path ?? ".");
        const abs = resolve(this.cwd, rel);
        this.mustBeInside(abs, rel);
        // Bounded and off the main thread: a listing the model asks for can be
        // pointed at anything, including a home directory.
        return formatListing(
          rel,
          await walkAsync(abs, {
            depth: num(args.depth, 1),
            glob: str(args.glob),
            deadline: Date.now() + WALK_DEADLINE_MS,
          }),
        );
      }

      case "grep": {
        const rel = String(args.path ?? ".");
        const abs = resolve(this.cwd, rel);
        this.mustBeInside(abs, rel);
        const pattern = String(args.pattern ?? "");
        return formatMatches(
          pattern,
          await grepFiles(abs, pattern, {
            glob: str(args.glob),
            ignoreCase: args.ignore_case === true,
          }),
        );
      }

      case "edit_file": {
        const rel = String(args.path ?? "");
        const abs = resolve(this.cwd, rel);
        this.mustBeInside(abs, rel);
        if (!existsSync(abs)) return `no such file: ${rel} — write_file creates a new one`;
        const before = sha256Of(abs);
        const current = readFileSync(abs, "utf8");
        const edit = applyEdit(
          current,
          String(args.old_text ?? ""),
          String(args.new_text ?? ""),
          args.replace_all === true,
        );
        if (!edit.ok) return `edit refused: ${edit.why}`;
        writeFileSync(abs, edit.text, "utf8");
        // Ledgered exactly like a write, so files-changed and record-intact
        // prove a surgical edit the same way they prove a whole-file rewrite.
        const editedAt = isAbsolute(rel) ? relative(this.cwd, abs) : rel;
        if (!isGenerated(editedAt)) {
          this.ledger.push({
            path: editedAt,
            before,
            after: createHash("sha256").update(edit.text, "utf8").digest("hex"),
            callId,
            substance: substanceOf(current, edit.text),
          });
        }
        const delta = Buffer.byteLength(edit.text, "utf8") - Buffer.byteLength(current, "utf8");
        return (
          `replaced ${edit.replacements} occurrence(s) in ${rel} · ` +
          `${delta >= 0 ? "+" : ""}${delta} bytes`
        );
      }

      case "bash": {
        const r = await runCommand(String(args.command ?? ""), {
          cwd: this.cwd,
          timeoutMs: this.cfg.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: scrubbedEnv(),
          // A cancelled turn kills the command it is waiting on. Leaving a
          // build running after the turn that asked for it was called off is
          // the machine doing work nobody is going to read.
          signal: this.running?.signal,
        });
        // Same shape execSync produced: bare stdout when it worked, and a
        // tagged dump of both streams when it did not.
        if (r.code === 0 && !r.timedOut) return r.stdout;
        const tag = r.timedOut ? "timeout" : `exit ${r.code ?? r.signal ?? "?"}`;
        return `${tag}\n${r.stdout}${r.stderr}`;
      }

      default:
        return `unknown tool: ${name}`;
    }
  }

  /**
   * Run the bar, with tamper detection in front of it. A bar the agent
   * rewrote mid-task is not a bar, so the edit is reported as a failure
   * rather than quietly honoured.
   */
  /**
   * Refuse to act outside the project.
   *
   * Only the tools that resolve paths THEMSELVES need this. `write_file` and
   * `read_file` are handed one path, which the permission gate has already
   * checked against the project boundary at every autonomy level — so a
   * second refusal here would not add safety, it would override a person who
   * looked at the prompt and said yes. `list_dir` and `grep` walk, and a walk
   * can end up somewhere the gate never saw.
   */
  private mustBeInside(abs: string, shown: string): void {
    if (!insideProject(this.cwd, abs)) {
      throw new Error(`${shown} is outside this project; molt will not walk there`);
    }
  }

  private async runBarGuarded(claim?: string, override?: Bar | null): Promise<BarResult> {
    const bar = override ?? this.cfg.bar!;
    const t0 = Date.now();
    // The bar is the longest-running thing molt does. It gets the same
    // cancellation handle a tool call gets, for the same reason.
    this.running = new AbortController();
    try {
      return await this.runBarInner(bar, claim, t0);
    } finally {
      this.running = undefined;
    }
  }

  private async runBarInner(bar: Bar, claim: string | undefined, t0: number): Promise<BarResult> {
    const now = barFingerprint(this.cwd);
    if (this.barHash !== null && now !== this.barHash) {
      const tamper: CheckResult = {
        name: "bar-unmodified",
        kind: "builtin",
        detail: "done.yml fingerprint",
        ok: false,
        output:
          ".molt/done.yml changed during this session. The definition of done cannot be " +
          "edited by the work being judged against it. Revert the file and satisfy the " +
          "original checks, or stop and tell the user why the bar is wrong.",
        durationMs: Date.now() - t0,
      };
      const rest = await runBar(bar, this.barContext(claim));
      return {
        ok: false,
        results: [tamper, ...rest.results],
        durationMs: Date.now() - t0,
      };
    }
    return runBar(bar, this.barContext(claim));
  }

  /**
   * Ask for an answer with what has already been paid for.
   *
   * Every guard in this loop used to end a turn by returning nothing: the step
   * guard, the budget, the turn ceiling. A session that
   * read twenty files and hit a limit threw all of it away — maximum cost,
   * zero value, which is the worst outcome available and the one a user
   * actually reported.
   *
   * So a stopped turn gets one last request with tools disabled. The model
   * cannot go looking for more; it has to say what it found and what it could
   * not determine. That answer is NOT a completion claim and does not go
   * through the bar — it is a report from a turn molt cut short, and it is
   * labelled as one, because presenting it as verified would be the exact lie
   * this whole tool exists to refuse.
   */
  private async *salvage(
    reason: string,
    fetchFn: typeof fetch,
    log?: Journal,
  ): AsyncGenerator<EngineEvent> {
    this.transcript.push({
      role: "user",
      content:
        `[molt] ${reason} You cannot call any more tools. Answer now with what you have ` +
        `already found: what you learned, and — just as importantly — what you did not get ` +
        `to and cannot vouch for. Do not claim anything you did not verify.`,
    });
    // Cancellable, like every other request. It was not, and that made molt
    // unquittable at the worst moment: hitting the budget runs a salvage, and
    // a salvage that cannot be aborted holds the turn open with no way out —
    // ctrl+C reached a controller that had already been cleared. A safety net
    // you cannot climb out of is a trap.
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      // The salvage is a request like any other, so it speaks whichever
      // protocol the rest of the turn spoke — sending it to the OpenAI path
      // while the session ran on the native one would fail the one request
      // whose entire job is to rescue a turn that already went wrong.
      const wire = this.transcript.wire();
      const res = await fetchFn(this.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...authHeaders(this.cfg.baseUrl, this.cfg.apiKey),
        },
        // `tools` must be present even to say "use none of them" — a
        // tool_choice without a tools array is a 400 on at least xAI, and the
        // first version of this sent exactly that and swallowed the refusal.
        body: JSON.stringify(
          this.native
            ? toRequest(wire, TOOLS, {
                model: this.cfg.model,
                maxTokens: this.cfg.maxTokens,
                toolChoice: "none",
                // A fork must reuse the parent's prefix exactly or it reads
                // none of the cache the turn has been building.
                cacheAt: this.cacheStyle === "explicit" && !this.cachingUnsupported
                  ? new Set(breakpoints(wire))
                  : undefined,
              })
            : {
                model: this.cfg.model,
                messages: withCaching(wire, this.cacheStyle, !this.cachingUnsupported),
                tools: TOOLS,
                tool_choice: "none",
              },
        ),
      });
      if (!res.ok) {
        // A safety net that fails silently is not a safety net. Say so.
        const why = await res.text().catch(() => "");
        log?.append("error", { text: `salvage failed: HTTP ${res.status}`, body: why.slice(0, 200) });
        yield {
          kind: "info",
          text: `could not write a closing summary (HTTP ${res.status}) — the work above is all there is`,
        };
        return;
      }
      const json = (await res.json()) as {
        choices?: { message?: Msg }[];
        usage?: Usage;
        content?: { type: string; text?: string }[];
      };
      const nativeUsage = this.native ? usageFor(json.usage as unknown as Record<string, unknown>) : undefined;
      const text = this.native
        ? (toMessage(json).content ?? "")
        : (json.choices?.[0]?.message?.content ?? "");
      const pTok = (nativeUsage ?? json.usage)?.prompt_tokens ?? 0;
      const cTok = (nativeUsage ?? json.usage)?.completion_tokens ?? 0;
      this.sessionPrompt += pTok;
      this.sessionCompletion += cTok;
      if (typeof json.usage?.cost === "number") this.sessionBilled += json.usage.cost;
      else this.unbilledSteps += 1;
      log?.append("salvage", { reason, promptTokens: pTok, completionTokens: cTok, chars: text.length });
      if (!text.trim()) return;
      yield {
        kind: "info",
        text:
          "the answer below was written after molt stopped the turn. It was NOT checked " +
          "against the bar — treat it as notes, not as a completed task.",
      };
      yield { kind: "assistant_text", text: redact(text, this.secrets()) };
    } catch (e) {
      // A courtesy that failed must not mask the real stop, but must not
      // vanish either. Cancelling it is not a failure — it is being told the
      // last word is no longer wanted.
      if (controller.signal.aborted) {
        log?.append("cancelled", { reason: "salvage cancelled" });
        yield { kind: "info", text: "cancelled — no closing summary was written" };
      } else {
        log?.append("error", { text: `salvage failed: ${String(e)}` });
      }
    } finally {
      this.inFlight = undefined;
    }
  }

  /**
   * Close out a turn whose claim was never proven: write the receipt, log
   * the ending, and report it as a failure. Shared by the exhausted path and
   * the one that stops early because nothing changed, so both produce the
   * same evidence — a refusal that skips the receipt is a refusal nobody can
   * audit later.
   */
  private async *finishUnproven(
    claim: string,
    result: BarResult,
    attempts: number,
    log?: Journal,
  ): AsyncGenerator<EngineEvent> {
    const onlyWrites = failedOnlyWriteChecks(result);
    if (this.cfg.receipts) {
      const receipt = this.cfg.receipts.write({
        claim,
        result,
        attempt: attempts,
        verdict: "exhausted",
        model: this.cfg.model,
        provider: this.provider,
        sessionTokens: this.sessionTokens,
        shedBatches: this.transcript.shedCount,
      });
      log?.append("receipt", { verdict: "exhausted", file: receipt.path, attempt: attempts });
      yield { kind: "receipt", path: receipt.path };
    }
    log?.append("session_end", { reason: "bar not met", attempts });
    yield { kind: "proof_exhausted", result, attempts };
    yield {
      kind: "error",
      text: onlyWrites
        ? `bar not met: ${onlyWrites} requires this turn to have changed a file, and none ` +
          `changed. molt is reporting failure rather than success. Either the work was not ` +
          `done, or this was a question — ask questions with /ask, or a leading "?", which ` +
          `runs the rest of the bar and drops that one check.`
        : `bar not met after ${attempts} attempts. molt is reporting failure rather ` +
          `than success. See .molt/receipts/ for what was checked.`,
    };
  }

  /** Run the bar without touching the loop — backs the /prove command. */
  async proveNow(claim?: string): Promise<BarResult | null> {
    if (!this.cfg.bar) return null;
    return this.runBarGuarded(claim);
  }

  /**
   * One user turn, with its own books.
   *
   * The session meter answers "what have I spent?" and must only ever climb.
   * It cannot also answer "what did that question cost?" — so the per-job
   * figures are kept here, as a delta against a snapshot taken before the
   * turn, and reported when the turn ends. Nothing about the session totals
   * changes; a job is a view of them, never a reset.
   */
  /**
   * Start a turn.
   *
   * Deliberately not a generator. A generator body does not execute until the
   * first `next()`, so the criteria would be captured whenever the caller got
   * round to iterating — and "sealed before the work" would rest on a nuance of
   * when iteration happens rather than on when the seal is taken. Copying here,
   * eagerly, means the criteria are fixed the instant the turn is asked for.
   *
   * Nothing else moves: the returned value is the same async generator it
   * always was.
   */
  run(userText: string, confirm: Confirm, opts: RunOptions = {}): AsyncGenerator<EngineEvent> {
    const sealed: RunOptions = {
      ...opts,
      taskChecks: Object.freeze((opts.taskChecks ?? []).map((c) => Object.freeze({ ...c }))) as Check[],
      taskNotes: Object.freeze([...(opts.taskNotes ?? [])]) as string[],
    };
    return this.runSealed(userText, confirm, sealed);
  }

  private async *runSealed(
    userText: string,
    confirm: Confirm,
    opts: RunOptions,
  ): AsyncGenerator<EngineEvent> {
    const job = ++this.jobCount;
    const startedAt = Date.now();
    const before = this.meter();
    let steps = 0;
    let cancelled = false;
    let errored = false;
    let exhausted = false;
    let proven = false;
    let answered = false;

    yield { kind: "job_start", job, text: userText };
    this.pinTask(userText);

    for await (const ev of this.runTurn(userText, confirm, job, opts)) {
      switch (ev.kind) {
        case "step_summary":
          steps += 1;
          break;
        case "cancelled":
          cancelled = true;
          break;
        case "error":
          errored = true;
          break;
        case "proof_exhausted":
          exhausted = true;
          break;
        case "proof_result":
          proven = true;
          break;
        case "assistant_text":
          answered = true;
          break;
      }
      yield ev;
    }

    // Order matters: a bar that was never met is "not proven" even though an
    // error event follows it, and an answer nothing checked is never
    // "verified" — the distinction molt exists to make.
    const outcome: JobOutcome = cancelled
      ? "cancelled"
      : exhausted
        ? "not proven"
        : errored
          ? "error"
          : proven
            ? "verified"
            : answered
              ? "unverified"
              : "stopped";

    yield {
      kind: "job_end",
      job,
      steps,
      spend: this.spendSince(before),
      durationMs: Date.now() - startedAt,
      outcome,
    };
  }

  private async *runTurn(
    userText: string,
    confirm: Confirm,
    job: number,
    opts: RunOptions = {},
  ): AsyncGenerator<EngineEvent> {
    // Remember where this turn began so a cancellation can leave no trace.
    const turnStart = this.transcript.length;
    const log = this.cfg.journal;
    /**
     * This turn's criteria, copied and sealed before anything runs.
     *
     * The copy is the whole point. `opts` belongs to the caller, and a caller
     * that could keep editing it — or a model that could reach it — would be
     * choosing the passing conditions after seeing what it had done. Frozen
     * here, at the top of the turn, before the first request goes out, so
     * "these were set before the work existed" is a fact about the code rather
     * than a promise about behaviour.
     */
    const taskChecks: Check[] = (opts.taskChecks ?? []).map((c) => Object.freeze({ ...c }));
    const taskNotes: string[] = [...(opts.taskNotes ?? [])];
    Object.freeze(taskChecks);
    Object.freeze(taskNotes);
    const taskSeal = taskChecks.length || taskNotes.length ? sealOf(taskChecks, taskNotes) : "";
    if (taskSeal) {
      // Journalled before the first request, so the record shows the criteria
      // predating the work rather than merely claiming to.
      log?.append("note", {
        text: `task criteria sealed: ${taskChecks.length} check(s), ${taskNotes.length} note(s)`,
        seal: taskSeal,
        checks: taskChecks.map((c) => c.name),
        notes: taskNotes,
      });
      yield {
        kind: "info",
        text:
          `${taskChecks.length} task check(s) and ${taskNotes.length} note(s) sealed for this ` +
          `turn (${taskSeal.slice(0, 12)}). They cannot change while it runs.`,
      };
    }

    this.transcript.push({ role: "user", content: userText });
    if (taskChecks.length || taskNotes.length) {
      // Stated to the model, because a gate it does not know about is a trap
      // rather than a specification — and the point is for the work to satisfy
      // these, not to be caught out by them. Pushed as a separate message so it
      // survives shedding independently of the ask, and so a reader of the
      // transcript can see exactly what was set and when.
      const lines = [
        "Acceptance criteria for this task, fixed before you began and unchangeable:",
        ...taskChecks.map((c) =>
          c.kind === "command"
            ? `  [checked] ${c.name}: ${c.run}`
            : `  [checked] ${c.name}: builtin ${c.builtin}`,
        ),
        ...taskNotes.map((n) => `  [recorded, not machine-checked] ${n}`),
        "",
        "The [checked] ones run when you claim to be finished and can refuse the",
        "claim. The [recorded] ones appear on the receipt as stated intent and are",
        "never reported as verified — do not describe one as passing. You cannot",
        "edit these; attempting to is itself a failure.",
      ];
      this.transcript.push({ role: "user", content: lines.join("\n") });
    }
    log?.append("user_message", {
      chars: userText.length,
      preview: userText.replace(/\s+/g, " ").slice(0, 120),
      sha256: createHash("sha256").update(userText, "utf8").digest("hex").slice(0, 16),
    });
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const maxAttempts = this.cfg.maxProofAttempts ?? MAX_PROOF_ATTEMPTS;
    let proofAttempts = 0;
    /** The last bar result, for deciding whether another run could differ. */
    let lastResult: BarResult | null = null;
    /** The previous attempt's failures, to notice a bar going nowhere. */
    let lastFailure = "";
    this.actsSinceBar = 0;

    /**
     * Every tool call made this turn, by call and by the digest of what it
     * returned. A model that asks the same question and gets the same answer
     * has learned nothing, and resending that answer costs the same as the
     * first time — which is how thirty steps of re-reading four files became
     * fifty cents.
     */
    const answered = new Map<string, { step: number; sha: string }>();
    /**
     * Which lines of which file the model has already been shown this turn.
     *
     * Exact-match detection is not enough on its own: asking for line 181 and
     * then line 182 of the same file returns almost the same bytes under a
     * different key, which is precisely how a real session walked past the
     * repeat guard for thirty-two steps. Coverage answers the question that
     * actually matters — "has this already been shown?" — rather than "is this
     * byte-identical to something?".
     */
    const shown = new Map<string, { from: number; to: number }[]>();
    /** Consecutive steps in which nothing new came back. */
    let dryStreak = 0;

    // A question changes nothing, so a check that demands a change can only
    // ever fail it. `ask` drops exactly those checks for this turn and runs
    // the rest — the bar is narrowed in the open, never quietly lowered, and
    // the receipt records which checks actually ran.
    // Narrowed here for the announcement below and for proof_start's names;
    // re-derived at each proof attempt, because whether this turn wrote
    // anything is not known until it has had the chance to.
    const bar = opts.ask
      ? withoutWriteChecks(withTaskChecks(this.cfg.bar, taskChecks))
      : withTaskChecks(this.cfg.bar, taskChecks);
    const barNow = (): Bar | null =>
      opts.ask
        ? asQuestion(withTaskChecks(this.cfg.bar, taskChecks), this.mergedLedger().length === 0)
        : withTaskChecks(this.cfg.bar, taskChecks);
    if (opts.ask) {
      const dropped = (this.cfg.bar?.checks.length ?? 0) - (bar?.checks.length ?? 0);
      log?.append("note", { text: `ask turn — ${dropped} write-dependent check(s) not run` });
      if (dropped > 0) {
        yield {
          kind: "info",
          text: `asking: ${dropped} check(s) that require a file change are not run this turn`,
        };
      }
    }

    const turnStartTokens = this.sessionTokens;
    const turnStartCost = this.costUsd();
    let warned = 0;
    // The step guard is the last way out of a turn, and it had the same fault
    // the spending ceiling had: it stopped dead. A reported run reached it with
    // 1,344,777 tokens and $0.89 spent and got no answer for any of it. The
    // money is gone either way — ending there is what makes it worth nothing.
    // So the cap is extensible on the same terms: asked once per cap, stopping
    // the default, and only where somebody is watching.
    let stepCap = MAX_STEPS;
    for (let step = 0; ; step++) {
      if (step >= stepCap) {
        if (!opts.onCeiling) break;
        const spent =
          `${step} steps · ${this.sessionTokens} tokens` +
          (this.costUsd() === undefined ? "" : ` · ${fmtUsd(this.costUsd() ?? 0)}`);
        if (!(await opts.onCeiling(spent))) break;
        stepCap += MAX_STEPS;
        log?.append("note", { text: `step guard raised at ${spent} — turn continues` });
        yield {
          kind: "info",
          text: `carrying on past ${spent}. Another ${MAX_STEPS} steps before molt asks again.`,
        };
      }
      // An explicit budget speaks for itself, and speaks first: one knob
      // should not produce two different messages.
      if (this.overBudget()) {
        yield {
          kind: "error",
          text: `budget hit (${this.budgetTokens} tokens) — loop stopped. /budget to raise.`,
        };
        yield* this.salvage(`You have reached the token budget for this session.`, fetchFn, log);
        return;
      }

      // Otherwise a ceiling on the turn, not just on the session. Checked
      // before the request rather than after, so the limit is what molt
      // refuses to spend rather than what it noticed spending.
      // Money where a price is known, tokens only where it is not.
      const spentThisTurn = this.sessionTokens - turnStartTokens;
      const usdThisTurn =
        turnStartCost === undefined ? undefined : (this.costUsd() ?? 0) - turnStartCost;
      // No default ceiling on your own hardware. A spending ceiling exists to
      // stop a bill, and a model running on a box you own does not send one —
      // so the default stops work that costs nothing but electricity, and stops
      // it in the middle, which is the most expensive way to spend nothing.
      // A ceiling you set yourself still binds: this removes the default, not
      // the control.
      const free = isSelfHosted(this.cfg.baseUrl);
      const usdCeiling = this.cfg.maxTurnUsd ?? (free ? 0 : DEFAULT_TURN_USD);
      const tokenCeiling = this.cfg.maxTurnTokens ?? (free ? 0 : DEFAULT_TURN_TOKENS);
      const priced = usdThisTurn !== undefined && usdCeiling > 0;
      const used = priced ? usdThisTurn : spentThisTurn;
      const ceiling = priced ? usdCeiling : tokenCeiling;
      // Named for what it is, and not `shown` — which is the read-coverage map
      // a few lines down, and which this quietly shadowed until the compiler
      // said so.
      const ceilingLine = priced
        ? `${fmtUsd(usdThisTurn)} of ${fmtUsd(usdCeiling)}`
        : `${spentThisTurn} of ${tokenCeiling} tokens`;

      // Said on the way up, not only on arrival. A limit that speaks for the
      // first time when it stops you is a limit that feels like a surprise
      // bill, whatever the number on it.
      while (
        ceiling > 0 &&
        warned < CEILING_WARNINGS.length &&
        used >= ceiling * CEILING_WARNINGS[warned]!
      ) {
        const pct = Math.round(CEILING_WARNINGS[warned]! * 100);
        warned += 1;
        yield {
          kind: "info",
          text:
            `this turn: ${ceilingLine} — ${pct}% of the ceiling. Type /budget $5 now to raise ` +
            `it and the turn carries on; /budget off removes it entirely.`,
        };
      }

      if (ceiling > 0 && used >= ceiling) {
        // Ask, when there is someone to ask.
        //
        // Stopping dead at the ceiling is the most expensive outcome available:
        // the money is already spent, and ending there converts it into nothing
        // at all. A reported run reached $1.02 of a $1.00 ceiling twenty steps
        // into real work and got no answer for any of it — "it seems like a
        // bigger waste if you spend the money and never get an output".
        //
        // Deliberately not the `confirm` used for tools. `--yes` means "do not
        // ask me about tool calls", and reading it as "spend without limit"
        // would let a headless run in CI go through a budget unattended. This
        // is a separate channel that only an interactive session provides, so
        // where nobody is watching the ceiling still stops the turn.
        if (opts.onCeiling) {
          const more = await opts.onCeiling(ceilingLine);
          if (more) {
            // Raised by the same amount again, so continuing is a decision
            // taken once per ceiling rather than a limit quietly removed.
            if (priced) this.cfg.maxTurnUsd = usdCeiling * 2;
            else this.cfg.maxTurnTokens = tokenCeiling * 2;
            log?.append("note", { text: `ceiling raised at ${ceilingLine} — turn continues` });
            yield {
              kind: "info",
              text: `carrying on past ${ceilingLine}. The ceiling is now ${
                priced ? fmtUsd(usdCeiling * 2) : `${tokenCeiling * 2} tokens`
              } for this turn.`,
            };
            warned = 0;
            continue;
          }
        }
        log?.append("session_end", {
          reason: "turn ceiling",
          tokens: spentThisTurn,
          usd: usdThisTurn ?? null,
        });
        yield {
          kind: "error",
          text:
            `stopped: this turn has spent ${ceilingLine}, its ceiling for a single turn. Nothing ` +
            `was verified. Narrow the request, raise it with /budget, or remove it with ` +
            `/budget off.`,
        };
        yield* this.salvage(`This turn reached its spending ceiling (${ceilingLine}).`, fetchFn, log);
        return;
      }

      // Cheap, mechanical, and strictly a subset of shedding: prune tool
      // results that later work has made irrelevant before considering the
      // much heavier option of shedding.
      if (this.cfg.elideSuperseded !== false) {
        const pruned = this.transcript.elideSupersededReads();
        if (pruned.elided > 0) {
          log?.append("elide", { elided: pruned.elided, tokensSaved: pruned.tokensSaved });
          yield {
            kind: "info",
            text: `pruned ${pruned.elided} superseded tool result(s) · ${pruned.tokensSaved} tokens freed`,
          };
        }
      }

      const auto = this.cfg.autoShedAtTokens ?? DEFAULT_AUTO_SHED_TOKENS;
      if (auto > 0 && this.transcript.historyTokens() > auto) {
        const shed = this.shed();
        if (shed) {
          // Shedding removes the file contents from the model's context, so
          // everything molt believed it had "already been shown" is gone. The
          // coverage map has to forget with it — otherwise molt tells a model
          // to scroll up to something it just archived, refuses the re-read,
          // and calls the resulting stall a loop. A real session spent 29 of
          // its 31 repeat-refusals after a shed, for exactly this reason.
          shown.clear();
          answered.clear();
          log?.append("shed", {
            dropped: shed.dropped,
            before: shed.before,
            after: shed.after,
            archive: shed.path,
            estimated: true,
          });
          yield { kind: "shed", ...shed };
        }
      }

      const stream = this.cfg.stream !== false;
      const controller = new AbortController();
      this.inFlight = controller;
      const stepStartedAt = Date.now();

      const wire = this.transcript.wire();
      const requestEst = this.bom().requestTotalEst;
      log?.append("request", {
        step,
        messages: wire.length,
        estTokens: requestEst,
        estimated: true,
        stream,
        model: this.cfg.model,
        endpoint: this.cfg.baseUrl,
      });
      yield {
        kind: "request",
        step,
        messages: wire.length,
        estTokens: requestEst,
        model: this.cfg.model,
        stream,
      };

      /**
       * Streaming responses carry no usage block unless it is asked for.
       * Without this flag molt fell back to counting the wire JSON itself —
       * an estimate presented in a meter that reads as a measurement, on
       * the code path that is on by default. Asking costs one field.
       */
      const askForUsage = stream && !this.streamUsageUnsupported && !this.native;
      const send = (withUsage: boolean, withCache = !this.cachingUnsupported): Promise<Response> => {
        const marks = withCache && this.cacheStyle === "explicit" ? new Set(breakpoints(wire)) : undefined;
        const body = this.native
          ? toRequest(wire, TOOLS, {
              model: this.cfg.model,
              maxTokens: this.cfg.maxTokens,
              stream,
              toolChoice: "auto",
              cacheAt: marks,
            })
          : {
              model: this.cfg.model,
              // Breakpoints on providers that need them, nothing on providers
              // that cache by themselves. Never a change to the text.
              messages: withCaching(wire, this.cacheStyle, withCache),
              tools: TOOLS,
              tool_choice: "auto",
              ...(stream ? { stream: true } : {}),
              ...(withUsage ? { stream_options: { include_usage: true } } : {}),
            };
        return fetchFn(this.endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            ...authHeaders(this.cfg.baseUrl, this.cfg.apiKey),
          },
          body: (this.lastRequestBody = JSON.stringify(body)),
        });
      };

      // A failed step is not a verdict on the work.
      //
      // Everything between sending the request and holding a usable message
      // can fail in ways that say nothing about whether the work is any good:
      // `TypeError: fetch failed` from a DNS blip or a laptop waking, a 429
      // because the minute's quota ran out, a 502 from a proxy, a stream that
      // dies halfway, an HTML error page where JSON was promised. Each of
      // those used to end the turn where it stood. One reported session lost
      // forty-nine thousand tokens of reading that way and was told only
      // "network: TypeError: fetch failed".
      //
      // So they are all one policy now: retry what a second attempt could
      // plausibly fix, and whatever happens, close the turn the way every
      // other stop closes — by asking for an answer with what has already been
      // paid for. A 400 or a 401 is not retried, because the conversation or
      // the credentials being wrong does not improve by asking again, and a
      // second identical refusal is exactly the spending this avoids.
      let msg: Msg | undefined;
      let usage: Usage | undefined;
      let finishReason: string | undefined;
      /** Whether this step's text already went out as deltas. */
      let streamedContent = false;
      let failure:
        | { text: string; why: string; retryable: boolean; retryAfterMs?: number }
        | undefined;
      /**
       * Shed-and-retry rounds used on this step.
       *
       * More than one, because a single shed is a guess: the first is sized
       * with whatever ratio molt has learned so far, and the server's answer to
       * it is what makes the next one right. One round was enough to fail —
       * "shedding to 10813" was followed by a refusal at 24,307 tokens, and the
       * turn ended there with everything it had done thrown away.
       */
      let overflowRounds = 0;
      /**
       * Whether this attempt has put text on screen.
       *
       * A retry replays the message from the beginning, so anything already
       * shown belongs to an abandoned attempt and has to be taken back first —
       * otherwise the reader sees the same sentence twice with no way to tell
       * which one the model actually finished.
       */
      let shownThisAttempt = false;

      for (let attempt = 0; ; attempt++) {
        failure = undefined;
        msg = undefined;
        let res: Response | undefined;
        try {
          res = await send(askForUsage);
          // A server that does not implement the field rejects the request. Try
          // once without it rather than failing a turn over a request for better
          // bookkeeping — and only conclude the field was the problem if the
          // retry actually works, so a genuine 400 does not quietly turn usage
          // reporting off for the rest of the session.
          if (!res.ok && res.status === 400 && askForUsage) {
            const retry = await send(false);
            if (retry.ok) {
              this.streamUsageUnsupported = true;
              log?.append("note", {
                text: "provider rejected stream_options — token counts fall back to molt's estimate",
              });
            }
            res = retry;
          }

          // The body is read once. A `Response` gives its body up exactly
          // once, so the caching fallback below and the failure report that
          // follows it have to share the same read rather than each taking
          // their own.
          let body = res.ok ? "" : (await res.text().catch(() => ""));

          // An endpoint that will not take the markers must cost a retry, not
          // a turn. Same shape as the stream_options fallback above: try once
          // without, and only believe the markers were the problem if that
          // works — so a genuine 400 is not quietly blamed on caching.
          if (
            !res.ok &&
            res.status === 400 &&
            this.cacheStyle === "explicit" &&
            !this.cachingUnsupported &&
            refusedCaching(body)
          ) {
            const retry = await send(askForUsage && !this.streamUsageUnsupported, false);
            if (retry.ok) {
              this.cachingUnsupported = true;
              log?.append("note", {
                text: "provider rejected cache_control — prompt caching is off for this session",
              });
            }
            res = retry;
            body = res.ok ? "" : (await res.text().catch(() => ""));
          }

          if (!res.ok) {
            // "Too big" is not a verdict on the work, and it is the one
            // refusal that says how to fix itself. Shed and send less rather
            // than ending a turn that has done real work — molt's own
            // threshold is 60,000 tokens and this endpoint may serve 16,384,
            // which it has no other way to discover.
            const over = res.status === 400 ? contextOverflow(body) : null;
            if (over && overflowRounds < OVERFLOW_ROUNDS) {
              overflowRounds++;
              const bom = this.bom();
              // What molt believed it was sending, against what the server
              // counted. molt estimates characters/4; a real tokenizer on code
              // disagrees, and one session shed to an estimated 11.6k only to
              // be refused at 24,307. Every decision about what to drop was
              // being made in a unit twice the size of the real one.
              const scale = tokenScale(over.sent, bom.requestTotalEst);
              if (scale > this.tokenScale) this.tokenScale = scale;
              // Remembered for the rest of the session, so every later read is
              // sized to fit rather than discovered to be too large.
              if (over.window > 0) this.contextWindow = over.window;
              const fixedEst = bom.systemTokens + bom.toolSchemaTokens;
              const target = historyBudget(over.window, fixedEst, this.tokenScale);
              if (target > 0) this.cfg.autoShedAtTokens = target;

              log?.append("note", {
                text:
                  `context window ${over.window || "unknown"}; server counted ${over.sent} where ` +
                  `molt estimated ${bom.requestTotalEst} (x${this.tokenScale.toFixed(2)}) — ` +
                  `round ${overflowRounds}, history target ${target || "unknown"}`,
              });
              yield {
                kind: "info",
                text: over.window
                  ? `this endpoint serves ${over.window} tokens and counted ${over.sent} in that ` +
                    `request — about ${this.tokenScale.toFixed(1)}x molt's estimate. Carrying less ` +
                    `and trying again` +
                    (target > 0 && overflowRounds === 1
                      ? ` — start with --auto-shed ${target} to skip this.`
                      : ".")
                  : "this endpoint refused the request as too large. Carrying less and trying again.",
              };

              // Each round keeps fewer exchanges. The threshold alone changes
              // nothing: shed() drops everything older than `keepExchanges` and
              // does not consult it, so a second call with the same argument
              // finds nothing and a lower target is ignored.
              const shed = this.shed(keepForRound(overflowRounds), keepRecentForRound(overflowRounds));
              if (shed) {
                log?.append("shed", {
                  dropped: shed.dropped,
                  before: shed.before,
                  after: shed.after,
                  archive: shed.path,
                });
                yield {
                  kind: "shed",
                  dropped: shed.dropped,
                  before: shed.before,
                  after: shed.after,
                  path: shed.path,
                };
                failure = {
                  text: "context window too small for what molt was carrying",
                  why: "The endpoint could not hold the conversation.",
                  retryable: true,
                };
                if (shownThisAttempt) {
                  shownThisAttempt = false;
                  yield { kind: "stream_reset", why: "shed and retried" };
                }
                continue;
              }

              // Nothing older to drop. Before concluding anything, check
              // whether the problem is even age: a shed that freed 400 tokens
              // out of 18,300 was not failing, it was working on the wrong
              // thing. The bulk was a single file read the shed keeps by
              // design, and shrinking that is the only move left.
              if (over.window > 0) {
                const per = Math.max(
                  256,
                  Math.floor((over.window * RESULT_WINDOW_SHARE) / Math.max(this.tokenScale, 1)),
                );
                const trim = this.transcript.trimOversized(per);
                if (trim.trimmed > 0) {
                  log?.append("elide", {
                    trimmed: trim.trimmed,
                    tokensSaved: trim.tokensSaved,
                    reason: `oversized for a ${over.window}-token window`,
                  });
                  yield {
                    kind: "info",
                    text:
                      `nothing older left to shed, so ${trim.trimmed} oversized result(s) were ` +
                      `trimmed to fit — ${trim.tokensSaved} tokens freed. The files are still ` +
                      `on disk; re-read a narrower range to see what was cut.`,
                  };
                  failure = {
                    text: "context window too small for what molt was carrying",
                    why: "The endpoint could not hold the conversation.",
                    retryable: true,
                  };
                  continue;
                }
              }

              // Now it is genuinely the window. That verdict is drawn from an
              // empty transcript rather than from a ratio, which is noisy
              // enough to condemn a server that would have fitted.
              const fixedReal = Math.round(fixedEst * this.tokenScale);
              const need = Math.max(32_768, 2 ** Math.ceil(Math.log2(Math.max(fixedReal, 1) * 3)));
              failure = {
                text: over.window
                  ? `this endpoint serves ${over.window} tokens of context and there is nothing ` +
                    `left to shed — molt's system prompt and tool definitions alone are about ` +
                    `${fixedReal} as it counts them. Restart the server with a larger context ` +
                    `(-c ${need} or more), or use an endpoint that serves one.`
                  : "the endpoint refused the request as too large and there is nothing left to shed.",
                why: "Shedding cannot make this request fit.",
                retryable: false,
              };
              break;
            }
            const transient = res.status === 408 || res.status === 429 || res.status >= 500;
            failure = {
              text: `HTTP ${res.status}: ${body.slice(0, 300)}`,
              why: `The provider refused the request with HTTP ${res.status}.`,
              retryable: transient,
            };
            // A rate limit usually says when to come back. Believe it over a
            // fixed backoff — guessing shorter earns a second refusal, and
            // guessing longer wastes the wait.
            if (transient) failure.retryAfterMs = retryAfterMs(res);
          } else {
            const contentType = res.headers?.get?.("content-type") ?? "";
            const isSse = stream && res.body != null && contentType.includes("event-stream");
            if (isSse && this.native) {
              // Anthropic's stream is block-oriented rather than
              // choice-oriented, so it gets its own reader.
              const fragments: string[] = [];
              const result = await readNativeStream(res.body!, (f) => {
                fragments.push(f);
              });
              msg = result.message;
              finishReason = result.finishReason;
              usage = {
                prompt_tokens: result.promptTokens,
                completion_tokens: result.completionTokens,
                ...(result.cachedTokens === undefined
                  ? {}
                  : { prompt_tokens_details: { cached_tokens: result.cachedTokens } }),
                cache_read_input_tokens: result.cachedTokens,
                cache_creation_input_tokens: result.cacheWriteTokens,
              };
            } else if (isSse) {
              // Yielded as they arrive. This was buffered until the read
              // completed, on the reasoning that a few hundred milliseconds of
              // earlier paint was not worth the complexity — but on a local
              // endpoint a step is tens of seconds, and buffering meant the
              // window showed nothing at all for the whole of it. Three runs in
              // one session were cancelled during that silence.
              const frag = new Fragments();
              const safe = new SafeStream((t: string) => redact(t, this.secrets()));
              let streamAcc: StreamAccumulator | undefined;
              let live = "";
              shownThisAttempt = false;
              const reading = readStream(
                res.body!,
                (fragment) => frag.push(fragment),
                (a) => (streamAcc = a),
              )
                .then((r) => {
                  frag.finish();
                  return r;
                })
                .catch((e: unknown) => {
                  frag.finish();
                  throw e;
                });
              for await (const fragment of frag.drain()) {
                live += fragment;
                const showable = safe.take(fragment);
                if (showable) {
                  streamedContent = true;
                  shownThisAttempt = true;
                  yield { kind: "delta", text: showable };
                }
                // The model names a tool several hundred milliseconds before
                // its arguments finish. Said as soon as it is known, because
                // the gap between narration ending and a tool row appearing is
                // where a person decides the model has stalled.
                for (const name of streamAcc?.drainPending() ?? []) {
                  yield { kind: "tool_pending", name };
                }
              }
              const tail = safe.flush();
              if (tail) {
                streamedContent = true;
                shownThisAttempt = true;
                yield { kind: "delta", text: tail };
              }
              const result = await reading;
              msg = result.message;
              finishReason = result.finishReason;
              usage = {
                prompt_tokens: result.promptTokens,
                completion_tokens: result.completionTokens,
                ...(result.cachedTokens === undefined
                  ? {}
                  : { prompt_tokens_details: { cached_tokens: result.cachedTokens } }),
                ...(result.reasoningTokens === undefined
                  ? {}
                  : { completion_tokens_details: { reasoning_tokens: result.reasoningTokens } }),
                ...(result.costUsd === undefined ? {} : { cost: result.costUsd }),
              };
            } else {
              type Payload = {
                choices?: { message?: Msg; finish_reason?: string | null }[];
                usage?: Usage;
              };
              let json: Payload | undefined;
              try {
                json = (await res.json()) as Payload;
              } catch {
                // Named for what it is. An HTML error page from a proxy is the
                // usual cause, and "network: SyntaxError" sends whoever reads
                // it to debug the wrong layer.
                failure = {
                  text: "provider returned non-JSON response",
                  why: "The provider returned something that was not JSON.",
                  retryable: true,
                };
              }
              if (json && this.native) {
                const native = json as unknown as {
                  content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
                  stop_reason?: string | null;
                  usage?: Record<string, unknown>;
                };
                msg = toMessage(native);
                finishReason = finishReasonFor(native.stop_reason);
                usage = usageFor(native.usage);
              } else if (json) {
                msg = json.choices?.[0]?.message;
                finishReason = json.choices?.[0]?.finish_reason ?? undefined;
                usage = json.usage;
              }
            }
            if (!failure && !msg) {
              // A response shaped wrong is usually a proxy or a bad gateway
              // answering in the provider's place, which the next attempt
              // often gets past.
              failure = {
                text: "provider response missing choices[0].message",
                why: "The provider returned a response with no assistant message in it.",
                retryable: true,
              };
            }
          }
        } catch (e) {
          if (controller.signal.aborted) {
            this.inFlight = undefined;
            this.transcript.rollbackTo(turnStart);
            const wrote = [...new Set(this.ledger.map((e) => e.path))];
            log?.append("cancelled", { step, rolledBack: true, filesWritten: wrote });
            yield { kind: "cancelled", filesWritten: wrote };
            return;
          }
          failure = {
            text: `network: ${String(e)}`,
            why: "The connection to the provider failed and could not be re-established.",
            retryable: true,
          };
        }

        if (!failure) break;
        if (!failure.retryable || attempt >= NETWORK_RETRIES) break;
        // About to replay this message from the beginning. Anything already on
        // screen belongs to an attempt that is being abandoned, and leaving it
        // there would show the reader the same sentence twice with no way to
        // tell which one the model actually finished.
        if (shownThisAttempt) {
          shownThisAttempt = false;
          yield { kind: "stream_reset", why: failure.text };
        }
        const backoff = this.cfg.retryBackoffMs ?? NETWORK_BACKOFF_MS;
        const wait = failure.retryAfterMs ?? backoff[attempt] ?? backoff.at(-1) ?? 4_000;
        log?.append("note", { text: `${failure.text} — retrying in ${wait}ms` });
        yield {
          kind: "info",
          text:
            `${failure.text} — retrying in ${Math.round(wait / 100) / 10}s, ` +
            `attempt ${attempt + 2} of ${NETWORK_RETRIES + 1}`,
        };
        await sleepUnlessAborted(wait, controller.signal);
        if (controller.signal.aborted) {
          this.inFlight = undefined;
          this.transcript.rollbackTo(turnStart);
          const wrote = [...new Set(this.ledger.map((e) => e.path))];
          log?.append("cancelled", { step, rolledBack: true, filesWritten: wrote });
          yield { kind: "cancelled", filesWritten: wrote };
          return;
        }
      }

      this.inFlight = undefined;

      if (failure || !msg) {
        const text = failure?.text ?? "provider response missing choices[0].message";
        log?.append("error", { text });
        yield {
          kind: "error",
          text:
            `${text}${failure?.retryable ? ` — gave up after ${NETWORK_RETRIES + 1} attempts` : ""}. ` +
            `Nothing was verified. The work above still happened; what follows is a report ` +
            `on it, not a completion.`,
        };
        // Only where a last request could plausibly do better. A 400 or a 401
        // is the conversation, the model id, or the credentials being wrong,
        // and a salvage would be refused in exactly the same way — paying
        // twice to be told the same thing is the spending this avoids.
        if (failure?.retryable !== false) {
          yield* this.salvage(failure?.why ?? "The provider returned nothing usable.", fetchFn, log);
        }
        return;
      }

      // The attempt stuck, so the text it produced can go to the screen.
      //
      // A provider that does not stream sends its prose in the message body,
      // and nothing carried it: `assistant_text` is the turn's final answer
      // and is only sent at the end, so with `--no-stream` every word the
      // model wrote on the way — what it was about to do and why — was thrown
      // away and only the tool calls showed. Sent as a delta, which is the
      // event that means "the model is talking", so both kinds of provider
      // reach the screen the same way.
      // Only for a provider that did not stream. The SSE path now yields its
      // fragments as they arrive, and repeating the joined text here is how the
      // whole message came out twice.
      const said = streamedContent ? "" : redact(msg.content ?? "", this.secrets());
      if (said) {
        streamedContent = true;
        yield { kind: "delta", text: said };
      }

      const reportedUsage =
        typeof usage?.prompt_tokens === "number" || typeof usage?.completion_tokens === "number";
      const pTok = usage?.prompt_tokens ?? estTokens(JSON.stringify(wire));
      const cTok = usage?.completion_tokens ?? estTokens(JSON.stringify(msg));
      const cachedTok =
        usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? 0;
      const billedUsd = usage?.cost;
      const costBefore = this.costUsd();

      this.sessionPrompt += pTok;
      this.sessionCompletion += cTok;
      this.sessionCached += cachedTok;
      if (!reportedUsage) this.estimatedSteps += 1;

      // Every successful step is a free measurement of how wrong molt's
      // character-count estimate is on this endpoint's tokenizer. Learning it
      // here means auto-shed is sized correctly before an overflow rather than
      // after one — the refused request is the expensive way to find out, and
      // on a small window it arrives mid-turn with work already done.
      if (reportedUsage && typeof usage?.prompt_tokens === "number") {
        const learned = tokenScale(usage.prompt_tokens, requestEst);
        if (learned > this.tokenScale) this.tokenScale = learned;
      }
      if (typeof billedUsd === "number") this.sessionBilled += billedUsd;
      else this.unbilledSteps += 1;

      const costAfter = this.costUsd();
      const stepCost =
        typeof billedUsd === "number"
          ? billedUsd
          : costAfter === undefined
            ? undefined
            : costAfter - (costBefore ?? 0);

      log?.append("response", {
        step,
        promptTokens: pTok,
        completionTokens: cTok,
        cachedTokens: cachedTok,
        // Providers do not always report usage. Say which this is.
        estimated: !reportedUsage,
        costUsd: stepCost ?? null,
        billed: typeof billedUsd === "number",
        finishReason: finishReason ?? null,
        toolCalls: msg.tool_calls?.length ?? 0,
        contentChars: (msg.content ?? "").length,
        finishedWithText: Boolean(msg.content),
      });
      yield {
        kind: "usage",
        promptTokens: pTok,
        completionTokens: cTok,
        cachedTokens: cachedTok,
        sessionTokens: this.sessionTokens,
        costUsd: costAfter,
        estimated: !reportedUsage,
        billed: typeof billedUsd === "number",
      };
      // Cumulative prompt tokens are dominated by resending the same
      // conversation, which is fine when the provider caches it and brutal
      // when it does not. Said once, when it starts to matter, because it
      // changes which provider a long session should run on.
      if (
        !this.warnedNoCache &&
        this.sessionCached === 0 &&
        this.sessionPrompt > 100_000 &&
        reportedUsage &&
        // Not on your own hardware. The sentence below is about a bill, and
        // there is no bill — worse, its advice is to move to a provider with
        // automatic caching, which is the opposite of what someone running a
        // model locally wants to hear. A local server may well be reusing its
        // KV cache for the same prefix and simply not reporting it in the
        // OpenAI usage shape, so zero here is not even evidence of rework.
        !isSelfHosted(this.cfg.baseUrl)
      ) {
        this.warnedNoCache = true;
        yield {
          kind: "info",
          text:
            `${this.sessionPrompt} prompt tokens so far and none of them cached — this ` +
            `endpoint re-bills the whole conversation on every step. Providers with ` +
            `automatic caching charge a fraction of this for the same work.`,
        };
      }

      // A cache that stops working mid-session is worse than one that never
      // worked, because the warning above never fires: the session total keeps
      // the early hits and looks healthy while every new step pays full price.
      // Observed on a real run — the hit rate held for two steps and then sat
      // at 128 tokens against a prompt growing to 50,000, which was most of
      // that turn's bill and nothing said so.
      //
      // Judged per step rather than cumulatively, and only once the prompt is
      // large enough for the difference to be real money.
      if (reportedUsage && pTok > CACHE_WATCH_TOKENS) {
        const hit = cachedTok / pTok;
        if (hit >= 0.25) this.cacheWasWorking = true;
        else if (this.cacheWasWorking && !this.warnedCacheLost) {
          this.warnedCacheLost = true;
          yield {
            kind: "info",
            text:
              `prompt caching stopped: this step reused ${cachedTok} of ${pTok} tokens ` +
              `(${Math.round(hit * 100)}%) after earlier steps were reusing most of the ` +
              `conversation. Every step from here re-bills the whole context. If it does ` +
              `not recover, a fresh session re-establishes the cache more cheaply than ` +
              `continuing this one.`,
          };
        }
      }

      const spend: Spend = {
        promptTokens: pTok,
        completionTokens: cTok,
        cachedTokens: cachedTok,
        costUsd: stepCost,
        estimated: !reportedUsage,
        billed: typeof billedUsd === "number",
      };
      /** Close out the step with what it did and what it cost. */
      const summary = (tools: string[], outcome: "tools" | "claim"): EngineEvent => ({
        kind: "step_summary",
        job,
        step,
        tools,
        spend,
        sessionTokens: this.sessionTokens,
        sessionCostUsd: this.costUsd(),
        durationMs: Date.now() - stepStartedAt,
        outcome,
        finishReason,
      });

      this.transcript.push({
        role: "assistant",
        content: msg.content ?? null,
        ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
      });

      // The message is complete. Said before the tool calls below, so what the
      // model wrote appears above the work it was introducing rather than
      // after it — and so the next step starts on a line of its own.
      yield { kind: "message_end" };

      if (msg.tool_calls?.length) {
        const called: string[] = [];
        let autoRan = 0;
        let repeated = 0;
        for (const call of msg.tool_calls) {
          const name = call.function?.name ?? "unknown";
          let args: Record<string, unknown> = {};
          let malformed = false;
          try {
            args = JSON.parse(call.function?.arguments || "{}") as Record<string, unknown>;
          } catch {
            // Running with empty arguments produced a misleading error — a
            // malformed read_file became "EISDIR: illegal operation on a
            // directory", which sends the model to debug a path it never
            // sent. Say what actually happened instead.
            malformed = true;
          }
          const detail = toolDetail(name, args);
          // What the current autonomy level says about this exact call. The
          // decision is mechanical and the reason travels with it, so an
          // approval prompt can say which rule produced it rather than
          // asking the same way about everything.
          const decision = gate(this.autonomy, { name, args, cwd: this.cwd });
          // The prompt shows the command in full. You are being asked to judge
          // it, and a redacted command is one you cannot judge.
          const allowed = decision.ask ? await confirm(name, `${detail}${decision.why ? ` — ${decision.why}` : ""}`) : true;

          let result: string;
          let note: string | undefined;
          if (malformed) {
            const raw = capture(call.function?.arguments ?? "");
            yield {
              kind: "tool",
              name,
              detail: "malformed arguments",
              note: "malformed",
              args: raw,
              bytes: 0,
              preview: raw,
              auto: true,
            };
            this.transcript.push({
              role: "tool",
              tool_call_id: call.id,
              content:
                `[molt: the arguments for ${name} were not valid JSON, so nothing ran. ` +
                `Send them again as a JSON object. What arrived was: ${raw}]`,
            });
            called.push(name);
            continue;
          }
          // Timed around execution only. Waiting on a human to approve a gated
          // tool is not the tool being slow, and folding the two together
          // would make every gated call look like one.
          let durationMs: number | undefined;
          if (!allowed) {
            result = "User denied this action.";
            note = "denied";
          } else {
            yield { kind: "tool_start", name, detail };
            const toolStartedAt = Date.now();
            // Scoped to this one call, so ctrl+C reaches the command that is
            // actually running and nothing that ran before it.
            this.running = new AbortController();
            try {
              // read_file budgets itself, to the byte, so that the notice
              // saying how to continue survives. Capping it again here is what
              // cut that notice off and left the model with no way forward.
              const raw = await this.runTool(name, args, call.id);
              const t =
                name === "read_file"
                  ? { text: raw, note: undefined }
                  : truncateResult(raw, Math.min(TOOL_RESULT_MAX_BYTES, this.resultBudget()));
              result = t.text;
              note = t.note;
            } catch (e) {
              result = `tool error: ${String(e)}`;
              note = "error";
            } finally {
              this.running = undefined;
            }
            durationMs = Date.now() - toolStartedAt;

            // A read of lines the model has already been shown, whatever
            // offset it spelled them with.
            if (name === "read_file" && note !== "error") {
              const path = String(args.path ?? "");
              const from = num(args.offset, 0);
              const to = actualReadEnd(result, from, path);
              const covered = shown.get(path) ?? [];
              // How much of this window is genuinely new. Containment alone is
              // too strict: a read that overlaps an earlier one by 99% and
              // runs three lines past it is not contained, and a model
              // drifting its offset by a few lines a step walked straight
              // through that test for thirty-two steps.
              let fresh = 0;
              for (let line = from; line < to; line++) {
                if (!covered.some((r) => line >= r.from && line < r.to)) fresh += 1;
              }
              const span = Math.max(1, to - from);
              const already = fresh === 0 || (fresh / span < 0.25 && fresh < 40);
              if (already) {
                const seen = covered.reduce((n, r) => Math.max(n, r.to), 0);
                result =
                  `[molt: you have already been shown lines ${from + 1}-${to} of ${path}` +
                  (fresh === 0 ? "" : ` (all but ${fresh} line(s) of it)`) +
                  `. Scroll up rather than reading it again — nothing has changed since. To ` +
                  `see a part you do not have, ask for offset=${seen} or later; if you have ` +
                  `what you need, answer.]`;
                note = "repeat";
                repeated += 1;
              } else {
                covered.push({ from, to });
                shown.set(path, covered);
              }
            }

            // The same call, returning the same bytes it returned before.
            // Send a pointer instead of the payload: the answer is already in
            // the conversation, and saying so is both cheaper and truer than
            // repeating it.
            // Canonical key: {path} and {path, offset: 0} are the same call,
            // and a model that spells out a default must not thereby look like
            // it is asking something new.
            const key = callKey(name, args);
            const sha = createHash("sha256").update(result, "utf8").digest("hex");
            const prior = answered.get(key);
            if (prior && prior.sha === sha) {
              result =
                `[molt: this is the same ${name} call you made at step ${prior.step + 1}, and ` +
                `nothing has changed since. Its result is already above in this conversation. ` +
                `Repeating it cannot tell you anything new — act on what you have, or say ` +
                `plainly what is blocking you.]`;
              note = "repeat";
              repeated += 1;
            }
            answered.set(key, { step, sha });
          }
          // Both branches are recorded. A call that ran without being asked
          // about is exactly the thing an audit needs to be able to find, and
          // it is recorded with the level that let it through.
          log?.append("permission", {
            name,
            detail,
            allowed,
            asked: decision.ask,
            autonomy: this.autonomy,
            ...(decision.why ? { why: decision.why } : {}),
          });
          log?.append("tool_call", { step, name, detail, allowed });
          log?.append("tool_result", {
            name,
            bytes: Buffer.byteLength(result, "utf8"),
            truncated: Boolean(note?.startsWith("capped")),
            note,
            sha256: createHash("sha256").update(result, "utf8").digest("hex").slice(0, 16),
          });
          if ((name === "write_file" || name === "edit_file") && allowed) {
            shown.delete(String(args.path ?? ""));
            this.pinTask(userText);
          }
          called.push(name);
          this.did.push(
            `${allowed ? "" : "refused: "}${name} ${detail}` +
              (note && note !== "repeat" ? ` [${note}]` : ""),
          );
          if (allowed) this.actsSinceBar += 1;
          if (!decision.ask) autoRan += 1;
          // Everything that scrolls is redacted. A transcript is pasted into
          // bug reports and screenshotted into chat windows, which makes the
          // screen a distribution channel like any other — and unlike the
          // prompt above, nobody is judging a command from the scrollback.
          const hide = (t: string) => redact(t, this.secrets());
          yield {
            kind: "tool",
            name,
            detail: hide(detail),
            note,
            durationMs,
            args: hide(capture(call.function?.arguments ?? "")),
            bytes: Buffer.byteLength(result, "utf8"),
            preview: hide(capture(result)),
            auto: !decision.ask,
          };
          this.transcript.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        yield summary(called, "tools");

        // A step that mostly repeated itself learned little. Worth saying —
        // and nothing more than that.
        //
        // This used to end the turn on the second such step in a row. It was
        // the wrong instrument: repetition is a *guess* at waste, and the guess
        // is bad. A model that re-reads a file it has just edited, re-runs a
        // suite to see it go green, or re-checks a path before writing to it is
        // repeating a call and making progress — and the read-coverage branch
        // above counts a largely-overlapping re-read as a repeat too. Two such
        // steps in a row and a turn died with 384,000 tokens of real work in it
        // and nothing to show, which is the exact "maximum cost, zero value"
        // outcome `salvage` exists to prevent.
        //
        // Spend is already bounded by instruments that measure spend directly,
        // are checked before every step, warn on the way up, and are the user's
        // to set: `/budget` for the session, the per-turn ceiling above, and
        // MAX_STEPS behind both. A proxy that guesses at the same thing and
        // gets it wrong does not add safety, it just takes the turn away.
        //
        // What survives is the part that pays for itself: the repeated call
        // still gets a pointer instead of its payload, so a loop gets cheaper
        // as it goes, and the model is told plainly it is going in circles.
        if (called.length > 0 && repeated * 2 >= called.length) {
          dryStreak += 1;
          log?.append("repeat_step", {
            step,
            repeated,
            calls: called.length,
            streak: dryStreak,
            sessionTokens: this.sessionTokens,
            costUsd: this.costUsd() ?? null,
          });
          yield {
            kind: "info",
            text:
              `${repeated} of ${called.length} calls that step were things molt had already ` +
              `answered — little or nothing new came back` +
              (dryStreak >= 2
                ? `. That is ${dryStreak} steps in a row; it is spending against ` +
                  `${this.budgetTokens === undefined ? "this turn's ceiling" : "your /budget"} ` +
                  `without learning anything. shift+V to watch what it is reaching for.`
                : ""),
          };
        } else {
          dryStreak = 0;
        }
        continue; // let the model see tool results
      }

      yield summary([], "claim");

      // ---- The model believes it is finished. That is a claim. ----
      const claim = msg.content ?? "";

      if (!bar || bar.checks.length === 0) {
        yield {
          kind: "info",
          text: opts.ask
            ? "nothing left in the bar to check a question against — this answer is unverified."
            : "no .molt/done.yml — completion is unverified. run `molt init` to add a bar.",
        };
        // `streamed` says the deltas already carried this text. Still sent, so
        // that "the model gave a final answer" stays one event a caller can
        // wait on — `molt run`'s exit code turns on it — but a surface that
        // already printed it knows not to print it twice.
        if (claim) {
          yield {
            kind: "assistant_text",
            text: redact(claim, this.secrets()),
            streamed: streamedContent,
          };
        }
        return;
      }

      // Nothing has happened since the last bar run, so the bar cannot
      // answer differently. Say so and stop, rather than spending another
      // suite — and another turn's tokens — proving it.
      if (lastResult !== null && this.actsSinceBar === 0) {
        log?.append("bar_skipped", {
          attempt: proofAttempts,
          reason: "no tool calls since the last bar run; state is unchanged",
          failed: lastResult.results.filter((r) => !r.ok).map((r) => r.name).join(", "),
        });
        yield {
          kind: "info",
          text:
            "the model changed nothing since the last check, so re-running the bar would " +
            "produce the same result. Stopping instead of spending another attempt.",
        };
        yield* this.finishUnproven(claim, lastResult, proofAttempts, log);
        return;
      }

      proofAttempts += 1;
      yield {
        kind: "proof_start",
        checks: bar.checks.length,
        names: bar.checks.map((c) => c.name),
      };
      const result = await this.runBarGuarded(claim, barNow());
      this.actsSinceBar = 0;
      lastResult = result;
      log?.append("bar_run", {
        attempt: proofAttempts,
        ok: result.ok,
        total: result.results.length,
        passed: result.results.filter((r) => r.ok).length,
        failed: result.results.filter((r) => !r.ok).map((r) => r.name).join(", "),
        ms: result.durationMs,
        checks: result.results.map((r) => ({
          name: r.name,
          kind: r.kind,
          detail: r.detail,
          ok: r.ok,
          exitCode: r.exitCode ?? null,
          ms: r.durationMs,
          // A reused result is evidence of a different kind, and the record
          // has to say which kind it is.
          cached: r.cached === true,
        })),
      });
      // A bar failing in exactly the same way it failed last time is a bar the
      // model is not converging on. It spent 1.13M tokens on one such loop,
      // rewriting a correct document to satisfy a check that was wrong about
      // it — so identical twice is enough.
      const signature = result.results
        .filter((r) => !r.ok)
        .map((r) => `${r.name}:${r.output.trim()}`)
        .join("|");
      const stuck = !result.ok && signature === lastFailure;
      lastFailure = signature;
      const exhausted = !result.ok && (stuck || proofAttempts >= maxAttempts);
      const verdict = result.ok ? "accepted" : exhausted ? "exhausted" : "refused";

      if (this.cfg.receipts) {
        const receipt = this.cfg.receipts.write({
          claim,
          result,
          attempt: proofAttempts,
          verdict,
          model: this.cfg.model,
          provider: this.provider,
          sessionTokens: this.sessionTokens,
          session: this.cfg.journal?.sessionId,
          costUsd: this.costUsd(),
          costEstimated: this.costEstimated,
          shedBatches: this.transcript.shedCount,
          changed: this.mergedLedger().map((e) => ({ path: e.path, before: e.before, after: e.after })),
          did: [...this.did],
          task: taskSeal
            ? {
                // Recomputed from the frozen arrays, not carried along, so a
                // receipt that disagrees with the journal is a real signal
                // rather than the same string copied twice.
                seal: sealOf(taskChecks, taskNotes),
                checks: taskChecks.map((c) =>
                  c.kind === "command" ? `${c.name}: ${c.run}` : `${c.name}: builtin ${c.builtin}`,
                ),
                notes: [...taskNotes],
              }
            : undefined,
        });
        log?.append("receipt", { verdict, file: receipt.path, attempt: proofAttempts });
        yield { kind: "receipt", path: receipt.path };
      }

      if (result.ok) {
        log?.append("session_end", { reason: "bar met", attempts: proofAttempts });
        yield { kind: "proof_result", result, attempt: proofAttempts };
        // `streamed` says the deltas already carried this text. Still sent, so
        // that "the model gave a final answer" stays one event a caller can
        // wait on — `molt run`'s exit code turns on it — but a surface that
        // already printed it knows not to print it twice.
        if (claim) {
          yield {
            kind: "assistant_text",
            text: redact(claim, this.secrets()),
            streamed: streamedContent,
          };
        }
        return;
      }

      if (exhausted) {
        log?.append("session_end", { reason: "bar not met", attempts: proofAttempts });
        yield { kind: "proof_exhausted", result, attempts: proofAttempts };
        const onlyWrites = failedOnlyWriteChecks(result);
        if (stuck) {
          yield {
            kind: "info",
            text:
              "the bar failed in exactly the same way twice. Continuing would spend more " +
              "tokens on a check the work is not moving — either the work cannot satisfy " +
              "it, or the check is wrong about the work.",
          };
        }
        yield {
          kind: "error",
          text: onlyWrites
            ? `bar not met: ${onlyWrites} requires this turn to have changed a file, and ` +
              `none changed. molt is reporting failure rather than success. Either the work ` +
              `was not done, or this was a question — ask questions with /ask, or a leading ` +
              `"?", which runs the rest of the bar and drops that one check.`
            : `bar not met after ${proofAttempts} attempts. molt is reporting failure rather ` +
              `than success. See .molt/receipts/ for what was checked.`,
        };
        return;
      }

      yield { kind: "proof_refused", result, attempt: proofAttempts };
      this.pinTask(
        userText,
        result.results.filter((r) => !r.ok && !r.advisory).map((r) => r.name).join(", "),
      );
      this.transcript.pushBarFailure(formatBarFailure(result, proofAttempts, maxAttempts));
    }

    yield {
      kind: "error",
      text:
        `stopped after ${MAX_STEPS} steps (loop guard) · ${this.sessionTokens} tokens` +
        (this.costUsd() === undefined ? "" : ` · ${fmtUsd(this.costUsd() ?? 0)}`) +
        `. Nothing was verified. Narrow the request, or set /budget to put a ceiling on a ` +
        `turn like this.`,
    };
    yield* this.salvage(`You have used all ${MAX_STEPS} steps available for this turn.`, fetchFn, log);
  }

  /** Preflight: is the endpoint reachable, and is the model actually there? */
  /**
   * `reachable` is reported separately from `ok`.
   *
   * `ok` folds two questions together — did the endpoint answer, and is this
   * model on it — which is the right answer for `molt doctor`, where both must
   * hold. It is the wrong answer immediately after switching endpoints, where
   * no model has been chosen yet: the caller printed "unreachable" over a
   * detail line that said "endpoint reachable · 6 models", because `ok` was
   * false for a model that was deliberately blank.
   */
  async doctor(): Promise<{
    ok: boolean;
    reachable: boolean;
    detail: string;
    modelPresent?: boolean;
    models?: string[];
  }> {
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const base = this.cfg.baseUrl.replace(/\/$/, "");
    try {
      const res = await fetchFn(`${base}/models`, { headers: authHeaders(base, this.cfg.apiKey) });
      if (!res.ok) {
        return { ok: false, reachable: false, detail: `HTTP ${res.status} from ${base}/models` };
      }
      const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const ids = (json?.data ?? []).map((m) => m.id).filter(Boolean) as string[];
      // No list at all is not evidence against the model; endpoints that hide
      // /models exist, and refusing them would be a guess dressed as a check.
      if (!ids.length) {
        return {
          ok: true,
          reachable: true,
          models: [],
          detail: `endpoint reachable (${base}) · model list unavailable`,
        };
      }
      const has = ids.includes(this.cfg.model);
      return {
        // A preflight that passes on a model the endpoint does not have is a
        // preflight that only fails once the work has already started.
        ok: has,
        reachable: true,
        modelPresent: has,
        models: ids,
        detail:
          `endpoint reachable · ${ids.length} models` +
          (has
            ? ` · '${this.cfg.model}' available`
            : ` · ⚠ '${this.cfg.model}' NOT in list (try: ${ids.slice(0, 3).join(", ")})`),
      };
    } catch (e) {
      return { ok: false, reachable: false, detail: `cannot reach ${base}: ${String(e)}` };
    }
  }

  /** List model ids from an endpoint's /models route. */
  async listModels(
    baseUrl = this.cfg.baseUrl,
    apiKey = this.cfg.apiKey,
  ): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const base = baseUrl.replace(/\/$/, "");
    try {
      const res = await fetchFn(`${base}/models`, { headers: authHeaders(base, apiKey) });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${base}/models` };
      const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const ids = (json?.data ?? []).map((m) => m.id).filter(Boolean) as string[];
      return { ok: true, ids };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
}
