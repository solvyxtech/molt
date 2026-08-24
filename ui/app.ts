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
  setModel(o: {
    model: string;
    baseUrl?: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; error?: string; state?: AppState }>;
  setAutonomy(
    level: string,
  ): Promise<{ ok: boolean; error?: string; state?: AppState; means?: string }>;
  run(text: string, ask?: boolean): Promise<{ ok: boolean; error?: string }>;
  cancel(): void;
  answerConfirm(id: string, ok: boolean): void;
  receipts(): Promise<ReceiptRow[]>;
  receipt(file: string): Promise<string | null>;
  journal(): Promise<Record<string, unknown>[]>;
  stats(): Promise<Stats | null>;
  onEvent(fn: (ev: Ev) => void): () => void;
  onConfirm(fn: (r: ConfirmReq) => void): () => void;
  onIdle(fn: () => void): () => void;
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
};

type ModelSource = {
  name: string;
  url: string;
  ok: boolean;
  ids: string[];
  error?: string;
  needsKey?: boolean;
};

type ReceiptRow = { file: string; n: number; verdict: string; mtime: number };
type Stats = {
  tokens: number;
  cached: number;
  costUsd: number | null;
  shedBatches: number;
  hasBar: boolean;
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

const fmtMs = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

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

function showTab(name: string): void {
  for (const t of document.querySelectorAll<HTMLElement>(".tab"))
    t.classList.toggle("active", t.dataset.tab === name);
  for (const p of document.querySelectorAll<HTMLElement>(".panel"))
    p.classList.toggle("active", p.id === `panel-${name}`);
  // The composer belongs to the session; showing it elsewhere invites you to
  // type a task into a screen that will not run one.
  $("composer").classList.toggle("hidden", name !== "session");
  if (name === "receipts") void loadReceipts();
  if (name === "log") void loadJournal();
  if (name === "checks") clearBadge("checks");
  if (name === "receipts") clearBadge("receipts");
}

function badge(which: "checks" | "receipts", text: string, kind?: "ok" | "fail"): void {
  const b = $(`badge-${which}`);
  b.textContent = text;
  b.className = `badge${kind ? " " + kind : ""}`;
}
function clearBadge(which: "checks" | "receipts"): void {
  $(`badge-${which}`).className = "badge hidden";
}

document.getElementById("tabs")!.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>(".tab");
  if (t?.dataset.tab) showTab(t.dataset.tab);
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
}

function append(node: HTMLElement): void {
  const was = atBottom();
  $("stream-empty")?.remove();
  stream().appendChild(node);
  follow(was);
}

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

function receiptLink(path: string): HTMLElement {
  const file = path.split("/").pop()!;
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
  let head: string;
  if (advisoryOnly) {
    head =
      failed === 0
        ? `answered — ${passed} check(s) reported, all clear · ${fmtMs(r.durationMs ?? 0)}`
        : `answered — ${failed} of ${rows.length} check(s) already failing, before this question`;
  } else if (ok) {
    head = `bar met — ${passed} of ${rows.length} checks · ${fmtMs(r.durationMs ?? 0)}`;
  } else {
    head = `bar not met — ${passed} of ${rows.length} checks${
      ev.attempt ? ` · attempt ${ev.attempt}` : ""
    }`;
  }
  box.appendChild(el("h4", undefined, head));

  for (const c of rows) {
    const row = el("div", "check");
    const label = c.ok ? "pass" : c.advisory ? "note" : "FAIL";
    const cls = c.ok ? "pass" : c.advisory ? "note" : "fail";
    row.appendChild(el("div", `verdict ${cls}`, label));
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

// ── checks tab ───────────────────────────────────────────────────────────────

function renderChecks(result?: Ev): void {
  const box = $("checks");
  box.textContent = "";
  const defined = state?.checks ?? [];
  const results: any[] = result?.result?.results ?? [];

  if (!defined.length && !results.length) {
    $("checks-sub").textContent = state?.open
      ? "No .molt/done.yml in this workspace — completions here are unverified, and molt will say so."
      : "No workspace open.";
    return;
  }
  $("checks-sub").textContent = results.length
    ? `Last run: ${results.filter((r) => r.ok).length} of ${results.length} passed.`
    : `${defined.length} check(s) defined. They run when the model claims to be done.`;

  const seen = new Set<string>();
  for (const r of results) {
    seen.add(r.name);
    const card = el("div", `check-card ${r.ok ? "pass" : "fail"}`);
    const top = el("div", "top");
    top.appendChild(el("span", "nm", r.name));
    top.appendChild(el("span", "tag", r.kind ?? ""));
    top.appendChild(el("span", "spacer"));
    top.appendChild(
      el("span", r.ok ? "verdict pass" : "verdict fail", r.ok ? "pass" : "FAIL"),
    );
    card.appendChild(top);
    if (r.output) card.appendChild(el("pre", undefined, r.output));
    box.appendChild(card);
  }
  for (const c of defined) {
    if (seen.has(c.name)) continue;
    const card = el("div", "check-card");
    const top = el("div", "top");
    top.appendChild(el("span", "nm", c.name));
    top.appendChild(el("span", "tag", c.kind));
    for (const t of c.tags ?? []) top.appendChild(el("span", "tag", t));
    card.appendChild(top);
    box.appendChild(card);
  }
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
  for (const r of rows) {
    const { kind, at, ...rest } = r as any;
    const row = el("div", "entry");
    row.appendChild(el("div", "kind", String(kind ?? "?")));
    row.appendChild(el("div", "body", JSON.stringify(rest)));
    box.appendChild(row);
  }
}

$("log-filter").addEventListener("input", drawJournal);
$("log-refresh").addEventListener("click", () => void loadJournal());

// ── markdown, enough of it for a receipt ─────────────────────────────────────

/**
 * A deliberately small renderer.
 *
 * Receipts are the document you hand to someone who does not trust you, so
 * they get rendered by code that can be read in one sitting rather than by a
 * dependency. It builds DOM nodes and sets text, never HTML — a receipt quotes
 * the model verbatim, and the model is not a trusted author.
 */
function renderMarkdown(md: string, into: HTMLElement): void {
  const lines = md.split("\n");
  let i = 0;
  const inline = (parent: HTMLElement, text: string): void => {
    // `code`, **bold**, and nothing else. Anything unmatched stays literal.
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      const at = m.index!;
      if (at > last) parent.appendChild(document.createTextNode(text.slice(last, at)));
      const tok = m[0];
      if (tok.startsWith("`")) parent.appendChild(el("code", undefined, tok.slice(1, -1)));
      else parent.appendChild(el("strong", undefined, tok.slice(2, -2)));
      last = at + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("```")) {
      const pre = el("pre");
      const code = el("code");
      i++;
      const buf: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("```")) buf.push(lines[i++]!);
      i++;
      code.textContent = buf.join("\n");
      pre.appendChild(code);
      into.appendChild(pre);
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const node = el(`h${h[1]!.length}`);
      inline(node, h[2]!);
      into.appendChild(node);
      i++;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (r: string): string[] =>
        r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const table = el("table");
      const thead = el("thead");
      const hr = el("tr");
      for (const c of cells(line)) {
        const th = el("th");
        inline(th, c);
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      i += 2;
      const tbody = el("tbody");
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const tr = el("tr");
        for (const c of cells(lines[i]!)) {
          const td = el("td");
          inline(td, c);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        i++;
      }
      table.appendChild(tbody);
      into.appendChild(table);
      continue;
    }

    if (line.startsWith(">")) {
      const q = el("blockquote");
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) buf.push(lines[i++]!.replace(/^>\s?/, ""));
      inline(q, buf.join("\n"));
      q.style.whiteSpace = "pre-wrap";
      into.appendChild(q);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const ul = el("ul");
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        const li = el("li");
        inline(li, lines[i]!.replace(/^[-*]\s+/, ""));
        ul.appendChild(li);
        i++;
      }
      into.appendChild(ul);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      into.appendChild(el("hr"));
      i++;
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const p = el("p");
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#|>|```|[-*]\s|\|)/.test(lines[i]!))
      buf.push(lines[i++]!);
    inline(p, buf.join(" "));
    into.appendChild(p);
  }
}

// ── engine events ────────────────────────────────────────────────────────────

function setState(kind: "idle" | "busy" | "proving" | "ok" | "fail", text: string): void {
  $("state-dot").className = `dot ${kind === "idle" ? "" : kind}`.trim();
  $("state-text").textContent = text;
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
      wire("request", "out", `step ${ev.step ?? ""} · ${ev.messages ?? "?"} messages`);
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
      badge("checks", "…");
      showTabHint();
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
      badge("checks", ok ? "pass" : "fail", ok ? "ok" : "fail");
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

/** Nudge the eye to the Checks tab the first time a proof runs. */
let hinted = false;
function showTabHint(): void {
  if (hinted) return;
  hinted = true;
}

molt.onConfirm((req) => {
  $("confirm-title").textContent = req.name;
  $("confirm-detail").textContent = req.detail;
  $("confirm").classList.remove("hidden");
  const answer = (ok: boolean) => () => {
    molt.answerConfirm(req.id, ok);
    $("confirm").classList.add("hidden");
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
  $("send").classList.remove("hidden");
  $("stop").classList.add("hidden");
  if (!$("state-dot").classList.contains("ok") && !$("state-dot").classList.contains("fail"))
    setState("idle", "idle");
  void refreshStats();
});

// ── composer ─────────────────────────────────────────────────────────────────

const promptBox = $("prompt") as HTMLTextAreaElement;

function autogrow(): void {
  promptBox.style.height = "auto";
  promptBox.style.height = `${Math.min(promptBox.scrollHeight, 200)}px`;
}
promptBox.addEventListener("input", autogrow);

promptBox.addEventListener("keydown", (e) => {
  // Enter sends; shift+Enter is a newline. The opposite of a chat box would be
  // wrong here — a task is usually one line and sending it should not need a
  // second gesture.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});

const ask0 = (): boolean => ($("ask") as HTMLInputElement).checked;

async function send(): Promise<void> {
  const text = promptBox.value.trim();
  if (!text || busy) return;
  if (!state?.open) {
    showTab("settings");
    $("set-status").textContent = "Open a workspace first.";
    return;
  }
  promptBox.value = "";
  autogrow();
  say("you", text, "user");
  busy = true;
  $("send").classList.add("hidden");
  $("stop").classList.remove("hidden");
  setState("busy", "thinking");
  // Before the first event: the request is in flight and the window must say
  // so, or the gap between Run and the first token reads as a dead click.
  startActivity(ask0() ? "asking" : "thinking");
  const ask = ($("ask") as HTMLInputElement).checked;
  const r = await molt.run(text, ask);
  if (!r.ok && r.error) say("error", r.error, "error");
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
  for (const { level, means } of state.autonomyLevels) {
    const b = el("button", `au${level === state.autonomy ? " on" : ""}`, level) as HTMLButtonElement;
    // The summary is the engine's own words for what the level permits.
    b.title = means;
    b.addEventListener("click", () => void chooseAutonomy(level, means));
    box.appendChild(b);
  }
}

async function chooseAutonomy(level: string, means: string): Promise<void> {
  const r = await molt.setAutonomy(level);
  if (!r.ok) {
    say("error", r.error ?? "could not change autonomy", "error");
    return;
  }
  state = r.state!;
  renderAutonomy();
  // Said out loud in the stream, because it changes what the next turn may do
  // to this machine without asking, and a silent change to that is the kind
  // nobody remembers making.
  if (state.open) say("", `autonomy: ${level} — ${means}`, "info");
  localStorage.setItem("molt.autonomy", level);
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
  state = r.state!;
  applyState();
  $("set-status").textContent = "Open.";
  showTab("session");
});

$("set-theme").addEventListener("change", async () => {
  const name = ($("set-theme") as HTMLSelectElement).value;
  const t = await molt.theme(name);
  for (const [k, v] of Object.entries(t)) document.documentElement.style.setProperty(`--${k}`, v);
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
  $("picker").classList.remove("hidden");
  $("picker-sub").textContent = "Asking every endpoint you hold a key for…";
  $("picker-list").textContent = "";
  await drawPicker(await sources());
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
    if (!src.ok) grp.appendChild(el("span", "err", src.needsKey ? "no key stored" : (src.error ?? "unreachable")));
    box.appendChild(grp);

    if (!src.ids.length) {
      box.appendChild(el("div", "empty-grp", src.ok ? "no models listed" : "—"));
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
    $("picker").classList.add("hidden");
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
  $("picker").classList.add("hidden");
  say("", `model is now ${id}`, "info");
}

$("crumb-model").addEventListener("click", () => void openPicker());
$("picker-close").addEventListener("click", () => $("picker").classList.add("hidden"));
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
    if (!src.ids.length) continue;
    const g = document.createElement("optgroup");
    g.label = `${src.name} — ${src.url}`;
    for (const id of src.ids) g.appendChild(new Option(id, `${id}\u0000${src.url}`));
    sel.appendChild(g);
  }
  const custom = document.createElement("optgroup");
  custom.label = "other";
  custom.appendChild(new Option("custom — type an id below", "\u0000custom"));
  sel.appendChild(custom);
  syncModelPick(chosen);
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

// ── chrome ───────────────────────────────────────────────────────────────────

function applyState(): void {
  if (!state) return;
  $("crumb-cwd").textContent = state.cwd ?? "no workspace";
  $("crumb-cwd").className = state.cwd ? "crumb" : "crumb muted";
  $("crumb-model").textContent = state.model ?? "no model";
  // Keep link-quiet: the crumb is the way into the model picker, and assigning
  // className wholesale here would quietly strip the affordance that says so.
  $("crumb-model").classList.toggle("muted", !state.model);
  $("crumb-local").classList.toggle("hidden", !state.selfHosted);
  $("st-bar").textContent = state.checks.length
    ? `bar: ${state.checks.length} check(s)`
    : "no bar — unverified";
  $("st-session").textContent = state.sessionId ? `session ${state.sessionId}` : "";
  renderAutonomy();
  $("local-hint").textContent = state.selfHosted
    ? "Self-hosted: no spending ceiling applies, and molt will not warn about caching it cannot see."
    : "";
  if (state.barError) {
    say("bar", `done.yml could not be read: ${state.barError}`, "error");
  }
  renderChecks();
}

async function refreshStats(): Promise<void> {
  const s = await molt.stats();
  if (!s) return;
  // One string rather than three fields with separators between them: an
  // empty session showed "— · — · —", which reads as broken rather than idle.
  const parts = [`${fmtInt(s.tokens)} tokens`];
  if (s.cached > 0) parts.push(`${fmtInt(s.cached)} cached`);
  if (s.costUsd !== null) parts.push(`$${s.costUsd.toFixed(4)}`);
  if (s.shedBatches > 0) parts.push(`${s.shedBatches} shed`);
  $("st-usage").textContent = s.tokens > 0 ? parts.join("  ·  ") : "";
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
