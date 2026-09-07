/**
 * The ACP backends: a Grok or Gemini subscription doing the work, molt still
 * judging it.
 *
 * The thing worth pinning is not that the backend runs. It is that running the
 * model behind a protocol molt does not control changes nothing about what
 * molt will accept — every write still arrives as a tool call molt executes,
 * so the ledger is complete and `tree-accounted` still means something; a
 * builtin the agent reaches for is refused rather than quietly allowed; and a
 * run that costs no money never grows a dollar figure.
 *
 * Every test drives a scripted agent over a real pipe, and that agent reaches
 * molt's tools over the real loopback MCP server. Nothing spawns `grok`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  ACP_AGENTS,
  acpAgentFor,
  acpHealth,
  acpModels,
  isAcp,
  McpToolServer,
  mcpEntry,
  bridgePath,
} from "../src/acp.js";
import { Archive } from "../src/archive.js";
import { parseBar } from "../src/bar.js";
import { CLAUDE_CODE_URL } from "../src/claude-code.js";
import { draftCriteria } from "../src/criteria.js";
import { Engine } from "../src/engine.js";
import { interviewTurn } from "../src/interview.js";
import { isSelfHosted, PROVIDERS, providerName } from "../src/providers.js";
import { Receipts } from "../src/receipts.js";
import { scriptedAcpAgent, type ScriptedAcpTurn } from "./acp-agent.js";
import { allowAll, denyAll, drain, workspace } from "./helpers.js";

const BAR = parseBar(`
version: 1
checks:
  - name: work-landed
    builtin: files-changed
  - name: work-accounted
    builtin: tree-accounted
`);

const GROK = ACP_AGENTS.find((a) => a.name === "grok-build")!;
const GEMINI = ACP_AGENTS.find((a) => a.name === "gemini-cli")!;

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

function ws(): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

function engineIn(dir: string, turns: ScriptedAcpTurn[], url = GROK.url) {
  const agent = scriptedAcpAgent(turns);
  const engine = new Engine({
    baseUrl: url,
    model: "grok-4.6",
    provider: "grok-build",
    cwd: dir,
    bar: BAR,
    archive: new Archive(dir),
    receipts: new Receipts(dir),
    acpSpawn: agent.spawnFn,
    maxProofAttempts: 2,
    // A price that would be applied if anything applied one. Nothing should.
    priceInPerMtok: 2,
    priceOutPerMtok: 6,
  });
  return { engine, agent };
}

describe("which backend an endpoint names", () => {
  it("recognises each ACP URL and nothing else", () => {
    assert.equal(isAcp(GROK.url), true);
    assert.equal(isAcp(GEMINI.url), true);
    assert.equal(isAcp("grok-build://anything"), true);
    assert.equal(isAcp(CLAUDE_CODE_URL), false);
    assert.equal(isAcp("https://api.x.ai/v1"), false);
    assert.equal(isAcp(undefined), false);
    assert.equal(acpAgentFor(GROK.url)?.bin, "grok");
    assert.equal(acpAgentFor(GEMINI.url)?.bin, "gemini");
  });

  /**
   * The metered xAI endpoint and the subscription CLI are different products
   * on different bills, and molt must never resolve one to the other — that
   * confusion is what would charge an API account for a turn the plan paid
   * for, or send a plan's OAuth token at an endpoint expecting a key.
   */
  it("keeps the subscription apart from the metered API", () => {
    assert.equal(providerName(GROK.url), "grok-build");
    assert.equal(providerName("https://api.x.ai/v1"), "xai");
    assert.equal(PROVIDERS["grok-build"]?.needsKey, false);
    assert.equal(PROVIDERS.xai?.needsKey, true);
  });

  /**
   * The URL has no dots in it, which every other rule in `isSelfHosted` reads
   * as a LAN hostname — and self-hosted turns the repo map off, which is
   * measurably the wrong default for a frontier model.
   */
  it("is not mistaken for a machine you run", () => {
    assert.equal(isSelfHosted(GROK.url), false);
    assert.equal(isSelfHosted(GEMINI.url), false);
  });

  it("offers the models the CLI resolves, and no invented ones", () => {
    assert.deepEqual(acpModels(GROK.url), [...GROK.models]);
    assert.deepEqual(acpModels("https://api.x.ai/v1"), []);
  });
});

describe("molt's tools, served over loopback MCP", () => {
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "write_file",
        description: "write a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ];

  async function serve(): Promise<{
    server: McpToolServer<never>;
    endpoint: { url: string; headers: { name: string; value: string }[] };
    ran: string[];
  }> {
    const ran: string[] = [];
    const server = new McpToolServer<never>(
      tools,
      async (name) => {
        ran.push(name);
        return `ran ${name}`;
      },
      () => {},
    );
    const endpoint = await server.listen();
    return { server, endpoint, ran };
  }

  const post = async (
    endpoint: { url: string; headers: { name: string; value: string }[] },
    body: unknown,
    auth = true,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? Object.fromEntries(endpoint.headers.map((h) => [h.name, h.value])) : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  /**
   * Loopback is reachable by every process on the machine and molt's tools
   * write files. An unauthenticated port here is a local write primitive for
   * anything that guessed it.
   */
  it("refuses a caller without the session token", async () => {
    const { server, endpoint } = await serve();
    const res = await post(endpoint, { jsonrpc: "2.0", id: 1, method: "tools/list" }, false);
    assert.equal(res.status, 401);
    await server.close();
  });

  it("lists molt's tools and runs one", async () => {
    const { server, endpoint, ran } = await serve();
    const listed = await post(endpoint, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = ((listed.json.result as { tools?: { name: string }[] })?.tools ?? []).map(
      (t) => t.name,
    );
    assert.deepEqual(names, ["write_file"]);

    const called = await post(endpoint, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "mcp__molt__write_file", arguments: { path: "a.txt" } },
    });
    assert.deepEqual(ran, ["write_file"], "the prefix the agent uses must be stripped");
    const content = (called.json.result as { content?: { text?: string }[] })?.content ?? [];
    assert.equal(content[0]?.text, "ran write_file");
    await server.close();
  });

  /**
   * A tool molt does not serve is answered as a failed call rather than a
   * dead connection: an agent waiting forever on a reply looks exactly like a
   * model that has stopped thinking.
   */
  it("refuses a tool it does not serve, and says which", async () => {
    const { server, endpoint, ran } = await serve();
    const called = await post(endpoint, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "mcp__molt__rm_rf", arguments: {} },
    });
    assert.deepEqual(ran, []);
    assert.equal((called.json.result as { isError?: boolean })?.isError, true);
    assert.deepEqual(server.refused, ["rm_rf"]);
    await server.close();
  });
});

/**
 * The transport Gemini needs, because it cannot take the one Grok takes.
 *
 * An HTTP entry Gemini ignores does not fail — it produces an agent with no
 * tools at all, wondering why it cannot write anything. The bridge is the
 * difference between that and a working backend, so it is spawned for real
 * here rather than described.
 */
describe("the stdio bridge to molt's tool server", () => {
  it("hands each agent the transport it can actually use", async () => {
    const endpoint = { url: "http://127.0.0.1:1/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] };
    assert.equal(mcpEntry(GROK, endpoint).type, "http");
    assert.equal(mcpEntry(GROK, endpoint).url, endpoint.url);

    const stdio = mcpEntry(GEMINI, endpoint);
    assert.equal(stdio.type, "stdio");
    const env = stdio.env as { name: string; value: string }[];
    assert.equal(env.find((e) => e.name === "MOLT_MCP_TOKEN")?.value, "t", "the Bearer prefix is not part of the token");
    assert.equal(env.find((e) => e.name === "MOLT_MCP_URL")?.value, endpoint.url);
  });

  /**
   * A path handed to an agent that does not resolve produces a spawn failure
   * the agent reports as "no tools" and molt never sees. Caught here, where it
   * can still name itself — and named loudly, because the packaged app's
   * `import.meta` is an empty object and this is where that lands.
   */
  it("refuses a bridge path that is not there, rather than handing it over", () => {
    const before = process.env.MOLT_MCP_BRIDGE;
    process.env.MOLT_MCP_BRIDGE = join(ws(), "not-here.js");
    try {
      assert.throws(() => bridgePath(), /MOLT_MCP_BRIDGE|cannot find/u);
    } finally {
      if (before === undefined) delete process.env.MOLT_MCP_BRIDGE;
      else process.env.MOLT_MCP_BRIDGE = before;
    }
  });

  it("forwards a real tool call over a real pipe", async () => {
    const ran: string[] = [];
    const server = new McpToolServer<never>(
      [
        {
          type: "function" as const,
          function: { name: "grep", description: "search", parameters: { type: "object" } },
        },
      ],
      async (name) => {
        ran.push(name);
        return "found nothing";
      },
      () => {},
    );
    const endpoint = await server.listen();
    const entry = mcpEntry(GEMINI, endpoint);
    const env = Object.fromEntries(
      (entry.env as { name: string; value: string }[]).map((e) => [e.name, e.value]),
    );
    const child = spawn(process.execPath, entry.args as string[], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const replies: Record<string, unknown>[] = [];
    const done = new Promise<void>((resolve) => {
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        buf += d;
        for (;;) {
          const i = buf.indexOf("\n");
          if (i < 0) break;
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) replies.push(JSON.parse(line) as Record<string, unknown>);
        }
        if (replies.length >= 2) resolve();
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "mcp__molt__grep", arguments: { pattern: "x" } },
      })}\n`,
    );
    await done;
    child.kill();
    await server.close();

    const listed = replies.find((r) => r.id === 1)?.result as { tools?: { name: string }[] };
    assert.deepEqual((listed?.tools ?? []).map((t) => t.name), ["grep"]);
    assert.deepEqual(ran, ["grep"], "the call must reach molt's handler, not a copy of it");
    const called = replies.find((r) => r.id === 2)?.result as { content?: { text?: string }[] };
    assert.equal(called?.content?.[0]?.text, "found nothing");
  });
});

describe("a turn done by an ACP agent", () => {
  it("writes through molt's tools, so the ledger is complete", async () => {
    const dir = ws();
    const { engine, agent } = engineIn(dir, [
      {
        calls: [{ name: "write_file", args: { path: "hello.txt", content: "hi\n" } }],
        text: "Wrote hello.txt.",
      },
    ]);
    const events = await drain(engine.run("create hello.txt", allowAll));

    assert.equal(readFileSync(join(dir, "hello.txt"), "utf8"), "hi\n");

    // The same tool event the HTTP backend produces, from the same code.
    const tool = events.find((e) => e.kind === "tool") as { name: string } | undefined;
    assert.equal(tool?.name, "write_file");

    // And the bar ran and passed, which it can only do if the write is in the
    // ledger: `tree-accounted` refuses a tree change no tool call explains.
    const result = events.find((e) => e.kind === "proof_result") as
      | { result: { ok: boolean; results: { name: string; ok: boolean }[] } }
      | undefined;
    assert.ok(result, "the bar should have run");
    assert.equal(result.result.ok, true, JSON.stringify(result.result.results));

    // The agent was handed molt's tool table and nothing else.
    assert.ok(agent.toolsSeen().includes("write_file"));
  });

  /**
   * The layer that does not depend on the CLI honouring a profile. Whatever
   * the agent believes it is allowed to do, a tool it cannot get approved is
   * a tool it cannot run.
   */
  it("refuses the agent's own builtins, and says so on screen", async () => {
    const dir = ws();
    const { engine, agent } = engineIn(dir, [
      {
        builtins: ["write_file_native", "bash"],
        calls: [{ name: "write_file", args: { path: "ok.txt", content: "x\n" } }],
        text: "Done.",
      },
    ]);
    const events = await drain(engine.run("do the work", allowAll));

    const denied = agent.permissions.filter((p) => p.outcome === "no").map((p) => p.tool);
    assert.deepEqual(denied.sort(), ["bash", "write_file_native"]);
    const allowed = agent.permissions.filter((p) => p.outcome === "yes").map((p) => p.tool);
    assert.deepEqual(allowed, ["mcp__molt__write_file"]);

    const notes = events
      .filter((e) => e.kind === "info")
      .map((e) => (e as { text?: string }).text ?? "");
    assert.ok(
      notes.some((t) => /refused .*'bash'/u.test(t)),
      `a refusal should be visible, got: ${JSON.stringify(notes)}`,
    );
    /**
     * And a refused tool is not reported as one that ran. The first draft of
     * this backend concluded at the announcement, which arrives before the
     * permission request — so every refusal was also announced as an
     * unaccounted write, which is the one claim that would make a receipt
     * lie in the direction that matters.
     */
    assert.ok(
      !notes.some((t) => /ran its own 'bash'/u.test(t)),
      `a refused tool must not be reported as having run, got: ${JSON.stringify(notes)}`,
    );
  });

  /**
   * The gap this backend cannot close, pinned so it stays visible: Grok
   * auto-approves its read-only tools, and those never reach molt's refusal.
   * They do not change the tree, so `tree-accounted` is unharmed — but the
   * ledger is not a complete record of what the model looked at, and molt
   * says so on screen rather than leaving it to be discovered in a receipt.
   */
  it("reports a builtin that ran without asking, rather than hiding it", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
      {
        autoTools: ["read_file"],
        calls: [{ name: "write_file", args: { path: "x.txt", content: "x\n" } }],
        text: "Done.",
      },
    ]);
    const events = await drain(engine.run("read then write", allowAll));
    const notes = events
      .filter((e) => e.kind === "info")
      .map((e) => (e as { text?: string }).text ?? "");
    assert.ok(
      notes.some((t) => /ran its own 'read_file' without asking/u.test(t)),
      `an unaccounted builtin should be named, got: ${JSON.stringify(notes)}`,
    );
  });

  it("gates a tool call the same way, and records the refusal", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
      { calls: [{ name: "write_file", args: { path: "no.txt", content: "x" } }], text: "tried" },
    ]);
    await drain(engine.run("break things", denyAll));
    assert.equal(existsSync(join(dir, "no.txt")), false, "a denied call must not have written");
  });

  /**
   * A subscription run is not metered, so the receipt says the plan paid for
   * it. A price that would be applied if anything applied one is configured
   * above; nothing should.
   */
  it("puts no dollar figure on a plan's work", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
      { calls: [{ name: "write_file", args: { path: "a.txt", content: "x\n" } }], text: "done" },
    ]);
    const events = await drain(engine.run("write a.txt", allowAll));
    const summary = events.find((e) => e.kind === "step_summary") as
      | { spend: { costUsd?: number; billed: boolean } }
      | undefined;
    assert.ok(summary, "expected a step summary");
    assert.equal(summary.spend.costUsd, undefined, "a subscription turn must carry no cost");
    assert.equal(summary.spend.billed, false, "the plan paid for this, not a key");
  });

  /**
   * Zero is a measurement, not an absence — and reporting it disables the one
   * ceiling that still means anything on a subscription. A plan has no dollars
   * for `/budget` to bound, so the token ceiling is the whole safety rail; a
   * backend reporting zero tokens runs forever by construction. The salvage
   * test found this, because a budget the backend can never trip never
   * salvages.
   */
  it("counts tokens itself, so a ceiling still bounds the run", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
      { calls: [{ name: "write_file", args: { path: "a.txt", content: "x\n" } }], text: "done" },
    ]);
    const events = await drain(engine.run("write a.txt", allowAll));
    const summary = events.find((e) => e.kind === "step_summary") as
      | { spend: { promptTokens: number; completionTokens: number } }
      | undefined;
    assert.ok(summary, "expected a step summary");
    assert.ok(
      summary.spend.promptTokens > 0,
      "a step that sent a prompt must not report zero tokens",
    );
    assert.ok(summary.spend.completionTokens > 0, "nor zero for what came back");
  });

  /** What molt tells the agent, which is what a receipt claims it was told. */
  it("hands the agent molt's system prompt and its own profile", async () => {
    const dir = ws();
    const { engine, agent } = engineIn(dir, [{ text: "hello" }]);
    await drain(engine.run("say hello", allowAll));
    const meta = (agent.sessionParams()._meta ?? {}) as Record<string, unknown>;
    assert.equal(typeof meta.systemPromptOverride, "string");
    assert.ok(
      String(meta.systemPromptOverride).length > 0,
      "the agent must be given molt's rules, not its own",
    );
    // Grok's documented lever for stripping its builtins.
    assert.deepEqual((meta.agentProfile as { tools?: string }).tools, "");
    // And molt hosts no filesystem for it: every write is a tool call.
    const servers = agent.sessionParams().mcpServers as { name?: string }[];
    assert.deepEqual(servers.map((s) => s.name), ["molt"]);
  });
});

describe("health", () => {
  it("keeps 'not installed' apart from 'not signed in'", async () => {
    const missing = await acpHealth(GROK, {
      run: async () => {
        throw new Error("ENOENT");
      },
    });
    assert.equal(missing.installed, false);
    assert.equal(missing.ok, false);
    assert.equal(missing.fix, GROK.installHint);

    const out = await acpHealth(GROK, {
      run: async () => ({ stdout: "1.0.13 (abc)\n" }),
      probe: async () => ({ authenticated: false, detail: "not signed in" }),
    });
    assert.equal(out.installed, true);
    assert.equal(out.version, "1.0.13");
    assert.equal(out.authenticated, false);
    assert.equal(out.fix, GROK.loginHint, "a logged-out CLI needs a login, not an install");
    assert.match(out.detail, /1\.0\.13/u);

    const ok = await acpHealth(GROK, {
      run: async () => ({ stdout: "1.0.13\n" }),
      probe: async () => ({ authenticated: true }),
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.fix, undefined);
  });

  /**
   * A signed-out agent answers `initialize` happily and only fails at
   * `session/new` — the state that would otherwise read as healthy right up
   * until the first turn spent nothing and reported nothing.
   */
  it("surfaces a signed-out agent as a turn that failed, not as a hang", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [{ authError: true }]);
    const events = await drain(engine.run("do the work", allowAll));
    const errors = events
      .filter((e) => e.kind === "error")
      .map((e) => (e as { text?: string }).text ?? "");
    assert.ok(
      errors.some((t) => /Auth/iu.test(t)),
      `the refusal should reach the reader, got: ${JSON.stringify(errors)}`,
    );
  });
});

/**
 * Every path that would otherwise speak HTTP on an ACP endpoint.
 *
 * `grok-build://subscription` is a name for "the subscription is doing the
 * work", not a URL, and `fetch` refuses the scheme with the six words
 * "TypeError: fetch failed" — a sentence that names neither the cause nor the
 * layer, and that a reader cannot tell from a dead local server. Claude Code
 * shipped that bug three times over before `claude-code-http-leak.test.ts`
 * pinned it; this is the same invariant for the same reason, written at the
 * same time as the backend rather than after the third report.
 */
describe("nothing on an ACP endpoint reaches for HTTP", () => {
  /** A fetch that fails the test rather than the request. */
  const noFetch = (where: string): typeof fetch =>
    ((input: unknown) => {
      assert.fail(`${where} sent an HTTP request to ${String(input)}`);
    }) as unknown as typeof fetch;

  it("drafts criteria through the agent instead of over HTTP", async () => {
    const agent = scriptedAcpAgent([
      { text: '{"checks":[{"name":"suite","run":"npm test"}],"notes":["reads cleanly"]}' },
    ]);
    const r = await draftCriteria({
      task: "audit this repo",
      scripts: ["test"],
      barChecks: ["types"],
      baseUrl: GROK.url,
      model: "grok-4.6",
      fetchFn: noFetch("draftCriteria"),
      acpSpawn: agent.spawnFn,
    });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.deepEqual(r.ok ? r.draft.checks.map((c) => c.run) : [], ["npm test"]);
    assert.ok(agent.sent.some((t) => t.includes("audit this repo")), JSON.stringify(agent.sent));
    /**
     * A question is not work: this path is given no tool server at all, so
     * nothing it does can land on disk without a ledger entry behind it.
     */
    assert.deepEqual(agent.sessionParams().mcpServers, []);
  });

  it("interviews through the agent instead of over HTTP", async () => {
    const agent = scriptedAcpAgent([
      {
        text: JSON.stringify({
          questions: [
            { id: "q1", prompt: "What counts as done?", options: ["tests pass", "a demo"] },
          ],
        }),
      },
    ]);
    const r = await interviewTurn({
      task: "audit this repo",
      scripts: ["test"],
      barChecks: ["types"],
      history: [],
      round: 1,
      baseUrl: GROK.url,
      model: "grok-4.6",
      fetchFn: noFetch("interviewTurn"),
      acpSpawn: agent.spawnFn,
    });
    assert.equal(r.kind, "ask");
    assert.equal(r.kind === "ask" ? r.questions[0]?.prompt : "", "What counts as done?");
  });

  /**
   * The salvage is the expensive one. It is the last request of a turn molt
   * cut short, and every ceiling in the loop ends in one — so a backend that
   * could not salvage put nothing on screen at the exact moment a reader most
   * needs to know what happened.
   */
  it("salvages through the agent instead of over HTTP", async () => {
    const dir = ws();
    const agent = scriptedAcpAgent([
      // Says something, writes nothing, so the bar refuses it.
      { text: "Read a few files. Nothing written yet." },
      // The salvage: it answers rather than working.
      { text: "I read the config and the engine. I did not verify anything." },
    ]);
    const engine = new Engine({
      baseUrl: GROK.url,
      model: "grok-4.6",
      provider: "grok-build",
      cwd: dir,
      bar: BAR,
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      acpSpawn: agent.spawnFn,
      maxProofAttempts: 2,
      // Nothing on this backend may reach the network at all.
      fetchFn: noFetch("the salvage"),
    });
    // Small enough that the second pass through the loop is over it.
    engine.setBudget(1);

    const events = await drain(engine.run("audit this repo", allowAll));
    const said = events
      .filter((e) => e.kind === "assistant_text")
      .map((e) => (e as { text?: string }).text ?? "");
    assert.ok(
      said.some((t) => t.includes("I did not verify anything")),
      `the salvaged answer must reach the reader, got ${JSON.stringify(said)}`,
    );
  });

  /** And the two places that ask an endpoint what it has. */
  it("lists models and preflights without a request", async () => {
    const dir = ws();
    const engine = new Engine({
      baseUrl: GROK.url,
      model: "grok-4.6",
      provider: "grok-build",
      cwd: dir,
      bar: BAR,
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      fetchFn: noFetch("listModels"),
    });
    const listed = await engine.listModels();
    assert.deepEqual(listed.ok ? listed.ids : [], [...GROK.models]);
  });
});
