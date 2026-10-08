/**
 * molt's engine — a small agent loop that speaks the OpenAI-compatible
 * /chat/completions wire format, so one implementation covers OpenAI,
 * OpenRouter, Groq, Mistral, and — the point — local llama.cpp / Ollama /
 * vLLM servers. Any base URL, any key, any model.
 *
 * What makes it molt rather than one more harness is the proof gate. When
 * the model stops calling tools and produces a final answer, that answer
 * is treated as a CLAIM, not a result. molt runs the project's bar
 * (.maat/done.yml). If any check fails, the claim is refused, the exact
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
import { bashPath, runCommand } from "./run.js";
import { copyTreeOrWhy } from "./scratch.js";
import { scrubEnv, secretValue, secretValues } from "./secrets.js";
import { describeStart, listBackground, startBackground, stopBackground } from "./background.js";
import { objectionLine, readsTheWork, reviewClaim, type ExecutableReview, type ObjectionRun, type Review } from "./review.js";
import { credentialFreeEnv } from "./credenv.js";
import { judgeEffort, judgeTarget } from "./judge.js";
import { auditClaim, authorKey, authorWords, claimLabel, contradictions, independentOf, tierOf, withAuthor, type Tier } from "./tiers.js";
import { recordGoldens, valueUnproven } from "./golden.js";
import { discountedChecks } from "./control.js";
import { postWorkAudit, type AuditReport } from "./post-audit.js";
import { arbitrate, parseDisputes, type Ruling } from "./dispute.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync, statSync } from "node:fs";
import { excludeMoltFromGit, listProject, removeNew, unnamedNewFiles, type ProjectListing } from "./leftovers.js";
import { inspectDir, inspectFile, namedInputs, profileLine } from "./inspect.js";
import { basename, dirname, resolve, relative, isAbsolute, join } from "node:path";
import type { ArchiveLike } from "./archive.js";
import {
  BAR_FILENAME,
  CheckCache,
  barFingerprint,
  clipEnds,
  formatBarFailure,
  runBar,
  type BarContext,
  barPath,
} from "./bar.js";
import { checkSelfError, preflightCriteria } from "./criteria.js";
import { preWorkCopy, type PreWorkCopy } from "./scratch.js";
import {
  AUTONOMY_SUMMARY,
  DEFAULT_AUTONOMY,
  gate,
  insideProject,
  type Autonomy,
  isReadOnlyCommand,
} from "./autonomy.js";
import { errorText } from "./format.js";
import { MOLT_TOOL_NAMES, narratedCallIn, narratedCallNudge } from "./narrated.js";
import { redact } from "./redact.js";
import { WITHHELD_MIN_CHARS, commandSha, hiddenCommands, maskDeep, maskText } from "./withhold.js";
import { Watchdog, envFirstByteMs, firstByteMs, probeError, probeSignal, requestIdleMs, waited, localSpeed, LatencyLearner } from "./watchdog.js";
import {
  SKIP_DIRS,
  WALK_DEADLINE_MS,
  applyEdit,
  diffSyntaxIn,
  diffSyntaxRefusal,
  isPatchPath,
  formatListing,
  formatMatches,
  grepFiles,
  changedLinesOf,
  substanceOf,
  walkAsync,
  isTestPath,
  specWeakened,
  snapshotTree,
  type TreeSnapshot,
} from "./files.js";
import {
  isAnthropicNative,
  messagesUrl,
  readNativeStream,
  toMessage,
  toRequest,
  usageFor,
  finishReasonFor,
  outputCeiling,
  DEFAULT_MAX_TOKENS,
} from "./anthropic.js";
import { breakpoints, withCaching, refusedCaching, type CacheStyle, cacheStyle } from "./cache.js";
import { Journal } from "./journal.js";
import {
  commitMessage,
  commitPaths,
  isRepo,
  pathsIn,
  restore as restoreFiles,
  revertPlan,
  snapshot,
  treeState,
  type LedgerLike,
} from "./git.js";
import { Integrity } from "./integrity.js";
import {
  authHeaders,
  isSelfHosted,
  selfHostedThinking, openRouterProvider,
} from "./providers.js";
import { Receipts } from "./receipts.js";
import { normalizeRequirements, signOut, signOutMessage, type SignOut } from "./signout.js";
import { gitPathsStaged, touches } from "./gitbend.js";
import { REFERENCE_CHECK_NAME, REFERENCE_SELF_ERROR } from "./reference.js";
import { argumentProblems } from "./toolargs.js";
import { takeTurn } from "./localgate.js";
import { parseLenient } from "./lenient-json.js";
import { LONG_RATE_LIMIT_MS, longQuotaText, rateLimitResetAt, untilText, providerErrorText, normalizeMessage, readStream, transientProviderError, type ProviderError, type StreamAccumulator, type Usage } from "./stream.js";
import { Fragments, SafeStream } from "./live.js";
import { Transcript, excerpt, toolDetail } from "./transcript.js";
import { acpAgentFor, acpHealth, acpModels, AcpSession, backendStallMs, isAcp } from "./acp.js";
import { type BackendSession, type ToolRunner } from "./backend.js";
import { endpointProblem, removedSubscriptionProblem } from "./endpoint.js";
import {
  estTokens,
  type Bar,
  type Check,
  type CheckAuthor,
  type CheckResult,
  type BarResult,
  type Bom,
  type Confirm,
  type EngineEvent,
  type FileDiff,
  type LedgerEntry,
  type JobOutcome,
  type Msg,
  type Spend,
} from "./types.js";
import { stateDir, stateDirName, stateRedirect } from "./statedir.js";
import { gitSync, isolationLine, privSep, type WorkerFs } from "./privsep.js";
import { bashReach, noProgressCallsFromEnv, outsideTask, ProgressMeter, taskPathsIn, treeStamp } from "./scope.js";

/** Journals that already carry the isolation line (one per journal, however many engines share it). */
const isolationNoted = new WeakSet<object>();
import { env } from "./env.js";
import { Judgments, caseReason, reasonText } from "./judgment.js";

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
  "You are Maat, a coding agent working in the current directory.",
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
  "This project defines what 'done' means in .maat/done.yml. When you finish,",
  "those checks run automatically. If any fail you will be told exactly which,",
  "with their output, and you must fix the underlying problem and continue.",
  "Do not edit .maat/done.yml to make checks pass. Do not claim work you have",
  "not done — it will be checked against the full session record.",
  "",
  "Changing what code does makes the tests that pinned the old behaviour wrong.",
  "Update them. Adding a test for the new behaviour does not retire the old one:",
  "both still run, and the suite stays red until the contradiction is gone.",
  "",
  "But a test that contradicts your change is not an obstacle to be removed. Fix",
  "the code so it meets the test. If you believe the test itself is wrong, say",
  "which assertion and why, and stop — that is a decision for a person.",
  "",
  "Work in batches. Every reply is a round trip that resends this whole",
  "conversation, so when reads, searches or commands do not depend on each other,",
  "make all of those tool calls in the same reply, and give bash a list of",
  "commands rather than calling it once per command. One tool call per reply is",
  "the slow way to work.",
  "",
  "Any checks this task has run by themselves when you say you are done. While",
  "you work, run only the narrowest test that covers what you just changed; do not",
  "rebuild or rerun the whole suite after every edit.",
  "",
  "If you are unsure whether something worked, say so and check it rather than",
  "asserting it. An unverified claim costs the same as a false one.",
].join("\n");

/**
 * What a headless run is told that an interactive one is not.
 *
 * Every sentence here was bought by a run that ended early. "Which of these
 * would you like?" ended a CI run with no work and exit 3. "I have described
 * the approach; let me know if you want me to implement it" ended another.
 * The last line is the one that moves a terminal benchmark: the grader reads
 * the file the task named, at the path it named, and nothing else.
 */
export const UNATTENDED_PROMPT = [
  "Nobody is watching this run and nobody will reply. A question ends the job",
  "with nothing done, so do not ask one: choose the reasonable reading, say in",
  "one line what you assumed, and continue. Do the work rather than describing",
  "it. When the task names a file, a path, a command or an output format,",
  "produce exactly that, there. Check your result the way a grader would — run",
  "the thing, read the output — before you say it is done.",
  "",
  "Do scratch work outside the task's directories: helper scripts, copies of the",
  "input, experiments and snapshots (a `git init` to diff against, a trial run on a",
  "copy) go in $(mktemp -d). Try a change that rewrites files on a copy first, then",
  "apply it. Before you finish, remove anything you still left in the task's",
  "directories that it did not ask for — build outputs, test binaries, scratch files.",
].join("\n");

/** What a project with no .maat/done.yml is told, so nobody goes looking for one. */
export const NO_BAR_PROMPT =
  "This project has no .maat/done.yml, so do not look for one. Done is judged by the " +
  "acceptance criteria stated in this conversation, if any, and by the task itself.";

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
export function systemPromptFor(cwd: string, extra?: string): string {
  const base = `${SYSTEM_PROMPT}\n\nThe working directory is ${cwd} — that, and not a guess, is where relative paths land.`;
  return extra ? `${base}\n\n${extra}` : base;
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
 * There is no default spending ceiling. There was, and it was wrong.
 *
 * A turn used to stop at $1.00, or at 500,000 tokens where no price was known,
 * unless someone had said otherwise. Nobody chose either number — the same
 * fault as the 8,192-token response cap this project removed for the same
 * reason, and it fails the same way: a limit nobody set interrupts real work
 * in the middle, which is the most expensive place to stop, and the person it
 * interrupts has no idea why that number and not another.
 *
 * A ceiling is a real control and it still exists. `/budget 4000000` sets one
 * in tokens, `/budget $5` in money, `--budget` before a run, and once set it
 * warns on the way up and asks before it gives up. It binds because someone
 * decided it should, which is the only way a limit means anything.
 *
 * What is left in its place is not nothing. Spend is reported on every step
 * and on every receipt; the guards that can recognise waste rather than merely
 * measure it — repeats, drifting re-reads, empty turns, the step ceiling —
 * are unchanged and were always the part that caught real problems.
 */

/** Fractions of the ceiling at which molt says something, once each. */
const CEILING_WARNINGS = [0.5, 0.8];

/** Malformed tool calls in a row before the model is told firmly, and before the turn ends. */
export const MALFORMED_WARN = 3;
export const MALFORMED_STOP = 6;

/** A line break or other control character in a file name: no real file needs one, and in a receipt it could forge a heading. */
const CONTROL_IN_PATH = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const CONTROL_PATH_REFUSAL = "refused: a file name may not contain a line break or other control character";

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
 * original is preserved in `.maat/exuviae/`, `record-intact` fails if it is
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

/**
 * A refusal where the completion reserve, not the prompt, overflowed.
 *
 * vLLM-style servers count `max_tokens` against the window. GMI Cloud serves
 * qwen3-235b with a 131,072-token TOTAL window, and the request went out with
 * the model's full listed output (an OpenAI-shaped request with no max_tokens
 * is given that by the router), so a 2,454-token prompt was refused:
 *
 *     maximum context length of 131072 tokens. You requested a total of
 *     133526 tokens: 2454 tokens from the input messages and 131072 tokens
 *     for the completion.
 *
 * Shedding history can never fix that. Every server words it differently:
 * vLLM (both its old and current wordings), OpenAI, OpenRouter, Anthropic and
 * TGI are read below. llama.cpp never refuses for the reserve (it stops the
 * reply when the window fills), so its refusal is always a prompt overflow.
 * Returns the window, the input and the completion the server counted, or
 * null when the body does not say all three.
 */
export function completionOverflow(body: string): { window: number; input: number; completion: number } | null {
  const ok = (window: number, input: number, completion: number) =>
    window > 0 && input >= 0 && completion > 0 ? { window, input, completion } : null;

  // Anthropic: "input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000".
  const anth = /max_tokens`?\s+exceed context limit:\s*(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/i.exec(body);
  if (anth) return ok(Number(anth[3]), Number(anth[1]), Number(anth[2]));

  // Hugging Face TGI: "`inputs` tokens + `max_new_tokens` must be <= 4096. Given: 1000 `inputs` tokens and 4000 `max_new_tokens`".
  const tgi = /must be <= (\d+)\.\s*Given:\s*(\d+) `?inputs`? tokens and (\d+) `?max_new_tokens`?/i.exec(body);
  if (tgi) return ok(Number(tgi[1]), Number(tgi[2]), Number(tgi[3]));

  const win = /maximum context length (?:is|of) (\d+)/i.exec(body);
  if (!win) return null;
  const window = Number(win[1]);

  // vLLM (since vllm#36197): "you requested 32768 output tokens and your prompt contains 1000 input tokens".
  const v2 = /you requested (\d+) output tokens? and your prompt contains (\d+) input tokens?/i.exec(body);
  if (v2) return ok(window, Number(v2[2]), Number(v2[1]));

  // vLLM 0.8-0.16: "'max_tokens' or 'max_completion_tokens' is too large: 32768. This model's maximum
  // context length is 32768 tokens and your request has 1000 input tokens (32768 > 32768 - 1000)."
  const v1 = /is too large:\s*(\d+)[\s\S]{0,200}?your request has (\d+) input tokens?/i.exec(body);
  if (v1) return ok(window, Number(v1[2]), Number(v1[1]));

  // GMI / vLLM: "A tokens from the input messages and B tokens for the completion".
  const gmi = /(\d+) tokens? from the input messages and (\d+) tokens? for the completion/i.exec(body);
  if (gmi) return ok(window, Number(gmi[1]), Number(gmi[2]));

  // OpenRouter: "(1000 of text input, 900 of tool input, 32768 in the output)". Every "of … input"
  // part counts against the prompt (text, tool, image).
  const orOut = /(\d+) in the output/i.exec(body);
  if (orOut) {
    const ins = [...body.matchAll(/(\d+) of [a-z ]{0,20}?input/gi)].map((m) => Number(m[1]));
    if (ins.length) return ok(window, ins.reduce((a, b) => a + b, 0), Number(orOut[1]));
  }

  // OpenAI: "(1232 in the messages, 32768 in the completion)", sometimes with "N in the functions".
  const oai = /\(([^)]*?(\d+) in the completion)\)/i.exec(body);
  if (oai) {
    const ins = [...oai[1]!.matchAll(/(\d+) in the (?!completion)\w+/gi)].map((m) => Number(m[1]));
    if (ins.length) return ok(window, ins.reduce((a, b) => a + b, 0), Number(oai[2]));
  }
  return null;
}

/** The most an unasked output cap grows to after replies hit it. */
export const OUTPUT_CAP_MAX = 131_072;

/**
 * A 400 that refuses the `max_tokens` field itself, as opposed to its value.
 * Narrow on purpose: it must name the field and say it is unsupported.
 */
export function refusedMaxTokens(body: string): boolean {
  return /max_tokens/i.test(body) && /unsupported|not supported|unrecognized|unknown (field|parameter)|extra inputs are not permitted|use 'max_completion_tokens'/i.test(body);
}

/** Room left between the prompt and the window, kept free of the completion reserve. */
export const COMPLETION_MARGIN = 256;
/** A completion cap below this is no reply worth asking for; the prompt is what has to shrink. */
export const MIN_COMPLETION = 1_024;

/**
 * The completion cap that fits, when lowering it alone fixes the overflow:
 * the window less the input and a margin. Null when even the smallest useful
 * reply does not fit (the history is the problem, and shedding is the fix).
 */
export function fittedCompletion(o: { window: number; input: number; completion: number }): number | null {
  const fit = o.window - o.input - Math.max(COMPLETION_MARGIN, Math.round(o.window * 0.01));
  return fit >= MIN_COMPLETION && fit < o.completion ? fit : null;
}

/** The cap tried once when a window refusal names no counts molt can read. */
export const FALLBACK_COMPLETION = 8_192;

/**
 * A smaller cap to try before shedding, for a window refusal whose wording
 * completionOverflow does not know.
 *
 * Maat always sends max_tokens now, and a server that counts it against the
 * window refuses in its own words. Shedding cannot fix a reserve overflow, so
 * when the refusal is about the context or the length and the cap sent was
 * large, one request with a smaller cap is cheaper than ending a turn "with
 * nothing left to shed". `inputEst` is molt's scaled estimate of the prompt,
 * used when the server named a window but no prompt count. Null when the
 * prompt itself is known not to fit (shed instead), when the cap is already
 * small, or when the body is not about the window at all.
 */
export function reserveFallback(body: string, cap: number, inputEst: number): number | null {
  if (cap <= FALLBACK_COMPLETION || completionOverflow(body)) return null;
  const over = contextOverflow(body);
  if (!over && !(/context|length/i.test(body) && /tokens?/i.test(body))) return null;
  if (!over || over.window <= 0) return FALLBACK_COMPLETION;
  const input = over.sent > 0 ? over.sent : inputEst;
  const fit = over.window - input - Math.max(COMPLETION_MARGIN, Math.round(over.window * 0.01));
  if (fit < MIN_COMPLETION) return null;
  return Math.min(fit, Math.floor(cap / 2));
}

export function contextOverflow(body: string): Overflow | null {
  // Overflow wording, not the bare word "context": a pinned OpenRouter provider
  // answered a rate-limit retry with a 400 that merely mentioned context, and a
  // 2,476-token request was shed to nothing and the run ended (2026-10-07).
  if (
    !/n_ctx|too many tokens|maximum context length|context (length|window|size)|exceeds? (the )?(available |maximum )?context|context.{0,40}(exceed|too (long|large))|prompt is too long|request too large/i.test(
      body,
    )
  )
    return null;
  // Where the server split the prompt from the completion, the prompt's count
  // is what molt's estimate is compared with. Never the output count: current
  // vLLM puts that first ("you requested 32768 output tokens and your prompt
  // contains 1000"), and reading it as the prompt scaled every estimate 8x.
  const co = completionOverflow(body);
  if (co) return { window: co.window, sent: co.input };
  // Every field the common servers use, most specific first.
  const win =
    /"n_ctx"\s*:\s*(\d+)/.exec(body) ??
    /context size \((\d+)\s*tokens?\)/i.exec(body) ??
    /maximum context length (?:is|of) (\d+)/i.exec(body) ??
    // Anthropic: "prompt is too long: 210000 tokens > 200000 maximum".
    /tokens? > (\d+) maximum/i.exec(body);
  const sent =
    /"n_prompt_tokens"\s*:\s*(\d+)/.exec(body) ??
    /request \((\d+)\s*tokens?\)/i.exec(body) ??
    /prompt is too long:\s*(\d+)/i.exec(body) ??
    /your (?:prompt contains|request has|messages resulted in) (\d+)/i.exec(body) ??
    /you requested (?:a total of |about )?(\d+)(?!\d)(?! output)/i.exec(body);
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
/**
 * The longest one sealed check may run once the turn's clock has run out. The
 * runner kills the process a minute after `--for`, and the bar is what the
 * verdict is made of: a check that needs more is retired as timed out.
 */
export const DEADLINE_CHECK_CAP_MS = 40_000;
/**
 * How many empty assistant turns to ask through before treating one as a
 * claim of completion.
 *
 * Two, because the failure it covers is a dropped turn rather than a decision:
 * session 0581ccd8 step 11 came back with no text, no tool call and
 * `finish_reason: stop`, molt read that as "I am finished", and a 26-second
 * bar ran to establish that nothing had happened. Asking again is one cheap
 * request. Asking forever would be a hang, so the third one is allowed to mean
 * what molt used to assume the first one meant.
 */
export const EMPTY_TURN_RETRIES = 2;

/**
 * How many replies that imitate a tool call in text are sent back before one
 * is let through to the bar.
 *
 * The same shape as EMPTY_TURN_RETRIES. A model that writes
 * `<tool_call>{"name": "write_file", …}</tool_call>` into its reply, or a
 * `[Tool result]` it made up, and then "Done", has run nothing — the provider
 * returned no tool call — and molt used to read that as a finished claim and
 * spend the bar on an unchanged tree. Telling it costs one request. Telling it
 * forever would be a hang, and the detector can be wrong about a reply that
 * only quotes a call, so after two the reply goes to the bar, which is the
 * thing that decides whether work happened.
 */
export const NARRATED_CALL_RETRIES = 2;

/**
 * How many times a reply cut off at the output ceiling is asked to continue
 * before molt reads it as the answer.
 *
 * The same shape as EMPTY_TURN_RETRIES and for the same reason: a truncated
 * reply is not a decision to stop, so asking again is worth one request — but
 * a model that keeps running out of room must not loop for ever, and what it
 * has written by then is what there is.
 */
export const TRUNCATED_TURN_RETRIES = 2;
/**
 * Consecutive dry steps before molt says so IN THE TRANSCRIPT rather than only
 * on screen.
 *
 * The per-call pointer already tells the model that one call repeated. What it
 * never told the model was that the whole step did, four steps running — that
 * escalation was a `kind: "info"` event, which reaches the user's screen and
 * no part of the conversation. So the human watching session 0581ccd8 could
 * see it was looping and the only party able to stop it could not.
 */
export const DRY_STREAK_NUDGE = 3;
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

/**
 * Consecutive low-hit steps before molt says the cache has gone.
 *
 * Three, because one is noise: a real session read 67%, 4%, 0%, 0%, 51%, 0%,
 * 0%, 80% with an append-only prefix and nothing molt did in between. A
 * warning that fires on the first dip tells the reader to abandon a session
 * that is working.
 */
export const CACHE_LOST_STREAK = 3;

export const NETWORK_RETRIES = 3;
export const NETWORK_BACKOFF_MS = [500, 2_000, 5_000];

/**
 * Retries for a provider that said it is overloaded or rate-limited.
 *
 * A separate, longer budget, because the network policy above is sized for a
 * blip and an overload is not a blip: on a free OpenRouter model half of all
 * requests came back "Upstream error: Service temporarily overloaded", in
 * runs that last seconds to a minute. Four tries inside eight seconds lose a
 * thirty-step task to the provider about half the time; this waits it out
 * for a little over two minutes before giving up.
 */
export const OVERLOAD_RETRIES = 8;
export const OVERLOAD_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 20_000, 30_000, 30_000, 30_000];

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

/**
 * A provider error that arrived inside a 200 response (see StreamChunk.error),
 * as the request failure it is. Whatever partial message came with it is
 * dropped by the caller: the retry replays the request from the start.
 */
function providerFailure(e: ProviderError): { text: string; why: string; retryable: boolean; overload?: boolean } {
  const resetAt = rateLimitResetAt({ error: e });
  if (resetAt !== undefined && resetAt - Date.now() > LONG_RATE_LIMIT_MS) {
    return {
      text: `the provider's rate limit is reached ${untilText(resetAt)} — ${providerErrorText(e)}`,
      why: "The provider will not take requests again until its limit resets; waiting inside a turn cannot get past it.",
      retryable: false,
    };
  }
  const transient = transientProviderError(e);
  return {
    text: providerErrorText(e),
    why: "The provider reported an error instead of an answer.",
    retryable: transient,
    ...(transient ? { overload: true } : {}),
  };
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
      name: "inspect",
      description:
        "Look at a file as bytes before writing code against it: encoding and BOM, line endings " +
        "(CRLF/LF/mixed), final newline, trailing whitespace, non-ASCII and control characters, a hex " +
        "dump, and for CSV/TSV/JSON/logs the oddities a grader checks — rows with a different field " +
        "count, empty or padded values, values that differ only by case, mixed types, rare line shapes. " +
        "On a directory, one line per file. Read-only.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number", description: "First byte of the hex dump (default 0)." },
          length: { type: "number", description: "Bytes to dump (default 128 for text, 256 for binary; at most 4096)." },
        },
        required: ["path"],
      },
    },
  },
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
      description:
        "Run a shell command. It already starts in the project directory — never cd " +
        "there first. Use list_dir and grep instead of ls/grep/find. Never change a " +
        "file through the shell (sed -i, perl -pi, cat >, a python or node script that " +
        "writes files): use edit_file or write_file, which Maat records and can check; " +
        "a change made through the shell is invisible to the record and asks for " +
        "approval every time. " +
        "Waits for exit; the result reports how long it took. A command that needs " +
        "longer than the default timeout must say so with timeout_s. To start a server " +
        "or watcher and keep working, set background=true: it runs in its own process " +
        "group, its output goes to a log file you can read_file, and the call returns " +
        "at once.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          commands: {
            type: "array",
            items: { type: "string" },
            description:
              "Several commands to run in order, stopping at the first that fails — " +
              "use this instead of one call per command whenever you do not need to " +
              "read one command's output before writing the next.",
          },
          timeout_s: {
            type: "number",
            description: "Seconds before the command is killed. Default 60; at most 1800.",
          },
          background: {
            type: "boolean",
            description: "Start it and return immediately. Output goes to .maat/bg/<job>.log.",
          },
          stop_job: {
            type: "number",
            description: "Stop a background job by its number instead of running command.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan",
      description:
        "Keep a short numbered plan. Send the whole list each time; `current` is the " +
        "0-based step you are on (earlier steps are done). Costs nothing and runs nothing; " +
        "it is a note to yourself that survives long work. Use it for tasks of more than " +
        "three steps, and update it as you finish each one.",
      parameters: {
        type: "object",
        properties: {
          steps: { type: "array", items: { type: "string" } },
          current: { type: "number", description: "Index of the step in progress." },
        },
        required: ["steps"],
      },
    },
  },
] as const;

/** The most a single `bash` call may ask to wait. Longer is a background job. */
export const MAX_BASH_TIMEOUT_MS = 30 * 60_000;

/**
 * A plan, as the model reads it back.
 *
 * Done steps are crossed off, the current one is marked, the rest are
 * pending. The marking leans on recency bias: the last thing in the result is
 * the next thing to do.
 */
export function renderPlan(steps: string[], current: number): string {
  const cur = Number.isFinite(current) ? Math.max(0, Math.min(steps.length, Math.floor(current))) : 0;
  const lines = steps.map((s, i) => {
    const mark = i < cur ? "[x]" : i === cur ? "[>]" : "[ ]";
    return `${mark} ${i + 1}. ${s}`;
  });
  const done = Math.min(cur, steps.length);
  const tail =
    done >= steps.length
      ? "all steps done — verify, then answer"
      : `${done}/${steps.length} done · now: ${steps[cur]}`;
  return `${lines.join("\n")}\n${tail}`;
}

const TOOL_SCHEMA_JSON = JSON.stringify(TOOLS);

/**
 * Batch mode's one tool: a plan and a list of actions, every reply.
 *
 * The reference Terminal-Bench agent never offers native one-at-a-time tool
 * calls: every reply must be a JSON object with an analysis, a plan and a
 * list of commands, so a batch is the only thing a model can send. molt took
 * a median 22-30 model round trips per task where it took 9, and asking the
 * model to batch — in the prompt, in the tool descriptions, with a list form
 * of bash — did not change that at all. The shape of the only tool does.
 *
 * Each action is one of molt's ordinary tools with its ordinary arguments,
 * expanded into ordinary calls when the reply arrives: the approval gate, the
 * ledger, repeat detection and the checks see exactly what they always see.
 * The model gets one combined result back for its one call.
 */
export const ACT_TOOL = {
  type: "function",
  function: {
    name: "act",
    description:
      "Your only tool. Each reply: say what you know, your plan, and every action you can " +
      "take before you need to see a result — a batch, run in order. Actions use Maat's " +
      "tools: read_file, write_file, edit_file, list_dir, grep, bash, plan, with those " +
      "tools' usual arguments. Send an empty actions list when the work is finished, with " +
      "your answer in analysis.",
    parameters: {
      type: "object",
      properties: {
        analysis: { type: "string", description: "What you know now, from the results so far." },
        plan: { type: "string", description: "What these actions are for, and what comes next." },
        actions: {
          type: "array",
          description:
            'In order. Each is {"tool": name, "args": {...}}, e.g. {"tool":"bash","args":{"command":"ls"}}.',
          items: {
            type: "object",
            properties: { tool: { type: "string" }, args: { type: "object" } },
            required: ["tool", "args"],
          },
        },
      },
      required: ["analysis", "actions"],
    },
  },
} as const;

/** Said in the system prompt in batch mode. */
export const BATCH_PROMPT = [
  "Batch mode: you have one tool, act. Every reply calls it once with ALL the",
  "actions you can take before you need to see a result — read the three files,",
  "run the build and the test, write both files — not one action per reply. Each",
  "reply is a round trip that resends the whole conversation. When the work is",
  "finished, call act with an empty actions list and your answer in analysis.",
  "",
  "A first reply usually looks like this — several actions, one call:",
  'act({"analysis": "Nothing inspected yet.", "plan": "See what is here and how it builds.",',
  '     "actions": [{"tool": "list_dir", "args": {"path": ".", "depth": 2}},',
  '                 {"tool": "read_file", "args": {"path": "README.md"}},',
  '                 {"tool": "bash", "args": {"command": "git log --oneline -5; python3 --version"}}]})',
  "and a later one: edit two files and run the test that covers them, in one call.",
].join("\n");

type ActSub = { id: string; name: string; rawArgs: string; label: string };

/**
 * An `act` call as the ordinary calls it stands for, or null when it is not
 * one (a malformed act falls through and is reported as malformed).
 */
export function expandAct(call: { id: string; function?: { name?: string; arguments?: string } }):
  | { analysis: string; subs: ActSub[]; unusable: number }
  | null {
  if (call.function?.name !== "act") return null;
  let a: { analysis?: unknown; plan?: unknown; actions?: unknown };
  try {
    a = parseLenient(call.function.arguments || "{}") as typeof a;
  } catch {
    return null;
  }
  if (!a || typeof a !== "object") return null;
  const analysis = [a.analysis, a.plan].filter((x) => typeof x === "string" && x.trim()).join("\n\n");
  // Models drift from the schema in a few common, unambiguous ways, and on a
  // long write the drift cost the write itself: Nemotron sent an act whose
  // actions were not the {tool, args} array, nothing in it was read as an
  // action, and an act with no actions is the "finished" signal — so a reply
  // writing clean.csv became a claim with nothing on disk. Read the shapes
  // whose meaning is not in doubt: actions as a JSON string, one action
  // object instead of a list, name/function/tool_name for tool, and
  // arguments/input/parameters (object or JSON string) for args.
  let raw: unknown = a.actions;
  if (typeof raw === "string") {
    try {
      raw = parseLenient(raw);
    } catch {
      /* left as is: counted as unusable below */
    }
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const subs: ActSub[] = [];
  let unusable = typeof raw === "string" && raw.trim() !== "" && raw.trim() !== "[]" ? 1 : 0;
  list.forEach((x, k) => {
    if (!x || typeof x !== "object") {
      unusable += 1;
      return;
    }
    const o = x as Record<string, unknown>;
    const fn = o.function && typeof o.function === "object" ? (o.function as Record<string, unknown>) : undefined;
    const tool = [o.tool, o.name, o.tool_name, fn?.name, typeof o.function === "string" ? o.function : undefined].find((t) => typeof t === "string" && t.trim()) as string | undefined;
    if (!tool) {
      unusable += 1;
      return;
    }
    let given: unknown = [o.args, o.arguments, o.input, o.parameters, fn?.arguments].find((v) => v !== undefined);
    if (typeof given === "string") {
      try {
        given = parseLenient(given);
      } catch {
        unusable += 1;
        return;
      }
    }
    const args = given && typeof given === "object" && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
    subs.push({
      id: `${call.id}~${k}`,
      name: tool,
      rawArgs: JSON.stringify(args),
      label: `${tool} ${toolDetail(tool, args)}`.slice(0, 160),
    });
  });
  return { analysis, subs, unusable };
}

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
   * `.maat/done.yml` is deliberately per-project and deliberately not read
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
   * More criteria, still being drafted when the turn starts. The model may
   * read (read_file, list_dir, grep, inspect, read-only bash) while they are
   * drafted; the first call that changes anything — and the first claim —
   * waits until they are sealed, so they still predate every change. The
   * drafter sees only the task text, never the transcript. Drafting took a
   * median 17 s of every local task, all of it before the first step.
   */
  pendingCriteria?: Promise<{ taskChecks: Check[]; taskNotes: string[]; requirements?: string[] }>;
  /**
   * What of `pendingCriteria` is ready now — the checks that passed review so
   * far. With a time budget the wait for the full draft is bounded
   * (criteriaWaitMs); when it runs out these are sealed instead.
   */
  criteriaSoFar?: () => Promise<{ taskChecks: Check[]; taskNotes: string[]; requirements?: string[] }>;
  /** Overrides criteriaWaitMs(budget). Tests only. */
  criteriaWaitMs?: number;
  /**
   * An independent reference check, still being written (src/reference.ts).
   * Built from the task text and a snapshot of the project taken before the
   * first step, so it may join the sealed checks at a claim without the work
   * having had any say in it. Null when none applies.
   */
  referenceCheck?: Promise<{ check: Check; note: Record<string, unknown> } | null>;
  /** Overrides referenceWaitMs. Tests only. */
  referenceWaitMs?: number;
  /** Overrides how long a claim waits for checks still drafting after the time budget's cut. Tests only. */
  lateCriteriaWaitMs?: number;
  /**
   * The drafter's inputs, frozen before the first step (criteria.ts
   * drafterSnapshot): `sha` is their hash, `used` the hash each drafter stage
   * computed over what it actually put in its prompt. When every stage used
   * the snapshot, the drafts are independent of the work, and a claim of done
   * may wait for them until the time budget's safety margin
   * (claimWaitForDraftsMs). A mismatch means a stage read the folder the work
   * changed: its checks are not joined.
   */
  draftInputs?: { sha: string; used: () => string[] };
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
  /**
   * The task's stated requirements, verbatim (src/signout.ts), kept with the
   * sealed criteria. Unattended, the first claim is held once while each is
   * paired with the commands the model ran for it. Empty or absent: nothing
   * happens.
   */
  requirements?: string[];
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

/**
 * Would this call change anything? Reading tools never do; a bash command
 * does unless it is plainly read-only. Used to let a model read while its
 * task's checks are still being drafted, and to seal them before its first
 * change.
 */
export function changesSomething(name: string, rawArgs: string): boolean {
  if (name === "read_file" || name === "list_dir" || name === "grep" || name === "inspect" || name === "plan") return false;
  if (name !== "bash") return true;
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch {
    return true;
  }
  if (a.background === true || a.stop_job !== undefined) return true;
  const cmds = typeof a.command === "string" ? [a.command] : Array.isArray(a.commands) ? a.commands.map(String) : [];
  return cmds.length === 0 || !cmds.every((c) => isReadOnlyCommand(c));
}

/**
 * The grace a closing summary gets past the deadline: a tenth of the budget,
 * between 1 s and 30 s. The summary is a courtesy; a run given 540 s must not
 * spend another five minutes on it (or an hour, on a backend that hangs).
 */
export function deadlineGraceMs(budgetMs: number): number {
  return Math.min(30_000, Math.max(1_000, Math.round(budgetMs / 10)));
}

/**
 * How long a turn with a time budget waits for its drafted checks before
 * sealing what is ready: a tenth of the budget, between 45 s and 2 min. No
 * budget, no bound — a person at the keyboard can wait.
 */
export function criteriaWaitMs(budgetMs: number): number | undefined {
  if (!budgetMs) return undefined;
  return Math.min(120_000, Math.max(45_000, Math.round(budgetMs / 10)));
}

/**
 * How long a claim waits for a reference check still being written: up to five
 * minutes with no time budget, else a quarter of what is left, at most three.
 * Not ready by then, the claim is judged without it, and the next claim looks
 * again.
 */
export function referenceWaitMs(timeLeftMs: number | undefined): number {
  if (timeLeftMs === undefined) return 300_000;
  return Math.max(0, Math.min(180_000, Math.round(timeLeftMs / 4)));
}

/**
 * How long a claim waits for drafted checks that were cut with none ready:
 * they are the only thing that can make the claim verifiable, so they get most
 * of what is left (60%, leaving the rest for running the bar), at most two
 * minutes; with no time budget, two minutes.
 */
export function lateCriteriaWaitMs(timeLeftMs: number | undefined): number {
  if (timeLeftMs === undefined) return 120_000;
  return Math.max(0, Math.min(120_000, Math.round(timeLeftMs * 0.6)));
}

/**
 * How long a claim of done waits for drafted checks still on their way, when
 * the drafter's inputs are known to be sealed before the work (RunOptions
 * .draftInputs): until what is left of the time budget, less a margin for
 * running the checks and the review — the larger of 60 s and 15% of the
 * budget. Never shorter than lateCriteriaWaitMs. A separate judge (Grok at
 * 170–300 s, a local model past 6 min) routinely finished after the fixed
 * two minutes, and correct work was labelled unverified. No budget, the old
 * two minutes.
 */
export function claimWaitForDraftsMs(timeLeftMs: number | undefined, budgetMs: number): number {
  const floor = lateCriteriaWaitMs(timeLeftMs);
  if (timeLeftMs === undefined || !budgetMs) return floor;
  const margin = Math.max(60_000, Math.round(budgetMs * 0.15));
  return Math.max(floor, timeLeftMs - margin);
}

/**
 * A hash of everything the drafter reads: the task text and the project's file
 * listing before the first step. Journalled at turn start and again when late
 * checks join, so "written without sight of the work" is two equal lines in
 * the record rather than a promise.
 */
export function draftInputsHash(task: string, listing: ProjectListing | null): string {
  const h = createHash("sha256");
  h.update(task, "utf8");
  h.update("\0files\0" + [...(listing?.files ?? [])].sort().join("\n"));
  h.update("\0dirs\0" + [...(listing?.dirs ?? [])].sort().join("\n"));
  return h.digest("hex").slice(0, 16);
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

/**
 * What to do with the working tree once the bar has answered — the second
 * half of `autoresearch`'s loop, with molt's bar as the judge.
 */
/**
 * What a write to a pinned file says.
 *
 * Names the pin rather than the file system, because the model has done
 * nothing wrong and the useful next move is to say what it wanted to change
 * — not to retry, and not to route around it with `bash`.
 */
export function readOnlyRefusal(path: string): string {
  return (
    `write refused: ${path} is pinned read-only for this session. It can be read, not ` +
    `changed. Do not work around this with another tool — say what you would have ` +
    `changed there and why, and continue with the rest.`
  );
}

export type GitPolicy = {
  /** Commit what the bar verified, with the receipt in the message. */
  commitOnPass?: boolean;
  /** Put back the files this turn wrote when the bar was not met. */
  restoreOnFail?: boolean;
};

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
   * How an ACP agent's process is started, injected.
   *
   * Only tests pass one. Left out, `AcpSession` spawns the real `grok`, which
   * is the only way a test could spend a real subscription's quota. Every
   * test that drives the backend supplies a scripted agent here instead.
   */
  acpSpawn?: typeof import("node:child_process").spawn;
  /**
   * Response ceiling for protocols that demand one. Anthropic's Messages API
   * requires `max_tokens`; the OpenAI shape treats it as optional.
   */
  maxTokens?: number;
  /**
   * How hard a reasoning model may think before it answers: `none`, `low`,
   * `medium`, `high`. Sent as OpenRouter's `reasoning: { effort }` on the
   * OpenAI-shaped request, and only when set — a server that does not know the
   * field may refuse the request, so it is never sent unasked.
   *
   * Exists because of Space Bunny Alpha: at its default effort it spent 8,000
   * tokens reasoning about three shell checks and never wrote them, and the
   * OpenAI-shaped request carries no `max_tokens`, so a turn could think to
   * the model's 524k ceiling. At `low` it answered in 716 tokens.
   */
  reasoningEffort?: string;
  /**
   * The effort for every request after the checks refused a claim this turn.
   *
   * A refusal is the point where more thinking is known to be needed: the
   * cheap first try did not do it. Raising effort for the whole turn slows
   * every step and turns hard tasks into timeouts (LangChain measured maximum
   * reasoning scoring 10 points under "high" on Terminal-Bench 2.0 for exactly
   * that reason); raising it only after a refusal spends it where it pays.
   */
  retryReasoningEffort?: string;
  /**
   * When the turn's own drafted (hidden) checks fail the same way twice, show
   * the model those checks' commands once and let it go on — fix the work or
   * dispute the check — instead of stopping. On Terminal-Bench that stop came
   * with right work 34 times and wrong work 33: a coin flip, a fifth of tasks,
   * and locally it ended runs whose check was right and whose work the model
   * could still have fixed. OFF unless `true` (`--reveal-stuck`): as the default
   * it cost 7 tasks of 60 on Mercury by letting the model bend correct work to
   * wrong checks (see the proof loop). A claim that
   * then passes carries `revealed`, and a later write to a path the task names
   * as an input, or to one DISPUTE_HINT forbids, refuses it (bentAfterReveal).
   */
  revealOnStuck?: boolean;
  /**
   * Experimental (`--review-advisory`, MAAT_REVIEW_ADVISORY=1): the independent
   * review is recorded and shown but gates nothing — no nudge, no demotion —
   * and "verified" instead needs a passing drafted runs+value check that
   * failed before the work (tiers.ts `reviewAdvisory`). Off by default.
   */
  reviewAdvisory?: boolean;
  /**
   * Experimental (`--review-executable`, MAAT_REVIEW_EXECUTABLE=1): each
   * objection the independent review raises must carry a read-only shell
   * command that demonstrates it. Maat runs it on a throwaway copy of the tree;
   * an objection counts only when its command ran and showed the failure.
   * The rest are recorded as unsubstantiated notes and veto nothing
   * (src/review.ts). Off by default.
   */
  reviewExecutable?: boolean;
  /**
   * Opt-in (`--require-discriminating`, MAAT_REQUIRE_DISCRIMINATING=1):
   * "verified" needs a passing independent runs+value check that FAILED on
   * the tree before the work (tiers.ts `requireDiscriminating`); otherwise the
   * tier is passed-untested. Off by default: replayed over the 2026-10-07
   * lanes it removed 2 wrong verifieds and denied 10 right ones (precision
   * 18/22 -> 8/10). The cause is fixed at seal time instead (seal-time
   * redraft of checks that pass before the work). `reviewAdvisory` implies it.
   */
  requireDiscriminating?: boolean;
  /**
   * Opt-in (`--post-work-audit`, MAAT_POST_WORK_AUDIT=1): when a claimed turn
   * is not verified by the checks sealed before the work, an independent
   * judge drafts checks from the task text and an interface view of the work
   * (never its transcript, claim or outputs), and one that passes on the work,
   * fails before it and fails on a mutant of the changed code earns
   * "verified (post-work audit: <judge>)", tier `verified-audit`
   * (src/post-audit.ts). Needs a judge that is not the worker model.
   */
  postWorkAudit?: boolean;
  /**
   * Requirement sign-out (src/signout.ts): one round per unattended turn that
   * lists each stated requirement beside the commands run for it. Off unless
   * `true` (`--signout`): it fired 60 times in one measured set of runs and
   * rescued no task, while doubling steps and pushing input tokens to 97-116k.
   */
  signOut?: boolean;
  /**
   * Who rules on a DISPUTE line (src/dispute.ts), and how many asks. One ask
   * unless `votes` says more (`--dispute-votes`). `model` / `baseUrl` name an
   * arbiter other than the worker (`--arbiter-model`). With none, or the same
   * baseUrl and model as the worker, the dispute is rejected without asking:
   * 0 of 20 were upheld, ten of those trees passed the grader, and a model
   * ruling on its own misreading repeats it.
   */
  dispute?: { votes?: number; model?: string; baseUrl?: string; apiKey?: string };
  /**
   * Review a verified claim independently and label it (src/review.ts):
   * `votes` reviews of the task text and the receipt; a majority-backed,
   * task-quoted violation makes the claim "passed its checks, unconfirmed".
   * A label, never a gate — the turn's outcome and the work are untouched.
   * Off unless set.
   */
  review?: { votes?: number; reasoningEffort?: string };
  /**
   * Open a judgment case for every job the scale could not settle
   * (judgment.ts). On unless set to false — benchmark runs, where no person
   * will ever rule, turn it off.
   */
  judgment?: boolean;
  /**
   * The step ceiling for one turn, in place of MAX_STEPS. 0 means none.
   *
   * MAX_STEPS is a loop guard sized for a chat session. On Terminal-Bench a
   * task that needed forty tool calls was stopped at thirty-two with the work
   * half done, at 350k tokens — money spent for nothing, which is what a
   * ceiling in the wrong place does. A benchmark bounds a turn by tokens and
   * by wall clock and sets this high; nobody else needs to touch it.
   */
  maxSteps?: number;
  /**
   * Batch mode: the model's only tool is `act`, a plan and a list of actions
   * every reply (ACT_TOOL). For models that will not batch on request. HTTP
   * endpoints only — a subscription CLI brings its own loop.
   */
  batch?: boolean;
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
  /**
   * Project-level integrity ledger binding the journal, receipts, and exuviae
   * into one cross-linked chain with a shippable root of trust. Optional: no
   * ledger, no cross-link — but the other evidence is still recorded.
   */
  integrity?: Integrity;
  /**
   * What molt does with the tree once the bar has answered.
   *
   * Off unless asked for. Committing and reverting are both things a person
   * expects to be in charge of, and a tool that started doing either because
   * it was installed would be a tool people stop installing.
   */
  git?: GitPolicy;
  /**
   * A wall-clock ceiling for one turn, in milliseconds.
   *
   * The other two ceilings — tokens and money — measure what a turn consumes.
   * This measures what it costs the person waiting for it, which is the limit
   * `autoresearch` runs on: a fixed five minutes per attempt, then the judge
   * runs whatever state the work is in. A turn that is going to take twenty
   * minutes is usually a turn that has gone wrong, and the useful moment to
   * find that out is at minute five.
   */
  turnDeadlineMs?: number;
  /**
   * How long a model request may go without receiving a byte before it is
   * abandoned as hung and retried. Not a limit on the answer: every byte that
   * arrives resets it. Unset means `MOLT_REQUEST_IDLE_MS`, then
   * REQUEST_IDLE_MS (src/watchdog.ts); 0 turns it off.
   */
  requestIdleMs?: number;
  /**
   * Silence from a subprocess (ACP) backend, in ms, after which its provider
   * is taken to have stalled and the turn ends as a provider issue. Unset
   * means `MAAT_BACKEND_STALL_MS`, then BACKEND_STALL_MS (src/acp.ts); 0
   * turns it off.
   */
  backendStallMs?: number;
  /**
   * The allowance before a request's first byte, overriding the one scaled
   * from the prompt and output sizes (see firstByteMs in src/watchdog.ts).
   * For a server whose speed is known, and for tests.
   */
  requestFirstByteMs?: number;
  /** How long `doctor` and `listModels` wait on `/models`. PROBE_TIMEOUT_MS unless set; 0 is none. */
  probeTimeoutMs?: number;
  /**
   * A map of the repository, added to the system prompt. Built by the caller
   * (it walks the disk, which the constructor must not) and paid for once,
   * inside the cached prefix.
   */
  repoMap?: string;
  /** Paths the model may read but must never write. */
  readOnly?: string[];
  /**
   * The environment brief (src/brief.ts), added to the system prompt beside
   * the map. Built by the caller for the same reason the map is: it probes
   * the machine, which the constructor must not.
   */
  brief?: string;
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
  /**
   * Nobody is watching. Adds one paragraph to the system prompt saying so.
   *
   * A headless run has no one to answer a question, and a model that ends
   * its turn on "which would you prefer?" has ended the job with nothing
   * done. Told up front, it decides, states the assumption, and continues —
   * which is what a person running `molt run` in CI, or a benchmark harness
   * with a fifteen-minute clock, actually wants.
   */
  unattended?: boolean;
  /**
   * The machine is disposable.
   *
   * `--sandbox`. The project boundary becomes the machine: a task that says
   * "write the config to /etc/nginx/conf.d" or "save it to /tmp/out" is done
   * where it says. Nothing else changes here — what asks still asks, and the
   * caller decides what to do with the question. A benchmark container is the
   * case this exists for, and it is off everywhere else.
   */
  sandbox?: boolean;
  /**
   * Unattended: tool calls in a row that change no file in the project before
   * the model is told to finish or stop; as many again and the turn ends,
   * judged on disk ("no-progress"). 0 turns the guard off. Default:
   * MAAT_NO_PROGRESS_CALLS, else 30 (src/scope.ts).
   */
  noProgressCalls?: number;
  /**
   * Where to write one JSON file per completion attempt holding the whole
   * turn: the wire transcript, the ledger, the bar's result, the receipt name.
   *
   * The journal deliberately records no message content, and receipts hold
   * the claim but not the conversation that led to it — so the record molt
   * keeps by default cannot train a model to predict a verdict from what the
   * model saw. This is the opt-in that can. Redacted like everything else
   * molt writes; off unless asked for, because a full transcript on disk is
   * exactly the file that quietly accumulates credentials.
   */
  captureDir?: string;
  /**
   * Where file reads and writes go, when not straight to disk.
   *
   * An editor driving molt over ACP holds the files the person is looking at
   * in buffers, some with changes not yet saved. Writing past it to disk
   * clobbers those changes or leaves the buffer stale; reading past it gives
   * the model a file the person is no longer looking at. So a surface that has
   * the editor's buffers supplies these, and molt goes through them.
   *
   * The ledger still records what is on DISK afterwards, because that is what
   * the bar reads: an editor that reformats on save changes the file molt
   * wrote, and a hash of the text molt sent would then disagree with the tree.
   * Either function may throw; molt then does the operation on disk itself.
   */
  files?: FileAccess;
};

export type FileAccess = {
  read?: (absPath: string) => Promise<string>;
  write?: (absPath: string, content: string) => Promise<void>;
};

/**
 * `bash {commands: [...]}` as one script: each command on its own line under
 * `set -e`, so they run in order and stop at the first failure — what a person
 * typing them one after another would see, in one round trip instead of one
 * per command. The reference Terminal-Bench agent's protocol is a list of
 * commands per turn, and that shape, not the model, is why it needed a third
 * of molt's round trips. Every line is still a line the autonomy gate reads.
 */
export function foldCommands(args: Record<string, unknown>, cwd: string): void {
  if (Array.isArray(args.commands)) {
    const list = args.commands
      .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      .map((c) => stripCwdPrefix(c, cwd));
    if (list.length && typeof args.command !== "string") {
      args.command = list.length === 1 ? list[0] : ["set -e", ...list].join("\n");
    }
    delete args.commands;
  }
  if (typeof args.command === "string") args.command = stripCwdPrefix(args.command, cwd);
}

/**
 * A command without a leading `cd` into the directory it already runs in.
 *
 * Only an exact match of the working directory, quoted or not, followed by
 * `&&` or `;`, is removed. `cd` anywhere else, into anything else, is left.
 */
export function stripCwdPrefix(command: string, cwd: string): string {
  const esc = cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\/+$/, "");
  const re = new RegExp(`^\\s*cd\\s+(?:"${esc}/?"|'${esc}/?'|${esc}/?)\\s*(?:&&|;)\\s*`);
  const out = command.replace(re, "");
  return out.trim() ? out : command;
}

/** A command shorter than this reports no duration; nobody plans around 300ms. */
export const SLOW_COMMAND_MS = 2_000;

function fmtSeconds(ms: number): string {
  const s = ms / 1000;
  return s >= 60 ? `${(s / 60).toFixed(1)}m` : `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
}

function exitWord(e: { code: number | null; signal: string | null }): string {
  return e.code !== null ? `with exit ${e.code}` : `on ${e.signal ?? "a signal"}`;
}

/**
 * The environment the worker's commands get: no credential of any shape
 * (src/secrets.ts). Normally `captureSecrets()` has already emptied
 * process.env of them at startup; this covers a library caller that did not.
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  return scrubEnv(process.env);
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

/**
 * The checks that failed because they never ran.
 *
 * When every unmet check is one of these, another attempt is not a second
 * chance — it is spending a model's tokens on a command that does not exist.
 * A real session did exactly that: a sealed criterion grepped a file that was
 * not there, grep exited 2, and the model spent its attempts trying to make
 * the error go away by creating the file. Nothing was verified, and the run
 * ended having taught the model to satisfy a typo.
 */
function brokenChecks(result: BarResult): string[] {
  return result.results.filter((r) => !r.ok && !r.advisory && r.didNotRun).map((r) => r.name);
}

/** True when the bar is unmet and every unmet check is broken rather than failing. */
function onlyBrokenChecks(result: BarResult): boolean {
  const failed = result.results.filter((r) => !r.ok && !r.advisory);
  return failed.length > 0 && failed.every((r) => r.didNotRun === true);
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
  text: string,
  shown: string,
  offset: number,
  limit: number,
  cap = READ_MAX_BYTES,
): string {
  const raw = text.split("\n");
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

/**
 * What a write result says when the file on disk is not the text the model
 * sent — an editor formatted it on save. The model's next edit has to match
 * what is there, so it is told rather than left to find out by a failed edit.
 */
function reshaped(sent: string, landed: string): string {
  return sent === landed
    ? ""
    : ` [the editor reformatted it on save: the file now holds ${Buffer.byteLength(landed, "utf8")} ` +
        `bytes, not the ${Buffer.byteLength(sent, "utf8")} sent — read it before editing it again]`;
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

/**
 * `keep: "ends"` for a command, `"head"` for everything else.
 *
 * A model that runs `npm test` itself hits the same wall the bar hit: the
 * verdict is at the end of the output and the head is what survived. A grep
 * or a listing is a list, where the first N results are as good as any, so
 * those keep the head as before.
 */
function truncateResult(
  s: string,
  cap = TOOL_RESULT_MAX_BYTES,
  keep: "head" | "ends" = "head",
): { text: string; note?: string } {
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= cap) return { text: s };
  if (keep === "ends") {
    return { text: clipEnds(s, cap), note: `capped at ${cap}B (was ${bytes}B)` };
  }
  const cut = Buffer.from(s, "utf8").subarray(0, cap).toString("utf8");
  return {
    text: cut + `\n[molt: truncated ${bytes - cap} bytes]`,
    note: `capped at ${cap}B (was ${bytes}B)`,
  };
}

/** What one tool call needs to know about the turn it belongs to. */
type ToolContext = {
  step: number;
  userText: string;
  confirm: Confirm;
  log?: Journal;
  /** Line ranges of each file already shown, so a re-read can be named as one. */
  shown: Map<string, { from: number; to: number }[]>;
  /** The last result of each distinct call, so an identical one can be pointed at. */
  answered: Map<string, { step: number; sha: string }>;
};

/** What the step loop needs to know once a tool call is finished. */
type ToolOutcome = {
  name: string;
  /** What the model is told. Also what the transcript records. */
  result: string;
  /** True when autonomy let it run without asking. */
  auto: boolean;
  /** True when it returned something the model had already been given. */
  repeated: boolean;
};

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
   * The live ACP session (Grok Build), when that is the backend.
   *
   * One per molt session rather than per turn: the second message into a
   * streaming session read 2,200 tokens out of cache where the first wrote
   * 958 fresh ones, and a session per turn pays that back every time.
   */
  private cc?: BackendSession<EngineEvent>;
  /** The subscription backend's last running cost total; see the note it feeds. */
  private subscriptionCostSeen = 0;

  /**
   * The model a receipt names: what the backend confirms ran, not what was
   * asked for. An ACP agent that never received the choice ran its own
   * default while every receipt recorded the requested one.
   */
  private modelOfRecord(): string {
    return this.cc?.ranModel?.() ?? this.cfg.model;
  }
  /** The system prompt the live session was started with. */
  private ccSystem = "";
  /**
   * User messages the ACP agent has already been given.
   *
   * By identity, not by index. A cancelled turn rolls the transcript back and
   * a shed renumbers it; an object either was forwarded or was not.
   */
  private ccForwarded = new WeakSet<Msg>();
  /** The turn's tool context, read by the MCP handlers as each call arrives. */
  private ccCtx?: ToolContext;
  /**
   * The seal gate for a subprocess backend. The agent there makes its own tool
   * calls inside one step, so the check the native loop does between planning
   * and running (seal the drafted checks before the first change) has to run
   * here, per call, before the tool does. Set by `run()` for the turn.
   */
  private ccGate?: (name: string, args: Record<string, unknown>) => AsyncGenerator<EngineEvent>;
  /**
   * Tools are shut for the rest of this turn.
   *
   * The HTTP salvage says `tool_choice: "none"` in a request body. There is
   * no request body here, so the promise the salvage prompt makes — "you
   * cannot call any more tools" — is kept at the seam every tool call on this
   * backend already passes through, and a model that tries anyway is told no
   * rather than quietly allowed to go on spending a stopped turn.
   */
  private ccNoTools = false;

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
   * A model's own output maximum, once it has told molt what it is.
   *
   * Held apart from `cfg.maxTokens` rather than overwriting it: what the user
   * asked for and what this model will accept are two different facts, and
   * folding them together loses the request the moment the model changes.
   * Sticky within a model, so a low ceiling costs one retry per session
   * rather than one per step.
   */
  private modelMaxTokens?: number;

  /**
   * The output cap this session settled on without being asked: the default
   * (DEFAULT_MAX_TOKENS, not the model's whole listed output), doubled each
   * time a reply is cut off at it, up to OUTPUT_CAP_MAX.
   */
  private outputCap = DEFAULT_MAX_TOKENS;
  /**
   * The completion reserve a server said fits its window beside the prompt
   * (completionOverflow). Kept until the history is shed: the prompt grows
   * between sheds, and after one there is room for a larger reply again.
   */
  private fittedCompletion?: number;
  /**
   * The fitted cap above was a guess (reserveFallback), not read from the
   * server's own counts. A reply that is cut off at a guess drops it.
   */
  private fittedGuessed = false;
  /** Set once a provider refuses `max_tokens` outright; it is then not sent. */
  private maxTokensUnsupported = false;

  /** What to send as `max_tokens`: what was asked for, bounded by what fits. */
  private maxTokensFor(): number {
    const asked = this.cfg.maxTokens ?? this.outputCap;
    return Math.min(asked, this.modelMaxTokens ?? Infinity, this.fittedCompletion ?? Infinity);
  }
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

  /**
   * Is the work being done by a CLI molt spawned, rather than by an HTTP
   * endpoint it posts to?
   *
   * Read off the endpoint, so it survives `/endpoint` switching mid-session
   * and cannot disagree with what the receipt records.
   *
   * One predicate for ACP backends, because everything downstream of it
   * asks the same question: there is no request body to put `tool_choice` in,
   * no `/models` to fetch, no token price to apply, and the context belongs to
   * the subprocess rather than to molt's transcript. Which CLI it is only
   * matters where the session is constructed and where health is reported.
   */
  /** The CLI's name, for a message a person reads. */
  private get backendLabel(): string {
    return acpAgentFor(this.cfg.baseUrl)?.label ?? "subscription CLI";
  }

  /** The tools this session offers the model. */
  private get offeredTools(): readonly unknown[] {
    return this.cfg.batch && !this.subprocess ? [ACT_TOOL] : TOOLS;
  }

  private get subprocess(): boolean {
    return isAcp(this.cfg.baseUrl);
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
  /** Consecutive steps that reused almost nothing. Reset by any real hit. */
  private lowCacheStreak = 0;
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
   * What each write did, by call id, until its `tool` event carries it out.
   * A surface that shows edits as diffs needs the before and after text, and
   * only runTool ever holds both.
   */
  private writeDiffs = new Map<string, FileDiff>();
  /**
   * What the model did this turn, one line each, in order.
   *
   * The receipt is read by someone asking "what did it do, and should I
   * believe it finished?" — and until now the answer to the first half was
   * nowhere in the document.
   */
  private did: string[] = [];
  /** This turn's requirement sign-out, for the receipt (src/signout.ts). */
  private turnSignOut: SignOut | undefined;
  /**
   * Tool calls made this turn, by id. The session ledger is keyed by call id,
   * so this is what tells a write this turn made from one an earlier turn did
   * — and `files-changed` needs to know, or a turn that changed nothing is
   * accepted on the strength of the last one that did.
   */
  private turnCalls = new Set<string>();
  /**
   * The working tree when this turn began. `tree-accounted` compares the
   * disk against it at claim time, so a change the ledger never saw — a
   * script the model ran, `sed -i` — is a change the bar can refuse.
   */
  private turnTree: TreeSnapshot | null = null;
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
  /** sha256 of .maat/done.yml as it stood when the session began. */
  /**
   * Task criteria that already passed when tried before the work began.
   *
   * A pass at the end from one of these is a guard holding, not the task
   * being shown done: it passed on the untouched tree too. The receipt says
   * `pass (nothing to establish)` for it rather than presenting it as proof.
   */
  private passedBeforeWork: ReadonlySet<string> = new Set();
  /**
   * The expected-looking operands of `diff`/`cmp` task checks, with their
   * content as the turn found them (src/golden.ts). Recorded at the seal,
   * before the first step; a golden file not in here, or changed since,
   * proves no value.
   */
  private goldensBefore: Map<string, string | null> = new Map();
  /**
   * Task criteria that ran before the work began and FAILED there.
   *
   * The only checks whose pass at the end shows this work did something: one
   * that passed on the untouched tree too, or was never tried there (broken
   * then, or joined after the work began), cannot tell the work from none.
   * "verified" needs a passing independent value check from this set
   * (src/tiers.ts `failedBefore`).
   */
  private failedBeforeWork: ReadonlySet<string> = new Set();
  /**
   * A copy of the project taken at turn start, before any request, kept only
   * while checks are still to join late (drafts past the time cut, the
   * reference check). A late check is tried against it as it joins, so it
   * gets the same pre-work try as one sealed up front. Null when nothing is
   * pending or the tree is too big to copy: a late check is then untried.
   */
  private preWorkTree: PreWorkCopy | null = null;
  /** True only while `proveNow` runs: a bar with no turn behind it. */
  private standalone = false;
  private barHash: string | null;
  private inFlight?: AbortController;
  /**
   * A cancel that arrived while nothing was in flight.
   *
   * `cancel()` aborts the request or the command that is running, and until
   * this existed that was all it did: a cancel that landed while molt was
   * waiting on a permission answer, or between a tool and the next request,
   * aborted nothing, and the turn carried on as if it had never been asked to
   * stop. A surface that cancels whenever the person says so — an editor over
   * ACP sends session/cancel at any moment — needs the turn to end at the next
   * thing it would have started. Only set while a turn runs, so a cancel at
   * an idle prompt cannot cancel the next turn before it begins.
   */
  private cancelRequested = false;
  private turnActive = false;
  /** ctrl+C dropped the subscription session mid-step; the step reports a cancel, not a fault. */
  private ccCancelled = false;
  /** Aborts the command or bar check currently executing, if any. */
  private running?: AbortController;
  /**
   * How many write records this session handed to the archive. Kept in
   * memory and NOT derived from the archive, so it is an independent
   * expectation the archive can be checked against.
   */
  private archivedWrites = 0;

  /**
   * Exuvia indices this session shed, so the bar reads back this session's
   * archived writes and not the whole project's history.
   *
   * The archive directory outlives the session; the ledger a turn is judged
   * against must not.
   */
  private sessionArchives = new Set<number>();
  /**
   * Project-relative paths this session created — files that did not exist
   * when molt first wrote them. Deleting one destroys nothing that was not
   * molt's own doing, which is what makes the gate's delete exception safe.
   */
  private createdThisSession(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const e of this.sessionLedger()) if (e.before === null) out.add(e.path);
    for (const f of this.bashCreated) out.add(f);
    return out;
  }

  /**
   * Project-relative files that first appeared while a bash call ran.
   *
   * The ledger only sees file-tool writes, so `echo x > t1.txt; ...; rm t1.txt`
   * was a delete of a file molt "did not create": refused headless, left
   * behind, and the grader failed the task for the leftover. A file absent
   * before a call and present after it is molt's own doing exactly as a
   * write_file of a new path is. Files only: a folder created by bash may
   * later hold things that were moved into it.
   */
  private bashCreated = new Set<string>();

  /** Files this TURN wrote, with what was there before — what a revert acts on. */
  private turnWrites: LedgerLike[] = [];
  /** Every check was retired by an upheld dispute this turn (judgment.ts). */
  private turnAllRetired = false;
  /** This session's provider latency, learned from completed requests (watchdog.ts). */
  private readonly latency = new LatencyLearner();
  /**
   * The learner for the drafter's and critic's asks (AskOptions.latency):
   * what they take teaches the engine's own requests what normal is. Not
   * offered for a self-hosted server, whose allowances come from its hardware.
   */
  get askLatency(): LatencyLearner | undefined {
    return isSelfHosted(this.cfg.baseUrl) ? undefined : this.latency;
  }
  /** Why the independent review was skipped this turn (see reviewSkipReason), if it was. */
  private reviewSkipped: string | undefined;
  /** Hidden checks whose commands were shown to the model this turn. */
  private turnRevealed: string[] = [];
  /**
   * Set when the model was stopped (clock, provider) and the sealed bar was run
   * on the tree as it stood. Six of twenty local runs ended with no verdict at
   * all because the clock or a failed request stopped the turn before any check
   * ran; two of them had passing work on disk.
   */
  private turnEndedBy: "deadline" | "provider" | "no-progress" | "malformed" | undefined;
  /**
   * Malformed tool calls in a row this turn. One is a slip; a run that kept
   * sending broken `act` calls made 17 in a row and paid for every one
   * (2026-10-07). After MALFORMED_WARN the model is told firmly; after
   * MALFORMED_STOP the turn ends and the work on disk is judged.
   */
  private malformedStreak = 0;
  /** A subprocess backend went silent past the stall allowance this turn (a provider issue). */
  private turnProviderStall = false;
  /** `--revert` put this turn's work back, so a person cannot accept it as it stands. */
  private turnRestored = false;
  /** The pre-turn working tree, as a commit object nothing else can see. */
  private turnSnapshot: string | null = null;
  private turnSnapshotPaths = new Set<string>();
  private turnStartedAt = 0;
  private repoMapText = "";
  private briefText = "";
  private readOnlyPaths = new Set<string>();

  constructor(cfg: EngineConfig) {
    this.cfg = cfg;
    // All three go into the system message, so they must exist before it is built.
    this.repoMapText = cfg.repoMap ?? "";
    this.briefText = cfg.brief ?? "";
    for (const p of cfg.readOnly ?? []) this.readOnlyPaths.add(p);
    this.transcript = new Transcript(this.systemPrompt());
    this.barHash = barFingerprint(this.cwd);
    // The key molt was handed is the one secret it can mask exactly.
    cfg.journal?.protect(cfg.apiKey, env("API_KEY"));
    cfg.receipts?.protect(cfg.apiKey, env("API_KEY"));
    cfg.integrity?.protect(cfg.apiKey, env("API_KEY"));
    // Bind the session's opening to the journal's genesis state, so the
    // integrity chain can prove a session began from the record we shipped.
    if (cfg.integrity && cfg.journal) {
      cfg.integrity.append({
        kind: "session_start",
        session: cfg.journal.sessionId,
        journalRoot: cfg.journal.chainRoot(),
      });
    }
    // Under --worker-user, one line in the journal saying what isolation was
    // actually in effect (src/privsep.ts), e.g.
    // "isolation: worker uid 1001, check uid 1002, pid namespace on".
    const isolation = isolationLine();
    if (isolation && cfg.journal && !isolationNoted.has(cfg.journal)) {
      isolationNoted.add(cfg.journal);
      cfg.journal.append("note", { kind: "isolation", text: isolation });
    }
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
  /**
   * The window this endpoint named, or 0 until an overflow teaches it.
   *
   * The desktop meter fills against this. Inventing a 128k default is how
   * a local 16k server would read as 8% full while it was about to refuse.
   */
  get learnedWindow(): number {
    return this.contextWindow;
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
    if (m !== this.cfg.model) {
      // Output maximums are per-model, and the last one's says nothing
      // about this one. Discovered again on the next refusal if it matters.
      this.modelMaxTokens = undefined;
      this.fittedCompletion = undefined;
      this.fittedGuessed = false;
      this.maxTokensUnsupported = false;
      // A cap doubled on the last model says nothing about this one either.
      this.outputCap = DEFAULT_MAX_TOKENS;
    }
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

  /** The per-turn spending ceiling in dollars; 0 is none. */
  get turnBudgetUsd(): number {
    return this.cfg.maxTurnUsd ?? 0;
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
    // Not `modelMaxTokens`: changing the endpoint clears the model above, and
    // the `setModel` that has to follow is what forgets its ceiling. Clearing
    // it here as well would be a second copy of that rule.
    this.cacheWasWorking = false;
    this.warnedCacheLost = false;
    this.reset();
  }

  reset(): void {
    this.transcript = new Transcript(this.systemPrompt());
    this.ledger = [];
    this.archivedWrites = 0;
    this.sessionArchives = new Set();
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
    if (this.turnActive) this.cancelRequested = true;
    this.inFlight?.abort();
    this.running?.abort();
    /**
     * The ACP agent subprocess has to be told too.
     *
     * Nothing else reaches it: `inFlight` guards a fetch this backend never
     * makes, and stopping molt's reader would leave the agent process
     * working through the rest of the turn with nobody watching. Ending the
     * session is the only way to unask the question, so the next turn starts
     * a new one.
     */
    if (this.cc) {
      this.ccCancelled = true;
      void this.dropAcpSession();
    }
  }

  get streaming(): boolean {
    return this.cfg.stream !== false;
  }

  /**
   * The system message: the constant prompt, this directory, and the two
   * facts a session can be handed before it starts — a map of the repository
   * and the files it may read but never write.
   *
   * Both live here rather than in a first user message because everything in
   * the system message sits inside the cached prefix: it is paid for once per
   * session instead of once per step, which is the only reason a repo map is
   * affordable at all.
   */
  private systemPrompt(): string {
    const parts: string[] = [];
    // The constant prompt names .maat/done.yml as where "done" is defined.
    // In a project without one, a model reads that and spends its first step
    // opening a file that is not there — one step on every task of a
    // benchmark. Said plainly instead, once, inside the cached prefix.
    if (!this.cfg.bar) parts.push(NO_BAR_PROMPT);
    if (this.cfg.batch) parts.push(BATCH_PROMPT);
    if (this.cfg.unattended) parts.push(UNATTENDED_PROMPT);
    if (this.briefText) parts.push(this.briefText);
    if (this.repoMapText) parts.push(this.repoMapText);
    if (this.readOnlyPaths.size) {
      parts.push(
        `These files are READ-ONLY for this session: ${[...this.readOnlyPaths].sort().join(", ")}.\n` +
          `Read them as much as you like. A write to one is refused — if the work needs a ` +
          `change there, say so and stop rather than working around it.`,
      );
    }
    return systemPromptFor(this.cwd, parts.join("\n\n") || undefined);
  }

  /** The repository map in force, as the model sees it. */
  get repoMap(): string {
    return this.repoMapText;
  }

  /**
   * Replace the map. Rebuilds the system message, which resets the cached
   * prefix — so this is a session-start operation, not a per-turn one, and
   * `/map` says so when it is used mid-session.
   */
  setRepoMap(text: string): void {
    this.repoMapText = text;
    this.transcript.setSystem(this.systemPrompt());
  }

  /** The environment brief in force, as the model sees it. */
  get brief(): string {
    return this.briefText;
  }

  /** The reasoning effort sent with each request, or undefined for the model's own. */
  /** Set when the checks refused a claim this turn; see retryReasoningEffort. */
  private refusedThisTurn = false;
  /**
   * The review of this turn's passed claim, when it was made inside the turn
   * and stands for the final state (no nudge followed it). runSealed reuses it
   * rather than asking again.
   */
  private turnReview: Review | null | undefined = undefined;
  /** The task checks this turn sealed (set when they are sealed, which may be after the first reads). */
  private sealedChecks: readonly Check[] = [];
  /** The notes sealed with them, for recomputing the seal when the commands are released. */
  private sealedNotes: readonly string[] = [];
  /**
   * Text withheld from every record while this job runs: the commands of its
   * hidden checks, and the reference check's source (src/withhold.ts). Held in
   * memory only, and released — journalled in full, receipts' full twins
   * written — when the job's work is over.
   */
  private withheld: { name: string; text: string }[] = [];
  /** Absolute paths this turn's task names: part of the task, though outside the project (src/scope.ts). */
  private turnTaskPaths: string[] = [];
  /** This turn's checks are hidden, or are being drafted to be (src/scope.ts). */
  private turnHidesChecks = false;

  /**
   * Whether the file tools are held to the task: an unattended job with
   * hidden checks, while it runs. A person at the keyboard can read what they
   * like; a worker alone with checks it cannot see spent whole budgets
   * reading Maat's records and other tasks' logs instead (src/scope.ts).
   */
  private scoped(): boolean {
    return this.cfg.unattended === true && this.turnActive && (this.turnHidesChecks || this.withheld.length > 0);
  }

  /** The refusal for a file tool's path outside the task, journalled; null when the path is in scope. */
  private refuseOutsideTask(tool: string, path: string): string | null {
    if (!this.scoped()) return null;
    const v = outsideTask(this.cwd, path, { tool, taskPaths: this.turnTaskPaths });
    if (!v) return null;
    this.cfg.journal?.append("outside_task", { tool, path: path || ".", reach: v.kind, refused: true });
    return v.message;
  }

  /** A bash command that names `.maat/` or a path outside the project: not blocked, journalled. */
  private noteBashReach(command: string): void {
    if (!this.scoped()) return;
    const r = bashReach(this.cwd, command, this.turnTaskPaths);
    if (!r.stateDir && r.outside.length === 0) return;
    this.cfg.journal?.append("outside_task", {
      tool: "bash",
      refused: false,
      stateDir: r.stateDir,
      outside: r.outside,
      command: command.slice(0, 500),
    });
  }

  /** The effort the next request carries. */
  private get effortNow(): string | undefined {
    return this.refusedThisTurn && this.cfg.retryReasoningEffort
      ? this.cfg.retryReasoningEffort
      : this.cfg.reasoningEffort;
  }

  get reasoningEffort(): string | undefined {
    return this.cfg.reasoningEffort;
  }

  /** Set or clear the reasoning effort. Takes effect on the next request. */
  setReasoningEffort(effort?: string): void {
    this.cfg.reasoningEffort = effort || undefined;
  }

  /** Replace the brief. Same cost as `setRepoMap`: the cached prefix resets. */
  setBrief(text: string): void {
    this.briefText = text;
    this.transcript.setSystem(this.systemPrompt());
  }

  get readOnly(): string[] {
    return [...this.readOnlyPaths].sort();
  }

  /** Pin paths as readable but unwritable. Returns the ones newly added. */
  addReadOnly(paths: string[]): string[] {
    const added: string[] = [];
    for (const p of paths) {
      const rel = p.trim();
      if (!rel || this.readOnlyPaths.has(rel)) continue;
      this.readOnlyPaths.add(rel);
      added.push(rel);
    }
    if (added.length) this.transcript.setSystem(this.systemPrompt());
    return added;
  }

  clearReadOnly(): number {
    const n = this.readOnlyPaths.size;
    this.readOnlyPaths.clear();
    this.transcript.setSystem(this.systemPrompt());
    return n;
  }

  /** Is this path pinned read-only? Compared as written, and resolved. */
  private isReadOnly(rel: string, abs: string): boolean {
    if (this.readOnlyPaths.has(rel)) return true;
    for (const p of this.readOnlyPaths) {
      if (resolve(this.cwd, p) === abs) return true;
    }
    return false;
  }

  get gitPolicy(): GitPolicy {
    return this.cfg.git ?? {};
  }

  setGitPolicy(p: GitPolicy): void {
    this.cfg.git = { ...this.gitPolicy, ...p };
  }

  /** The wall-clock ceiling for one turn, in ms. 0 or undefined means none. */
  get turnDeadlineMs(): number {
    return this.cfg.turnDeadlineMs ?? 0;
  }

  setTurnDeadline(ms?: number): void {
    this.cfg.turnDeadlineMs = ms && ms > 0 ? ms : undefined;
  }

  /** Completion attempts before a turn reports failure. */
  get maxProofAttempts(): number {
    return this.cfg.maxProofAttempts ?? MAX_PROOF_ATTEMPTS;
  }

  setMaxProofAttempts(n: number): void {
    this.cfg.maxProofAttempts = Math.max(1, Math.floor(n));
  }

  /** The history size a shed is triggered at, in molt's own token units. 0 is off. */
  get autoShedAtTokens(): number {
    return this.cfg.autoShedAtTokens ?? DEFAULT_AUTO_SHED_TOKENS;
  }

  setAutoShed(tokens: number): void {
    this.cfg.autoShedAtTokens = Math.max(0, Math.floor(tokens));
  }

  /** When this turn's wall clock runs out, as an epoch ms, or undefined for never. */
  private deadlineAt(): number | undefined {
    const ms = this.turnDeadlineMs;
    return ms > 0 && this.turnStartedAt > 0 ? this.turnStartedAt + ms : undefined;
  }

  /**
   * How long a closing summary may wait, as an epoch ms, under a time budget.
   *
   * The salvage runs after the clock has stopped the model, so the turn's own
   * deadline is already behind it; it gets a short grace (deadlineGraceMs)
   * past whichever is later, the deadline or now. Without a budget, undefined:
   * the idle and stall watchdogs still bound it.
   */
  private salvageDeadlineAt(): number | undefined {
    const at = this.deadlineAt();
    return at === undefined ? undefined : Math.max(at, Date.now()) + deadlineGraceMs(this.turnDeadlineMs);
  }

  /** The stall allowance for a subprocess backend (EngineConfig.backendStallMs). */
  private stallMs(): number {
    return this.cfg.backendStallMs ?? backendStallMs();
  }

  /**
   * Whether the independent review would outlast the turn, and so is not run.
   * Six of eight no-verdict runs on Mercury 2.5 passed their bar and then died
   * inside the review's three asks, past the runner's grace; one stalled ask is
   * 123 s. With under three first-byte allowances left (a fixed 60 s until the
   * provider has shown what its normal is) the claim ends as it stands, said
   * to be unreviewed.
   */
  private reviewSkipReason(): string | undefined {
    const left = this.timeLeftMs();
    if (left === undefined) return undefined;
    // The review runs on the judge. A separate judge model is timed at the default, not
    // at the worker's learned latency (a slow worker made a fast judge's review look like 9 min).
    const judged = judgeTarget({ baseUrl: this.cfg.baseUrl, model: this.cfg.model }).model !== this.cfg.model;
    const need = 3 * ((judged ? undefined : this.latency.learnedFirstByte()) ?? 20_000);
    if (left > need) return undefined;
    return left <= 0
      ? "the time budget had run out"
      : `${Math.round(left / 1000)}s of the time budget were left, under the ${Math.round(need / 1000)}s a review can take`;
  }

  /** Milliseconds left before this turn's deadline, or undefined for none. */
  private timeLeftMs(): number | undefined {
    const at = this.deadlineAt();
    return at === undefined ? undefined : Math.max(0, at - Date.now());
  }

  /**
   * The clock, as the model reads it after each step of a timed turn.
   *
   * On Terminal-Bench 18 of 89 molt trials ran out the task's clock, and the
   * grader judged whatever was on disk then: five had spent 130+ steps and
   * never put a deliverable in place, others started a build longer than the
   * time left. A model that is never told the time cannot pace itself.
   */
  private clockNote(): string | undefined {
    const total = this.turnDeadlineMs;
    const left = this.timeLeftMs();
    if (!total || left === undefined) return undefined;
    const min = (ms: number) =>
      total < 120_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.max(0, Math.round(ms / 60_000))}m`;
    const used = total - left;
    const base = `[molt: ${min(used)} of ${min(total)} used]`;
    if (left > total / 2) return base;
    if (left > total / 4) {
      // Halfway: of 8 Terminal-Bench trials stopped by the budget, most had no
      // deliverable in place when it ran out (compcert, caffe: no binary).
      return (
        `${base} Half the time is gone. If the deliverable is not in its final place yet, ` +
        `get a working version there first and improve it after.`
      );
    }
    return (
      `${base} Less than a quarter of the time is left. Put the deliverable in its ` +
      `final place and form now, working or not, then finish it or say done; ` +
      `do not start anything that cannot finish in ${min(left)}.`
    );
  }

  /** Has this turn run past its wall-clock ceiling? */
  private pastDeadline(): boolean {
    const ms = this.turnDeadlineMs;
    return ms > 0 && this.turnStartedAt > 0 && Date.now() - this.turnStartedAt >= ms;
  }

  /** Withhold these checks' commands (the hidden ones) from every record until the job ends. */
  private withholdChecks(checks: readonly Check[]): void {
    for (const c of checks) {
      if (c.kind !== "command" || hiddenCommands([c]).length === 0) continue;
      this.withholdText(c.name, c.run);
    }
  }

  /** Withhold one string (a command, a reference program) until the job ends. */
  private withholdText(name: string, text: string): void {
    if (!text || text.length < WITHHELD_MIN_CHARS || this.withheld.some((w) => w.text === text)) return;
    this.withheld.push({ name, text });
    this.cfg.journal?.withhold([text]);
    this.cfg.receipts?.withhold([text]);
  }

  /** Text with every withheld string masked. Identity once the job's commands are released. */
  maskWithheld(text: string): string {
    return maskText(text, this.withheld.map((w) => w.text));
  }

  /** An event as it may be printed while the job runs: withheld strings masked. */
  maskEvent<T>(ev: T): T {
    return this.withheld.length ? maskDeep(ev, this.withheld.map((w) => w.text)) : ev;
  }

  /**
   * The work is over: write what was withheld. The journal records each
   * hidden command in full (the seal journalled before the work is a hash over
   * them, so the two can be compared), each masked receipt gets its full twin
   * under receipts/full/, bound into the integrity chain. Null when nothing
   * was withheld. Idempotent.
   */
  private releaseWithheld(): Extract<EngineEvent, { kind: "checks_released" }> | null {
    if (!this.withheld.length) return null;
    const items = this.withheld;
    this.withheld = [];
    this.cfg.journal?.release();
    const twins = this.cfg.receipts?.release() ?? [];
    const checks = this.sealedChecks
      .filter((c): c is Extract<Check, { kind: "command" }> => c.kind === "command" && items.some((w) => w.text === c.run))
      .map((c) => ({ name: c.name, run: c.run }));
    const other = items.filter((w) => !checks.some((c) => c.run === w.text));
    const seal = this.sealedChecks.length || this.sealedNotes.length ? sealOf([...this.sealedChecks], [...this.sealedNotes]) : "";
    this.cfg.journal?.append("note", {
      kind: "checks-released",
      text: `the work is over: ${checks.length} hidden check command(s) released`,
      seal,
      checks: checks.map((c) => ({ ...c, sha256: commandSha(c.run) })),
      ...(other.length ? { withheld: other.map((w) => ({ name: w.name, text: w.text })) } : {}),
      receipts: twins.map((t) => t.file),
    });
    for (const t of twins) {
      if (!this.cfg.integrity || !this.cfg.journal) break;
      this.cfg.integrity.append({
        kind: "release",
        session: this.cfg.journal.sessionId,
        receiptFile: t.file,
        receiptSha: sha256Of(t.path) ?? "",
        of: t.of,
        journalRoot: this.cfg.journal.chainRoot(),
      });
    }
    return { kind: "checks_released", seal, checks, receipts: twins.map((t) => t.path) };
  }

  /** Values that must not appear on screen or in a file molt writes. */
  private secrets(): (string | undefined)[] {
    return [this.cfg.apiKey, env("API_KEY"), secretValue("OPENAI_API_KEY"), ...secretValues()];
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
    /**
     * A subscription run costs no money, so it gets no dollar figure.
     *
     * The tokens are real and are still counted, but pricing them off a table
     * would put a number on a receipt for money nobody was charged — and
     * `anthropicPricing` would happily match the model alias and do it. The
     * token ceiling still applies; `/budget` in dollars has nothing to bound.
     */
    if (this.subprocess) return undefined;
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
  /**
   * Write the standing note of what this turn is for.
   *
   * The note is the second message on the wire, right after the system
   * prompt, so changing it throws away the provider's cache for the whole
   * conversation behind it. It used to be rewritten after every new file and
   * every refusal, to keep a "files you have changed" list current; in one
   * Zed session nine of fourteen cache misses followed a file edit, each one
   * re-billing the whole conversation at full price. So during work the note
   * is only recorded (`now` false) and goes onto the wire at the next point
   * the cache is lost anyway — a shed, which is also the only time the list
   * matters, because the history that showed those writes is what was shed.
   */
  private pinTask(request: string, lastFailure?: string, now = false): void {
    const written = [...new Set(this.ledger.map((e) => e.path))];
    const text = [
      "[molt] What this turn is for. This note is never compacted away.",
      `Request: ${request.replace(/\s+/g, " ").slice(0, 400)}`,
      written.length ? `Files you have changed: ${written.join(", ")}` : "Files changed so far: none",
      lastFailure ? `The bar last refused this claim: ${lastFailure}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (now) {
      this.transcript.pin(text);
      this.pendingPin = undefined;
    } else {
      this.pendingPin = text;
    }
  }

  /**
   * Save a tool's whole output under `.maat/out/`, redacted like everything
   * else molt writes, and return the path the model should read. Null if it
   * could not be written — the preview still stands on its own.
   */
  private spill(text: string, callId: string): string | null {
    try {
      const name = `${callId.replace(/[^\w-]/g, "_")}.txt`;
      const rel = `${stateDirName(this.cwd)}/out/${name}`;
      mkdirSync(stateDir(this.cwd, "out"), { recursive: true });
      // In the state dir under privilege separation; read_file serves it back (spilledOutput).
      writeFileSync(stateDir(this.cwd, "out", name), this.maskWithheld(redact(text, this.secrets())), "utf8");
      return rel;
    } catch {
      return null;
    }
  }

  /** A pinned note recorded during work, put on the wire at the next shed. */
  private pendingPin?: string;

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
  /**
   * Every write this project can still prove, across all sessions.
   *
   * For auditing history — "was this work ever done, and is the evidence
   * still there". Not for judging a turn: see `sessionLedger`.
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

  /**
   * What THIS session wrote: live memory plus the batches it shed.
   *
   * The distinction from `mergedLedger` is the whole of a real failure. The
   * archive directory outlives the session, so judging a turn against every
   * batch in it judges the turn against the project's history. A receipt from
   * a turn whose only work was `src/files.ts` shows `work-checked` breaking
   * lines in `electron/main.ts` and `ui/index.html` — written days earlier, by
   * someone else — and `work-landed` reporting "contents changed since molt
   * wrote it" for four files this session never opened, because a later commit
   * had touched them.
   *
   * There is no honest way for a model to clear that. One cleared it the only
   * way available: six comment-only word swaps across six untouched files, in
   * a single step, purely to make stale hashes match. The bar then accepted
   * the turn. That is the exact outcome `files-changed` names as the worst
   * one, produced by the check itself.
   */
  sessionLedger(): LedgerEntry[] {
    const archived = this.cfg.archive?.ledger?.(this.sessionArchives) ?? [];
    const byPath = new Map<string, LedgerEntry>();
    for (const e of [...archived, ...this.ledger]) {
      const prior = byPath.get(e.path);
      byPath.set(e.path, prior ? { ...e, before: prior.before } : { ...e });
    }
    return [...byPath.values()];
  }

  /**
   * What THIS turn wrote.
   *
   * The session ledger outlives a turn. A receipt or an ask-mode decision that
   * reads it attributes earlier work to a claim that never opened those files
   * — a later question filed as a verified change of the previous turn's
   * writes, which is how stats counted answers as work. `turnCalls` is reset
   * at the start of each run; filtering on it is the same floor
   * `files-changed` already uses.
   */
  turnLedger(): LedgerEntry[] {
    return this.sessionLedger().filter((e) => this.turnCalls.has(e.callId));
  }

  barContext(claim?: string): BarContext {
    return {
      cwd: this.cwd,
      ...(this.standalone ? { standalone: true } : {}),
      // So ctrl+C during a long suite kills the suite, not just the spinner.
      signal: this.running?.signal,
      record: this.transcript.record(),
      read: [...this.readPaths],
      cache: this.cache,
      ledger: this.sessionLedger(),
      turnLedger: this.turnLedger(),
      treeBefore: this.turnTree ?? undefined,
      liveLedger: [...this.ledger],
      archive: this.cfg.archive,
      archivedBatches: this.transcript.shedCount,
      expectedArchivedWrites: this.archivedWrites,
      sessionArchives: this.sessionArchives,
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
    // The cache is lost here anyway, and the history that showed this turn's
    // writes is about to go: now is when the pinned note must be current.
    if (this.pendingPin) {
      this.transcript.pin(this.pendingPin);
      this.pendingPin = undefined;
    }

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
      this.sessionArchives.add(entry.index);
      // Bind the exuvia and the journal's current state into the integrity
      // chain, so a deletion or edit of this archived batch is provable later
      // even across process restarts.
      if (this.cfg.integrity && this.cfg.journal) {
        this.cfg.integrity.append({
          kind: "shed",
          session: this.cfg.journal.sessionId,
          exuvia: entry.file,
          exuviaSha: entry.sha256,
          journalRoot: this.cfg.journal.chainRoot(),
        });
      }
    }

    this.transcript.commitShed(plan);
    // A cap fitted beside the old prompt is too small for the new one.
    this.fittedCompletion = undefined;
    this.fittedGuessed = false;

    this.ledger = staying;
    // Journalled here, on every path. It was journalled by the two auto-shed
    // call sites and by neither surface's `/shed`, so a batch shed by hand
    // was in the archive and the integrity ledger and not in the session log
    // — and the log is the expectation `record-intact` reads back tomorrow.
    // This project's exuvia 0000 is one the log cannot explain.
    this.cfg.journal?.append("shed", {
      dropped: plan.droppedCount,
      before: plan.beforeTokens,
      after: plan.afterTokens,
      archive: path,
      estimated: true,
    });
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

  /**
   * A file's text, through the editor when there is one.
   *
   * A read the editor cannot serve — a path outside its project, a file it
   * cannot open — falls back to disk rather than failing the call: the
   * editor is where the freshest copy lives, not the only copy there is.
   */
  private async readText(abs: string): Promise<string> {
    // Under privilege separation the worker's helper reads it, as the worker.
    const wfs = this.workerFs;
    if (wfs) return wfs.read(abs);
    const read = this.cfg.files?.read;
    if (read) {
      try {
        return await read(abs);
      } catch {
        /* the editor could not serve it; disk can */
      }
    }
    return readFileSync(abs, "utf8");
  }

  /**
   * Write a file, through the editor when there is one, and return what is
   * on disk afterwards.
   *
   * The editor writes into its buffer and saves, and may format on the way.
   * What it saved is what the bar will read, so that is what is returned and
   * ledgered — not the text molt sent. An editor that took the write but did
   * not save it leaves disk behind the buffer; molt then writes disk itself,
   * so the two agree and the ledger names a file that exists.
   */
  private async writeText(abs: string, content: string): Promise<string> {
    const wfs = this.workerFs;
    if (wfs) {
      await wfs.write(abs, content);
      return content;
    }
    mkdirSync(dirname(abs), { recursive: true });
    const write = this.cfg.files?.write;
    if (write) {
      const pre = sha256Of(abs);
      try {
        await write(abs, content);
        if (existsSync(abs)) {
          const landed = readFileSync(abs, "utf8");
          // A buffer the editor accepted but never saved still holds the old
          // text on disk. Only a changed file is evidence the save happened.
          if (landed === content || sha256Of(abs) !== pre) return landed;
        }
      } catch {
        /* the editor refused the write; disk will not */
      }
    }
    writeFileSync(abs, content, "utf8");
    return content;
  }

  /**
   * The file tools' hands under privilege separation (src/privsep.ts): a
   * helper running as the worker user. Undefined when it is off, and the
   * tools touch the disk as Maat, as they always did.
   */
  private get workerFs(): WorkerFs | undefined {
    return privSep()?.fs();
  }

  private async fileExists(abs: string): Promise<boolean> {
    const wfs = this.workerFs;
    return wfs ? wfs.exists(abs) : existsSync(abs);
  }

  private async fileSha(abs: string): Promise<string | null> {
    const wfs = this.workerFs;
    return wfs ? wfs.sha256(abs) : sha256Of(abs);
  }

  /**
   * A spilled output (`.maat/out/<call>.txt`) while Maat's records are out of
   * the project: the worker cannot read the state dir, so Maat serves its own
   * masked copy of the worker's own output. Undefined for any other path.
   */
  private spilledOutput(rel: string): string | undefined {
    const to = stateRedirect(this.cwd);
    if (!to) return undefined;
    const m = /^(?:\.\/)?\.(?:maat|molt)\/out\/([\w-]+\.txt)$/.exec(rel);
    if (!m) return undefined;
    const p = join(to, "out", m[1]!);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
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
      case "inspect": {
        const rel = String(args.path ?? ".");
        const abs = resolve(this.cwd, rel);
        const off = this.refuseOutsideTask("inspect", rel);
        if (off) return off;
        const wfs = this.workerFs;
        if (!(await this.fileExists(abs))) return `${rel} does not exist`;
        try {
          const part = { offset: num(args.offset, 0), length: num(args.length, 0) || undefined };
          if (wfs) return (await wfs.isDir(abs)) ? await wfs.inspectDir(abs, rel) : await wfs.inspectFile(abs, rel, part);
          return statSync(abs).isDirectory()
            ? inspectDir(abs, rel)
            : inspectFile(abs, rel, part);
        } catch (e) {
          return `could not inspect ${rel}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      case "read_file": {
        const off = this.refuseOutsideTask("read_file", String(args.path ?? ""));
        if (off) return off;
        this.readPaths.add(String(args.path ?? ""));
        return readPart(
          this.spilledOutput(String(args.path ?? "")) ?? (await this.readText(resolve(this.cwd, String(args.path ?? "")))),
          String(args.path ?? ""),
          num(args.offset, 0),
          num(args.limit, Number.MAX_SAFE_INTEGER),
          this.resultBudget(),
        );
      }

      case "write_file": {
        const rel = String(args.path ?? "");
        const abs = resolve(this.cwd, rel);
        if (CONTROL_IN_PATH.test(rel)) return CONTROL_PATH_REFUSAL;
        // Refused before anything is read or written. A read-only pin is a
        // promise to the person who made it, and a promise that holds only
        // when the model cooperates is not one.
        if (this.isReadOnly(rel, abs)) return readOnlyRefusal(rel);
        const before = await this.fileSha(abs);
        // The text as well as the hash: a hash proves the file changed, and
        // only the text can say whether the change was a comment.
        let priorText = "";
        const existed = await this.fileExists(abs);
        if (existed) {
          try {
            priorText = await this.readText(abs);
          } catch {
            /* unreadable: the change scores as substantive, which never blocks work */
          }
        }
        const sent = String(args.content ?? "");
        // A whole file that is really a diff of one. Same failure as the
        // edit_file guard below, and the same one-step refusal.
        if (!isPatchPath(rel)) {
          const why = diffSyntaxIn(sent);
          if (why) return `write refused: ${diffSyntaxRefusal("content", why)}`;
        }
        // What landed, which is what the sent text became if an editor
        // reformatted it on save. Everything below is measured on that.
        const content = await this.writeText(abs, sent);
        this.writeDiffs.set(callId, { path: abs, oldText: existed ? priorText : null, newText: content });
        const after = createHash("sha256").update(content, "utf8").digest("hex");
        const at = isAbsolute(rel) ? relative(this.cwd, abs) : rel;
        if (!isGenerated(at)) {
          const specGone = isTestPath(at) ? specWeakened(priorText, content) : [];
          this.ledger.push({
            path: at,
            before,
            after,
            callId,
            substance: substanceOf(priorText, content),
            changedLines: changedLinesOf(priorText, content),
            ...(specGone.length ? { specRemoved: specGone } : {}),
          });
          this.turnWrites.push({ path: at, before });
        }
        return (
          `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}` +
          reshaped(sent, content) +
          (isGenerated(at)
            ? " [build output — written, but not counted as work: the next build overwrites it]"
            : "")
        );
      }

      case "list_dir": {
        const rel = String(args.path ?? ".");
        const abs = resolve(this.cwd, rel);
        const off = this.refuseOutsideTask("list_dir", rel);
        if (off) return off;
        this.mustBeInside(abs, rel);
        // Bounded and off the main thread: a listing the model asks for can be
        // pointed at anything, including a home directory.
        const walkOpts = { depth: num(args.depth, 1), glob: str(args.glob), deadline: Date.now() + WALK_DEADLINE_MS };
        const wfs = this.workerFs;
        return formatListing(rel, wfs ? await wfs.walk(abs, walkOpts) : await walkAsync(abs, walkOpts));
      }

      case "grep": {
        const rel = String(args.path ?? ".");
        const abs = resolve(this.cwd, rel);
        const off = this.refuseOutsideTask("grep", rel);
        if (off) return off;
        this.mustBeInside(abs, rel);
        const pattern = String(args.pattern ?? "");
        const grepOpts = { glob: str(args.glob), ignoreCase: args.ignore_case === true };
        const wfs = this.workerFs;
        return formatMatches(pattern, wfs ? await wfs.grep(abs, pattern, grepOpts) : await grepFiles(abs, pattern, grepOpts));
      }

      case "edit_file": {
        const rel = String(args.path ?? "");
        const abs = resolve(this.cwd, rel);
        if (CONTROL_IN_PATH.test(rel)) return CONTROL_PATH_REFUSAL;
        this.mustBeInside(abs, rel);
        if (this.isReadOnly(rel, abs)) return readOnlyRefusal(rel);
        if (!(await this.fileExists(abs))) return `no such file: ${rel} — write_file creates a new one`;
        const before = await this.fileSha(abs);
        const current = await this.readText(abs);
        const edit = applyEdit(
          current,
          String(args.old_text ?? ""),
          String(args.new_text ?? ""),
          args.replace_all === true,
          { allowDiffText: isPatchPath(rel) },
        );
        if (!edit.ok) return `edit refused: ${edit.why}`;
        const landed = await this.writeText(abs, edit.text);
        this.writeDiffs.set(callId, { path: abs, oldText: current, newText: landed });
        // Ledgered exactly like a write, so files-changed and record-intact
        // prove a surgical edit the same way they prove a whole-file rewrite.
        const editedAt = isAbsolute(rel) ? relative(this.cwd, abs) : rel;
        if (!isGenerated(editedAt)) {
          const specGone = isTestPath(editedAt) ? specWeakened(current, landed) : [];
          this.ledger.push({
            path: editedAt,
            before,
            after: createHash("sha256").update(landed, "utf8").digest("hex"),
            callId,
            substance: substanceOf(current, landed),
            changedLines: changedLinesOf(current, landed),
            ...(specGone.length ? { specRemoved: specGone } : {}),
          });
          this.turnWrites.push({ path: editedAt, before });
        }
        const delta = Buffer.byteLength(landed, "utf8") - Buffer.byteLength(current, "utf8");
        return (
          `replaced ${edit.replacements} occurrence(s) in ${rel} · ` +
          `${delta >= 0 ? "+" : ""}${delta} bytes` +
          reshaped(edit.text, landed)
        );
      }

      case "bash": {
        // Folded and stripped where the arguments were parsed; again here for
        // a caller that reaches runTool directly (a subscription backend).
        foldCommands(args, this.cwd);
        const command = String(args.command ?? "");
        this.noteBashReach(command);
        if (!command.trim() && args.stop_job === undefined) {
          return "bash needs a command, or commands: a list to run in order";
        }
        // Stopping a job is a verb of its own, carried on the same tool so the
        // repertoire stays small; the command is ignored when it is present.
        if (args.stop_job !== undefined) {
          const id = Number(args.stop_job);
          const p = listBackground().find((e) => e.id === id);
          if (!p) return `no background job ${String(args.stop_job)} — jobs started this session: ${
            listBackground().map((e) => e.id).join(", ") || "none"
          }`;
          if (p.exit) return `job ${id} had already exited (${exitWord(p.exit)}); its log is ${p.log}`;
          stopBackground(id);
          return `stopping job ${id} (pid ${p.pid}, "${p.command}"); its log is ${p.log}`;
        }
        if (args.background === true) {
          const p = startBackground(command, { cwd: this.cwd, env: scrubbedEnv(), asWorker: true });
          // A process that died before the result was even composed is the
          // common failure — a typo in the command, a port already bound. Give
          // it a moment so that case is reported as what it is, not as a
          // running server the model then waits on.
          await sleepUnlessAborted(150, this.running?.signal ?? new AbortController().signal);
          if (p.exit) {
            return `job ${p.id} exited ${exitWord(p.exit)} straight away. Its output is in ${p.log}.`;
          }
          return describeStart(p);
        }
        const asked = Number(args.timeout_s);
        const wanted =
          Number.isFinite(asked) && asked > 0
            ? Math.min(asked * 1000, MAX_BASH_TIMEOUT_MS)
            : (this.cfg.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS);
        // Never past the turn's own deadline: a command still running when
        // the time is up is killed anyway, and so is everything after it.
        const left = this.timeLeftMs();
        const timeoutMs = left !== undefined ? Math.max(5_000, Math.min(wanted, left - 10_000)) : wanted;
        const t0 = Date.now();
        // Only a command that could write needs the before/after listing; a
        // listing that was cut short (null) records nothing rather than guess.
        const listed = isReadOnlyCommand(command) ? null : listProject(this.cwd);
        const r = await runCommand(command, {
          cwd: this.cwd,
          timeoutMs,
          maxBuffer: 1024 * 1024,
          env: scrubbedEnv(),
          // As the worker user when privilege separation is on (src/privsep.ts).
          asWorker: true,
          // A cancelled turn kills the command it is waiting on. Leaving a
          // build running after the turn that asked for it was called off is
          // the machine doing work nobody is going to read.
          signal: this.running?.signal,
        });
        const took = Date.now() - t0;
        if (listed) {
          const now = listProject(this.cwd);
          if (now) for (const f of now.files) if (!listed.files.has(f)) this.bashCreated.add(f);
        }
        // Same shape execSync produced: bare stdout when it worked, and a
        // tagged dump of both streams when it did not — plus how long it
        // took, once it took long enough to matter. A model that knows the
        // suite is forty seconds stops re-running it to "double check", and
        // sets timeout_s before the next slow thing rather than after.
        const held = r.heldOpen && !r.timedOut
          ? "\n[molt: the command finished, but something it started is still running and holding its output, " +
            "so its later output is not shown. Start servers with background=true, or redirect them " +
            "(`cmd >/tmp/x.log 2>&1 &`).]"
          : "";
        // One command that ate a fifth of the whole budget: query-optimize
        // re-ran a 130 s query four times and ran out the clock.
        const total = this.turnDeadlineMs;
        const hog =
          total && took >= total / 5
            ? `\n[molt: that one command used ${Math.round((100 * took) / total)}% of this task's time. ` +
              `Do not run it again unless that is the plan; test on something smaller first.]`
            : "";
        const ran = (took >= SLOW_COMMAND_MS ? `\n[molt: ran ${fmtSeconds(took)}]` : "") + held + hog;
        // One trailing newline is folded into the note so the result does not
        // end in a blank line; the model reads "slow\n[molt: ran 2.2s]".
        const body = (out: string) => (ran ? out.replace(/\n$/, "") : out);
        if (r.code === 0 && !r.timedOut) return `${body(r.stdout)}${ran}`;
        if (r.timedOut) {
          return (
            `timeout after ${fmtSeconds(timeoutMs)}\n${r.stdout}${r.stderr}` +
            `\n[molt: killed at the ${fmtSeconds(timeoutMs)} limit. If it genuinely needs longer, ` +
            `call again with timeout_s (up to ${MAX_BASH_TIMEOUT_MS / 1000}); if it is a server ` +
            `or watcher, start it with background=true instead.]`
          );
        }
        return `exit ${r.code ?? r.signal ?? "?"}\n${body(`${r.stdout}${r.stderr}`)}${ran}`;
      }

      case "plan": {
        const steps = Array.isArray(args.steps)
          ? args.steps.map((s) => String(s).trim()).filter((s) => s.length > 0).slice(0, 20)
          : [];
        if (!steps.length) return "a plan needs at least one step";
        return renderPlan(steps, Number(args.current ?? 0));
      }

      case "act":
        // Reached only when an act's actions could not be read (expandAct):
        // a readable one never arrives here as itself.
        return (
          "act: nothing ran, because at least one of its actions could not be read. The actions go in order, " +
          "so the readable ones were not run without it either. This is not a refusal — nothing was " +
          "denied; the action list itself could not be parsed. `actions` must be a JSON array (not a " +
          "string holding one) of " +
          '{"tool": "<tool name>", "args": {...}} objects, e.g. ' +
          '[{"tool": "write_file", "args": {"path": "out.txt", "content": "..."}}]. Send them again.'
        );

      default:
        return `unknown tool: ${name}`;
    }
  }

  /**
   * Run the bar, with tamper detection in front of it.
   *
   * All this check can see is that the fingerprint of .maat/done.yml no
   * longer matches the one taken when the turn began — not who changed it.
   * The wording used to say "the work being judged against it" edited the
   * file, which is a claim about the agent. On 2026-09-07 the file changed
   * mid-session by another route entirely, and a turn that had never touched
   * it was refused for it and told to revert a change it did not make, on
   * every attempt until it was exhausted.
   *
   * The finding still stands as a refusal — a bar that moved mid-session
   * cannot judge the claim either way, by anyone's hand — but it no longer
   * says who moved it, and it says plainly that retrying will not clear it:
   * that is a decision for the person, not another attempt.
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
    if (this.cfg.sandbox) return;
    if (!insideProject(this.cwd, abs)) {
      throw new Error(`${shown} is outside this project; Maat will not walk there`);
    }
  }

  /** Files the last bar run left in the project that were not there before it. */
  checkLeftovers: string[] = [];

  /**
   * The input files the task names, one line each, as bytes — appended to the
   * task when the turn starts. A careful person looks at the exact input
   * before writing code against it; a model that is shown "CRLF, 2 values
   * differ only by case" does not have to think of looking. See inspect.ts.
   */
  private inputProfile(task: string): string {
    try {
      const files = namedInputs(task, this.cwd);
      if (!files.length) return "";
      const lines = files.map((p) => `- ${profileLine(p, relative(this.cwd, p).startsWith("..") ? p : relative(this.cwd, p))}`);
      let body = lines.join("\n");
      if (body.length > 2_000) body = `${body.slice(0, 2_000)}\n…`;
      return `\n\n[molt] The input files this task names, as bytes (inspect a file for more):\n${body}`;
    } catch {
      return "";
    }
  }

  /** Remove what a bar run created in the project; see src/leftovers.ts. */
  private removeCheckLeftovers(before: ProjectListing | null): void {
    this.checkLeftovers = removeNew(this.cwd, before);
  }

  private async runBarGuarded(claim?: string, override?: Bar | null): Promise<BarResult> {
    const bar = override ?? this.cfg.bar!;
    const t0 = Date.now();
    const before = this.cfg.unattended ? listProject(this.cwd) : null;
    // The bar is the longest-running thing molt does. It gets the same
    // cancellation handle a tool call gets, for the same reason.
    this.running = new AbortController();
    if (this.cancelRequested) this.running.abort();
    try {
      return await this.runBarInner(bar, claim, t0);
    } finally {
      this.running = undefined;
      if (this.cfg.unattended) this.removeCheckLeftovers(before);
    }
  }

  private async runBarInner(bar: Bar, claim: string | undefined, t0: number): Promise<BarResult> {
    const now = barFingerprint(this.cwd);
    if (this.barHash !== null && now !== this.barHash) {
      /**
       * Who moved the bar — said plainly where molt knows, hedged where it does not.
       *
       * The fingerprint moving is all this check measures, and for a while the
       * wording claimed more than that: "the definition of done cannot be
       * edited by the work being judged against it" is an accusation, and on
       * 2026-09-07 it was aimed at a turn that had never touched the file
       * while a person armed a check in another window. It was then softened
       * to hedge in every case, which gave away something molt actually has.
       *
       * A tool call that writes `.maat/done.yml` leaves a ledger entry naming
       * it, exactly like any other write. Where that entry exists there is no
       * uncertainty to be humble about — and this is the case the check was
       * built for, a model editing its own passing conditions, which is the
       * last place to be vague. Where it does not exist, molt genuinely cannot
       * tell an editor from another session from a person, and says so.
       *
       * The refusal is the same either way: a bar that moved mid-session
       * cannot judge the claim, by anyone's hand. Only the sentence changes,
       * and with it what the model is told to do about it.
       */
      /** As the ledger spells it: project-relative, always this. */
      const BAR_PATH = relative(this.cwd, barPath(this.cwd)).replace(/\\/g, "/");
      const editedHere = this.turnLedger()
        .some((e) => e.path === BAR_PATH || e.path.endsWith(`/${BAR_FILENAME}`));
      const tamper: CheckResult = {
        name: "bar-unmodified",
        kind: "builtin",
        detail: "done.yml fingerprint",
        ok: false,
        output: editedHere
          ? `This turn wrote ${BAR_PATH}, and its fingerprint no longer matches the one taken ` +
            "when the turn began. The definition of done cannot be edited by the work being " +
            "judged against it — a model that sets its own passing conditions always passes. " +
            "Revert it and satisfy the original checks, or stop and tell the user why the bar " +
            "is wrong; changing it is their decision, not yours."
          : `${BAR_PATH} no longer matches the fingerprint taken when this turn began, and no ` +
            "tool call in this turn wrote it. Maat cannot tell from here whether another " +
            "session did, an editor did, or a person arming a check did — only that the bar " +
            "moved while it was being judged against, and a bar that moved mid-session cannot " +
            "judge this claim either way. Retrying will not clear this: no amount of further " +
            "work fixes a bar that moved out from under it, and reverting a change this turn " +
            `did not make is not something to guess at. Say that it changed and stop — the ` +
            `person needs to settle ${BAR_PATH} before this can be judged again.`,
        durationMs: Date.now() - t0,
      };
      const rest = await runBar(bar, this.barContext(claim));
      return {
        ok: false,
        results: [tamper, ...rest.results],
        durationMs: Date.now() - t0,
      };
    }
    return this.markGuards(await runBar(bar, this.barContext(claim)));
  }

  /** The review's executable-objection runner, when `reviewExecutable` is on; else nothing. */
  private executableReview(): { executable?: ExecutableReview } {
    if (this.cfg.reviewExecutable !== true) return {};
    return { executable: { run: (command) => this.runObjection(command) } };
  }

  /**
   * Run one reviewer's objection command as a task check runs: in a throwaway
   * copy of the tree (src/scratch.ts), under bash, never past the turn's clock.
   * The command has already passed lint L15 (it does not change the work).
   *
   * Never on the work itself. A reviewer's command is written by a model that
   * read the task text, which may be anyone's, and it exists to probe the
   * work, not to protect it; the lint is a reading of the command, not a
   * guarantee. With no copy (a worktree's .git pointer, a tree over the copy
   * limits, MAAT_CHECK_COPY=0) the objection is not run and does not count:
   * "could not be run safely".
   */
  private async runObjection(command: string): Promise<ObjectionRun> {
    const tried = process.env.MAAT_CHECK_COPY === "0" ? { why: "MAAT_CHECK_COPY=0 turns throwaway copies off" } : await copyTreeOrWhy(this.cwd);
    if ("why" in tried) {
      return { code: null, stdout: "", stderr: "", notRun: `could not be run safely: no throwaway copy of the tree (${tried.why})` };
    }
    const copy = tried;
    try {
      const left = this.timeLeftMs();
      if (left !== undefined && left <= 0) {
        return { code: null, stdout: "", stderr: "", notRun: "the time budget is spent" };
      }
      const r = await runCommand(command, {
        cwd: copy.dir,
        shell: bashPath() ?? true,
        timeoutMs: left !== undefined ? Math.max(1, Math.min(30_000, left)) : 30_000,
        maxBuffer: 1024 * 1024,
        // The reviewer's command never sees Maat's credentials (credentialFreeEnv).
        env: credentialFreeEnv(process.env),
        signal: this.running?.signal,
      });
      const fix = (t: string) => copy.unmap(t);
      return { code: r.code, stdout: fix(r.stdout), stderr: fix(r.stderr), timedOut: r.timedOut, readsWork: readsTheWork(command, copy.dir) };
    } finally {
      await copy.cleanup();
    }
  }


  /** Executable mode: every objection that did not count, as an info line each. */
  private *unsubstantiated(review: Review | null): Generator<EngineEvent> {
    for (const o of review?.objections ?? []) {
      if (o.result === "demonstrated") continue;
      // The reviewer's command and its output can quote a hidden check.
      yield { kind: "info", text: this.maskWithheld(`objection not counted (reviewer ${o.vote}): ${objectionLine(o)}`) };
    }
  }

  /** Pass a turn's events through, and remove the pre-work copy however it ends. */
  private async *dropPreWorkTreeAfter(inner: AsyncGenerator<EngineEvent>): AsyncGenerator<EngineEvent> {
    try {
      yield* inner;
    } finally {
      // The post-work audit tries its checks on this copy after the turn's
      // events are over; it is removed when the job ends (runSealed).
      if (this.cfg.postWorkAudit !== true) {
        await this.preWorkTree?.cleanup();
        this.preWorkTree = null;
      }
    }
  }

  /**
   * Try checks that joined after the work began against the pre-work copy,
   * as sealCriteria tries the ones sealed up front. Without a copy they stay
   * untried, and an untried check cannot earn "verified".
   */
  private async tryLateBeforeWork(checks: readonly Check[], log?: Journal): Promise<void> {
    const tree = this.preWorkTree;
    if (!tree || !checks.length) return;
    const asTask = (n: string) => (n.startsWith("task:") ? n : `task:${n}`);
    // A check that names the project by its absolute path (Terminal-Bench's
    // /app/...) would read the finished tree, not the copy: its try says
    // nothing about the tree before the work. Not tried.
    const roots = [this.cwd, (() => { try { return realpathSync(this.cwd); } catch { return this.cwd; } })()];
    const named = (c: Check) => c.kind === "command" && roots.some((r) => r.length > 1 && c.run.includes(r));
    const absolute = checks.filter(named);
    const tryable = checks.filter((c) => !named(c));
    const passed: string[] = [];
    const failed: string[] = [];
    // The worker may have run by now, as this same uid, so the copy is
    // checked against the digest taken when it was made, before and after the
    // try. A copy that changed is not the tree before the work: nothing tried
    // on it counts (src/scratch.ts preWorkCopy).
    const intactBefore = tryable.length ? await tree.intact() : false;
    if (intactBefore) {
      this.running = new AbortController();
      if (this.cancelRequested) this.running.abort();
      try {
        await preflightCriteria(tryable, { cwd: tree.dir, signal: this.running.signal, passed, failed });
      } catch {
        return;
      } finally {
        this.running = undefined;
      }
    }
    const intact = intactBefore && (await tree.intact());
    if (!intact || absolute.length) {
      log?.append("note", {
        kind: "pre-work-try",
        text: !intact && tryable.length
          ? "the copy of the project taken before the work changed during the work: late checks count as not tried"
          : "late checks that name the project's absolute path read the finished tree: not tried before the work",
        late: true,
        untried: [...(!intact ? tryable : []), ...absolute].map((c) => asTask(c.name)),
        ...(!intact && tryable.length ? { tampered: true } : {}),
      });
    }
    if (!intact) return;
    // Golden files a late check diffs against: what they held before the work, read from the copy.
    for (const c of tryable) {
      if (c.kind !== "command") continue;
      const g = recordGoldens([{ run: c.run }], tree.dir);
      for (const [abs, digest] of g) {
        // Only files inside the copy: an absolute path outside it is read as
        // it is now, after the work, and proves nothing about before.
        const rel = relative(tree.dir, abs);
        if (rel.startsWith("..") || isAbsolute(rel)) continue;
        const key = join(this.cwd, rel);
        if (!this.goldensBefore.has(key)) this.goldensBefore.set(key, digest);
      }
    }
    this.passedBeforeWork = new Set([...this.passedBeforeWork, ...passed.map(asTask)]);
    this.failedBeforeWork = new Set([...this.failedBeforeWork, ...failed.map(asTask)]);
    log?.append("note", {
      kind: "pre-work-try",
      text: `late checks tried on the copy taken before the work: ${failed.length} failed, ${passed.length} passed`,
      late: true,
      failed: failed.map(asTask),
      passed: passed.map(asTask),
    });
  }

  /**
   * Run the post-work audit (src/post-audit.ts) on the pre-work copy kept for
   * it. Undefined, said once, when it cannot run: no copy, or no judge that is
   * another model than the worker (#32: a model never both finds and judges).
   */
  private async *runPostWorkAudit(task: string): AsyncGenerator<EngineEvent, AuditReport | undefined> {
    const log = this.cfg.journal;
    const judge = judgeTarget({ baseUrl: this.cfg.baseUrl, apiKey: this.cfg.apiKey, model: this.cfg.model });
    const skip = (why: string) => {
      log?.append("note", { kind: "post-work-audit", ran: false, text: `post-work audit skipped: ${why}` });
      return { kind: "info" as const, text: `post-work audit skipped: ${why}.` };
    };
    if (!independentOf({ kind: "judge", model: judge.model }, this.workerNames())) {
      yield skip(`the judge (${judge.model}) is the worker model; set --judge to another model`);
      return undefined;
    }
    const pre = this.preWorkTree;
    if (!pre) {
      yield skip("no copy of the project was taken before the work (too big to copy)");
      return undefined;
    }
    if (!(await pre.intact())) {
      yield skip("the copy of the project taken before the work has changed since, so nothing tried on it decides anything");
      return undefined;
    }
    yield { kind: "info", text: `post-work audit: ${judge.model} drafts checks from the task and the work's interface` };
    const now = Date.now();
    const turnEnd = this.deadlineAt();
    const deadlineAt = turnEnd === undefined ? now + 180_000 : Math.min(now + 180_000, Math.max(turnEnd, now + 45_000));
    this.running = new AbortController();
    let report: AuditReport;
    try {
      report = await postWorkAudit({
        task,
        workDir: this.cwd,
        preWorkDir: pre.dir,
        preWorkIntact: pre.intact,
        judge,
        fetchFn: this.cfg.fetchFn,
        acpSpawn: this.cfg.acpSpawn,
        reasoningEffort: judgeEffort(this.cfg.reasoningEffort),
        deadlineAt,
        signal: this.running.signal,
        // Masked like every hidden check while it runs, released below.
        onCheck: (c) => this.withholdText(`audit:${c.name}`, c.run),
      });
    } catch (e) {
      log?.append("note", { kind: "post-work-audit", ran: false, text: `post-work audit failed: ${errorText(e)}` });
      yield { kind: "info", text: `post-work audit could not run: ${errorText(e)}` };
      return undefined;
    } finally {
      this.running = undefined;
      this.releaseWithheld();
    }
    log?.append("note", {
      kind: "post-work-audit",
      ran: true,
      text: `post-work audit by ${report.judge}: ${report.drafted} drafted, ${report.dropped.length} dropped, ${report.accepted.length} cleared every gate`,
      judge: report.judge,
      viewSha: createHash("sha256").update(report.view).digest("hex").slice(0, 16),
      changed: report.changed.map((c) => c.path),
      dropped: report.dropped,
      mutants: report.mutants,
      checks: report.checks.map((c) => ({
        name: `audit:${c.name}`,
        run: c.run,
        sha256: commandSha(c.run),
        quote: c.quote,
        accepted: c.accepted,
        ...(c.rule ? { rule: c.rule, why: c.why } : {}),
        ...(c.work ? { work: c.work } : {}),
        ...(c.preWork ? { preWork: c.preWork } : {}),
        ...(c.mutants ? { mutantsKilled: c.mutants.killed, mutantsTotal: c.mutants.total, mutantsCrashedOnly: c.mutants.crashedOnly } : {}),
      })),
      ...(report.error ? { error: report.error } : {}),
    });
    if (report.error) yield { kind: "info", text: `post-work audit: ${report.error}` };
    else if (!report.accepted.length) {
      const why = report.checks.map((c) => `${c.name}: ${c.why}`).concat(report.dropped.map((d) => `${d.name}: ${d.why}`));
      yield { kind: "info", text: `post-work audit: no check cleared every gate${why.length ? ` (${why.join("; ")})` : " (the judge drafted none)"}` };
    }
    return report;
  }

  /** tierOf's advisory-review argument: empty unless `reviewAdvisory`. */
  private advisoryTier(): { reviewAdvisory?: true; requireDiscriminating?: true } {
    return {
      ...(this.cfg.reviewAdvisory === true ? { reviewAdvisory: true as const } : {}),
      ...(this.cfg.requireDiscriminating === true ? { requireDiscriminating: true as const } : {}),
    };
  }

  /** Who wrote each sealed check, keyed by the name it runs under in the bar (and its bare name). */
  private sealedAuthors(): Map<string, CheckAuthor> {
    const m = new Map<string, CheckAuthor>();
    for (const c of this.sealedChecks) {
      const a = withAuthor(c, this.cfg.model).author!;
      m.set(c.name, a);
      if (!c.name.startsWith("task:")) m.set(`task:${c.name}`, a);
    }
    return m;
  }

  /** Failing checks written by someone independent of the worker (judge, reference, person): their names. */
  private independentFailing(failing: readonly CheckResult[]): string[] {
    const authors = this.sealedAuthors();
    const workers = this.workerNames();
    return failing
      .filter((r) => {
        const a = authors.get(r.name);
        return a !== undefined && independentOf(a, workers);
      })
      .map((r) => r.name);
  }

  /** The worker under every name it ran as: the configured id and the one the backend reported. */
  private workerNames(): string[] {
    return [...new Set([this.cfg.model, this.modelOfRecord()].filter((m): m is string => typeof m === "string" && m.trim().length > 0))];
  }

  /** Everything tierOf weighs beside the results: advisory mode, the worker, who wrote each check, what the pre-work try found, which golden files predate the work, and which passes the worker arranged. */
  private tierContext(results: readonly CheckResult[]): {
    reviewAdvisory?: true;
    requireDiscriminating?: true;
    guards: ReadonlySet<string>;
    failedBefore: ReadonlySet<string>;
    worker: string[];
    authors: Map<string, CheckAuthor>;
    valueUnproven: Set<string>;
    discounted: Map<string, string>;
  } {
    const authors = this.sealedAuthors();
    // What of the passing checks the worker arranged rather than earned
    // (control.ts): read off the tree as it stands at the claim.
    const discounted = discountedChecks(results, {
      cwd: this.cwd,
      before: this.turnTree,
      written: this.turnLedger().map((e) => e.path),
      authors,
    });
    return {
      ...this.advisoryTier(),
      guards: this.passedBeforeWork,
      failedBefore: this.failedBeforeWork,
      worker: this.workerNames(),
      authors,
      valueUnproven: valueUnproven(this.sealedChecks.map((c) => ({ name: c.name, run: c.kind === "command" ? c.run : undefined, tags: c.tags })), this.cwd, this.goldensBefore),
      discounted,
    };
  }

  /** The receipt's authorship map: sealed checks by bar name, as recorded. */
  private receiptAuthors(): Record<string, CheckAuthor> {
    return Object.fromEntries(this.sealedAuthors());
  }

  /**
   * See `passedBeforeWork` and `failedBeforeWork`. Only a passing command
   * criterion is relabelled; every sealed task check is stamped with how it
   * fared on the tree before the work, for the receipt.
   */
  private markGuards(result: BarResult): BarResult {
    if (this.sealedChecks.length === 0 && this.passedBeforeWork.size === 0) return result;
    const sealed = new Set(this.sealedChecks.map((c) => (c.name.startsWith("task:") ? c.name : `task:${c.name}`)));
    return {
      ...result,
      results: result.results.map((r) => {
        const beforeWork: CheckResult["beforeWork"] = this.passedBeforeWork.has(r.name)
          ? "passed"
          : this.failedBeforeWork.has(r.name)
            ? "failed"
            : sealed.has(r.name)
              ? "untried"
              : undefined;
        const stamped = beforeWork ? { ...r, beforeWork } : r;
        return r.ok && r.kind === "command" && this.passedBeforeWork.has(r.name)
          ? {
              ...stamped,
              established: false,
              output:
                "passed before the work began too, so it guards against a regression and " +
                "does not show this task was done · " +
                r.output,
            }
          : stamped;
      }),
    };
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
    /**
     * This backend has no endpoint to post to.
     *
     * `salvage` was the last path still speaking HTTP on it. The base URL is
     * `grok-build://subscription`, which `fetch` refuses outright, so every
     * ceiling in this loop — the deadline, the budget, the spending ceiling,
     * the step limit, a provider that gave up — ended with the safety net
     * throwing into the journal and nothing at all reaching the reader. The
     * one request whose entire job is to rescue a stopped turn cannot be the
     * one request that goes a way this backend cannot go.
     */
    if (this.subprocess) {
      yield* this.subprocessSalvage(reason, log);
      return;
    }
    // Cancellable, like every other request. It was not, and that made molt
    // unquittable at the worst moment: hitting the budget runs a salvage, and
    // a salvage that cannot be aborted holds the turn open with no way out —
    // ctrl+C reached a controller that had already been cleared. A safety net
    // you cannot climb out of is a trap.
    const controller = new AbortController();
    this.inFlight = controller;
    // Watched like any other request. The salvage is what runs after a
    // provider has already failed, which is exactly when it is most likely
    // to be hung — and a closing summary that never returns is a turn that
    // never closes.
    const idle = requestIdleMs(this.cfg.requestIdleMs);
    const watch = new Watchdog(controller.signal, {
      firstByteMs:
        this.cfg.requestFirstByteMs ??
              envFirstByteMs() ??
        firstByteMs(idle, {
          promptTokens: Math.round(this.bom().requestTotalEst * this.tokenScale),
          maxTokens: this.maxTokensFor(),
          stream: false,
        }, isSelfHosted(this.cfg.baseUrl) ? localSpeed() : undefined),
      idleMs: idle,
      // Under a time budget, bounded by it plus a short grace: a salvage
      // waits on the same provider that may just have hung.
      deadlineAt: this.salvageDeadlineAt(),
    });
    try {
      // The salvage is a request like any other, so it speaks whichever
      // protocol the rest of the turn spoke — sending it to the OpenAI path
      // while the session ran on the native one would fail the one request
      // whose entire job is to rescue a turn that already went wrong.
      const wire = this.transcript.wire();
      const res = watch.watch(await fetchFn(this.endpoint, {
        method: "POST",
        signal: watch.signal,
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
                maxTokens: this.maxTokensFor(),
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
                tools: this.offeredTools,
                tool_choice: "none",
              },
        ),
      }));
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
          "the answer below was written after Maat stopped the turn. It was NOT checked " +
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
      } else if (watch.reason === "idle") {
        log?.append("error", { text: `salvage failed: no response in ${waited(watch.waitedMs)}` });
        yield {
          kind: "info",
          text:
            `could not write a closing summary — the provider sent nothing for ` +
            `${waited(watch.waitedMs)} — the work above is all there is`,
        };
      } else {
        log?.append("error", { text: `salvage failed: ${errorText(e)}` });
      }
    } finally {
      watch.dispose();
      this.inFlight = undefined;
    }
  }

  /**
   * The same last word, asked the way this backend is asked.
   *
   * Everything the HTTP salvage does, minus the request: one message, no
   * tools, the answer labelled as notes rather than as a completion, and the
   * tokens counted against the session so the meter still adds up. What it
   * cannot do is stream — the HTTP salvage does not either, and yielding the
   * deltas as well as the text below is how the closing answer would print
   * twice.
   */
  private async *subprocessSalvage(
    reason: string,
    log?: Journal,
  ): AsyncGenerator<EngineEvent> {
    let cc: BackendSession<EngineEvent>;
    try {
      cc = await this.subprocessSession();
    } catch (e) {
      log?.append("error", { text: `salvage failed: ${errorText(e)}` });
      yield {
        kind: "info",
        text: "could not write a closing summary — the work above is all there is",
      };
      return;
    }

    /**
     * Everything molt has said that the ACP agent has not been told yet.
     *
     * The salvage prompt, and whatever a ceiling pushed just before it. Same
     * rule the ACP step uses, so the two conversations do not drift apart
     * on the last message of the turn.
     */
    const pending = this.transcript
      .all()
      .filter((m) => m.role === "user" && !this.ccForwarded.has(m));
    for (const m of pending) this.ccForwarded.add(m);
    const texts = pending.map((m) => m.content ?? "").filter((t) => t.trim().length > 0);
    if (!texts.length) return;

    let done:
      | { text: string; promptTokens: number; completionTokens: number; error?: string; stopped?: "deadline" | "stall" }
      | undefined;
    /** The last answer that called nothing, in case `done` carries no text. */
    let last = "";
    this.ccNoTools = true;
    try {
      for await (const ev of cc.send([texts.join("\n\n")], { deadlineAt: this.salvageDeadlineAt(), stallMs: this.stallMs() })) {
        if (ev.kind === "done") done = ev;
        else if (ev.kind === "assistant" && !ev.toolCalls.length && ev.text) last = ev.text;
      }
    } catch (e) {
      // A courtesy that failed must not mask the real stop. The session is
      // started lazily inside `send`, so a missing optional dependency throws
      // here rather than above — and an exception escaping a salvage would
      // take down the turn it exists to close.
      log?.append("error", { text: `salvage failed: ${errorText(e)}` });
      yield {
        kind: "info",
        text: "could not write a closing summary — the work above is all there is",
      };
      return;
    } finally {
      this.ccNoTools = false;
    }

    if (done?.stopped) {
      // Cut by the clock or a stall: the agent was cancelled and killed, and
      // the next turn starts a fresh session.
      await this.dropAcpSession();
      log?.append("note", { text: `salvage not written: ${done.error ?? done.stopped}`, ...(done.stopped === "stall" ? { providerIssue: true, providerStall: true } : {}) });
      yield { kind: "info", text: "could not write a closing summary — the work above is all there is" };
      return;
    }
    if (!done || done.error) {
      // A session that vanished mid-salvage was cancelled, not broken:
      // `cancel()` ends it, because ending it is the only way to stop the
      // subprocess. Reporting that as a failure would blame molt for doing
      // what it was told.
      const cancelled = !this.cc;
      log?.append(cancelled ? "cancelled" : "error", {
        text: cancelled
          ? "salvage cancelled"
          : `salvage failed: ${done?.error ?? `the ${this.backendLabel} session ended without answering`}`,
      });
      yield {
        kind: "info",
        text: cancelled
          ? "cancelled — no closing summary was written"
          : "could not write a closing summary — the work above is all there is",
      };
      return;
    }

    this.sessionPrompt += done.promptTokens;
    this.sessionCompletion += done.completionTokens;
    // A subscription run is not metered, so this is unbilled like every other
    // step on this backend. Counted, so `billed` cannot come out true.
    this.unbilledSteps += 1;
    const text = (done.text || last).trim();
    log?.append("salvage", {
      reason,
      promptTokens: done.promptTokens,
      completionTokens: done.completionTokens,
      chars: text.length,
    });
    if (!text) return;
    yield {
      kind: "info",
      text:
        "the answer below was written after Maat stopped the turn. It was NOT checked " +
        "against the bar — treat it as notes, not as a completed task.",
    };
    yield { kind: "assistant_text", text: redact(text, this.secrets()) };
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
    endedBy?: "deadline" | "provider" | "no-progress" | "malformed",
  ): AsyncGenerator<EngineEvent> {
    const onlyWrites = failedOnlyWriteChecks(result);
    if (this.cfg.receipts) {
      const receipt = this.cfg.receipts.write({
        claim,
        result,
        attempt: attempts,
        verdict: "exhausted",
        model: this.modelOfRecord(),
        provider: this.provider,
        sessionTokens: this.sessionTokens,
        shedBatches: this.transcript.shedCount,
        ...(endedBy ? { endedBy } : {}),
      });
      log?.append("receipt", { verdict: "exhausted", file: receipt.path, attempt: attempts });
      this.bindReceipt(receipt.path, "exhausted");
      this.capture(receipt.path, "exhausted", this.transcript.record().find((m) => m.role === "user")?.content ?? "", result, claim);
      yield { kind: "receipt", path: receipt.path };
    }
    log?.append("session_end", { reason: "bar not met", attempts });
    yield { kind: "proof_exhausted", result, attempts };
    yield {
      kind: "error",
      text: onlyWrites
        ? `bar not met: ${onlyWrites} requires this turn to have changed a file, and none ` +
          `changed. Maat is reporting failure rather than success. Either the work was not ` +
          `done, or this was a question — ask questions with /ask, or a leading "?", which ` +
          `runs the rest of the bar and drops that one check.`
        : `bar not met after ${attempts} attempt${attempts === 1 ? "" : "s"}. Maat is reporting failure rather ` +
          `than success. See .maat/receipts/ for what was checked.`,
    };
    yield* this.settleFailed(log);
  }

  /**
   * Photograph the working tree before the turn touches it.
   *
   * Only when a revert could actually happen: two git calls are nothing
   * beside a model round trip, but a policy that is switched off should cost
   * exactly zero.
   */
  private async captureTree(): Promise<void> {
    this.turnSnapshot = null;
    this.turnSnapshotPaths = new Set();
    if (!this.gitPolicy.restoreOnFail) return;
    if (!(await isRepo(this.cwd))) return;
    const ref = await snapshot(this.cwd);
    if (!ref) return;
    this.turnSnapshot = ref;
    this.turnSnapshotPaths = await pathsIn(this.cwd, ref);
  }

  /**
   * The bar was met: keep the change.
   *
   * The commit carries the receipt's name and the checks that passed, so
   * `git log` makes the same claim the receipt does and can be followed back
   * to the evidence. Only the paths this turn wrote are staged — never `-A`,
   * never another session's work.
   */
  private async *settlePassed(
    task: string,
    attempts: number,
    checks: string[],
    receipt: string | undefined,
    log?: Journal,
  ): AsyncGenerator<EngineEvent> {
    if (!this.gitPolicy.commitOnPass) return;
    const paths = [...new Set(this.turnWrites.map((w) => w.path))].sort();
    // A turn that wrote nothing and passed is a question that was answered.
    // There is nothing to commit and nothing to say about it.
    if (!paths.length) return;
    if (!(await isRepo(this.cwd))) {
      yield { kind: "info", text: "verified, but this is not a git repository — nothing to commit to." };
      return;
    }
    const r = await commitPaths(
      this.cwd,
      paths,
      commitMessage({ task, receipt, checks, attempts, session: this.cfg.journal?.sessionId }),
    );
    if (!r.ok) {
      log?.append("note", { text: `commit skipped: ${r.reason}` });
      yield { kind: "info", text: `not committed: ${r.reason}` };
      return;
    }
    log?.append("git_commit", {
      sha: r.sha,
      files: r.files.length,
      receipt: receipt ?? "",
      checks: checks.join(", "),
    });
    yield {
      kind: "info",
      text:
        `committed ${r.sha.slice(0, 8)} · ${r.files.length} file(s) · the receipt is named in ` +
        `the message · /undo takes the commit back and keeps the work`,
    };
  }

  /**
   * The bar was not met: put the tree back where the turn found it.
   *
   * The evidence is deliberately untouched — receipts, the journal and the
   * integrity ledger live under `.maat/`, which no turn writes through the
   * tools, so what happened survives the code being reverted. Undoing the
   * work must never undo the record of it.
   */
  private async *settleFailed(log?: Journal): AsyncGenerator<EngineEvent> {
    if (!this.gitPolicy.restoreOnFail) return;
    if (!this.turnWrites.length) return;
    if (!this.turnSnapshot) {
      yield {
        kind: "info",
        text:
          "not restored: no pre-turn snapshot exists, so there is nothing to put the files " +
          "back to. They are as the turn left them.",
      };
      return;
    }
    const plan = revertPlan(this.turnWrites, (p) => this.turnSnapshotPaths.has(p));
    const done = await restoreFiles(this.cwd, this.turnSnapshot, plan);
    this.turnRestored = done.restored.length + done.removed.length > 0;
    log?.append("git_restore", {
      restored: done.restored.length,
      removed: done.removed.length,
      kept: done.kept.length,
      failed: done.failed.length,
    });
    const parts: string[] = [];
    if (done.restored.length) parts.push(`${done.restored.length} put back`);
    if (done.removed.length) parts.push(`${done.removed.length} removed`);
    if (done.kept.length) {
      parts.push(`${done.kept.length} left alone (git had no copy to restore)`);
    }
    if (done.failed.length) parts.push(`${done.failed.length} could not be restored`);
    yield {
      kind: "info",
      text:
        `the bar was not met, so the tree is back where the turn found it: ` +
        `${parts.join(" · ") || "nothing to undo"}. The receipt and the journal are untouched.`,
    };
  }

  /**
   * One file per attempt with everything a verdict was made from, for
   * training the safeguard. Written beside the receipt, never instead of it,
   * and never on the model's screen — a capture is a record, not a result.
   */
  private capture(
    receiptPath: string,
    verdict: string,
    task: string,
    result: BarResult,
    claim: string,
  ): void {
    const dir = this.cfg.captureDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const name = `${this.cfg.journal?.sessionId ?? "nosession"}-${basename(receiptPath).replace(/\.md$/, "")}.json`;
      const body = {
        version: 1,
        generatedAt: new Date().toISOString(),
        session: this.cfg.journal?.sessionId ?? null,
        receipt: basename(receiptPath),
        verdict,
        model: this.modelOfRecord(),
        provider: this.provider,
        task,
        claim,
        // What the model wrote, broken arguments included: the repair in
        // wire() is for the provider, and a model's broken JSON is exactly
        // what a training record must keep.
        transcript: this.transcript.wire({ repairArgs: false }),
        ledger: this.sessionLedger(),
        turnLedger: this.turnLedger(),
        did: [...this.did],
        result,
        sessionTokens: this.sessionTokens,
        costUsd: this.costUsd() ?? null,
        costEstimated: this.costEstimated,
      };
      writeFileSync(join(dir, name), redact(JSON.stringify(this.maskEvent(body), null, 1), this.secrets()), "utf8");
    } catch {
      // A capture that could not be written is a training example lost, not a
      // turn broken. The receipt and the journal still hold the verdict.
    }
  }

  /**
   * Bind a written receipt into the integrity chain.
   *
   * The receipt file's own sha256 is bound together with the journal's root
   * at the moment of writing, so later edits to the receipt (or the journal
   * turning out to have been edited) show up as drift in `Integrity.verify`
   * — independently of the journal's own chain.
   */
  private bindReceipt(file: string, verdict: string): void {
    if (!this.cfg.integrity || !this.cfg.journal) return;
    // `Receipts.write` returns the receipt's FULL path. Joining it onto
    // `.maat/receipts` again produced a path that does not exist, so the sha
    // came out empty and was bound as empty — and an empty bound hash was
    // skipped by the verifier, which is how a receipt could be rewritten
    // afterwards and still verify clean. Hash the file that is really there,
    // and record the bare name, which is what the receipts index uses and
    // what survives the project being moved.
    const path = isAbsolute(file) ? file : stateDir(this.cwd, "receipts", file);
    const sha = existsSync(path) ? sha256Of(path) ?? "" : "";
    this.cfg.integrity.append({
      kind: "receipt",
      session: this.cfg.journal.sessionId,
      receiptFile: basename(file),
      receiptSha: sha,
      journalRoot: this.cfg.journal.chainRoot(),
      verdict,
    });
  }

  /** Run the bar without touching the loop — backs the /prove command. */
  async proveNow(claim?: string): Promise<BarResult | null> {
    if (!this.cfg.bar) return null;
    // Standalone means no turn has run in this engine: no snapshot, nothing
    // written. After a turn, a prove is a re-judgement of that turn and every
    // builtin has something to read.
    this.standalone = this.turnTree === null && this.ledger.length === 0 && this.archivedWrites === 0;
    try {
      return await this.runBarGuarded(claim);
    } finally {
      this.standalone = false;
    }
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
    this.cancelRequested = false;
    this.turnActive = true;
    try {
      yield* this.runSealedTurn(userText, confirm, opts, job, startedAt);
    } finally {
      // A turn that threw or was abandoned still releases what it withheld.
      this.releaseWithheld();
      await this.preWorkTree?.cleanup();
      this.preWorkTree = null;
      this.turnActive = false;
      this.cancelRequested = false;
    }
  }

  private async *runSealedTurn(
    userText: string,
    confirm: Confirm,
    opts: RunOptions,
    job: number,
    startedAt: number,
  ): AsyncGenerator<EngineEvent> {
    const before = this.meter();
    this.turnStartedAt = startedAt;
    this.turnWrites = [];
    this.turnAllRetired = false;
    this.turnRevealed = [];
    this.turnEndedBy = undefined;
    this.malformedStreak = 0;
    this.turnProviderStall = false;
    this.turnRestored = false;
    this.refusedThisTurn = false;
    this.turnReview = undefined;
    this.reviewSkipped = undefined;
    this.sealedChecks = [];
    this.sealedNotes = [];
    this.turnCalls = new Set();
    this.turnTaskPaths = taskPathsIn(userText);
    this.turnHidesChecks = false;
    // molt's records stay out of the project's `git status` (leftovers.ts).
    excludeMoltFromGit(this.cwd);
    // Per turn, or receipt five lists what turn one ran. It did: receipts
    // 0043–0047 of this project each open with the same three reads.
    this.did = [];
    this.turnSignOut = undefined;
    await this.captureTree();
    this.turnTree = snapshotTree(this.cwd);
    let steps = 0;
    let cancelled = false;
    let errored = false;
    let exhausted = false;
    let proven = false;
    let answered = false;

    yield { kind: "job_start", job, text: userText };
    this.pinTask(userText, undefined, true);

    let receiptPath: string | undefined;
    let exhaustedResult: BarResult | undefined;
    let lastProof: BarResult | undefined;
    for await (const ev of this.dropPreWorkTreeAfter(this.runTurn(userText, confirm, job, opts))) {
      switch (ev.kind) {
        case "receipt":
          receiptPath = ev.path;
          break;
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
          exhaustedResult = ev.result;
          break;
        case "proof_result":
          proven = true;
          lastProof = ev.result;
          break;
        case "assistant_text":
          answered = true;
          break;
      }
      yield ev;
    }

    // The work is over; nothing the worker does from here can change the
    // verdict, so the hidden commands may now be written (src/withhold.ts).
    const released = this.releaseWithheld();
    if (released) yield released;

    // Order matters: a bar that was never met is "not proven" even though an
    // error event follows it, and an answer nothing checked is never
    // "verified" — the distinction molt exists to make.
    let outcome: JobOutcome = cancelled
      ? "cancelled"
      : exhausted
        ? "not proven"
        : errored && !(this.turnEndedBy && proven)
          ? "error"
          : proven
            ? opts.ask && this.turnWrites.length === 0
              ? "answered"
              : "verified"
            : answered || this.turnEndedBy === "deadline" || this.turnEndedBy === "no-progress"
              ? "unverified"
              : "stopped";

    // Checks that passed on a tree the model was STOPPED on — by the clock or
    // a failed provider — never make "verified": the model never said the work
    // was done. On Mercury 2.5 that is exactly where the false verifieds came
    // from: log-summary, sql-top-customers and cron-next each ran out the
    // clock half-finished, the drafted checks passed on what was there, and
    // the grader failed all three. The pass is kept on the record
    // (passedAtEnd) — it is information — but the outcome is unverified.
    const passedAtEnd = outcome === "verified" && this.turnEndedBy !== undefined;
    if (passedAtEnd) {
      outcome = "unverified";
      yield {
        kind: "info",
        text: `the checks passed on the work as it stood when the ${this.turnEndedBy === "deadline" ? "clock" : this.turnEndedBy === "no-progress" ? "no-progress guard" : this.turnEndedBy === "malformed" ? "malformed-call limit" : "provider"} stopped the model, but it never said it was done — unverified.`,
      };
    }

    // Refused only by checks the model drafted for itself. On the local suite
    // such a refusal was right about one time in five: 19 of 23 "not proven"
    // runs had passed the grader, the checks having miscounted, misread a
    // rule or broken on macOS. "Not proven" says the work failed; what is
    // known is that molt's own checks disagree with it. Said as that, so
    // "not proven" keeps its meaning for checks a person wrote. The exit
    // code is unchanged: the work is not accepted either way.
    const failing = exhaustedResult?.results.filter((r) => !r.ok && !r.advisory && !r.skipped) ?? [];
    const checksDisagree =
      outcome === "not proven" && failing.length > 0 && failing.every((r) => r.hidden === true);
    if (checksDisagree) {
      outcome = "unverified";
      yield {
        kind: "info",
        text:
          `unverified: Maat's own drafted checks (${failing.map((r) => r.name).join(", ")}) disagree with ` +
          `the work. Drafted checks are often wrong; nothing here shows the work is.`,
      };
    }

    // "verified" against checks the model drafted for itself, with no project
    // bar and no check a person chose, is a weaker claim than it sounds. On
    // Terminal-Bench one in three such "verified" turns failed the hidden
    // tests. The outcome keeps its name so every surface still works; this
    // says what stood behind it.
    const selfChecked =
      !this.cfg.bar &&
      this.sealedChecks.length > 0 &&
      this.sealedChecks.every((c) => c.hidden === true);
    // The independent review: a label on a verified claim, never a gate.
    let review: Review | null = null;
    // Set by runTurn (TypeScript cannot see that through the generator).
    const inTurn = this.turnReview as Review | null | undefined;
    if (outcome === "verified" && this.cfg.review && inTurn !== undefined) {
      // Reviewed inside the turn, and nothing changed after.
      review = inTurn;
      this.cfg.journal?.append("review", review ? { confirmed: review.confirmed, votes: review.votes, violations: review.violations.length, ...(review.objections ? { objections: review.objections } : {}) } : { ran: false });
      if (review && !review.confirmed) {
        yield { kind: "info", text: `passed its checks, unconfirmed: the reviewer (${review.votes}) found ` + review.violations.map((v) => `"${v.quote}" — ${v.evidence}`).join("; ") };
      }
    } else if (outcome === "verified" && this.cfg.review && !this.turnEndedBy && this.reviewSkipReason()) {
      this.reviewSkipped = this.reviewSkipReason();
      this.cfg.journal?.append("review", { ran: false, skipped: this.reviewSkipped });
      yield { kind: "info", text: `skipping the independent review: ${this.reviewSkipped}. The claim stands as checked, unreviewed.` };
    } else if (outcome === "verified" && this.cfg.review && !this.turnEndedBy && receiptPath && existsSync(receiptPath)) {
      yield { kind: "info", text: "reviewing the claim independently against the task text" };
      review = await reviewClaim({
        task: userText,
        receipt: readFileSync(this.cfg.receipts?.fullPath(receiptPath) ?? receiptPath, "utf8"),
        votes: this.cfg.review.votes,
        ask: {
          ...judgeTarget({ baseUrl: this.cfg.baseUrl, apiKey: this.cfg.apiKey, model: this.cfg.model }),
          cwd: this.cwd,
          reasoningEffort: judgeEffort(this.cfg.review.reasoningEffort ?? this.cfg.reasoningEffort),
          fetchFn: this.cfg.fetchFn,
          acpSpawn: this.cfg.acpSpawn,
          // Never longer than the turn has left: a review that outlives the clock ends it without a verdict.
          ...(this.timeLeftMs() !== undefined ? { timeoutMs: Math.max(1_000, this.timeLeftMs()!) } : {}),
          // And every retry and pause inside it, not just one ask.
          deadlineAt: this.deadlineAt(),
        },
        ...this.executableReview(),
      }).catch(() => null);
      this.cfg.journal?.append("review", review ? { confirmed: review.confirmed, votes: review.votes, violations: review.violations.length, ...(review.objections ? { objections: review.objections } : {}) } : { ran: false });
      if (review?.objections && receiptPath) this.cfg.receipts?.amendReview(basename(receiptPath), review.objections);
      yield* this.unsubstantiated(review);
      if (!review) {
        yield { kind: "info", text: "the independent review could not be run; the claim stands as checked" };
      } else if (!review.confirmed) {
        yield {
          kind: "info",
          text:
            `passed its checks, unconfirmed: the reviewer (${review.votes}) found ` +
            review.violations.map((v) => `"${v.quote}" — ${v.evidence}`).join("; "),
        };
      }
    }
    // The scale did not settle this one: it goes to the person (judgment.ts).
    const reason = caseReason({
      outcome,
      checksDisagree: checksDisagree ? failing.map((r) => r.name) : undefined,
      review: review ?? undefined,
      wrote: this.turnWrites.length > 0,
      allRetired: this.turnAllRetired,
      onlyNothingChanged: failing.length > 0 && failing.every((r) => r.kind === "builtin" && r.detail === "files-changed"),
    });
    let opened: number | undefined;
    if (reason && this.cfg.judgment !== false) {
      try {
        const c = new Judgments(this.cwd).open({
          session: this.cfg.journal?.sessionId,
          job,
          model: this.cfg.model,
          task: userText,
          outcome,
          reason,
          checks: failing.map((r) => ({ name: r.name, detail: r.detail, output: r.output, drafted: r.hidden === true })),
          ...(review && !review.confirmed ? { violations: review.violations } : {}),
          ...(receiptPath ? { receipt: receiptPath } : {}),
          files: this.turnWrites.map((w) => w.path),
          ...(this.turnRestored ? { restored: true } : {}),
        });
        opened = c.n;
        this.cfg.journal?.append("judgment", { case: c.n, opened: reason, outcome, checks: c.checks.map((k) => k.name), files: c.files.length });
        yield { kind: "info", text: `awaiting your judgment: case ${c.n} — ${reasonText(reason)}.` };
      } catch {
        // The record of a case is never worth failing the turn over.
      }
    }
    // The word "verified" is earned by evidence, the same on every model: a
    // passing check that ran the deliverable and asserted a value (or one a
    // person wrote), and no reviewer contradiction. Measured, that class was
    // right 7/7 where everything else carrying the word was right 28/50. What
    // passed without earning it is reported as what it is. After the judgment
    // case above, which is opened on what the reviewers said.
    let tier: Tier | undefined;
    let tierReason: string | undefined;
    let claim: string | undefined;
    if (outcome === "verified" && lastProof) {
      // Review was asked for and did not run (skipped near the deadline, or a
      // nudge cleared it and no re-review followed): no "verified". On v11, 6
      // of the 7 "verified" claims were unreviewed this way and 4 were wrong.
      const unreviewed = this.cfg.review !== undefined && !review;
      const t = tierOf({ results: lastProof.results, review, unreviewed, ...this.tierContext(lastProof.results) });
      tier = t.tier;
      if (t.tier === "passed-checks") {
        outcome = "unverified";
        tierReason = t.reason;
        yield { kind: "info", text: `passed its checks (not verified: ${t.reason}).` };
      } else if (t.tier === "passed-own-checks") {
        // The model that did the work wrote every check that could have
        // proved it: a model never both finds and judges. Not verified, and
        // the exit code is unverified's.
        outcome = "unverified";
        tierReason = t.reason;
        claim = claimLabel(outcome, t);
        yield { kind: "info", text: `${claim}: ${t.reason}. Use --judge <another model>, or approve the checks yourself, for "verified".` };
      } else if (t.tier === "passed-untested") {
        // Independent checks passed, but every one of them passed on the
        // untouched tree too or was never tried there: they guard against a
        // regression and cannot tell this work from none.
        outcome = "unverified";
        tierReason = t.reason;
        claim = claimLabel(outcome, t);
        yield { kind: "info", text: `${claim}: ${t.reason}.` };
      } else {
        claim = claimLabel(outcome, t);
      }
      if (receiptPath) this.cfg.receipts?.amendTier(basename(receiptPath), { ...t, ...(claim ? { claim } : {}) });
      this.cfg.journal?.append("note", {
        text: `tier: ${t.tier}`,
        evidence: t.evidence,
        ...(t.basis ? { basis: t.basis } : {}),
        ...(t.by?.length ? { by: t.by } : {}),
        ...(claim ? { claim } : {}),
        ...(t.reason ? { reason: t.reason } : {}),
        ...(t.reviewNote ? { review: t.reviewNote } : {}),
      });
    }
    // The post-work audit (opt-in): a claimed turn the sealed checks did not
    // verify gets checks an independent judge drafts from the task and the
    // work's interface, each gated on the work, the pre-work copy and mutants.
    let audit: AuditReport | undefined;
    const auditable =
      this.cfg.postWorkAudit === true &&
      !opts.ask &&
      !cancelled &&
      !this.turnEndedBy &&
      // A claim the sealed checks did not verify: they passed without earning the
      // word, only drafted checks refused it, or nothing checked it. Never one a
      // person's or the project's check refused ("not proven"), or an error.
      outcome === "unverified" &&
      // A reviewer that found the claim contradicts the task is not overruled here.
      contradictions(review) === 0 &&
      // Nor is a sealed check someone other than the worker wrote (a judge, a
      // reference) that still fails on this work: an audit check on another
      // property passing beside it is no answer to that failure.
      this.independentFailing(failing).length === 0;
    if (auditable) {
      audit = yield* this.runPostWorkAudit(userText);
      if (audit?.accepted.length) {
        outcome = "verified";
        tier = "verified-audit";
        tierReason = undefined;
        claim = auditClaim(audit.judge);
        yield { kind: "info", text: `${claim}: ${audit.accepted.map((n) => `\`audit:${n}\``).join(", ")} passed on the work, failed before it, and failed on a mutant of the changed code.` };
        if (receiptPath) this.cfg.receipts?.amendTier(basename(receiptPath), { tier: "verified-audit", claim });
        this.cfg.journal?.append("note", { text: "tier: verified-audit", claim, by: [audit.judge], accepted: audit.accepted.map((n) => `audit:${n}`) });
      }
    }
    yield {
      kind: "job_end",
      job,
      steps,
      spend: this.spendSince(before),
      durationMs: Date.now() - startedAt,
      outcome,
      ...(tier ? { tier, ...(tierReason ? { tierReason } : {}) } : {}),
      ...(claim ? { claim } : {}),
      ...(audit ? { audit: { judge: audit.judge, drafted: audit.drafted, grounded: audit.drafted - audit.dropped.length, accepted: audit.accepted.map((n) => `audit:${n}`), ...(audit.error ? { error: audit.error } : {}) } } : {}),
      ...(this.sealedChecks.length ? { checkAuthors: Object.fromEntries(this.sealedChecks.map((c) => [c.name.startsWith("task:") ? c.name : `task:${c.name}`, authorKey(withAuthor(c, this.cfg.model).author!)])) } : {}),
      ...(selfChecked ? { selfChecked: true } : {}),
      ...(this.reviewSkipped ? { unreviewed: true } : {}),
      ...(this.turnEndedBy ? { endedBy: this.turnEndedBy, ...(this.turnEndedBy === "deadline" ? { deadline: true } : {}) } : {}),
      ...(passedAtEnd ? { passedAtEnd: true } : {}),
      ...(this.turnProviderStall ? { providerStall: true } : {}),
      ...(checksDisagree ? { checksDisagree: failing.map((r) => r.name) } : {}),
      ...(outcome === "verified" && this.turnRevealed.length ? { revealed: [...this.turnRevealed] } : {}),
      ...(review ? { review: { confirmed: review.confirmed, votes: review.votes, violations: review.violations, ...(review.objections ? { objections: review.objections } : {}) } } : {}),
      ...(opened !== undefined ? { case: opened } : {}),
    };
  }

  /**
   * The git-tracked project files the revealed checks' commands name: fixtures
   * the check reads, which the model did not create. Committing one after the
   * reveal is bentAfterReveal's git case. Untracked names are the model's own
   * output and stay free.
   */
  private revealedTargets(commands: string[]): string[] {
    let tracked: Set<string>;
    try {
      tracked = new Set(
        gitSync(["ls-files"], this.cwd)
          .split("\n")
          .filter(Boolean),
      );
    } catch {
      return [];
    }
    const out = new Set<string>();
    for (const cmd of commands) {
      for (const w of cmd.match(/[\w./-]+/g) ?? []) {
        const rel = relative(this.cwd, resolve(this.cwd, w));
        if (tracked.has(rel)) out.add(rel);
      }
    }
    return [...out];
  }

  /**
   * Why a claim that passed after a reveal is refused, or undefined.
   *
   * Once the model has read a hidden check's command, the cheap way to meet it
   * is to change what the check reads: the task's input data, the shell, an
   * installed package, the check's own files. 10 of the 29 right-looking
   * Terminal-Bench passes after such a reveal were bent that way. Only writes
   * made after the reveal count, and only to a file that existed (an input the
   * model created is an output). Inputs are the paths the task text names
   * itself, not namedInputs' guess at the project's data files.
   */
  private bentAfterReveal(
    seen: Set<string>,
    task: string,
    revealed?: { didAt: number; targets: string[] },
  ): { reason: string; hard: boolean } | undefined {
    const later = this.turnLedger().filter((e) => !seen.has(e.callId));
    const inputs = new Set(
      namedInputs(task, this.cwd)
        .filter((p) => task.includes(relative(this.cwd, p)) || task.includes(basename(p)))
        .map((p) => resolve(p)),
    );
    // A `git add` / `git commit` through bash after the reveal makes a change
    // to the check's target durable without the ledger seeing a write. Same
    // split as the writes below: environment or a test file the task does not
    // ask for is hard; a named input, or a tracked file the revealed check
    // reads, ends the claim unverified.
    if (revealed) {
      // What the model created this turn is an output, however the task names it.
      const made = new Set(this.turnLedger().filter((e) => e.before === null).map((e) => resolve(this.cwd, e.path)));
      for (const rel of gitPathsStaged(this.did.slice(revealed.didAt), this.cwd)) {
        const abs = resolve(this.cwd, rel);
        if (/^\/(usr\/)?(local\/)?s?bin\//.test(abs) || /\/(site|dist)-packages\//.test(abs) || /\/\.maat\//.test(abs)) {
          return { reason: `after the check was shown, the model committed ${rel} with git, part of the environment, not the work`, hard: true };
        }
        if (isTestPath(rel) && !task.includes(basename(rel))) {
          return { reason: `after the check was shown, the model committed ${rel} with git, a test or check file the task does not ask for`, hard: true };
        }
        if (made.has(abs)) continue;
        if ([...inputs].some((i) => touches(rel, relative(this.cwd, i))) || revealed.targets.some((t) => touches(rel, t))) {
          return { reason: `after the check was shown, the model committed ${rel} with git, a file the check reads or the task names as an input`, hard: false };
        }
      }
    }
    if (later.length === 0) return undefined;
    for (const e of later) {
      const abs = resolve(this.cwd, e.path);
      if (/^\/(usr\/)?(local\/)?s?bin\//.test(abs) || /\/(site|dist)-packages\//.test(abs) || /\/\.maat\//.test(abs)) {
        return { reason: `after the check was shown, the model wrote ${e.path}, part of the environment, not the work`, hard: true };
      }
      if (e.before !== null && inputs.has(abs)) {
        // Not a refusal: in a task that transforms its inputs in place
        // (config-migrate, redact-secrets) the named file IS the deliverable,
        // and refusing would fail correct work. It cannot earn "verified"
        // after the check was shown, so the claim ends unverified, said why.
        return { reason: `after the check was shown, the model changed ${e.path}, an input the task names`, hard: false };
      }
      if (isTestPath(e.path) && !task.includes(basename(e.path))) {
        return { reason: `after the check was shown, the model changed ${e.path}, a test or check file the task does not ask for`, hard: true };
      }
    }
    return undefined;
  }

  /**
   * The live ACP session (Grok Build, OpenCode), started when it is first needed.
   *
   * Rebuilt whenever molt's system prompt changes — `/map`, `/read` and a
   * repo-map refresh all rewrite it — because a session carrying the old one
   * is working from instructions molt no longer holds. Rebuilding costs the
   * cached prefix, which is the same trade `setSystem` already documents.
   */
  private async subprocessSession(): Promise<BackendSession<EngineEvent>> {
    const system = this.transcript.systemText;
    if (this.cc && this.ccSystem !== system) {
      await this.cc.close();
      this.cc = undefined;
      this.subscriptionCostSeen = 0;
    }
    if (!this.cc) {
      this.ccSystem = system;
      this.ccForwarded = new WeakSet<Msg>();
      /**
       * The one tool path, whichever CLI is on the other end.
       *
       * ACP agents reach it over a loopback HTTP MCP server. The same
       * autonomy gate, ledger entry, journal lines, and events on screen.
       */
      const runTool: ToolRunner<EngineEvent> = async (name, args, callId, emit) => {
        const ctx = this.ccCtx;
        if (!ctx) return "[molt: no turn is running]";
        if (this.ccNoTools) {
          return "[molt: the turn is over. No more tools — answer with what you already have.]";
        }
        if (this.ccGate) {
          const gate = this.ccGate(name, args);
          for (;;) {
            const g = await gate.next();
            if (g.done) break;
            emit(g.value);
          }
        }
        const calls = this.invokeTool({ id: callId, name, rawArgs: JSON.stringify(args) }, ctx);
        for (;;) {
          const next = await calls.next();
          if (next.done) return next.value.result;
          emit(next.value);
        }
      };
      const spec = acpAgentFor(this.cfg.baseUrl);
      if (!spec) {
        const removed = removedSubscriptionProblem(this.cfg.baseUrl);
        throw new Error(
          removed ??
            `no ACP agent for endpoint '${this.cfg.baseUrl}' — use grok-build or an HTTP API`,
        );
      }
      this.cc = new AcpSession<EngineEvent>({
        spec,
        model: this.cfg.model,
        cwd: this.cwd,
        systemPrompt: system,
        tools: TOOLS,
        runTool,
        // The per-call controller invokeTool sets: a deadline or a stall that
        // ends the agent's turn ends the command it was waiting on too.
        abortTools: () => this.running?.abort(),
        asWorker: true,
        ...(this.cfg.acpSpawn ? { spawnFn: this.cfg.acpSpawn } : {}),
      });
    }
    return this.cc;
  }

  /**
   * One step of a turn, done by an ACP agent instead of by an HTTP request.
   *
   * A "step" here is everything up to the model falling silent: it may have
   * called twenty tools on the way, and each was gated, run and recorded by
   * molt as it happened. What comes back is what the HTTP path produces — a
   * final message, its token cost, and why it stopped — so the bar, the
   * receipt and the ceilings downstream cannot tell the two apart.
   *
   * Returns null when the turn cannot continue; it has already said why.
   */
  private async *subprocessStep(
    step: number,
    ctx: ToolContext,
  ): AsyncGenerator<
    EngineEvent,
    { msg: Msg; usage: Usage; finishReason?: string; streamed: boolean } | "cancelled" | "deadline" | "stall" | null
  > {
    this.ccCtx = ctx;
    this.ccCancelled = false;
    let cc: BackendSession<EngineEvent>;
    try {
      cc = await this.subprocessSession();
    } catch (e) {
      const text = errorText(e);
      ctx.log?.append("error", { text });
      yield { kind: "error", text };
      return null;
    }

    /**
     * Everything molt has said that the ACP agent has not been told yet.
     *
     * The ask, the sealed criteria, an empty-turn nudge, a refused bar — molt
     * writes all of them to the transcript as user messages, so forwarding
     * what has not gone yet keeps the two conversations saying the same
     * things in the same order without a second code path per kind.
     */
    const pending = this.transcript
      .all()
      .filter((m) => m.role === "user" && !this.ccForwarded.has(m));
    for (const m of pending) this.ccForwarded.add(m);
    const texts = pending.map((m) => m.content ?? "").filter((t) => t.trim().length > 0);
    if (texts.length === 0) {
      // Nothing new to say and no reply owed. Sending nothing would hang on a
      // session that only speaks when spoken to.
      texts.push("[molt: carry on, or say what is blocking you.]");
    }
    /**
     * One molt step is one message and one answer.
     *
     * molt writes the ask and its sealed criteria as separate messages so a
     * shed can drop one without the other; this backend never sheds, so the
     * distinction buys nothing here and costs the invariant that makes the
     * step boundary legible — send once, read until it stops.
     */
    const said = [texts.join("\n\n")];

    ctx.log?.append("request", {
      step,
      messages: texts.length,
      estTokens: this.bom().requestTotalEst,
      estimated: true,
      stream: true,
      model: this.cfg.model,
      endpoint: this.cfg.baseUrl,
    });
    yield {
      kind: "request",
      step,
      messages: texts.length,
      estTokens: this.bom().requestTotalEst,
      model: this.cfg.model,
      stream: true,
    };

    /**
     * An assistant message with no tool calls, held back one beat.
     *
     * The last one is the turn's claim and the shared code downstream pushes
     * it; pushing it here as well is how the same sentence lands in the
     * transcript twice. Anything that turns out not to be last is pushed as
     * soon as the next message proves it.
     */
    let deferred: string | null = null;
    let done:
      | {
          text: string;
          promptTokens: number;
          completionTokens: number;
          cachedTokens: number;
          cumulativeCostUsd: number;
          error?: string;
          stopped?: "deadline" | "stall";
          silentMs?: number;
        }
      | undefined;

    // Every wait on the agent is bounded: by the turn's deadline, and by a
    // stall allowance on its silence. Neither existed, and one Grok Build
    // prompt turn held a 540 s bench job for an hour.
    for await (const ev of cc.send(said, { deadlineAt: this.deadlineAt(), stallMs: this.stallMs() })) {
      if (ev.kind === "host") {
        yield ev.event;
      } else if (ev.kind === "delta") {
        yield { kind: "delta", text: redact(ev.text, this.secrets()) };
      } else if (ev.kind === "info") {
        ctx.log?.append("note", { text: ev.text });
        yield { kind: "info", text: ev.text };
      } else if (ev.kind === "assistant") {
        if (deferred !== null) {
          this.transcript.push({ role: "assistant", content: deferred });
          deferred = null;
        }
        if (ev.toolCalls.length) {
          this.transcript.push({
            role: "assistant",
            content: ev.text || null,
            tool_calls: ev.toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          });
        } else {
          deferred = ev.text;
        }
      } else if (ev.kind === "done") {
        done = ev;
      }
    }

    // ctrl+C ends the session, which is the only way to unask the question —
    // and a session ended that way stops without a result. That silence was
    // reported as "the session ended without answering", an error, with the
    // transcript left holding the abandoned step and no `cancelled` in the
    // journal: the HTTP path's cancel, told as a provider fault.
    if (this.ccCancelled) {
      this.ccCancelled = false;
      return "cancelled";
    }
    if (!done) {
      yield { kind: "error", text: `the ${this.backendLabel} session ended without answering` };
      await this.dropAcpSession();
      return null;
    }
    if (done.stopped === "deadline") {
      // The clock, not the provider: the step loop closes the turn the way it
      // closes any that ran out of time, judging what is on disk.
      if (deferred !== null) this.transcript.push({ role: "assistant", content: deferred });
      ctx.log?.append("note", {
        text: `time budget reached during step ${step}'s ${this.backendLabel} turn — session/cancel sent, agent process tree ended`,
      });
      await this.dropAcpSession();
      return "deadline";
    }
    if (done.stopped === "stall") {
      // The provider went quiet, which is not the task failing. Journalled the
      // way a provider's quota wall is — a provider issue — so a benchmark
      // does not count it against the work.
      const silent = waited(done.silentMs ?? this.stallMs());
      const text = `provider stall: ${this.backendLabel} sent nothing for ${silent} — its turn was cancelled and the agent process tree ended`;
      ctx.log?.append("error", { text, providerIssue: true, providerStall: true, silentMs: done.silentMs ?? null });
      if (deferred !== null) this.transcript.push({ role: "assistant", content: deferred });
      this.turnProviderStall = true;
      yield {
        kind: "error",
        text: `${text}. This is the provider, not the task. Nothing was verified; the work above still happened.`,
      };
      await this.dropAcpSession();
      return "stall";
    }
    if (done.error) {
      const wall = longQuotaText(done.error);
      ctx.log?.append("error", { text: wall ?? done.error, ...(wall ? { providerCapped: true } : {}) });
      if (wall) {
        // A quota that lifts hours from now is not this task's failure, and
        // nothing inside a turn gets past it. Fail fast, say when it lifts.
        yield { kind: "error", text: `${wall}. Nothing was verified; the work above still happened.` };
        await this.dropAcpSession();
        return null;
      }
      yield {
        kind: "error",
        text:
          `${this.backendLabel}: ${done.error}. Nothing was verified. The work above still ` +
          `happened; what follows is a report on it, not a completion.`,
      };
      // The session cannot be trusted to continue after it has failed, and a
      // new one costs a cached prefix rather than the turn.
      await this.dropAcpSession();
      return null;
    }

    /**
     * What the SDK thinks the same work would have cost on the API.
     *
     * Journalled, never metered. It is the one number that would let someone
     * compare a plan against a bill, and it is exactly the number that must
     * not turn up in `costUsd()` as though it had been charged.
     */
    /**
     * Only when the backend actually reported one.
     *
     * Some subscription SDKs report what the same turn would have cost on the
     * API, which is worth recording. ACP reports nothing, and a note reading
     * "0.0000 USD would have been billed" is not a cheap turn — it is a
     * missing number wearing a measurement's clothes.
     */
    /**
     * The SDK's figure is the session's running total, and it was journalled
     * as each step's: summing the notes over a session counted the first step
     * once per step after it. The step's own share is the difference from the
     * last reading; the running total is kept beside it, named as such.
     */
    if (done.cumulativeCostUsd > 0) {
      const step = Math.max(0, done.cumulativeCostUsd - this.subscriptionCostSeen);
      this.subscriptionCostSeen = done.cumulativeCostUsd;
      ctx.log?.append("note", {
        text:
          `${this.cfg.provider ?? "subscription"}: ${step.toFixed(4)} USD would have been billed ` +
          `on the API for this step (${done.cumulativeCostUsd.toFixed(4)} this session)`,
        costEstimateUsd: step,
        sessionCostEstimateUsd: done.cumulativeCostUsd,
        subscription: true,
      });
    }

    return {
      msg: { role: "assistant", content: done.text || deferred || "" },
      usage: {
        prompt_tokens: done.promptTokens,
        completion_tokens: done.completionTokens,
        prompt_tokens_details: { cached_tokens: done.cachedTokens },
        cache_read_input_tokens: done.cachedTokens,
        // No `cost`: see costUsd().
      },
      finishReason: "stop",
      streamed: true,
    };
  }

  /** End the ACP session, so the next turn starts a fresh one. */
  private async dropAcpSession(): Promise<void> {
    const cc = this.cc;
    this.cc = undefined;
    this.subscriptionCostSeen = 0;
    this.ccCtx = undefined;
    await cc?.close();
  }

  /**
   * One tool call, from the decision to allow it through to the record of it.
   *
   * Lifted out of the step loop when a second backend arrived. The ACP
   * agent runs molt's tools through an MCP server rather than through the
   * loop, so without this the gate, the ledger, the read-coverage map, the
   * repeat pointer and three journal entries would exist twice — and this
   * repo has shipped the same bug on two surfaces six times over. There is
   * one copy, and both backends call it.
   *
   * A generator because everything in here reports: the caller drains the
   * events to its own consumer and reads the outcome off the return.
   */
  private async *invokeTool(
    call: { id: string; name: string; rawArgs: string; truncated?: boolean },
    ctx: ToolContext,
  ): AsyncGenerator<EngineEvent, ToolOutcome> {
    /** Whether this call told the model something it had already been told. */
    let repeatedHere = false;
    const { id: callId, name } = call;
    let args: Record<string, unknown> = {};
    let malformed = false;
    /** What the arguments get wrong against the tool's schema (src/toolargs.ts). */
    let violations: string[] = [];
    try {
      args = parseLenient(call.rawArgs || "{}") as Record<string, unknown>;
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("not an object");
      if (name === "bash") foldCommands(args, this.cwd);
      violations = argumentProblems(TOOLS.find((t) => t.function.name === name)?.function.parameters as never, args);
      if (violations.length) malformed = true;
    } catch {
      // Running with empty arguments produced a misleading error — a
      // malformed read_file became "EISDIR: illegal operation on a
      // directory", which sends the model to debug a path it never
      // sent. Say what actually happened instead.
      malformed = true;
    }
    // An act reaches a tool call as itself only when its actions could not be
    // read (expandAct), so it counts as malformed here too.
    const known = TOOLS.some((t) => t.function.name === name);
    const refused = malformed || name === "act" || !known;
    this.malformedStreak = refused ? this.malformedStreak + 1 : 0;
    const detail = toolDetail(name, args);
    this.turnCalls.add(callId);
    // What the current autonomy level says about this exact call. The
    // decision is mechanical and the reason travels with it, so an
    // approval prompt can say which rule produced it rather than
    // asking the same way about everything.
    const decision = gate(this.autonomy, {
      name,
      args,
      cwd: this.cwd,
      // What molt itself put on disk this session. Lets a model tidy
      // away its own scratch files without waking anyone.
      created: this.createdThisSession(),
      boundary: this.cfg.sandbox ? "machine" : "project",
    });
    // The prompt shows the command in full. You are being asked to judge
    // it, and a redacted command is one you cannot judge.
    //
    // Past the turn's wall clock, nothing more runs. The step loop reads the
    // clock between steps, which on the HTTP path is between tool batches —
    // but a subscription backend runs a whole agentic step, every call in it,
    // inside one of molt's steps, so `--for 5m` on an ACP agent bounded
    // nothing: the step could go on calling tools for as long as it liked.
    // Every call comes through here, whichever backend made it, so this is
    // where the clock is honoured; the model is told, and the step loop
    // closes the turn the way any deadline closes one.
    const outOfTime = this.pastDeadline();
    // A turn being cancelled runs nothing more, asked or not — including a
    // call whose permission question the cancel arrived during.
    const asked = outOfTime || this.cancelRequested
      ? false
      : decision.ask
        ? await ctx.confirm(name, `${detail}${decision.why ? ` — ${decision.why}` : ""}`, {
            id: callId,
            args,
            ...(decision.why ? { why: decision.why } : {}),
          })
        : true;
    const stopping = this.cancelRequested;
    const allowed = asked && !stopping;

    let result: string;
    let note: string | undefined;
    if (malformed) {
      const raw = capture(call.rawArgs);
      yield {
        kind: "tool",
        name,
        id: callId,
        detail: violations.length ? "arguments do not fit the schema" : "malformed arguments",
        note: "malformed",
        args: raw,
        bytes: 0,
        preview: raw,
        auto: true,
      };
      // Which fact this is matters more than it looks.
      //
      // "Send them again" is right for a model that produced bad JSON and
      // wrong for one that produced good JSON and had it cut off at the
      // output ceiling: sending the same call again produces the same
      // truncation, and molt asked for it every time. A `write_file` of a
      // large file looped exactly that way. The stop reason already says
      // which happened, so it is said.
      const complaint = call.truncated
        ? `[molt: your reply hit the output ceiling of ${this.maxTokensFor()} tokens and was cut ` +
          `off part-way through the arguments for ${name}, so nothing ran. Sending the same call ` +
          `again will be cut off in the same place. Write less in one go — a smaller file, or one ` +
          `part of it at a time — or ask for the ceiling to be raised with --max-tokens.]`
        : violations.length
          ? `[molt: the arguments for ${name} do not fit its schema, so nothing ran: ` +
            `${violations.join("; ")}. Send the call again with them fixed.]`
          : `[molt: the arguments for ${name} were not valid JSON, so nothing ran. ` +
            `Send them again as a JSON object. What arrived began: ${excerpt(raw)}]`;
      const firm =
        this.malformedStreak >= MALFORMED_WARN
          ? ` [molt: that is ${this.malformedStreak} malformed calls in a row. Send ONE call whose arguments are a single JSON object matching the ${name} schema, or finish; after ${MALFORMED_STOP} the turn ends.]`
          : "";
      this.transcript.push({ role: "tool", tool_call_id: callId, content: complaint + firm });
      this.transcript.markMalformedCall(callId);
      return { name, result: complaint, auto: true, repeated: false };
    }
    // Timed around execution only. Waiting on a human to approve a gated
    // tool is not the tool being slow, and folding the two together
    // would make every gated call look like one.
    let durationMs: number | undefined;
    if (!allowed) {
      result = outOfTime
        ? `[molt: the time budget for this turn is up — ${name} was not run, and no further ` +
          `call will be. Stop calling tools and answer now with what you have already found, ` +
          `saying plainly what is unfinished.]`
        : stopping
          ? "[molt: the turn was cancelled before this ran.]"
          : "User denied this action.";
      note = outOfTime ? "out of time" : stopping ? "cancelled" : "denied";
    } else {
      yield {
        kind: "tool_start",
        name,
        detail,
        id: callId,
        args: redact(capture(call.rawArgs), this.secrets()),
      };
      const toolStartedAt = Date.now();
      // Scoped to this one call, so ctrl+C reaches the command that is
      // actually running and nothing that ran before it.
      this.running = new AbortController();
      try {
        // read_file budgets itself, to the byte, so that the notice
        // saying how to continue survives. Capping it again here is what
        // cut that notice off and left the model with no way forward.
        const raw = await this.runTool(name, args, callId);
        const t =
          name === "read_file"
            ? { text: raw, note: undefined }
            : truncateResult(
                raw,
                Math.min(TOOL_RESULT_MAX_BYTES, this.resultBudget()),
                name === "bash" ? "ends" : "head",
              );
        result = t.text;
        note = t.note;
        // What was cut is kept, not lost: the whole output goes to a file and
        // the model is told where. The conversation carries the preview only,
        // and every later request resends the preview, not the whole thing.
        if (t.note?.startsWith("capped")) {
          const kept = this.spill(raw, callId);
          if (kept) {
            result +=
              `\n[molt: the full output (${Buffer.byteLength(raw, "utf8")} bytes) is in ${kept} — ` +
              `read_file it, with an offset, for the part you need]`;
          }
        }
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
        const covered = ctx.shown.get(path) ?? [];
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
          repeatedHere = true;
        } else {
          covered.push({ from, to });
          ctx.shown.set(path, covered);
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
      const prior = ctx.answered.get(key);
      if (prior && prior.sha === sha) {
        result =
          `[molt: this is the same ${name} call you made at step ${prior.step + 1}, and ` +
          `nothing has changed since. Its result is already above in this conversation. ` +
          `Repeating it cannot tell you anything new — act on what you have, or say ` +
          `plainly what is blocking you.]`;
        note = "repeat";
        repeatedHere = true;
      }
      ctx.answered.set(key, { step: ctx.step, sha });
    }
    // Both branches are recorded. A call that ran without being asked
    // about is exactly the thing an audit needs to be able to find, and
    // it is recorded with the level that let it through.
    ctx.log?.append("permission", {
      name,
      detail,
      allowed,
      asked: decision.ask,
      autonomy: this.autonomy,
      ...(decision.why ? { why: decision.why } : {}),
    });
    ctx.log?.append("tool_call", { step: ctx.step, name, detail, allowed });
    ctx.log?.append("tool_result", {
      name,
      bytes: Buffer.byteLength(result, "utf8"),
      truncated: Boolean(note?.startsWith("capped")),
      note,
      sha256: createHash("sha256").update(result, "utf8").digest("hex").slice(0, 16),
    });
    if ((name === "write_file" || name === "edit_file") && allowed) {
      ctx.shown.delete(String(args.path ?? ""));
      this.pinTask(ctx.userText);
    }
    this.did.push(
      `${allowed ? "" : "refused: "}${name} ${detail}` +
        (note && note !== "repeat" ? ` [${note}]` : ""),
    );
    if (allowed) this.actsSinceBar += 1;
    // Everything that scrolls is redacted. A transcript is pasted into
    // bug reports and screenshotted into chat windows, which makes the
    // screen a distribution channel like any other — and unlike the
    // prompt above, nobody is judging a command from the scrollback.
    const hide = (t: string) => redact(t, this.secrets());
    const diff = this.writeDiffs.get(callId);
    this.writeDiffs.delete(callId);
    yield {
      kind: "tool",
      name,
      id: callId,
      ...(diff
        ? {
            diff: {
              path: diff.path,
              oldText: diff.oldText === null ? null : hide(diff.oldText),
              newText: hide(diff.newText),
            },
          }
        : {}),
      detail: hide(detail),
      note,
      durationMs,
      args: hide(capture(call.rawArgs)),
      bytes: Buffer.byteLength(result, "utf8"),
      preview: hide(capture(result)),
      auto: !decision.ask,
    };
    const firmHere =
      refused && this.malformedStreak >= MALFORMED_WARN
        ? ` [molt: that is ${this.malformedStreak} malformed calls in a row. Send ONE call whose arguments are a single JSON object matching the tool's schema, or finish; after ${MALFORMED_STOP} the turn ends.]`
        : "";
    this.transcript.push({ role: "tool", tool_call_id: callId, content: result + firmHere });
    if (refused) this.transcript.markMalformedCall(callId);
    return { name, result, auto: !decision.ask, repeated: repeatedHere };
  }

  private async *runTurn(
    userText: string,
    confirm: Confirm,
    job: number,
    opts: RunOptions = {},
  ): AsyncGenerator<EngineEvent> {
    // Remember where this turn began so a cancellation can leave no trace.
    const turnStart = this.transcript.length;
    /**
     * The project as the turn found it, headless only: at the first claim,
     * files that appeared since and that the task never names are put to the
     * model once — the helper script or copy it left beside the deliverable.
     */
    const turnListing = this.cfg.unattended ? listProject(this.cwd) : null;
    let leftoversAsked = false;
    /** Requirement sign-out: the stated requirements, and whether they were put once (src/signout.ts). */
    let requirements = normalizeRequirements(opts.requirements);
    let signedOut = false;
    this.passedBeforeWork = new Set();
    this.goldensBefore = new Map();
    this.failedBeforeWork = new Set();
    const log = this.cfg.journal;
    await this.preWorkTree?.cleanup();
    // The copy is taken asynchronously, and a draft can fail while it is
    // taken: mark the pending draft handled now (it is awaited, and its
    // failure reported, further down) so that is not an unhandled rejection.
    opts.pendingCriteria?.catch(() => {});
    if ((opts.pendingCriteria || opts.referenceCheck || this.cfg.postWorkAudit === true) && !opts.ask) {
      const t0 = Date.now();
      this.preWorkTree = await preWorkCopy(this.cwd);
      // Journalled either way, so a replay can tell a late check that was
      // never tried because there was no copy from one that failed its try.
      log?.append(
        "note",
        this.preWorkTree
          ? { kind: "pre-work-copy", text: `copied the project before the work for late checks: ${this.preWorkTree.files} file(s) in ${Date.now() - t0} ms`, files: this.preWorkTree.files, ms: Date.now() - t0 }
          : { kind: "pre-work-copy", text: "no copy of the project before the work (too large, or it could not be copied): late checks are not tried before the work", ms: Date.now() - t0 },
      );
    } else this.preWorkTree = null;
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
    let taskChecks: Check[] = [];
    let taskNotes: string[] = [];
    let taskSeal = "";
    /**
     * Criteria still being drafted when the turn began (see RunOptions
     * .pendingCriteria). The model may read while they are drafted; its first
     * change, or its first claim, waits for them to be sealed.
     */
    let pendingCriteria = opts.pendingCriteria;
    const criteriaSince = Date.now();
    // Drafted checks are hidden; given ones may be. Either way the file tools are held to the task.
    this.turnHidesChecks = Boolean(pendingCriteria) || (opts.taskChecks ?? []).some((c) => c.hidden === true);
    /**
     * The draft, when the time budget's cut found it with no checks: kept alive
     * to join at the first claim instead of sealing nothing (joinLateCriteria).
     */
    let lateCriteria: typeof pendingCriteria;
    let draftInputs = "";
    if (pendingCriteria && !opts.ask) {
      draftInputs = opts.draftInputs?.sha ?? draftInputsHash(userText, listProject(this.cwd));
      log?.append("note", { kind: "draft-inputs", text: "drafter inputs fixed at turn start", inputsSha: draftInputs });
    }
    /** Sealed mid-step: tell the model once this step's tool results are in. */
    let announceAfterTools = false;
    const self = this;
    /** Freeze, seal, journal and try the criteria — all before any change. */
    async function* sealCriteria(checks: Check[], notes: string[]): AsyncGenerator<EngineEvent> {
    // Who wrote each check is fixed here, with the checks: a check nobody
    // vouched for is the worker's (src/tiers.ts withAuthor).
    taskChecks = checks.map((c) => Object.freeze(withAuthor({ ...c }, self.cfg.model)));
    taskNotes = [...notes];
    Object.freeze(taskChecks);
    Object.freeze(taskNotes);
    taskSeal = taskChecks.length || taskNotes.length ? sealOf(taskChecks, taskNotes) : "";
    self.sealedChecks = taskChecks;
    self.sealedNotes = taskNotes;
    self.withholdChecks(taskChecks);
    if (taskSeal) {
      // Journalled before the first request, so the record shows the criteria
      // predating the work rather than merely claiming to.
      log?.append("note", {
        text: `task criteria sealed: ${taskChecks.length} check(s), ${taskNotes.length} note(s)`,
        seal: taskSeal,
        checks: taskChecks.map((c) => c.name),
        authors: Object.fromEntries(taskChecks.map((c) => [c.name, authorWords(c.author)])),
        notes: taskNotes,
      });
      yield {
        kind: "info",
        text:
          `${taskChecks.length} task check(s) and ${taskNotes.length} note(s) sealed for this ` +
          `turn (${taskSeal.slice(0, 12)}). They cannot change while it runs.`,
      };
      // Try them once, now, before a single token is spent. A criterion is
      // meant to fail before the work; it is not meant to be unrunnable, and
      // the difference is cheap to establish here and expensive to discover
      // at the end of a turn.
      // What each expected-looking file held before the work (src/golden.ts).
      self.goldensBefore = recordGoldens(taskChecks.map((c) => ({ run: c.kind === "command" ? c.run : undefined })), self.cwd);
      if (taskChecks.length) {
        // Through `running`, so ctrl+C at the very start of a turn kills the
        // preflight rather than waiting it out.
        self.running = new AbortController();
        let broken: Awaited<ReturnType<typeof preflightCriteria>> = [];
        const passed: string[] = [];
        const failed: string[] = [];
        const beforeTry = self.cfg.unattended ? listProject(self.cwd) : null;
        try {
          broken = await preflightCriteria(taskChecks, {
            cwd: self.cwd,
            signal: self.running.signal,
            passed,
            failed,
          });
          const asTask = (n: string) => (n.startsWith("task:") ? n : `task:${n}`);
          self.passedBeforeWork = new Set(passed.map(asTask));
          self.failedBeforeWork = new Set(failed.map(asTask));
          // Journalled so a replay can tell a check that discriminates from one
          // that only guards (src/tiers.ts failedBefore).
          log?.append("note", {
            kind: "pre-work-try",
            text: `tried before the work: ${failed.length} failed, ${passed.length} passed`,
            failed: [...self.failedBeforeWork],
            passed: [...self.passedBeforeWork],
          });
        } finally {
          self.running = undefined;
          if (self.cfg.unattended) {
            const gone = removeNew(self.cwd, beforeTry);
            if (gone.length) log?.append("note", { text: `removed what the checks created before the work: ${gone.join(", ")}` });
          }
        }
        if (broken.length) {
          log?.append("note", {
            text: "sealed criteria that did not run when tried before the work",
            checks: broken.map((b) => b.name),
          });
          yield {
            kind: "info",
            text:
              broken
                .map(
                  (b) =>
                    `criterion \`${b.name}\` did not run when tried before the work: ` +
                    `\`${b.run}\` — ${b.why}.`,
                )
                .join(" ") +
              ` A criterion is supposed to fail until the work is done, but this one cannot ` +
              `report either way. If the work is what makes it runnable, carry on; otherwise ` +
              `stop and repair it, because no work will satisfy it.`,
          };
        }
      }
    }
    }

    /** Tell the model what was sealed: a gate it does not know about is a trap. */
    const announceCriteria = (): void => {
    if (taskChecks.length || taskNotes.length) {
      // Stated to the model, because a gate it does not know about is a trap
      // rather than a specification — and the point is for the work to satisfy
      // these, not to be caught out by them. Pushed as a separate message so it
      // survives shedding independently of the ask, and so a reader of the
      // transcript can see exactly what was set and when.
      const lines = [
        "Acceptance criteria for this task, fixed before you began and unchangeable:",
        ...taskChecks.map((c) =>
          c.hidden
            ? `  [checked] ${c.name} — the command is withheld; a check you can see is a check you can copy`
            : c.kind === "command"
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
      this.transcript.push({ role: "user", content: lines.join("\n"), molt: { criteria: true } });
    }
    };
    if (!pendingCriteria) yield* sealCriteria(opts.taskChecks ?? [], opts.taskNotes ?? []);
    this.transcript.push({ role: "user", content: userText + this.inputProfile(userText) });
    if (!pendingCriteria) announceCriteria();
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
    let revealedThisTurn = false;
    let revealMark: { didAt: number; targets: string[] } | undefined;
    /** Calls already ledgered when the reveal happened: what is new came after the model read the check. */
    let revealSeen = new Set<string>();
    /** Set when a write after the reveal bent the work to the check; ends the turn refused. */
    let bentReason: string | undefined;
    let lastReceipt: string | undefined;
    let lastReceiptPath: string | undefined;
    /** The reviewers' findings have been put to the model once this turn. */
    let reviewNudged = false;
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
    /** Consecutive assistant turns that arrived with nothing in them. */
    let emptyTurns = 0;
    /** Consecutive replies that stopped at the output ceiling. */
    let truncatedTurns = 0;
    /** Consecutive replies that wrote a tool call out as text instead of making one. */
    let narratedTurns = 0;
    /** The dry streak molt has already written into the transcript. */
    let nudgedAtStreak = 0;

    // A question changes nothing, so a check that demands a change can only
    // ever fail it. `ask` drops exactly those checks for this turn and runs
    // the rest — the bar is narrowed in the open, never quietly lowered, and
    // the receipt records which checks actually ran.
    // Narrowed here for the announcement below and for proof_start's names;
    // re-derived at each proof attempt, because whether this turn wrote
    // anything is not known until it has had the chance to.
    let bar = opts.ask
      ? withoutWriteChecks(withTaskChecks(this.cfg.bar, taskChecks))
      : withTaskChecks(this.cfg.bar, taskChecks);
    /**
     * Whether the drafted checks are known to be independent of the work:
     * the caller froze the drafter's inputs before the first step, and every
     * drafter stage so far used exactly those.
     */
    const draftsIndependent = (): boolean =>
      opts.draftInputs !== undefined && opts.draftInputs.used().every((h) => h === draftInputs);
    /** How long a claim waits for checks still drafting (see claimWaitForDraftsMs). */
    const lateWait = (): number =>
      opts.lateCriteriaWaitMs ??
      (draftsIndependent() ? claimWaitForDraftsMs(self.timeLeftMs(), self.turnDeadlineMs) : lateCriteriaWaitMs(self.timeLeftMs()));
    /**
     * Seal criteria that were still being drafted. Called before the first
     * call that changes anything and before the first claim, so the checks
     * still predate every change; only the reading overlapped their drafting.
     */
    async function* settleCriteria(announce = true): AsyncGenerator<EngineEvent> {
      if (!pendingCriteria) return;
      const p = pendingCriteria;
      pendingCriteria = undefined;
      const ready = await Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 50))]);
      if (!ready) yield { kind: "info", text: "waiting for this task's checks to be sealed before the first change" };
      const none: { taskChecks: Check[]; taskNotes: string[]; requirements?: string[] } = { taskChecks: [], taskNotes: [] };
      // Bounded under a time budget: query-optimize spent 262 s of 705 here.
      const cap = opts.criteriaWaitMs ?? criteriaWaitMs(self.turnDeadlineMs);
      let got: { taskChecks: Check[]; taskNotes: string[]; requirements?: string[] };
      if (cap !== undefined && opts.criteriaSoFar) {
        const left = Math.max(0, cap - (Date.now() - criteriaSince));
        let timer: NodeJS.Timeout | undefined;
        const out = await Promise.race([
          p.catch(() => none),
          new Promise<null>((r) => { timer = setTimeout(() => r(null), left); }),
        ]);
        clearTimeout(timer);
        if (out) got = out;
        else {
          got = await opts.criteriaSoFar().catch(() => none);
          if (got.taskChecks.length === 0 && !opts.ask) {
            // Sealing nothing would leave every correct result unverifiable
            // (14 of 60 runs on Mercury 2.5, when the drafter's request
            // stalled). The draft keeps going and joins at the first claim.
            lateCriteria = p;
            yield {
              kind: "info",
              text:
                `checks were still being drafted after ${Math.round(cap / 1000)}s of the time budget and none was ready; ` +
                `not sealing an empty set — the first claim waits up to ${Math.round(lateWait() / 1000)}s for them and judges with them if they arrive`,
            };
          } else {
            yield {
              kind: "info",
              text: `checks were still being drafted after ${Math.round(cap / 1000)}s of the time budget; sealing the ${got.taskChecks.length} reviewed so far`,
            };
          }
        }
      } else {
        got = await p.catch(() => none);
      }
      requirements = normalizeRequirements([...requirements, ...(got.requirements ?? [])]);
      yield* sealCriteria([...(opts.taskChecks ?? []), ...got.taskChecks], [...(opts.taskNotes ?? []), ...got.taskNotes]);
      // Mid-step, the announcement waits for this step's tool results: a
      // message between a tool call and its result is a malformed
      // conversation, and providers answer one with an empty turn.
      if (announce) announceCriteria();
      else announceAfterTools = true;
      bar = opts.ask
        ? withoutWriteChecks(withTaskChecks(self.cfg.bar, taskChecks))
        : withTaskChecks(self.cfg.bar, taskChecks);
    }
    // The same gate for a backend that runs its own tool calls (ACP, Claude
    // Code): sealed before the first call that changes anything.
    this.ccGate = async function* (name, args) {
      if (pendingCriteria && changesSomething(name, JSON.stringify(args))) yield* settleCriteria(false);
    };
    /** The reference check, until it joins or proves not to apply. */
    let referencePending = opts.ask ? undefined : opts.referenceCheck;
    async function* joinReference(): AsyncGenerator<EngineEvent> {
      const p = referencePending;
      if (!p) return;
      const wait = opts.referenceWaitMs ?? referenceWaitMs(self.timeLeftMs());
      let timer: NodeJS.Timeout | undefined;
      const late = Symbol("late");
      const got = await Promise.race([
        p.catch(() => null),
        new Promise<typeof late>((r) => { timer = setTimeout(() => r(late), wait); }),
      ]);
      clearTimeout(timer);
      if (got === late) {
        yield { kind: "info", text: "the reference check is still being written; judging this claim without it" };
        return;
      }
      referencePending = undefined;
      if (!got) return;
      const check = Object.freeze(
        withAuthor({ ...got.check, name: got.check.name.startsWith("task:") ? got.check.name : `task:${got.check.name}` }, self.cfg.model),
      );
      if (taskChecks.some((c) => c.name === check.name)) return;
      await self.tryLateBeforeWork([check], log);
      taskChecks = Object.freeze([...taskChecks, check]) as Check[];
      self.sealedChecks = taskChecks;
      self.withholdChecks([check]);
      // The reference program is the check's expected values: withheld like a command.
      if (typeof got.note.source === "string") self.withholdText(`${check.name} (reference source)`, got.note.source);
      bar = withTaskChecks(self.cfg.bar, taskChecks);
      log?.append("note", { text: "reference check joined the sealed checks", ...got.note });
      yield {
        kind: "info",
        text: "an independent reference check joined this turn's checks — written from the task text and the project as it was before the work",
      };
      self.transcript.push({
        role: "user",
        content:
          "An independent reference check has joined the acceptance criteria. It was written from the task text " +
          "and the project as it was before you began, by a reviewer who never saw your work: it compares your " +
          "deliverable with a reference on the task's examples, the edge cases its words imply, and random inputs. " +
          "The command is withheld; on a failure you will see the input, the expected and the actual result.",
      });
    }
    /**
     * Checks that were still drafting when the time budget's cut found none
     * ready. Like the reference check they were written from the task text and
     * the project before the first step, so they may join at a claim; the
     * inputs' hash journalled at turn start is journalled again here. Not
     * ready by the claim, it is judged without them and the next claim looks
     * again.
     */
    async function* joinLateCriteria(): AsyncGenerator<EngineEvent> {
      const p = lateCriteria;
      if (!p) return;
      const independent = draftsIndependent();
      const wait = lateWait();
      const began = Date.now();
      let timer: NodeJS.Timeout | undefined;
      const late = Symbol("late");
      const got = await Promise.race([
        p.catch(() => null),
        new Promise<typeof late>((r) => { timer = setTimeout(() => r(late), wait); }),
      ]);
      clearTimeout(timer);
      const waited = Math.round((Date.now() - began) / 1000);
      const budgetNote = independent && self.turnDeadlineMs ? " (waited to the time budget's margin: the drafter's inputs were sealed before the work)" : "";
      if (got === late) {
        log?.append("note", { kind: "late-checks", text: `drafted checks did not arrive after ${waited}s`, waitedMs: Date.now() - began, arrived: false, inputsSha: draftInputs });
        yield {
          kind: "info",
          text: `waited ${waited}s for the drafted checks${budgetNote}; they did not arrive within ${Math.round(wait / 1000)}s, so this claim is judged without them and cannot be verified by task checks`,
        };
        return;
      }
      lateCriteria = undefined;
      // Recomputed from what the drafter stages actually used, now that they
      // are done: a stage that read the changed folder shows here.
      const used = opts.draftInputs?.used() ?? [];
      const strays = used.filter((h) => h !== draftInputs);
      if (opts.draftInputs && strays.length) {
        log?.append("note", {
          kind: "late-checks",
          text: "late drafted checks NOT joined: a drafter stage used inputs that differ from the turn-start snapshot",
          inputsSha: draftInputs,
          used,
          arrived: true,
          waitedMs: Date.now() - began,
        });
        yield {
          kind: "info",
          text: `the drafted checks arrived after ${waited}s but were drafted from a view of the project that differs from the one taken before the work; they are not joined, so this claim cannot be verified by task checks`,
        };
        return;
      }
      const have = new Set(taskChecks.map((c) => c.name));
      const added = (got?.taskChecks ?? [])
        .map((c) => Object.freeze(withAuthor({ ...c, name: c.name.startsWith("task:") ? c.name : `task:${c.name}` }, self.cfg.model)))
        .filter((c) => !have.has(c.name));
      if (!added.length) {
        log?.append("note", { kind: "late-checks", text: "the drafter finished with no checks to join", inputsSha: draftInputs });
        return;
      }
      await self.tryLateBeforeWork(added, log);
      taskChecks = Object.freeze([...taskChecks, ...added]) as Check[];
      taskNotes = Object.freeze([...taskNotes, ...(got?.taskNotes ?? [])]) as string[];
      taskSeal = sealOf(taskChecks, taskNotes);
      requirements = normalizeRequirements([...requirements, ...(got?.requirements ?? [])]);
      self.sealedChecks = taskChecks;
      self.sealedNotes = taskNotes;
      self.withholdChecks(added);
      bar = withTaskChecks(self.cfg.bar, taskChecks);
      log?.append("note", {
        kind: "late-checks",
        text: `late drafted checks joined the sealed checks: ${added.length} check(s) after ${waited}s`,
        inputsSha: used.length ? used[used.length - 1] : draftInputs,
        waitedMs: Date.now() - began,
        arrived: true,
        seal: taskSeal,
        checks: added.map((c) => c.name),
      });
      yield {
        kind: "info",
        text: `waited ${waited}s for the drafted checks${budgetNote}; ${added.length} arrived and joined this turn's checks — written from the task text and the project as it was before the work`,
      };
      self.transcript.push({
        role: "user",
        content:
          "Drafted acceptance criteria have joined this turn's checks. They were written from the task text and " +
          "the project as it was before you began, by a drafter that never saw your work: " +
          added.map((c) => c.name).join(", ") +
          ". The commands are withheld; on a failure you will see the output.",
      });
    }
    // Drafted checks retired by an upheld dispute this turn (src/dispute.ts),
    // and every check already disputed once, by bare name.
    const retired = new Map<string, Ruling>();
    const disputed = new Set<string>();
    const bare = (name: string) => name.replace(/^task:/, "");
    const liveTaskChecks = () => taskChecks.filter((c) => !retired.has(bare(c.name)));
    const barNow = (): Bar | null =>
      opts.ask
        ? asQuestion(withTaskChecks(this.cfg.bar, liveTaskChecks()), this.turnLedger().length === 0)
        : withTaskChecks(this.cfg.bar, liveTaskChecks());
    /**
     * Sealed checks that failed in their own code or ran out their own time.
     *
     * A drafted check that errs says nothing about the work. One that hangs
     * says nothing either, and a bar that waits on it ends the run at the
     * runner's kill with no verdict: a check that never finished is retired
     * for this run, and the others judge.
     */
    const brokenOwn = (res: BarResult): CheckResult[] =>
      res.cancelled
        ? []
        : res.results.filter((r) => {
            if (r.ok || r.advisory || retired.has(bare(r.name))) return false;
            if (bare(r.name) === REFERENCE_CHECK_NAME) return r.exitCode === REFERENCE_SELF_ERROR || r.timedOut === true;
            const sealed = taskChecks.some((c) => bare(c.name) === bare(r.name));
            return sealed && (r.timedOut === true || (r.hidden === true && checkSelfError(r.output) !== null));
          });
    async function* retireBroken(list: CheckResult[]): AsyncGenerator<EngineEvent> {
      for (const r of list) {
        const timeout = r.timedOut === true;
        const why = timeout
          ? "timeout"
          : bare(r.name) === REFERENCE_CHECK_NAME
            ? "the reference check failed in its own code"
            : (checkSelfError(r.output) ?? "");
        retired.set(bare(r.name), { name: bare(r.name), upheld: true, votes: timeout ? "timeout" : "own error", reason: why });
        // Masked before the cut: the journal masks what it writes, but not a
        // command whose start the slice has already dropped.
        log?.append("note", { text: `check ${bare(r.name)} retired: ${why}`, output: self.maskWithheld(r.output).slice(-500) });
        yield {
          kind: "info",
          text: timeout
            ? `check ${bare(r.name)} timed out, which says nothing about the work; retired, and the claim judged without it`
            : `check ${bare(r.name)} failed in its own code, not on the work (${why}); retired, and the claim judged without it`,
        };
      }
    }
    /**
     * The model is stopped; the work on disk is not left unjudged.
     *
     * The clock and a failed provider both used to end a turn with no check
     * run: 6 of 20 local runs had no verdict, two with passing work in place.
     * The sealed bar runs once on the tree as it stands, and the turn's outcome
     * is what it says: verified only if it passed, not proven if it did not,
     * unverified when nothing was sealed. Returns whether a bar ran.
     */
    async function* judgeOnDisk(why: "deadline" | "provider" | "no-progress" | "malformed", claim: string): AsyncGenerator<EngineEvent, boolean> {
      self.turnEndedBy = why;
      if (opts.ask) return false;
      let barThis = barNow();
      if (!barThis || barThis.checks.length === 0) return false;
      // Whatever the runner allows after the deadline is short: a check may
      // not take the rest of it. Past the cap it is retired as timed out.
      const capMs = why === "deadline" ? DEADLINE_CHECK_CAP_MS : undefined;
      const capped = (b: Bar): Bar =>
        capMs === undefined
          ? b
          : { ...b, checks: b.checks.map((c) => (c.kind === "command" ? { ...c, timeoutMs: Math.min(c.timeoutMs, capMs) } : c)) };
      proofAttempts += 1;
      yield { kind: "proof_start", checks: barThis.checks.length, names: barThis.checks.map((c) => c.name) };
      let result = await self.runBarGuarded(claim, capped(barThis));
      const broken = brokenOwn(result);
      if (broken.length) {
        yield* retireBroken(broken);
        barThis = barNow();
        if (!barThis || barThis.checks.length === 0) {
          self.turnAllRetired = true;
          yield { kind: "info", text: "no other check is left to judge the work — this claim is unverified." };
          log?.append("session_end", { reason: `unverified: every check retired (${why})` });
          return true;
        }
        result = await self.runBarGuarded(claim, capped(barThis));
      }
      if (result.cancelled) return true;
      lastResult = result;
      self.actsSinceBar = 0;
      log?.append("bar_run", {
        attempt: proofAttempts,
        ok: result.ok,
        total: result.results.length,
        passed: result.results.filter((r) => r.ok).length,
        failed: result.results.filter((r) => !r.ok).map((r) => r.name).join(", "),
        ms: result.durationMs,
        endedBy: why,
        checks: result.results.map((r) => ({
          name: r.name, kind: r.kind, detail: r.detail, ok: r.ok, exitCode: r.exitCode ?? null, ms: r.durationMs, cached: r.cached === true,
          ...(r.ranInPlace ? { ranInPlace: r.ranInPlace } : {}),
        })),
      });
      const undetermined =
        !result.ok && (result.undetermined?.length ?? 0) > 0 && result.results.every((r) => r.ok || r.advisory || r.skipped);
      if (result.ok || undetermined) {
        const verdict = result.ok ? "accepted" : "undetermined";
        if (self.cfg.receipts) {
          const head = await treeState(self.cwd).catch(() => null);
          const receipt = self.cfg.receipts.write({
            claim, result, attempt: proofAttempts, verdict, head,
            model: self.modelOfRecord(), provider: self.provider, sessionTokens: self.sessionTokens,
            session: self.cfg.journal?.sessionId, costUsd: self.costUsd(), costEstimated: self.costEstimated,
            shedBatches: self.transcript.shedCount, endedBy: why,
            changed: self.turnLedger().map((e) => ({
              path: e.path, before: e.before, after: e.after,
              ...(e.changedLines?.length ? { lines: e.changedLines } : {}),
            })),
            cwd: self.cwd, did: [...self.did],
            task: taskSeal
              ? {
                  seal: sealOf(taskChecks, taskNotes),
                  checks: taskChecks.map((c) => (c.kind === "command" ? `${c.name}: ${c.run}` : `${c.name}: builtin ${c.builtin}`)),
                  notes: [...taskNotes],
                }
              : undefined,
          ...(verdict === "accepted" ? { tier: tierOf({ results: result.results, ...self.tierContext(result.results) }) } : {}),
          authors: self.receiptAuthors(),
          });
          log?.append("receipt", { verdict, file: receipt.path, attempt: proofAttempts, endedBy: why });
          self.bindReceipt(receipt.path, verdict);
          self.capture(receipt.path, verdict, userText, result, claim);
          lastReceipt = basename(receipt.path);
          lastReceiptPath = receipt.path;
          yield { kind: "receipt", path: receipt.path };
        }
        if (result.ok) {
          log?.append("session_end", { reason: "bar met", attempts: proofAttempts, endedBy: why });
          yield { kind: "proof_result", result, attempt: proofAttempts };
          yield* self.settlePassed(userText, proofAttempts, result.results.map((r) => r.name), lastReceipt, log);
        } else {
          log?.append("session_end", { reason: "undetermined", attempts: proofAttempts, endedBy: why });
        }
        return true;
      }
      yield* self.finishUnproven(claim, result, proofAttempts, log, why);
      return true;
    }
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
    const stepUnit = this.cfg.maxSteps === 0 ? Infinity : (this.cfg.maxSteps ?? MAX_STEPS);
    let stepCap = stepUnit;
    /**
     * The deadline fired while a request was in flight. The timer and the
     * clock agree to the millisecond at best, so the check below is told
     * rather than left to re-measure and perhaps disagree.
     */
    let deadlineInterrupted = false;
    /**
     * The no-progress guard, unattended only (src/scope.ts). Tool calls in a
     * row that advanced nothing: no file in the project changed, and each
     * call returned only what it had returned before (ProgressMeter). Reading
     * something new, running a command for the first time, or getting a
     * different answer from one is progress, wherever the work happens. At
     * `idleLimit` the model is told once to finish or stop, at twice that the
     * turn ends and the work on disk is judged the way the deadline judges
     * it. 2026-10-07: a worker made 90-125 calls a task reading other tasks'
     * logs and Maat's records until the clock ran out. HTTP backends only:
     * an ACP backend (grok-build://, OpenCode) runs its tools inside one step.
     */
    const idleLimit = this.cfg.unattended ? (this.cfg.noProgressCalls ?? noProgressCallsFromEnv()) : 0;
    let idleStamp = idleLimit > 0 ? treeStamp(this.cwd) : null;
    const progress = new ProgressMeter();
    /** Per call this step: whether it advanced anything (see ProgressMeter). */
    const advancedThisStep: boolean[] = [];
    let idleCalls = 0;
    let idleNudged = false;
    let idleStop = false;
    for (let step = 0; ; step++) {
      // Cancelled while nothing was in flight — during a permission question,
      // or between a tool and the next request. The next step is the next
      // thing the turn would have started, so it is where the turn ends, with
      // the same rollback and the same record as any other cancel.
      if (this.cancelRequested) {
        this.transcript.rollbackTo(turnStart);
        const wrote = [...new Set(this.ledger.map((e) => e.path))];
        log?.append("cancelled", { step, rolledBack: true, filesWritten: wrote });
        yield { kind: "cancelled", filesWritten: wrote };
        return;
      }
      if (step >= stepCap) {
        if (!opts.onCeiling) break;
        const spent =
          `${step} steps · ${this.sessionTokens} tokens` +
          (this.costUsd() === undefined ? "" : ` · ${fmtUsd(this.costUsd() ?? 0)}`);
        if (!(await opts.onCeiling(spent))) break;
        stepCap += stepUnit;
        log?.append("note", { text: `step guard raised at ${spent} — turn continues` });
        yield {
          kind: "info",
          text: `carrying on past ${spent}. Another ${stepUnit} steps before Maat asks again.`,
        };
      }
      // The wall clock, checked where the other ceilings are. This is
      // `autoresearch`'s fixed budget: the attempt gets its minutes, and
      // whatever state the work is in when they are up is the state the judge
      // sees. Unlike a token ceiling it is not a proxy for anything — it is
      // the thing the person waiting actually spends.
      if (idleStop) {
        yield {
          kind: "info",
          text:
            `no progress: ${idleCalls} tool calls in a row changed no file and returned nothing new, after ` +
            `being told to finish or stop — no more tool calls. The sealed checks judge the work as it stands.`,
        };
        const judged = yield* judgeOnDisk("no-progress", "");
        if (!judged) yield* this.salvage("No file in the project has changed for a long time; the turn is over.", fetchFn, log);
        return;
      }
      if (deadlineInterrupted || this.pastDeadline()) {
        const spentMs = Date.now() - this.turnStartedAt;
        log?.append("deadline", { limitMs: this.turnDeadlineMs, spentMs });
        const clock = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}s`);
        yield {
          kind: "info",
          text:
            `time budget reached (${clock(spentMs)} of ${clock(this.turnDeadlineMs)}) — no more ` +
            `tool calls. The bar still decides what the work was worth: nothing is committed ` +
            `that it did not pass.`,
        };
        // The work on disk is judged before anything else is asked of the
        // provider: a closing summary can take the minutes the verdict needs.
        const judged = yield* judgeOnDisk("deadline", "");
        if (!judged) yield* this.salvage("Your time budget for this turn is up.", fetchFn, log);
        return;
      }

      // A model that keeps sending malformed calls is stopped like a clock that
      // ran out: no more tool calls, the work on disk is judged, and the
      // receipt says the model, not the provider, ended the turn.
      if (this.malformedStreak >= MALFORMED_STOP) {
        log?.append("note", { text: `ended: malformed tool calls (${this.malformedStreak} in a row)`, malformedStop: true });
        yield {
          kind: "info",
          text: `ended: ${this.malformedStreak} malformed tool calls in a row — no more tool calls this turn. The work on disk is judged as it stands.`,
        };
        this.turnEndedBy = "malformed";
        const judged = this.turnWrites.length > 0 ? yield* judgeOnDisk("malformed", "") : false;
        if (!judged) yield* this.salvage("You sent several malformed tool calls in a row, so this turn has ended.", fetchFn, log);
        return;
      }

      // An explicit budget speaks for itself, and speaks first: one knob
      // should not produce two different messages.
      if (this.overBudget()) {
        yield {
          kind: "error",
          text: `budget hit (${this.budgetTokens} tokens) — loop stopped. /budget to raise.`,
          ceiling: "budget",
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
      // Zero unless someone set one. The self-hosted exception that used to
      // live here — no default ceiling on hardware you own — is gone with the
      // default itself: there is nothing left to make an exception to.
      const usdCeiling = this.cfg.maxTurnUsd ?? 0;
      const tokenCeiling = this.cfg.maxTurnTokens ?? 0;
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
      if (
        ceiling > 0 &&
        warned < CEILING_WARNINGS.length &&
        used >= ceiling * CEILING_WARNINGS[warned]!
      ) {
        // Every mark this step blew past, in one notice. The loop used to
        // yield one line per mark, so a step that jumped from 40% to 79%
        // printed the same sentence twice.
        while (warned < CEILING_WARNINGS.length && used >= ceiling * CEILING_WARNINGS[warned]!) {
          warned += 1;
        }
        /**
         * The percentage actually reached, not the mark that was crossed.
         *
         * This printed the threshold: "1589524 of 2000000 tokens — 50% of the
         * ceiling", which is 79%. A step can cross a mark and land well past
         * it, and a meter that misstates its own arithmetic is the one kind of
         * error this tool cannot afford anywhere.
         */
        const pct = Math.round((used / ceiling) * 100);
        /**
         * Advice in the unit that is actually binding.
         *
         * It said `/budget $5` unconditionally. Where no price is known —
         * every subscription ACP run, since a subscription turn has no dollar
         * figure at all — the money ceiling is not what stopped anything, so
         * that command would change a number nothing reads and the turn would
         * hit the same wall. A bare number sets the token ceiling; `$` sets
         * the money one.
         */
        const raise = priced ? `/budget ${fmtUsd(usdCeiling * 2)}` : `/budget ${ceiling * 2}`;
        yield {
          kind: "info",
          text:
            `this turn: ${ceilingLine} — ${pct}% of the ceiling. ${raise} raises it and the ` +
            `turn carries on; /budget off removes it entirely.`,
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
          ceiling: "turn",
          text:
            `stopped: this turn has spent ${ceilingLine}, its ceiling for a single turn. Nothing ` +
            `was verified. Narrow the request, raise it with /budget, or remove it with ` +
            `/budget off.`,
        };
        yield* this.salvage(`This turn reached its spending ceiling (${ceilingLine}).`, fetchFn, log);
        return;
      }

      /**
       * Context management, for the backend that has any.
       *
       * An ACP agent holds its own conversation and compacts it its own way;
       * molt's transcript is a record of what was said, not the thing being
       * sent. Eliding and shedding it there would buy nothing, and shedding
       * would archive into exuviae a context that was never in flight —
       * evidence of a conversation molt did not have.
       */
      // Mechanical, and a smaller move than shedding: prune tool results that
      // later work has made irrelevant before considering the much heavier
      // option of shedding. Not free, though — see below.
      if (!this.subprocess && this.cfg.elideSuperseded !== false) {
        // Protect the prefix once this endpoint has shown it caches. Eliding
        // rewrites a message in the middle of the conversation, so everything
        // after it is a cache miss on the next request — measured at 0% on the
        // step after each elision in a real session. Where nothing has ever
        // been served from cache there is nothing to protect and elision runs
        // as it always did.
        const pruned = this.transcript.elideSupersededReads({
          protectCache: this.sessionCached > 0,
        });
        if (pruned.elided > 0) {
          log?.append("elide", {
            elided: pruned.elided,
            tokensSaved: pruned.tokensSaved,
            deferred: pruned.deferred,
          });
          yield {
            kind: "info",
            text: `pruned ${pruned.elided} superseded tool result(s) · ${pruned.tokensSaved} tokens freed`,
          };
        } else if (pruned.deferred > 0) {
          log?.append("elide", { elided: 0, tokensSaved: 0, deferred: pruned.deferred });
        }
      }

      const auto = this.subprocess ? 0 : this.cfg.autoShedAtTokens ?? DEFAULT_AUTO_SHED_TOKENS;
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
          yield { kind: "shed", ...shed };
        }
      }

      const stepStartedAt = Date.now();
      /** Calls made before this step, so a subprocess step can tell whether it ran any. */
      const callsBeforeStep = this.turnCalls.size;
      const wire = this.transcript.wire();
      const requestEst = this.bom().requestTotalEst;
      let msg: Msg | undefined;
      let usage: Usage | undefined;
      let finishReason: string | undefined;
      /** Whether this step's text already went out as deltas. */
      let streamedContent = false;

      if (this.subprocess) {
        // The ACP agent runs the model, the tool calls and its own context. What
        // comes back is the same three things the HTTP path produces — a final
        // message, what it cost in tokens, and why it stopped — so everything
        // below this branch is shared.
        const got = yield* this.subprocessStep(step, {
          step,
          userText,
          confirm,
          log,
          shown,
          answered,
        });
        if (got === "cancelled") {
          this.transcript.rollbackTo(turnStart);
          const wrote = [...new Set(this.ledger.map((e) => e.path))];
          log?.append("cancelled", { step, rolledBack: true, filesWritten: wrote });
          yield { kind: "cancelled", filesWritten: wrote };
          return;
        }
        if (got === "deadline") {
          deadlineInterrupted = true;
          continue;
        }
        if (got === "stall") {
          // Work that happened is judged, as after any provider failure; no
          // closing summary is asked of a provider that has just gone silent.
          const judged = this.turnWrites.length > 0 ? yield* judgeOnDisk("provider", "") : false;
          if (!judged) this.turnEndedBy = "provider";
          return;
        }
        if (!got) return;
        msg = got.msg;
        usage = got.usage;
        finishReason = got.finishReason;
        streamedContent = got.streamed;
      } else {
        const stream = this.cfg.stream !== false;
        const controller = new AbortController();
        this.inFlight = controller;

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
        /**
         * This attempt's watchdog: silence and the deadline, on top of ctrl+C.
         * Every send in the attempt goes through it, so the fallbacks below
         * (stream_options, cache_control, the output ceiling) are watched too.
         */
        let watch: Watchdog | undefined;
        const idle = requestIdleMs(this.cfg.requestIdleMs);
        const send = (withUsage: boolean, withCache = !this.cachingUnsupported): Promise<Response> => {
          const marks = withCache && this.cacheStyle === "explicit" ? new Set(breakpoints(wire)) : undefined;
          const body = this.native
            ? toRequest(wire, this.offeredTools as typeof TOOLS, {
                model: this.cfg.model,
                maxTokens: this.maxTokensFor(),
                stream,
                toolChoice: "auto",
                cacheAt: marks,
              })
            : {
                model: this.cfg.model,
                // Breakpoints on providers that need them, nothing on providers
                // that cache by themselves. Never a change to the text.
                messages: withCaching(wire, this.cacheStyle, withCache),
                tools: this.offeredTools,
                tool_choice: "auto",
                ...(this.effortNow ? { reasoning: { effort: this.effortNow } } : {}),
                // Thinking off on a self-hosted server, where `reasoning` is
                // ignored (see selfHostedThinking). Nothing on a cloud endpoint.
                ...selfHostedThinking(this.cfg.baseUrl, this.effortNow),
                ...openRouterProvider(this.cfg.baseUrl, this.cfg.model),
                // Always a cap. Without one a router fills in the model's whole
                // listed output, and a server that counts it against the window
                // refuses every request (completionOverflow).
                ...(this.maxTokensUnsupported ? {} : { max_tokens: this.maxTokensFor() }),
                ...(stream ? { stream: true } : {}),
                ...(withUsage ? { stream_options: { include_usage: true } } : {}),
              };
          const w = watch;
          return fetchFn(this.endpoint, {
            method: "POST",
            signal: w?.signal ?? controller.signal,
            headers: {
              "content-type": "application/json",
              ...authHeaders(this.cfg.baseUrl, this.cfg.apiKey),
            },
            body: (this.lastRequestBody = JSON.stringify(body)),
          }).then((r) => (w ? w.watch(r) : r));
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
        let failure:
          | { text: string; why: string; retryable: boolean; retryAfterMs?: number; overload?: boolean }
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
        /** The deadline ended this step's request; the step loop closes the turn. */
        let deadlineHit = false;

        /** This request's turn at a self-hosted endpoint (src/localgate.ts); a no-op otherwise. */
        let releaseTurn: () => void = () => {};
        for (let attempt = 0; ; attempt++) {
          failure = undefined;
          msg = undefined;
          watch?.dispose();
          // An attempt that left through a `continue` or a `break` inside the
          // try (a shed-and-retry, a refusal that stops the retries) never
          // reached the release below; its turn is given back here and after
          // the loop, or the next request to a one-slot server waits for it
          // for ever. Safe to call twice.
          releaseTurn();
          // Taken before the watchdog starts: waiting behind Maat's own other
          // requests to a one-slot local server is not the server being hung.
          releaseTurn = await takeTurn(this.cfg.baseUrl, controller.signal).catch(() => () => {});
          watch = new Watchdog(controller.signal, {
            firstByteMs:
              this.cfg.requestFirstByteMs ??
              envFirstByteMs() ??
              firstByteMs(idle, {
                promptTokens: Math.round(requestEst * this.tokenScale),
                maxTokens: this.maxTokensFor(),
                stream,
              }, isSelfHosted(this.cfg.baseUrl) ? localSpeed() : undefined),
            idleMs: idle,
            deadlineAt: this.deadlineAt(),
          }, isSelfHosted(this.cfg.baseUrl) ? undefined : this.latency);
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
                  text: "provider rejected stream_options — token counts fall back to Maat's estimate",
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

            // A model whose own output maximum is below molt's default says
            // so, and says what the maximum is. Same shape as the two
            // fallbacks above: retry once, and only believe the ceiling was
            // the problem if that works.
            if (!res.ok && res.status === 400 && this.modelMaxTokens === undefined && !this.maxTokensUnsupported) {
              const cap = outputCeiling(body);
              if (cap && cap < this.maxTokensFor()) {
                const was = this.maxTokensFor();
                this.modelMaxTokens = cap;
                const retry = await send(askForUsage && !this.streamUsageUnsupported);
                if (retry.ok) {
                  log?.append("note", {
                    text: `${this.cfg.model} accepts ${cap} output tokens, not ${was} — using its maximum`,
                  });
                } else {
                  // Not the ceiling after all. Forget it rather than spending
                  // the rest of the session on a smaller answer for a reason
                  // that turned out to be wrong.
                  this.modelMaxTokens = undefined;
                }
                res = retry;
                body = res.ok ? "" : (await res.text().catch(() => ""));
              }
            }

            // The completion reserve overflowed, not the prompt: ask for a
            // smaller reply and send the same history again. Shedding cannot
            // fix this one, and it was ending runs "too large and nothing left
            // to shed" on a 2,454-token prompt.
            for (let i = 0; i < 2 && !res.ok && res.status === 400; i++) {
              const co = completionOverflow(body);
              const fit = co ? fittedCompletion(co) : null;
              if (!co || fit === null || fit >= this.maxTokensFor()) break;
              const was = this.maxTokensFor();
              this.fittedCompletion = fit;
              this.fittedGuessed = false;
              log?.append("note", {
                body: body.slice(0, 600),
                text:
                  `the completion reserve overflowed the ${co.window}-token window (${co.input} input + ` +
                  `${co.completion} completion) — max_tokens ${was} → ${fit}, retried without shedding`,
              });
              yield {
                kind: "info",
                text: `this endpoint counts the reply against its ${co.window}-token window — asking for at most ${fit} output tokens instead of ${was}.`,
              };
              res = await send(askForUsage && !this.streamUsageUnsupported);
              body = res.ok ? "" : (await res.text().catch(() => ""));
            }

            // A window refusal in wording none of the above reads, from a
            // request that carried a large cap. Try one smaller cap before
            // shedding: shedding cannot fix a reserve overflow, and before
            // max_tokens was always sent these servers fitted the reply
            // themselves. Kept only if it works.
            if (!res.ok && res.status === 400 && !this.maxTokensUnsupported) {
              const was = this.maxTokensFor();
              const guess = reserveFallback(body, was, Math.round(this.bom().requestTotalEst * this.tokenScale));
              if (guess !== null && guess < was) {
                const before = { fitted: this.fittedCompletion, guessed: this.fittedGuessed };
                this.fittedCompletion = guess;
                this.fittedGuessed = true;
                const retry = await send(askForUsage && !this.streamUsageUnsupported);
                if (retry.ok) {
                  log?.append("note", {
                    body: body.slice(0, 600),
                    text: `window refusal with max_tokens ${was} — ${guess} was accepted, kept for the session`,
                  });
                  yield {
                    kind: "info",
                    text: `this endpoint refused a ${was}-token reply reserve — asking for at most ${guess} output tokens instead.`,
                  };
                } else {
                  this.fittedCompletion = before.fitted;
                  this.fittedGuessed = before.guessed;
                }
                res = retry;
                body = res.ok ? "" : (await res.text().catch(() => ""));
              }
            }

            // A provider that will not take `max_tokens` at all (OpenAI's
            // reasoning models want max_completion_tokens). Try once without;
            // only believe the field was the problem if that works.
            if (!res.ok && res.status === 400 && !this.native && !this.maxTokensUnsupported && refusedMaxTokens(body)) {
              this.maxTokensUnsupported = true;
              const retry = await send(askForUsage && !this.streamUsageUnsupported);
              if (retry.ok) {
                log?.append("note", { text: "provider refused max_tokens — sending requests without an output cap" });
              } else {
                this.maxTokensUnsupported = false;
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
                  body: body.slice(0, 600),
                  text:
                    `context window ${over.window || "unknown"}; server counted ${over.sent} where ` +
                    `maat estimated ${bom.requestTotalEst} (x${this.tokenScale.toFixed(2)}) — ` +
                    `round ${overflowRounds}, history target ${target || "unknown"}`,
                });
                yield {
                  kind: "info",
                  text: over.window
                    ? `this endpoint serves ${over.window} tokens and counted ${over.sent} in that ` +
                      `request — about ${this.tokenScale.toFixed(1)}x Maat's estimate. Carrying less ` +
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
                  yield {
                    kind: "shed",
                    dropped: shed.dropped,
                    before: shed.before,
                    after: shed.after,
                    path: shed.path,
                  };
                  failure = {
                    text: "context window too small for what Maat was carrying",
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
                      text: "context window too small for what Maat was carrying",
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
                      `left to shed — Maat's system prompt and tool definitions alone are about ` +
                      `${fixedReal} as it counts them. Restart the server with a larger context ` +
                      `(-c ${need} or more), or use an endpoint that serves one.`
                    : "the endpoint refused the request as too large and there is nothing left to shed.",
                  why: "Shedding cannot make this request fit.",
                  retryable: false,
                };
                break;
              }
              const transient = res.status === 408 || res.status === 429 || res.status >= 500;
              const resetAt = res.status === 429 ? rateLimitResetAt(body) : undefined;
              if (resetAt !== undefined && resetAt - Date.now() > LONG_RATE_LIMIT_MS) {
                failure = {
                  text: `the provider's rate limit is reached ${untilText(resetAt)} — ${body.slice(0, 200)}`,
                  why: "The provider will not take requests again until its limit resets; waiting inside a turn cannot get past it.",
                  retryable: false,
                };
                break;
              }
              failure = {
                text: `HTTP ${res.status}: ${body.slice(0, 300)}`,
                why: `The provider refused the request with HTTP ${res.status}.`,
                retryable: transient,
                ...(res.status === 429 || res.status === 503 || res.status === 529 ? { overload: true } : {}),
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
                // Answer text and reasoning share one queue, tagged, so the
                // loop below wakes for either and keeps their order.
                const frag = new Fragments<{ text: string; thought?: true }>();
                const safe = new SafeStream((t: string) => redact(t, this.secrets()));
                const safeThought = new SafeStream((t: string) => redact(t, this.secrets()));
                let streamAcc: StreamAccumulator | undefined;
                let live = "";
                shownThisAttempt = false;
                const reading = readStream(
                  res.body!,
                  (fragment) => frag.push({ text: fragment }),
                  (a) => (streamAcc = a),
                  (thought) => frag.push({ text: thought, thought: true }),
                )
                  .then((r) => {
                    frag.finish();
                    return r;
                  })
                  .catch((e: unknown) => {
                    frag.finish();
                    throw e;
                  });
                for await (const piece of frag.drain()) {
                  if (piece.thought) {
                    // Redacted like the answer: reasoning quotes files too.
                    const shown = safeThought.take(piece.text);
                    if (shown) yield { kind: "thought", text: shown };
                    continue;
                  }
                  const fragment = piece.text;
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
                const thoughtTail = safeThought.flush();
                if (thoughtTail) yield { kind: "thought", text: thoughtTail };
                const tail = safe.flush();
                if (tail) {
                  streamedContent = true;
                  shownThisAttempt = true;
                  yield { kind: "delta", text: tail };
                }
                const result = await reading;
                if (result.error) failure = providerFailure(result.error);
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
                  error?: ProviderError;
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
                  if (json.error && typeof json.error === "object") failure = providerFailure(json.error);
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
              if (msg) msg = normalizeMessage(msg);
            }
          } catch (e) {
            if (controller.signal.aborted) {
              releaseTurn();
              watch.dispose();
              this.inFlight = undefined;
              this.transcript.rollbackTo(turnStart);
              const wrote = [...new Set(this.ledger.map((e) => e.path))];
              log?.append("cancelled", { step, rolledBack: true, filesWritten: wrote });
              yield { kind: "cancelled", filesWritten: wrote };
              return;
            }
            /**
             * An endpoint that is not an address is not a network problem.
             *
             * `fetch` reports both as a TypeError, so Maat retried
             * `--url grok` — the shorthand, typed at a build too old to expand
             * it — four times over seven seconds and then called it a network
             * failure. Nothing was down. Asked before the generic case, because
             * this policy's own rule is that what cannot improve on a second
             * attempt is not retried.
             */
            const badEndpoint = endpointProblem(this.cfg.baseUrl);
            failure = badEndpoint
              ? {
                  text: badEndpoint,
                  why: "The endpoint Maat was pointed at is not a usable address.",
                  retryable: false,
                }
              : {
                  text: `network: ${errorText(e)}`,
                  why: "The connection to the provider failed and could not be re-established.",
                  retryable: true,
                };
          }
          releaseTurn();
          // The watchdog, whichever layer noticed it. A body read cut off by
          // it can surface as "not JSON" or as a network error, and neither is
          // what happened.
          if (watch.reason === "deadline") {
            deadlineHit = true;
            failure = undefined;
            msg = undefined;
            break;
          }
          if (watch.reason === "idle") {
            msg = undefined;
            failure = {
              text:
                `no response from the provider for ${waited(watch.waitedMs)} — the ` +
                `connection looks hung`,
              why: "The provider stopped responding.",
              retryable: true,
            };
          }

          if (failure) msg = undefined;
          // A request that completed teaches the session what this provider's
          // normal looks like (watchdog.ts LatencyLearner). Local servers keep
          // their hardware-based allowances.
          if (!failure && msg && !isSelfHosted(this.cfg.baseUrl)) this.latency.record(watch);
          if (!failure) break;
          const retries = failure.overload ? OVERLOAD_RETRIES : NETWORK_RETRIES;
          if (!failure.retryable || attempt >= retries) break;
          // About to replay this message from the beginning. Anything already on
          // screen belongs to an attempt that is being abandoned, and leaving it
          // there would show the reader the same sentence twice with no way to
          // tell which one the model actually finished.
          if (shownThisAttempt) {
            shownThisAttempt = false;
            yield { kind: "stream_reset", why: failure.text };
          }
          const backoff = this.cfg.retryBackoffMs ?? (failure.overload ? OVERLOAD_BACKOFF_MS : NETWORK_BACKOFF_MS);
          const wait = failure.retryAfterMs ?? backoff[attempt] ?? backoff.at(-1) ?? 4_000;
          log?.append("note", { text: `${failure.text} — retrying in ${wait}ms` });
          yield {
            kind: "info",
            text:
              `${failure.text} — retrying in ${Math.round(wait / 100) / 10}s, ` +
              `attempt ${attempt + 2} of ${retries + 1}`,
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

        watch?.dispose();
        releaseTurn();
        this.inFlight = undefined;

        if (deadlineHit) {
          // The request was ended by the clock, not by the provider. Nothing
          // it said is kept — the step loop's deadline check closes the turn
          // the way it closes any other that ran out of time, salvage and all.
          if (shownThisAttempt) yield { kind: "stream_reset", why: "time budget reached" };
          log?.append("note", { text: `time budget reached during step ${step}'s request — request ended` });
          deadlineInterrupted = true;
          continue;
        }

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
          // Work that happened is judged, whatever the provider did after it.
          const judged = this.turnWrites.length > 0 ? yield* judgeOnDisk("provider", "") : false;
          if (!judged && failure?.retryable !== false) {
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
      // One low step is not a state. A provider serving a cached prefix from
      // behind a load balancer answers erratically — 67%, then 4%, then 0%,
      // then 51%, then 80%, with nothing on molt's side changing between them
      // — and the first version of this warning latched on that single 4% and
      // announced that "every step from here re-bills the whole context",
      // which the next step disproved. It is a streak or it is noise.
      if (reportedUsage && pTok > CACHE_WATCH_TOKENS) {
        const hit = cachedTok / pTok;
        if (hit >= 0.25) {
          this.cacheWasWorking = true;
          this.lowCacheStreak = 0;
        } else {
          this.lowCacheStreak += 1;
          if (
            this.cacheWasWorking &&
            !this.warnedCacheLost &&
            this.lowCacheStreak >= CACHE_LOST_STREAK
          ) {
            this.warnedCacheLost = true;
            yield {
              kind: "info",
              text:
                `prompt caching has not recovered: ${this.lowCacheStreak} steps in a row reused ` +
                `almost none of the conversation, the last of them ${cachedTok} of ${pTok} tokens ` +
                `(${Math.round(hit * 100)}%), after earlier steps were reusing most of it. While ` +
                `it stays this way each step is billed for the whole context. If it does not come ` +
                `back, a fresh session re-establishes the cache more cheaply than continuing.`,
            };
          }
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
      const summary = (
        tools: string[],
        outcome: "tools" | "claim" | "empty" | "truncated" | "narrated",
      ): EngineEvent => ({
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

      // Batch mode: an act with no actions is the model saying it is done,
      // with its answer in the analysis. It becomes exactly that — a reply
      // with text and no tool call — so the claim path is the ordinary one.
      if (this.cfg.batch && msg.tool_calls?.length) {
        const acts = msg.tool_calls.map((c) => expandAct(c));
        // Finished only when every act really is empty. One that carried
        // actions Maat could not read is not "done": it goes to the tool path
        // below, which answers it with an error naming the expected shape.
        if (acts.every((a) => a !== null && a.subs.length === 0 && a.unusable === 0)) {
          const said = acts.map((a) => a!.analysis).filter(Boolean).join("\n\n");
          msg = { ...msg, content: [msg.content, said].filter((x) => x && x.trim()).join("\n\n") };
          delete (msg as { tool_calls?: unknown }).tool_calls;
        }
      }

      this.transcript.push({
        role: "assistant",
        content: msg.content ?? null,
        ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
      });

      // The message is complete. Said before the tool calls below, so what the
      // model wrote appears above the work it was introducing rather than
      // after it — and so the next step starts on a line of its own.
      yield { kind: "message_end" };

      // ---- A turn with nothing in it is not a claim. ----
      //
      // No text, no tool call. molt used to fall straight through to the proof
      // loop and run the whole bar against an unchanged tree, because "the
      // model stopped calling tools" was taken to mean "the model says it is
      // done". For a model that simply drops a turn — and small local ones do
      // it constantly — that is a full suite spent proving that nothing
      // happened, and a receipt whose claim reads "(no final message)".
      //
      // Say what arrived and ask again. Only if it keeps arriving empty does
      // it get treated as the claim it never was, so this can slow a turn down
      // by EMPTY_TURN_RETRIES requests but can never stop one.
      if (!msg.tool_calls?.length && !(msg.content ?? "").trim()) {
        emptyTurns += 1;
        if (emptyTurns <= EMPTY_TURN_RETRIES) {
          log?.append("empty_turn", {
            step,
            attempt: emptyTurns,
            finishReason: finishReason ?? null,
          });
          this.transcript.push({
            role: "user",
            content:
              "[molt: that turn arrived empty — no text and no tool call, so nothing ran " +
              "and nothing was checked. Either call a tool to carry on with the work, or " +
              "write out what you have found. An empty turn is not an answer.]",
            molt: { nudge: true },
          });
          yield summary([], "empty");
          yield {
            kind: "info",
            text:
              `the model returned an empty turn` +
              (finishReason ? ` (${finishReason})` : "") +
              ` — asking again rather than running the bar on nothing` +
              (emptyTurns === EMPTY_TURN_RETRIES ? "; the next one is taken as its answer" : ""),
          };
          continue;
        }
      } else {
        emptyTurns = 0;
      }

      if (msg.tool_calls?.length) {
        const called: string[] = [];
        let autoRan = 0;
        let repeated = 0;
        // Batch mode: each act is run as the ordinary calls it holds, then
        // their results fold back into one result for the act.
        type Planned = { id: string; name: string; rawArgs: string; truncated: boolean };
        const planned: Planned[] = [];
        const folds: { id: string; parts: { id: string; label: string }[] }[] = [];
        for (const [i, call] of msg.tool_calls.entries()) {
          const last = finishReason === "length" && i === msg.tool_calls.length - 1;
          const act = this.cfg.batch ? expandAct(call) : null;
          if (act && act.unusable > 0) {
            log?.append("note", { text: `act with ${act.unusable} unreadable action(s)`, args: (call.function?.arguments ?? "").slice(0, 20_000) });
          }
          // An act with any action Maat could not read runs none of them: the
          // others may depend on the one that was dropped (a write, then the
          // command that reads it), and the model, shown results for fewer
          // actions than it sent, would not know which one vanished. It goes
          // the unreadable way below and is answered with the expected shape.
          if (act && act.subs.length && act.unusable === 0) {
            act.subs.forEach((sub, k) =>
              planned.push({ id: sub.id, name: sub.name, rawArgs: sub.rawArgs, truncated: last && k === act.subs.length - 1 }),
            );
            folds.push({ id: call.id, parts: act.subs.map((sub) => ({ id: sub.id, label: sub.label })) });
          } else {
            planned.push({
              id: call.id,
              name: call.function?.name ?? "unknown",
              rawArgs: call.function?.arguments ?? "",
              // Only the last one can be the one that ran out of room.
              truncated: last,
            });
          }
        }
        if (pendingCriteria && planned.some((p) => changesSomething(p.name, p.rawArgs))) yield* settleCriteria(false);
        advancedThisStep.length = 0;
        for (const p of planned) {
          const outcome = yield* this.invokeTool(p, { step, userText, confirm, log, shown, answered });
          if (idleLimit > 0) {
            let parsed: Record<string, unknown> | undefined;
            try {
              const v = JSON.parse(p.rawArgs || "{}") as unknown;
              if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
            } catch {
              /* malformed: its answer is Maat's complaint, which is never progress */
            }
            const key = parsed ? callKey(outcome.name, parsed) : `${outcome.name}(${p.rawArgs})`;
            advancedThisStep.push(!outcome.repeated && progress.advanced(key, outcome.result));
          }
          called.push(outcome.name);
          if (outcome.repeated) repeated += 1;
          if (outcome.auto) autoRan += 1;
        }
        for (const f of folds) this.transcript.combineToolResults(f.id, f.parts);
        const clock = this.clockNote();
        if (clock) this.transcript.noteOnLastToolResult(clock);
        if (announceAfterTools) {
          announceAfterTools = false;
          announceCriteria();
        }
        yield summary(called, "tools");

        if (idleLimit > 0) {
          const stamp = treeStamp(this.cwd);
          const changed = stamp === null || idleStamp === null || stamp !== idleStamp;
          idleStamp = stamp;
          if (changed) {
            // A file in the project changed, or the tree could not be measured
            // (never counted as idle).
            idleCalls = 0;
            idleNudged = false;
          } else {
            // In order: the run of non-advancing calls is what is counted, and
            // one call that advanced anything starts it again.
            for (const a of advancedThisStep) {
              if (a) {
                idleCalls = 0;
                idleNudged = false;
              } else idleCalls += 1;
            }
            if (!idleNudged && idleCalls >= idleLimit) {
              idleNudged = true;
              log?.append("no_progress", { step, calls: idleCalls, limit: idleLimit, action: "nudged" });
              yield { kind: "info", text: `no progress: ${idleCalls} tool calls in a row changed no file and returned nothing new — told the model to finish or stop` };
              this.transcript.push({
                role: "user",
                content:
                  `[molt: your last ${idleCalls} tool calls changed no file and returned nothing they ` +
                  `had not returned before. Repeating them will not finish the task. If you know what ` +
                  `to change, change it now and say done. If you cannot finish, say plainly what is ` +
                  `blocking you and stop. If ${idleLimit} more calls advance nothing, the turn ends ` +
                  `and the work is judged as it stands.]`,
                molt: { nudge: true },
              });
            } else if (idleNudged && idleCalls >= 2 * idleLimit) {
              log?.append("no_progress", { step, calls: idleCalls, limit: idleLimit, action: "stopped" });
              idleStop = true;
            }
          }
        }

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
              `${repeated} of ${called.length} calls that step were things Maat had already ` +
              `answered — little or nothing new came back` +
              (dryStreak >= 2
                ? `. That is ${dryStreak} steps in a row; it is spending against ` +
                  `${this.budgetTokens === undefined ? "this turn's ceiling" : "your /budget"} ` +
                  `without learning anything. shift+V to watch what it is reaching for.`
                : ""),
          };
          // The streak, said to the party that can end it.
          //
          // Everything above this line is for the human: the log line is for
          // the audit and the info event is for the screen. The model was told
          // only ever about the single call in front of it — "this is the same
          // read you made at step 41" — which it can answer by making a
          // slightly different read, forty times running, and did. Nothing in
          // its context said "you have now spent four steps learning nothing".
          //
          // This does not end the turn. Ending a turn on repetition was tried
          // and reverted for good reasons, recorded above: repetition is a
          // guess at waste and a bad one. Telling the model what molt can
          // plainly see costs a few hundred tokens and takes nothing away.
          if (dryStreak >= DRY_STREAK_NUDGE && dryStreak - nudgedAtStreak >= DRY_STREAK_NUDGE) {
            nudgedAtStreak = dryStreak;
            this.transcript.push({
              role: "user",
              content:
                `[molt: ${dryStreak} steps in a row have now returned things you had already ` +
                `been given. Re-reading a file Maat has already shown you, or re-running a ` +
                `search you have already run, cannot tell you anything new — the answers are ` +
                `above in this conversation. If you know what to change, change it. If you do ` +
                `not, say plainly what is blocking you and stop; Maat records an unfinished ` +
                `turn honestly. Do not keep looking.]`,
              molt: { nudge: true },
            });
          }
        } else {
          dryStreak = 0;
          nudgedAtStreak = 0;
        }
        continue; // let the model see tool results
      }

      // ---- A tool call written as text is not a tool call. ----
      //
      // The reply names a call — `<tool_call>…`, a JSON `{"name": "write_file",
      // "arguments": …}`, "Calling edit_file with …", a `[Tool result]` it
      // wrote itself — and the provider returned no tool call. Nothing ran.
      // Read as a claim, that is a bar spent on an unchanged tree and, in ask
      // mode or with no bar, an answer built on results nobody produced. It
      // happens most after a shed, when the transcript the model is imitating
      // is a digest that describes calls in prose.
      //
      // Said in the transcript, because the screen is not where the model
      // reads. A subprocess backend runs its tools inside the step, so there a
      // step that did call something is left alone: its text is a report.
      const narrated =
        msg.content && !(this.subprocess && this.turnCalls.size > callsBeforeStep)
          ? narratedCallIn(msg.content, this.cfg.batch ? [...MOLT_TOOL_NAMES, "act"] : undefined)
          : null;
      if (narrated) {
        narratedTurns += 1;
        const giveUp = narratedTurns > NARRATED_CALL_RETRIES;
        log?.append("narrated_call", {
          step,
          attempt: narratedTurns,
          found: narrated,
          finishReason: finishReason ?? null,
          ...(giveUp ? { passedToBar: true } : {}),
        });
        if (!giveUp) {
          this.transcript.push({
            role: "user",
            content: narratedCallNudge(narrated),
            molt: { nudge: true },
          });
          yield summary([], "narrated");
          yield {
            kind: "info",
            text:
              `the model wrote a tool call as text instead of making one (${narrated}) — ` +
              `nothing ran. Telling it so rather than reading that as a finished claim` +
              (narratedTurns === NARRATED_CALL_RETRIES
                ? "; the next one goes to the bar as its answer"
                : ""),
          };
          continue;
        }
        yield {
          kind: "info",
          text:
            `the model has written tool calls as text ${narratedTurns} times running — ` +
            `passing this reply to the bar as its answer. The calls it describes did not run.`,
        };
      } else {
        narratedTurns = 0;
      }

      // ---- A sentence that stopped mid-word is not a claim of completion. ----
      //
      // With no tool call, the next thing molt does is treat this message as
      // "I am finished" and spend the whole bar deciding whether it is true.
      // A message cut off at the output ceiling did not decide to stop; it ran
      // out of room. Asking it to carry on costs one step. Running the bar on
      // it costs the suite, and produces a receipt whose claim is half a
      // sentence.
      if (finishReason === "length" && truncatedTurns < TRUNCATED_TURN_RETRIES) {
        truncatedTurns += 1;
        // The cap this reply hit, before any change below: the note, the
        // nudge and the info line report what happened, not what comes next.
        const hit = this.maxTokensFor();
        // A reply that actually hit the default cap earns a larger one; a cap
        // the person set, or one the server said is all that fits, stays. A
        // fitted cap that was only a guess is dropped; if the full one is
        // refused again, the refusal fits it again.
        if (this.cfg.maxTokens === undefined && this.outputCap < OUTPUT_CAP_MAX && hit === this.outputCap) {
          this.outputCap = Math.min(OUTPUT_CAP_MAX, this.outputCap * 2);
        } else if (this.fittedGuessed && hit === this.fittedCompletion) {
          this.fittedCompletion = undefined;
          this.fittedGuessed = false;
        }
        const next = this.maxTokensFor();
        log?.append("note", {
          text: `reply cut off at the ${hit}-token output ceiling` + (next !== hit ? `; the next request asks for ${next}` : ""),
          step,
          attempt: truncatedTurns,
        });
        this.transcript.push({
          role: "user",
          content:
            `[molt: that reply hit the output ceiling of ${hit} tokens and stopped ` +
            `part-way through, so it is not being read as a finished answer. Continue from where ` +
            `it stops, and keep what remains short.]`,
          molt: { nudge: true },
        });
        yield summary([], "truncated");
        yield {
          kind: "info",
          text:
            `the reply was cut off at the ${hit}-token output ceiling — asking it ` +
            `to continue rather than running the bar on half a sentence` +
            (this.cfg.maxTokens === undefined ? " (raise it with --max-tokens)" : ""),
        };
        continue;
      }

      yield summary([], "claim");

      // ---- The model believes it is finished. That is a claim. ----
      const claim = msg.content ?? "";
      if (pendingCriteria) yield* settleCriteria();
      if (referencePending) yield* joinReference();
      if (lateCriteria) yield* joinLateCriteria();

      // Once per turn, unattended, before anything is judged: each stated
      // requirement beside the commands the model ran for it. The checks are
      // hidden, so nothing else sends the model back down the task's list.
      // Exactly one round; the hidden checks never appear in it.
      if (this.cfg.unattended && this.cfg.signOut === true && !signedOut && !opts.ask && requirements.length) {
        signedOut = true;
        const so = signOut(requirements, this.did);
        this.turnSignOut = so;
        log?.append("note", {
          text: "requirements put to the model for sign-out before judging",
          signout: so,
        });
        yield {
          kind: "info",
          text:
            `before checking: signing out ${requirements.length} stated requirement(s) — ` +
            `${so.unexercised.length} not yet run`,
        };
        this.transcript.push({ role: "user", content: signOutMessage(so), molt: { nudge: true } });
        continue;
      }

      // Once per turn, before anything is judged: what the work left behind
      // that the task did not ask for. A nudge, never a deletion — the model
      // knows which of them the task needs, and says so or removes the rest.
      if (turnListing && !leftoversAsked && !opts.ask) {
        leftoversAsked = true;
        const extra = unnamedNewFiles(turnListing, listProject(this.cwd), userText);
        if (extra.length) {
          const shown = extra.slice(0, 12).join(", ") + (extra.length > 12 ? `, and ${extra.length - 12} more` : "");
          log?.append("note", { text: "files the task does not name, put to the model before judging", files: extra.slice(0, 50) });
          yield { kind: "info", text: `before checking: asking about files the task does not name — ${shown}` };
          this.transcript.push({
            role: "user",
            content:
              `[Maat: before this is checked — you created files the task does not name: ${shown}. ` +
              "If any is a helper script, a copy, a test or scratch file you made for yourself, delete it now: " +
              "the task's directory should hold only what the task asks for. If the task needs one, say which in a " +
              "line. Then give your final answer again.]",
          });
          continue;
        }
      }

      if (!bar || bar.checks.length === 0) {
        yield {
          kind: "info",
          text: opts.ask
            ? "nothing left in the bar to check a question against — this answer is unverified."
            : "no .maat/done.yml — completion is unverified. run `maat init` to add a bar.",
        };
        // The turn is over, and the record says so. Without this a turn with
        // no bar ended on its last `response`, which is exactly what a turn
        // killed mid-request looks like — and `molt verify` would say so.
        log?.append("session_end", { reason: opts.ask ? "answered" : "unverified: no bar" });
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

      // A dispute of a drafted check that failed last time: ruled on by
      // independent reviews before the bar runs again (src/dispute.ts).
      let retiredNow = 0;
      let rejectedNow = 0;
      if (lastResult !== null) {
        for (const d of parseDisputes(claim)) {
          const failed = lastResult.results.find((r) => !r.ok && r.hidden === true && bare(r.name) === d.name);
          const check = taskChecks.find((c) => bare(c.name) === d.name && c.hidden === true);
          if (!failed || !check || check.kind !== "command" || disputed.has(d.name)) {
            yield {
              kind: "info",
              text: disputed.has(d.name)
                ? `${d.name} was already disputed once; the ruling stands`
                : `no failing drafted check is named ${d.name}; only those can be disputed`,
            };
            continue;
          }
          disputed.add(d.name);
          const arb = this.cfg.dispute;
          const arbModel = arb?.model || this.cfg.model;
          const arbUrl = arb?.baseUrl || this.cfg.baseUrl;
          if (arbModel === this.cfg.model && arbUrl === this.cfg.baseUrl) {
            rejectedNow += 1;
            const why = "rejected: no independent arbiter (the worker model would rule on its own misreading; set --arbiter-model)";
            log?.append("dispute", { check: d.name, quote: d.quote, why: d.why, ran: false, skipped: "same model" });
            yield { kind: "info", text: `the dispute of ${d.name} was ${why}; the check stands` };
            this.transcript.push({
              role: "user",
              content: `[molt] Your dispute of ${d.name} was ${why}. The check stands. Change the work so it passes.`,
            });
            continue;
          }
          yield { kind: "info", text: `reviewing the dispute of ${d.name} against the task text` };
          const ruling = await arbitrate({
            task: userText,
            check: { name: d.name, run: check.run },
            output: failed.output,
            dispute: d,
            votes: arb?.votes ?? 1,
            ask: {
              baseUrl: arbUrl,
              apiKey: arb?.apiKey ?? this.cfg.apiKey,
              model: arbModel,
              cwd: this.cwd,
              reasoningEffort: this.cfg.review?.reasoningEffort ?? this.cfg.reasoningEffort,
              fetchFn: this.cfg.fetchFn,
              acpSpawn: this.cfg.acpSpawn,
              deadlineAt: this.deadlineAt(),
            },
          }).catch(() => null);
          log?.append("dispute", {
            check: d.name,
            quote: d.quote,
            why: d.why,
            ...(ruling ? { upheld: ruling.upheld, votes: ruling.votes, ...(ruling.quote ? { taskQuote: ruling.quote } : {}) } : { ran: false }),
          });
          if (ruling?.upheld) {
            retired.set(d.name, ruling);
            retiredNow += 1;
            yield {
              kind: "info",
              text: `check ${d.name} retired (${ruling.votes} reviews): it contradicts the task — "${ruling.quote}"`,
            };
          } else {
            const why = ruling ? `rejected (${ruling.votes} reviews found a contradiction)` : "could not be reviewed";
            rejectedNow += 1;
            yield { kind: "info", text: `the dispute of ${d.name} was ${why}; the check stands` };
            this.transcript.push({
              role: "user",
              content:
                `[molt] Your dispute of ${d.name} was ${why}. The check stands: it is a fair reading ` +
                `of the task. Change the work so it passes.`,
            });
          }
        }
      }

      // Every check was retired: nothing is left to judge the claim, so it is
      // reported the way an unchecked answer is — unverified. The same when
      // what is left of the task's checks only looks: Terminal-Bench
      // pytorch-model-recovery retired the one check that ran the model, and
      // "the file loads, the weights match" carried a verified the grader
      // failed on the first forward() call.
      const liveTask = (barNow()?.checks ?? []).filter((c) => c.tags?.includes("task"));
      const onlyLooks = liveTask.length > 0 && liveTask.every((c) => c.tags?.includes("surface"));
      if (retiredNow > 0 && ((barNow()?.checks.length ?? 0) === 0 || onlyLooks)) {
        this.turnAllRetired = true;
        yield {
          kind: "info",
          text: onlyLooks
            ? "the checks that ran the work were retired by dispute; what is left only looks at it — this claim is unverified."
            : "every check was retired by dispute — this claim is unverified.",
        };
        log?.append("session_end", { reason: "unverified: every check retired" });
        if (claim) yield { kind: "assistant_text", text: redact(claim, this.secrets()), streamed: streamedContent };
        return;
      }

      // A rejected dispute and nothing else: the model has been told the
      // check stands, and gets its turn to change the work before the bar
      // runs again — not a stop for "nothing changed".
      if (rejectedNow > 0 && retiredNow === 0 && this.actsSinceBar === 0) continue;

      // Nothing has happened since the last bar run, so the bar cannot
      // answer differently. Say so and stop, rather than spending another
      // suite — and another turn's tokens — proving it.
      // After a review nudge the model may answer that the reviewers are
      // wrong and change nothing. The bar it passed still stands: a nudge
      // never turns a pass into a refusal.
      if (lastResult !== null && lastResult.ok && reviewNudged && this.actsSinceBar === 0) {
        log?.append("session_end", { reason: "bar met", attempts: proofAttempts });
        yield { kind: "proof_result", result: lastResult, attempt: proofAttempts };
        yield* this.settlePassed(userText, proofAttempts, lastResult.results.map((r) => r.name), lastReceipt, log);
        if (claim) yield { kind: "assistant_text", text: redact(claim, this.secrets()), streamed: streamedContent };
        return;
      }

      if (lastResult !== null && this.actsSinceBar === 0 && retiredNow === 0) {
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
      const barThis = barNow() ?? bar;
      yield {
        kind: "proof_start",
        checks: barThis.checks.length,
        names: barThis.checks.map((c) => c.name),
      };
      let result = await this.runBarGuarded(claim, barThis);
      // A check that failed in its own code is no verdict on the work. The
      // reference check says so with exit 3 (src/reference.ts); a drafted
      // check says so in its output — a compile error in its own program, a
      // tool rejecting its options (criteria.ts checkSelfError). Preflight
      // catches these before the work only when the check gets that far: a
      // node-summarize check piped `node summarize.js` into a jq program that
      // was wrong, failed first on the missing script, and then refused six
      // correct solutions. Retired, and the claim judged by what remains.
      const selfBroken = brokenOwn(result);
      if (selfBroken.length) {
        yield* retireBroken(selfBroken);
        const rest = barNow();
        if (!rest || rest.checks.length === 0) {
          // Nothing else judges the claim: unverified, as when every check is
          // retired by dispute — never a pass on an empty bar.
          this.turnAllRetired = true;
          yield { kind: "info", text: "no other check is left to judge the claim — this claim is unverified." };
          log?.append("session_end", { reason: "unverified: every check retired" });
          if (claim) yield { kind: "assistant_text", text: redact(claim, this.secrets()), streamed: streamedContent };
          return;
        }
        result = await this.runBarGuarded(claim, rest);
      }
      if (this.checkLeftovers.length) {
        log?.append("note", { text: `removed what the checks created: ${this.checkLeftovers.join(", ")}` });
        yield { kind: "info", text: `removed what the checks created in the project: ${this.checkLeftovers.join(", ")}` };
      }
      if (result.cancelled) {
        // ctrl+C landed while a check was running. This used to fall through:
        // the killed check read as red, a refused receipt was written, the
        // "failure" went back to the model, and the next request was billed —
        // for a turn the person had just ended. Closed the way a cancelled
        // request is closed, and named as what it was.
        this.transcript.rollbackTo(turnStart);
        const wrote = [...new Set(this.ledger.map((e) => e.path))];
        log?.append("cancelled", { step, rolledBack: true, during: "bar", filesWritten: wrote });
        yield { kind: "cancelled", filesWritten: wrote };
        return;
      }
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
          // A task check that ran on the work itself, not a throwaway copy.
          ...(r.ranInPlace ? { ranInPlace: r.ranInPlace } : {}),
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
      let stuck = !result.ok && signature === lastFailure;
      // A repeat failure of hidden drafted checks only is not a verdict: the
      // work was right 34 times and wrong 33 at this stop, so it decided the
      // outcome on a coin flip. The model is shown the commands once and the
      // turn goes on, bounded by the attempt limit; the DISPUTE route stays
      // open. A check a person wrote still ends the turn here.
      const stuckHidden = result.results.filter((r) => !r.ok && !r.advisory);
      const hiddenOnly =
        stuckHidden.length > 0 &&
        stuckHidden.every((r) => (barNow()?.checks ?? []).find((c) => c.name === r.name)?.hidden === true);
      // Opt-in again (`--reveal-stuck`). As the default it was measured on
      // Mercury 2.5 against the build that stops here: 37/60 vs 44/60. Shown
      // a wrong drafted check, the model bent correct work to fit it — six
      // runs passed their checks on a second try and failed the grader
      // (0 in the stopping build): a report cut to the check's 6 lines, a
      // folder deleted to make "exactly 5 files", git reset --hard. One rescue
      // in 120 runs, at three times the tokens. Stopping leaves the work on
      // disk, reported unverified, and that work passed 24 of 25 times.
      const revealNow = stuck && this.cfg.revealOnStuck === true && !revealedThisTurn && hiddenOnly;
      if (stuck && this.cfg.revealOnStuck === true && hiddenOnly) stuck = false;
      if (revealNow) {
        revealedThisTurn = true;
        revealSeen = new Set(this.turnLedger().map((e) => e.callId));
        this.turnRevealed = stuckHidden.map((r) => bare(r.name));
        revealMark = {
          didAt: this.did.length,
          targets: this.revealedTargets(
            stuckHidden.flatMap((r) => {
              const c = (barNow()?.checks ?? []).find((k) => k.name === r.name);
              return c && c.kind === "command" ? [c.run] : [];
            }),
          ),
        };
      }
      // The model has read the check; work that then edits the task's input or
      // the environment to satisfy it is the check's answer, not the task's.
      if (result.ok && revealedThisTurn) {
        const bent = this.bentAfterReveal(revealSeen, userText, revealMark);
        if (bent && !bent.hard) {
          log?.append("note", { text: `unverified after a reveal: ${bent.reason}` });
          yield { kind: "info", text: `${bent.reason} — this claim is unverified.` };
          log?.append("session_end", { reason: "unverified: input changed after a reveal" });
          if (claim) yield { kind: "assistant_text", text: redact(claim, this.secrets()), streamed: streamedContent };
          return;
        }
        bentReason = bent?.reason;
        if (bentReason) {
          result = {
            ...result,
            ok: false,
            results: [
              ...result.results,
              { name: "bent-work", kind: "builtin", detail: "bent-work", ok: false, output: bentReason, durationMs: 0 },
            ],
          };
          log?.append("note", { text: `claim refused after a reveal: ${bentReason}` });
        }
      }
      const stuckChecks = stuck
        ? result.results.filter((r) => !r.ok).map((r) => r.name)
        : [];
      lastFailure = signature;
      // A broken check ends the turn now rather than at the attempt limit.
      // There is no work that satisfies a command which did not run, so every
      // further attempt is spend with no possible outcome.
      const allBroken = onlyBrokenChecks(result);
      // Everything that ran passed, and something done.yml requires did not
      // run. Not accepted — a partial bar is not a bar — and not refused
      // either: the work did not fail anything, and no attempt can answer a
      // check this run never asks. So it ends now, named as what it is.
      const undetermined =
        !result.ok && !result.cancelled && (result.undetermined?.length ?? 0) > 0 &&
        result.results.every((r) => r.ok || r.advisory || r.skipped);
      const exhausted =
        !result.ok && (undetermined || stuck || allBroken || bentReason !== undefined || proofAttempts >= maxAttempts);
      const verdict = result.ok
        ? "accepted"
        : undetermined
          ? "undetermined"
          : exhausted
            ? "exhausted"
            : "refused";

      // A stuck bar is its own fact, worth a separate journal entry: the run
      // records the outcome, this records the signal that a check may be
      // wrong about the work — the exact failure 1.13M tokens were spent on.
      if (stuck) {
        log?.append("bar_stuck", {
          attempt: proofAttempts,
          failed: stuckChecks.join(", "),
          signature,
          tokens: this.sessionTokens,
        });
      }

      if (this.cfg.receipts) {
        const head = await treeState(this.cwd).catch(() => null);
        const receipt = this.cfg.receipts.write({
          claim,
          result,
          attempt: proofAttempts,
          verdict,
          head,
          model: this.modelOfRecord(),
          provider: this.provider,
          sessionTokens: this.sessionTokens,
          session: this.cfg.journal?.sessionId,
          costUsd: this.costUsd(),
          costEstimated: this.costEstimated,
          shedBatches: this.transcript.shedCount,
          // A question the bar could not refuse is recorded as one, so stats
          // never count an answer as a verified change.
          ask: opts.ask === true && this.turnLedger().length === 0,
          changed: this.turnLedger().map((e) => ({
            path: e.path,
            before: e.before,
            after: e.after,
            ...(e.changedLines?.length ? { lines: e.changedLines } : {}),
          })),
          cwd: this.cwd,
          did: [...this.did],
          signout: this.turnSignOut,
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
          ...(this.turnRevealed.length ? { revealed: [...this.turnRevealed] } : {}),
          ...(verdict === "accepted" ? { tier: tierOf({ results: result.results, ...this.tierContext(result.results) }) } : {}),
          authors: this.receiptAuthors(),
        });
        log?.append("receipt", { verdict, file: receipt.path, attempt: proofAttempts });
        this.bindReceipt(receipt.path, verdict);
        this.capture(receipt.path, verdict, userText, result, claim);
        lastReceipt = basename(receipt.path);
        lastReceiptPath = receipt.path;
        yield { kind: "receipt", path: receipt.path };
      }

      // The verification nudge, with evidence. A claim that passed its checks
      // is read by independent reviewers here, inside the turn. When a
      // majority find the task text contradicted, the model is told what
      // they found — once — and gets its turn to fix it or say why they are
      // wrong. Afterwards it was only a label: on the local comparison the
      // reviewers named the missing user and the uppercase email, and both
      // tasks were still lost because the turn had already ended.
      const skipReview = result.ok && this.cfg.review && !reviewNudged && !opts.ask ? this.reviewSkipReason() : undefined;
      if (skipReview) {
        this.reviewSkipped = skipReview;
        this.turnReview = null;
        log?.append("review", { ran: false, skipped: skipReview });
        yield { kind: "info", text: `skipping the independent review: ${skipReview}. The claim stands as checked, unreviewed.` };
      } else if (result.ok && this.cfg.review && !reviewNudged && !opts.ask && lastReceiptPath && existsSync(lastReceiptPath)) {
        yield { kind: "info", text: "reviewing the claim independently against the task text" };
        const review = await reviewClaim({
          task: userText,
          receipt: readFileSync(lastReceiptPath, "utf8"),
          votes: this.cfg.review.votes,
          ask: {
            ...judgeTarget({ baseUrl: this.cfg.baseUrl, apiKey: this.cfg.apiKey, model: this.cfg.model }),
            cwd: this.cwd,
            reasoningEffort: judgeEffort(this.cfg.review.reasoningEffort ?? this.cfg.reasoningEffort),
            fetchFn: this.cfg.fetchFn,
            acpSpawn: this.cfg.acpSpawn,
            ...(this.timeLeftMs() !== undefined ? { timeoutMs: Math.max(1_000, this.timeLeftMs()!) } : {}),
            deadlineAt: this.deadlineAt(),
          },
          ...this.executableReview(),
        }).catch(() => null);
        if (review?.objections) {
          if (lastReceipt) this.cfg.receipts?.amendReview(lastReceipt, review.objections);
          yield* this.unsubstantiated(review);
        }
        if (review && !review.confirmed && review.violations.length && this.cfg.reviewAdvisory !== true) {
          reviewNudged = true;
          this.turnReview = undefined;
          log?.append("review", { confirmed: false, votes: review.votes, violations: review.violations.length, nudged: true, ...(review.objections ? { objections: review.objections } : {}) });
          yield {
            kind: "info",
            text:
              `the checks passed, but ${review.votes} independent reviews found the task contradicted — ` +
              `giving the model one chance to answer it`,
          };
          this.transcript.push({
            role: "user",
            content:
              `[molt] Your checks passed, but independent reviewers who read only the task and your ` +
              `receipt found the work contradicts the task:\n` +
              (review.objections
                ? // Executable mode: an objection's command output may quote a hidden check.
                  this.maskWithheld(review.violations.map((v) => `- the task says "${v.quote}" — ${v.evidence}`).join("\n"))
                : review.violations.map((v) => `- the task says "${v.quote}" — ${v.evidence}`).join("\n")) +
              `\nIf they are right, fix it and say done again. If they are wrong, say in one line why, ` +
              `and say done again without changing anything.`,
          });
          continue;
        }
        this.turnReview = review;
      }

      if (result.ok) {
        log?.append("session_end", { reason: "bar met", attempts: proofAttempts });
        yield { kind: "proof_result", result, attempt: proofAttempts };
        yield* this.settlePassed(
          userText,
          proofAttempts,
          result.results.map((r) => r.name),
          lastReceipt,
          log,
        );
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
        log?.append("session_end", {
          reason: undetermined ? "undetermined" : "bar not met",
          attempts: proofAttempts,
        });
        yield { kind: "proof_exhausted", result, attempts: proofAttempts };
        const onlyWrites = failedOnlyWriteChecks(result);
        if (undetermined) {
          const names = (result.undetermined ?? []).map((n) => `\`${n}\``).join(", ");
          yield {
            kind: "error",
            text:
              `undetermined: every check that ran passed, but ${names} did not run — this ` +
              `run's tag selection left ${result.undetermined!.length === 1 ? "it" : "them"} out. ` +
              `A claim is accepted against the whole of .maat/done.yml, not the part that was ` +
              `asked. Nothing was refused and the work is left as it is; run without the ` +
              `selection to settle it.`,
          };
          return;
        }
        if (allBroken) {
          const names = brokenChecks(result).map((n) => `\`${n}\``).join(", ");
          yield {
            kind: "error",
            text:
              `the bar was not met, but nothing failed: ${names} did not run. ` +
              `The command was not found or could not be executed, so no verdict was ` +
              `reached either way, and no change to the work could produce one. ` +
              `Repair the check in .maat/done.yml — Maat will not spend more attempts on it.`,
          };
          yield* this.settleFailed(log);
          return;
        }
        if (bentReason) {
          yield {
            kind: "error",
            text:
              `claim refused: ${bentReason}. The checks passed only after the model read a hidden ` +
              `check's command, and the work that met it changed what the task or the environment ` +
              `supplies. Maat will not call that verified. Undo that change and meet the task as written.`,
          };
          yield* this.settleFailed(log);
          return;
        }
        if (stuck) {
          yield {
            kind: "info",
            text:
              "the bar failed in exactly the same way twice, on: " +
              (stuckChecks.map((n) => `\`${n}\``).join(", ") || "all checks") +
              ". Continuing would spend more tokens on a check the work is not moving — " +
              "either the work cannot satisfy it, or the check is wrong about the work.",
          };
        }
        yield {
          kind: "error",
          text: onlyWrites
            ? `bar not met: ${onlyWrites} requires this turn to have changed a file, and ` +
              `none changed. Maat is reporting failure rather than success. Either the work ` +
              `was not done, or this was a question — ask questions with /ask, or a leading ` +
              `"?", which runs the rest of the bar and drops that one check.`
            : `bar not met after ${proofAttempts} attempt${proofAttempts === 1 ? "" : "s"}. Maat is reporting failure rather ` +
              `than success. See .maat/receipts/ for what was checked.`,
        };
        yield* this.settleFailed(log);
        return;
      }

      yield { kind: "proof_refused", result, attempt: proofAttempts };
      if (this.cfg.retryReasoningEffort && !this.refusedThisTurn) {
        this.refusedThisTurn = true;
        yield { kind: "info", text: `reasoning effort raised to ${this.cfg.retryReasoningEffort} for the retry` };
      }
      this.pinTask(
        userText,
        result.results.filter((r) => !r.ok && !r.advisory).map((r) => r.name).join(", "),
      );
      this.transcript.pushBarFailure(formatBarFailure(result, proofAttempts, maxAttempts));
      if (revealNow) {
        const shown = stuckHidden.map((r) => {
          const c = (barNow()?.checks ?? []).find((k) => k.name === r.name);
          return `- ${r.name}: \`${c && "run" in c ? c.run : "?"}\``;
        });
        yield { kind: "info", text: `the same hidden check failed twice; showing the model ${stuckHidden.length === 1 ? "its command" : "their commands"} once` };
        this.transcript.push({
          role: "user",
          content:
            `[molt] The same check failed the same way twice. These are the commands that ran:\n${shown.join("\n")}\n` +
            `Read the task again. If your work is wrong, fix it. If a check demands something the task ` +
            `does not say, do not bend the work to it: reply DISPUTE <check name>: "<exact words from the task>".`,
        });
      }
    }

    yield {
      kind: "error",
      ceiling: "steps",
      text:
        `stopped after ${stepCap} steps (loop guard) · ${this.sessionTokens} tokens` +
        (this.costUsd() === undefined ? "" : ` · ${fmtUsd(this.costUsd() ?? 0)}`) +
        `. Nothing was verified. Narrow the request, or set /budget to put a ceiling on a ` +
        `turn like this.`,
    };
    yield* this.salvage(`You have used all ${stepCap} steps available for this turn.`, fetchFn, log);
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
    /**
     * Nothing to reach, so nothing is asked.
     *
     * The two questions doctor answers — can molt get there, and is the model
     * there — become one: is the subscription CLI installed and logged in.
     * Fetching `grok-build://subscription/models` would fail in a way that
     * reads as a network problem and sends someone to check their wifi.
     */
    if (this.subprocess) {
      const spec = acpAgentFor(this.cfg.baseUrl);
      if (!spec) {
        const removed = removedSubscriptionProblem(this.cfg.baseUrl);
        return {
          ok: false,
          reachable: false,
          detail: removed ?? `no ACP agent for '${this.cfg.baseUrl}'`,
        };
      }
      const health = await acpHealth(spec);
      const ids = acpModels(this.cfg.baseUrl);
      // An alias the CLI resolves itself is not in the list and is still
      // valid; refusing it would be molt overruling the only party that knows.
      const has = ids.includes(this.cfg.model) || this.cfg.model.startsWith(spec.bin);
      return {
        ok: health.ok && has,
        reachable: health.installed,
        modelPresent: has,
        models: ids,
        detail:
          health.detail +
          (health.fix ? ` · run \`${health.fix}\`` : "") +
          (has
            ? ""
            : ` · ⚠ '${this.cfg.model}' is not a ${this.backendLabel} model (try: ${ids.slice(0, 3).join(", ")})`),
      };
    }
    /**
     * The third caller this file's own doc comment names.
     *
     * `endpointProblem`'s comment has always said four callers need this
     * answer, doctor among them, but nothing here ever asked it: a garbage
     * `baseUrl` reached `fetchFn` and came back a `TypeError`, caught below
     * and reported as "cannot reach ... TypeError" — the same misdiagnosis
     * the retry loop above exists to avoid, just uncaught in the one place
     * `molt doctor` is supposed to be the honest answer.
     */
    const badEndpoint = endpointProblem(this.cfg.baseUrl);
    if (badEndpoint) return { ok: false, reachable: false, detail: badEndpoint };
    const probeMs = this.cfg.probeTimeoutMs;
    try {
      const res = await fetchFn(`${base}/models`, {
        headers: authHeaders(base, this.cfg.apiKey),
        signal: probeSignal(probeMs),
      });
      if (!res.ok) {
        return { ok: false, reachable: false, detail: `HTTP ${res.status} from ${base}/models` };
      }
      type Listing = { data?: { id?: string }[] } | null;
      let json: Listing;
      try {
        json = (await res.json()) as Listing;
      } catch {
        // Something answered, and it was not an API. `--url https://openrouter.ai`
        // without its `/api/v1` gets a 200 web page here, and doctor called that
        // "endpoint reachable · model list unavailable" and exited 0 — the one
        // command meant to catch a wrong URL passing it, for the first real
        // request to fail on.
        return {
          ok: false,
          reachable: false,
          detail:
            `${base}/models answered with a page, not JSON — this looks like a website rather ` +
            `than the API. The base URL usually ends in /v1 (for example /api/v1).`,
        };
      }
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
      return { ok: false, reachable: false, detail: `cannot reach ${base}: ${probeError(e, `${base}/models`, probeMs)}` };
    }
  }

  /** List model ids from an endpoint's /models route. */
  async listModels(
    baseUrl = this.cfg.baseUrl,
    apiKey = this.cfg.apiKey,
  ): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const base = baseUrl.replace(/\/$/, "");
    if (isAcp(baseUrl)) return { ok: true, ids: acpModels(baseUrl) };
    const removed = removedSubscriptionProblem(baseUrl);
    if (removed) return { ok: false, error: removed };
    const probeMs = this.cfg.probeTimeoutMs;
    try {
      const res = await fetchFn(`${base}/models`, {
        headers: authHeaders(base, apiKey),
        signal: probeSignal(probeMs),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${base}/models` };
      const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const ids = (json?.data ?? []).map((m) => m.id).filter(Boolean) as string[];
      return { ok: true, ids };
    } catch (e) {
      return { ok: false, error: probeError(e, `${base}/models`, probeMs) };
    }
  }
}
