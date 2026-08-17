/**
 * The TUI.
 *
 * Deliberately plain. The interesting part of molt is the loop, and a
 * terminal interface earns its keep by getting out of the way — showing the
 * work, the receipts, and the refusals, and nothing else.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Banner, fmtDuration } from "./banner.js";
import { COMMANDS, completionFor, matchCommands, windowAround, wrapIndex } from "./commands.js";
import { StatusLine } from "./status-line.js";
import { loadBar, writeDefaultBar, BarError } from "./bar.js";
import type { Engine } from "./engine.js";
import {
  PROVIDERS,
  defaultConfigDir,
  firstSelectable,
  keyedProviders,
  modelSources,
  moveSelection,
  pickerRows,
  readAuth,
  resolveProvider,
  saveEndpoint,
  saveKey,
  windowRows,
  type ModelChoice,
  type PickerRow,
} from "./providers.js";
import { DEFAULT_THEME, getTheme, nextTheme } from "./theme.js";
import type { BarResult, EngineEvent } from "./types.js";

type Line = {
  id: number;
  tone: "user" | "agent" | "tool" | "info" | "error" | "ok" | "fail";
  text: string;
};

const HELP = [
  "commands",
  ...COMMANDS.map((c) => `  ${(c.name + (c.args ? " " + c.args : "")).padEnd(20)}${c.summary}`),
  "",
  "  type / to browse · ↑↓ to choose · tab to fill · enter to run",
].join("\n");

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
}: {
  engine: Engine;
  version: string;
  autoShed?: number;
}) {
  const { exit } = useApp();
  const [themeName, setThemeName] = useState(DEFAULT_THEME);
  const theme = getTheme(themeName);

  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ name: string; detail: string } | null>(null);
  const [promptChoice, setPromptChoice] = useState(0);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [streamText, setStreamText] = useState("");
  const [cost, setCost] = useState<number | undefined>(undefined);

  // Picker state. `login-key` is the one mode that must never echo what you
  // type, so it is a distinct state rather than a flag on a shared one.
  type Mode =
    | { kind: "chat" }
    | { kind: "login-select"; providers: { name: string; hasKey: boolean }[]; index: number }
    | { kind: "login-key"; provider: string }
    | { kind: "model-select"; rows: PickerRow[]; index: number };
  const [mode, setMode] = useState<Mode>({ kind: "chat" });

  // What the model is doing right now, and since when. Held separately from
  // `busy` because the turn stays busy across several distinct phases.
  const [activity, setActivity] = useState<{ label: string; since: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const nextId = useRef(0);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const add = useCallback((tone: Line["tone"], text: string) => {
    setLines((prev) => [...prev, { id: nextId.current++, tone, text }]);
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

  /** Name the current phase, restarting the clock only when it actually changes. */
  const beginActivity = useCallback((label: string) => {
    setActivity((a) => (a?.label === label ? a : { label, since: Date.now() }));
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
      for (const r of result.results) {
        add(
          r.ok ? "ok" : "fail",
          `  ${r.ok ? "pass" : "FAIL"}  ${r.name}${r.exitCode !== undefined ? ` (exit ${r.exitCode})` : ""}`,
        );
        if (!r.ok) {
          for (const l of r.output.trim().split("\n").slice(0, 8)) add("fail", `        ${l}`);
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
          "everything else passed. work-landed requires this turn to have changed a file,\n" +
            "so a question, a greeting, or read-only work can never satisfy it — that is what\n" +
            "the README means by 'files-changed fails read-only tasks by design'.\n" +
            "for a session of questions rather than changes, start molt with --skip session.",
        );
      }
    },
    [add],
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
          beginActivity(ev.name);
          break;
        case "tool": {
          // The duration earns its place next to the call it describes, not
          // in a summary at the end where it cannot be acted on.
          const took = ev.durationMs === undefined ? "" : `  ${fmtDuration(ev.durationMs)}`;
          add("tool", `${ev.name}  ${ev.detail}${ev.note ? `  [${ev.note}]` : ""}${took}`);
          beginActivity("thinking");
          break;
        }
        case "usage":
          setTokens(ev.sessionTokens);
          setCost(ev.costUsd);
          break;
        case "proof_start":
          beginActivity("checking the bar");
          add("info", `checking ${ev.checks} condition(s) from .molt/done.yml`);
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
    [add, beginActivity, renderBar],
  );

  /** Remember the endpoint so the next bare `molt` starts where this left off. */
  const persistEndpoint = useCallback(() => {
    if (engine.model) saveEndpoint(engine.baseUrl, engine.model);
  }, [engine]);

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
      // is usable now rather than after a restart.
      if (preset) {
        engine.setBaseUrl(preset.url, key, provider);
        setTokens(0);
        setCost(undefined);
      }
      add(
        ok ? "ok" : "error",
        ok
          ? `key saved for ${provider} → ${defaultConfigDir()}/auth.json (0600) · /model to pick one`
          : `could not write ${defaultConfigDir()}/auth.json — key held for this session only`,
      );
    },
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
          setTokens(0);
          return true;
        case "/bom": {
          const b = engine.bom();
          add(
            "info",
            `system ${b.systemTokens} · tools ${b.toolSchemaTokens} · history ${b.historyTokens} · ` +
              `request ≈ ${b.requestTotalEst} · session ${b.sessionPromptTokens + b.sessionCompletionTokens}` +
              (b.budgetTokens ? ` / ${b.budgetTokens}` : ""),
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
          }
          return true;
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
              `${st.tokensPerVerifiedChange ?? "—"} tokens per verified change`,
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
    [add, engine, exit, persistEndpoint, renderBar, startLogin, startModelPicker, themeName],
  );

  const submit = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      if (text.startsWith("/")) {
        if (!command(text)) add("error", `unknown command: ${text.split(/\s+/)[0]}`);
        return;
      }
      // Refuse rather than fire a request at an endpoint with no model. The
      // failure would otherwise surface as an opaque provider error.
      if (!engine.model) {
        add("error", "no model selected — /login to add a provider key, then /model to pick one");
        return;
      }
      add("user", text);
      setBusy(true);
      beginActivity("thinking");
      try {
        for await (const ev of engine.run(text, confirm)) handleEvent(ev);
      } catch (e) {
        add("error", String(e));
      } finally {
        setBusy(false);
      }
    },
    [add, beginActivity, command, confirm, engine, handleEvent],
  );

  useInput((char, key) => {
    // --- permission prompt: arrows choose, enter commits, no typing ---
    if (pending) {
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

    // --- mid-stream: Ctrl-C cancels the turn rather than killing molt ---
    if (busy) {
      if (key.ctrl && char === "c") engine.cancel();
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
        setInput((v) => v.slice(0, -1));
        return;
      }
      if (char && !key.ctrl && !key.meta) setInput((v) => v + char);
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
    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
      setPaletteIndex(0);
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      setInput((s) => s + char);
      setPaletteIndex(0);
    }
  });

  const toneColor: Record<Line["tone"], string> = {
    user: theme.text,
    agent: theme.accent,
    tool: theme.dim,
    info: theme.dim,
    error: theme.fail,
    ok: theme.ok,
    fail: theme.fail,
  };

  return (
    <Box flexDirection="column">
      <Banner
        theme={theme}
        themeName={themeName}
        animate
        version={version}
      />

      <Box flexDirection="column" marginTop={1}>
        {lines.map((l) => (
          <Text key={l.id} color={toneColor[l.tone]}>
            {l.tone === "user" ? "› " : l.tone === "tool" ? "· " : "  "}
            {l.text}
          </Text>
        ))}
      </Box>

      {streamText ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>{streamText}</Text>
          <Text color={theme.dim}>▌</Text>
        </Box>
      ) : null}

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
          <Text color={theme.ghost}>  ←→ choose · enter confirm · esc deny</Text>
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
                  {activity && (
                    <Text color={theme.ghost}>
                      {" \u00b7 "}
                      {fmtDuration(Date.now() - activity.since)}
                    </Text>
                  )}
                </>
              ) : (
                <>
                  <Text color={theme.dim}>{mode.kind === "login-key" ? "🔑 " : "› "}</Text>
                  {/* A pasted key is echoed as dots — it must not survive on
                      screen or in a scrollback buffer. */}
                  <Text color={theme.text}>
                    {mode.kind === "login-key" ? "•".repeat(input.length) : input}
                  </Text>
                  <Text color={theme.accent}>▌</Text>
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
          budgetTokens: engine.budgetTokens,
        }}
      />
    </Box>
  );
}
