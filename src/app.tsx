/**
 * The TUI.
 *
 * Deliberately plain. The interesting part of molt is the loop, and a
 * terminal interface earns its keep by getting out of the way — showing the
 * work, the receipts, and the refusals, and nothing else.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { Banner, fmtCost, fmtDuration } from "./banner.js";
import { COMMANDS, completionFor, matchCommands, windowAround, wrapIndex } from "./commands.js";
import { StatusLine } from "./status-line.js";
import { loadBar, writeDefaultBar, BarError } from "./bar.js";
import type { Engine } from "./engine.js";
import {
  PROVIDERS,
  defaultConfigDir,
  fetchPricing,
  firstSelectable,
  keyedProviders,
  modelSources,
  moveSelection,
  needsPriceLookup,
  pickerRows,
  readAuth,
  resolveProvider,
  saveEndpoint,
  saveKey,
  savePricing,
  storedEndpoint,
  windowRows,
  type ModelChoice,
  type PickerRow,
} from "./providers.js";
import {
  AUTONOMY_LEVELS,
  AUTONOMY_SUMMARY,
  DEFAULT_AUTONOMY,
  isAutonomy,
  nextAutonomy,
  type Autonomy,
} from "./autonomy.js";
import {
  EMPTY,
  backspace,
  deleteForward,
  deleteWord,
  end,
  home,
  insert,
  killToEnd,
  killToStart,
  left,
  line,
  right,
  split,
  type Line,
} from "./line.js";
import { DEFAULT_THEME, getTheme, nextTheme } from "./theme.js";
import type { BarResult, EngineEvent, JobOutcome } from "./types.js";

type Row = {
  id: number;
  tone: "user" | "agent" | "tool" | "info" | "error" | "ok" | "fail";
  text: string;
};

/**
 * One line of the live feed behind `v`.
 *
 * Kept separate from the transcript because the two have opposite
 * lifetimes. The transcript is permanent and is printed once, never
 * redrawn — that is what keeps a long session from tearing itself apart in
 * a terminal that cannot scroll backwards. The feed is a bounded window on
 * what is happening now, redrawn freely because it never grows.
 */
type Feed = { id: number; text: string; dim?: boolean };

/** A user turn, and what it cost. */
type Job = {
  n: number;
  text: string;
  startedAt: number;
  steps: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd?: number;
  estimated: boolean;
  durationMs?: number;
  outcome?: JobOutcome;
};

/** Feed lines kept in memory. Bounded: this is a window, not a second log. */
const FEED_MEMORY = 300;
/** Feed lines on screen at once. The panel must never outgrow the viewport. */
const FEED_ROWS = 9;
/** Finished jobs listed under the running one. */
const JOB_ROWS = 4;
/** Lines of an in-flight answer shown while it streams. */
const STREAM_ROWS = 8;

const HELP = [
  "commands",
  ...COMMANDS.map((c) => `  ${(c.name + (c.args ? " " + c.args : "")).padEnd(20)}${c.summary}`),
  "",
  "  type / to browse · ↑↓ to choose · tab to fill · enter to run",
  "  start a line with ? to ask a question rather than request a change —",
  "  checks that require a file to change are not run for that turn.",
  "  shift+V while molt is working (or ctrl+V any time) watches every call,",
  "  argument, and result — the same facts the session log records to disk.",
  "  shift+A raises how much molt does without asking. ctrl+A at the prompt.",
].join("\n");

/** Tokens, at a width that does not make the line jitter as it climbs. */
function tok(n: number): string {
  if (n < 1000) return `${n}`;
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
}

/**
 * Tokens and money, in one phrasing used everywhere.
 *
 * Every place that reports spending says it the same way, so a step, a job,
 * and the session can be read against each other without translating
 * between formats — the thing that made the old meter look like it was
 * jumping around.
 */
function spendText(s: {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd?: number;
  estimated: boolean;
}): string {
  const cached = s.cachedTokens > 0 ? ` (${tok(s.cachedTokens)} cached)` : "";
  const money =
    s.costUsd === undefined ? "" : ` · ${s.estimated ? "~" : ""}${fmtCost(s.costUsd)}`;
  return `${tok(s.promptTokens)} in${cached} · ${tok(s.completionTokens)} out${money}`;
}

/** How many palette rows to show at once. */
const PALETTE_ROWS = 6;

/**
 * The working indicator. Braille cells are a single column wide in every
 * modern terminal font, so the label beside them never shifts as it turns.
 */
const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
const SPIN_MS = 90;

export function App({
  engine,
  version,
  autoShed,
  verbose: startVerbose = false,
}: {
  engine: Engine;
  version: string;
  autoShed?: number;
  /** Start in the transparency view, from `--verbose`. */
  verbose?: boolean;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // The live panel must fit the window exactly. A line one column too long
  // wraps, the panel grows a row, and the region molt redraws every frame
  // stops matching the region it erased — which is how a "view" turns into
  // torn output.
  const columns = stdout?.columns ?? 80;
  const room = Math.max(24, columns - 4);
  const fit = (t: string) => (t.length > room ? t.slice(0, room - 1) + "…" : t);
  const [themeName, setThemeName] = useState(DEFAULT_THEME);
  const theme = getTheme(themeName);

  const [lines, setLines] = useState<Row[]>([]);
  // The prompt line carries its caret, so a typo can be fixed where it is
  // rather than by deleting everything after it.
  const [entry, setEntry] = useState<Line>(EMPTY);
  const input = entry.text;
  const setInput = useCallback((text: string) => setEntry(line(text)), []);
  /** Apply one editing operation to the line. */
  const edit = useCallback((op: (l: Line) => Line) => setEntry((l) => op(l)), []);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ name: string; detail: string } | null>(null);
  const [promptChoice, setPromptChoice] = useState(0);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [streamText, setStreamText] = useState("");
  const [cost, setCost] = useState<number | undefined>(undefined);
  const [costEstimated, setCostEstimated] = useState(false);
  const [verbose, setVerbose] = useState(startVerbose);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  // The splash is the one moving thing on screen at startup, and the
  // transcript cannot be printed permanently above something still moving.
  const [settled, setSettled] = useState(false);
  const [autonomy, setAutonomyState] = useState<Autonomy>(engine.autonomy ?? DEFAULT_AUTONOMY);

  // Picker state. `login-key` is the one mode that must never echo what you
  // type, so it is a distinct state rather than a flag on a shared one.
  type Mode =
    | { kind: "chat" }
    | { kind: "login-select"; providers: { name: string; hasKey: boolean }[]; index: number }
    | { kind: "login-key"; provider: string }
    | { kind: "model-select"; rows: PickerRow[]; index: number }
    | { kind: "autonomy-select"; index: number };
  const [mode, setMode] = useState<Mode>({ kind: "chat" });

  // What the model is doing right now, and since when. Held separately from
  // `busy` because the turn stays busy across several distinct phases.
  const [activity, setActivity] = useState<{
    label: string;
    what?: string;
    since: number;
  } | null>(null);
  const [frame, setFrame] = useState(0);
  const nextId = useRef(0);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const add = useCallback((tone: Row["tone"], text: string) => {
    setLines((prev) => [...prev, { id: nextId.current++, tone, text }]);
  }, []);

  /**
   * Record a line for the live feed.
   *
   * Written whether or not the view is open: `v` reveals what already
   * happened rather than starting a recording. Bounded, because the durable
   * copy of all of this is the session log on disk.
   */
  const note = useCallback((text: string, dim = false) => {
    setFeed((prev) => {
      const next = [...prev, { id: nextId.current++, text, dim }];
      return next.length > FEED_MEMORY ? next.slice(-FEED_MEMORY) : next;
    });
  }, []);

  useEffect(() => {
    if (!engine.hasBar) {
      add(
        "info",
        "no .molt/done.yml in this project — completions will not be verified. /init to add one.",
      );
    }
    if (autoShed) add("info", `auto-shed above ${autoShed} tokens of history`);
  }, [add, engine, autoShed]);

  // The spinner only turns while there is work. An idle molt draws nothing
  // and holds no timer, so it costs a stopped terminal exactly nothing.
  useEffect(() => {
    if (!busy) {
      setFrame(0);
      return;
    }
    const id = setInterval(() => setFrame((f) => f + 1), SPIN_MS);
    return () => clearInterval(id);
  }, [busy]);

  /**
   * Name the current phase, restarting the clock only when it actually
   * changes. `what` is the thing being acted on — the file being read, the
   * command being run — so the working line says what is happening rather
   * than only that something is.
   */
  const beginActivity = useCallback((label: string, what?: string) => {
    setActivity((a) => (a?.label === label && a?.what === what ? a : { label, what, since: Date.now() }));
  }, []);

  const confirm = useCallback(
    (name: string, detail: string) =>
      new Promise<boolean>((resolve) => {
        setPending({ name, detail });
        setPromptChoice(0); // default to allow; deny is one arrow away
        resolver.current = resolve;
      }),
    [],
  );

  // The palette is derived, never stored — it can never disagree with the
  // text on screen.
  const matches = matchCommands(input);
  const showPalette = matches.length > 0 && !busy && !pending && mode.kind === "chat";
  const selectedIndex = wrapIndex(paletteIndex, matches.length);
  const selected = matches[selectedIndex];

  const renderBar = useCallback(
    (result: BarResult, header: string) => {
      add(result.ok ? "ok" : "fail", header);
      const passed = result.results.filter((r) => r.ok).length;
      // The one-line verdict, before the per-check list. A reader who wants
      // the detail scrolls; a reader who wants to know whether to trust the
      // last thing the model said does not have to.
      const blocking = result.results.filter((r) => !r.ok && !r.advisory);
      const warned = result.warnings ?? [];
      add(
        result.ok ? "ok" : "fail",
        `  ${passed} of ${result.results.length} checks passed · ${fmtDuration(result.durationMs)}` +
          (blocking.length ? ` · failed: ${blocking.map((r) => r.name).join(", ")}` : "") +
          (warned.length ? ` · advisory: ${warned.map((r) => r.name).join(", ")}` : ""),
      );
      for (const r of result.results) {
        // An advisory failure reads as a warning, because that is what it is:
        // it did not stop anything, and printing it as FAIL next to a met bar
        // teaches people to delete the check rather than read it.
        const label = r.ok ? "pass" : r.advisory ? "warn" : "FAIL";
        add(
          r.ok ? "ok" : r.advisory ? "info" : "fail",
          `  ${label}  ${r.name}${r.exitCode !== undefined ? ` (exit ${r.exitCode})` : ""}`,
        );
        // What the check actually ran, and how long it took. A passing check
        // that never ran the command you think it runs is the failure mode
        // this makes visible.
        note(`  ${r.ok ? "pass" : "FAIL"} ${r.name} · ${r.detail} · ${fmtDuration(r.durationMs)}`, true);
        if (r.ok && r.output.trim()) {
          for (const l of r.output.trim().split("\n").slice(0, 4)) note(`      ${l}`, true);
        }
        if (!r.ok) {
          for (const l of r.output.trim().split("\n").slice(0, 8)) {
            add(r.advisory ? "info" : "fail", `        ${l}`);
          }
        }
      }

      // A check's output is written for the model, which is the party that
      // can act on it. When the only thing standing between you and an answer
      // is a check this turn was never going to satisfy, that needs saying to
      // you, in your terms — otherwise the refusal reads as molt malfunctioning.
      const onlyWorkLanded =
        !result.ok &&
        result.results.every((r) => r.ok || r.detail === "files-changed") &&
        result.results.some((r) => !r.ok && r.detail === "files-changed");
      if (onlyWorkLanded) {
        add(
          "info",
          "everything else passed. work-landed requires this turn to have changed a file, so\n" +
            "a question, a lookup, or an explanation can never satisfy it — and molt would\n" +
            "rather refuse an honest answer than accept an invented file edit.\n" +
            "ask questions with /ask <question>: it runs the rest of the bar and drops that\n" +
            "one check for the turn. For a whole session of questions, start with --skip session.",
        );
      }
    },
    [add, note],
  );

  const handleEvent = useCallback(
    (ev: EngineEvent) => {
      switch (ev.kind) {
        case "delta":
          beginActivity("responding");
          setStreamText((s) => s + ev.text);
          break;
        case "cancelled":
          setStreamText("");
          add("info", "cancelled — the session is unchanged");
          break;
        case "assistant_text":
          setStreamText("");
          add("agent", ev.text);
          break;
        case "tool_start":
          beginActivity(ev.name, ev.detail);
          break;
        case "tool": {
          // The duration earns its place next to the call it describes, not
          // in a summary at the end where it cannot be acted on.
          const took = ev.durationMs === undefined ? "" : `  ${fmtDuration(ev.durationMs)}`;
          // A call nobody was asked about says so. Autonomy is a convenience,
          // and the record of what it let through has to be readable without
          // opening the log.
          add(
            "tool",
            `${ev.name}  ${ev.detail}${ev.note ? `  [${ev.note}]` : ""}${ev.auto ? "  [auto]" : ""}${took}`,
          );
          // The exact call and the head of what came back. Verbatim: a
          // transparency view that paraphrases is one more thing to verify.
          note(`· ${ev.name} ${ev.detail}${took}`);
          if (ev.args && ev.args !== "{}") note(`    args ${ev.args.replace(/\s+/g, " ")}`, true);
          if (ev.bytes !== undefined) {
            note(`    → ${ev.bytes} bytes${ev.note ? ` · ${ev.note}` : ""}`, true);
          }
          for (const l of (ev.preview ?? "").split("\n").slice(0, 5)) {
            if (l.trim()) note(`    │ ${l}`, true);
          }
          beginActivity("thinking");
          break;
        }
        case "job_start":
          setJobs((prev) => [
            ...prev,
            {
              n: ev.job,
              text: ev.text,
              startedAt: Date.now(),
              steps: 0,
              promptTokens: 0,
              completionTokens: 0,
              cachedTokens: 0,
              costUsd: undefined,
              estimated: false,
            },
          ]);
          note(`▸ job ${ev.job} · ${ev.text.replace(/\s+/g, " ").slice(0, 60)}`);
          break;
        case "job_end":
          // The job's own books, closed. The session meter below never
          // resets — this is a view of it, not a replacement for it.
          setJobs((prev) =>
            prev.map((j) =>
              j.n === ev.job
                ? {
                    ...j,
                    steps: ev.steps,
                    promptTokens: ev.spend.promptTokens,
                    completionTokens: ev.spend.completionTokens,
                    cachedTokens: ev.spend.cachedTokens,
                    costUsd: ev.spend.costUsd,
                    estimated: ev.spend.estimated,
                    durationMs: ev.durationMs,
                    outcome: ev.outcome,
                  }
                : j,
            ),
          );
          note(
            `▪ job ${ev.job} ${ev.outcome} · ${ev.steps} step(s) · ` +
              `${spendText(ev.spend)} · ${fmtDuration(ev.durationMs)}`,
          );
          break;
        case "request":
          beginActivity("thinking");
          note(
            `→ step ${ev.step + 1} · ${ev.messages} messages · ~${tok(ev.estTokens)} tokens → ${ev.model}` +
              (ev.stream ? " · streaming" : ""),
            true,
          );
          break;
        case "step_summary": {
          // Every step closes with what it did and what it cost. Emitted
          // whether or not the transparency view is open: the running total
          // is reconciled step by step, so a surprising bill has a line
          // where it came from rather than only a final number.
          const s = ev.spend;
          const did = ev.outcome === "claim" ? "claims done" : ev.tools.join(", ") || "no tools";
          add(
            "info",
            `step ${ev.step + 1} · ${did} · ${spendText(s)} · ${fmtDuration(ev.durationMs)}` +
              (s.estimated ? " · tokens estimated" : s.billed ? " · billed by provider" : ""),
          );
          // Fold the step into the job it belongs to, so the panel can show
          // a running cost for work that has not finished yet.
          setJobs((prev) =>
            prev.map((j) =>
              j.n === ev.job
                ? {
                    ...j,
                    steps: j.steps + 1,
                    promptTokens: j.promptTokens + s.promptTokens,
                    completionTokens: j.completionTokens + s.completionTokens,
                    cachedTokens: j.cachedTokens + s.cachedTokens,
                    costUsd:
                      s.costUsd === undefined ? j.costUsd : (j.costUsd ?? 0) + s.costUsd,
                    estimated: j.estimated || s.estimated,
                  }
                : j,
            ),
          );
          // The step line is already in the transcript a row above; what the
          // panel adds is the reconciliation — where the session total stands
          // after it, and why the model stopped.
          note(
            `  ↳ session ${tok(ev.sessionTokens)} tokens` +
              (ev.sessionCostUsd === undefined ? "" : ` · ${fmtCost(ev.sessionCostUsd)}`) +
              (ev.finishReason ? ` · finish: ${ev.finishReason}` : ""),
            true,
          );
          break;
        }
        case "usage":
          setTokens(ev.sessionTokens);
          setCost(ev.costUsd);
          if (ev.estimated) setCostEstimated(true);
          break;
        case "proof_start":
          beginActivity("checking the bar");
          add(
            "info",
            `checking ${ev.checks} condition(s) from .molt/done.yml: ${ev.names.join(", ")}`,
          );
          break;
        case "proof_result":
          renderBar(ev.result, "bar met");
          break;
        case "proof_refused":
          // The claim was refused, so it must leave the screen. Streaming
          // already painted it; without this the refused text stays in the
          // buffer and the next attempt's tokens append to it.
          setStreamText("");
          renderBar(ev.result, `completion refused (attempt ${ev.attempt}) — continuing`);
          add("info", "  the failures above go back to the model; it keeps working");
          break;
        case "proof_exhausted":
          setStreamText("");
          renderBar(ev.result, `bar not met after ${ev.attempts} attempts`);
          break;
        case "receipt":
          add("info", `receipt: ${ev.path}`);
          break;
        case "shed":
          add("info", `shed ${ev.dropped} messages · ${ev.before} → ${ev.after} tokens · ${ev.path}`);
          break;
        case "info":
          add("info", ev.text);
          break;
        case "error":
          add("error", ev.text);
          break;
      }
    },
    [add, beginActivity, note, renderBar],
  );

  /** Remember the endpoint so the next bare `molt` starts where this left off. */
  const persistEndpoint = useCallback(() => {
    if (engine.model) saveEndpoint(engine.baseUrl, engine.model);
  }, [engine]);

  // Stable identity: Banner fires this from an effect, so a new function
  // every render would re-fire it on every frame of the animation.
  const onSettle = useCallback(() => setSettled(true), []);

  /**
   * Move the autonomy ceiling.
   *
   * Announced in the transcript rather than the feed: this is the one setting
   * that changes what molt may do to the machine, so the record of the
   * session has to carry it whether or not anyone had the view open.
   */
  const applyAutonomy = useCallback(
    (level: Autonomy) => {
      engine.setAutonomy(level);
      setAutonomyState(level);
      add("info", `autonomy: ${level} — ${AUTONOMY_SUMMARY[level]}`);
    },
    [add, engine],
  );

  const cycleAutonomy = useCallback(() => {
    applyAutonomy(nextAutonomy(engine.autonomy));
  }, [applyAutonomy, engine]);

  /**
   * Open the level picker.
   *
   * At an idle prompt a keystroke has to be safe to press by accident: a
   * terminal cannot tell shift+A from the "A" that starts "Add a test", so
   * the key that works there opens a chooser and changes nothing until you
   * confirm. Escape puts the keystroke back where it came from. While molt is
   * working, or while it is asking permission, the same key cycles outright —
   * there is no typing to collide with, and speed is the point.
   */
  const openAutonomy = useCallback(() => {
    setMode({ kind: "autonomy-select", index: AUTONOMY_LEVELS.indexOf(engine.autonomy) });
  }, [engine]);

  const toggleVerbose = useCallback(() => {
    setVerbose((v) => {
      // Said in the feed, not the transcript: a keypress that permanently
      // prints a line into the record is a keypress people stop pressing.
      note(
        v
          ? "view closed — shift+V while working, ctrl+V any time"
          : "view open: every call, argument, and result, as recorded in .molt/log",
      );
      return !v;
    });
  }, [note]);

  /**
   * Ask the provider what this model costs.
   *
   * Prices are per model and change without notice, so molt reads them from
   * the endpoint that will do the billing rather than from a table it ships
   * or a number typed once and forgotten. Providers that publish nothing
   * leave the meter with no cost to show, which is the honest outcome.
   */
  const refreshPricing = useCallback(
    async (announce: boolean) => {
      const model = engine.model;
      if (!model) return;
      const p = await fetchPricing(engine.baseUrl, model, engine.cfg.apiKey);
      if (!p) {
        // Publishing nothing is not the same as costing nothing, and it is
        // not a reason to discard a price someone set by hand.
        if (announce) {
          add("info", `${engine.provider} publishes no price for ${model} — /price <in> <out> to set one`);
        }
        return;
      }
      engine.setPricing({ in: p.in, out: p.out, cached: p.cached, source: p.source });
      savePricing(model, p);
      if (announce) {
        add(
          "info",
          `pricing · $${p.in}/M in${p.cached === undefined ? "" : ` · $${p.cached}/M cached`} · ` +
            `$${p.out}/M out · from ${p.source}`,
        );
      }
    },
    [add, engine],
  );

  // On start, and never again unless the model changes. One /models-style
  // request, off the critical path — the prompt is usable before it lands.
  useEffect(() => {
    if (needsPriceLookup(engine.model, engine.pricing(), storedEndpoint())) {
      void refreshPricing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startLogin = useCallback(
    (arg?: string) => {
      const stored = readAuth();
      // `/login xai` skips the picker; a wrong name falls through to it.
      const direct = arg ? resolveProvider(arg) : null;
      if (direct) {
        add("info", `paste API key for ${direct} — input hidden, enter to save, esc to cancel`);
        const hint = PROVIDERS[direct]?.hint;
        if (hint) add("info", `note: ${hint}`);
        setMode({ kind: "login-key", provider: direct });
        return;
      }
      if (arg) add("info", `unknown provider '${arg}'`);
      add("info", "add a key — choose a provider:");
      setMode({
        kind: "login-select",
        providers: keyedProviders().map((name) => ({ name, hasKey: Boolean(stored[name]) })),
        index: 0,
      });
    },
    [add],
  );

  const finishLogin = useCallback(
    (provider: string, key: string) => {
      setMode({ kind: "chat" });
      if (!key) {
        add("info", "login cancelled");
        return;
      }
      const preset = PROVIDERS[provider];
      const ok = saveKey(provider, key);
      // Point the session at the provider you just authenticated, so the key
      // is usable now rather than after a restart. The model does not travel
      // with it — it belonged to the endpoint you just left.
      if (preset) {
        engine.setBaseUrl(preset.url, key, provider);
        setTokens(0);
        setCost(undefined);
        setCostEstimated(false);
      }
      add(
        ok ? "ok" : "error",
        ok
          ? `key saved for ${provider} → ${defaultConfigDir()}/auth.json (0600)`
          : `could not write ${defaultConfigDir()}/auth.json — key held for this session only`,
      );
      // Straight into the picker: a provider with no model selected cannot do
      // anything, and making someone type /model to learn that is a step molt
      // can take for them.
      if (preset) void startModelPicker();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [add, engine],
  );

  /** Aggregate models across every provider you hold a key for. */
  const startModelPicker = useCallback(async () => {
    const auth = readAuth();
    const sources = modelSources(auth);
    if (!sources.length) {
      add("info", "no provider keys yet — /login to add one");
      return;
    }
    setBusy(true);
    const results = await Promise.all(
      sources.map(async (src) => ({ ...src, r: await engine.listModels(src.url, src.key) })),
    );
    setBusy(false);

    const choices: ModelChoice[] = [];
    for (const src of results) {
      if (!src.r.ok) continue;
      choices.push(...src.r.ids.map((id) => ({ provider: src.name, id, url: src.url, key: src.key })));
    }
    // Report unreachable keyed providers — a silently short list reads as
    // "this provider has no models" when it means "molt could not ask".
    for (const src of results.filter((x) => !x.r.ok && auth[x.name])) {
      add("error", `${src.name}: unreachable (${(src.r as { error: string }).error})`);
    }
    if (!choices.length) {
      add("error", "no models found — check the keys with molt doctor, or /login again");
      return;
    }
    const rows = pickerRows(choices);
    add("info", "models across your keys:");
    setMode({ kind: "model-select", rows, index: firstSelectable(rows) });
  }, [add, engine]);

  const applyModel = useCallback(
    (c: ModelChoice) => {
      setMode({ kind: "chat" });
      // Switching endpoint resets the session: different endpoint, different
      // world, and a transcript carried across would misattribute the record.
      if (engine.baseUrl !== c.url) {
        engine.setBaseUrl(c.url, c.key, c.provider);
        setTokens(0);
        setCost(undefined);
      }
      engine.setModel(c.id);
      persistEndpoint();
      add("ok", `model → ${c.provider}/${c.id}`);
      // A price belongs to a model. Carrying the old one across a switch
      // bills the new model at the old rate, silently and wrongly.
      setCostEstimated(false);
      void refreshPricing(true);
    },
    [add, engine, persistEndpoint, refreshPricing],
  );

  // `command` can start a turn (/ask) and `submit` dispatches commands, so
  // one of the two has to reach the other late. A ref keeps both honest
  // without recreating either on every render.
  const submitRef = useRef<((text: string, opts?: { ask?: boolean }) => void) | null>(null);

  const command = useCallback(
    (raw: string): boolean => {
      const [cmd, ...rest] = raw.trim().split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd) {
        case "/help":
          add("info", HELP);
          return true;
        case "/exit":
        case "/quit":
          exit();
          return true;
        case "/molt": {
          const t = nextTheme(themeName);
          setThemeName(t);
          add("info", `theme: ${t}`);
          return true;
        }
        case "/clear":
          engine.reset();
          setLines([]);
          setFeed([]);
          setJobs([]);
          setTokens(0);
          setCost(undefined);
          setCostEstimated(false);
          return true;
        case "/bom": {
          const b = engine.bom();
          add(
            "info",
            `system ${b.systemTokens} · tools ${b.toolSchemaTokens} · history ${b.historyTokens} · ` +
              `request ≈ ${b.requestTotalEst} · session ${b.sessionPromptTokens + b.sessionCompletionTokens}` +
              (b.budgetTokens ? ` / ${b.budgetTokens}` : "") +
              (b.sessionCachedTokens > 0 ? ` · ${b.sessionCachedTokens} cached` : "") +
              (b.costUsd === undefined
                ? ""
                : ` · ${b.costEstimated ? "~" : ""}${fmtCost(b.costUsd)}`),
          );
          return true;
        }
        case "/wire":
          add("info", engine.lastRequestBody ?? "(nothing sent yet)");
          return true;
        case "/budget":
          if (arg === "off" || arg === "") {
            engine.setBudget(undefined);
            add("info", "budget cleared");
          } else {
            const n = Number(arg);
            if (!Number.isFinite(n) || n <= 0) add("error", "usage: /budget <tokens|off>");
            else {
              engine.setBudget(n);
              add("info", `budget: ${n} tokens`);
            }
          }
          return true;
        case "/login":
          startLogin(arg || undefined);
          return true;
        case "/model":
          if (!arg) void startModelPicker();
          else {
            engine.setModel(arg);
            persistEndpoint();
            add("ok", `model → ${arg}`);
            void refreshPricing(true);
          }
          return true;
        case "/ask":
        case "/q": {
          if (!arg) {
            add("error", "usage: /ask <question> — runs the bar without the work-landed check");
            return true;
          }
          void submitRef.current?.(arg, { ask: true });
          return true;
        }
        case "/autonomy":
        case "/auto": {
          if (!arg) {
            openAutonomy();
            return true;
          }
          if (!isAutonomy(arg)) {
            add("error", "usage: /autonomy <low|medium|high>");
            return true;
          }
          applyAutonomy(arg);
          return true;
        }
        case "/verbose":
        case "/detail":
          toggleVerbose();
          return true;
        case "/price": {
          const p = engine.pricing();
          if (arg === "" || arg === "show") {
            if (p.in === undefined || p.out === undefined) {
              add(
                "info",
                `no price known for ${engine.model || "this model"} — the meter shows tokens only. ` +
                  "/price <in> <out> sets USD per 1M tokens.",
              );
            } else {
              add(
                "info",
                `${engine.model} · $${p.in}/M in` +
                  (p.cached === undefined ? "" : ` · $${p.cached}/M cached`) +
                  ` · $${p.out}/M out · ${p.source ?? "set by hand"}`,
              );
              const b = engine.bom();
              if (b.sessionPromptTokens + b.sessionCompletionTokens > 0) {
                add(
                  "info",
                  `  this session: ${b.sessionPromptTokens} in` +
                    (b.sessionCachedTokens > 0 ? ` (${b.sessionCachedTokens} cached)` : "") +
                    ` · ${b.sessionCompletionTokens} out · ` +
                    `${b.costEstimated ? "~" : ""}${fmtCost(b.costUsd ?? 0)}` +
                    (b.costEstimated ? " (token counts estimated)" : ""),
                );
              }
            }
            return true;
          }
          if (arg === "off" || arg === "clear") {
            engine.setPricing({});
            savePricing(engine.model, null);
            add("info", "pricing cleared — the meter will show tokens only");
            return true;
          }
          if (arg === "refresh" || arg === "fetch") {
            void refreshPricing(true);
            return true;
          }
          const parts = arg.split(/\s+/).map(Number);
          if (parts.length < 2 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
            add("error", "usage: /price <usd-per-1M-in> <usd-per-1M-out> [cached] | refresh | off");
            return true;
          }
          const [pin, pout, pcache] = parts;
          engine.setPricing({ in: pin, out: pout, cached: pcache, source: "set by hand" });
          savePricing(engine.model, {
            in: pin!,
            out: pout!,
            cached: pcache,
            source: "set by hand",
          });
          add("ok", `pricing · $${pin}/M in · $${pout}/M out` + (pcache ? ` · $${pcache}/M cached` : ""));
          return true;
        }
        case "/regrow": {
          if (!arg) {
            add("error", "usage: /regrow <pattern>");
            return true;
          }
          const r = engine.regrowMatching(arg);
          if (r.hits === 0) add("info", `nothing in the archive matches /${arg}/`);
          else
            add(
              "info",
              `re-attached ${r.attached} of ${r.hits} match(es) · +${r.tokens} tokens of context`,
            );
          return true;
        }
        case "/archive": {
          const archive = engine.archive;
          if (!archive) {
            add("info", "no archive configured");
            return true;
          }
          if (arg) {
            const hits = archive.grep?.(arg) ?? [];
            if (hits.length === 0) add("info", `nothing matches /${arg}/`);
            for (const h of hits.slice(0, 5))
              add("info", `exuvia ${h.index}: ${h.excerpt.slice(0, 200)}`);
            if (hits.length > 5) add("info", `… and ${hits.length - 5} more`);
          } else {
            const entries = archive.list();
            if (entries.length === 0) add("info", "nothing shed in this project yet");
            for (const e of entries)
              add("info", `  ${String(e.index).padStart(4, "0")}  ${e.messages} msgs  ${e.file}`);
          }
          return true;
        }
        case "/receipts": {
          const rows = engine.receipts?.records() ?? [];
          if (rows.length === 0) add("info", "no completion attempts recorded yet");
          for (const r of rows.slice(-10))
            add(
              r.verdict === "accepted" ? "ok" : "fail",
              `  ${r.file}  ${r.verdict}  attempt ${r.attempt}` +
                (r.failed.length ? `  failed: ${r.failed.join(", ")}` : ""),
            );
          return true;
        }
        case "/stats": {
          const st = engine.receipts?.stats();
          if (!st || st.attempts === 0) {
            add("info", "no completion attempts recorded yet");
            return true;
          }
          add(
            "info",
            `${st.attempts} attempts · ${st.accepted} accepted · ` +
              `false-claim rate ${(st.falseClaimRate * 100).toFixed(1)}% · ` +
              `${st.tokensPerVerifiedChange ?? "—"} tokens per verified change` +
              (st.usdPerVerifiedChange === undefined
                ? ""
                : ` · ${fmtCost(st.usdPerVerifiedChange)} per verified change`),
          );
          return true;
        }
        case "/shed": {
          if (arg === "--explain" || arg === "explain") {
            const plan = engine.explainShed();
            if (!plan) {
              add("info", "nothing worth shedding yet");
              return true;
            }
            add(
              "info",
              `would shed ${plan.droppedCount} messages · ${plan.beforeTokens} → ${plan.afterTokens} tokens`,
            );
            add("info", "── stays in context (digest) ──");
            for (const l of plan.digest.split("\n").slice(0, 12)) add("info", `  ${l}`);
            add("info", "── preserved on disk (exuvia) ──");
            for (const l of plan.exuvia.split("\n").slice(0, 12)) add("info", `  ${l}`);
            return true;
          }
          try {
            const s = engine.shed();
            if (!s) add("info", "nothing worth shedding yet");
            else
              add(
                "info",
                `shed ${s.dropped} messages · ${s.before} → ${s.after} tokens · archived ${s.path}`,
              );
          } catch (e) {
            add("error", `shed aborted, context untouched: ${String(e)}`);
          }
          return true;
        }
        case "/init": {
          const p = writeDefaultBar(engine.cwd);
          try {
            engine.setBar(loadBar(engine.cwd));
            add("info", `wrote ${p}`);
          } catch (e) {
            add("error", String(e));
          }
          return true;
        }
        case "/bar": {
          try {
            const bar = loadBar(engine.cwd);
            if (!bar) add("info", "no .molt/done.yml — /init to create one");
            else
              for (const c of bar.checks)
                add("info", `  ${c.name}: ${c.kind === "command" ? c.run : `builtin ${c.builtin}`}`);
          } catch (e) {
            add("error", e instanceof BarError ? e.message : String(e));
          }
          return true;
        }
        case "/prove": {
          const result = engine.proveNow();
          if (!result) add("info", "no bar to check — /init to create one");
          else renderBar(result, result.ok ? "bar met" : "bar not met");
          return true;
        }
        default:
          return false;
      }
    },
    [
      add,
      applyAutonomy,
      engine,
      exit,
      openAutonomy,
      persistEndpoint,
      refreshPricing,
      renderBar,
      startLogin,
      startModelPicker,
      themeName,
      toggleVerbose,
    ],
  );

  const submit = useCallback(
    async (raw: string, opts: { ask?: boolean } = {}) => {
      if (!raw.trim()) return;
      if (raw.startsWith("/")) {
        if (!command(raw)) add("error", `unknown command: ${raw.split(/\s+/)[0]}`);
        return;
      }
      // A leading "?" marks the turn as a question. It is the shortest
      // possible way for the PERSON to say so — and it has to be the person.
      // molt cannot let the model decide which of its own claims need
      // proving; that is the one decision the whole tool exists to take away
      // from it.
      const asking = opts.ask || /^\?\s*\S/.test(raw);
      const text = asking ? raw.replace(/^\?\s*/, "") : raw;
      if (!text.trim()) return;
      // Refuse rather than fire a request at an endpoint with no model. The
      // failure would otherwise surface as an opaque provider error.
      if (!engine.model) {
        add("error", "no model selected — /login to add a provider key, then /model to pick one");
        return;
      }
      add("user", `${asking ? "? " : ""}${text}`);
      setBusy(true);
      beginActivity("thinking");
      try {
        for await (const ev of engine.run(text, confirm, { ask: asking })) handleEvent(ev);
      } catch (e) {
        add("error", String(e));
      } finally {
        setBusy(false);
      }
    },
    [add, beginActivity, command, confirm, engine, handleEvent],
  );

  useEffect(() => {
    submitRef.current = (text, opts) => void submit(text, opts);
  }, [submit]);

  useInput((char, key) => {
    // --- permission prompt: arrows choose, enter commits, no typing ---
    if (pending) {
      // The prompt is exactly where "stop asking me this" is decided, so the
      // autonomy key works here. Raising the ceiling does not answer the
      // question in front of you — that stays a deliberate keypress.
      if (char === "A") {
        cycleAutonomy();
        return;
      }
      if (char === "V") {
        toggleVerbose();
        return;
      }
      if (key.leftArrow || key.upArrow) {
        setPromptChoice((i) => wrapIndex(i - 1, 2));
        return;
      }
      if (key.rightArrow || key.downArrow || key.tab) {
        setPromptChoice((i) => wrapIndex(i + 1, 2));
        return;
      }
      if (key.return) {
        resolver.current?.(promptChoice === 0);
        setPending(null);
        return;
      }
      if (key.escape) {
        resolver.current?.(false);
        setPending(null);
        return;
      }
      // y/n still work for anyone with the muscle memory.
      const c = char.toLowerCase();
      if (c === "y") {
        resolver.current?.(true);
        setPending(null);
      } else if (c === "n") {
        resolver.current?.(false);
        setPending(null);
      }
      return;
    }

    // --- shift+V opens the view, shift+A moves the autonomy ceiling.
    //
    // Both are bound while a turn is running and while molt is asking
    // permission — the two places the prompt takes no typing, so a letter is
    // free. At an idle prompt a capital letter is the first character of a
    // sentence far more often than it is a command, so there they are
    // ctrl+V / ctrl+A, or /verbose and /autonomy. ---
    if (key.ctrl && (char === "v" || char === "\u0016")) {
      toggleVerbose();
      return;
    }
    if (key.ctrl && (char === "a" || char === "\u0001")) {
      // A terminal's ctrl+A means "start of line", and molt must not steal
      // that from anyone editing. With nothing typed there is no line to go
      // to the start of, so the key is free for the autonomy picker.
      if (input === "" || busy || mode.kind !== "chat") cycleAutonomy();
      else edit(home);
      return;
    }

    // --- mid-stream: Ctrl-C cancels the turn rather than killing molt ---
    if (busy) {
      if (key.ctrl && char === "c") engine.cancel();
      else if (char === "V" && !key.ctrl && !key.meta) toggleVerbose();
      else if (char === "A" && !key.ctrl && !key.meta) cycleAutonomy();
      return;
    }

    // --- the autonomy picker: nothing changes until enter ---
    if (mode.kind === "autonomy-select") {
      if (key.escape || (key.ctrl && char === "c")) {
        setMode({ kind: "chat" });
        // Pressed by accident while starting a sentence: give the letter back
        // rather than making someone retype the line.
        edit((l) => insert(l, "A"));
        return;
      }
      const back = key.upArrow || (key.shift && key.tab);
      const forward = key.downArrow || key.tab;
      if (back || forward) {
        setMode({ ...mode, index: wrapIndex(mode.index + (back ? -1 : 1), AUTONOMY_LEVELS.length) });
        return;
      }
      if (key.return) {
        setMode({ kind: "chat" });
        applyAutonomy(AUTONOMY_LEVELS[mode.index]!);
      }
      return;
    }

    // --- pickers: arrows choose, enter commits, nothing is typed ---
    if (mode.kind === "login-select" || mode.kind === "model-select") {
      if (key.escape || (key.ctrl && char === "c")) {
        setMode({ kind: "chat" });
        add("info", "cancelled");
        return;
      }
      const back = key.upArrow || (key.shift && key.tab);
      const forward = key.downArrow || key.tab;
      if (mode.kind === "login-select") {
        if (back || forward) {
          setMode({ ...mode, index: wrapIndex(mode.index + (back ? -1 : 1), mode.providers.length) });
          return;
        }
        if (key.return) {
          const provider = mode.providers[mode.index]!.name;
          add("info", `paste API key for ${provider} — input hidden, enter to save, esc to cancel`);
          const hint = PROVIDERS[provider]?.hint;
          if (hint) add("info", `note: ${hint}`);
          setMode({ kind: "login-key", provider });
        }
        return;
      }
      if (back || forward) {
        // moveSelection steps over the provider headers, so the highlight
        // can only ever land on something selectable.
        setMode({ ...mode, index: moveSelection(mode.rows, mode.index, back ? -1 : 1) });
        return;
      }
      if (key.return) {
        const row = mode.rows[mode.index];
        if (row?.kind === "model") applyModel(row.choice);
        else setMode({ kind: "chat" });
      }
      return;
    }

    // --- key entry: the one picker step that takes typing, and hides it ---
    if (mode.kind === "login-key") {
      if (key.escape || (key.ctrl && char === "c")) {
        setInput("");
        setMode({ kind: "chat" });
        add("info", "login cancelled");
        return;
      }
      if (key.return) {
        const value = input.trim();
        setInput("");
        // `input` holds the raw key; it never reaches the transcript.
        finishLogin(mode.provider, value);
        return;
      }
      if (key.backspace || key.delete) {
        edit(backspace);
        return;
      }
      if (char && !key.ctrl && !key.meta) edit((l) => insert(l, char));
      return;
    }

    if (key.ctrl && char === "c") {
      exit();
      return;
    }

    // --- palette navigation ---
    if (showPalette) {
      if (key.upArrow) {
        setPaletteIndex((i) => wrapIndex(i - 1, matches.length));
        return;
      }
      if (key.downArrow) {
        setPaletteIndex((i) => wrapIndex(i + 1, matches.length));
        return;
      }
      if (key.tab && selected) {
        setInput(completionFor(selected));
        setPaletteIndex(0);
        return;
      }
      if (key.escape) {
        setInput("");
        setPaletteIndex(0);
        return;
      }
      if (key.return && selected) {
        // Enter runs the highlighted command, so nothing has to be typed in
        // full — but only when the typed text is not already a whole command.
        const typed = input.trim();
        const text = typed === selected.name || selected.args ? typed : selected.name;
        setInput("");
        setPaletteIndex(0);
        void submit(selected.args && typed === selected.name ? typed : text);
        return;
      }
    }

    if (key.return) {
      const text = input;
      setInput("");
      setPaletteIndex(0);
      void submit(text);
      return;
    }

    // --- editing the line in place ---
    //
    // Enough of readline to fix a mistake without retyping the sentence, and
    // no more: this is a one-line prompt, not an editor.
    if (key.leftArrow) {
      edit(left);
      return;
    }
    if (key.rightArrow) {
      edit(right);
      return;
    }
    if (key.backspace) {
      edit(backspace);
      setPaletteIndex(0);
      return;
    }
    if (key.delete) {
      // Ink reports both backspace and the delete key here depending on the
      // terminal; with a caret the two are different edits, so the one that
      // deletes forward only does so when there is something ahead of it.
      edit((l) => (l.at < l.text.length ? deleteForward(l) : backspace(l)));
      setPaletteIndex(0);
      return;
    }
    if (key.ctrl && char === "w") {
      edit(deleteWord);
      setPaletteIndex(0);
      return;
    }
    if (key.ctrl && char === "k") {
      edit(killToEnd);
      setPaletteIndex(0);
      return;
    }
    if (key.ctrl && char === "u") {
      edit(killToStart);
      setPaletteIndex(0);
      return;
    }
    if (key.ctrl && char === "e") {
      edit(end);
      return;
    }
    // shift+A on an empty line opens the level picker. Bound only on an empty
    // line: mid-sentence a capital letter is a letter, so "fix the Auth bug"
    // types the way it reads.
    if (char === "A" && input === "" && !key.ctrl && !key.meta) {
      openAutonomy();
      return;
    }

    if (char && !key.ctrl && !key.meta) {
      edit((l) => insert(l, char));
      setPaletteIndex(0);
    }
  });

  const toneColor: Record<Row["tone"], string> = {
    user: theme.text,
    agent: theme.accent,
    tool: theme.dim,
    info: theme.dim,
    error: theme.fail,
    ok: theme.ok,
    fail: theme.fail,
  };

  // Everything above the live region is printed once and never redrawn.
  // The old TUI re-rendered the whole session on every frame, which a
  // terminal cannot do once the output is taller than the window: it can
  // only erase what is still on screen, so the rest tears and duplicates.
  // That is the "buggy viewer", and it got worse the more molt had to say.
  //
  // The splash is held back until it stops moving, because permanent output
  // cannot be printed above something still animating.
  const staticItems: { key: string; row?: Row }[] = settled
    ? [{ key: "banner" }, ...lines.map((l) => ({ key: `l${l.id}`, row: l }))]
    : [];

  const running = jobs.find((j) => j.outcome === undefined);
  const done = jobs.filter((j) => j.outcome !== undefined);

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(item) =>
          item.row ? (
            <Text key={item.key} color={toneColor[item.row.tone]}>
              {item.row.tone === "user" ? "› " : item.row.tone === "tool" ? "· " : "  "}
              {item.row.text}
            </Text>
          ) : (
            <Box key={item.key} flexDirection="column">
              <Banner theme={theme} themeName={themeName} version={version} />
            </Box>
          )
        }
      </Static>

      {!settled && (
        <Banner
          theme={theme}
          themeName={themeName}
          animate
          version={version}
          onSettle={onSettle}
        />
      )}

      {/* An answer in flight. Capped: the full text joins the transcript
          when it completes, and an uncapped live region is the other half
          of the redraw problem. */}
      {streamText ? (
        <Box marginTop={1} flexDirection="column">
          {(() => {
            const all = streamText.split("\n");
            const shown = all.slice(-STREAM_ROWS);
            return (
              <>
                {all.length > STREAM_ROWS && (
                  <Text color={theme.ghost}>  ↑ {all.length - STREAM_ROWS} more line(s)</Text>
                )}
                {shown.map((l, i) => (
                  <Text key={i} color={theme.accent}>
                    {fit(l)}
                    {i === shown.length - 1 ? <Text color={theme.dim}>▌</Text> : null}
                  </Text>
                ))}
              </>
            );
          })()}
        </Box>
      ) : null}

      {verbose && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>
            {fit(`── what the model is doing ${"─".repeat(Math.max(2, room - 44))}`)}
            <Text color={theme.ghost}>  shift+V closes</Text>
          </Text>

          {running ? (
            <Text color={theme.accent}>
              {fit(
                `  job ${running.n} · ${running.text.replace(/\s+/g, " ").slice(0, 32)} · ` +
                  `${running.steps} step(s) · ${spendText(running)} · ` +
                  `${fmtDuration(Date.now() - running.startedAt)}`,
              )}
            </Text>
          ) : (
            <Text color={theme.ghost}>  idle · no job running</Text>
          )}

          {feed.slice(-FEED_ROWS).map((f) => (
            <Text key={f.id} color={f.dim ? theme.ghost : theme.dim}>
              {fit(`  ${f.text}`)}
            </Text>
          ))}

          {done.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {done.slice(-JOB_ROWS).map((j) => (
                <Text key={j.n} color={theme.ghost}>
                  {fit(
                    `  job ${j.n} ${j.outcome} · ${j.steps} step(s) · ${spendText(j)}` +
                      (j.durationMs === undefined ? "" : ` · ${fmtDuration(j.durationMs)}`),
                  )}
                </Text>
              ))}
              {done.length > JOB_ROWS && (
                <Text color={theme.ghost}>{`  … and ${done.length - JOB_ROWS} earlier job(s)`}</Text>
              )}
            </Box>
          )}
        </Box>
      )}

      {pending ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.warn}>
            allow {pending.name}: {pending.detail}
          </Text>
          <Box>
            {["allow", "deny"].map((label, i) => (
              <Text
                key={label}
                color={promptChoice === i ? theme.accent : theme.dim}
                bold={promptChoice === i}
              >
                {promptChoice === i ? " ▸ " : "   "}
                {label}
              </Text>
            ))}
          </Box>
          <Text color={theme.ghost}>
            {`  ←→ choose · enter confirm · esc deny · shift+A autonomy (${autonomy}) · shift+V watch`}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {mode.kind === "login-select" ? (
            <Box flexDirection="column">
              {mode.providers.map((p, i) => {
                const active = i === mode.index;
                return (
                  <Box key={p.name}>
                    <Text color={active ? theme.accent : theme.dim} bold={active}>
                      {active ? " ▸ " : "   "}
                      {p.name.padEnd(14)}
                    </Text>
                    {p.hasKey && <Text color={theme.ghost}>key stored — will overwrite</Text>}
                  </Box>
                );
              })}
              <Text color={theme.ghost}>   ↑↓ choose · enter select · esc cancel</Text>
            </Box>
          ) : mode.kind === "autonomy-select" ? (
            <Box flexDirection="column">
              <Text color={theme.dim}>  how much molt does without asking:</Text>
              {AUTONOMY_LEVELS.map((level, i) => {
                const active = i === mode.index;
                return (
                  <Box key={level}>
                    <Text color={active ? theme.accent : theme.dim} bold={active}>
                      {active ? " ▸ " : "   "}
                      {level.padEnd(8)}
                    </Text>
                    <Text color={active ? theme.text : theme.ghost}>
                      {fit(AUTONOMY_SUMMARY[level])}
                    </Text>
                    {level === engine.autonomy && <Text color={theme.ghost}>{"  ← now"}</Text>}
                  </Box>
                );
              })}
              {/* Said here, every time, because this is the moment someone is
                  deciding to be asked less. */}
              <Text color={theme.ghost}>
                {"   leaving the project and anything irreversible always ask"}
              </Text>
              <Text color={theme.ghost}>   ↑↓ choose · enter set · esc cancel</Text>
            </Box>
          ) : mode.kind === "model-select" ? (
            <Box flexDirection="column">
              {windowRows(mode.rows, mode.index).map(({ row, i }) =>
                row.kind === "header" ? (
                  // The provider header carries the same bright colour the
                  // highlighted row gets, so the grouping reads at a glance.
                  <Text key={`h${i}`} color={theme.accent} bold>
                    {"  "}
                    {row.provider}
                  </Text>
                ) : (
                  <Text
                    key={`m${i}`}
                    color={i === mode.index ? theme.accent : theme.dim}
                    bold={i === mode.index}
                  >
                    {i === mode.index ? "   ▸ " : "     "}
                    {row.choice.id}
                  </Text>
                ),
              )}
              <Text color={theme.ghost}>   ↑↓ choose · enter select · esc cancel</Text>
            </Box>
          ) : (
            <Box>
              {busy ? (
                <>
                  <Text color={theme.accent}>{SPINNER[frame % SPINNER.length]} </Text>
                  <Text color={theme.dim}>{activity?.label ?? "working"}</Text>
                  {/* What it is working ON, not just that it is working. */}
                  {activity?.what && (
                    <Text color={theme.dim}>
                      {" \u00b7 "}
                      {activity.what.length > 48 ? activity.what.slice(0, 47) + "…" : activity.what}
                    </Text>
                  )}
                  {activity && (
                    <Text color={theme.ghost}>
                      {" \u00b7 "}
                      {fmtDuration(Date.now() - activity.since)}
                    </Text>
                  )}
                  <Text color={theme.ghost}>
                    {" \u00b7 "}
                    {verbose ? "shift+V closes" : "shift+V to watch"}
                  </Text>
                </>
              ) : (
                <>
                  <Text color={theme.dim}>{mode.kind === "login-key" ? "🔑 " : "› "}</Text>
                  {/* A pasted key is echoed as dots — it must not survive on
                      screen or in a scrollback buffer. */}
                  {mode.kind === "login-key" ? (
                    <>
                      <Text color={theme.text}>{"•".repeat(input.length)}</Text>
                      <Text color={theme.accent}>▌</Text>
                    </>
                  ) : (
                    (() => {
                      // The caret is drawn where it actually is: a block at the
                      // end of the line, and the character it stands on
                      // reversed when it is inside the text.
                      const { before, under, after, atEnd } = split(entry);
                      return (
                        <>
                          <Text color={theme.text}>{before}</Text>
                          {atEnd ? (
                            <Text color={theme.accent}>▌</Text>
                          ) : (
                            <Text color={theme.text} inverse>
                              {under}
                            </Text>
                          )}
                          <Text color={theme.text}>{after}</Text>
                        </>
                      );
                    })()
                  )}
                </>
              )}
            </Box>
          )}

          {showPalette && (
            <Box flexDirection="column" marginTop={0}>
              {(() => {
                const win = windowAround(matches, selectedIndex, PALETTE_ROWS);
                const above = win[0]?.i ?? 0;
                const below = matches.length - 1 - (win.at(-1)?.i ?? 0);
                return (
                  <>
                    {above > 0 && <Text color={theme.ghost}>   ↑ {above} more</Text>}
                    {win.map(({ item: c, i }) => {
                      const active = i === selectedIndex;
                      return (
                        <Box key={c.name}>
                          <Text color={active ? theme.accent : theme.dim} bold={active}>
                            {active ? " ▸ " : "   "}
                            {(c.name + (c.args ? " " + c.args : "")).padEnd(20)}
                          </Text>
                          <Text color={active ? theme.text : theme.ghost}>{c.summary}</Text>
                        </Box>
                      );
                    })}
                    {below > 0 && <Text color={theme.ghost}>   ↓ {below} more</Text>}
                  </>
                );
              })()}
              <Text color={theme.ghost}>   ↑↓ choose · tab fill · enter run · esc clear</Text>
            </Box>
          )}
        </Box>
      )}

      <StatusLine
        theme={theme}
        busy={busy}
        status={{
          provider: engine.provider,
          model: engine.model,
          sessionTokens: tokens,
          costUsd: cost,
          costEstimated,
          autonomy,
          // A key already stored means the next step is choosing a model, not
          // logging in again.
          hint: Object.keys(readAuth()).length > 0 ? "/model" : "/login",
          budgetTokens: engine.budgetTokens,
        }}
      />
    </Box>
  );
}
