/**
 * The model, autonomy and effort pickers an editor shows for a molt session.
 *
 * Three layers: the catalog (what is listed, how it is grouped, how a value
 * names a backend and a model), the server (what set_config_option does, and
 * when), and the built binary over stdio choosing a second endpoint and the
 * next turn going there. Subscription CLIs are never probed: detection is
 * injected in-process and declared by MOLT_ACP_SUBSCRIPTIONS for the child.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  type ConfigOption,
  decodeModelValue,
  discoverModels,
  encodeModelValue,
  modelOption,
  type ModelSource,
  NO_MODEL,
  optionHas,
  readRememberedEndpoints,
  type SelectGroup,
} from "../src/acp-catalog.js";
import { AcpConnection, type AcpAgentSpec } from "../src/acp.js";
import { AcpServer, type ModelChoices } from "../src/acp-server.js";
import { GROK_BUILD_URL } from "../src/endpoint.js";
import { Engine } from "../src/engine.js";
import { INVALID_PARAMS, INVALID_REQUEST, RpcError, RpcPeer } from "../src/jsonrpc.js";
import { jsonBody, scriptServer, type Reply } from "./acp-provider.js";
import { workspace } from "./helpers.js";
import { spawn } from "node:child_process";

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

const groupsOf = (o: ConfigOption) => o.options as SelectGroup[];

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

describe("model values", () => {
  it("round-trip whatever the model id holds", () => {
    for (const [url, model] of [
      ["https://api.x.ai/v1", "grok-4.6"],
      ["http://[::1]:8080/v1", "qwen3:30b-a3b"],
      ["https://openrouter.ai/api/v1", "inception/mercury-2.5-preview"],
      ["http://127.0.0.1:8080/v1", "odd#model"],
      [GROK_BUILD_URL, "grok-4.6"],
    ] as const) {
      const v = encodeModelValue(url, model);
      assert.deepEqual(decodeModelValue(v), { url, model });
    }
  });

  it("drop a trailing slash from the endpoint, so one server is one value", () => {
    assert.equal(encodeModelValue("http://h:1/v1/", "m"), "http://h:1/v1#m");
  });

  it("refuse what encoding could not have produced", () => {
    for (const bad of [NO_MODEL, "no-separator", "#model-only", "http://h/v1#"]) {
      assert.equal(decodeModelValue(bad), null, bad);
    }
  });
});

describe("discovery", () => {
  const listings: Record<string, { ok: true; ids: string[] } | { ok: false; error: string }> = {
    "https://api.x.ai/v1": { ok: true, ids: ["grok-4.6", "grok-4.7"] },
    "http://localhost:11434/v1": { ok: false, error: "fetch failed" },
    "http://192.168.0.218:8080/v1": { ok: true, ids: ["qwen3.8-27b"] },
    "https://llm.example.com/v1": { ok: true, ids: [] },
  };

  const deps = (over: Partial<Parameters<typeof discoverModels>[0]> = {}) => ({
    auth: { xai: "xai-key", openai: "" },
    stored: { baseUrl: "http://192.168.0.218:8080/v1", model: "qwen3.8-27b" },
    remembered: [{ url: "https://llm.example.com/v1/", lastModel: "house-model" }],
    listModels: async (url: string) => listings[url] ?? { ok: false as const, error: "unknown" },
    subscriptionUsable: async (url: string) => url === GROK_BUILD_URL,
    ...over,
  });

  it("lists only what can run, each in its group", async () => {
    const found = await discoverModels(deps());
    const byUrl = Object.fromEntries(found.map((f) => [f.url, f]));
    assert.deepEqual(Object.keys(byUrl).sort(), [
      GROK_BUILD_URL,
      "http://192.168.0.218:8080/v1",
      "https://api.x.ai/v1",
      "https://llm.example.com/v1",
    ].sort());
    assert.equal(byUrl[GROK_BUILD_URL]!.group, "subscriptions");
    assert.deepEqual(byUrl[GROK_BUILD_URL]!.models, ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]);
    assert.equal(byUrl["https://api.x.ai/v1"]!.group, "api-keys");
    assert.equal(byUrl["http://192.168.0.218:8080/v1"]!.group, "local");
    // Answered with an empty list: the model it was last used with stands.
    assert.deepEqual(byUrl["https://llm.example.com/v1"]!.models, ["house-model"]);
  });

  it("asks a keyed provider with its key, and never asks one with no key", async () => {
    const asked: [string, string | undefined][] = [];
    await discoverModels(
      deps({
        listModels: async (url, key) => {
          asked.push([url, key]);
          return { ok: false, error: "x" };
        },
      }),
    );
    assert.ok(asked.some(([u, k]) => u === "https://api.x.ai/v1" && k === "xai-key"));
    assert.ok(!asked.some(([u]) => u === "https://api.openai.com/v1"), "an empty key is no key");
  });

  it("leaves out a probe that does not answer in time, and says so", async () => {
    const logs: string[] = [];
    const t0 = Date.now();
    // Slower than timeoutMs so `within` takes the fallback; still settles so
    // the runner is not left with forever-pending promises.
    const slow = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 200));
    const found = await discoverModels(
      deps({
        timeoutMs: 50,
        subscriptionUsable: () => slow(false),
        listModels: () => slow({ ok: false as const, error: "still waiting" }),
        log: (l) => logs.push(l),
      }),
    );
    assert.deepEqual(found, []);
    assert.ok(Date.now() - t0 < 2_000);
    assert.ok(logs.some((l) => /no answer in time|not usable here/.test(l)));
  });

  it("reads the window's remembered servers without writing them", () => {
    const w = workspace();
    cleanups.push(w.cleanup);
    writeFileSync(
      join(w.dir, "desktop-endpoints.json"),
      JSON.stringify([{ url: "http://10.0.0.5:1234/v1/", lastModel: "m", seen: "x" }, { nope: 1 }]),
    );
    assert.deepEqual(readRememberedEndpoints(w.dir), [{ url: "http://10.0.0.5:1234/v1", lastModel: "m" }]);
    assert.deepEqual(readRememberedEndpoints(join(w.dir, "missing")), []);
  });
});

describe("the model option", () => {
  const sources: ModelSource[] = [
    { group: "local", url: "http://127.0.0.1:8080/v1", label: "127.0.0.1:8080", models: ["qwen"] },
    { group: "subscriptions", url: GROK_BUILD_URL, label: "Grok Build", models: ["grok-4.7"] },
    { group: "api-keys", url: "https://api.x.ai/v1", label: "xai", models: ["grok-4.6"] },
  ];

  it("groups in a fixed order: subscriptions, API keys, local", () => {
    const o = modelOption(sources, { url: "https://api.x.ai/v1", model: "grok-4.6" });
    assert.equal(o.id, "model");
    assert.equal(o.category, "model");
    assert.deepEqual(groupsOf(o).map((g) => g.name), ["Subscriptions", "API keys", "Local"]);
    assert.equal(o.currentValue, "https://api.x.ai/v1#grok-4.6");
    assert.equal(groupsOf(o)[0]!.options[0]!.name, "Grok Build · grok-4.7");
    assert.ok(optionHas(o, "http://127.0.0.1:8080/v1#qwen"));
  });

  it("always contains the model in use, discovered or not", () => {
    const o = modelOption([], { url: "https://api.x.ai/v1", model: "grok-4.6" });
    assert.ok(optionHas(o, o.currentValue));
    assert.equal(groupsOf(o)[0]!.name, "API keys");
    const p = modelOption(sources, { url: "https://api.x.ai/v1", model: "grok-9" });
    assert.ok(optionHas(p, "https://api.x.ai/v1#grok-9"));
  });

  it("says nothing is selected rather than inventing a default", () => {
    const o = modelOption(sources, { url: "http://localhost:11434/v1", model: "" });
    assert.equal(o.currentValue, NO_MODEL);
    assert.ok(optionHas(o, NO_MODEL));
  });
});

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

const A = "http://a.test/v1";
const B = "http://b.test/v1";

type Sent = { url: string; model: string };

/** Two scripted endpoints behind one fetch, recording which one each request reached. */
function twoEndpoints(reply: (url: string) => Reply) {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "{}");
    const base = url.replace(/\/chat\/completions$/, "");
    sent.push({ url: base, model: (JSON.parse(body) as { model: string }).model });
    const r = reply(base);
    if (r.hang) {
      return new Promise<Response>((_res, rej) => {
        const abort = () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return new Response(jsonBody(r), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, sent };
}

async function harness(o: {
  model?: string;
  discover?: () => Promise<ModelSource[]>;
  effortLevels?: ModelChoices["effortLevels"];
  reply?: (url: string) => Reply;
} = {}) {
  const w = workspace();
  cleanups.push(w.cleanup);
  const net = twoEndpoints(o.reply ?? ((url) => ({ text: `answered by ${url}` })));
  const updates: Record<string, unknown>[] = [];
  const engines: Engine[] = [];
  const applied: Sent[] = [];
  let server!: AcpServer;
  const client = new RpcPeer({
    write: (l) => queueMicrotask(() => server.feed(l)),
    onNotify: (m, p) => {
      if (m === "session/update") updates.push((p as { update: Record<string, unknown> }).update);
    },
    onRequest: async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }),
  });
  server = new AcpServer({
    write: (l) => queueMicrotask(() => client.feed(l)),
    version: "test",
    newEngine: async ({ cwd }) => {
      const e = new Engine({ baseUrl: A, model: o.model ?? "a-model", cwd, fetchFn: net.fetchFn, stream: false, bar: null, retryBackoffMs: [0] });
      engines.push(e);
      return e;
    },
    models: {
      discover:
        o.discover ??
        (async () => [
          { group: "api-keys", url: A, label: "a", models: ["a-model"] },
          { group: "local", url: B, label: "b", models: ["b-model", "b-small"] },
        ]),
      waitMs: 500,
      apply: async (engine, url, model) => {
        applied.push({ url, model });
        if (engine.baseUrl !== url) engine.setBaseUrl(url, undefined, "test");
        engine.setModel(model);
      },
      effortLevels: o.effortLevels,
    },
  });
  const call = (m: string, p: unknown) => client.request(m, p);
  await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const opened = (await call("session/new", { cwd: w.dir, mcpServers: [] })) as {
    sessionId: string;
    configOptions: ConfigOption[];
  };
  const sid = opened.sessionId;
  const set = (configId: string, value: string) =>
    call("session/set_config_option", { sessionId: sid, configId, value }) as Promise<{ configOptions: ConfigOption[] }>;
  const prompt = (text: string) =>
    call("session/prompt", { sessionId: sid, prompt: [{ type: "text", text }] }) as Promise<{ stopReason: string }>;
  const optionUpdates = () => updates.filter((u) => u.sessionUpdate === "config_option_update");
  const said = () =>
    updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.content as { text: string }).text)
      .join("");
  return { sid, opened, set, prompt, call, client, net, engines, applied, updates, optionUpdates, said };
}

const byId = (opts: ConfigOption[], id: string) => opts.find((x) => x.id === id);

describe("session/new's config options", () => {
  it("offers the model (grouped) and autonomy, with the current values", async () => {
    const h = await harness();
    const model = byId(h.opened.configOptions, "model")!;
    assert.equal(model.currentValue, `${A}#a-model`);
    assert.deepEqual(groupsOf(model).map((g) => g.name), ["API keys", "Local"]);
    const autonomy = byId(h.opened.configOptions, "autonomy")!;
    assert.equal(autonomy.category, "mode");
    assert.equal(autonomy.currentValue, "low");
    assert.equal(byId(h.opened.configOptions, "effort"), undefined, "no model here takes effort");
  });

  it("does not wait for a slow discovery; the list grows by config_option_update", async () => {
    let finish!: (s: ModelSource[]) => void;
    const h = await harness({ discover: () => new Promise((r) => (finish = r)) });
    // Opened with only the model in use.
    const first = byId(h.opened.configOptions, "model")!;
    assert.deepEqual(groupsOf(first).map((g) => g.options.length), [1]);
    finish([{ group: "local", url: B, label: "b", models: ["b-model"] }]);
    await new Promise((r) => setTimeout(r, 20));
    const upd = h.optionUpdates().at(-1)!;
    const model = byId(upd.configOptions as ConfigOption[], "model")!;
    assert.ok(optionHas(model, `${B}#b-model`));
  });
});

describe("session/set_config_option", () => {
  it("switches endpoint and model for the next turn, and the turn goes there", async () => {
    const h = await harness();
    await h.prompt("first");
    assert.deepEqual(h.net.sent.at(-1), { url: A, model: "a-model" });

    const r = await h.set("model", `${B}#b-model`);
    assert.equal(byId(r.configOptions, "model")!.currentValue, `${B}#b-model`);
    await h.prompt("second");
    assert.deepEqual(h.net.sent.at(-1), { url: B, model: "b-model" });
    assert.match(h.said(), /answered by http:\/\/b\.test\/v1/);
    assert.match(h.said(), /A different backend starts a fresh conversation/);

    // Back again, and a model on the same endpoint keeps the conversation.
    await h.set("model", `${A}#a-model`);
    await h.prompt("third");
    assert.deepEqual(h.net.sent.at(-1), { url: A, model: "a-model" });
  });

  it("refuses a value that is not on offer, and an option that does not exist", async () => {
    const h = await harness();
    await assert.rejects(h.set("model", "http://evil.test/v1#m"), (e: RpcError) => e.code === INVALID_PARAMS);
    await assert.rejects(h.set("model", NO_MODEL), (e: RpcError) => e.code === INVALID_PARAMS);
    await assert.rejects(h.set("temperature", "hot"), (e: RpcError) => e.code === INVALID_PARAMS);
    await assert.rejects(h.set("autonomy", "reckless"), (e: RpcError) => e.code === INVALID_PARAMS);
  });

  it("never switches mid-turn: the running turn keeps its model, the next one gets the new one", async () => {
    let hang = true;
    const h = await harness({ reply: () => (hang ? { hang: true } : { text: "ok" }) });
    const running = h.prompt("long");
    await new Promise((r) => setTimeout(r, 20));
    const r = await h.set("model", `${B}#b-small`);
    assert.equal(byId(r.configOptions, "model")!.currentValue, `${B}#b-small`, "the picker shows the choice");
    assert.equal(h.engines[0]!.model, "a-model", "the engine is untouched while the turn runs");
    assert.equal(h.applied.length, 0);
    h.client.notify("session/cancel", { sessionId: h.sid });
    await running;
    assert.deepEqual(h.applied, [{ url: B, model: "b-small" }], "applied once the turn ended");
    hang = false;
    await h.prompt("next");
    assert.deepEqual(h.net.sent.at(-1), { url: B, model: "b-small" });
    assert.ok(h.net.sent.slice(0, -1).every((s) => s.url === A), "nothing before went to B");
  });

  it("autonomy is one setting on both paths", async () => {
    const h = await harness();
    await h.set("autonomy", "medium");
    assert.equal(h.engines[0]!.autonomy, "medium");
    assert.ok(h.updates.some((u) => u.sessionUpdate === "current_mode_update" && u.currentModeId === "medium"));
    await h.call("session/set_mode", { sessionId: h.sid, modeId: "high" });
    const last = h.optionUpdates().at(-1)!;
    assert.equal(byId(last.configOptions as ConfigOption[], "autonomy")!.currentValue, "high");
  });

  it("effort appears for a model that takes it, and goes when the model changes", async () => {
    const h = await harness({ effortLevels: (_url, model) => (model === "b-model" ? ["low", "medium", "high"] : null) });
    assert.equal(byId(h.opened.configOptions, "effort"), undefined);

    const withEffort = await h.set("model", `${B}#b-model`);
    const effort = byId(withEffort.configOptions, "effort")!;
    assert.equal(effort.category, "thought_level");
    assert.equal(effort.currentValue, "medium");
    assert.ok(byId(h.optionUpdates().at(-1)!.configOptions as ConfigOption[], "effort"), "announced by update too");

    const raised = await h.set("effort", "high");
    assert.equal(byId(raised.configOptions, "effort")!.currentValue, "high");
    await assert.rejects(h.set("effort", "extreme"), (e: RpcError) => e.code === INVALID_PARAMS);

    const without = await h.set("model", `${B}#b-small`);
    assert.equal(byId(without.configOptions, "effort"), undefined);
    assert.equal(byId(h.optionUpdates().at(-1)!.configOptions as ConfigOption[], "effort"), undefined);
    await assert.rejects(h.set("effort", "low"), (e: RpcError) => e.code === INVALID_PARAMS);
  });

  it("with no model, the picker says so and a prompt is refused with what to do", async () => {
    const h = await harness({ model: "" });
    assert.equal(byId(h.opened.configOptions, "model")!.currentValue, NO_MODEL);
    await assert.rejects(h.prompt("hi"), (e: RpcError) => e.code === INVALID_REQUEST && /model picker/.test(e.message));
    await h.set("model", `${B}#b-model`);
    assert.equal((await h.prompt("hi")).stopReason, "end_turn");
  });
});

// ---------------------------------------------------------------------------
// The built binary
// ---------------------------------------------------------------------------

describe("molt acp over stdio: choosing a second endpoint", { timeout: 60_000 }, () => {
  it("lists it, switches to it, and the next turn's request goes there", async () => {
    const first = await scriptServer(() => ({ text: "from the first endpoint" }), { models: ["first-model"] });
    const second = await scriptServer(() => ({ text: "from the second endpoint" }), { models: ["second-model", "second-small"] });
    cleanups.push(first.close, second.close);
    const project = mkdtempSync(join(tmpdir(), "molt-acp-cfgopt-"));
    const config = mkdtempSync(join(tmpdir(), "molt-acp-cfgopt-cfg-"));
    cleanups.push(() => rmSync(project, { recursive: true, force: true }));
    cleanups.push(() => rmSync(config, { recursive: true, force: true }));
    mkdirSync(config, { recursive: true });
    // The second server is one the window remembers.
    writeFileSync(join(config, "desktop-endpoints.json"), JSON.stringify([{ url: second.url, seen: "t" }]));

    const spec = {
      name: "molt", label: "molt", url: "molt://acp", bin: process.execPath,
      args: [join(process.cwd(), "dist", "cli.js"), "acp", "--url", first.url, "--model", "first-model", "--yes"],
      models: [], installHint: "", loginHint: "", credentialPath: "", mcpTransport: "stdio", sessionMeta: () => ({}),
    } as AcpAgentSpec;
    let stdout = "";
    const updates: Record<string, unknown>[] = [];
    const conn = new AcpConnection(spec, {
      cwd: project,
      spawnFn: ((bin: string, args: string[], opts: Record<string, unknown>) => {
        const c = spawn(bin, args, {
          ...opts,
          env: {
            ...process.env,
            MOLT_CONFIG_DIR: config,
            // Detection mocked: Grok Build is declared usable, nothing is spawned.
            MOLT_ACP_SUBSCRIPTIONS: "grok-build",
            MOLT_ACP_DISCOVERY_WAIT_MS: "10000",
          },
        });
        c.stdout.on("data", (d) => (stdout += String(d)));
        return c;
      }) as unknown as typeof spawn,
      onNotify: (m, p) => {
        if (m === "session/update") updates.push((p as { update: Record<string, unknown> }).update);
      },
      onRequest: async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }),
    });
    await conn.start();
    cleanups.push(() => conn.close());

    await conn.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const opened = (await conn.request("session/new", { cwd: project, mcpServers: [] })) as {
      sessionId: string;
      configOptions: ConfigOption[];
    };
    const model = byId(opened.configOptions, "model")!;
    assert.equal(model.currentValue, `${first.url}#first-model`);
    const groups = groupsOf(model);
    assert.deepEqual(groups.map((g) => g.name), ["Subscriptions", "Local"]);
    assert.deepEqual(groups[0]!.options.map((o) => o.value), [
      `${GROK_BUILD_URL}#grok-4.7`,
      `${GROK_BUILD_URL}#grok-4.7-build-fast`,
      `${GROK_BUILD_URL}#grok-4.6`,
      `${GROK_BUILD_URL}#grok-4.5`,
    ]);
    assert.ok(optionHas(model, `${second.url}#second-small`));

    await conn.request("session/prompt", { sessionId: opened.sessionId, prompt: [{ type: "text", text: "one" }] });
    assert.equal(first.requests.at(-1)!.model, "first-model");

    const switched = (await conn.request("session/set_config_option", {
      sessionId: opened.sessionId,
      configId: "model",
      value: `${second.url}#second-small`,
    })) as { configOptions: ConfigOption[] };
    assert.equal(byId(switched.configOptions, "model")!.currentValue, `${second.url}#second-small`);

    const r = (await conn.request("session/prompt", {
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "two" }],
    })) as { stopReason: string; _meta: { molt: { verdict: string } } };
    assert.equal(r.stopReason, "end_turn");
    assert.equal(r._meta.molt.verdict, "unverified");
    assert.equal(second.requests.length, 1);
    assert.equal(second.requests[0]!.model, "second-small");
    assert.equal(first.requests.length, 1, "nothing more went to the first endpoint");

    // Remembered the way /model remembers it.
    const cfg = JSON.parse(readFileSync(join(config, "config.json"), "utf8")) as { baseUrl: string; model: string };
    assert.deepEqual([cfg.baseUrl, cfg.model], [second.url, "second-small"]);

    await conn.close();
    for (const line of stdout.split("\n").filter(Boolean)) {
      assert.equal((JSON.parse(line) as { jsonrpc: string }).jsonrpc, "2.0");
    }
  });
});
