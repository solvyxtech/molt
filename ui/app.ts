/**
 * The window.
 *
 * Rendering only. Every fact on screen arrives as an `EngineEvent` from the
 * main process, and every action leaves through the preload bridge — this file
 * has no filesystem, no network, and no way to acquire one.
 *
 * The organising rule is the one the TUI learned the hard way: the session
 * stream is for the work, and everything else gets its own surface. Reading
 * the wire, the journal, or a receipt must never push the model's narration up
 * the screen, because a log you have to scroll away from is a log you stop
 * reading.
 */

import { renderMarkdown } from "./markdown.js";
import { playSplash } from "./splash.js";
import { fmtCost } from "../src/format.js";
import { matchCommands } from "../src/commands.js";
import { JOURNAL_RENDER_CAP, STREAM_CAP, contextCap, contextFill, newest, trimOldest } from "./bounds.js";
import { holdAfterAutoDraft, taskForRun } from "./criteria-hold.js";

// ── the bridge ───────────────────────────────────────────────────────────────

type ConfirmReq = { id: string; name: string; detail: string };
type MoltBridge = {
  state(): Promise<AppState>;
  theme(name: string): Promise<Record<string, string>>;
  pickWorkspace(): Promise<string | null>;
  openSession(o: {
    cwd: string;
    model: string;
    baseUrl: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; error?: string; state?: AppState }>;
  saveKey(provider: string, key: string): Promise<boolean>;
  saveEndpoint(baseUrl: string, model: string): Promise<boolean>;
  storedEndpoint(): Promise<{ baseUrl?: string; model?: string }>;
  listModels(current?: { url: string; key?: string }): Promise<ModelSource[]>;
  endpoints(): Promise<{ url: string; lastModel?: string; seen: string }[]>;
  addEndpoint(url: string, model?: string): Promise<unknown>;
  forgetEndpoint(url: string): Promise<unknown>;
  setModel(o: {
    model: string;
    baseUrl?: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; error?: string; state?: AppState }>;
  setAutonomy(
    level: string,
  ): Promise<{ ok: boolean; error?: string; state?: AppState; means?: string }>;
  command(name: string, arg: string): Promise<CommandOutcome>;
  reset(): Promise<{ ok: boolean; error?: string; state?: AppState }>;
  initBar(): Promise<CommandOutcome & { state?: AppState }>;
  run(
    text: string,
    ask?: boolean,
    criteria?: { checks: { name: string; run: string }[]; notes: string[] },
  ): Promise<{ ok: boolean; error?: string }>;
  draftCriteria(
    task: string,
  ): Promise<
    { ok: true; draft: { checks: { name: string; run: string }[]; notes: string[] } }
    | { ok: false; error: string }
  >;
  interview(opts: {
    task: string;
    round: number;
    history: { questions: { id: string; prompt: string; options: string[]; allowOther: boolean }[]; answers: { id: string; choice: string }[] }[];
  }): Promise<
    | { kind: "ask"; questions: { id: string; prompt: string; options: string[]; allowOther: boolean }[]; round: number }
    | { kind: "propose"; proposal: { barAdds: { name: string; run: string }[]; checks: { name: string; run: string }[]; notes: string[] } }
    | { kind: "error"; error: string }
  >;
  applyBar(adds: { name: string; run: string }[]): Promise<{ ok: boolean; error?: string; state?: AppState }>;
  cancel(): void;
  answerConfirm(id: string, ok: boolean): void;
  receipts(): Promise<ReceiptRow[]>;
  receipt(file: string): Promise<string | null>;
  journal(): Promise<Record<string, unknown>[]>;
  stats(): Promise<Stats | null>;
  verify(): Promise<VerifyResult | null>;
  onEvent(fn: (ev: Ev) => void): () => void;
  onConfirm(fn: (r: ConfirmReq) => void): () => void;
  onIdle(fn: () => void): () => void;
};

type VerifyResult = {
  ok: boolean;
  established: boolean;
  records: number;
  brokenAt: number | null;
  reason: string | null;
  drift: { kind: string; file: string; bound: string }[];
  unbound: { kind: string; file: string }[];
  /** Every session log's own chain, recomputed — half of what `molt verify` checks. */
  journals?: { file: string; ok: boolean; entries: number; reason: string | null }[];
  root: string | null;
  generatedAt: string;
};

type AppState = {
  open: boolean;
  cwd: string | null;
  model: string | null;
  baseUrl: string | null;
  provider: string | null;
  selfHosted: boolean;
  autonomy: string;
  autonomyLevels: { level: string; means: string }[];
  checks: { name: string; kind: string; tags: string[] }[];
  barError: string | null;
  sessionId: string | null;
  providers: string[];
  keyed: string[];
  themes: string[];
  platform: string;
  commands: { name: string; args?: string; summary: string; aliases?: string[] }[];
};

type CommandOutcome =
  | { kind: "info"; text: string }
  | { kind: "error"; text: string }
  | { kind: "bar"; result: any }
  | { kind: "unhandled" };

type ModelSource = {
  name: string;
  url: string;
  ok: boolean;
  ids: string[];
  error?: string;
  needsKey?: boolean;
  local?: boolean;
  remembered?: boolean;
};

type ReceiptRow = { file: string; n: number; verdict: string; mtime: number };
type Stats = {
  tokens: number;
  cached: number;
  costUsd: number | null;
  costEstimated?: boolean;
  shedBatches: number;
  hasBar: boolean;
  requestEst: number;
  window: number;
  budget: number | null;
};

/** Loose on purpose: the engine's event union is the authority, not this. */
type Ev = { kind: string } & Record<string, any>;

declare global {
  interface Window {
    molt: MoltBridge;
  }
}
const molt = window.molt;

// ── dom helpers ──────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  // textContent, never innerHTML. Everything on this screen is either model
  // output or a provider's error message, and both are untrusted strings.
  if (text !== undefined) n.textContent = text;
  return n;
}

const fmtInt = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);

/**
 * A duration, at the precision the number deserves.
 *
 * It was `${Math.round(ms / 60_000)}m` past a minute, which rounded 90s to
 * "2m" and printed a 64s test run and a 119s one identically. On a screen whose
 * whole claim is that the numbers are real, a duration that rounds to the
 * nearest minute is the wrong kind of approximate.
 */
const fmtMs = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  let m = Math.floor(ms / 60_000);
  let s = Math.round((ms % 60_000) / 1000);
  if (s === 60) {
    m += 1;
    s = 0;
  }
  return s ? `${m}m ${s}s` : `${m}m`;
};

// ── state ────────────────────────────────────────────────────────────────────

let state: AppState | null = null;
let busy = false;
/** The assistant paragraph currently being streamed into, if any. */
let openSaid: HTMLElement | null = null;
/** Tool rows awaiting completion, keyed by name+detail. */
const runningTools = new Map<string, HTMLElement>();
let activeReceipt: string | null = null;
/** The receipt for the proof still being rendered. See the `receipt` case. */
let pendingReceipt: string | null = null;

// ── tabs ─────────────────────────────────────────────────────────────────────

const TABS = ["session", "view", "receipts", "log", "settings"] as const;

function showTab(name: string): void {
  for (const t of document.querySelectorAll<HTMLElement>(".tab")) {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    // The strip already said role="tab" and never said which one was chosen,
    // so a screen reader announced five tabs and no selection. Roving tabindex
    // with it: a tablist is one stop, and the arrows move inside it.
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
  }
  for (const p of document.querySelectorAll<HTMLElement>(".panel"))
    p.classList.toggle("active", p.id === `panel-${name}`);
  // The composer belongs to the session; showing it elsewhere invites you to
  // type a task into a screen that will not run one.
  $("composer").classList.toggle("hidden", name !== "session");
  if (name !== "session") closePalette();
  // Not at boot: with no workspace open the window lands on Settings, and a
  // splash that molts behind a form nobody is looking at has been spent. It
  // plays the first time the session is actually on screen.
  if (name === "session") {
    const empty = document.getElementById("stream-empty");
    if (empty) playSplash(empty);
  }
  if (name === "receipts") void loadReceipts();
  if (name === "log") void loadJournal();
  if (name === "receipts") clearBadge("receipts");
}

function badge(which: "receipts", text: string, kind?: "ok" | "fail"): void {
  const b = $(`badge-${which}`);
  b.textContent = text;
  b.className = `badge${kind ? " " + kind : ""}`;
}
function clearBadge(which: "receipts"): void {
  $(`badge-${which}`).className = "badge hidden";
}

document.getElementById("tabs")!.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>(".tab");
  if (t?.dataset.tab) showTab(t.dataset.tab);
});

/** Arrow keys move within the strip, which is what a tablist promises. */
document.getElementById("tabs")!.addEventListener("keydown", (e) => {
  if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
  const tabs = [...document.querySelectorAll<HTMLElement>(".tab")];
  const at = tabs.findIndex((t) => t.classList.contains("active"));
  const to =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? tabs.length - 1
        : (at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  const next = tabs[to];
  if (!next?.dataset.tab) return;
  e.preventDefault();
  showTab(next.dataset.tab);
  next.focus();
});
document.body.addEventListener("click", (e) => {
  const g = (e.target as HTMLElement).closest<HTMLElement>("[data-goto]");
  if (g?.dataset.goto) showTab(g.dataset.goto);
});

// ── session stream ───────────────────────────────────────────────────────────

const stream = () => $("stream");

function atBottom(): boolean {
  const p = $("panel-session");
  return p.scrollHeight - p.scrollTop - p.clientHeight < 90;
}
function follow(was: boolean): void {
  if (was) $("panel-session").scrollTop = $("panel-session").scrollHeight;
  updateJump();
}

function append(node: HTMLElement): void {
  const was = atBottom();
  $("stream-empty")?.remove();
  stream().appendChild(node);
  // The wire view already drops frames past 600. The session stream did
  // not, so a long day of work paid for every earlier turn on every
  // scroll. Oldest rows go first; the record is still on disk.
  trimOldest(stream(), STREAM_CAP);
  follow(was);
}

function jumpLive(): void {
  const p = $("panel-session");
  p.scrollTop = p.scrollHeight;
  updateJump();
}

function updateJump(): void {
  $("jump").classList.toggle("hidden", atBottom() || !busy);
}

$("panel-session").addEventListener(
  "scroll",
  () => updateJump(),
  { passive: true },
);
$("jump").addEventListener("click", jumpLive);

/**
 * The row that says molt is alive.
 *
 * Reported as "nothing happens when you put in a prompt". Something did — the
 * dot in the corner pulsed and the Stop button appeared — but the stream, which
 * is where you are looking, showed your message and then held still. Against a
 * hosted model that gap is a second. Against a 30B on your own hardware it was
 * over three minutes of a screen that looked broken.
 *
 * So the wait gets a line of its own, with a phase and a clock, and the clock
 * is the point: a number that changes is the difference between "working" and
 * "hung", and no amount of animation says it as plainly.
 */
let activity: { row: HTMLElement; phase: HTMLElement; clock: HTMLElement; started: number } | null =
  null;
let activityTimer: ReturnType<typeof setInterval> | null = null;

function startActivity(phase: string): void {
  if (activity) {
    setPhase(phase);
    return;
  }
  const row = el("div", "activity");
  row.appendChild(el("span", "spin", "▪"));
  const p = el("span", "phase", phase);
  const c = el("span", "clock", "0s");
  row.appendChild(p);
  row.appendChild(c);
  activity = { row, phase: p, clock: c, started: Date.now() };
  append(row);
  activityTimer = setInterval(() => {
    if (!activity) return;
    activity.clock.textContent = fmtMs(Date.now() - activity.started);
  }, 1000);
}

function setPhase(phase: string): void {
  if (activity) activity.phase.textContent = phase;
  else startActivity(phase);
}

function stopActivity(): void {
  if (activityTimer) clearInterval(activityTimer);
  activityTimer = null;
  activity?.row.remove();
  activity = null;
}

/** Keep the waiting row at the bottom, below whatever just arrived. */
function bumpActivity(): void {
  if (activity) stream().appendChild(activity.row);
}

function say(who: string, text: string, cls = ""): HTMLElement {
  const row = el("div", `said ${cls}`.trim());
  row.appendChild(el("div", "who", who));
  row.appendChild(el("div", "what", text));
  append(row);
  bumpActivity();
  return row;
}

/**
 * Text arriving a fragment at a time.
 *
 * Held open until `message_end`, which is the engine saying the message is
 * finished. Guessing that boundary is what ran every step's narration into the
 * next one in the terminal; the event exists so no surface has to guess again.
 */
function delta(text: string): void {
  const was = atBottom();
  if (!openSaid) {
    openSaid = say("molt", "");
  }
  const what = openSaid.querySelector(".what")!;
  what.textContent = (what.textContent ?? "") + text;
  follow(was);
}

function endMessage(): void {
  openSaid = null;
}

function toolRow(ev: Ev, running: boolean): HTMLElement {
  const d = el("details", `tool${running ? " running" : ""}`) as HTMLDetailsElement;
  const s = el("summary");
  s.appendChild(el("span", "glyph", running ? "▸" : "▪"));
  s.appendChild(el("span", "name", ev.name ?? "tool"));
  s.appendChild(el("span", "detail", ev.detail ?? ""));
  if (typeof ev.durationMs === "number") s.appendChild(el("span", "ms", fmtMs(ev.durationMs)));
  d.appendChild(s);

  const body: string[] = [];
  if (ev.args) body.push(`args\n${ev.args}`);
  if (typeof ev.bytes === "number") body.push(`${ev.bytes} bytes returned to the model`);
  if (ev.preview) body.push(`result\n${ev.preview}`);
  if (ev.note) body.push(ev.note);
  if (body.length) d.appendChild(el("pre", undefined, body.join("\n\n")));
  return d;
}

/** What was sealed, shown in the stream where the work will appear. */
function sealedBlock(c: { checks: { name: string; run: string }[]; notes: string[] }): HTMLElement {
  const box = el("div", "sealed");
  box.appendChild(
    el(
      "div",
      "s-head",
      `sealed ${c.checks.length} check(s) · ${c.notes.length} note(s)`,
    ),
  );
  return box;
}

function receiptLink(path: string): HTMLElement {
  // Engine paths use the host separator. A split on "/" left the whole
  // Windows path as the filename, so the link asked for a file that
  // receipts:read would refuse.
  const file = path.split(/[\\/]/).pop()!;
  const b = el("button", "receipt-link", `receipt · ${file}`);
  b.addEventListener("click", () => {
    activeReceipt = file;
    showTab("receipts");
    void openReceipt(file);
  });
  return b;
}

function proofBlock(ev: Ev): HTMLElement {
  const r = ev.result ?? {};
  const ok = r.ok === true;
  const rows: any[] = [...(r.results ?? []), ...(r.warnings ?? [])];
  // A question runs its checks advisory, so a failure among them is a note
  // about the repository rather than a verdict on the turn. Rendering that as
  // "bar met — 0 of 1 checks" was true and unreadable: it claimed a pass while
  // showing a failure, which is the shape of the dishonesty this tool exists
  // to refuse — just pointing the other way.
  const advisoryOnly = rows.length > 0 && rows.every((c) => c.advisory === true);
  const failed = rows.filter((c) => !c.ok).length;
  const passed = rows.filter((c) => c.ok).length;

  const box = el("div", `proof ${ok ? (advisoryOnly && failed ? "note" : "pass") : "fail"}`);
  // The duration is kept out of the headline string: the headline is
  // uppercased, and "1m" uppercases to "1M", which reads as a size.
  let head: string;
  let dur = "";
  if (advisoryOnly) {
    if (failed === 0) {
      head = `answered — ${passed} check(s) reported, all clear`;
      dur = fmtMs(r.durationMs ?? 0);
    } else {
      head = `answered — ${failed} of ${rows.length} check(s) already failing, before this question`;
    }
  } else if (ok) {
    head = `bar met — ${passed} of ${rows.length} checks`;
    dur = fmtMs(r.durationMs ?? 0);
  } else {
    head = `bar not met — ${passed} of ${rows.length} checks${
      ev.attempt ? ` · attempt ${ev.attempt}` : ""
    }`;
  }
  const h = el("h4", undefined, head);
  if (dur) h.appendChild(el("span", "dur", ` · ${dur}`));
  box.appendChild(h);

  for (const c of rows) {
    const row = el("div", "check");
    const label = c.ok ? "pass" : c.advisory ? "note" : "FAIL";
    const cls = c.ok ? "pass" : c.advisory ? "note" : "fail";
    row.appendChild(el("div", `verdict ${cls}`, label));
    // The name was missing entirely. Four rows reading "PASS" with a blank
    // middle told you the bar was met and refused to say by what — and on a
    // failure you could not tell which check had refused the claim, which is
    // the one fact the block exists to carry.
    row.appendChild(el("div", "cname", c.name ?? ""));
    row.appendChild(el("div", "est", c.output || c.detail || ""));
    row.appendChild(el("div", "ms muted", c.durationMs ? fmtMs(c.durationMs) : ""));
    box.appendChild(row);
  }
  return box;
}

// ── wire view ────────────────────────────────────────────────────────────────

function wire(kind: string, dir: "in" | "out", text: string): void {
  const w = $("wire");
  const f = el("div", `frame ${dir}`);
  f.appendChild(el("div", "k", kind));
  f.appendChild(el("pre", undefined, text));
  w.appendChild(f);
  // Bounded, or a long session turns the tab into a memory leak.
  while (w.childElementCount > 600) w.removeChild(w.firstChild!);
  if (($("view-follow") as HTMLInputElement).checked) {
    $("panel-view").scrollTop = $("panel-view").scrollHeight;
  }
}

$("view-clear").addEventListener("click", () => ($("wire").textContent = ""));

// ── spine ────────────────────────────────────────────────────────────────────

/**
 * The last proof, kept so the spine can paint without asking the engine
 * again. Name, pass/fail, duration — stdout lives on the receipt.
 */
let lastProof: Ev | undefined;

type SpineRow = {
  name: string;
  ok?: boolean;
  running?: boolean;
  skipped?: boolean;
  durationMs?: number;
};

function spineRows(result?: Ev): SpineRow[] {
  const defined = state?.checks ?? [];
  const results: any[] = result?.result?.results ?? [];
  const seen = new Set<string>();
  const rows: SpineRow[] = [];
  for (const r of results) {
    seen.add(r.name);
    rows.push({
      name: r.name,
      ok: r.ok === true,
      durationMs: r.durationMs,
    });
  }
  for (const c of defined) {
    if (seen.has(c.name)) continue;
    rows.push({
      name: c.name,
      running: result === undefined && busy && $("state-dot").classList.contains("proving"),
      skipped: !!results.length,
    });
  }
  return rows;
}

function paintSpine(result?: Ev): void {
  const list = $("spine-list");
  const sub = $("spine-sub");
  const rows = spineRows(result);
  if (!state?.open) {
    sub.textContent = "What \"done\" means. Stays on screen while the model works.";
    list.textContent = "";
    list.appendChild(
      el("li", "empty", "Open a workspace — checks from .molt/done.yml land here."),
    );
    return;
  }
  if (!rows.length) {
    sub.textContent = "No bar — completions here are unverified.";
    list.textContent = "";
    list.appendChild(
      el("li", "empty", "No .molt/done.yml. /init writes one. Until then, claims are unverified."),
    );
    return;
  }
  const ran = rows.filter((r) => r.ok !== undefined);
  const passed = ran.filter((r) => r.ok).length;
  sub.textContent = ran.length
    ? `${passed} of ${ran.length} last run`
    : `${rows.length} check(s) · run when it claims done`;

  // Rebuild only when the set of names changes. Verdicts update in place so
  // a proving pass does not throw away the list the eye is already on.
  const existing = [...list.querySelectorAll<HTMLElement>("li[data-name]")];
  const same =
    existing.length === rows.length &&
    existing.every((n, i) => n.dataset.name === rows[i]!.name);
  if (!same) {
    list.textContent = "";
    for (const r of rows) {
      const li = el("li");
      li.dataset.name = r.name;
      const mark = el("span", "spine-mark", "·");
      li.appendChild(mark);
      li.appendChild(el("span", "spine-nm", r.name));
      li.appendChild(el("span", "spine-ms"));
      list.appendChild(li);
    }
  }
  const items = list.querySelectorAll<HTMLElement>("li[data-name]");
  rows.forEach((r, i) => {
    const li = items[i];
    if (!li) return;
    li.className = r.running
      ? "run"
      : r.ok === true
        ? "pass"
        : r.ok === false
          ? "fail"
          : r.skipped
            ? "skip"
            : "";
    const mark = li.querySelector(".spine-mark");
    if (mark)
      mark.textContent = r.running ? "▸" : r.ok === true ? "●" : r.ok === false ? "✕" : r.skipped ? "○" : "·";
    const ms = li.querySelector(".spine-ms");
    if (ms) ms.textContent = r.durationMs ? fmtMs(r.durationMs) : "";
  });
}

function renderChecks(result?: Ev): void {
  if (result) lastProof = result;
  paintSpine(result ?? lastProof);
}

// ── receipts tab ─────────────────────────────────────────────────────────────

async function loadReceipts(): Promise<void> {
  const rows = await molt.receipts();
  const list = $("receipt-list");
  list.textContent = "";
  if (!rows.length) {
    list.appendChild(el("p", "muted pad", "No receipts yet."));
    return;
  }
  for (const r of rows) {
    const b = el("button") as HTMLButtonElement;
    b.appendChild(el("div", undefined, `receipt ${String(r.n).padStart(4, "0")}`));
    b.appendChild(el("div", `vd ${r.verdict}`, r.verdict));
    if (r.file === activeReceipt) b.classList.add("active");
    b.addEventListener("click", () => void openReceipt(r.file));
    list.appendChild(b);
  }
  if (!activeReceipt && rows[0]) void openReceipt(rows[0].file);
}

async function openReceipt(file: string): Promise<void> {
  activeReceipt = file;
  const md = await molt.receipt(file);
  const doc = $("receipt-doc");
  doc.textContent = "";
  if (md === null) {
    doc.appendChild(el("p", "muted pad", "That receipt is no longer on disk."));
    return;
  }
  renderMarkdown(md, doc);
  for (const b of $("receipt-list").querySelectorAll("button")) b.classList.remove("active");
  void loadReceipts();
}

// ── verify the evidence chain ─────────────────────────────────────────────────

/**
 * Run the full integrity check on the open workspace: the journals' own
 * chains plus the project-level ledger binding journals, receipts and exuviae
 * together. Show the verdict, any drift, and the root of trust. This is the
 * window's answer to `molt verify` — the same check, on this surface.
 */
async function runVerify(): Promise<void> {
  const out = $("verify-result");
  const ev = await molt.verify();
  out.classList.remove("hidden");

  if (ev === null) {
    out.textContent = "No workspace is open — open one to verify its evidence chain.";
    out.className = "verify warn";
    return;
  }

  if (!ev.established) {
    // No records, nothing bound. "Intact" here would be a green light for a
    // chain that covers none of the evidence sitting beside it.
    out.className = "verify warn";
    out.textContent = "";
    out.appendChild(el("div", undefined, "No evidence chain yet — nothing has been bound."));
    out.appendChild(
      el(
        "div",
        undefined,
        ev.unbound.length
          ? `${ev.unbound.length} receipt(s) and shed(s) here predate the ledger. A root of trust appears once a session binds its first receipt.`
          : "A root of trust appears once a session binds its first receipt.",
      ),
    );
    return;
  }

  const badLogs = (ev.journals ?? []).filter((j) => !j.ok);
  const head = el(
    "div",
    undefined,
    ev.ok
      ? `Evidence chain intact · ${ev.records} record(s) binding journal, receipts and exuviae · ` +
        `${(ev.journals ?? []).length} session log(s) recompute.`
      : badLogs.length
        ? `Evidence chain BROKEN · ${badLogs.length} session log(s) do not recompute.`
        : `Evidence chain ${ev.brokenAt !== null ? "BROKEN" : "DRIFTED"} at record ${ev.brokenAt ?? "—"}.`,
  );
  // A stale verdict's colour must not outlive it.
  out.className = "verify";
  out.textContent = "";
  out.appendChild(head);
  if (ev.root) out.appendChild(el("div", "verify-root", `root of trust: ${ev.root}`));

  if (ev.reason) {
    out.appendChild(el("div", undefined, ev.reason));
  }
  for (const d of ev.drift) {
    out.appendChild(el("div", undefined, `${d.kind} ${d.file} no longer matches its bound hash (${d.bound})`));
  }
  for (const j of badLogs) {
    out.appendChild(el("div", undefined, `journal ${j.file}: ${j.reason ?? "chain broken"}`));
  }
  // What the chain does not reach, said plainly beside what it does.
  if (ev.unbound.length) {
    out.appendChild(
      el("div", undefined, `${ev.unbound.length} artifact(s) on disk are not bound by this chain.`),
    );
  }
  out.classList.add(ev.ok ? "ok" : "fail");
}

// ── journal tab ──────────────────────────────────────────────────────────────

let journalRows: Record<string, unknown>[] = [];

async function loadJournal(): Promise<void> {
  journalRows = await molt.journal();
  drawJournal();
}

function drawJournal(): void {
  const q = ($("log-filter") as HTMLInputElement).value.trim().toLowerCase();
  const box = $("log");
  box.textContent = "";
  const rows = journalRows.filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q));
  if (!rows.length) {
    box.appendChild(el("p", "muted", journalRows.length ? "Nothing matches." : "No entries yet."));
    return;
  }
  const shown = newest(rows, JOURNAL_RENDER_CAP);
  if (shown.length < rows.length) {
    box.appendChild(
      el(
        "p",
        "muted",
        `showing the newest ${shown.length} of ${rows.length} matching entries — the rest is still on disk`,
      ),
    );
  }
  for (const r of shown) {
    const { kind, at, ...rest } = r as any;
    const row = el("div", "entry");
    row.appendChild(el("div", "kind", String(kind ?? "?")));
    row.appendChild(el("div", "body", JSON.stringify(rest)));
    box.appendChild(row);
  }
}

$("log-filter").addEventListener("input", drawJournal);
$("log-refresh").addEventListener("click", () => void loadJournal());
$("receipt-verify").addEventListener("click", () => void runVerify());

// ── engine events ────────────────────────────────────────────────────────────

function setState(kind: "idle" | "busy" | "proving" | "ok" | "fail", text: string): void {
  $("state-dot").className = `dot ${kind === "idle" ? "" : kind}`.trim();
  $("state-text").textContent = text;
  if (kind === "idle") paintSpine(lastProof);
  updateJump();
}

molt.onEvent((ev) => {
  switch (ev.kind) {
    case "delta":
      // The first token is the answer to "is it alive?", so the waiting row
      // goes as soon as one arrives.
      stopActivity();
      delta(ev.text);
      break;

    case "message_end":
      endMessage();
      break;

    case "tool_pending":
      // The model has begun emitting a call, several hundred milliseconds
      // before the row for it can exist. Saying so here is the difference
      // between "it is talking" and "it is about to act", at exactly the
      // moment someone is deciding whether to press Stop.
      setPhase(`calling ${ev.name}`);
      bumpActivity();
      break;

    case "stream_reset": {
      // The attempt that produced this text is being abandoned and replayed.
      // Leaving it on screen would show the same sentence twice.
      if (openSaid) openSaid.remove();
      openSaid = null;
      setPhase(`retrying — ${ev.why}`.slice(0, 80));
      bumpActivity();
      break;
    }

    case "assistant_text":
      // `streamed` means the deltas already carried this text. Rendering it
      // again is how the CLI printed every final answer twice.
      if (!ev.streamed) {
        endMessage();
        say("molt", ev.text);
      }
      endMessage();
      break;

    case "tool_start": {
      endMessage();
      const row = toolRow(ev, true);
      runningTools.set(`${ev.name}:${ev.detail}`, row);
      append(row);
      setState("busy", ev.name);
      // A long bash or a wide grep is exactly when the screen looks stuck.
      setPhase(`${ev.name} ${ev.detail}`.trim());
      bumpActivity();
      break;
    }

    case "tool": {
      const key = `${ev.name}:${ev.detail}`;
      const open = runningTools.get(key);
      const fresh = toolRow(ev, false);
      if (open) {
        open.replaceWith(fresh);
        runningTools.delete(key);
      } else {
        append(fresh);
      }
      wire(
        `${ev.name} · ${ev.bytes ?? 0}B`,
        "in",
        [ev.args ? `args ${ev.args}` : "", ev.preview ?? ""].filter(Boolean).join("\n"),
      );
      setPhase("thinking");
      bumpActivity();
      break;
    }

    case "job_start":
      setState("busy", "thinking");
      startActivity("thinking");
      break;

    // The request as the engine states it, before the answer exists. This
    // frame used to be faked from job_start, which carries no step and no
    // message count, so every session's wire view read "step · ? messages"
    // beside a journal that had both numbers — and the real request events
    // were never rendered at all.
    case "request":
      wire(
        "request",
        "out",
        `step ${ev.step + 1} · ${ev.messages} messages · ~${ev.estTokens} tokens → ${ev.model}` +
          (ev.stream ? " · streaming" : ""),
      );
      break;

    case "usage":
      wire(
        "usage",
        "in",
        `prompt ${ev.promptTokens} (cached ${ev.cachedTokens}) · completion ${ev.completionTokens}`,
      );
      void refreshStats();
      break;

    case "proof_start":
      setState("proving", `proving · ${ev.checks} checks`);
      // The longest silence in a turn: the suite runs, and until now nothing
      // said which check was taking the time.
      setPhase(`proving · ${ev.checks} check(s)`);
      bumpActivity();
      paintSpine();
      break;

    case "proof_result":
    case "proof_refused":
    case "proof_exhausted": {
      endMessage();
      stopActivity();
      append(proofBlock(ev));
      if (pendingReceipt) {
        append(receiptLink(pendingReceipt));
        pendingReceipt = null;
      }
      renderChecks(ev);
      const ok = ev.result?.ok === true;
      setState(ok ? "ok" : "fail", ok ? "bar met" : "bar not met");
      break;
    }

    case "receipt": {
      pendingReceipt = String(ev.path);
      badge("receipts", "new");
      break;
    }

    case "shed":
      say(
        "shed",
        `archived ${ev.dropped} message(s) · ${fmtInt(ev.before)} → ${fmtInt(ev.after)} tokens`,
        "info",
      );
      break;

    case "info":
      endMessage();
      say("", ev.text, "info");
      break;

    case "error":
      endMessage();
      stopActivity();
      say("error", ev.text, "error");
      setState("fail", "error");
      break;

    case "cancelled":
      endMessage();
      stopActivity();
      say(
        "",
        ev.filesWritten?.length
          ? `cancelled — these files were already written: ${ev.filesWritten.join(", ")}`
          : "cancelled",
        "info",
      );
      break;
  }
});

/**
 * What opening something over the page costs you.
 *
 * Focus moves in and comes back where it was, and Escape closes it. Neither
 * was true of either dialog: the picker could only be dismissed by finding its
 * Close button with the mouse, and the permission prompt trapped nothing,
 * focused nothing, and left Tab wandering into the composer behind it.
 */
let modalReturn: HTMLElement | null = null;

function openModal(id: string, focusId?: string): void {
  modalReturn = document.activeElement as HTMLElement | null;
  $(id).classList.remove("hidden");
  if (focusId) $(focusId).focus();
}

function closeModal(id: string): void {
  $(id).classList.add("hidden");
  modalReturn?.focus?.();
  modalReturn = null;
}

document.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  const chord = state?.platform === "darwin" ? e.metaKey : e.ctrlKey;
  if (chord && !e.altKey && $("confirm").classList.contains("hidden")) {
    const n = e.code.startsWith("Digit") ? Number(e.code.slice(5)) : 0;
    if (n >= 1 && n <= TABS.length) {
      e.preventDefault();
      showTab(TABS[n - 1]!);
      return;
    }
    if (e.key === "k" || e.key === "K") {
      e.preventDefault();
      showTab("session");
      const box = $("prompt") as HTMLTextAreaElement;
      if (!box.value.startsWith("/")) box.value = "/";
      box.focus();
      autogrow();
      refreshPalette();
      return;
    }
    if (e.key === ".") {
      e.preventDefault();
      showTab("session");
      jumpLive();
      return;
    }
    if (e.key === "b" || e.key === "B") {
      e.preventDefault();
      setSpineOpen(!spineOpen);
      return;
    }
  }
  if (e.key !== "Escape") return;
  // Innermost surface first, one per press.
  if (!$("confirm").classList.contains("hidden")) {
    // Escape is an answer here, and the only answer it can safely mean.
    e.preventDefault();
    ($("confirm-no") as HTMLButtonElement).click();
    return;
  }
  if (!$("picker").classList.contains("hidden")) {
    e.preventDefault();
    closeModal("picker");
    return;
  }
  if (!$("interview-panel").classList.contains("hidden")) {
    e.preventDefault();
    closeInterview();
    return;
  }
  if (!$("criteria").classList.contains("hidden")) {
    e.preventDefault();
    $("criteria").classList.add("hidden");
  }
});

molt.onConfirm((req) => {
  $("confirm-title").textContent = req.name;
  $("confirm-detail").textContent = req.detail;
  // Refuse takes focus, not Allow. A permission prompt appears without being
  // asked for, often while the pointer is somewhere else entirely, and the
  // key someone is most likely to hit next must not grant anything.
  openModal("confirm", "confirm-no");
  const answer = (ok: boolean) => () => {
    molt.answerConfirm(req.id, ok);
    closeModal("confirm");
  };
  const yes = $("confirm-yes");
  const no = $("confirm-no");
  const y = answer(true);
  const n = answer(false);
  yes.onclick = y;
  no.onclick = n;
});

molt.onIdle(() => {
  stopActivity();
  busy = false;
  hintedBusy = false;
  $("send").classList.remove("hidden");
  $("stop").classList.add("hidden");
  // Stop (and the turn ending any other way) resolves a pending confirm to
  // false on the main side. The dialog is only hidden by its own buttons,
  // so without this a cancelled permission prompt stays on screen and
  // answers nothing.
  if (!$("confirm").classList.contains("hidden")) closeModal("confirm");
  if (!$("state-dot").classList.contains("ok") && !$("state-dot").classList.contains("fail"))
    setState("idle", "idle");
  updateJump();
  void refreshStats();
});

// ── composer ─────────────────────────────────────────────────────────────────

const promptBox = $("prompt") as HTMLTextAreaElement;

function autogrow(): void {
  promptBox.style.height = "auto";
  promptBox.style.height = `${Math.min(promptBox.scrollHeight, 200)}px`;
}
promptBox.addEventListener("input", () => {
  autogrow();
  refreshPalette();
});

promptBox.addEventListener("keydown", (e) => {
  // While the palette is still choosing, the arrow keys belong to it, not to
  // the caret — but once an argument is being typed the line is yours again.
  if (paletteChoosing()) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      paletteIndex = (paletteIndex + d + paletteMatches.length) % paletteMatches.length;
      drawPalette();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const c = paletteMatches[paletteIndex];
      if (c) {
        promptBox.value = c.args ? `${c.name} ` : c.name;
        refreshPalette();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Or the same press closes the palette and then the criteria panel.
      e.stopPropagation();
      closePalette();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void runPaletteChoice();
      return;
    }
  }
  // Enter sends; shift+Enter is a newline. The opposite of a chat box would be
  // wrong here — a task is usually one line and sending it should not need a
  // second gesture.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});

/** Ask-only is `?` at the start of a line, or `/ask`. Not a checkbox. */
let askNext = false;
const ask0 = (): boolean => askNext;

/** Reset each time the engine goes idle, so the hint is once per turn. */
let hintedBusy = false;

/**
 * A task the first Run drafted for but did not start.
 *
 * Held here rather than in the composer, so a held turn does not look like a
 * refused one. Cleared the moment the turn actually starts.
 */
let pendingTask: string | null = null;

async function send(): Promise<void> {
  const { text, resuming } = taskForRun(promptBox.value, pendingTask);
  if (!text) return;
  // A line beginning with / is a command. Sending it to the model instead is
  // how "/budget 40000" becomes a request to write a budgeting feature.
  if (text.startsWith("/")) {
    closePalette();
    promptBox.value = "";
    autogrow();
    const sp = text.indexOf(" ");
    const name = sp === -1 ? text : text.slice(0, sp);
    const arg = sp === -1 ? "" : text.slice(sp + 1).trim();
    say("you", text, "user");
    await runCommand(name, arg);
    return;
  }
  // A command is not a turn.
  //
  // The composer refused everything while one was running, which took the whole
  // palette away at exactly the moment most of it is worth having: /wire,
  // /stats, /receipts and `/shed --explain` all answer questions you only think
  // to ask while something is in flight. Worse, Enter did nothing at all and
  // said nothing about why, which reads as a broken key rather than a refusal.
  // Only a prompt for the model has to wait for the model.
  if (busy) {
    if (!hintedBusy) {
      hintedBusy = true;
      say(
        "",
        "a turn is running — press Stop to interrupt it, or send a /command " +
          "(/shed --explain, /stats, /wire) which runs alongside it",
        "info",
      );
    }
    return;
  }

  // "? question" is the terminal's shorthand for ask-only.
  if (text.startsWith("?")) {
    askNext = true;
    promptBox.value = text.slice(1).trim();
    return void send();
  }
  if (!state?.open) {
    showTab("settings");
    $("set-status").textContent = "Open a workspace first.";
    return;
  }
  const ask = ask0();
  const auto = ($("ck-auto") as HTMLInputElement).checked;
  const hadRows = rows.length > 0;

  // Run while questions are still up means "skip the rest", not "start
  // coding". Spec-first does not let the model work on a guess you have
  // not seen.
  if (!$("interview-panel").classList.contains("hidden")) {
    await interviewRound(true);
    return;
  }

  // Spec first: the first Run writes a spec and holds. The second seals
  // what is still in the panel and starts work. Ask-only, a panel you
  // already filled, and a resume after that hold skip it.
  if (
    holdAfterAutoDraft({
      auto,
      hadRows,
      ask,
      resuming,
    })
  ) {
    busy = true;
    $("send").classList.add("hidden");
    $("stop").classList.remove("hidden");
    setState("busy", "spec");
    startActivity("writing a spec");
    pendingTask = text;
    promptBox.value = "";
    autogrow();
    if (!resuming) say("you", text, "user");
    await startInterview(text);
    const stillAsking = !$("interview-panel").classList.contains("hidden");
    $("criteria").classList.remove("hidden");
    drawCriteria();
    $("ck-state").textContent = stillAsking
      ? "answer, then Run again — or skip remaining"
      : "review the spec, then Run again to start";
    if (!stillAsking) {
      say("", "spec first — review it, then Run to start the turn", "info");
    }
    stopActivity();
    busy = false;
    $("send").classList.remove("hidden");
    $("stop").classList.add("hidden");
    setState("idle", stillAsking ? "interview" : "review spec");
    return;
  }

  promptBox.value = "";
  autogrow();
  // Already on screen if this Run is resuming a held one.
  if (!resuming) say("you", text, "user");
  pendingTask = null;
  busy = true;
  $("send").classList.add("hidden");
  $("stop").classList.remove("hidden");
  setState("busy", "thinking");
  // Before the first event: the request is in flight and the window must say
  // so, or the gap between Run and the first token reads as a dead click.
  startActivity(ask ? "asking" : "thinking");

  const criteria = criteriaPayload();
  if (criteria.checks.length || criteria.notes.length) {
    append(sealedBlock(criteria));
    bumpActivity();
  }
  const r = await molt.run(text, ask, criteria);
  askNext = false;
  if (!r.ok && r.error) say("error", r.error, "error");
  // One task, one set. Carrying them into the next turn would quietly apply
  // yesterday's criteria to today's work.
  rows = [];
  drawCriteria();
  $("criteria").classList.add("hidden");
}

$("send").addEventListener("click", () => void send());
$("stop").addEventListener("click", () => {
  molt.cancel();
  setState("idle", "cancelling");
});

// ── autonomy ─────────────────────────────────────────────────────────────────

/**
 * How much molt may do without asking, next to the thing it modifies.
 *
 * A segmented control rather than a dropdown, because all three options and
 * the distance between them should be visible at once — this is the setting
 * that decides whether a command runs on your machine unattended, and a
 * closed dropdown hides which way it is currently pointing.
 *
 * It sits under "ask only" in the composer for the same reason: it is a
 * property of the turn you are about to send, not a preference filed away in
 * Settings where you would never look at it again.
 */
function renderAutonomy(): void {
  const box = $("autonomy");
  box.textContent = "";
  if (!state) return;
  const at = state.autonomyLevels.findIndex((l) => l.level === state!.autonomy);
  for (const [i, { level, means }] of state.autonomyLevels.entries()) {
    const b = el("button", `au${i <= at ? " lit" : ""}`) as HTMLButtonElement;
    b.dataset.i = String(i);
    b.type = "button";
    // The engine's own words for what this level permits — the tooltip is the
    // only place the full sentence fits now that the buttons are 6px wide.
    b.title = `${level} — ${means}`;
    b.setAttribute("aria-label", `${level}: ${means}`);
    b.textContent = level;
    // Hovering previews the level you would set, filling to that bar.
    b.addEventListener("mouseenter", () => {
      for (const [j, other] of [...box.children].entries())
        other.classList.toggle("hot", j <= i);
    });
    b.addEventListener("click", () => void chooseAutonomy(level, means));
    box.appendChild(b);
  }
  $("au-name").textContent = state.autonomy;
  $("au-name").title = state.autonomyLevels[at]?.means ?? "";
}

async function chooseAutonomy(level: string, _means: string): Promise<void> {
  const r = await molt.setAutonomy(level);
  if (!r.ok) {
    say("error", r.error ?? "could not change autonomy", "error");
    return;
  }
  state = r.state!;
  renderAutonomy();
  localStorage.setItem("molt.autonomy", level);
}

// ── acceptance criteria ──────────────────────────────────────────────────────

/**
 * What "done" means for this task, on top of what it means for the project.
 *
 * Kept out of the way until asked for. The value of per-task verification is
 * real and the friction is what kills it, so there is one button to open the
 * panel, one to have the model draft from what you typed, and nothing to fill
 * in before you can press Run.
 *
 * A row is either a check or a note and the two never look alike. A check is a
 * command that runs with the bar and can refuse the claim; a note is a sentence
 * that lands on the receipt as stated intent and is never reported as verified.
 * Conflating them would make the receipt lie in the one direction it cannot
 * afford, so they are different colours, differently labelled, and the label is
 * a button — clicking it converts the row, because most people discover which
 * one they meant while typing it.
 */
type Row = { kind: "check" | "note"; name: string; text: string };
let rows: Row[] = [];

function drawCriteria(): void {
  const box = $("ck-rows");
  box.textContent = "";
  if (rows.length === 0) {
    box.appendChild(
      el("div", "ck-empty", "None. The project's bar still applies — this adds to it."),
    );
  }
  for (const [i, r] of rows.entries()) {
    const row = el("div", `ck-row ${r.kind}`);

    const kind = el("button", "ck-kind", r.kind === "check" ? "check" : "note") as HTMLButtonElement;
    kind.type = "button";
    kind.title =
      r.kind === "check"
        ? "Runs with the bar and can refuse the claim. Click to make it a note."
        : "Recorded on the receipt, never reported as verified. Click to make it a check.";
    kind.addEventListener("click", () => {
      r.kind = r.kind === "check" ? "note" : "check";
      drawCriteria();
    });
    row.appendChild(kind);

    if (r.kind === "check") {
      const name = el("input", "ck-name") as HTMLInputElement;
      // Explicit, because the stylesheet selects on input[type="text"] and an
      // input with no attribute does not match it — these rows rendered as
      // white boxes with black text in the middle of a dark window.
      name.type = "text";
      name.value = r.name;
      name.placeholder = "name";
      name.spellcheck = false;
      name.addEventListener("input", () => (r.name = name.value));
      row.appendChild(name);
    }

    const text = el("input", "ck-text") as HTMLInputElement;
    text.type = "text";
    text.value = r.text;
    text.placeholder = r.kind === "check" ? "shell command that must exit 0" : "what should be true";
    text.spellcheck = false;
    text.addEventListener("input", () => (r.text = text.value));
    row.appendChild(text);

    const del = el("button", "ck-del", "✕") as HTMLButtonElement;
    del.type = "button";
    del.title = "remove";
    del.addEventListener("click", () => {
      rows.splice(i, 1);
      drawCriteria();
    });
    row.appendChild(del);
    box.appendChild(row);
  }
  updateCriteriaState();
}

function updateCriteriaState(): void {
  const c = rows.filter((r) => r.kind === "check" && r.text.trim()).length;
  const n = rows.filter((r) => r.kind === "note" && r.text.trim()).length;
  $("ck-state").textContent = c || n ? `${c} check(s), ${n} note(s)` : "";
}

/** What gets sent, cleaned of half-typed rows. */
function criteriaPayload(): { checks: { name: string; run: string }[]; notes: string[] } {
  const checks = rows
    .filter((r) => r.kind === "check" && r.text.trim())
    .map((r, i) => ({ name: r.name.trim() || `check-${i + 1}`, run: r.text.trim() }));
  const notes = rows.filter((r) => r.kind === "note" && r.text.trim()).map((r) => r.text.trim());
  return { checks, notes };
}

$("ck-hide").addEventListener("click", () => $("criteria").classList.add("hidden"));
$("ck-add").addEventListener("click", () => {
  rows.push({ kind: "check", name: "", text: "" });
  drawCriteria();
});
$("ck-add-note").addEventListener("click", () => {
  rows.push({ kind: "note", name: "", text: "" });
  drawCriteria();
});

/**
 * Draft criteria from the task text.
 *
 * Automatic by default, but `send` holds after a non-empty draft so a person
 * sees the commands before they run. A drafted check is a process, not a
 * stricter boolean — `true` does not weaken the project bar, and `rm -rf`
 * still runs. The project bar is the one that must never come from a prompt,
 * because that one can be weakened, and a model that sets its own passing
 * conditions always passes.
 */
async function draftInto(task: string, quiet = false): Promise<void> {
  if (!task) {
    if (!quiet) $("ck-state").textContent = "type the task first — the draft is made from it";
    return;
  }
  $("ck-state").textContent = "asking the model what would prove this…";
  const r = await molt.draftCriteria(task);
  if (!r.ok) {
    // Never blocks the turn. A drafting failure means no extra criteria, not
    // no work — the project's bar still applies.
    $("ck-state").textContent = r.error;
    return;
  }
  // Appended, not replacing: anything already typed was written by a person
  // and outranks a suggestion.
  for (const c of r.draft.checks) rows.push({ kind: "check", name: c.name, text: c.run });
  for (const n of r.draft.notes) rows.push({ kind: "note", name: "", text: n });
  drawCriteria();
  if (!r.draft.checks.length && !r.draft.notes.length) {
    $("ck-state").textContent = "the model had nothing to add beyond the project's bar";
  }
}

$("ck-draft").addEventListener("click", () => void draftInto(promptBox.value.trim()));

// ── slash commands ───────────────────────────────────────────────────────────

/**
 * The palette, as the terminal has it.
 *
 * The matching rules are `src/commands.ts`, imported rather than reimplemented
 * — exact name, then prefix, then subsequence, then a word in the summary, ties
 * breaking toward the shorter name. That file exists because a palette that
 * surfaces the wrong command teaches people to stop reading it, and having two
 * implementations of those rules is the surest way to get two behaviours.
 *
 * Bundled into the renderer, where it is pure logic over a list of names. The
 * commands that need an engine are executed in the main process; the ones that
 * are only about this window are handled here.
 */
let paletteMatches: AppState["commands"] = [];
let paletteIndex = 0;

function drawPalette(): void {
  const box = $("palette-rows");
  box.textContent = "";
  for (const [i, c] of paletteMatches.entries()) {
    const b = el("button", i === paletteIndex ? "on" : "") as HTMLButtonElement;
    b.appendChild(el("span", "cmd", c.args ? `${c.name} ${c.args}` : c.name));
    b.appendChild(el("span", "sum", c.summary));
    b.addEventListener("click", () => {
      paletteIndex = i;
      void runPaletteChoice();
    });
    box.appendChild(b);
  }
  $("palette").classList.toggle("hidden", paletteMatches.length === 0);
  box.querySelector("button.on")?.scrollIntoView({ block: "nearest" });
}

function refreshPalette(): void {
  // The palette belongs to the prompt. On another tab there is no prompt to
  // run a command from, so offering one is a menu that cannot be used.
  if ($("composer").classList.contains("hidden")) {
    closePalette();
    return;
  }
  paletteMatches = matchCommands(promptBox.value, state?.commands ?? []);
  if (paletteIndex >= paletteMatches.length) paletteIndex = 0;
  drawPalette();
}

/**
 * Is the palette still a menu, or already just a label?
 *
 * The shared matcher keeps returning the settled command once an argument is
 * being typed — deliberately, so the row stays on screen as a reminder of which
 * command you are inside and what it takes. That makes it a hint, not a
 * chooser, and the keyboard has to know the difference: with `/model grok-4.6`
 * typed, Enter must send the line. Routed to the palette it would have run
 * "needs an argument, so complete rather than run" and replaced everything
 * after `/model ` with nothing.
 */
function paletteChoosing(): boolean {
  return paletteMatches.length > 0 && !/\s/.test(promptBox.value.trim());
}

function closePalette(): void {
  paletteMatches = [];
  paletteIndex = 0;
  $("palette").classList.add("hidden");
}

/** Enter on a highlighted row: complete it if it takes an argument, else run. */
async function runPaletteChoice(): Promise<void> {
  const c = paletteMatches[paletteIndex];
  if (!c) return;
  // Clicking the hint row for a command you have already begun arguing with
  // means "yes, that one" — not "throw away what I typed".
  if (!paletteChoosing()) {
    closePalette();
    promptBox.focus();
    return;
  }
  closePalette();
  if (c.args) {
    // Needs an argument, so complete rather than run — firing /regrow with no
    // pattern just to print its usage line wastes the keystroke.
    promptBox.value = `${c.name} `;
    promptBox.focus();
    return;
  }
  promptBox.value = "";
  await runCommand(c.name, "");
}

/**
 * Run one command, wherever it belongs.
 *
 * Window commands are handled here. Everything else goes to the main process,
 * which answers `unhandled` for a name it does not know — so an unknown command
 * is reported once, by the side that knows it is unknown, rather than silently
 * doing nothing.
 */
async function runCommand(name: string, arg: string): Promise<void> {
  switch (name) {
    case "/help":
      for (const c of state?.commands ?? [])
        say("", `  ${(c.args ? `${c.name} ${c.args}` : c.name).padEnd(30)}${c.summary}`, "info");
      return;
    case "/exit":
    case "/quit":
      window.close();
      return;
    case "/molt": {
      const names = state?.themes ?? [];
      const sel = $("set-theme") as HTMLSelectElement;
      const next = names[(names.indexOf(sel.value) + 1) % names.length]!;
      sel.value = next;
      sel.dispatchEvent(new Event("change"));
      say("", `theme: ${next}`, "info");
      return;
    }
    case "/model":
      if (arg) {
        await chooseModel(arg, state?.baseUrl ?? "");
        return;
      }
      await openPicker();
      return;
    case "/autonomy":
    case "/auto": {
      const lv = state?.autonomyLevels.find((l) => l.level === arg);
      if (!arg || !lv) {
        say("", `autonomy: ${state?.autonomy} — click low/medium/high beside the prompt`, "info");
        return;
      }
      await chooseAutonomy(lv.level, lv.means);
      return;
    }
    case "/ask":
    case "/q":
      askNext = true;
      if (arg) {
        promptBox.value = arg;
        await send();
      } else {
        say("", "ask only is on — the next turn is a question", "info");
      }
      return;
    case "/interview":
    case "/spec":
      await startInterview(arg);
      return;
    case "/verbose":
    case "/detail":
      showTab("view");
      return;
    case "/receipts":
      showTab("receipts");
      return;
    case "/login":
      showTab("settings");
      ($("set-key") as HTMLInputElement).focus();
      if (arg) ($("set-provider") as HTMLSelectElement).value = arg;
      return;
    case "/endpoint":
      showTab("settings");
      if (arg) ($("set-url") as HTMLInputElement).value = arg;
      ($("set-url") as HTMLInputElement).focus();
      return;
    case "/clear": {
      const r = await molt.reset();
      if (!r.ok) {
        say("error", r.error ?? "could not reset", "error");
        return;
      }
      stream().textContent = "";
      // A held spec-first task, a drafted panel, and an interview still on
      // screen are yesterday's work. Resetting the engine and leaving them
      // would start the next Run against a task nobody can see.
      pendingTask = null;
      pendingBarAdds = [];
      rows = [];
      drawCriteria();
      $("criteria").classList.add("hidden");
      $("ck-seal").classList.add("hidden");
      closeInterview();
      lastProof = undefined;
      askNext = false;
      state = r.state ?? state;
      applyState();
      say("", "session reset — context cleared, the record on disk is untouched", "info");
      return;
    }
    case "/init": {
      const r = await molt.initBar();
      if (r.kind === "error") say("error", r.text, "error");
      else if (r.kind === "info") {
        say("", r.text, "info");
        if (r.state) {
          state = r.state;
          applyState();
        }
      }
      return;
    }
  }

  const out = await molt.command(name, arg);
  switch (out.kind) {
    case "info":
      say("", out.text, "info");
      if (name === "/bar") setSpineOpen(true);
      if (name === "/wire") showTab("view");
      return;
    case "error":
      say("error", out.text, "error");
      return;
    case "bar":
      append(proofBlock({ kind: "proof_result", result: out.result }));
      renderChecks({ kind: "proof_result", result: out.result });
      setSpineOpen(true);
      return;
    case "unhandled":
      say("error", `unknown command: ${name} — /help lists them`, "error");
      return;
  }
}

// ── settings ─────────────────────────────────────────────────────────────────

$("set-pick").addEventListener("click", async () => {
  const dir = await molt.pickWorkspace();
  if (dir) ($("set-cwd") as HTMLInputElement).value = dir;
});

$("set-savekey").addEventListener("click", async () => {
  const key = ($("set-key") as HTMLInputElement).value.trim();
  const provider = ($("set-provider") as HTMLSelectElement).value;
  if (!key) {
    $("set-status").textContent = "No key entered.";
    return;
  }
  const ok = await molt.saveKey(provider, key);
  ($("set-key") as HTMLInputElement).value = "";
  $("set-status").textContent = ok
    ? `Stored for ${provider} in ~/.config/molt/auth.json (0600).`
    : "Could not write the key file.";
});

$("set-open").addEventListener("click", async () => {
  const cwd = ($("set-cwd") as HTMLInputElement).value.trim();
  const model = ($("set-model") as HTMLInputElement).value.trim();
  const baseUrl = ($("set-url") as HTMLInputElement).value.trim();
  if (!cwd || !model || !baseUrl) {
    $("set-status").textContent = "Workspace, model and endpoint are all required.";
    return;
  }
  const key = ($("set-key") as HTMLInputElement).value.trim() || undefined;
  const r = await molt.openSession({ cwd, model, baseUrl, apiKey: key });
  if (!r.ok) {
    $("set-status").textContent = r.error ?? "Could not open.";
    return;
  }
  await molt.saveEndpoint(baseUrl, model);
  // A leftover proof from the previous workspace would light the spine for
  // checks this project does not have.
  lastProof = undefined;
  state = r.state!;
  applyState();
  $("set-status").textContent = "Open.";
  showTab("session");
});

$("set-theme").addEventListener("change", async () => {
  const name = ($("set-theme") as HTMLSelectElement).value;
  const t = await molt.theme(name);
  for (const [k, v] of Object.entries(t)) {
    // bgRaised -> --bg-raised, so the surfaces land on the properties the
    // stylesheet actually reads rather than on ones nothing consults.
    const prop = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    document.documentElement.style.setProperty(`--${prop}`, v);
  }
  localStorage.setItem("molt.theme", name);
});

// ── model picker ─────────────────────────────────────────────────────────────

/**
 * Every model you could pick, from every endpoint you hold a key for.
 *
 * This is `/model`. The desktop shipped without it — Settings had a free-text
 * field seeded from the last endpoint, so the only reachable model was the one
 * used last and changing it meant knowing an id by heart. Opened from the
 * model name in the title bar, which is where you are already looking when you
 * want to change it.
 *
 * Cached for the session: asking four endpoints costs four round trips, and
 * the list does not change between two glances at it.
 */
let sourceCache: ModelSource[] | null = null;

async function sources(force = false): Promise<ModelSource[]> {
  if (sourceCache && !force) return sourceCache;
  const url = ($("set-url") as HTMLInputElement).value.trim() || state?.baseUrl || "";
  const key = ($("set-key") as HTMLInputElement).value.trim() || undefined;
  sourceCache = await molt.listModels(url ? { url, key } : undefined);
  return sourceCache;
}

async function openPicker(): Promise<void> {
  openModal("picker");
  $("picker-sub").textContent = "Asking every endpoint you hold a key for…";
  $("picker-list").textContent = "";
  await drawPicker(await sources());
  // Focus lands on the list once it exists, so the model you are switching to
  // is one Tab away rather than four.
  const first =
    $("picker-list").querySelector<HTMLElement>("button.current") ??
    $("picker-list").querySelector<HTMLElement>("button");
  (first ?? $("picker-close")).focus();
}

async function drawPicker(list: ModelSource[]): Promise<void> {
  const box = $("picker-list");
  box.textContent = "";
  const total = list.reduce((n, s) => n + s.ids.length, 0);
  $("picker-sub").textContent = total
    ? `${total} model(s) across ${list.length} endpoint(s). Switching keeps the conversation.`
    : "No endpoint answered. Store a key in Settings, or point at a server you run.";

  for (const src of list) {
    const grp = el("div", "grp");
    grp.appendChild(el("span", undefined, src.name));
    grp.appendChild(el("span", "host", src.url));
    // A refusal is a thing to show, with its reason — not a provider that
    // silently vanished from the list.
    if (src.local) grp.appendChild(el("span", "tag-local", "local"));
    if (!src.ok && src.ids.length) grp.appendChild(el("span", "err", reasonFor(src)));
    if (src.remembered) {
      // Only a server this window remembered can be forgotten; a preset is
      // not the user's to remove.
      const x = el("button", "forget", "forget") as HTMLButtonElement;
      x.title = `stop asking ${src.url} for models`;
      x.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await molt.forgetEndpoint(src.url);
        await drawPicker(await sources(true));
      });
      grp.appendChild(x);
    }
    box.appendChild(grp);

    if (!src.ids.length) {
      box.appendChild(el("div", "empty-grp", reasonFor(src)));
      continue;
    }
    for (const id of src.ids) {
      const b = el("button", undefined, id) as HTMLButtonElement;
      if (id === state?.model && src.url === state?.baseUrl) b.classList.add("current");
      b.addEventListener("click", () => void chooseModel(id, src.url));
      box.appendChild(b);
    }
  }
}

async function chooseModel(id: string, url: string): Promise<void> {
  // Before a workspace is open there is no engine to tell; the choice is
  // staged in Settings and applied when it opens.
  if (!state?.open) {
    ($("set-model") as HTMLInputElement).value = id;
    ($("set-url") as HTMLInputElement).value = url;
    syncModelPick(id);
    closeModal("picker");
    $("set-status").textContent = `${id} selected — open a workspace to use it.`;
    showTab("settings");
    return;
  }
  const key = ($("set-key") as HTMLInputElement).value.trim() || undefined;
  const r = await molt.setModel({ model: id, baseUrl: url, apiKey: key });
  if (!r.ok) {
    $("picker-sub").textContent = r.error ?? "Could not switch model.";
    return;
  }
  state = r.state!;
  applyState();
  closeModal("picker");
  say("", `model is now ${id}`, "info");
}

$("crumb-model").addEventListener("click", () => void openPicker());
$("picker-close").addEventListener("click", () => closeModal("picker"));
// The backdrop dismisses the picker, which costs nothing to reopen. It does
// not dismiss the permission prompt: that one is a question, and a stray click
// beside it must not be able to answer it either way.
$("picker").addEventListener("click", (e) => {
  if (e.target === $("picker")) closeModal("picker");
});
$("picker-add").addEventListener("click", () => void addEndpoint());
$("picker-url").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") void addEndpoint();
});

/**
 * Register a server and ask it what it serves.
 *
 * Deliberately usable with no workspace open: a new box on the network is
 * exactly the thing you want to point at before you have chosen a project, and
 * requiring a session first is how its models stayed invisible.
 */
async function addEndpoint(): Promise<void> {
  const box = $("picker-url") as HTMLInputElement;
  const url = box.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    $("picker-sub").textContent = "An endpoint needs a scheme — http:// or https://";
    return;
  }
  $("picker-sub").textContent = `Asking ${url}…`;
  await molt.addEndpoint(url);
  box.value = "";
  const list = await sources(true);
  await drawPicker(list);
  const added = list.find((s) => s.url.replace(/\/+$/, "") === url.replace(/\/+$/, ""));
  if (added && !added.ok) {
    // Kept in the list even so: a server that is merely switched off should
    // not have to be typed in again when it comes back.
    $("picker-sub").textContent = `${url} — ${reasonFor(added)}. Kept in the list.`;
  }
  void fillModelSelect(false);
}

$("picker-refresh").addEventListener("click", async () => {
  $("picker-sub").textContent = "Asking…";
  await drawPicker(await sources(true));
});

/** Settings' own dropdown, which shares the discovery with the picker. */
async function fillModelSelect(force = false): Promise<void> {
  const sel = $("set-model-pick") as HTMLSelectElement;
  const chosen = ($("set-model") as HTMLInputElement).value.trim();
  sel.textContent = "";
  const list = await sources(force);
  for (const src of list) {
    const g = document.createElement("optgroup");
    g.label = `${src.name} — ${src.url}`;
    if (src.ids.length) {
      for (const id of src.ids) g.appendChild(new Option(id, `${id}\u0000${src.url}`));
    } else {
      // Shown, not skipped. Dropping an endpoint that answered nothing left
      // "other" as the only group in the list, which reads as "there are no
      // models" when it means "this server did not answer" — and hides the one
      // fact you need, which is why.
      const why = new Option(`  ${reasonFor(src)}`, "\u0000custom");
      why.disabled = true;
      g.appendChild(why);
    }
    sel.appendChild(g);
  }
  const custom = document.createElement("optgroup");
  custom.label = "other";
  custom.appendChild(new Option("custom — type an id below", "\u0000custom"));
  sel.appendChild(custom);
  syncModelPick(chosen);
}

/** Why a source listed nothing, in the terms that apply to that kind of host. */
function reasonFor(src: ModelSource): string {
  if (src.ok) return "no models listed";
  if (src.needsKey) return "no key stored — add one in Settings";
  if (src.local) return "not answering — is the server running?";
  return src.error ?? "unreachable";
}

/** Point the dropdown at `id` if it is in the list; otherwise show custom. */
function syncModelPick(id: string): void {
  const sel = $("set-model-pick") as HTMLSelectElement;
  const url = ($("set-url") as HTMLInputElement).value.trim();
  const exact = [...sel.options].find((o) => o.value === `${id}\u0000${url}`);
  const byId = [...sel.options].find((o) => o.value.split("\u0000")[0] === id);
  sel.value = (exact ?? byId)?.value ?? "\u0000custom";
  $("row-custom-model").classList.toggle("hidden", sel.value !== "\u0000custom");
}

$("set-model-pick").addEventListener("change", () => {
  const sel = $("set-model-pick") as HTMLSelectElement;
  const [id, url] = sel.value.split("\u0000");
  if (url === "custom") {
    $("row-custom-model").classList.remove("hidden");
    ($("set-model") as HTMLInputElement).focus();
    return;
  }
  $("row-custom-model").classList.add("hidden");
  ($("set-model") as HTMLInputElement).value = id!;
  if (url) ($("set-url") as HTMLInputElement).value = url;
});

$("set-refresh").addEventListener("click", () => {
  $("set-status").textContent = "Asking endpoints…";
  void fillModelSelect(true).then(() => ($("set-status").textContent = "Models refreshed."));
});


// ── spine collapse ───────────────────────────────────────────────────────────

/**
 * Fully hidden, no leftover strip. Default expanded so first launch still
 * shows the unique surface. `/bar` and Cmd/Ctrl+B are how you get it back.
 */
let spineOpen = true;

function setSpineOpen(open: boolean): void {
  spineOpen = open;
  $("stage").classList.toggle("no-spine", !open);
  $("spine-toggle").setAttribute("aria-pressed", String(open));
  localStorage.setItem("molt.spine", open ? "on" : "off");
}

$("spine-toggle").addEventListener("click", () => setSpineOpen(!spineOpen));
$("spine-hide").addEventListener("click", () => setSpineOpen(false));

// ── interview ────────────────────────────────────────────────────────────────

type IvQ = { id: string; prompt: string; options: string[]; allowOther: boolean };
type IvA = { id: string; choice: string };

let ivTask = "";
let ivRound = 1;
let ivHistory: { questions: IvQ[]; answers: IvA[] }[] = [];
let ivCurrent: IvQ[] = [];
const ivPicks = new Map<string, string>();
let pendingBarAdds: { name: string; run: string }[] = [];

function closeInterview(): void {
  $("interview-panel").classList.add("hidden");
}

function drawInterview(): void {
  const box = $("iv-qs");
  box.textContent = "";
  for (const q of ivCurrent) {
    const card = el("div", "iv-q");
    card.appendChild(el("div", "prompt", q.prompt));
    const opts = el("div", "iv-opts");
    for (const opt of q.options) {
      const b = el("button", ivPicks.get(q.id) === opt ? "on" : "") as HTMLButtonElement;
      b.type = "button";
      b.textContent = opt;
      b.addEventListener("click", () => {
        ivPicks.set(q.id, opt);
        drawInterview();
      });
      opts.appendChild(b);
    }
    card.appendChild(opts);
    if (q.allowOther) {
      const other = el("input", "iv-other") as HTMLInputElement;
      other.type = "text";
      other.placeholder = "or say it in your own words";
      const cur = ivPicks.get(q.id);
      if (cur && !q.options.includes(cur)) other.value = cur;
      other.addEventListener("input", () => {
        if (other.value.trim()) ivPicks.set(q.id, other.value.trim());
      });
      card.appendChild(other);
    }
    box.appendChild(card);
  }
}

function collectAnswers(): IvA[] {
  return ivCurrent
    .map((q) => ({ id: q.id, choice: (ivPicks.get(q.id) ?? "").trim() }))
    .filter((a) => a.choice.length > 0);
}

async function startInterview(task = ""): Promise<void> {
  // Criteria is the review surface even when nothing is open — self-check
  // clicks Interview with no workspace and still has to tell a check from
  // a note. The model round waits until a session exists.
  $("criteria").classList.remove("hidden");
  if (!state?.open) {
    showTab("settings");
    $("set-status").textContent = "Open a workspace first.";
    $("ck-state").textContent = "open a workspace to interview; add checks here in the meantime";
    return;
  }
  ivTask = task.trim() || promptBox.value.trim();
  ivRound = 1;
  ivHistory = [];
  ivCurrent = [];
  ivPicks.clear();
  pendingBarAdds = [];
  $("interview-panel").classList.remove("hidden");
  $("iv-state").textContent = "asking…";
  await interviewRound();
}

async function interviewRound(skip = false): Promise<void> {
  if (ivCurrent.length) {
    ivHistory.push({ questions: ivCurrent, answers: skip ? [] : collectAnswers() });
  }
  $("iv-state").textContent = skip ? "proposing from what you answered…" : "asking…";
  const r = await molt.interview({
    task: ivTask,
    round: ivRound,
    history: ivHistory,
  });
  if (r.kind === "error") {
    $("iv-state").textContent = r.error;
    say("error", r.error, "error");
    return;
  }
  if (r.kind === "ask") {
    ivRound = r.round + 1;
    ivCurrent = r.questions;
    ivPicks.clear();
    $("iv-state").textContent = `round ${r.round} — answer, then continue`;
    drawInterview();
    return;
  }
  closeInterview();
  pendingBarAdds = r.proposal.barAdds;
  for (const c of r.proposal.checks) rows.push({ kind: "check", name: c.name, text: c.run });
  for (const n of r.proposal.notes) rows.push({ kind: "note", name: "", text: n });
  $("criteria").classList.remove("hidden");
  drawCriteria();
  $("ck-seal").classList.toggle("hidden", pendingBarAdds.length === 0);
  $("ck-state").textContent = pendingBarAdds.length
    ? "review, then Seal into bar — or Run to use as this-task criteria"
    : "review the draft, then Run to seal it for this task";
  say("", "interview proposed criteria — review them before they mean anything", "info");
}

$("interview").addEventListener("click", () => void startInterview());
$("iv-hide").addEventListener("click", closeInterview);
$("iv-next").addEventListener("click", () => void interviewRound(false));
$("iv-skip").addEventListener("click", () => void interviewRound(true));
$("ck-seal").addEventListener("click", async () => {
  if (!pendingBarAdds.length) return;
  const r = await molt.applyBar(pendingBarAdds);
  if (!r.ok) {
    say("error", r.error ?? "could not write the bar", "error");
    return;
  }
  if (r.state) {
    state = r.state;
    applyState();
  }
  pendingBarAdds = [];
  $("ck-seal").classList.add("hidden");
  $("ck-state").textContent = "wrote into .molt/done.yml — task criteria still need Run to seal";
  setSpineOpen(true);
});

// ── chrome ───────────────────────────────────────────────────────────────────

function applyState(): void {
  if (!state) return;
  $("crumb-cwd").textContent = state.cwd ?? "no workspace";
  $("crumb-cwd").className = state.cwd ? "crumb" : "crumb muted";
  // Both crumbs ellipsise at 340px, and a deep path or a long local model id
  // is longer than that far more often than not. Without a tooltip the tail —
  // which is the part that identifies it — was simply unreadable.
  $("crumb-cwd").title = state.cwd ?? "no workspace open";
  $("crumb-model").textContent = state.model ?? "no model";
  $("crumb-model").title = state.model
    ? `${state.model}${state.baseUrl ? ` — ${state.baseUrl}` : ""}\nClick to change`
    : "Click to choose a model";
  // Keep link-quiet: the crumb is the way into the model picker, and assigning
  // className wholesale here would quietly strip the affordance that says so.
  $("crumb-model").classList.toggle("muted", !state.model);
  $("crumb-local").classList.toggle("hidden", !state.selfHosted);
  if (state.sessionId) {
    $("set-status").dataset.session = state.sessionId;
    if (!$("set-status").textContent) $("set-status").textContent = `session ${state.sessionId}`;
  }
  // Settings is where you go to see what is open, and its workspace box was
  // filled from nothing — a session could be running against a directory while
  // the field that names it sat empty behind a placeholder. Never while it has
  // focus: overwriting a path someone is halfway through typing is worse than
  // showing them nothing.
  const cwdBox = $("set-cwd") as HTMLInputElement;
  if (state.cwd && document.activeElement !== cwdBox) cwdBox.value = state.cwd;
  renderAutonomy();
  $("local-hint").textContent = state.selfHosted
    ? "Self-hosted: no spending ceiling applies, and molt will not warn about caching it cannot see."
    : "";
  if (state.barError) {
    say("bar", `done.yml could not be read: ${state.barError}`, "error");
  }
  renderChecks();
  void refreshStats();
}

/**
 * OpenCode's rail is a context meter plus a todo list. The meter is worth
 * taking; the list is not. molt's todo is the bar — what "done" means — and
 * a second checklist of the model's own tasks would be a copy.
 */
function paintContext(s: Stats | null): void {
  const pct = $("ctx-pct");
  const line = $("ctx-line");
  const cost = $("ctx-cost");
  const fill = $("ctx-fill");
  const bar = fill.parentElement!;
  if (!s) {
    pct.textContent = "";
    line.textContent = "no session";
    cost.textContent = "";
    fill.style.width = "0%";
    bar.className = "ctx-bar";
    return;
  }
  const cap = contextCap(s.window, s.budget);
  const used = s.requestEst;
  const ratio = contextFill(used, cap);
  const pctN = Math.round(ratio * 100);
  fill.style.width = `${pctN}%`;
  bar.className = ratio >= 0.92 ? "ctx-bar full" : ratio >= 0.75 ? "ctx-bar hot" : "ctx-bar";
  if (cap > 0) {
    pct.textContent = `${pctN}%`;
    line.textContent =
      s.window > 0
        ? `${fmtInt(used)} of ${fmtInt(cap)}`
        : `${fmtInt(used)} of ${fmtInt(cap)} budget`;
  } else {
    // No window named, no budget set. A percentage of a number we invented
    // is how this would lie, so the fill stays empty and the count stands.
    pct.textContent = "";
    line.textContent = used > 0 ? `${fmtInt(used)} in the next request` : "empty";
  }
  const money =
    s.costUsd === null ? "" : s.costEstimated ? `~${fmtCost(s.costUsd)}` : fmtCost(s.costUsd);
  cost.textContent = [money, s.cached > 0 ? `${fmtInt(s.cached)} cached` : "", s.shedBatches > 0 ? `${s.shedBatches} shed` : ""]
    .filter(Boolean)
    .join(" · ");
}

async function refreshStats(): Promise<void> {
  paintContext(await molt.stats());
}

async function boot(): Promise<void> {
  state = await molt.state();

  const themeSel = $("set-theme") as HTMLSelectElement;
  for (const t of state.themes) themeSel.appendChild(new Option(t, t));
  const saved = localStorage.getItem("molt.theme") ?? state.themes[0]!;
  themeSel.value = saved;
  themeSel.dispatchEvent(new Event("change"));

  const provSel = $("set-provider") as HTMLSelectElement;
  for (const p of state.providers) provSel.appendChild(new Option(p, p));

  const stored = await molt.storedEndpoint();
  if (stored.baseUrl) ($("set-url") as HTMLInputElement).value = stored.baseUrl;
  if (stored.model) ($("set-model") as HTMLInputElement).value = stored.model;

  const savedAutonomy = localStorage.getItem("molt.autonomy");
  if (savedAutonomy && savedAutonomy !== state.autonomy) {
    const r = await molt.setAutonomy(savedAutonomy);
    if (r.ok && r.state) state = r.state;
  }

  // The frame differs by platform, and the padding that compensates for
  // macOS's traffic lights is a hole anywhere else.
  document.documentElement.dataset.platform = state.platform;
  const mod = state.platform === "darwin" ? "⌘" : "Ctrl";
  for (const k of document.querySelectorAll("[data-mod]")) k.textContent = mod;

  setSpineOpen(localStorage.getItem("molt.spine") !== "off");
  applyState();
  // Discovery is a network call per endpoint; it must not hold the window
  // shut, so it fills in behind the first paint.
  void fillModelSelect().catch(() => {
    $("set-status").textContent = "Could not reach any endpoint to list models.";
  });
  showTab(state.open ? "session" : "settings");
  if (!state.open) $("composer").classList.add("hidden");
}

void boot();

export {};
