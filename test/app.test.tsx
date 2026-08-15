import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type MoltEngine } from "../src/app.js";
import type { EngineEvent, Confirm, Bom } from "../src/engine.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function submit(stdin: { write: (s: string) => void }, text: string) {
  await sleep(20);
  stdin.write(text);
  await sleep(20);
  stdin.write("\r");
  await sleep(20);
}

/** Fake engine driven by a scripted event list (or a custom run fn). */
function fakeEngine(
  events: EngineEvent[] = [],
  runFn?: (text: string, confirm: Confirm) => AsyncGenerator<EngineEvent>,
): MoltEngine {
  return {
    model: "fake-model",
    budgetTokens: undefined,
    async *run(text, confirm) {
      if (runFn) return yield* runFn(text, confirm);
      for (const ev of events) {
        await sleep(1);
        yield ev;
      }
    },
    bom: (): Bom => ({
      systemTokens: 40,
      toolSchemaTokens: 120,
      historyTokens: 7,
      requestTotalEst: 167,
      sessionPromptTokens: 100,
      sessionCompletionTokens: 20,
      costUsd: undefined,
      budgetTokens: undefined,
    }),
    reset() {},
    setBudget() {},
    shed: () => ({
      beforeTokens: 900,
      afterTokens: 120,
      droppedCount: 6,
      exuvia: "# molt exuvia\n\n## user\n\nfull dropped history here\n",
    }),
    attach() {},
    probe: async (_p: string, model?: string) => ({
      ok: true as const,
      text: `answer from ${model}`,
      promptTokens: 50,
      completionTokens: model === "slow-model" ? 200 : 10,
      ms: model === "slow-model" ? 900 : 100,
    }),
    lastRequestBody: '{"model":"fake-model","messages":[]}',
    doctor: async () => ({ ok: true, detail: "endpoint reachable · 3 models · 'fake-model' available" }),
    baseUrl: "http://fake.local/v1",
    setModel() {},
    setApiKey() {},
    setBaseUrl() {},
    listModels: async (baseUrl?: string) => {
      if (baseUrl?.includes("openrouter"))
        return { ok: true as const, ids: ["qwen/qwen3-coder", "anthropic/claude-sonnet-4.6"] };
      if (baseUrl?.includes("x.ai"))
        return { ok: true as const, ids: ["grok-code-fast-1"] };
      if (baseUrl?.includes("localhost"))
        return { ok: false as const, error: "ECONNREFUSED" };
      return { ok: true as const, ids: ["alpha", "beta", "gamma"] };
    },
  };
}

const happyPath: EngineEvent[] = [
  { kind: "tool", name: "bash", detail: "npm test" },
  { kind: "assistant_text", text: "All 12 tests pass." },
  { kind: "usage", promptTokens: 900, completionTokens: 80, sessionTokens: 980, costUsd: 0.0123 },
];

describe("App", () => {
  it("renders the settled banner and prompt on launch", () => {
    const { lastFrame } = render(<App engine={fakeEngine()} />);
    expect(lastFrame()).toContain("molt ))))");
    expect(lastFrame()).toContain("shed the stock shell");
    expect(lastFrame()).toContain("fake-model");
  });

  it("plays the shed animation when enabled", async () => {
    const { lastFrame } = render(<App engine={fakeEngine()} animateBanner />);
    expect(lastFrame()).toContain("(m)(o)(l)(t)");
    await sleep(600);
    expect(lastFrame()).toContain("molt ))))");
    expect(lastFrame()).not.toContain("(m)");
  });

  it("shows startup notice when passed", () => {
    const { lastFrame } = render(
      <App engine={fakeEngine()} initialNotice="system prompt: 40 tok" />,
    );
    expect(lastFrame()).toContain("system prompt: 40 tok");
  });

  it("runs a full turn: user line, tool line, answer, token receipt", async () => {
    const { stdin, lastFrame } = render(<App engine={fakeEngine(happyPath)} />);
    await submit(stdin, "run the tests");
    await sleep(50);
    const frame = lastFrame()!;
    expect(frame).toContain("❯ run the tests");
    expect(frame).toContain("⚙ bash");
    expect(frame).toContain("All 12 tests pass.");
    expect(frame).toContain("✓ 900→80 tok · session 980 · $0.0123");
    expect(frame).toContain("980 tok · $0.0123"); // status line
  });

  it("/bom prints the context bill of materials", async () => {
    const { stdin, lastFrame } = render(<App engine={fakeEngine()} />);
    await submit(stdin, "/bom");
    expect(lastFrame()).toContain("system 40 · tool schemas 120 · history 7");
    expect(lastFrame()).toContain("next request ≈167 tok");
    expect(lastFrame()).toContain("100 in / 20 out");
  });

  it("/budget sets and clears, /molt switches themes", async () => {
    const { stdin, lastFrame } = render(<App engine={fakeEngine()} />);
    await submit(stdin, "/budget 50000");
    expect(lastFrame()).toContain("budget set: 50000 tokens");
    await submit(stdin, "/budget");
    expect(lastFrame()).toContain("budget cleared");
    await submit(stdin, "/molt ember");
    expect(lastFrame()).toContain("molted → ember");
    await submit(stdin, "/molt");
    expect(lastFrame()).toContain("themes: tidepool  ember  mantis  mono");
  });

  it("survives a hostile event stream without crashing", async () => {
    const hostile = [
      { kind: "mystery" },
      { kind: "assistant_text", text: "长".repeat(5000) },
      { kind: "tool", name: "bash", detail: "a".repeat(80), note: "capped at 4096B (was 50000B)" },
      { kind: "error", text: "HTTP 500: upstream exploded" },
    ] as EngineEvent[];
    const { stdin, lastFrame } = render(<App engine={fakeEngine(hostile)} />);
    await submit(stdin, "go");
    await sleep(50);
    expect(lastFrame()).toContain("HTTP 500");
    // note may wrap across terminal lines; compare whitespace-normalized
    expect(lastFrame()!.replace(/\s+/g, " ")).toContain("[capped at 4096B (was 50000B)]");
  });

  it("/shed archives the exuvia and reports the token diff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "molt-app-"));
    const { stdin, lastFrame } = render(
      <App engine={fakeEngine()} artifactDir={dir} />,
    );
    await submit(stdin, "/shed");
    const frame = lastFrame()!.replace(/\s+/g, " ");
    expect(frame).toContain("shed 6 messages · history 900→120 tok");
    expect(frame).toContain("0 tokens spent");
    const files = readdirSync(join(dir, "exuviae"));
    expect(files.length).toBe(1);
    expect(readFileSync(join(dir, "exuviae", files[0]), "utf8")).toContain(
      "full dropped history here",
    );
  });

  it("/regrow re-attaches the newest exuvia", async () => {
    const dir = mkdtempSync(join(tmpdir(), "molt-app-"));
    const eng = fakeEngine();
    const r = render(<App engine={eng} artifactDir={dir} />);
    await submit(r.stdin, "/shed");
    await submit(r.stdin, "/regrow");
    expect(r.lastFrame()!.replace(/\s+/g, " ")).toContain("regrew");
  });

  it("/wire dumps the exact last request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "molt-app-"));
    const { stdin, lastFrame } = render(
      <App engine={fakeEngine()} artifactDir={dir} />,
    );
    await submit(stdin, "/wire");
    expect(lastFrame()!.replace(/\s+/g, " ")).toContain("wire: last request");
    expect(readFileSync(join(dir, "wire.json"), "utf8")).toContain("fake-model");
  });

  it("/connect switches provider and reports key status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "molt-cfg-"));
    const { stdin, lastFrame } = render(<App engine={fakeEngine()} configDir={dir} />);
    await submit(stdin, "/connect openrouter");
    const f = lastFrame()!.replace(/\s+/g, " ");
    expect(f).toContain("connected: openrouter (https://openrouter.ai/api/v1)");
    expect(f).toContain("no key stored — /login to add one");
    await submit(stdin, "/connect nonsense");
    expect(lastFrame()).toContain("providers: ollama  openrouter  anthropic  openai  xai  groq");
  });

  it("/login: provider picker → masked key → persisted per provider (0600)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "molt-cfg-"));
    const { stdin, lastFrame } = render(<App engine={fakeEngine()} configDir={dir} />);
    await submit(stdin, "/login");
    const menu = lastFrame()!.replace(/\s+/g, " ");
    expect(menu).toContain("1. openrouter");
    expect(menu).toContain("anthropic");
    expect(menu).toContain("xai");
    await submit(stdin, "1"); // openrouter
    expect(lastFrame()).toContain("paste API key for openrouter");
    await sleep(20);
    stdin.write("sk-or-secret");
    await sleep(20);
    expect(lastFrame()).toContain("••••••••••••");
    expect(lastFrame()).not.toContain("sk-or-secret");
    stdin.write("\r");
    await sleep(30);
    expect(lastFrame()).toContain("key saved for openrouter");
    const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    expect(auth.openrouter).toBe("sk-or-secret");
    const fmode = (await import("node:fs")).statSync(join(dir, "auth.json")).mode & 0o777;
    expect(fmode).toBe(0o600);
  });

  it("/model aggregates models across all keyed providers and switches on pick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "molt-cfg-"));
    const switched: { url?: string; key?: string; model?: string } = {};
    const eng = {
      ...fakeEngine(),
      setBaseUrl: (u: string, k?: string) => { switched.url = u; switched.key = k; },
      setModel: (m: string) => { switched.model = m; },
    };
    // seed two provider keys
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ openrouter: "k1", xai: "k2" }));
    const { stdin, lastFrame } = render(<App engine={eng} configDir={dir} />);
    await submit(stdin, "/model");
    await sleep(60);
    const f = lastFrame()!.replace(/\s+/g, " ");
    expect(f).toContain("openrouter:");
    expect(f).toContain("qwen/qwen3-coder");
    expect(f).toContain("xai:");
    expect(f).toContain("grok-code-fast-1");
    expect(f).not.toContain("ECONNREFUSED"); // unreachable ollama is silent
    await submit(stdin, "3"); // 1,2 = openrouter · 3 = grok
    expect(lastFrame()).toContain("model → xai/grok-code-fast-1");
    expect(switched).toMatchObject({ url: "https://api.x.ai/v1", key: "k2", model: "grok-code-fast-1" });
  });

  it("/model with no keys anywhere points to /login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "molt-cfg-"));
    const eng = { ...fakeEngine(), listModels: async () => ({ ok: false as const, error: "ECONNREFUSED" }) };
    const { stdin, lastFrame } = render(<App engine={eng} configDir={dir} />);
    await submit(stdin, "/model");
    await sleep(40);
    expect(lastFrame()!.replace(/\s+/g, " ")).toContain("no models found on any keyed provider");
  });

  it("/doctor reports endpoint + model availability", async () => {
    const { stdin, lastFrame } = render(<App engine={fakeEngine()} />);
    await submit(stdin, "/doctor");
    await sleep(30);
    expect(lastFrame()!.replace(/\s+/g, " ")).toContain("doctor: endpoint reachable · 3 models");
  });

  it("/race arms, runs the next prompt on each model, compares", async () => {
    const { stdin, lastFrame } = render(<App engine={fakeEngine()} />);
    await submit(stdin, "/race fast-model slow-model");
    expect(lastFrame()).toContain("race armed: fast-model vs slow-model");
    await submit(stdin, "which is better?");
    await sleep(60);
    const frame = lastFrame()!.replace(/\s+/g, " ");
    expect(frame).toContain("answer from fast-model");
    expect(frame).toContain("answer from slow-model");
    expect(frame).toContain("race: fastest fast-model · leanest fast-model");
  });

  it("permission gate: renders prompt, y allows, n denies", async () => {
    let decision: boolean | null = null;
    const eng = fakeEngine([], async function* (_t, confirm) {
      decision = await confirm("bash", "rm -rf ./build");
      yield { kind: "usage", promptTokens: 1, completionTokens: 1, sessionTokens: 2 };
    });
    const { stdin, lastFrame } = render(<App engine={eng} />);
    await submit(stdin, "clean");
    expect(lastFrame()).toContain("allow? bash rm -rf ./build");
    stdin.write("y");
    await sleep(40);
    expect(decision).toBe(true);

    let decision2: boolean | null = null;
    const eng2 = fakeEngine([], async function* (_t, confirm) {
      decision2 = await confirm("write_file", "/etc/passwd");
      yield { kind: "usage", promptTokens: 1, completionTokens: 1, sessionTokens: 2 };
    });
    const r2 = render(<App engine={eng2} />);
    await submit(r2.stdin, "do it");
    r2.stdin.write("n");
    await sleep(40);
    expect(decision2).toBe(false);
  });
});
