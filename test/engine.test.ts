import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  estTokens,
  toolDetail,
  TOOL_RESULT_MAX_BYTES,
  type EngineEvent,
} from "../src/engine.js";

const allow = async () => true;
const deny = async () => false;

/** Build a fetch mock that returns scripted OpenAI-style responses. */
function scriptedFetch(responses: unknown[]): typeof fetch {
  let i = 0;
  return (async () => {
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const textResponse = (text: string, usage = { prompt_tokens: 100, completion_tokens: 20 }) => ({
  choices: [{ message: { role: "assistant", content: text } }],
  usage,
});

const toolResponse = (name: string, args: object) => ({
  choices: [{
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", function: { name, arguments: JSON.stringify(args) } }],
    },
  }],
  usage: { prompt_tokens: 150, completion_tokens: 30 },
});

async function collect(gen: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const cfg = { baseUrl: "http://test/v1", model: "test-model" };

describe("Engine", () => {
  it("plain text turn: emits text + real usage", async () => {
    const e = new Engine({ ...cfg, fetchFn: scriptedFetch([textResponse("hello")]) });
    const evs = await collect(e.run("hi", allow));
    expect(evs[0]).toMatchObject({ kind: "assistant_text", text: "hello" });
    expect(evs[1]).toMatchObject({ kind: "usage", promptTokens: 100, completionTokens: 20, sessionTokens: 120 });
  });

  it("tool round trip: write_file gated, executed, result fed back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "molt-"));
    const target = join(dir, "out.txt");
    const e = new Engine({
      ...cfg,
      fetchFn: scriptedFetch([
        toolResponse("write_file", { path: target, content: "hi molt" }),
        textResponse("written"),
      ]),
    });
    const evs = await collect(e.run("write it", allow));
    expect(evs.find((x) => x.kind === "tool")).toMatchObject({ name: "write_file" });
    expect(readFileSync(target, "utf8")).toBe("hi molt");
    expect(evs.at(-2)).toMatchObject({ kind: "assistant_text", text: "written" });
  });

  it("denied gate: tool not executed, model told, loop continues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "molt-"));
    const target = join(dir, "never.txt");
    const e = new Engine({
      ...cfg,
      fetchFn: scriptedFetch([
        toolResponse("bash", { command: `touch ${target}` }),
        textResponse("ok, skipped"),
      ]),
    });
    const evs = await collect(e.run("do it", deny));
    expect(evs.find((x) => x.kind === "tool")).toMatchObject({ note: "denied" });
    expect(() => readFileSync(target)).toThrow();
  });

  it("read_file is not gated", async () => {
    let confirmCalls = 0;
    const e = new Engine({
      ...cfg,
      fetchFn: scriptedFetch([
        toolResponse("read_file", { path: "package.json" }),
        textResponse("read it"),
      ]),
    });
    await collect(e.run("read", async () => { confirmCalls++; return true; }));
    expect(confirmCalls).toBe(0);
  });

  it("caps oversized tool results with a visible note", async () => {
    const e = new Engine({
      ...cfg,
      fetchFn: scriptedFetch([
        toolResponse("bash", { command: "head -c 9000 /dev/zero | tr '\\0' a" }),
        textResponse("done"),
      ]),
    });
    const evs = await collect(e.run("big output", allow));
    const tool = evs.find((x) => x.kind === "tool");
    expect(tool).toMatchObject({ note: expect.stringContaining(`capped at ${TOOL_RESULT_MAX_BYTES}B`) });
  });

  it("hard budget stops the loop before the next request", async () => {
    const e = new Engine({ ...cfg, fetchFn: scriptedFetch([textResponse("a")]) });
    e.setBudget(50); // first turn spends 120 > 50
    await collect(e.run("one", allow));
    const evs = await collect(e.run("two", allow));
    expect(evs[0]).toMatchObject({ kind: "error", text: expect.stringContaining("budget hit") });
  });

  it("HTTP errors surface status + body excerpt, no throw", async () => {
    const f = (async () => new Response("model not found", { status: 404 })) as typeof fetch;
    const e = new Engine({ ...cfg, fetchFn: f });
    const evs = await collect(e.run("hi", allow));
    expect(evs[0]).toMatchObject({ kind: "error", text: expect.stringContaining("HTTP 404") });
  });

  it("malformed provider JSON and missing message are errors, not crashes", async () => {
    const bad = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    let evs = await collect(new Engine({ ...cfg, fetchFn: bad }).run("x", allow));
    expect(evs[0].kind).toBe("error");
    const empty = scriptedFetch([{ choices: [] }]);
    evs = await collect(new Engine({ ...cfg, fetchFn: empty }).run("x", allow));
    expect(evs[0].kind).toBe("error");
  });

  it("runaway tool loops hit the step guard", async () => {
    const e = new Engine({
      ...cfg,
      fetchFn: scriptedFetch([toolResponse("read_file", { path: "package.json" })]),
    });
    const evs = await collect(e.run("loop forever", allow));
    expect(evs.at(-1)).toMatchObject({ kind: "error", text: expect.stringContaining("loop guard") });
  }, 20000);

  it("bom reports estimates, session reals, and prices when configured", async () => {
    const e = new Engine({
      ...cfg,
      priceInPerMtok: 1.0,
      priceOutPerMtok: 5.0,
      fetchFn: scriptedFetch([textResponse("hi", { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 })]),
    });
    await collect(e.run("hello", allow));
    const b = e.bom();
    expect(b.systemTokens).toBe(estTokens((await import("../src/engine.js")).SYSTEM_PROMPT));
    expect(b.sessionPromptTokens).toBe(1_000_000);
    expect(b.costUsd).toBeCloseTo(6.0);
  });
});

describe("shed / regrow / wire / probe", () => {
  it("shed is deterministic, archives everything, and shrinks history", async () => {
    const e = new Engine({
      ...cfg,
      fetchFn: scriptedFetch([
        textResponse("first answer about the flux capacitor. " + "detail ".repeat(200)),
        textResponse("second answer. " + "more ".repeat(200)),
        textResponse("third answer"),
      ]),
    });
    await collect(e.run("question one about flux", allow));
    await collect(e.run("question two", allow));
    await collect(e.run("question three", allow));
    const before = e.bom().historyTokens;
    const r = e.shed(2);
    expect(r).not.toBeNull();
    expect(r!.beforeTokens).toBe(before);
    expect(r!.afterTokens).toBeLessThan(before + 1);
    // the exuvia holds the FULL dropped content, verbatim
    expect(r!.exuvia).toContain("question one about flux");
    expect(r!.exuvia).toContain("first answer about the flux capacitor");
    // and shedding again immediately has nothing to drop
    expect(e.shed(2)).toBeNull();
  });

  it("refuses a shed that would grow context (no-gain guard)", async () => {
    const e = new Engine({
      ...cfg,
      fetchFn: scriptedFetch([textResponse("a"), textResponse("b"), textResponse("c")]),
    });
    await collect(e.run("1", allow));
    await collect(e.run("2", allow));
    await collect(e.run("3", allow));
    const before = e.bom().historyTokens;
    expect(e.shed(2)).toBeNull();
    expect(e.bom().historyTokens).toBe(before); // untouched
  });

  it("attach re-adds shed context", async () => {
    const e = new Engine({ ...cfg, fetchFn: scriptedFetch([textResponse("ok")]) });
    e.attach("# molt exuvia\nold stuff");
    const b = e.bom();
    expect(b.historyTokens).toBeGreaterThan(0);
  });

  it("captures the exact wire body of the last request", async () => {
    const e = new Engine({ ...cfg, fetchFn: scriptedFetch([textResponse("hi")]) });
    await collect(e.run("hello wire", allow));
    expect(e.lastRequestBody).toContain('"hello wire"');
    expect(e.lastRequestBody).toContain('"model":"test-model"');
  });

  it("probe: isolated tool-less call with timing and usage", async () => {
    const e = new Engine({ ...cfg, fetchFn: scriptedFetch([textResponse("probed")]) });
    const r = await e.probe("compare yourself", "other-model");
    expect(r).toMatchObject({ ok: true, text: "probed", promptTokens: 100 });
    expect(e.bom().historyTokens).toBe(0); // session untouched
  });

  it("probe surfaces HTTP failure without throwing", async () => {
    const f = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const e = new Engine({ ...cfg, fetchFn: f });
    const r = await e.probe("x");
    expect(r).toMatchObject({ ok: false, error: "HTTP 500" });
  });
});

describe("helpers", () => {
  it("toolDetail: one line, 80 chars, right field per tool", () => {
    expect(toolDetail("bash", { command: "npm  \n test" })).toBe("npm test");
    expect(toolDetail("read_file", { path: "/a/b" })).toBe("/a/b");
    expect(toolDetail("bash", { command: "x".repeat(500) }).length).toBe(80);
  });
});
