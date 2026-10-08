/**
 * The transcript: molt's context window, and the record underneath it.
 *
 * Two ideas carry the whole product:
 *
 *  1. Shedding is MECHANICAL. Verbatim excerpts, no model call, no tokens,
 *     no hallucination surface.
 *  2. Shedding is TWO-PHASE. planShed() computes what would happen and
 *     mutates nothing. commitShed() applies it — and the caller only
 *     commits after the archive write has actually landed on disk. A
 *     failed write can therefore never destroy context, which is the
 *     property every later proof depends on.
 *
 * `record()` returns the full session including everything shed. That is
 * what makes molt able to verify a claim about work from forty turns ago:
 * competitors summarized the original away, so they have nothing to check
 * against.
 *
 * No filesystem access here — archiving lives in archive.ts so this whole
 * module stays pure and testable.
 */
import { parseLenient } from "./lenient-json.js";
import { estTokens, type Bom, type Msg } from "./types.js";

export const STALE_FAILURE_PREFIX = "[molt: superseded]";
export const ELIDED_PREFIX = "[molt: superseded tool result —";

/**
 * How many steps an elision has to pay for itself in, when a cache is working.
 *
 * Eliding saves its tokens on every later request and costs the stranded
 * prefix once. Three is deliberately conservative: a turn that has already
 * read enough to need pruning nearly always has three steps left, and being
 * wrong this way keeps a working cache rather than shaving a few hundred
 * tokens off one request.
 */
export const ELISION_PAYBACK_STEPS = 3;

export const DIGEST_HEADER =
  "[molt digest of shed context — mechanical, verbatim excerpts, not a summary]";

/** Characters kept from each excerpted message in a digest. */
const EXCERPT_CHARS = 300;
/** Maximum tool-call lines listed in a digest. */
const MAX_ACTION_LINES = 25;
/**
 * When a single request has produced a long tool run, there are no user
 * turns to cut on. Fall back to keeping this many recent messages.
 */
const KEEP_RECENT_MESSAGES = 6;
/** Never bother shedding fewer than this many messages. */
const MIN_DROPPED = 2;

export type ShedPlan = {
  /** Full, unabridged markdown of everything being shed. */
  exuvia: string;
  /** The mechanical digest that will replace it in context. */
  digest: string;
  /** Messages being removed from the working context. */
  dropped: Msg[];
  droppedCount: number;
  beforeTokens: number;
  afterTokens: number;
};

/**
 * What a message costs on the wire, in molt's token units: its aged stand-in
 * when it has one (see `planAging`), its content otherwise.
 */
export function sentTokens(m: Msg): number {
  const calls = m.tool_calls?.map((c) =>
    c.id && m.molt?.agedArgs?.[c.id] !== undefined ? { ...c, function: { ...c.function, arguments: m.molt.agedArgs[c.id]! } } : c,
  );
  return estTokens(m.molt?.wire ?? m.content ?? "") + estTokens(JSON.stringify(calls ?? ""));
}

/**
 * Ageing older tool results (lean-sessions prototype, MAAT_LEAN_AGE).
 *
 * The newest `keep` tool results go on the wire whole. Older ones longer than
 * `minChars` go as their first `head` and last `tail` characters and a pointer
 * to the full text, which the engine writes under `.maat/out/` first. With
 * `args`, older tool-call arguments longer than `argMinChars` are shortened
 * the same way. Nothing is ever aged unless at least `batchChars` would come
 * off: each ageing rewrites messages in the middle of the conversation, so
 * everything after the first of them is a cache miss on the next request, and
 * batching keeps that to one miss per `batchChars` saved instead of one per
 * step.
 */
export type AgingOpts = {
  keep: number;
  minChars: number;
  batchChars: number;
  head: number;
  tail: number;
  args: boolean;
  argMinChars: number;
  /**
   * Age only once the history is over this many tokens (molt's units), and
   * then everything eligible at once: a soft shed, timed like a shed, that
   * keeps every call and the ends of every result. 0: age whenever a batch
   * is ready.
   */
  atTokens: number;
};

export type AgingPlan = {
  results: { index: number; callId: string; full: string }[];
  calls: { index: number; callId: string; full: string }[];
  /** Chars that stop being resent. */
  saving: number;
  /** Soft shed only: ageing alone cannot buy the headroom, so shed after it. */
  thenShed?: boolean;
};

/** An aged string: head, a marker saying what is missing and where it is, tail. */
export function ageText(text: string, head: number, tail: number, pointer: string | null, what = "result"): string {
  const cut = text.length - head - tail;
  return (
    `${text.slice(0, head)}\n[molt: ${cut} characters of this older ${what} are not resent` +
    (pointer ? `; the full text is in ${pointer} — read_file it, with an offset, for the part you need` : "") +
    `.]\n${text.slice(text.length - tail)}`
  );
}

/**
 * A bash command that only prints one file: `cat f`, `head -n 40 f`,
 * `sed -n '1,80p' f`, `nl f`, `tail f`. Anything with a pipe, a redirect or a
 * second command is not a plain read and is left alone.
 */
const SIMPLE_READ = /^(?:cat|nl(?: -\S+)*|head(?: -\S+(?: \d+)?)*|tail(?: -\S+(?: \d+)?)*|sed -n ['"]?[\d,$p]+['"]?)\s+([^\s|;&<>$`*?]+)$/;

/** Results that are already a pointer or a notice: nothing to age. */
const NOT_AGEABLE = [ELIDED_PREFIX, "[molt: this is the same ", "[molt: you have already been shown"];

export class Transcript {
  private system: Msg;
  private working: Msg[] = [];
  /** Every message ever shed, oldest batch first. Never truncated. */
  private archived: Msg[][] = [];
  /** What this turn is for. Sent every request, shed never. */
  private task: string | null = null;
  /**
   * Tool calls Maat refused as malformed. Their arguments go back to the
   * provider as a short excerpt, not in full: a run that made 17 malformed
   * `act` calls in a row resent every one of them on every step, prompts grew
   * to 630k tokens, and one task cost $0.82 for a 181-byte file (2026-10-07).
   * The record and captures keep the full text.
   */
  private malformedCalls = new Set<string>();
  /**
   * The least share of the history a shed cut on user turns must free, or it
   * cuts on recent messages instead (lean-sessions prototype,
   * MAAT_LEAN_SHED_MINFREE). 0 is off. Maat's own notes (the acceptance
   * criteria, a bar refusal) arrive as user messages, so a long single-request
   * turn can have three "exchanges" with nearly all its history before the
   * second: a real run shed 6 messages, 60,788 -> 60,387 tokens, lost its
   * whole prompt cache for 0.7%, and shed again one step later.
   */
  shedMinFree = 0;

  constructor(systemPrompt: string) {
    this.system = { role: "system", content: systemPrompt };
  }

  push(msg: Msg): void {
    this.working.push(msg);
  }

  /** Send this call's arguments as an excerpt from now on (see `malformedCalls`). */
  markMalformedCall(id: string): void {
    this.malformedCalls.add(id);
  }

  /**
   * Fold the tool results for `parts` into one result for the call `id`.
   *
   * Batch mode (see ACT_TOOL in engine.ts) runs each action of one `act` call
   * as an ordinary call, so the approval gate, the ledger and repeat detection
   * see every action — then the model gets back what it asked for: one result
   * for its one call, each action's output under its own heading, in order.
   * A part whose result is missing leaves everything as it was.
   */
  combineToolResults(id: string, parts: { id: string; label: string }[]): void {
    const at = parts.map((p) => this.working.findIndex((m) => m.role === "tool" && m.tool_call_id === p.id));
    if (!parts.length || at.some((i) => i < 0)) return;
    const content = parts
      .map((p, k) => `### ${k + 1}. ${p.label}\n${this.working[at[k]!]!.content ?? ""}`)
      .join("\n\n");
    const first = Math.min(...at);
    const drop = new Set(at);
    const out: Msg[] = [];
    this.working.forEach((m, i) => {
      if (i === first) out.push({ role: "tool", tool_call_id: id, content });
      else if (!drop.has(i)) out.push(m);
    });
    this.working = out;
  }

  /**
   * Add a line to the end of the newest tool result, if the newest message is
   * one. For facts about the moment (the clock), not about the call: they
   * ride on content that is new anyway, so the cached prefix is untouched.
   */
  noteOnLastToolResult(line: string): boolean {
    const last = this.working[this.working.length - 1];
    if (!last || last.role !== "tool") return false;
    last.content = `${last.content ?? ""}\n${line}`;
    return true;
  }

  /**
   * Replace the system message in place.
   *
   * Everything before the first user message is the cached prefix, so this
   * invalidates it: the next request pays full price for the prompt again.
   * That is the right trade for a fact the whole session depends on — a repo
   * map, or a file the model must not write — and the wrong one for anything
   * that changes often, which is why nothing per-turn is allowed in here.
   */
  setSystem(systemPrompt: string): void {
    this.system = { role: "system", content: systemPrompt };
  }

  /** The system prompt as it currently stands. */
  get systemText(): string {
    return this.system.content ?? "";
  }

  /** Working context including the system prompt. Internal shape. */
  all(): Msg[] {
    const task: Msg[] = this.task
      ? [{ role: "system", content: this.task, molt: { pinned: true } }]
      : [];
    return [this.system, ...task, ...this.working];
  }

  /**
   * Messages formatted for the wire: molt's own metadata removed, since
   * providers reject unknown fields with varying degrees of politeness.
   */
  wire(opts: { repairArgs?: boolean } = {}): Omit<Msg, "molt">[] {
    // Repaired tool-call arguments are for the request only (wireArgs). A
    // record of what the model did (a capture) passes repairArgs: false and
    // keeps the arguments exactly as the model wrote them.
    const repair = opts.repairArgs !== false;
    // One system message, and it comes first. The pinned task and a shed's
    // digest were system messages of their own, which OpenAI-style APIs take
    // and strict chat templates refuse: Qwen's raises "System message must be
    // at the beginning" on the second one, so every request to a local
    // llama.cpp Qwen failed with a 500. Leading system messages are joined
    // in order; a system message anywhere later goes as a user message.
    const out: Omit<Msg, "molt">[] = [];
    for (const { molt, ...raw } of this.all()) {
      // An aged message goes as its stand-in (planAging); `repair` false is a
      // record of what was said, which keeps the full text.
      const aged = repair && molt?.wire !== undefined;
      const m = aged ? { ...raw, content: molt!.wire! } : raw;
      const agedArgs = repair ? molt?.agedArgs : undefined;
      if (m.role !== "system")
        out.push(
          repair && Array.isArray(m.tool_calls)
            ? {
                ...m,
                tool_calls: m.tool_calls.map((c) =>
                  c.id && this.malformedCalls.has(c.id)
                    ? excerptCall(c)
                    : c.id && agedArgs?.[c.id] !== undefined
                      ? { ...c, function: { ...c.function, arguments: agedArgs[c.id]! } }
                      : wireCall(c),
                ),
              }
            : m,
        );
      else if (out.length === 0) out.push({ ...m });
      else if (out.length === 1 && out[0]!.role === "system") out[0] = { ...out[0]!, content: `${out[0]!.content ?? ""}\n\n${m.content ?? ""}` };
      else out.push({ role: "user", content: m.content ?? "" });
    }
    return out;
  }

  /**
   * The complete session: everything ever shed, in order, followed by the
   * current working context. This is the evidence base.
   */
  record(): Msg[] {
    return [this.system, ...this.archived.flat(), ...this.working];
  }

  /** Number of shed batches archived so far. */
  get shedCount(): number {
    return this.archived.length;
  }

  /** Messages currently in the working context, excluding the system prompt. */
  get length(): number {
    return this.working.length;
  }

  reset(): void {
    this.working = [];
    this.archived = [];
    this.task = null;
  }

  bom(toolSchemaJson: string, session: { prompt: number; completion: number }): Bom {
    const historyTokens = this.working.reduce((n, m) => n + sentTokens(m), 0);
    // The standing note is part of every request, so it is part of the fixed
    // cost of one — counted with the system prompt rather than hidden.
    const systemTokens = estTokens(this.system.content ?? "") + estTokens(this.task ?? "");
    const toolSchemaTokens = estTokens(toolSchemaJson);
    return {
      systemTokens,
      toolSchemaTokens,
      historyTokens,
      requestTotalEst: systemTokens + toolSchemaTokens + historyTokens,
      sessionPromptTokens: session.prompt,
      sessionCompletionTokens: session.completion,
      sessionCachedTokens: 0,
    };
  }

  historyTokens(): number {
    return this.working.reduce((n, m) => n + sentTokens(m), 0);
  }

  /**
   * Plan an ageing pass (see AgingOpts). Null when it would save less than a
   * batch. Pure: commitAging applies it.
   */
  planAging(o: AgingOpts): AgingPlan | null {
    const history = this.historyTokens();
    if (o.atTokens > 0 && history <= o.atTokens) return null;
    const toolIdx = this.working.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
    if (toolIdx.length <= o.keep) return null;
    let plan = this.agingFrom(toolIdx[toolIdx.length - o.keep]!, o);
    if (o.atTokens > 0) {
      // A soft shed buys headroom, like a shed: keep fewer whole results until
      // the history would be back under half the threshold, and if even two
      // are too many (the stand-ins themselves have grown), say so: the caller
      // sheds for real.
      for (let keep = o.keep - 1; keep >= 2 && history - plan.saving / 4 > o.atTokens / 2; keep--) {
        plan = this.agingFrom(toolIdx[toolIdx.length - keep]!, o);
      }
      if (history - plan.saving / 4 > o.atTokens / 2) plan.thenShed = true;
      return plan.saving > 0 || plan.thenShed ? plan : null;
    }
    if (plan.saving < o.batchChars) return null;
    return plan;
  }

  /** Everything ageable before message `boundary`. */
  private agingFrom(boundary: number, o: AgingOpts): AgingPlan {
    const stub = ageText("", o.head, o.tail, ".maat/out/aged-call_0000000000.txt").length;
    const plan: AgingPlan = { results: [], calls: [], saving: 0 };
    for (let i = 0; i < boundary; i++) {
      const m = this.working[i]!;
      if (m.role === "tool" && m.tool_call_id && typeof m.content === "string" && m.molt?.wire === undefined) {
        const t = m.content;
        if (t.length > Math.max(o.minChars, o.head + o.tail + stub) && !NOT_AGEABLE.some((p) => t.startsWith(p))) {
          plan.results.push({ index: i, callId: m.tool_call_id, full: t });
          plan.saving += t.length - (o.head + o.tail + stub);
        }
      }
      if (o.args && m.role === "assistant") {
        for (const c of m.tool_calls ?? []) {
          if (!c.id || m.molt?.agedArgs?.[c.id] !== undefined || this.malformedCalls.has(c.id)) continue;
          const a = c.function.arguments ?? "";
          if (a.length > o.argMinChars) {
            plan.calls.push({ index: i, callId: c.id, full: a });
            plan.saving += Math.max(0, a.length - agedArgs(a, o, null).length);
          }
        }
      }
    }
    return plan;
  }

  /** Apply an ageing plan; `pointer` names where each full text was kept (null: nowhere). */
  commitAging(plan: AgingPlan, o: AgingOpts, pointer: (callId: string, kind: "result" | "call") => string | null): void {
    for (const r of plan.results) {
      const m = this.working[r.index];
      if (!m || m.tool_call_id !== r.callId) continue;
      m.molt = { ...m.molt, wire: ageText(r.full, o.head, o.tail, pointer(r.callId, "result")) };
    }
    for (const c of plan.calls) {
      const m = this.working[c.index];
      if (!m) continue;
      m.molt = { ...m.molt, agedArgs: { ...m.molt?.agedArgs, [c.callId]: agedArgs(c.full, o, pointer(c.callId, "call")) } };
    }
  }

  /**
   * Compute a shed without applying it. Returns null when there is nothing
   * worth shedding — too few exchanges, or a digest that would grow the
   * context rather than shrink it.
   */
  /**
   * Set the standing note of what this turn is for.
   *
   * Held beside the working set rather than inside it, which is the whole
   * trick: it cannot be shed because shedding only ever touches `working`, it
   * cannot shift an index that a cancellation rollback depends on, and it
   * cannot survive a rollback it should not survive. One line of state instead
   * of a special case in three algorithms.
   */
  pin(content: string): void {
    this.task = content;
  }

  planShed(keepExchanges = 2, keepRecent = KEEP_RECENT_MESSAGES): ShedPlan | null {
    const isDigest = (m: Msg) => m.molt?.digest === true;

    // Digest messages are bookkeeping, not exchanges: they never count
    // toward keepExchanges and are never the only thing shed.
    const userIdxs = this.working
      .map((m, i) => (m.role === "user" && !isDigest(m) ? i : -1))
      .filter((i) => i >= 0);

    let cutAt: number;
    if (userIdxs.length > keepExchanges) {
      cutAt = userIdxs[userIdxs.length - keepExchanges];
      if (this.shedMinFree > 0) {
        const freed = this.working.slice(0, cutAt).reduce((n, m) => n + sentTokens(m), 0);
        if (freed < this.shedMinFree * this.historyTokens()) {
          const fallback = this.findSafeCut(this.working.length - Math.max(2, keepRecent));
          if (fallback !== null && fallback > cutAt) cutAt = fallback;
        }
      }
    } else {
      // A single request can produce dozens of tool calls with no user turn
      // to cut on — which is exactly when context runs out. Fall back to
      // keeping the most recent messages instead.
      // `keepRecent` is what a caller tightens when one shed was not enough.
      // A turn that has made forty tool calls against a single ask has no user
      // turn to cut on, so this branch is the one that runs in practice — and
      // with a fixed constant it drops the same messages every time, which is
      // why a second shed reported nothing to do while the request was still
      // twice the window.
      const fallback = this.findSafeCut(this.working.length - Math.max(2, keepRecent));
      if (fallback === null) return null;
      cutAt = fallback;
    }

    const dropped = this.working.slice(0, cutAt);
    const kept = this.working.slice(cutAt);
    if (dropped.length < MIN_DROPPED || dropped.every(isDigest)) return null;
    if (kept.length > 0 && kept[0].role === "tool") return null;

    const beforeTokens = this.historyTokens();
    const digest = buildDigest(dropped);
    const exuvia = buildExuvia(dropped, this.archived.length);

    const digestMsg: Msg = {
      role: "system",
      content: digest,
      molt: { digest: true },
    };
    const afterTokens = [digestMsg, ...kept].reduce((n, m) => n + sentTokens(m), 0);

    // Shedding must only ever shrink. On tiny sessions the digest can cost
    // more than the messages it replaces.
    if (afterTokens >= beforeTokens) return null;

    return { exuvia, digest, dropped, droppedCount: dropped.length, beforeTokens, afterTokens };
  }

  /**
   * The largest cut index at or below `limit` that does not orphan a tool
   * result. A `tool` message must stay with the assistant turn that
   * requested it — providers reject a payload that opens with a tool
   * result whose call is missing, and a rejected payload is a dead session.
   */
  private findSafeCut(limit: number): number | null {
    for (let i = Math.min(limit, this.working.length); i >= 0; i--) {
      if (i >= this.working.length) continue;
      if (this.working[i].role !== "tool") return i;
    }
    return null;
  }

  /**
   * Apply a plan produced by planShed(). Call this only after the exuvia
   * has been durably archived — that ordering is the guarantee.
   */
  commitShed(plan: ShedPlan): void {
    const cut = plan.droppedCount;
    const dropped = this.working.slice(0, cut);
    this.archived.push(dropped);
    this.working = [
      { role: "system", content: plan.digest, molt: { digest: true } },
      ...this.working.slice(cut),
    ];
  }

  /**
   * Remove the most recent messages. Used to undo a turn that was cancelled
   * before it produced anything, so "the session is unchanged" is literally
   * true rather than nearly true.
   */
  rollbackTo(length: number): void {
    if (length < 0 || length > this.working.length) return;
    this.working.length = length;
  }

  /** Re-attach previously shed context (or any text) to the working set. */
  regrow(text: string): void {
    this.working.push({
      role: "user",
      content: "[molt: context re-attached from the archive]\n" + text,
      molt: { regrown: true },
    });
  }

  /**
   * Inject a bar failure so the model can see exactly what is unmet.
   *
   * Only the LATEST failure matters, and a stale one is resent on every
   * subsequent request for the rest of the session. So earlier failures are
   * collapsed to a one-line marker rather than carried in full — the model
   * still knows a previous attempt was refused, without paying for the
   * output of a check it has already seen and acted on.
   */
  pushBarFailure(text: string): void {
    for (const m of this.working) {
      if (m.molt?.barFailure && m.content && !m.content.startsWith(STALE_FAILURE_PREFIX)) {
        const attempt = /attempt (\d+)/.exec(m.content)?.[1] ?? "?";
        m.content = `${STALE_FAILURE_PREFIX} attempt ${attempt} was refused; its failures are superseded below.`;
      }
    }
    this.working.push({
      role: "user",
      content: text,
      molt: { barFailure: true },
    });
  }

  /**
   * Drop tool results that later work has made irrelevant.
   *
   * A file read and then written is dead weight: the model will never use
   * the stale contents again, but every subsequent request pays for them.
   * Same for a path read twice — only the most recent read can be current.
   *
   * Mechanical and conservative: only `read_file` results are touched, only
   * when a later call in the same session supersedes them, and the
   * replacement says plainly what happened. Nothing is invented and the
   * full original stays in the record.
   */
  /**
   * Shrink individual tool results that are too large to carry.
   *
   * Shedding drops whole messages from the *front* and keeps recent ones by
   * design. That is right until the thing that will not fit is one of the
   * messages it is keeping: a session shed three messages and freed 400 tokens
   * out of 18,300, because a single file read held almost all of it. Nothing
   * older was the problem, so nothing shedding could do would help.
   *
   * This cuts oversized results down to a head and a tail with a marker
   * between them, newest last so the most recent context survives longest. The
   * file is still on disk and the marker says how to read the rest, so this
   * costs a re-read rather than the evidence — unlike dropping the message,
   * which would leave the model with no idea it had ever looked.
   */
  trimOversized(maxTokens: number): { trimmed: number; tokensSaved: number } {
    let trimmed = 0;
    let tokensSaved = 0;
    // Oldest first: a recent result is likelier to be the one being worked on.
    for (let i = 0; i < this.working.length; i++) {
      const m = this.working[i];
      if (m.role !== "tool" || typeof m.content !== "string") continue;
      // Already aged: what goes on the wire is the short stand-in.
      if (m.molt?.wire !== undefined) continue;
      const before = estTokens(m.content);
      if (before <= maxTokens) continue;

      const keepChars = Math.max(400, maxTokens * 4);
      const head = m.content.slice(0, Math.floor(keepChars * 0.7));
      const tail = m.content.slice(-Math.floor(keepChars * 0.2));
      const marker =
        `\n[molt: ${before - maxTokens} tokens of this result removed to fit the ` +
        `endpoint's context. It is not lost — re-read the file with an offset to ` +
        `see the middle, and prefer a narrower read next time.]\n`;
      const next = head + marker + tail;
      if (estTokens(next) >= before) continue;
      m.content = next;
      tokensSaved += before - estTokens(next);
      trimmed++;
    }
    return { trimmed, tokensSaved };
  }

  /**
   * Prune tool results later work made irrelevant.
   *
   * `protectCache` is the option this needed and did not have. Eliding
   * rewrites a message IN PLACE, in the middle of the conversation — see
   * `m.content = marker` below — and providers cache on exact prefix match,
   * so every token after the edit becomes a cache miss on the next request.
   * The docs claimed this "costs nothing" and "does not rewrite the context
   * prefix"; one real session measured the truth, with the step after each
   * elision reading 0% cached against a 20,000-token prompt.
   *
   * So when a cache is known to be working, a candidate is only worth eliding
   * if what it saves pays back what it strands within a few steps. When no
   * cache has been observed there is nothing to lose and everything is
   * elided, which is what a self-hosted endpoint sees.
   */
  elideSupersededReads(
    opts: { protectCache?: boolean; lean?: boolean } = {},
  ): { elided: number; tokensSaved: number; deferred: number } {
    const supersededBy = new Map<number, string>();
    /**
     * With `lean` (MAAT_LEAN_SUPERSEDE), what is superseded is a call, not the
     * message it was in. Keyed by message, a write to one file elided every
     * result of the step that read it — a step that read dur.py and
     * test_dur.py together lost test_dur.py when dur.py was rewritten, and
     * the marker told the model the current copy was further down, which it
     * was not.
     */
    const supersededCall = new Map<string, string>();
    /** The result each call id came back with, for the bash rerun rule. */
    const resultOf = new Map<string, string>();
    if (opts.lean)
      for (const m of this.working) if (m.role === "tool" && m.tool_call_id) resultOf.set(m.tool_call_id, m.content ?? "");
    /** The last live run of each bash command, by its whitespace-normalised text. */
    const lastRun = new Map<string, string>();
    const mark = (i: number, id: string | undefined, why: string) => {
      if (opts.lean && id) supersededCall.set(id, why);
      else supersededBy.set(i, why);
    };
    /**
     * Reads still worth keeping, keyed by the exact window they returned.
     *
     * Keyed by window and not by path, which is the whole lesson of a session
     * that spent 661k tokens and thirteen minutes going nowhere. Long files
     * arrive in parts, so lines 401-440 of a file do not supersede lines 1-40
     * of it — they complete them. Path-keyed elision treated every page as a
     * replacement for the last, deleted what the model had just read, and sent
     * it back to read the same file again, forever. Two features that were
     * each correct alone.
     */
    const lastRead = new Map<string, { i: number; id?: string }>();
    /** Every live read of a path, so a write can invalidate all of them. */
    const readsOf = new Map<string, string[]>();

    for (let i = 0; i < this.working.length; i++) {
      const m = this.working[i];
      for (const call of m.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          continue;
        }
        if (opts.lean && call.function.name === "bash" && typeof args.command === "string" && call.id) {
          const cmd = args.command.replace(/\s+/g, " ").trim();
          const now = resultOf.get(call.id) ?? "";
          // A rerun that came back the same is already sent as a pointer to
          // the earlier copy, which must then stay. One that came back
          // different makes the earlier output history.
          const prior = lastRun.get(cmd);
          if (prior !== undefined && !now.startsWith("[molt: this is the same ") && now !== resultOf.get(prior))
            mark(i, prior, `rerun at step ${i}`);
          if (!now.startsWith("[molt: this is the same ")) lastRun.set(cmd, call.id);
          // A plain read of one file through bash is a read of that file: a
          // later write makes it stale exactly as it does a read_file.
          const read = SIMPLE_READ.exec(cmd);
          if (read) {
            const window = `bash:${cmd}`;
            const p = read[1]!.replace(/^\.\//, "");
            lastRead.set(window, { i, id: call.id });
            const windows = readsOf.get(p) ?? [];
            if (!windows.includes(window)) windows.push(window);
            readsOf.set(p, windows);
          }
          continue;
        }
        const path = String(args.path ?? "").replace(opts.lean ? /^\.\// : /$^/, "");
        if (!path) continue;

        if (call.function.name === "read_file") {
          // Identical arguments return identical bytes; anything else is a
          // different part of the file and stands on its own.
          const window = `${path}@${Number(args.offset ?? 0)}+${String(args.limit ?? "all")}`;
          const prior = lastRead.get(window);
          if (prior !== undefined) mark(prior.i, prior.id, `re-read at step ${i}`);
          lastRead.set(window, { i, id: call.id });
          const windows = readsOf.get(path) ?? [];
          if (!windows.includes(window)) windows.push(window);
          readsOf.set(path, windows);
        } else if (call.function.name === "write_file" || call.function.name === "edit_file") {
          // A change to the file invalidates every part of it that was read,
          // whichever window it came from: what is in context is no longer
          // what is on disk.
          for (const window of readsOf.get(path) ?? []) {
            const prior = lastRead.get(window);
            if (prior !== undefined) mark(prior.i, prior.id, `changed at step ${i}`);
            lastRead.delete(window);
          }
          readsOf.delete(path);
        }
      }
    }

    if (opts.lean) {
      // Per call: map each superseded call id to its result's position.
      for (const [id, reason] of supersededCall) {
        const j = this.working.findIndex((m) => m.role === "tool" && m.tool_call_id === id);
        if (j >= 0) supersededBy.set(-(j + 1), reason);
      }
    }

    let elided = 0;
    let tokensSaved = 0;
    let deferred = 0;
    for (const [callIdx, reason] of supersededBy) {
      // The tool result follows its assistant turn. A negative key is one
      // exact result (the lean per-call rule): -(index + 1).
      const exact = callIdx < 0 ? -callIdx - 1 : -1;
      for (let j = exact >= 0 ? exact : callIdx + 1; j < this.working.length; j++) {
        const m = this.working[j];
        if (m.role !== "tool") break;
        if (exact >= 0 && j !== exact) break;
        if (!m.content || m.content.startsWith(ELIDED_PREFIX)) continue;
        // Already aged: what goes on the wire is the short stand-in.
        if (m.molt?.wire !== undefined) continue;
        const before = estTokens(m.content);
        // Wording matters here. "Full contents remain in the archived record"
        // reads, to a model, as an invitation to go and get them — which it
        // can only do by re-reading the file, which is what elided this copy
        // in the first place. Point at the newer copy instead.
        const marker =
          `${ELIDED_PREFIX} ${reason}. The current contents are further down this ` +
          `conversation; do not read the file again to recover this.`;
        // A short result costs less than the notice explaining its absence.
        // Eliding it would drop content AND grow the context — which is how
        // the meter came to report "−-17 tokens" saved.
        if (estTokens(marker) >= before) continue;
        const saving = before - estTokens(marker);
        // What this edit strands: everything after it shares a prefix that is
        // about to change, so the next request pays full price for all of it.
        // Elide only if the saving earns that back inside ELISION_PAYBACK_STEPS.
        if (opts.protectCache) {
          let stranded = 0;
          for (let k = j + 1; k < this.working.length; k++) {
            stranded += estTokens(this.working[k].content ?? "");
          }
          if (saving * ELISION_PAYBACK_STEPS < stranded) {
            deferred++;
            continue;
          }
        }
        m.content = marker;
        tokensSaved += saving;
        elided++;
      }
    }
    return { elided, tokensSaved, deferred };
  }
}

/**
 * A digest is verbatim excerpts, never a paraphrase. Prior digests are
 * carried forward whole rather than re-excerpted — re-truncating a
 * truncation is how context silently rots across repeated sheds.
 */
export function buildDigest(dropped: Msg[]): string {
  const cap = (t: string, n = EXCERPT_CHARS) => (t.length > n ? t.slice(0, n) + "…" : t);

  const carried: string[] = [];
  const asks: string[] = [];
  const answers: string[] = [];
  const actions: string[] = [];

  for (const m of dropped) {
    if (m.molt?.digest && m.content) {
      // Carry a previous digest through intact.
      carried.push(m.content.replace(DIGEST_HEADER, "").trim());
      continue;
    }
    if (m.role === "user" && m.content) asks.push(cap(m.content));
    if (m.role === "assistant" && m.content) answers.push(cap(m.content));
    for (const c of m.tool_calls ?? []) {
      let detail = "";
      try {
        const args = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
        detail = toolDetail(c.function.name, args);
      } catch {
        detail = "(unparseable arguments)";
      }
      // Capped: an act whose actions arrived as one huge string printed all of it here.
      actions.push(`${c.function.name}: ${cap(detail, 200)}`);
    }
  }

  const sections = [
    DIGEST_HEADER,
    carried.length ? carried.join("\n\n") : "",
    asks.length ? "Earlier requests:\n- " + asks.join("\n- ") : "",
    answers.length ? "Earlier results:\n- " + answers.join("\n- ") : "",
    actions.length ? "Actions taken:\n- " + actions.slice(0, MAX_ACTION_LINES).join("\n- ") : "",
  ].filter(Boolean);

  return sections.join("\n\n");
}

export function buildExuvia(dropped: Msg[], index: number): string {
  const head = [
    `# Maat exuvia ${String(index).padStart(4, "0")} — ${new Date().toISOString()}`,
    "",
    `Full, unabridged history shed from context. ${dropped.length} messages.`,
    "Re-attach any part with `/regrow`. Nothing here was summarized.",
    "",
  ];
  const body = dropped.map((m) => {
    const tools = m.tool_calls?.length
      ? "\n\n```json\n" + JSON.stringify(m.tool_calls, null, 2) + "\n```"
      : "";
    const tag = m.molt?.digest ? " (digest)" : m.molt?.regrown ? " (regrown)" : "";
    return `## ${m.role}${tag}\n\n${m.content ?? ""}${tools}\n`;
  });
  return [...head, ...body].join("\n");
}

/**
 * What a tool call did, in one line, for a person reading the transcript.
 *
 * Each tool says the thing that identifies the call: a command, a pattern, a
 * path — never a JSON blob, which is what a grep looked like before this had
 * a case for it. A paged read says which part it asked for, because two
 * identical-looking read_file lines are a loop while "from line 240" is
 * progress, and the reader should not have to guess which they are watching.
 */
export function toolDetail(name: string, args: Record<string, unknown>): string {
  const where = String(args.path ?? "");
  const glob = args.glob ? ` ${String(args.glob)}` : "";
  const raw =
    name === "bash"
      ? args.stop_job !== undefined
        ? `stop job ${String(args.stop_job)}`
        : `${args.background === true ? "& " : ""}${String(args.command ?? "")}`
      : name === "plan"
        ? `${Array.isArray(args.steps) ? args.steps.length : 0} steps, on #${Number(args.current ?? 0) + 1}`
        : name === "grep"
        ? `/${String(args.pattern ?? "")}/${where ? ` in ${where}` : ""}${glob}`
        : name === "list_dir"
          ? `${where || "."}${glob}`
          : name === "read_file" && Number(args.offset) > 0
            ? `${where} from line ${Number(args.offset) + 1}`
            : where || JSON.stringify(args);
  // Not truncated. A command cut at eighty characters is a command you cannot
  // check, and the transcript is printed once and wraps — there is no repaint
  // cost to pay for the honesty. Whitespace is still collapsed, because a
  // heredoc spread over twelve lines is a transcript nobody can scan.
  return raw.replace(/\s+/g, " ").trim();

}

/**
 * A tool call as it goes back to the provider: arguments always valid JSON.
 *
 * Maat reads a model's slightly broken arguments leniently, which is right for
 * running the call, but it sent the broken text back in the history. Strict
 * providers then refuse every later request: DeepSeek V4 Pro on StreamLake
 * answered "Assistant tool call function.arguments must be valid JSON" and
 * ended 6 of 12 runs (2026-10-07). The transcript keeps what the model wrote;
 * only the wire copy is repaired.
 *
 * Always a JSON object, the one shape the engine runs and the one chat
 * templates that iterate `arguments | items` accept: blank or `null` is `{}`;
 * anything else that is not an object (an array, a number, a string) or that
 * cannot be read at all goes as `{"_unparsed": "<what the model wrote>"}`, so
 * the next turn sees its own mistake rather than a call that seems to have
 * sent nothing.
 */
export function wireArgs(text: string): string {
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!text.trim()) return "{}";
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    try {
      const lenient = parseLenient(text);
      if (isObject(lenient)) return JSON.stringify(lenient);
    } catch {
      /* fall through */
    }
    return JSON.stringify({ _unparsed: excerpt(text) });
  }
  if (isObject(v)) return text;
  if (v === null) return "{}";
  return JSON.stringify({ _unparsed: excerpt(text) });
}

/** How much of a refused call's arguments goes back to the provider. */
export const MALFORMED_EXCERPT_CHARS = 300;

/** The start of `text`, and how much was left out. Enough for the model to see its own mistake. */
export function excerpt(text: string, max = MALFORMED_EXCERPT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[${text.length - max} more characters not resent]`;
}

/** A refused call as it goes back to the provider: always an object, never the whole text. */
function excerptCall<T extends { function?: { arguments?: unknown } }>(c: T): T {
  const a = c.function?.arguments;
  const text = typeof a === "string" ? a : JSON.stringify(a ?? {});
  return { ...c, function: { ...c.function!, arguments: JSON.stringify({ _refused: excerpt(text) }) } };
}

function wireCall<T extends { function?: { arguments?: unknown } }>(c: T): T {
  const a = c.function?.arguments;
  if (typeof a !== "string") return c;
  const fixed = wireArgs(a);
  return fixed === a ? c : { ...c, function: { ...c.function!, arguments: fixed } };
}

/**
 * Aged tool-call arguments: the same keys, with each string value longer than
 * a fifth of `argMinChars` shortened to its ends and a marker, so the call
 * still reads as the call it was. Always a JSON object, like wireArgs.
 */
function agedArgs(text: string, o: AgingOpts, pointer: string | null): string {
  let v: unknown;
  try {
    v = JSON.parse(wireArgs(text));
  } catch {
    return text;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return text;
  const cap = Math.max(200, Math.floor(o.argMinChars / 5));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] =
      typeof val === "string" && val.length > cap + 120
        ? ageText(val, Math.floor(cap * 0.7), Math.floor(cap * 0.3), pointer, "call's argument")
        : val;
  }
  const s = JSON.stringify(out);
  return s.length < text.length ? s : text;
}
