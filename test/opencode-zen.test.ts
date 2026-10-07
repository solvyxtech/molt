/**
 * The OpenCode backend runs OpenCode Zen models (`opencode/...`) and nothing
 * else. OpenCode can sign in to other vendors' consumer plans (Anthropic,
 * GitHub Copilot, Gemini, ...); Maat must never route through them, as worker
 * or judge, and must never hand the CLI a config or credential that enables
 * them. Also the `opencode://zen` rename, with the old spelling deprecated.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ACP_AGENTS, acpAgentFor, acpAsk, acpModelFor } from "../src/acp.js";
import { Archive } from "../src/archive.js";
import { askModel } from "../src/ask.js";
import { parseBar } from "../src/bar.js";
import { parseArgs } from "../src/cli.js";
import {
  endpointDeprecation,
  endpointProblem,
  expandEndpointShorthand,
  OPENCODE_LEGACY_URL,
  OPENCODE_URL,
  opencodeModelProblem,
} from "../src/endpoint.js";
import { Engine } from "../src/engine.js";
import { judgeTarget } from "../src/judge.js";
import { OPENCODE_CONFIG, opencodeAsk, opencodeChildEnv, opencodeEnv, opencodeModel } from "../src/opencode.js";
import { Receipts } from "../src/receipts.js";
import { scriptedAcpAgent } from "./acp-agent.js";
import { allowAll, drain, workspace } from "./helpers.js";

const OPENCODE = ACP_AGENTS.find((a) => a.name === "opencode")!;
const FOREIGN = [
  "anthropic/claude-sonnet-4-5",
  "github-copilot/gpt-5",
  "google/gemini-2.5-pro",
  "openai/gpt-5",
  "xai/grok-4",
  "openrouter/anthropic/claude-sonnet-4-5",
  "opencode/../anthropic/claude",
  "opencode/a b",
];
const BAR = parseBar(`
version: 1
checks:
  - name: work-landed
    builtin: files-changed
`);

const noFetch = ((input: unknown) => {
  assert.fail(`sent an HTTP request to ${String(input)}`);
}) as unknown as typeof fetch;

describe("opencode://zen", () => {
  it("is the OpenCode endpoint, and `opencode` still means it", () => {
    assert.equal(OPENCODE_URL, "opencode://zen");
    assert.equal(expandEndpointShorthand("opencode"), OPENCODE_URL);
    assert.equal(OPENCODE.url, OPENCODE_URL);
    assert.equal(endpointProblem(OPENCODE_URL), null);
  });

  it("accepts the old opencode://subscription with a deprecation notice, as the new name", () => {
    assert.equal(OPENCODE_LEGACY_URL, "opencode://subscription");
    assert.equal(endpointProblem(OPENCODE_LEGACY_URL), null);
    assert.equal(expandEndpointShorthand(OPENCODE_LEGACY_URL), OPENCODE_URL);
    assert.equal(acpAgentFor(OPENCODE_LEGACY_URL)?.name, "opencode");
    assert.match(endpointDeprecation(OPENCODE_LEGACY_URL) ?? "", /deprecated.*opencode:\/\/zen/);
    assert.equal(endpointDeprecation(OPENCODE_URL), null);
    assert.equal(parseArgs(["--judge", "opencode/big-pickle", "--judge-url", OPENCODE_LEGACY_URL, "x"], {}).judgeUrl, OPENCODE_URL);
    assert.equal(parseArgs(["--url", OPENCODE_LEGACY_URL, "--model", "opencode/big-pickle", "run", "x"], {}).url, OPENCODE_URL);
    assert.equal(parseArgs(["--model", "opencode/big-pickle", "run", "x"], { baseUrl: OPENCODE_LEGACY_URL }).url, OPENCODE_URL);
    assert.equal(judgeTarget({ baseUrl: "https://x/v1", model: "m" }, { MAAT_JUDGE_MODEL: "big-pickle", MAAT_JUDGE_URL: OPENCODE_LEGACY_URL }).baseUrl, OPENCODE_URL);
  });

  it("refuses any other opencode:// name", () => {
    assert.match(endpointProblem("opencode://anthropic") ?? "", /not an OpenCode endpoint/);
  });
});

describe("only OpenCode Zen models", () => {
  it("allows opencode/<model> and a bare <model>", () => {
    for (const m of ["opencode/big-pickle", "big-pickle", "opencode/claude-sonnet-4-5", "", "  opencode/gpt-5.1-codex  "]) {
      assert.equal(opencodeModelProblem(m), null, m);
    }
    assert.equal(opencodeModel("big-pickle"), "opencode/big-pickle");
    assert.equal(opencodeModel(""), "opencode/big-pickle");
  });

  it("refuses every other provider, with a message that says why", () => {
    for (const m of FOREIGN) {
      assert.match(opencodeModelProblem(m) ?? "", /not an OpenCode Zen model/, m);
      assert.throws(() => opencodeModel(m), /not an OpenCode Zen model/, m);
      assert.match(acpModelFor(OPENCODE, m).problem ?? "", /not an OpenCode Zen model/, m);
    }
  });

  it("refuses a foreign worker model at parse time", () => {
    for (const m of FOREIGN) {
      assert.throws(() => parseArgs(["--url", "opencode", "--model", m, "run", "x"], {}), /--model: .*not an OpenCode Zen model/, m);
    }
    assert.throws(() => parseArgs(["run", "x"], { baseUrl: OPENCODE_URL, model: "anthropic/claude-sonnet-4-5" }), /not an OpenCode Zen model/);
    assert.equal(parseArgs(["--url", "opencode", "--model", "big-pickle", "run", "x"], {}).model, "big-pickle");
  });

  it("refuses a foreign judge model at parse time, from flags or the environment", () => {
    for (const m of FOREIGN) {
      assert.throws(() => parseArgs(["--judge", m, "--judge-url", "opencode", "x"], {}), /--judge: .*not an OpenCode Zen model/, m);
    }
    // A judge on the worker's own OpenCode endpoint.
    assert.throws(
      () => parseArgs(["--url", "opencode", "--model", "big-pickle", "--judge", "github-copilot/gpt-5", "x"], {}),
      /--judge: .*not an OpenCode Zen model/,
    );
    const saved = { m: process.env.MAAT_JUDGE_MODEL, u: process.env.MAAT_JUDGE_URL };
    try {
      process.env.MAAT_JUDGE_MODEL = "anthropic/claude-sonnet-4-5";
      process.env.MAAT_JUDGE_URL = OPENCODE_URL;
      assert.throws(() => parseArgs(["x"], {}), /--judge: .*not an OpenCode Zen model/);
      process.env.MAAT_JUDGE_MODEL = "opencode/big-pickle";
      assert.doesNotThrow(() => parseArgs(["x"], {}));
    } finally {
      if (saved.m === undefined) delete process.env.MAAT_JUDGE_MODEL;
      else process.env.MAAT_JUDGE_MODEL = saved.m;
      if (saved.u === undefined) delete process.env.MAAT_JUDGE_URL;
      else process.env.MAAT_JUDGE_URL = saved.u;
    }
  });

  it("refuses a foreign judge at run time without spawning the CLI (opencode run path)", async () => {
    let ran = 0;
    const run = async () => {
      ran++;
      return { stdout: "" };
    };
    for (const m of FOREIGN) {
      const r = await opencodeAsk({ model: m, systemPrompt: "S", prompt: "P", run });
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.error, /not an OpenCode Zen model/);
    }
    // Through askModel, as the judge set by MAAT_JUDGE_* would be.
    const t = judgeTarget({ baseUrl: "https://x/v1", model: "m" }, { MAAT_JUDGE_MODEL: "github-copilot/gpt-5", MAAT_JUDGE_URL: "opencode" });
    const r = await askModel({ ...t, system: "S", prompt: "P", fetchFn: noFetch, cliRun: run, timeoutMs: 5_000 });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /not an OpenCode Zen model/);
    assert.equal(ran, 0);
  });

  it("refuses a foreign model at run time without spawning the CLI (ACP ask path)", async () => {
    const agent = scriptedAcpAgent([{ text: "hi" }]);
    let spawned = 0;
    const spawnFn = ((...a: Parameters<typeof agent.spawnFn>) => {
      spawned++;
      return agent.spawnFn(...a);
    }) as typeof agent.spawnFn;
    const r = await acpAsk({ spec: OPENCODE, model: "anthropic/claude-sonnet-4-5", systemPrompt: "S", prompt: "P", spawnFn, timeoutMs: 5_000 });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /not an OpenCode Zen model/);
    assert.equal(spawned, 0);
  });

  it("asks for Big Pickle rather than OpenCode's own default when no model is named", async () => {
    const agent = scriptedAcpAgent([{ text: "hi" }], {
      current: "anthropic/claude-sonnet-4-5",
      available: ["anthropic/claude-sonnet-4-5", "opencode/big-pickle"],
    });
    const r = await acpAsk({ spec: OPENCODE, model: "", systemPrompt: "S", prompt: "P", spawnFn: agent.spawnFn, timeoutMs: 5_000 });
    assert.equal(r.ok, true);
    assert.deepEqual(agent.modelsSet, ["opencode/big-pickle"]);
  });

  it("refuses a foreign worker model at run time without spawning the CLI (ACP session)", async () => {
    const w = workspace();
    after(w.cleanup);
    const dir = w.dir;
    const agent = scriptedAcpAgent([{ text: "done" }]);
    let spawned = 0;
    const spawnFn = ((...a: Parameters<typeof agent.spawnFn>) => {
      spawned++;
      return agent.spawnFn(...a);
    }) as typeof agent.spawnFn;
    const engine = new Engine({
      baseUrl: OPENCODE_URL,
      model: "github-copilot/gpt-5",
      provider: "opencode",
      cwd: dir,
      bar: BAR,
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      acpSpawn: spawnFn,
      maxProofAttempts: 1,
    });
    const events = await drain(engine.run("say hi", allowAll));
    assert.equal(spawned, 0);
    assert.match(JSON.stringify(events), /not an OpenCode Zen model/);
  });
});

describe("no config or credential that enables another provider", () => {
  it("enables only the opencode provider in the config Maat hands the CLI", () => {
    const cfg = JSON.parse(OPENCODE_CONFIG) as { enabled_providers?: string[]; provider?: unknown; model?: unknown };
    assert.deepEqual(cfg.enabled_providers, ["opencode"]);
    assert.equal(cfg.provider, undefined);
    assert.equal(cfg.model, undefined);
    assert.equal(OPENCODE.env?.OPENCODE_CONFIG_CONTENT, OPENCODE_CONFIG);
  });

  it("scrubs other providers' credentials and config paths from the child's environment", () => {
    const base = {
      PATH: "/bin",
      HOME: "/h",
      ANTHROPIC_API_KEY: "a",
      CLAUDE_CODE_OAUTH_TOKEN: "c",
      GITHUB_TOKEN: "g",
      GH_TOKEN: "g",
      COPILOT_API_KEY: "c",
      GEMINI_API_KEY: "g",
      GOOGLE_APPLICATION_CREDENTIALS: "/g.json",
      OPENAI_API_KEY: "o",
      OPENROUTER_API_KEY: "o",
      XAI_API_KEY: "x",
      AWS_ACCESS_KEY_ID: "a",
      SOMEVENDOR_API_KEY: "s",
      OPENCODE_CONFIG: "/evil/opencode.json",
      OPENCODE_CONFIG_DIR: "/evil",
      OPENCODE_CONFIG_CONTENT: '{"enabled_providers":["anthropic"]}',
      OPENCODE_API_KEY: "zen",
    };
    for (const env of [opencodeChildEnv(base), opencodeEnv("/tmp/empty", base)]) {
      assert.deepEqual(
        Object.keys(env).filter((k) => k !== "PWD").sort(),
        ["HOME", "OPENCODE_API_KEY", "OPENCODE_CONFIG_CONTENT", "PATH"],
      );
      assert.equal(env.OPENCODE_CONFIG_CONTENT, OPENCODE_CONFIG);
    }
  });

  it("spawns the ACP worker with the scrubbed environment and Maat's config", async () => {
    const agent = scriptedAcpAgent([{ text: "hi" }]);
    let env: NodeJS.ProcessEnv | undefined;
    const spawnFn = ((cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      env = opts.env;
      return (agent.spawnFn as unknown as (c: string, a: string[], o: object) => unknown)(cmd, args, opts);
    }) as unknown as typeof agent.spawnFn;
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-pass";
    try {
      const r = await acpAsk({ spec: OPENCODE, model: "big-pickle", systemPrompt: "S", prompt: "P", spawnFn, timeoutMs: 5_000 });
      assert.equal(r.ok, true);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
    assert.ok(env);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.OPENCODE_CONFIG_CONTENT, OPENCODE_CONFIG);
  });
});
