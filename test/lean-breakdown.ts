/**
 * Where a request's characters go.
 *
 * The lean-budget suite measures how big each request is; this says what it is
 * made of. Every request body a scripted turn sent is split into components:
 *
 *   system      the system prompt proper
 *   task        the pinned "what this turn is for" note
 *   digest      the mechanical digest a shed left behind
 *   tools       the tool schemas
 *   request     the user's own request message
 *   notes       other user messages Maat injected (bar failures, nudges, regrown)
 *   asstText    assistant prose
 *   asstCalls   assistant tool calls (names and arguments)
 *   results     tool results
 *   envelope    everything else: JSON keys, model, max_tokens, punctuation
 *
 * and, inside the tool results, how much is avoidable resend:
 *
 *   dupLines    lines a result repeats from an earlier result in the same request
 *               (a file read twice, overlapping sed ranges, a test rerun)
 *   superseded  results whose command was run again later in the same request
 *               (identical command, or an earlier run of the test suite)
 *
 * And per step, how much of the request is an exact repeat of the previous
 * one's leading messages: what a provider's prefix cache can serve.
 *
 * Chars, not tokens: the suite's numbers are chars and molt's own estimate is
 * chars / 4, so a token figure is that divided by four.
 */
import { DIGEST_HEADER } from "../src/transcript.js";

export const COMPONENTS = [
  "system",
  "task",
  "digest",
  "tools",
  "request",
  "notes",
  "asstText",
  "asstCalls",
  "results",
  "envelope",
] as const;
export type Component = (typeof COMPONENTS)[number];

export type Parts = Record<Component, number> & {
  body: number;
  dupLines: number;
  superseded: number;
  /** Earlier test-runner output with a later test run in the same request (an upper bound). */
  testRuns: number;
  /** Tool results older than the newest six in the request: what ageing works on. */
  oldResults: number;
  /** Tool calls whose arguments are over 1,000 chars, as sent. */
  longArgs: number;
  /** Chars at the start of this request identical to the previous request's start. */
  stablePrefix: number;
  messages: number;
};

type WireMsg = {
  role: string;
  content?: string | null | { type: string; text?: string }[];
  tool_calls?: { id?: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

const TASK_MARK = "[molt] What this turn is for.";
const len = (v: unknown): number => (v === undefined ? 0 : JSON.stringify(v).length);
const text = (c: WireMsg["content"]): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : "";

/** A test runner: a later run makes an earlier one's output history. */
export const TEST_RUN = /\b(pytest|unittest|npm (run )?test|node --test|go test|cargo test|jest|vitest|make( |$|\b)check)\b/;

function commandOf(call: { function: { name: string; arguments: string } }): string {
  try {
    const a = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    if (call.function.name === "bash") return `bash:${String(a.command ?? "").replace(/\s+/g, " ").trim()}`;
    return `${call.function.name}:${JSON.stringify(a)}`;
  } catch {
    return `${call.function.name}:?`;
  }
}

/** The leading messages two requests share exactly, in chars of the later one. */
function sharedPrefix(prev: WireMsg[] | undefined, cur: WireMsg[]): number {
  if (!prev) return 0;
  let n = 0;
  for (let i = 0; i < Math.min(prev.length, cur.length); i++) {
    const a = JSON.stringify(prev[i]);
    const b = JSON.stringify(cur[i]);
    if (a !== b) break;
    n += b.length;
  }
  return n;
}

export function breakdown(body: string, prevBody?: string): Parts {
  const req = JSON.parse(body) as { messages: WireMsg[]; tools?: unknown };
  const prev = prevBody ? (JSON.parse(prevBody) as { messages: WireMsg[]; tools?: unknown }) : undefined;
  const p: Parts = {
    body: body.length,
    system: 0,
    task: 0,
    digest: 0,
    tools: len(req.tools),
    request: 0,
    notes: 0,
    asstText: 0,
    asstCalls: 0,
    results: 0,
    envelope: 0,
    dupLines: 0,
    superseded: 0,
    testRuns: 0,
    oldResults: 0,
    longArgs: 0,
    stablePrefix: 0,
    messages: req.messages.length,
  };
  // Tools first: a provider renders the tools ahead of the conversation, so an
  // unchanged tool list is the first thing a prefix cache can reuse.
  const toolsSame = prev && JSON.stringify(prev.tools) === JSON.stringify(req.tools);
  p.stablePrefix = (toolsSame ? p.tools : 0) + (toolsSame ? sharedPrefix(prev?.messages, req.messages) : 0);

  // Which call produced each result, and the commands run later in this request.
  const order: { id: string; cmd: string; at: number }[] = [];
  req.messages.forEach((m, at) => {
    for (const c of m.tool_calls ?? []) {
      order.push({ id: c.id ?? "", cmd: commandOf(c), at });
    }
  });
  // Superseded: the same command ran again later and came back different (a
  // rerun that came back the same is already sent as a short pointer, and the
  // earlier copy is the one being pointed at). Earlier test runs: any test-runner
  // output with another test run after it, whatever its arguments.
  const resultOf = new Map<string, string>();
  for (const m of req.messages) if (m.role === "tool" && m.tool_call_id) resultOf.set(m.tool_call_id, text(m.content));
  const isPointer = (id: string) => (resultOf.get(id) ?? "").startsWith("[molt: this is the same ");
  const supersededIds = new Set<string>();
  const testIds = new Set<string>();
  order.forEach((o, i) => {
    const later = order.slice(i + 1);
    if (later.some((l) => l.cmd === o.cmd && !isPointer(l.id) && resultOf.get(l.id) !== resultOf.get(o.id))) supersededIds.add(o.id);
    if (o.cmd.startsWith("bash:") && TEST_RUN.test(o.cmd) && later.some((l) => l.cmd.startsWith("bash:") && TEST_RUN.test(l.cmd)))
      testIds.add(o.id);
  });

  const toolAt = req.messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const newest = new Set(toolAt.slice(-6));
  const seenLines = new Set<string>();
  let firstUser = true;
  req.messages.forEach((m, i) => {
    const t = text(m.content);
    if (m.role === "system" && i === 0) {
      // Leading system messages arrive joined: prompt, then task, then digest.
      const ti = t.indexOf(TASK_MARK);
      const di = t.indexOf(DIGEST_HEADER);
      const cuts = [ti, di].filter((x) => x >= 0).sort((a, b) => a - b);
      const sysEnd = cuts[0] ?? t.length;
      p.system += len(t.slice(0, sysEnd));
      if (ti >= 0) p.task += len(t.slice(ti, di > ti ? di : t.length));
      if (di >= 0) p.digest += len(t.slice(di, ti > di ? ti : t.length));
      return;
    }
    if (m.role === "user") {
      if (t.startsWith(DIGEST_HEADER)) p.digest += len(t);
      else if (firstUser) {
        p.request += len(t);
        firstUser = false;
      } else p.notes += len(t);
      return;
    }
    if (m.role === "assistant") {
      p.asstText += t ? len(t) : 0;
      p.asstCalls += m.tool_calls ? len(m.tool_calls) : 0;
      for (const c of m.tool_calls ?? []) if (c.function.arguments.length > 1000) p.longArgs += len(c);
      return;
    }
    if (m.role === "tool") {
      p.results += len(t);
      if (!newest.has(i)) p.oldResults += len(t);
      if (m.tool_call_id && supersededIds.has(m.tool_call_id)) p.superseded += len(t);
      if (m.tool_call_id && testIds.has(m.tool_call_id)) p.testRuns += len(t);
      for (const line of t.split("\n")) {
        const k = line.trim();
        if (k.length < 20) continue;
        if (seenLines.has(k)) p.dupLines += line.length + 1;
        else seenLines.add(k);
      }
      return;
    }
    p.notes += len(t);
  });
  const named = COMPONENTS.filter((c) => c !== "envelope").reduce((n, c) => n + p[c], 0);
  p.envelope = p.body - named;
  return p;
}

export type Summary = {
  steps: number;
  largest: number;
  total: number;
  /** Component totals over every request of the turn. */
  sum: Parts;
  /** The breakdown of the largest request. */
  peak: Parts;
  /** stablePrefix / body over the whole turn: the cacheable share. */
  cacheable: number;
  /**
   * The turn's chars with the cacheable prefix priced at a tenth: what a
   * provider that bills cache reads at 10% (Anthropic, DeepSeek, Gemini) would
   * charge for, in chars. Uncached chars count in full.
   */
  weighted: number;
  /** Each request's size, in order. */
  series: number[];
  /** Steps whose request kept less than 90% of the previous one as a cacheable prefix. */
  breaks: { step: number; kept: number }[];
};

/** What a cache read costs relative to an uncached input token, for `weighted`. */
export const CACHE_READ_PRICE = 0.1;

export function summarize(bodies: string[]): Summary {
  const all = bodies.map((b, i) => breakdown(b, bodies[i - 1]));
  const sum = {} as Parts;
  for (const k of [...COMPONENTS, "body", "dupLines", "superseded", "testRuns", "oldResults", "longArgs", "stablePrefix", "messages"] as const) {
    sum[k] = all.reduce((n, p) => n + p[k], 0);
  }
  const peak = all.reduce((a, b) => (b.body > a.body ? b : a), all[0]!);
  const breaks = all
    .map((p, i) => ({ step: i, kept: i === 0 ? 1 : p.stablePrefix / all[i - 1]!.body }))
    .filter((b) => b.step > 0 && b.kept < 0.9)
    .map((b) => ({ step: b.step, kept: Math.round(b.kept * 1000) / 1000 }));
  return {
    weighted: Math.round(sum.body - sum.stablePrefix + CACHE_READ_PRICE * sum.stablePrefix),
    series: all.map((p) => p.body),
    breaks,
    steps: all.length,
    largest: peak.body,
    total: sum.body,
    sum,
    peak,
    cacheable: sum.body ? sum.stablePrefix / sum.body : 0,
  };
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");

/** A plain-text table of a summary, for the test log and the report. */
export function table(name: string, s: Summary): string {
  const rows = [
    `${name}: ${s.steps} requests, largest ${s.largest.toLocaleString("en-US")}, total ${s.total.toLocaleString("en-US")} chars, cacheable prefix ${pct(s.sum.stablePrefix, s.total)}, cache-weighted ${s.weighted.toLocaleString("en-US")}, cache breaks at ${s.breaks.map((b) => `${b.step}(${Math.round(b.kept * 100)}%)`).join(" ") || "none"}`,
    `  component     total chars    share   | largest request   share`,
  ];
  for (const c of COMPONENTS) {
    rows.push(
      `  ${c.padEnd(12)} ${s.sum[c].toLocaleString("en-US").padStart(12)} ${pct(s.sum[c], s.total).padStart(7)}   | ${s.peak[c]
        .toLocaleString("en-US")
        .padStart(10)} ${pct(s.peak[c], s.peak.body).padStart(7)}`,
    );
  }
  rows.push(
    `  of results: older than the newest six ${s.sum.oldResults.toLocaleString("en-US")} (${pct(s.sum.oldResults, s.total)}); of calls: arguments over 1,000 chars ${s.sum.longArgs.toLocaleString("en-US")} (${pct(s.sum.longArgs, s.total)})`,
  );
  rows.push(
    `  of results: dupLines ${s.sum.dupLines.toLocaleString("en-US")} (${pct(s.sum.dupLines, s.total)}), superseded ${s.sum.superseded.toLocaleString("en-US")} (${pct(s.sum.superseded, s.total)}), earlier test runs ${s.sum.testRuns.toLocaleString("en-US")} (${pct(s.sum.testRuns, s.total)})`,
  );
  return rows.join("\n");
}
