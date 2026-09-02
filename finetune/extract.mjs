#!/usr/bin/env node
/**
 * Turn what molt already writes into fine-tuning data.
 *
 * Every completion attempt molt ever judged left three artifacts: a receipt
 * (the claim, what changed, every check's output, the verdict), a journal
 * (every tool call in order, hash-chained), and sometimes an exuvia. That is
 * a labelled dataset nobody wrote by hand — the label is the bar's verdict,
 * produced mechanically — and this script reads it back out.
 *
 * Rules, in the spirit of the thing being trained for:
 *
 *  - Every row names the record it came from (root, receipt file, receipt
 *    sha256, session, journal entry range). Nothing is invented; a field the
 *    record does not hold is absent, not guessed.
 *  - Rows are deduplicated by receipt sha256, so copies of a project (a
 *    worktree, a scratch copy) do not count the same attempt twice.
 *  - The train/valid split is by SESSION, never by row: attempts inside one
 *    session share a task and a transcript, and splitting them leaks the
 *    answer into validation.
 *  - The rendered training target is the bar's verdict, never a judgement.
 *    A model trained on this learns to PREDICT what molt's checks will say,
 *    which is adjudicated by running them. It is never asked to decide.
 *
 * Usage:
 *   node finetune/extract.mjs [--out finetune/data/<date>] [--valid 0.15] <project-root>...
 *
 * Output:
 *   records.jsonl   one structured row per unique receipt (all fields, provenance)
 *   train.jsonl     mlx-lm chat format, refusal-predictor target
 *   valid.jsonl     same, held-out sessions
 *   manifest.json   counts, roots, dedupe, the molt build this ran under
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
let out = "";
let validFrac = 0.15;
const roots = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") out = args[++i];
  else if (args[i] === "--valid") validFrac = Number(args[++i]);
  else roots.push(resolve(args[i]));
}
if (!roots.length) roots.push(process.cwd());
if (!out) out = join(process.cwd(), "finetune", "data", new Date().toISOString().slice(0, 10));
mkdirSync(out, { recursive: true });

const sha = (s) => createHash("sha256").update(s).digest("hex");
const readJsonl = (p) =>
  existsSync(p)
    ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    : [];

/** The parts of a receipt body a training row needs, read from its stable headings. */
function parseReceipt(body) {
  const section = (title) => {
    const i = body.indexOf(`## ${title}`);
    if (i < 0) return "";
    const rest = body.slice(i + title.length + 3);
    const j = rest.search(/\n## /);
    return (j < 0 ? rest : rest.slice(0, j)).trim();
  };
  const claimSec = section("What the model claimed") || section("Claim");
  const claim = claimSec.split("\n").filter((l) => l.startsWith(">")).map((l) => l.replace(/^> ?/, "")).join("\n").trim();
  const changedSec = section("What the model changed");
  const changed = [...changedSec.matchAll(/^\| `([^`]+)` \| (?:`([0-9a-f]+)`|did not exist) \| `([0-9a-f]+)` \|/gm)]
    .map((m) => ({ path: m[1], before: m[2] ?? null, after: m[3] }));
  const ran = section("What the model ran").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  let checks = [...section("What was checked, and what it established").matchAll(/^\| ([^|]+?) \| ([^|]+?) \| (.*?) \| (\d+) \|$/gm)]
    .map((m) => ({ name: m[1].trim(), verdict: m[2].trim().replace(/\*/g, ""), established: m[3].trim().replace(/\\\|/g, "|"), ms: Number(m[4]) }));
  if (!checks.length) {
    // The 2026-08-18 format: | check | kind | detail | exit | result | ms |
    checks = [...section("Checks").matchAll(/^\| ([^|]+?) \| (command|builtin) \| (.*?) \| ([^|]*?) \| (pass|FAIL|fail|warn) \| (\d+) \|$/gm)]
      .map((m) => ({ name: m[1].trim(), verdict: m[5].trim().toUpperCase() === "FAIL" ? "FAIL" : m[5].trim(), established: m[3].trim().replace(/`/g, ""), ms: Number(m[6]) }));
  }
  // Full output per check, from the "### name — pass|FAIL" blocks.
  const outputs = {};
  for (const m of body.matchAll(/^### (.+?) — (pass|FAIL)\n[\s\S]*?```\n([\s\S]*?)\n```/gm)) outputs[m[1]] = m[3];
  const meta = Object.fromEntries([...body.matchAll(/^- ([a-z ]+): (.+)$/gm)].map((m) => [m[1], m[2]]));
  const verdict = /^# molt receipt \d+ — (\w+)/m.exec(body)?.[1];
  return { verdict, claim, changed, ran, checks, outputs, meta };
}

/** Journal entries of the turn that produced a receipt: the last user message before it, through the bar run. */
function turnOf(entries, receiptFile) {
  const at = entries.findIndex((e) => e.kind === "receipt" && basename(String(e.data.file ?? "")) === receiptFile);
  if (at < 0) return null;
  let start = at;
  while (start > 0 && entries[start].kind !== "user_message") start--;
  const slice = entries.slice(start, at + 1);
  return {
    from: entries[start].seq,
    to: entries[at].seq,
    task: slice.find((e) => e.kind === "user_message")?.data.preview ?? null,
    ask: slice.some((e) => e.kind === "note" && /^ask turn/.test(String(e.data.text ?? ""))),
    calls: slice.filter((e) => e.kind === "tool_call").map((e) => ({ name: e.data.name, detail: e.data.detail, allowed: e.data.allowed !== false })),
    permissions: slice.filter((e) => e.kind === "permission").map((e) => ({ name: e.data.name, asked: e.data.asked, allowed: e.data.allowed, autonomy: e.data.autonomy })),
    bar: slice.filter((e) => e.kind === "bar_run").at(-1)?.data ?? null,
    stuck: slice.some((e) => e.kind === "bar_stuck"),
  };
}

/** Captures written by `--capture`, keyed by receipt file name. */
function capturesIn(root) {
  const out = new Map();
  const dir = join(root, "finetune", "captures");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    try {
      const c = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (c && typeof c.receipt === "string") out.set(c.receipt, c);
    } catch { /* a torn capture is no capture */ }
  }
  return out;
}

/** The conversation as the model saw it, bounded per message, for a capture-backed row. */
const MAX_MSG = 700;
function renderTranscript(transcript) {
  const msgs = transcript.filter((m) => m.role !== "system");
  const keep = msgs.length <= 40 ? msgs : [...msgs.slice(0, 26), { role: "user", content: `[… ${msgs.length - 38} messages omitted …]` }, ...msgs.slice(-12)];
  return keep.map((m) => {
    const calls = (m.tool_calls ?? []).map((c) => `${c.function?.name}(${String(c.function?.arguments ?? "").slice(0, 200)})`).join("; ");
    const body = String(m.content ?? "").replace(/\s+/g, " ").slice(0, MAX_MSG);
    return `[${m.role}] ${body}${calls ? ` CALLS: ${calls}` : ""}`;
  }).join("\n");
}

const rows = new Map(); // receipt sha -> row
let seenFiles = 0;
for (const root of roots) {
  const dir = join(root, ".molt", "receipts");
  if (!existsSync(dir)) continue;
  const journals = new Map();
  for (const f of existsSync(join(root, ".molt", "log")) ? readdirSync(join(root, ".molt", "log")) : []) {
    if (f.endsWith(".jsonl")) journals.set(f.replace(/\.jsonl$/, ""), readJsonl(join(root, ".molt", "log", f)));
  }
  const index = readJsonl(join(dir, "index.jsonl"));
  const captures = capturesIn(root);
  for (const f of readdirSync(dir).filter((n) => /^\d{4}-.*\.md$/.test(n)).sort()) {
    seenFiles++;
    const body = readFileSync(join(dir, f), "utf8");
    const id = sha(body);
    if (rows.has(id)) { rows.get(id).provenance.roots.push(basename(root)); continue; }
    const r = parseReceipt(body);
    const idx = index.filter((x) => x.file === f).at(-1) ?? {};
    // Which session: the index row says, or a journal names this receipt.
    let session = idx.session ?? null;
    if (!session) for (const [sid, es] of journals) if (es.some((e) => e.kind === "receipt" && basename(String(e.data.file ?? "")) === f)) { session = sid; break; }
    const turn = session && journals.has(session) ? turnOf(journals.get(session), f) : null;
    rows.set(id, {
      provenance: { roots: [basename(root)], receipt: f, receiptSha256: id, session, journal: turn ? { from: turn.from, to: turn.to } : null },
      model: r.meta["model"] ?? idx.model ?? null,
      provider: r.meta["provider"] ?? idx.provider ?? null,
      when: r.meta["when"] ?? idx.iso ?? null,
      attempt: Number(r.meta["attempt"] ?? idx.attempt ?? 0),
      task: turn?.task ?? null,
      ask: turn?.ask ?? idx.ask ?? false,
      calls: turn?.calls ?? null,
      permissions: turn?.permissions ?? null,
      changed: r.changed,
      ran: r.ran,
      claim: r.claim,
      checks: r.checks,
      outputs: r.outputs,
      verdict: r.verdict ?? idx.verdict,
      failed: r.checks.filter((c) => c.verdict === "FAIL").map((c) => c.name),
      stuck: turn?.stuck ?? false,
      transcript: captures.get(f)?.transcript ?? null,
      sessionTokens: Number(r.meta["session tokens"] ?? idx.sessionTokens ?? 0),
      costUsd: r.meta["session cost"] ?? null,
    });
  }
}

const all = [...rows.values()].sort((a, b) => String(a.when).localeCompare(String(b.when)));
writeFileSync(join(out, "records.jsonl"), all.map((r) => JSON.stringify(r)).join("\n") + "\n");

// ── the refusal-predictor target ────────────────────────────────────────────
// Input: everything the model could know before claiming. Output: what the bar said.
const MAX_CALLS = 32;
const MAX_CLAIM = 1200;
const MAX_CHANGED = 40;
const MAX_PROMPT_CHARS = 7000; // ~2k tokens on code-heavy text: leaves the target inside a 4096 window
function boundedCalls(calls) {
  if (calls.length <= MAX_CALLS) return calls.map((c) => `- ${c.allowed ? "" : "refused: "}${String(c.name).slice(0, 160)} ${String(c.detail).slice(0, 120)}`);
  const head = calls.slice(0, 22), tail = calls.slice(-10);
  return [...head, { name: `… ${calls.length - 32} call(s) omitted …`, detail: "", allowed: true }, ...tail]
    .map((c) => `- ${c.allowed ? "" : "refused: "}${String(c.name).slice(0, 160)} ${String(c.detail).slice(0, 120)}`);
}
function renderInput(r) {
  const lines = [
    "You are molt's safeguard. Predict what the bar will say about this completion claim.",
    "",
    `Task: ${r.task ?? "(not recorded)"}`,
    `Model: ${r.model}${r.ask ? " · ask turn (write checks dropped)" : ""}`,
    "",
    ...(r.transcript ? ["Conversation, as sent to the model:", renderTranscript(r.transcript), ""] : []),
    "Tool calls, in order:",
    ...(r.calls?.length ? boundedCalls(r.calls) : (r.ran.length ? boundedCalls(r.ran.slice(0, 64).map((x) => ({ name: x, detail: "", allowed: true }))) : ["- (none recorded)"])),
    "",
    "Files changed (ledger):",
    ...(r.changed.length ? [...r.changed.slice(0, MAX_CHANGED).map((c) => `- ${c.path}${c.before === null ? " (created)" : ""}`), ...(r.changed.length > MAX_CHANGED ? [`- … ${r.changed.length - MAX_CHANGED} more`] : [])] : ["- none"]),
    "",
    `Claim: ${(r.claim || "(no final message)").slice(0, MAX_CLAIM)}${r.claim.length > MAX_CLAIM ? " …" : ""}`,
    "",
    `Checks that will run: ${r.checks.map((c) => c.name).join(", ")}`,
  ];
  const s = lines.join("\n");
  return s.length <= MAX_PROMPT_CHARS ? s : s.slice(0, MAX_PROMPT_CHARS - 40) + "\n[… prompt cut to fit the training window]";
}
function renderTarget(r) {
  if (r.verdict === "accepted") return "ACCEPTED — every check that can refuse a completion passed.";
  const fails = r.checks.filter((c) => c.verdict === "FAIL");
  const head = r.verdict === "exhausted" ? "EXHAUSTED" : "REFUSED";
  return [`${head} — ${fails.length} check(s) fail:`, ...fails.map((c) => `- ${c.name}: ${(r.outputs[c.name] ?? c.established).split("\n").slice(0, 2).join(" ").slice(0, 200)}`)].join("\n");
}
const example = (r) => ({ messages: [{ role: "user", content: renderInput(r) }, { role: "assistant", content: renderTarget(r) }] });

// Split by session (rows with no session fall into train).
const sessions = [...new Set(all.map((r) => r.provenance.session).filter(Boolean))].sort();
const validSessions = new Set(sessions.filter((s) => parseInt(sha(s).slice(0, 8), 16) / 0xffffffff < validFrac));
const train = all.filter((r) => !validSessions.has(r.provenance.session));
const valid = all.filter((r) => validSessions.has(r.provenance.session));
for (const [name, set] of [["train", train], ["valid", valid], ["test", valid]]) {
  writeFileSync(join(out, `${name}.jsonl`), set.map((r) => JSON.stringify(example(r))).join("\n") + "\n");
  // Same order, one line each: the record every training row came from.
  writeFileSync(join(out, `${name}.provenance.jsonl`), set.map((r) => JSON.stringify(r.provenance)).join("\n") + "\n");
}

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  roots,
  receiptFilesSeen: seenFiles,
  uniqueReceipts: all.length,
  duplicatesDropped: seenFiles - all.length,
  withJournalTurn: all.filter((r) => r.calls).length,
  withCapturedTranscript: all.filter((r) => r.transcript).length,
  verdicts: Object.fromEntries(["accepted", "refused", "exhausted"].map((v) => [v, all.filter((r) => r.verdict === v).length])),
  askTurns: all.filter((r) => r.ask).length,
  byModel: Object.fromEntries([...new Set(all.map((r) => r.model))].map((m) => [m, all.filter((r) => r.model === m).length])),
  failingChecks: Object.fromEntries([...new Set(all.flatMap((r) => r.failed))].map((n) => [n, all.filter((r) => r.failed.includes(n)).length])),
  split: { train: train.length, valid: valid.length, validSessions: [...validSessions] },
  longestExampleEstTokens: Math.max(...all.map((r) => Math.ceil((renderInput(r).length + renderTarget(r).length) / 4))),
  target: "refusal-predictor: (task, tool calls, changed files, claim, checks) -> the bar's verdict and failing checks",
};
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`${all.length} unique receipts from ${seenFiles} files across ${roots.length} root(s) → ${out}`);
console.log(`train ${train.length} · valid ${valid.length} (${validSessions.size} held-out session(s)) · with journal turn ${manifest.withJournalTurn}`);
console.log(`verdicts ${JSON.stringify(manifest.verdicts)} · failing checks ${JSON.stringify(manifest.failingChecks)}`);
