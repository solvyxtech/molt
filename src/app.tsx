/**
 * The TUI.
 *
 * Deliberately plain. The interesting part of molt is the loop, and a
 * terminal interface earns its keep by getting out of the way — showing the
 * work, the receipts, and the refusals, and nothing else.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Static, Text, render, useApp, useInput, useStdout } from "ink";
import type { RenderOptions } from "ink";
import { Banner, fmtCost, fmtDuration, fmtTokens } from "./banner.js";
import {
  COMMANDS,
  COMMAND_COL,
  commandLabel,
  completionFor,
  matchCommands,
  windowAround,
  wrapIndex,
} from "./commands.js";
import { RemappedStdin } from "./keys.js";
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
  isSelfHosted,
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
  deleteWordForward,
  end,
  home,
  insert,
  killToEnd,
  killToStart,
  left,
  line,
  right,
  split,
  wordLeft,
  wordRight,
  type Line,
} from "./line.js";
import { DEFAULT_THEME, getTheme, nextTheme } from "./theme.js";
import type { BarResult, EngineEvent, JobOutcome } from "./types.js";

type Row = {
  id: number;
  tone: "user" | "agent" | "tool" | "info" | "error" | "ok" | "fail";
  text: string;
  /**
   * A blank line belonging above this row.
   *
   * Carried here rather than pushed as a row of its own, because Ink drops a
   * whitespace-only `<Static>` item when the items arrive one at a time —
   * which is exactly how streamed output arrives. All at once the blanks
   * survive; incrementally they vanish, so every paragraph break the model
   * wrote was silently deleted and its prose came out as one dense block.
   * Folded into the next row's text, the item is no longer whitespace-only
   * and the break survives.
   */
  gap?: boolean;
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

/**
 * Feed lines kept in memory.
 *
 * Generous, because this is what `v` reveals about what already happened, and
 * a transparency view whose memory is shorter than the session is a view that
 * hides the beginning of it. Still bounded: the durable copy is .molt/log.
 */
const FEED_MEMORY = 5_000;
/** Feed lines on screen at once. The panel must never outgrow the viewport. */
const FEED_ROWS = 9;

/** Finished jobs listed under the running one. */
const JOB_ROWS = 4;


const HELP = [
  "commands",
  ...COMMANDS.map((c) => `  ${commandLabel(c).padEnd(COMMAND_COL)}${c.summary}`),
  "",
  "  type / to browse · ↑↓ to choose · tab to fill · enter to run",
  "  start a line with ? to ask a question rather than request a change —",
  "  checks that require a file to change are not run for that turn.",
  "  arrows move · alt+arrows by word · ctrl+W/K/U cut · ctrl+A start · ctrl+E end",
  "  you can keep typing while molt works — enter queues it for when the turn ends.",
  "",
  "  shift+V while molt is working (or ctrl+V any time) watches every call,",
  "  argument, and result — the same facts the session log records to disk.",
  "  shift+A raises how much molt does without asking. ctrl+A at the prompt.",
].join("\n");

/** Tokens, at a width that does not make the line jitter as it climbs. */
const tok = fmtTokens;

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

/** Bytes, at a glance: exact when small, rounded when not. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * How many rows the prompt may occupy before it summarises instead.
 *
 * The prompt is a live region and a region that changes height is one the
 * terminal cannot repaint without tearing. Four leaves room for an ordinary
 * long sentence to wrap — which is wanted, since the text is yours and you are
 * still editing it — while bounding the pasted block that would otherwise take
 * twenty.
 */
const MAX_PROMPT_ROWS = 4;

/**
 * Draw the prompt: a summarised paste, or the line with its caret.
 *
 * Shared by the idle prompt and the mid-turn one. The mid-turn line used to
 * dump the whole string with no caret, so a typo three words back had to be
 * deleted from the end even though the same keys already moved the caret.
 * Same editor, same drawing.
 */
function PromptBody({
  entry,
  room,
  secret,
  theme,
}: {
  entry: Line;
  room: number;
  secret?: boolean;
  theme: { accent: string; ghost: string };
}): ReactNode {
  if (secret) {
    return (
      <>
        {"•".repeat(entry.text.length)}
        <Text color={theme.accent}>▌</Text>
      </>
    );
  }
  const rows = entry.text.split("\n");
  // Summarised when it has newlines, and also when one line alone would fill
  // more of the window than a prompt should. A chunked paste arrives before
  // its first newline does, so four hundred characters of a single line grew
  // the prompt to six rows and then collapsed it when the newline landed —
  // the same height oscillation, reached without a newline in sight. Ordinary
  // typing stays under this and still wraps, which is what you want when the
  // text is yours.
  const overlong = entry.text.length > room * MAX_PROMPT_ROWS;
  if (rows.length > 1 || overlong) {
    // The count goes first, deliberately. Showing the opening words and
    // trailing "+10 more lines" read as truncation — reported as "it only
    // pastes some of the text, or I can't see the whole text" — when every
    // character was in fact held and sent. Leading with what molt has says
    // so before the eye reaches anything that looks cut off.
    const tag =
      rows.length > 1
        ? `[${rows.length} lines, ${entry.text.length} chars] `
        : `[${entry.text.length} chars] `;
    // Trimmed to the window rather than wrapped: the whole point is a prompt
    // that does not change height while a paste arrives in a dozen reads, and
    // a long first line wraps to two rows on its own.
    const preview = rows[0]!.slice(0, Math.max(8, room - tag.length - 2));
    return (
      <>
        <Text color={theme.ghost}>{tag}</Text>
        {preview}
        {preview.length < rows[0]!.length ? <Text color={theme.ghost}>…</Text> : null}
        <Text color={theme.accent}>▌</Text>
      </>
    );
  }
  const { before, under, after, atEnd } = split(entry);
  return (
    <>
      {before}
      {atEnd ? <Text color={theme.accent}>▌</Text> : <Text inverse>{under}</Text>}
      {after}
    </>
  );
}

/**
 * Commands that take effect while a turn is running, rather than waiting.
 *
 * Deliberately only the spending limits. They change what molt is allowed to
 * do next and nothing about the conversation, so applying one halfway through
 * is safe — and it is the only way to act on a ceiling warning before the
 * ceiling arrives. Anything that moves the model, the endpoint or the
 * transcript stays queued: doing that mid-conversation is its own kind of
 * wrong.
 */
const RUNS_MID_TURN = new Set(["/budget", "/price"]);

/**
 * Lines of a tool result the live panel shows before it says how many remain.
 *
 * The panel answers "what is molt doing", and a payload is not an answer to
 * that. Enough to judge whether the call did what it should, and a count for
 * the rest so nothing is hidden silently.
 */
const PREVIEW_ROWS = 8;

/** How many palette rows to show at once. */
/** The `/login` row that is not a provider: a server you run yourself. */
const LOCAL_ROW = "local or self-hosted…";

const PALETTE_ROWS = 6;

/**
 * The working indicator. Braille cells are a single column wide in every
 * modern terminal font, so the label beside them never shifts as it turns.
 */
const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
const SPIN_MS = 90;

export type AppProps = {
  engine: Engine;
  version: string;
  autoShed?: number;
  /** Start in the transparency view, from `--verbose`. */
  verbose?: boolean;
};

/**
 * Mount the TUI.
 *
 * The one way to start it, because one of these options is not a preference.
 * Ink exits the process on ctrl+C on its own, beside whatever the app does
 * with the key, so a mount that leaves the default on cannot cancel a turn —
 * the program is already going down. molt owns that key, and the way to make
 * that true everywhere is to leave no mount that can decide otherwise: the
 * flag is applied last and is not overridable by a caller.
 *
 * The bug this closes was invisible for exactly this reason. Production
 * mounted with the default and died on ctrl+C; the tests mounted with it off
 * and exercised handling the real program never reached.
 */
export function renderApp(props: AppProps, options: RenderOptions = {}) {
  const stdin = options.stdin ?? process.stdin;
  return render(<App {...props} />, {
    ...options,
    // Ink labels the Backspace key `delete` and cannot tell it apart from the
    // real forward-delete. Untangled in the bytes on the way in, so both keys
    // mean what they say. See src/keys.ts.
    stdin: new RemappedStdin(stdin as NodeJS.ReadStream) as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
  });
}

export function App({
  engine,
  version,
  autoShed,
  verbose: startVerbose = false,
}: AppProps) {
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
  /** True once ctrl+C has been pressed on an empty line: the next one exits. */
  const [quitArmed, setQuitArmed] = useState(false);
  const [pending, setPending] = useState<
    { name: string; detail: string; kind?: "spend" } | null
  >(null);
  const [promptChoice, setPromptChoice] = useState(0);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [tokens, setTokens] = useState(0);
  /**
   * Estimated size of the request currently in flight. Lives on the meter,
   * not only the working line, because the splash is gone by then and the
   * working line is competing with what you are typing.
   */
  const [pendingEst, setPendingEst] = useState<number | undefined>(undefined);
  /**
   * Whether a key is already stored. Read once, then updated when /login
   * succeeds — a disk read on every render of the status line is the kind
   * of work a footer should never do.
   */
  const [hasKey, setHasKey] = useState(() => Object.keys(readAuth()).length > 0);
  const [streamText, setStreamText] = useState("");
  /** The line still being written, waiting for the newline that ends it. */
  const partial = useRef("");
  /** Things typed while molt was busy, waiting for the turn to end. */
  const queued = useRef<string[]>([]);
  const [cost, setCost] = useState<number | undefined>(undefined);
  const [costEstimated, setCostEstimated] = useState(false);
  const [verbose, setVerbose] = useState(startVerbose);
  const [feed, setFeed] = useState<Feed[]>([]);
  // Read inside `note`, which must not be rebuilt every time the view opens or
  // closes — a new identity there would re-run every effect that depends on it.
  const verboseRef = useRef(startVerbose);
  /**
   * Whether the live detail is also written into the permanent transcript.
   *
   * Fixed at startup by `--verbose` and never moved by the shift+V toggle: one
   * is a request for a record, the other is a look.
   */
  const mirrorToTranscript = useRef(startVerbose);
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
    | { kind: "login-url" }
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

  /** Move the half-written line into the transcript and clear the live one. */
  const flushPartial = useCallback(() => {
    const rest = partial.current;
    partial.current = "";
    setStreamText("");
    if (rest.trim()) {
      const gap = pendingGap.current;
      pendingGap.current = false;
      setLines((prev) => [
        ...prev,
        { id: nextId.current++, tone: "agent", text: rest, ...(gap ? { gap: true } : {}) },
      ]);
    }
  }, []);

  /** A blank line seen while streaming, waiting for the row it belongs above. */
  const pendingGap = useRef(false);

  const add = useCallback((tone: Row["tone"], text: string, gap = false) => {
    setLines((prev) => [...prev, { id: nextId.current++, tone, text, ...(gap ? { gap } : {}) }]);
  }, []);

  /**
   * A streamed line of the model's own prose, blank lines and all.
   *
   * A blank one is remembered rather than added: it comes back as the gap
   * above whatever is written next, which is the only way it survives the
   * transcript. A run of them still reads as one break — a model that leaves
   * four blank lines did not mean four.
   */
  const addAgentLine = useCallback(
    (text: string) => {
      if (text.trim() === "") {
        pendingGap.current = true;
        return;
      }
      add("agent", text, pendingGap.current);
      pendingGap.current = false;
    },
    [add],
  );

  /**
   * Record a line for the live feed, and — when the view is open — for the
   * transcript as well.
   *
   * The panel has to stay a fixed height, because a live region that grows is
   * a live region a terminal cannot repaint without tearing; that was the
   * original viewer bug. But "bounded" and "truncated" are different
   * promises, and transparency needs the second one broken, not the first.
   *
   * So the panel keeps showing the tail, and the full detail goes into the
   * transcript, which is printed once and never redrawn. Your terminal's own
   * scrollback then holds every line of it, at full width, for as long as the
   * session lasts.
   */
  const note = useCallback(
    (text: string, dim = false) => {
      const id = nextId.current++;
      setFeed((prev) => {
        const next = [...prev, { id, text, dim }];
        return next.length > FEED_MEMORY ? next.slice(-FEED_MEMORY) : next;
      });
      // Only when the session was *started* with --verbose, not when someone
      // has the view open.
      //
      // The transcript is permanent: it is printed once and never redrawn, so
      // anything written into it is in the conversation for good. Mirroring
      // the feed there while the view was open meant a glance at what molt was
      // doing permanently interleaved every argument, byte count and line of
      // every result with what the model had said — and closing the view could
      // not take any of it back. Reported as the view ruining the chat log and
      // pushing the model's own words out of sight.
      //
      // So looking and recording are separate acts now. shift+V is a live
      // view that leaves no trace; `--verbose` at launch is the deliberate
      // choice to have all of it in the scrollback.
      if (mirrorToTranscript.current) {
        setLines((prev) => [...prev, { id: nextId.current++, tone: "info", text: `  ${text}` }]);
      }
    },
    [],
  );

  /**
   * A tool result, bounded on screen and whole in the record.
   *
   * Every line used to go to the live feed, so one nine-kilobyte file read put
   * two hundred entries into it and the panel showed the tail of a file dump
   * rather than what the model was doing. Reported as molt spewing and filling
   * the terminal — "not good for traceability or what the model is actually
   * doing", which is exactly right: a payload is not an account of an action.
   *
   * The earlier complaint this replaced was the opposite one — a view that
   * showed five lines of forty was asking you to trust the other thirty-five —
   * and both are satisfied by the same rule. Truncation that names what it hid
   * is not a sample. The panel shows the head and says how much more there is;
   * `--verbose` still writes every line to the transcript, because that is the
   * deliberate request for the whole thing.
   */
  const notePreview = useCallback(
    (preview: string) => {
      const lines = preview.split("\n").filter((l) => l.trim());
      if (lines.length === 0) return;
      for (const l of lines.slice(0, PREVIEW_ROWS)) note(`    │ ${l}`, true);
      if (lines.length > PREVIEW_ROWS) {
        const hidden = lines.length - PREVIEW_ROWS;
        note(`    │ … ${hidden} more line(s) — the model received all of it`, true);
        // The record still gets the rest when one was asked for.
        if (mirrorToTranscript.current) {
          setLines((prev) => [
            ...prev,
            ...lines.slice(PREVIEW_ROWS).map((l) => ({
              id: nextId.current++,
              tone: "info" as const,
              text: `    │ ${l}`,
            })),
          ]);
        }
      }
    },
    [note],
  );

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
        // What the check actually established, on the same line. "pass
        // work-landed" is a header; "2 files modified and verified byte-for-byte
        // on disk" is the finding, and it is the reason anyone should believe
        // the header. It was already computed and only shown on failure.
        const evidence = r.ok ? r.output.trim().split("\n")[0] ?? "" : "";
        add(
          r.ok ? "ok" : r.advisory ? "info" : "fail",
          `  ${label}  ${r.name}${r.exitCode !== undefined ? ` (exit ${r.exitCode})` : ""}` +
            (r.cached ? "  [reused]" : "") +
            (evidence ? `  —  ${evidence}` : ""),
        );
        // What the check actually ran, and how long it took. A passing check
        // that never ran the command you think it runs is the failure mode
        // this makes visible.
        note(`  ${r.ok ? "pass" : "FAIL"} ${r.name} · ${r.detail} · ${fmtDuration(r.durationMs)}`, true);
        if (r.ok && r.output.trim()) {
          for (const l of r.output.trim().split("\n").slice(0, 4)) note(`      ${l}`, true);
        }
        if (!r.ok) {
          // The whole failure. A check's output is the evidence for a refusal,
          // and evidence with the end cut off is an assertion.
          for (const l of r.output.trim().split("\n")) {
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
        case "delta": {
          beginActivity("responding");
          // Completed lines go straight into the transcript, which is printed
          // once and never redrawn; only the line still being written stays in
          // the live region. Capping the live region at eight rows bounded the
          // repaint — and truncated the answer to do it, which is the wrong
          // half to give up. This bounds the repaint to a single line instead
          // and shows all of it.
          partial.current += ev.text;
          let cut = partial.current.indexOf("\n");
          while (cut !== -1) {
            const line = partial.current.slice(0, cut);
            partial.current = partial.current.slice(cut + 1);
            addAgentLine(line);
            cut = partial.current.indexOf("\n");
          }
          setStreamText(partial.current);
          break;
        }
        case "cancelled":
          setPendingEst(undefined);
          flushPartial();
          // "The session is unchanged" was true of the transcript and false of
          // the disk. molt cannot un-write a file, and saying otherwise is the
          // kind of small confident wrongness this whole tool exists to refuse.
          add(
            "info",
            ev.filesWritten?.length
              ? `cancelled — the conversation is rolled back, but ${ev.filesWritten.length} file(s) ` +
                `were already written and are still on disk: ${ev.filesWritten.join(", ")}`
              : "cancelled — nothing was written, and the conversation is rolled back",
          );
          break;
        case "message_end":
          // The step's last line, which has no newline of its own to end it.
          // Without this the next step's first word landed on it — one
          // ever-growing paragraph in the live region, printed below the tools
          // it was introducing instead of above them.
          flushPartial();
          break;
        case "assistant_text":
          // A streamed answer is already on screen — `message_end` closed its
          // last line a moment ago — so this carries nothing new. A provider
          // that does not stream sent nothing until now, and gets printed whole.
          if (!ev.streamed) add("agent", ev.text);
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
          // And how much came back. Without the view open a call said only
          // that it happened — you could not tell a read of four hundred lines
          // from one of four, or a command that printed nothing from one that
          // printed a screenful. The size is the cheapest possible answer to
          // "what did that actually do", and it costs no extra row.
          const got = ev.bytes === undefined ? "" : `  → ${fmtBytes(ev.bytes)}`;
          add(
            "tool",
            `${ev.name}  ${ev.detail}${ev.note ? `  [${ev.note}]` : ""}${ev.auto ? "  [auto]" : ""}${took}${got}`,
          );
          // The exact call and the head of what came back. Verbatim: a
          // transparency view that paraphrases is one more thing to verify.
          note(`· ${ev.name} ${ev.detail}${took}`);
          if (ev.args && ev.args !== "{}") note(`    args ${ev.args.replace(/\s+/g, " ")}`, true);
          if (ev.bytes !== undefined) {
            note(`    → ${ev.bytes} bytes${ev.note ? ` · ${ev.note}` : ""}`, true);
          }
          notePreview(ev.preview ?? "");
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
          // Say what the wait is for. "thinking · 47s" is a spinner with a
          // clock on it; the step number and the size of the request are the
          // difference between waiting and watching — and the request size is
          // the number that explains the bill arriving after it.
          setPendingEst(ev.estTokens);
          beginActivity("thinking", `step ${ev.step + 1} · ~${tok(ev.estTokens)} tokens sent`);
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
          setPendingEst(undefined);
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
          // The claim was refused. It was also streamed, and a terminal cannot
          // unprint — so rather than pretend it was never said, molt closes the
          // line and marks it. Hiding the words the model actually produced
          // would be its own small dishonesty, and it is the thing the reader
          // most needs to see next to the reason it was rejected.
          flushPartial();
          add("info", "↑ that claim was refused. What follows is why.");
          renderBar(ev.result, `completion refused (attempt ${ev.attempt}) — continuing`);
          add("info", "  the failures above go back to the model; it keeps working");
          break;
        case "proof_exhausted":
          flushPartial();
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
    [add, beginActivity, flushPartial, note, renderBar],
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
      verboseRef.current = !v;
      // Said in the feed, not the transcript: a keypress that permanently
      // prints a line into the record is a keypress people stop pressing.
      note(
        v
          ? "view closed — shift+V while working, ctrl+V any time"
          : "view open: every call, argument, and result — live only, nothing added to the chat. " +
            "--verbose at launch keeps it all in the scrollback instead.",
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
        // Nothing published for this model. A price may still stand — but only
        // if it was recorded FOR this model. Keeping the last model's rate
        // because the new one publishes none is how a Claude session came to
        // be billed at grok's $2/$6 and shown a total 40% under the truth,
        // which is the exact failure this whole meter exists to prevent.
        const stored = storedEndpoint();
        if (stored.priceModel !== model && engine.pricing().in !== undefined) {
          engine.setPricing({});
          savePricing(model, null);
          add(
            "info",
            `${engine.provider} publishes no price for ${model} — the meter will show tokens ` +
              `only. The previous model's rate does not carry over. /price <in> <out> to set one.`,
          );
          return;
        }
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
      add("info", "choose a provider, or point molt at a server you run:");
      setMode({
        kind: "login-select",
        // The last row is not a provider and takes no key. It is here because
        // `/login` is where people look to connect molt to something, and a
        // model you host yourself had no door in: the keyed providers are the
        // only ones listed, so Ollama — which needs no key — never appeared,
        // and `/endpoint` was a command nobody would think to type.
        providers: [
          ...keyedProviders().map((name) => ({ name, hasKey: Boolean(stored[name]) })),
          { name: LOCAL_ROW, hasKey: false },
        ],
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
      if (ok) setHasKey(true);
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
    // The endpoint molt is pointed at right now counts as a source, keyed or
    // not. Otherwise connecting to a server you run and opening /model showed
    // the providers you hold keys for and nothing from the machine you had
    // just connected to.
    const sources = modelSources(auth, {
      url: engine.baseUrl,
      key: engine.apiKey,
      name: engine.provider,
    });
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

  /**
   * Point molt at any OpenAI-compatible server.
   *
   * Shared by `/endpoint <url>` and the "local or self-hosted…" row in
   * `/login`, because the command alone was not enough: `/login` is where
   * people look to connect molt to something, and a model you run yourself
   * had no door in there at all.
   */
  const connectEndpoint = useCallback(
    (arg: string) => {
          // `host:port` is the shape people type, and `new URL` does not
          // reject it — it reads `192.168.0.72:` as the scheme. Checking for
          // the separator first means the message names the actual mistake
          // rather than complaining about a scheme the user never wrote.
          if (!arg.includes("://")) {
            add("error", `${arg} needs the scheme too, e.g. http://${arg.replace(/^\/+/, "")}`);
            return;
          }
          let url: URL;
          try {
            url = new URL(arg);
          } catch {
            add("error", `not a URL: ${arg} — try http://localhost:11434/v1`);
            return;
          }
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            add("error", `${url.protocol} is not a scheme molt can call — use http or https`);
            return;
          }
          // A key is not asked for: the case this exists to serve is a server
          // you run, which wants none. Use /login for a provider that does.
          engine.setBaseUrl(arg.replace(/\/$/, ""), undefined, url.hostname);
          setTokens(0);
          setCost(undefined);
          setCostEstimated(false);
          persistEndpoint();
          add("ok", `endpoint → ${arg}`);
          // Reachability said now rather than discovered on the first turn —
          // and reported on `reachable`, not `ok`. Switching endpoint clears
          // the model on purpose, so `ok` is false here for a model nobody has
          // chosen yet, and reading it as reachability printed "unreachable"
          // above a line saying the endpoint answered with six models.
          void engine.doctor().then(
            (d) => {
              if (!d.reachable) {
                add("error", `unreachable: ${d.detail}`);
                return;
              }
              const n = d.models?.length;
              add("ok", n === undefined ? "reachable" : `reachable · ${n} model(s)`);
              // Said, rather than left to be noticed. A missing ceiling is
              // exactly the kind of silent change that reads as a bug later.
              if (isSelfHosted(arg)) {
                add(
                  "info",
                  "your hardware, so no spending ceiling and no budget — nobody is billing you " +
                    "for it. /budget <tokens> still sets one if you want a stop.",
                );
              }
              add("info", "/model to pick one");
            },
            (e: unknown) => add("error", `could not reach it: ${String(e)}`),
          );
          return;
    },
    [add, engine, persistEndpoint],
  );

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
        case "/budget": {
          // "$2.50" or "2.50usd" is a money ceiling for a single turn; a bare
          // number is the session's token budget. Both, because tokens are
          // what a context window is measured in and money is what a bill is.
          const money = /^\$?([\d.]+)\s*(usd|\$)?$/i.exec(arg.trim());
          if (arg.trim().startsWith("$") || /usd$/i.test(arg.trim())) {
            const usd = Number(money?.[1]);
            if (!Number.isFinite(usd) || usd < 0) {
              add("error", "usage: /budget $2.50");
              return true;
            }
            engine.setTurnBudgetUsd(usd);
            add("info", usd === 0 ? "per-turn spending ceiling removed" : `per-turn ceiling: $${usd}`);
            return true;
          }
          if (arg === "off" || arg === "") {
            engine.setBudget(undefined);
            add(
              "info",
              "budget cleared — no session budget and no per-turn ceiling. molt will now " +
                "run a turn to the 32-step guard, which on a large codebase is a real bill.",
            );
          } else {
            const n = Number(arg);
            if (!Number.isFinite(n) || n <= 0) add("error", "usage: /budget <tokens|off>");
            else {
              engine.setBudget(n);
              add("info", `budget: ${n} tokens — for the session, and for any single turn`);
            }
          }
          return true;
        }
        case "/login":
          startLogin(arg || undefined);
          return true;
        case "/endpoint": {
          if (!arg) {
            add("info", "usage: /endpoint http://192.168.0.72:11434/v1 — any OpenAI-compatible server");
            add("info", `now: ${engine.baseUrl}`);
            return true;
          }
          connectEndpoint(arg);
          return true;
        }
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
            for (const h of hits) add("info", `exuvia ${h.index}: ${h.excerpt}`);
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
            for (const l of plan.digest.split("\n")) add("info", `  ${l}`);
            add("info", "── preserved on disk (exuvia) ──");
            for (const l of plan.exuvia.split("\n")) add("info", `  ${l}`);
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
          const { path, detected, existed } = writeDefaultBar(engine.cwd);
          try {
            engine.setBar(loadBar(engine.cwd));
            add("info", existed ? `${path} already exists, left alone` : `wrote ${path}`);
            for (const c of detected) add("info", `  ${c.name.padEnd(8)} ${c.run.padEnd(26)} ${c.because}`);
            if (!existed && detected.length === 0) {
              add(
                "info",
                "no build or test commands found here, so this bar only proves work landed. " +
                  "Add your own — that is where a bar gets its value.",
              );
            }
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
          // The bar runs off-thread now, so the command hands back immediately
          // and the result arrives when it arrives — the prompt stays live
          // while a two-minute suite runs.
          void engine.proveNow().then(
            (result) => {
              if (!result) add("info", "no bar to check — /init to create one");
              else renderBar(result, result.ok ? "bar met" : "bar not met");
            },
            (e: unknown) => add("error", String(e)),
          );
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
        for await (const ev of engine.run(text, confirm, {
          ask: asking,
          // Stopping dead at the ceiling is the most expensive outcome there
          // is: the money is already spent, and ending there turns it into
          // nothing. Only offered here, where a person is watching — a
          // headless run has nobody to ask and the ceiling still stops it.
          onCeiling: (spent) =>
            new Promise<boolean>((resolve) => {
              setPending({ name: "spend", detail: spent, kind: "spend" });
              setPromptChoice(1); // stopping is the default; carrying on is deliberate
              resolver.current = resolve;
            }),
        })) handleEvent(ev);
      } catch (e) {
        add("error", String(e));
      } finally {
        setBusy(false);
        setPendingEst(undefined);
        // A press that cancelled this turn must not still be armed against
        // the next one.
        setQuitArmed(false);
      }

      // Anything typed while that ran goes now, in the order it was typed.
      const next = queued.current.shift();
      if (next) submitRef.current?.(next);
    },
    [add, beginActivity, command, confirm, engine, handleEvent],
  );

  useEffect(() => {
    submitRef.current = (text, opts) => void submit(text, opts);
  }, [submit]);

  useInput((char, key) => {
    // Any other key means you did not mean to quit. Disarmed here rather than
    // on a timer, so the offer cannot expire between reading it and acting on
    // it — and cannot linger into a session you have gone back to using.
    if (quitArmed && !(key.ctrl && char === "c")) setQuitArmed(false);

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

    // --- while a turn runs: ctrl+C cancels it, and you can still type ---
    //
    // Typing used to be swallowed entirely, so a thought that arrived while
    // molt was working had to be held in your head until it finished. There is
    // no reason for that: the line is yours, and enter queues it for the moment
    // the turn ends.
    //
    // shift+V and shift+A still work here, but only on an empty line — the same
    // rule as at an idle prompt. A letter is a command when there is nothing to
    // type it into, and a letter otherwise.
    if (busy) {
      if (key.ctrl && char === "c") {
        // First press asks the turn to stop. If it is still running by the
        // next press, the turn is not listening — and molt does not get to
        // hold the terminal hostage while it decides. The second press leaves.
        //
        // This is a backstop, not the mechanism: a hung salvage used to make
        // ctrl+C do nothing at all, and while that particular hang is fixed,
        // "you can always get out" should not depend on having fixed every
        // possible hang.
        if (quitArmed) {
          exit();
          return;
        }
        setQuitArmed(true);
        engine.cancel();
        return;
      }
      if (input === "" && char === "V" && !key.ctrl && !key.meta) {
        toggleVerbose();
        return;
      }
      if (input === "" && char === "A" && !key.ctrl && !key.meta) {
        cycleAutonomy();
        return;
      }
      if (key.return) {
        const text = input.trim();
        if (text) {
          setInput("");
          // A few commands are worth running *now*, and the ceiling warning is
          // the reason. molt says "this turn: $0.53 of $1.00 — /budget raises
          // it" on the way up, and then queued the answer until after the turn
          // it was warning about had already been stopped. The advice was
          // impossible to take.
          //
          // The engine reads the ceiling at the top of every step, so a limit
          // raised mid-turn applies to the next one. Only limits, though:
          // switching model or endpoint halfway through a conversation is a
          // different thing entirely and still waits its turn.
          if (RUNS_MID_TURN.has(text.split(/\s+/)[0]!.toLowerCase())) {
            command(text);
          } else {
            queued.current.push(text);
            add("info", `queued — molt will start this when the current turn ends: ${text}`);
          }
        }
        return;
      }
      if (key.leftArrow) return edit(key.meta || key.ctrl ? wordLeft : left);
      if (key.rightArrow) return edit(key.meta || key.ctrl ? wordRight : right);
      if (key.backspace) return edit(key.meta ? deleteWord : backspace);
      if (key.delete) return edit(deleteForward);
      if (key.ctrl && char === "w") return edit(deleteWord);
      if (key.ctrl && char === "u") return edit(killToStart);
      if (key.ctrl && char === "k") return edit(killToEnd);
      if (char && !key.ctrl && !key.meta) edit((l) => insert(l, char));
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
          if (provider === LOCAL_ROW) {
            add(
              "info",
              "enter the base URL — e.g. http://localhost:11434/v1, or http://192.168.0.72:11434/v1 " +
                "for a box on your network. enter to connect, esc to cancel",
            );
            setMode({ kind: "login-url" });
            return;
          }
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
    if (mode.kind === "login-url") {
      if (key.escape || (key.ctrl && char === "c")) {
        setInput("");
        setMode({ kind: "chat" });
        add("info", "cancelled");
        return;
      }
      if (key.return) {
        const value = input.trim();
        setInput("");
        setMode({ kind: "chat" });
        if (value) connectEndpoint(value);
        return;
      }
      if (key.backspace || key.delete) {
        edit(key.meta ? deleteWord : backspace);
        return;
      }
      if (char && !key.ctrl && !key.meta) edit((l) => insert(l, char));
      return;
    }

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

    // ctrl+C at an idle prompt clears the line; only on an already-empty line,
    // and only twice in a row, does it end the session. A single press used to
    // quit outright — which threw away a half-typed prompt for the keystroke
    // every other REPL uses to take one back.
    if (key.ctrl && char === "c") {
      if (input !== "") {
        setInput("");
        setPaletteIndex(0);
        setQuitArmed(false);
        return;
      }
      if (quitArmed) {
        exit();
        return;
      }
      setQuitArmed(true);
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
      // alt/ctrl + arrow moves by words, as every other prompt does.
      edit(key.meta || key.ctrl ? wordLeft : left);
      return;
    }
    if (key.rightArrow) {
      edit(key.meta || key.ctrl ? wordRight : right);
      return;
    }
    if (key.meta && (char === "d" || char === "D")) {
      edit(deleteWordForward);
      setPaletteIndex(0);
      return;
    }
    if (key.backspace) {
      // alt+Backspace deletes the word behind the caret, the way every shell
      // does. It was unreachable before: the terminal sends `ESC 0x7f`, which
      // Ink called meta+delete, so it fell into the forward-delete guess below
      // and took a single character off the front instead.
      edit(key.meta ? deleteWord : backspace);
      setPaletteIndex(0);
      return;
    }
    if (key.delete) {
      // Only the real forward-delete reaches here now: Backspace is remapped to
      // 0x08 on the way in, so it arrives above as `key.backspace`. This used to
      // guess between the two from the caret position, which is why it deleted
      // the right character at the end of a line and the wrong one everywhere
      // else.
      edit(deleteForward);
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
            <Text key={item.key} color={toneColor[item.row.tone]} wrap="wrap">
              {(item.row.gap ? "\n" : "") +
                (item.row.tone === "user" ? "› " : item.row.tone === "tool" ? "· " : "  ") +
                item.row.text}
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

      {/* The line currently being written. Every completed line is already in
          the transcript above, so this is one line at most — bounded without
          being truncated, and wrapped rather than clipped. */}
      {streamText ? (
        <Box marginTop={1}>
          <Text color={theme.accent} wrap="wrap">
            {"  "}
            {streamText}
            <Text color={theme.dim}>▌</Text>
          </Text>
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
          <Text color={theme.warn} wrap="wrap">
            {pending.kind === "spend"
              ? `this turn has spent ${pending.detail} — its ceiling. Carrying on doubles it; ` +
                `stopping keeps what has been found so far and reports it.`
              : `allow ${pending.name}: ${pending.detail}`}
          </Text>
          <Box>
            {(pending.kind === "spend" ? ["carry on", "stop here"] : ["allow", "deny"]).map((label, i) => (
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
                    {p.hasKey && (
                      <Text color={theme.ghost}>
                        {fit("key stored — will overwrite")}
                      </Text>
                    )}
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
              {(() => {
                const win = windowRows(mode.rows, mode.index);
                const above = win[0]?.i ?? 0;
                const below = mode.rows.length - 1 - (win.at(-1)?.i ?? 0);
                return (
                  <>
                    {above > 0 && <Text color={theme.ghost}>   ↑ {above} more</Text>}
                    {win.map(({ row, i }) =>
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
                          {fit(row.choice.id)}
                          {row.choice.id === engine.model &&
                          row.choice.provider === engine.provider ? (
                            <Text color={theme.ghost}>{"  ← now"}</Text>
                          ) : null}
                        </Text>
                      ),
                    )}
                    {below > 0 && <Text color={theme.ghost}>   ↓ {below} more</Text>}
                  </>
                );
              })()}
              <Text color={theme.ghost}>   ↑↓ choose · enter select · esc cancel</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              {busy ? (
                <>
                  {/*
                    One wrapping Text, and the typed line on a row of its own.
                    These used to be flex siblings on a single row, which the
                    terminal CLIPS rather than reflows — so making this line say
                    more about what it was waiting for pushed the user's own
                    half-typed message off the right edge and it looked like
                    typing had stopped working. What molt has to say may not
                    cost you sight of what you are saying.
                  */}
                  <Text wrap="wrap">
                    <Text color={theme.accent}>{SPINNER[frame % SPINNER.length]} </Text>
                    <Text color={theme.dim}>{activity?.label ?? "working"}</Text>
                    {/* What it is working ON, not just that it is working. */}
                    {activity?.what ? <Text color={theme.dim}>{` \u00b7 ${activity.what}`}</Text> : null}
                    {activity ? (
                      <Text color={theme.ghost}>
                        {` \u00b7 ${fmtDuration(Date.now() - activity.since)}`}
                      </Text>
                    ) : null}
                    <Text color={theme.ghost}>
                      {` \u00b7 ${verbose ? "shift+V closes" : "shift+V to watch"}`}
                      {quitArmed ? " \u00b7 ctrl+C again to exit" : " \u00b7 ctrl+C stops this turn"}
                    </Text>
                  </Text>
                  {/* The line is still yours while it works. Same editor as
                      the idle prompt, including the caret: the keys already
                      moved it, and drawing without it made a mid-turn typo
                      look unfixable. */}
                  {input ? (
                    <Text color={theme.text} wrap="wrap">
                      <Text color={theme.dim}>{"  › "}</Text>
                      <PromptBody entry={entry} room={Math.max(8, room - 4)} theme={theme} />
                    </Text>
                  ) : null}
                </>
              ) : (
                <>
                  {/* One Text, not several side by side.
                      Siblings in a Box are laid out as flex children: they sit
                      in a row and are CLIPPED at the edge of the terminal
                      rather than reflowed, so a prompt longer than the window
                      lost its tail and left the caret parked at the cut. Text
                      nested inside Text is a single inline run, which wraps —
                      and the caret wraps with it, because it is part of the
                      same run. A pasted key is still echoed as dots. */}
                  <Text color={theme.text} wrap="wrap">
                    <Text color={theme.dim}>
                      {mode.kind === "login-key" ? "key " : mode.kind === "login-url" ? "url " : "› "}
                    </Text>
                    <PromptBody
                      entry={entry}
                      room={room}
                      secret={mode.kind === "login-key"}
                      theme={theme}
                    />
                  </Text>
                  {/* The offer, where the keystroke that made it is looking.
                      A press that silently does nothing reads as a hang. */}
                  {quitArmed && (
                    <Text color={theme.ghost}>{"  ctrl+C again to exit"}</Text>
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
                            {commandLabel(c).padEnd(COMMAND_COL)}
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
          hint: hasKey ? "/model" : "/login",
          budgetTokens: engine.budgetTokens,
          pendingEst,
        }}
      />
    </Box>
  );
}
