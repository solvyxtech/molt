/**
 * The Antigravity backend: a Google AI plan doing the work, molt still judging.
 *
 * The load-bearing test here is not that a turn runs. It is `writeAgyConfig`:
 * Antigravity's headless mode denies by default, and the allow-list molt
 * writes is the complete set of things the agent is permitted to do. If that
 * list ever widens by accident — a wildcard, a stale merge, a tool added
 * without a rule — the ledger stops being complete and every downstream
 * guarantee goes with it. So it is asserted exactly, not loosely.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  AGY_URL,
  agyAllowRules,
  agyEnv,
  agyHealth,
  agySetupState,
  ensureAgyRules,
  isAgy,
} from "../src/agy.js";
import { Archive } from "../src/archive.js";
import { parseBar } from "../src/bar.js";
import { CLAUDE_CODE_URL } from "../src/claude-code.js";
import { draftCriteria } from "../src/criteria.js";
import { Engine } from "../src/engine.js";
import { isSelfHosted, PROVIDERS, providerName } from "../src/providers.js";
import { Receipts } from "../src/receipts.js";
import { scriptedAgy, type ScriptedAgyTurn } from "./agy-cli.js";
import { allowAll, denyAll, drain, workspace } from "./helpers.js";

const BAR = parseBar(`
version: 1
checks:
  - name: work-landed
    builtin: files-changed
  - name: work-accounted
    builtin: tree-accounted
`);

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

function ws(): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

function engineIn(dir: string, turns: ScriptedAgyTurn[]) {
  const agy = scriptedAgy(turns);
  const engine = new Engine({
    baseUrl: AGY_URL,
    model: "gemini-3.1-pro-low",
    provider: "antigravity",
    cwd: dir,
    bar: BAR,
    archive: new Archive(dir),
    receipts: new Receipts(dir),
    acpSpawn: agy.spawnFn,
    agySetup: agy.setup,
    maxProofAttempts: 2,
    // A price that would be applied if anything applied one. Nothing should.
    priceInPerMtok: 3,
    priceOutPerMtok: 15,
  });
  return { engine, agy };
}

describe("which backend an endpoint names", () => {
  it("recognises the Antigravity URL and nothing else", () => {
    assert.equal(isAgy(AGY_URL), true);
    assert.equal(isAgy("antigravity://anything"), true);
    assert.equal(isAgy(CLAUDE_CODE_URL), false);
    assert.equal(isAgy("grok-build://subscription"), false);
    assert.equal(isAgy(undefined), false);
  });

  it("is a provider that needs no key, and is named on a receipt", () => {
    assert.equal(PROVIDERS.antigravity?.needsKey, false);
    assert.equal(providerName(AGY_URL), "antigravity");
  });

  it("is not mistaken for a machine you run", () => {
    assert.equal(isSelfHosted(AGY_URL), false);
  });
});

/**
 * The security boundary, asserted exactly.
 *
 * Antigravity refuses anything it has no rule for, so this list is not a
 * convenience — it is the whole definition of what the agent may do.
 */
describe("the permission rules molt writes", () => {
  const tools = ["read_file", "write_file", "grep"].map((name) => ({
    type: "function" as const,
    function: { name, description: name, parameters: { type: "object" } },
  }));

  function settingsIn(dir: string): string {
    return join(dir, "settings.json");
  }

  it("allows exactly molt's tools, one rule each, and no wildcard", () => {
    const rules = agyAllowRules(tools);
    assert.deepEqual(rules, [
      "mcp(molt/read_file)",
      "mcp(molt/write_file)",
      "mcp(molt/grep)",
    ]);
    // A wildcard would widen silently the moment molt gained a tool. The rule
    // string is the one the CLI itself prints when it refuses a call.
    assert.ok(!rules.some((r) => r.includes("*")), JSON.stringify(rules));
  });

  /**
   * The whole justification for editing a file molt does not own: it adds its
   * own rules and leaves everything else exactly as it found it.
   */
  it("adds only its own rules and preserves the rest of your settings", () => {
    const path = settingsIn(ws());
    writeFileSync(
      path,
      JSON.stringify({
        colorScheme: "solarized dark",
        model: "Gemini 3.6 Flash (High)",
        trustedWorkspaces: ["/Users/someone"],
        permissions: { allow: ["mcp(other/thing)"], deny: ["unsandboxed"] },
      }),
      "utf8",
    );
    const added = ensureAgyRules(tools, path);
    assert.deepEqual(added, agyAllowRules(tools));

    const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & {
      permissions: { allow: string[]; deny: string[] };
    };
    assert.equal(after.colorScheme, "solarized dark", "your settings must survive");
    assert.equal(after.model, "Gemini 3.6 Flash (High)");
    assert.deepEqual(after.trustedWorkspaces, ["/Users/someone"]);
    assert.deepEqual(after.permissions.deny, ["unsandboxed"], "molt writes no deny of its own");
    assert.ok(
      after.permissions.allow.includes("mcp(other/thing)"),
      "a rule molt did not write must not be removed",
    );
    for (const r of agyAllowRules(tools)) assert.ok(after.permissions.allow.includes(r));
  });

  it("is idempotent — a second run adds nothing", () => {
    const path = settingsIn(ws());
    assert.equal(ensureAgyRules(tools, path).length, 3);
    assert.deepEqual(ensureAgyRules(tools, path), [], "already-present rules are not rewritten");
    const after = JSON.parse(readFileSync(path, "utf8")) as {
      permissions: { allow: string[] };
    };
    assert.equal(new Set(after.permissions.allow).size, after.permissions.allow.length, "no duplicates");
    assert.deepEqual(agySetupState(tools, path).missingRules, []);
  });

  /**
   * The trick that removes the second sign-in: the port and token travel in
   * the environment, so the registered command line never changes and no
   * per-session config rewrite is needed. An MCP child spawned by `agy`
   * inherits the environment `agy` was started with — measured, not assumed.
   */
  it("carries the session's endpoint in the environment, not in the config", () => {
    const env = agyEnv({
      url: "http://127.0.0.1:5555/mcp",
      headers: [{ name: "Authorization", value: "Bearer secret" }],
    });
    assert.equal(env.MOLT_MCP_URL, "http://127.0.0.1:5555/mcp");
    assert.equal(env.MOLT_MCP_TOKEN, "secret", "the Bearer prefix is not part of the token");
    // And no HOME override: this runs against the login you already have.
    assert.equal(env.HOME, process.env.HOME);
  });
});

describe("a turn done by Antigravity", () => {
  it("writes through molt's tools, so the ledger is complete", async () => {
    const dir = ws();
    const { engine, agy } = engineIn(dir, [
      {
        calls: [{ name: "write_file", args: { path: "hello.txt", content: "hi\n" } }],
        text: "Wrote hello.txt.",
      },
    ]);
    const events = await drain(engine.run("create hello.txt", allowAll));

    assert.equal(readFileSync(join(dir, "hello.txt"), "utf8"), "hi\n");
    const tool = events.find((e) => e.kind === "tool") as { name: string } | undefined;
    assert.equal(tool?.name, "write_file");

    const result = events.find((e) => e.kind === "proof_result") as
      | { result: { ok: boolean; results: { name: string; ok: boolean }[] } }
      | undefined;
    assert.ok(result, "the bar should have run");
    assert.equal(result.result.ok, true, JSON.stringify(result.result.results));

    // The flags that make the stream work at all. `--print=` with an empty
    // value is not a typo: a bare `--print` eats the next flag as its prompt.
    const argv = agy.argv();
    assert.ok(argv.includes("--print="), `argv: ${argv.join(" ")}`);
    assert.ok(argv.includes("stream-json"));
  });

  /**
   * The one backend of the three that reports its own usage. Estimating here
   * would throw away a real measurement.
   */
  it("reports the real token counts, not an estimate", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
      {
        calls: [{ name: "write_file", args: { path: "a.txt", content: "x\n" } }],
        text: "done",
        usage: { input: 4000, output: 200, cached: 3000 },
      },
    ]);
    const events = await drain(engine.run("write a.txt", allowAll));
    const summary = events.find((e) => e.kind === "step_summary") as
      | { spend: { promptTokens: number; cachedTokens: number; costUsd?: number; billed: boolean } }
      | undefined;
    assert.ok(summary, "expected a step summary");
    assert.equal(summary.spend.promptTokens, 7000, "fresh + cached input is the whole prompt");
    assert.equal(summary.spend.cachedTokens, 3000);
    assert.equal(summary.spend.costUsd, undefined, "a plan is not a bill");
    assert.equal(summary.spend.billed, false);
  });

  /**
   * A refused builtin is the permission system working — nothing happened, so
   * nothing is missing from the ledger. Reporting it as unaccounted would cry
   * wolf on every turn.
   */
  it("tells a refused builtin apart from one that ran", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
      {
        refusedBuiltins: ["write_to_file"],
        ranBuiltins: ["view_file"],
        calls: [{ name: "write_file", args: { path: "ok.txt", content: "x\n" } }],
        text: "Done.",
      },
    ]);
    const events = await drain(engine.run("do the work", allowAll));
    const notes = events
      .filter((e) => e.kind === "info")
      .map((e) => (e as { text?: string }).text ?? "");
    assert.ok(
      notes.some((t) => /ran its own 'view_file'/u.test(t)),
      `an auto-approved builtin should be named: ${JSON.stringify(notes)}`,
    );
    assert.ok(
      !notes.some((t) => /ran its own 'write_to_file'/u.test(t)),
      `a refused builtin never ran: ${JSON.stringify(notes)}`,
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
});

/**
 * `antigravity://subscription` is a name, not a URL, and `fetch` refuses the
 * scheme with six words that read as a network fault. Same invariant as the
 * other two subprocess backends.
 */
describe("nothing on the Antigravity endpoint reaches for HTTP", () => {
  const noFetch = (where: string): typeof fetch =>
    ((input: unknown) => {
      assert.fail(`${where} sent an HTTP request to ${String(input)}`);
    }) as unknown as typeof fetch;

  it("runs a whole turn without a request", async () => {
    const dir = ws();
    const agy = scriptedAgy([
      { calls: [{ name: "write_file", args: { path: "a.txt", content: "x\n" } }], text: "done" },
    ]);
    const engine = new Engine({
      baseUrl: AGY_URL,
      model: "gemini-3.1-pro-low",
      provider: "antigravity",
      cwd: dir,
      bar: BAR,
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      acpSpawn: agy.spawnFn,
      agySetup: agy.setup,
      fetchFn: noFetch("the turn"),
    });
    const events = await drain(engine.run("write a.txt", allowAll));
    assert.ok(events.some((e) => e.kind === "proof_result"), "the turn should have completed");
  });

  /**
   * Refused in words rather than by a failed fetch. `agy` brings its 57 tools
   * whatever you ask of it, so there is no tool-free one-shot to draft with.
   */
  it("says why it cannot draft criteria, instead of failing as a network error", async () => {
    const r = await draftCriteria({
      task: "audit this repo",
      scripts: ["test"],
      barChecks: ["types"],
      baseUrl: AGY_URL,
      model: "gemini-3.1-pro-low",
      fetchFn: noFetch("draftCriteria"),
    });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /Antigravity/u);
  });
});

describe("health", () => {
  it("keeps 'not installed', 'not signed in' and 'ready' apart", async () => {
    const missing = await agyHealth({
      run: async () => {
        throw new Error("ENOENT");
      },
    });
    assert.equal(missing.installed, false);
    assert.equal(missing.ok, false);

    const out = await agyHealth({
      run: async (_c, args) => {
        if (args[0] === "--version") return { stdout: "1.1.25\n" };
        return { stdout: "Fetching available models...\nError: Please sign in to view available models.\n" };
      },
    });
    assert.equal(out.installed, true);
    assert.equal(out.version, "1.1.25");
    assert.equal(out.authenticated, false);
    // The login you already have — not a second one molt invents.
    assert.equal(out.fix, "agy");

    const ok = await agyHealth({
      run: async (_c, args) =>
        args[0] === "--version"
          ? { stdout: "1.1.25\n" }
          : { stdout: "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n" },
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.fix, undefined);
  });
});
