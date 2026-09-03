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

export class Transcript {
  private system: Msg;
  private working: Msg[] = [];
  /** Every message ever shed, oldest batch first. Never truncated. */
  private archived: Msg[][] = [];
  /** What this turn is for. Sent every request, shed never. */
  private task: string | null = null;

  constructor(systemPrompt: string) {
    this.system = { role: "system", content: systemPrompt };
  }

  push(msg: Msg): void {
    this.working.push(msg);
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
  wire(): Omit<Msg, "molt">[] {
    return this.all().map(({ molt: _molt, ...rest }) => rest);
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
    const historyTokens = this.working.reduce(
      (n, m) => n + estTokens(m.content ?? "") + estTokens(JSON.stringify(m.tool_calls ?? "")),
      0,
    );
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
    return this.working.reduce(
      (n, m) => n + estTokens(m.content ?? "") + estTokens(JSON.stringify(m.tool_calls ?? "")),
      0,
    );
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
    const afterTokens = [digestMsg, ...kept].reduce(
      (n, m) => n + estTokens(m.content ?? "") + estTokens(JSON.stringify(m.tool_calls ?? "")),
      0,
    );

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
    opts: { protectCache?: boolean } = {},
  ): { elided: number; tokensSaved: number; deferred: number } {
    const supersededBy = new Map<number, string>();
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
    const lastRead = new Map<string, number>();
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
        const path = String(args.path ?? "");
        if (!path) continue;

        if (call.function.name === "read_file") {
          // Identical arguments return identical bytes; anything else is a
          // different part of the file and stands on its own.
          const window = `${path}@${Number(args.offset ?? 0)}+${String(args.limit ?? "all")}`;
          const prior = lastRead.get(window);
          if (prior !== undefined) supersededBy.set(prior, `re-read at step ${i}`);
          lastRead.set(window, i);
          const windows = readsOf.get(path) ?? [];
          if (!windows.includes(window)) windows.push(window);
          readsOf.set(path, windows);
        } else if (call.function.name === "write_file" || call.function.name === "edit_file") {
          // A change to the file invalidates every part of it that was read,
          // whichever window it came from: what is in context is no longer
          // what is on disk.
          for (const window of readsOf.get(path) ?? []) {
            const prior = lastRead.get(window);
            if (prior !== undefined) supersededBy.set(prior, `changed at step ${i}`);
            lastRead.delete(window);
          }
          readsOf.delete(path);
        }
      }
    }

    let elided = 0;
    let tokensSaved = 0;
    let deferred = 0;
    for (const [callIdx, reason] of supersededBy) {
      // The tool result follows its assistant turn.
      for (let j = callIdx + 1; j < this.working.length; j++) {
        const m = this.working[j];
        if (m.role !== "tool") break;
        if (!m.content || m.content.startsWith(ELIDED_PREFIX)) continue;
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
      actions.push(`${c.function.name}: ${detail}`);
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
    `# molt exuvia ${String(index).padStart(4, "0")} — ${new Date().toISOString()}`,
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
      ? String(args.command ?? "")
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
