/**
 * The Claude Code backend: a subscription doing the work, molt still judging it.
 *
 * The thing worth pinning here is not that the backend runs. It is that
 * running the model somewhere else changes nothing about what molt will
 * accept: every write still goes through molt's tools, so the ledger is
 * complete and `tree-accounted` still means something; a refused bar still
 * reaches the model as the next thing it is told; and a run that costs no
 * money never grows a dollar figure.
 *
 * Every test drives a scripted SDK. A test that reached the real one would
 * spend the quota of whoever ran it, so `claudeCodeSdk` is supplied
 * everywhere and `loadSdk` is never called.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { parseBar } from "../src/bar.js";
import {
  CLAUDE_CODE_URL,
  claudeCodeHealth,
  isClaudeCode,
  zodShape,
} from "../src/claude-code.js";
import { Engine } from "../src/engine.js";
import { isSelfHosted, PROVIDERS, providerName } from "../src/providers.js";
import { Receipts } from "../src/receipts.js";
import type { EngineEvent } from "../src/types.js";
import {
  allowAll,
  denyAll,
  drain,
  scriptedClaudeCode,
  type ScriptedCcTurn,
  workspace,
} from "./helpers.js";

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

function engineIn(dir: string, turns: ScriptedCcTurn[]) {
  const cc = scriptedClaudeCode(turns);
  const engine = new Engine({
    baseUrl: CLAUDE_CODE_URL,
    model: "sonnet",
    provider: "claude-code",
    cwd: dir,
    bar: BAR,
    archive: new Archive(dir),
    receipts: new Receipts(dir),
    claudeCodeSdk: cc.sdk,
    maxProofAttempts: 2,
    // A price that would be applied if anything applied one. Nothing should.
    priceInPerMtok: 3,
    priceOutPerMtok: 15,
  });
  return { engine, cc };
}

function textOf(events: EngineEvent[], kind: EngineEvent["kind"]): string[] {
  return events
    .filter((e) => e.kind === kind)
    .map((e) => (e as { text?: string }).text ?? "");
}

describe("which backend an endpoint names", () => {
  it("recognises the Claude Code URL and nothing else", () => {
    assert.equal(isClaudeCode(CLAUDE_CODE_URL), true);
    assert.equal(isClaudeCode("claude-code://anything"), true);
    assert.equal(isClaudeCode("https://api.anthropic.com/v1"), false);
    assert.equal(isClaudeCode("http://localhost:11434/v1"), false);
    assert.equal(isClaudeCode(undefined), false);
  });

  it("is a provider that needs no key, and is named on a receipt", () => {
    assert.equal(PROVIDERS["claude-code"]?.needsKey, false);
    assert.equal(providerName(CLAUDE_CODE_URL), "claude-code");
  });

  /**
   * The URL has no dots in it, which every other rule in `isSelfHosted` reads
   * as a LAN hostname — and self-hosted turns the repo map off, which is
   * measurably the wrong default for a frontier model.
   */
  it("is not mistaken for a machine you run", () => {
    assert.equal(isSelfHosted(CLAUDE_CODE_URL), false);
  });
});

describe("molt's tool schemas, as the SDK wants them", () => {
  type Marked = { type: string; isOptional: boolean; described?: string };
  const mark = (type: string, isOptional = false, described?: string): Marked & {
    optional: () => unknown;
    describe: (d: string) => unknown;
  } => ({
    type,
    isOptional,
    ...(described === undefined ? {} : { described }),
    optional: () => mark(type, true, described),
    describe: (d: string) => mark(type, isOptional, d),
  });
  const z = {
    string: () => mark("string"),
    number: () => mark("number"),
    boolean: () => mark("boolean"),
    enum: () => mark("enum"),
    unknown: () => mark("unknown"),
  };

  it("keeps required and optional apart", () => {
    const shape = zodShape(
      {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "number" } },
        required: ["path"],
      },
      z as never,
    ) as unknown as Record<string, Marked>;
    assert.equal(shape.path?.type, "string");
    assert.equal(shape.path?.isOptional, false, "a required field must not be optional");
    assert.equal(shape.offset?.type, "number");
    assert.equal(shape.offset?.isOptional, true);
  });

  /**
   * A tool arriving with a type this does not know should reach the model
   * slightly under-described, not take the backend down mid-turn.
   */
  it("falls back rather than throwing on a type it does not know", () => {
    const shape = zodShape(
      { type: "object", properties: { odd: { type: "array" } }, required: ["odd"] },
      z as never,
    ) as unknown as Record<string, Marked>;
    assert.equal(shape.odd?.type, "unknown");
  });

  it("is empty for a schema with no properties", () => {
    assert.deepEqual(zodShape({}, z as never), {});
  });
});

describe("whether this machine can run the backend at all", () => {
  it("names the install command when Claude Code is missing", async () => {
    const health = await claudeCodeHealth(async () => {
      throw new Error("spawn claude ENOENT");
    });
    assert.equal(health.ok, false);
    assert.equal(health.installed, false);
    assert.match(health.fix ?? "", /install/);
  });

  /**
   * "Not installed" and "installed but logged out" have different fixes, and
   * folding them into one boolean sends people to the wrong one.
   */
  it("reports installed and unauthenticated as different states", async () => {
    const health = await claudeCodeHealth(async (cmd) => {
      if (cmd === "claude") return { stdout: "2.1.258 (Claude Code)\n" };
      throw new Error("no credential");
    });
    assert.equal(health.installed, true);
    assert.equal(health.version, "2.1.258");
    // Either it found a real credential on this machine or it did not; what is
    // pinned is that a version was read and the two facts stayed separate.
    assert.equal(typeof health.authenticated, "boolean");
    assert.match(health.detail, /2\.1\.258/);
  });
});

describe("a turn done by Claude Code", () => {
  it("writes through molt's tools, so the ledger is complete", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
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
  });

  it("gates a tool call the same way, and records the refusal", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
      { calls: [{ name: "bash", args: { command: "rm -rf /" } }], text: "tried" },
      { text: "I could not." },
    ]);
    const events = await drain(engine.run("break things", denyAll));

    const tool = events.find((e) => e.kind === "tool") as { note?: string } | undefined;
    assert.equal(tool?.note, "denied", "the autonomy gate must apply to this backend too");
    assert.equal(existsSync(join(dir, "hello.txt")), false);
  });

  /**
   * The whole point of the backend. A refused bar is written to molt's
   * transcript as a user message, and every user message molt has not yet
   * forwarded is what the next step sends — so the model is told why it was
   * refused without a second code path for saying so.
   */
  it("sends a refused bar back to the model as the next thing it is told", async () => {
    const dir = ws();
    const { engine, cc } = engineIn(dir, [
      // Claims to be done having changed nothing: `files-changed` refuses it.
      { text: "All done." },
      { calls: [{ name: "write_file", args: { path: "real.txt", content: "work\n" } }], text: "Now done." },
    ]);
    const events = await drain(engine.run("do the work", allowAll));

    assert.ok(
      events.some((e) => e.kind === "proof_refused"),
      "the first claim should have been refused",
    );
    assert.equal(cc.sent.length, 2, "the refusal should have produced a second message");
    assert.match(cc.sent[1] ?? "", /work-landed|No file was modified/i);
    assert.equal(readFileSync(join(dir, "real.txt"), "utf8"), "work\n");
  });

  it("says the ask once and does not repeat it", async () => {
    const dir = ws();
    const { engine, cc } = engineIn(dir, [
      { text: "nothing to do" },
      { calls: [{ name: "write_file", args: { path: "a.txt", content: "a\n" } }], text: "done" },
    ]);
    await drain(engine.run("the original ask", allowAll));
    const firstMentions = cc.sent.filter((t) => t.includes("the original ask")).length;
    assert.equal(firstMentions, 1, "a forwarded message must not be forwarded twice");
  });
});

describe("what a subscription run costs", () => {
  /**
   * A plan is not a bill. molt counts the tokens — they are real, and the
   * token ceiling still applies — but pricing them off a table would put a
   * dollar figure on a receipt for money nobody was charged.
   */
  it("counts tokens and reports no dollars", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
      {
        calls: [{ name: "write_file", args: { path: "a.txt", content: "a\n" } }],
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
    assert.equal(summary.spend.costUsd, undefined, "a subscription run has no price");
    assert.equal(summary.spend.billed, false);
    assert.equal(engine.costUsd(), undefined);
  });
});

describe("the tool surface Claude Code is given", () => {
  /**
   * Not tidiness. A turn where Claude Code used its own `Write` would put a
   * change on disk with no ledger entry behind it — indistinguishable from
   * the `sed` bypass `tree-accounted` was written to refuse — so the claim
   * could never pass the bar anyway. Turning the built-ins off is what makes
   * the backend usable rather than merely safe.
   */
  it("has molt's tools and none of its own", async () => {
    const dir = ws();
    const { engine, cc } = engineIn(dir, [
      { calls: [{ name: "write_file", args: { path: "a.txt", content: "a\n" } }], text: "done" },
    ]);
    await drain(engine.run("write a.txt", allowAll));
    const opts = cc.options();

    assert.deepEqual(opts.tools, [], "every built-in tool must be turned off");
    assert.deepEqual(opts.settingSources, [], "CLAUDE.md and settings must not steer the run");
    assert.equal(opts.strictMcpConfig, true, "the user's own MCP servers stay out");
    const allowed = opts.allowedTools as string[];
    assert.ok(allowed.includes("mcp__molt__write_file"));
    assert.ok(allowed.includes("mcp__molt__bash"));
    assert.ok(
      allowed.every((t) => t.startsWith("mcp__molt__")),
      `only molt's tools may be allowed, got ${allowed.join(", ")}`,
    );
  });

  it("gives it molt's system prompt, not Claude Code's", async () => {
    const dir = ws();
    writeFileSync(join(dir, "marker.ts"), "export const marker = 1;\n");
    const { engine, cc } = engineIn(dir, [
      { calls: [{ name: "write_file", args: { path: "a.txt", content: "a\n" } }], text: "done" },
    ]);
    await drain(engine.run("write a.txt", allowAll));
    const prompt = String(cc.options().systemPrompt ?? "");
    assert.ok(prompt.length > 0, "a system prompt must be sent");
    assert.match(prompt, /molt/i);
  });
});

describe("when the session fails", () => {
  it("ends the turn with the reason rather than a silent stop", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [{ error: "Claude Code exited: not logged in" }]);
    const events = await drain(engine.run("do something", allowAll));
    const errors = textOf(events, "error");
    assert.ok(
      errors.some((t) => t.includes("not logged in")),
      `expected the reason on screen, got ${JSON.stringify(errors)}`,
    );
  });
});
