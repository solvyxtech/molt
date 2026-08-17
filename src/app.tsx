/**
 * The TUI.
 *
 * Deliberately plain. The interesting part of molt is the loop, and a
 * terminal interface earns its keep by getting out of the way — showing the
 * work, the receipts, and the refusals, and nothing else.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Banner } from "./banner.js";
import { COMMANDS, completionFor, matchCommands, wrapIndex } from "./commands.js";
import { StatusLine } from "./status-line.js";
import { loadBar, writeDefaultBar, BarError } from "./bar.js";
import type { Engine } from "./engine.js";
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
  const showPalette = matches.length > 0 && !busy && !pending;
  const selected = matches[wrapIndex(paletteIndex, matches.length)];

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
    },
    [add],
  );

  const handleEvent = useCallback(
    (ev: EngineEvent) => {
      switch (ev.kind) {
        case "delta":
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
        case "tool":
          add("tool", `${ev.name}  ${ev.detail}${ev.note ? `  [${ev.note}]` : ""}`);
          break;
        case "usage":
          setTokens(ev.sessionTokens);
          setCost(ev.costUsd);
          break;
        case "proof_start":
          add("info", `checking ${ev.checks} condition(s) from .molt/done.yml`);
          break;
        case "proof_result":
          renderBar(ev.result, "bar met");
          break;
        case "proof_refused":
          renderBar(ev.result, `completion refused (attempt ${ev.attempt}) — continuing`);
          break;
        case "proof_exhausted":
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
    [add, renderBar],
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
        case "/model":
          if (!arg) add("error", "usage: /model <id>");
          else {
            engine.setModel(arg);
            add("info", `model: ${arg}`);
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
    [add, engine, exit, renderBar, themeName],
  );

  const submit = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      if (text.startsWith("/")) {
        if (!command(text)) add("error", `unknown command: ${text.split(/\s+/)[0]}`);
        return;
      }
      add("user", text);
      setBusy(true);
      try {
        for await (const ev of engine.run(text, confirm)) handleEvent(ev);
      } catch (e) {
        add("error", String(e));
      } finally {
        setBusy(false);
      }
    },
    [add, command, confirm, engine, handleEvent],
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
        status={{
          provider: engine.provider,
          model: engine.model,
          sessionTokens: tokens,
          costUsd: cost,
          budgetTokens: engine.budgetTokens,
        }}
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
          <Box>
            <Text color={theme.dim}>{busy ? "· " : "› "}</Text>
            <Text color={theme.text}>{input}</Text>
            {!busy && <Text color={theme.accent}>▌</Text>}
          </Box>

          {showPalette && (
            <Box flexDirection="column" marginTop={0}>
              {matches.slice(0, PALETTE_ROWS).map((c) => {
                const active = c.name === selected?.name;
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
              {matches.length > PALETTE_ROWS && (
                <Text color={theme.ghost}>   … {matches.length - PALETTE_ROWS} more</Text>
              )}
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
