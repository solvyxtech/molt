import React, { useCallback, useState } from "react";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import type { Engine, EngineEvent, Confirm, Bom } from "./engine.js";
import { reduceEvent, appendCapped, type Line } from "./transcript.js";
import { THEMES, DEFAULT_THEME, TAGLINE, type Theme } from "./theme.js";
import { Banner } from "./banner.js";

/** Structural interface so tests can pass a fake engine. */
export type MoltEngine = Pick<
  Engine,
  | "run"
  | "bom"
  | "reset"
  | "setBudget"
  | "model"
  | "budgetTokens"
  | "shed"
  | "attach"
  | "probe"
  | "doctor"
  | "lastRequestBody"
  | "setModel"
  | "setApiKey"
  | "setBaseUrl"
  | "listModels"
  | "baseUrl"
>;

export type ModelChoice = {
  provider: string;
  id: string;
  url: string;
  key?: string;
};

/** Provider presets for /connect and the /login picker. */
export const PROVIDERS: Record<string, { url: string; needsKey: boolean; hint?: string }> = {
  ollama: { url: "http://localhost:11434/v1", needsKey: false },
  openrouter: { url: "https://openrouter.ai/api/v1", needsKey: true },
  anthropic: {
    url: "https://api.anthropic.com/v1",
    needsKey: true,
    hint: "Console API key (metered) — subscription logins are not permitted in third-party tools",
  },
  openai: { url: "https://api.openai.com/v1", needsKey: true },
  xai: { url: "https://api.x.ai/v1", needsKey: true },
  groq: { url: "https://api.groq.com/openai/v1", needsKey: true },
};

type PendingPermission = {
  detail: string;
  resolve: (allowed: boolean) => void;
};

export function App({
  engine,
  initialNotice,
  customTheme,
  animateBanner = false,
  artifactDir = ".molt",
  configDir = join(homedir(), ".config", "molt"),
}: {
  engine: MoltEngine;
  initialNotice?: string;
  customTheme?: Theme;
  animateBanner?: boolean;
  /** Where exuviae and wire dumps are written (cwd-relative). */
  artifactDir?: string;
  /** Where auth.json / config.json live. */
  configDir?: string;
}) {
  const { exit } = useApp();
  const [themeName, setThemeName] = useState(
    customTheme ? "custom" : DEFAULT_THEME,
  );
  const theme: Theme =
    themeName === "custom" && customTheme
      ? customTheme
      : (THEMES[themeName] ?? THEMES[DEFAULT_THEME]);
  const [lines, setLines] = useState<Line[]>(
    initialNotice ? [{ kind: "info", text: initialNotice }] : [],
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [sessionTok, setSessionTok] = useState(0);
  const [cost, setCost] = useState<number | undefined>(undefined);
  const [raceModels, setRaceModels] = useState<string[] | null>(null);
  type Mode =
    | { kind: "chat" }
    | { kind: "login-select" }
    | { kind: "login-key"; provider: string }
    | { kind: "model-select"; choices: ModelChoice[] };
  const [mode, setMode] = useState<Mode>({ kind: "chat" });

  const push = useCallback((l: Line) => {
    setLines((prev) => appendCapped(prev, l));
  }, []);

  const confirm: Confirm = useCallback(
    (name, detail) =>
      new Promise<boolean>((resolve) => {
        setPending({ detail: `${name} ${detail}`, resolve });
      }),
    [],
  );

  const runTurn = useCallback(
    async (prompt: string) => {
      setBusy(true);
      try {
        for await (const ev of engine.run(prompt, confirm)) {
          setLines((prev) => reduceEvent(prev, ev as EngineEvent));
          if (ev.kind === "usage") {
            setSessionTok(ev.sessionTokens);
            setCost(ev.costUsd);
          }
        }
      } catch (err) {
        push({ kind: "error", text: String(err) });
      } finally {
        setBusy(false);
        setPending(null);
      }
    },
    [engine, confirm, push],
  );

  const readJson = useCallback((file: string): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(join(configDir, file), "utf8"));
    } catch {
      return {};
    }
  }, [configDir]);

  const writeJson = useCallback((file: string, data: Record<string, string>, secret = false) => {
    try {
      mkdirSync(configDir, { recursive: true });
      const p = join(configDir, file);
      writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
      if (secret) chmodSync(p, 0o600);
      return true;
    } catch {
      return false;
    }
  }, [configDir]);

  const persistEndpoint = useCallback(() => {
    writeJson("config.json", {
      ...readJson("config.json"),
      baseUrl: engine.baseUrl,
      model: engine.model,
    });
  }, [engine, readJson, writeJson]);

  const doConnect = useCallback((name: string) => {
    const p = PROVIDERS[name];
    if (!p) {
      push({ kind: "info", text: `providers: ${Object.keys(PROVIDERS).join("  ")}` });
      return;
    }
    const storedKey = readJson("auth.json")[name];
    engine.setBaseUrl(p.url, storedKey);
    setSessionTok(0);
    persistEndpoint();
    const keyMsg = !p.needsKey
      ? "no key needed"
      : storedKey
        ? "using stored key"
        : "no key stored — /login to add one";
    push({ kind: "info", text: `connected: ${name} (${p.url}) · ${keyMsg} · /model to pick a model` });
    if (p.hint) push({ kind: "info", text: `note: ${p.hint}` });
  }, [engine, push, readJson, persistEndpoint]);

  const finishLogin = useCallback((provider: string, key: string) => {
    setMode({ kind: "chat" });
    if (!key) {
      push({ kind: "info", text: "login cancelled" });
      return;
    }
    const p = PROVIDERS[provider];
    const ok = writeJson("auth.json", { ...readJson("auth.json"), [provider]: key }, true);
    if (p && engine.baseUrl === p.url) engine.setApiKey(key); // live if it's the active endpoint
    push({
      kind: "info",
      text: `key saved for ${provider}${ok ? ` → ${join(configDir, "auth.json")} (0600)` : " (persist failed — session only)"} · /model to browse its models · /login to add another`,
    });
  }, [engine, push, readJson, writeJson, configDir]);

  const startLogin = useCallback(() => {
    const stored = readJson("auth.json");
    const rows = Object.entries(PROVIDERS)
      .filter(([, p]) => p.needsKey)
      .map(([name], i) => `  ${i + 1}. ${name}${stored[name] ? "  (key stored — will overwrite)" : ""}`);
    push({
      kind: "info",
      text: `add a key — pick a provider:\n${rows.join("\n")}\ntype a number or name · esc to cancel`,
    });
    setMode({ kind: "login-select" });
  }, [push, readJson]);

  const resolveProvider = useCallback((sel: string): string | null => {
    const keyed = Object.keys(PROVIDERS).filter((n) => PROVIDERS[n].needsKey);
    const n = parseInt(sel, 10);
    if (Number.isFinite(n) && n >= 1 && n <= keyed.length) return keyed[n - 1];
    return keyed.includes(sel) ? sel : null;
  }, []);

  /** Aggregate models across every provider you hold a key for (+ local ollama). */
  const startModelPicker = useCallback(async () => {
    const stored = readJson("auth.json");
    const sources = Object.entries(PROVIDERS)
      .filter(([name, p]) => !p.needsKey || stored[name])
      .map(([name, p]) => ({ name, url: p.url, key: stored[name] as string | undefined }));
    if (!sources.length) {
      push({ kind: "info", text: "no provider keys yet — /login to add one" });
      return;
    }
    setBusy(true);
    const results = await Promise.all(
      sources.map(async (s) => ({ ...s, r: await engine.listModels(s.url, s.key) })),
    );
    setBusy(false);
    const choices: ModelChoice[] = [];
    const blocks: string[] = [];
    let shown = 0;
    for (const s of results) {
      if (!s.r.ok) {
        if (s.name !== "ollama") blocks.push(`${s.name}: unreachable (${s.r.error})`);
        continue;
      }
      const all = s.r.ids.map((id) => ({ provider: s.name, id, url: s.url, key: s.key }));
      choices.push(...all);
      const display = all.slice(0, 12);
      blocks.push(
        `${s.name}:\n` +
          display.map((c) => `  ${++shown}. ${c.id}`).join("\n") +
          (all.length > display.length ? `\n  …+${all.length - display.length} more (type any full name)` : ""),
      );
    }
    if (!choices.length) {
      push({ kind: "error", text: "no models found on any keyed provider — /doctor each, or /login again" });
      return;
    }
    push({
      kind: "info",
      text: `models across your keys:\n${blocks.join("\n")}\ntype a number or full model name · esc to cancel`,
    });
    setMode({ kind: "model-select", choices });
  }, [engine, push, readJson]);

  const pickModel = useCallback((choices: ModelChoice[], sel: string) => {
    setMode({ kind: "chat" });
    const visible = choices; // numbers index the shown order across providers
    const n = parseInt(sel, 10);
    let c: ModelChoice | undefined;
    if (Number.isFinite(n) && n >= 1) {
      // numbering matched display order: first 12 per provider in sequence
      const numbered: ModelChoice[] = [];
      const byProv = new Map<string, ModelChoice[]>();
      for (const ch of choices) {
        const arr = byProv.get(ch.provider) ?? [];
        arr.push(ch);
        byProv.set(ch.provider, arr);
      }
      for (const arr of byProv.values()) numbered.push(...arr.slice(0, 12));
      c = numbered[n - 1];
    }
    c ??= visible.find((ch) => ch.id === sel || `${ch.provider}/${ch.id}` === sel);
    if (!c) {
      push({ kind: "info", text: `no match for '${sel}' — /model to list again` });
      return;
    }
    if (engine.baseUrl !== c.url) {
      engine.setBaseUrl(c.url, c.key);
      setSessionTok(0);
    }
    engine.setModel(c.id);
    persistEndpoint();
    push({ kind: "info", text: `model → ${c.provider}/${c.id}` });
  }, [engine, push, persistEndpoint]);

  const doModel = useCallback((arg?: string) => {
    if (arg) {
      engine.setModel(arg);
      persistEndpoint();
      push({ kind: "info", text: `model → ${arg}` });
      return;
    }
    setBusy(true);
    void engine.listModels().then((r) => {
      if (r.ok) {
        const shown = r.ids.slice(0, 24);
        push({
          kind: "info",
          text: `models @ ${engine.baseUrl}:\n  ${shown.join("\n  ")}${r.ids.length > shown.length ? `\n  …+${r.ids.length - shown.length} more` : ""}\nuse: /model <name>`,
        });
      } else {
        push({ kind: "error", text: `model list: ${r.error}` });
      }
      setBusy(false);
    });
  }, [engine, push, persistEndpoint]);

  const runRace = useCallback(
    async (prompt: string, models: string[]) => {
      setBusy(true);
      try {
        const results: { m: string; tok: number; ms: number }[] = [];
        for (const m of models) {
          push({ kind: "info", text: `── ${m} ──` });
          const r = await engine.probe(prompt, m);
          if (!r.ok) {
            push({ kind: "error", text: `${m}: ${r.error}` });
            continue;
          }
          push({ kind: "assistant", text: r.text || "(empty)" });
          push({
            kind: "info",
            text: `✓ ${r.promptTokens}→${r.completionTokens} tok · ${(r.ms / 1000).toFixed(1)}s`,
          });
          results.push({ m, tok: r.promptTokens + r.completionTokens, ms: r.ms });
        }
        if (results.length > 1) {
          const fastest = [...results].sort((a, b) => a.ms - b.ms)[0].m;
          const leanest = [...results].sort((a, b) => a.tok - b.tok)[0].m;
          push({
            kind: "info",
            text: `race: fastest ${fastest} · leanest ${leanest} · (isolated, tool-less probes)`,
          });
        }
      } finally {
        setBusy(false);
        setRaceModels(null);
      }
    },
    [engine, push],
  );

  const doShed = useCallback(() => {
    const r = engine.shed();
    if (!r) {
      push({ kind: "info", text: "nothing to shed yet (kept last 2 exchanges)" });
      return;
    }
    let where = "(archive write failed)";
    try {
      const dir = join(resolve(process.cwd(), artifactDir), "exuviae");
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `${Date.now()}.md`);
      writeFileSync(p, r.exuvia, "utf8");
      where = p;
    } catch {
      /* archive is best-effort; context shed still applied */
    }
    push({
      kind: "info",
      text: `shed ${r.droppedCount} messages · history ${r.beforeTokens}→${r.afterTokens} tok (est) · 0 tokens spent · full copy: ${where}`,
    });
  }, [engine, push, artifactDir]);

  const doRegrow = useCallback(() => {
    try {
      const dir = join(resolve(process.cwd(), artifactDir), "exuviae");
      const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
      if (!files.length) {
        push({ kind: "info", text: "no exuviae to regrow from" });
        return;
      }
      const p = join(dir, files[files.length - 1]);
      const text = readFileSync(p, "utf8");
      engine.attach(text);
      push({
        kind: "info",
        text: `regrew ${files[files.length - 1]} · +${Math.ceil(text.length / 4)} tok (est) re-attached`,
      });
    } catch (e) {
      push({ kind: "error", text: `regrow failed: ${String(e)}` });
    }
  }, [engine, push, artifactDir]);

  const doWire = useCallback(() => {
    const body = engine.lastRequestBody;
    if (!body) {
      push({ kind: "info", text: "no request sent yet" });
      return;
    }
    let where = "(write failed)";
    try {
      const dir = resolve(process.cwd(), artifactDir);
      mkdirSync(dir, { recursive: true });
      const p = join(dir, "wire.json");
      writeFileSync(p, body, "utf8");
      where = p;
    } catch {
      /* best effort */
    }
    push({
      kind: "info",
      text: `wire: last request ${Buffer.byteLength(body, "utf8")}B ≈${Math.ceil(body.length / 4)} tok · exact JSON: ${where}`,
    });
  }, [engine, push, artifactDir]);

  const printBom = useCallback(() => {
    const b: Bom = engine.bom();
    push({
      kind: "info",
      text:
        `bom (est): system ${b.systemTokens} · tool schemas ${b.toolSchemaTokens} · ` +
        `history ${b.historyTokens} · next request ≈${b.requestTotalEst} tok`,
    });
    const cost =
      b.costUsd !== undefined ? ` · $${b.costUsd.toFixed(4)}` : "";
    push({
      kind: "info",
      text:
        `session (real): ${b.sessionPromptTokens} in / ${b.sessionCompletionTokens} out${cost}` +
        (b.budgetTokens ? ` · budget ${b.budgetTokens}` : " · no budget"),
    });
  }, [engine, push]);

  const handleCommand = useCallback(
    (raw: string): boolean => {
      const [cmd, arg] = raw.split(/\s+/, 2);
      switch (cmd) {
        case "/quit":
        case "/exit":
          exit();
          return true;
        case "/new":
          engine.reset();
          setSessionTok(0);
          push({ kind: "info", text: "new session" });
          return true;
        case "/bom":
          printBom();
          return true;
        case "/connect":
          doConnect(arg ?? "");
          return true;
        case "/login":
          startLogin();
          return true;
        case "/model":
          if (arg) doModel(arg);
          else void startModelPicker();
          return true;
        case "/doctor":
          setBusy(true);
          void engine.doctor().then((r) => {
            push(r.ok ? { kind: "info", text: `doctor: ${r.detail}` }
                      : { kind: "error", text: `doctor: ${r.detail}` });
            setBusy(false);
          });
          return true;
        case "/shed":
          doShed();
          return true;
        case "/regrow":
          doRegrow();
          return true;
        case "/wire":
          doWire();
          return true;
        case "/race": {
          const models = raw.split(/\s+/).slice(1);
          if (models.length >= 2) {
            setRaceModels(models);
            push({
              kind: "info",
              text: `race armed: ${models.join(" vs ")} — next prompt runs on each`,
            });
          } else {
            push({ kind: "info", text: "usage: /race <modelA> <modelB> [...]" });
          }
          return true;
        }
        case "/budget": {
          const n = arg ? parseInt(arg, 10) : NaN;
          if (Number.isFinite(n) && n > 0) {
            engine.setBudget(n);
            push({ kind: "info", text: `budget set: ${n} tokens (hard stop)` });
          } else {
            engine.setBudget(undefined);
            push({ kind: "info", text: "budget cleared" });
          }
          return true;
        }
        case "/molt": {
          if (arg && (THEMES[arg] || (arg === "custom" && customTheme))) {
            setThemeName(arg);
            push({ kind: "info", text: `molted → ${arg}` });
          } else {
            const names = [
              ...Object.keys(THEMES),
              ...(customTheme ? ["custom"] : []),
            ].join("  ");
            push({ kind: "info", text: `themes: ${names}` });
          }
          return true;
        }
        case "/help":
          push({
            kind: "info",
            text: "/connect <provider> /login /model [name] /doctor /bom /wire /shed /regrow /budget /race /molt /new /quit",
          });
          return true;
        default:
          return false;
      }
    },
    [exit, engine, push, printBom, customTheme, doShed, doRegrow, doWire, doConnect, doModel, startLogin, startModelPicker],
  );

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") return exit();

    if (pending) {
      if (ch === "y") {
        pending.resolve(true);
        setPending(null);
      } else if (ch === "n" || key.escape) {
        pending.resolve(false);
        setPending(null);
      }
      return;
    }

    if (mode.kind !== "chat") {
      if (key.return) {
        const v = input.trim();
        setInput("");
        if (mode.kind === "login-select") {
          const prov = resolveProvider(v);
          if (!prov) {
            push({ kind: "info", text: v ? `unknown provider '${v}' — try a number from the list` : "login cancelled" });
            setMode({ kind: "chat" });
          } else {
            push({ kind: "info", text: `paste API key for ${prov} (input hidden) — enter to save, esc to cancel` });
            setMode({ kind: "login-key", provider: prov });
          }
        } else if (mode.kind === "login-key") {
          finishLogin(mode.provider, v);
        } else if (mode.kind === "model-select") {
          if (v) pickModel(mode.choices, v);
          else setMode({ kind: "chat" });
        }
      } else if (key.escape) {
        setInput("");
        setMode({ kind: "chat" });
        push({ kind: "info", text: "cancelled" });
      } else if (key.backspace || key.delete) {
        setInput((v) => v.slice(0, -1));
      } else if (!key.ctrl && !key.meta && ch) {
        setInput((v) => v + ch);
      }
      return;
    }

    if (busy) return;

    if (key.return) {
      const prompt = input.trim();
      setInput("");
      if (!prompt) return;
      if (prompt.startsWith("/") && handleCommand(prompt)) return;
      push({ kind: "user", text: prompt });
      if (raceModels) {
        void runRace(prompt, raceModels);
      } else {
        void runTurn(prompt);
      }
    } else if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
    } else if (!key.ctrl && !key.meta && ch) {
      setInput((v) => v + ch);
    }
  });

  const costStr = cost !== undefined ? ` · $${cost.toFixed(4)}` : "";
  const status = pending
    ? "waiting on permission gate"
    : busy
      ? "thinking…"
      : `${engine.model} · ${sessionTok} tok${costStr}${engine.budgetTokens ? ` / ${engine.budgetTokens}` : ""} · /help`;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Banner theme={theme} themeName={themeName} animate={animateBanner} />
      <Text color={theme.dim}>{TAGLINE}</Text>
      <Box flexDirection="column" marginTop={1}>
        {lines.map((l, idx) => {
          switch (l.kind) {
            case "user":
              return (
                <Text key={idx} color={theme.user} wrap="wrap">
                  ❯ {l.text}
                </Text>
              );
            case "assistant":
              return (
                <Box key={idx} marginBottom={1}>
                  <Text color={theme.assistant} wrap="wrap">
                    {l.text}
                  </Text>
                </Box>
              );
            case "tool":
              return (
                <Text key={idx} color={theme.tool}>
                  ⚙ {l.name} <Text dimColor>{l.detail}</Text>
                  {l.note ? <Text color={theme.warn}> [{l.note}]</Text> : null}
                </Text>
              );
            case "info":
              return (
                <Text key={idx} color={theme.dim}>
                  {l.text}
                </Text>
              );
            case "error":
              return (
                <Text key={idx} color={theme.error}>
                  ✗ {l.text}
                </Text>
              );
          }
        })}
      </Box>
      {pending ? (
        <Box
          borderStyle="round"
          borderColor={theme.warn}
          paddingX={1}
          marginTop={1}
          flexDirection="column"
        >
          <Text color={theme.warn}>allow? {pending.detail}</Text>
          <Text dimColor>[y] allow · [n/esc] deny</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={theme.accent}>
            {busy ? "… " : mode.kind === "login-key" ? "🔑 " : mode.kind !== "chat" ? "# " : "❯ "}
          </Text>
          <Text>{mode.kind === "login-key" ? "•".repeat(input.length) : input}</Text>
          {!busy && <Text color={theme.accent}>█</Text>}
        </Box>
      )}
      <Text dimColor>{status}</Text>
    </Box>
  );
}
