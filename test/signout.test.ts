/**
 * Requirement sign-out (src/signout.ts): before an unattended claim is
 * judged, each stated requirement is put to the model with the commands it
 * ran that touch it. Local runs claimed "verified" on an access-log summary
 * that said 4xx: 41 where the log held 40; nothing had rerun that line.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applyCritique, draftCriteriaCritiqued, taskChecksFrom } from "../src/criteria.js";
import { Engine } from "../src/engine.js";
import { signOut, signOutMessage } from "../src/signout.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const TASK = "Write summary.txt from access.log. It must report the 4xx count and redact every email address.";
const REQS = ["report the 4xx count", "redact every email address"];

const userMessages = (p: ReturnType<typeof scriptedProvider>) =>
  p
    .requests()
    .flatMap((r) => (r as { messages: { role: string; content?: string }[] }).messages)
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => m.content as string);
const signoutMessages = (p: ReturnType<typeof scriptedProvider>) => [
  ...new Set(userMessages(p).filter((m) => /sign out each requirement/.test(m))),
];

// Sign-out is opt-in (`--signout`); the tests below that exercise the round turn it on.
const engineFor = (dir: string, p: ReturnType<typeof scriptedProvider>, unattended = true, signOut = true) =>
  new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: dir, fetchFn: p.fetchFn, bar: null, stream: false, autonomy: "high", unattended, signOut });

describe("requirements flow from sealing", () => {
  it("the critic's quotes are grounded in the task, deduplicated, capped, and ride on the draft", () => {
    const c = applyCritique(
      { checks: [{ name: "a", run: "true" }], notes: [] },
      JSON.stringify({
        checks: [{ name: "a", verdict: "runs", quote: "" }],
        uncovered: ["report the 4xx count"],
        requirements: [...REQS, "Report The 4xx Count", "never stated in the task"],
      }),
      TASK,
    )!;
    assert.deepEqual(c.requirements, ["report the 4xx count", "redact every email address"]);
    const many = Array.from({ length: 14 }, (_, i) => `requirement number ${i} here`);
    const big = applyCritique({ checks: [], notes: [] }, JSON.stringify({ checks: [], requirements: many }), many.join(". "))!;
    assert.equal(big.requirements.length, 10);
  });

  it("draftCriteriaCritiqued returns them with the draft, and taskChecksFrom keeps them", async () => {
    const replies = [
      JSON.stringify({ checks: [{ name: "runs", run: "./t < access.log | grep -q 40" }], notes: [] }),
      JSON.stringify({ checks: [{ name: "runs", verdict: "runs", quote: "" }], uncovered: [], requirements: REQS }),
    ];
    let i = 0;
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { role: "assistant", content: replies[i++] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const out = await draftCriteriaCritiqued({ task: TASK, scripts: [], barChecks: [], baseUrl: "http://p.test/v1", model: "m", fetchFn });
    assert.ok(out.ok);
    assert.deepEqual(out.draft.requirements, REQS);
    assert.deepEqual(taskChecksFrom(out.draft, { hidden: true }).requirements, REQS);
  });

  it("pendingCriteria's requirements reach the engine and are put to the model", async () => {
    const ws = workspace();
    try {
      const p = scriptedProvider([{ text: "Done." }, { text: "Done again." }]);
      const pendingCriteria = Promise.resolve({ taskChecks: [], taskNotes: [], requirements: REQS });
      await drain(engineFor(ws.dir, p).run(TASK, allowAll, { pendingCriteria }));
      const m = signoutMessages(p);
      assert.equal(m.length, 1);
      for (const r of REQS) assert.ok(m[0]!.includes(r));
    } finally {
      ws.cleanup();
    }
  });
});

describe("signOut pairing", () => {
  it("marks a requirement exercised by a command that names its words or path, and the rest not yet run", () => {
    const did = ["write_file summary.txt", "bash python3 summarize.py access.log | grep 4xx", "read_file access.log", "refused: bash rm -rf x"];
    const s = signOut(REQS, did);
    assert.deepEqual(s.matched.map((m) => m.requirement), ["report the 4xx count"]);
    assert.deepEqual(s.unexercised, ["redact every email address"]);
    const msg = signOutMessage(s);
    assert.match(msg, /1\. "report the 4xx count" - you ran: `python3 summarize\.py/);
    assert.match(msg, /2\. "redact every email address" - not yet run/);
  });
});

describe("the sign-out round", () => {
  it("lists requirements with the turn's own calls, once, then judging proceeds", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "access.log"), "1\n");
      const p = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "summary.txt", content: "4xx: 41\n" } }, { name: "bash", args: { command: "grep -c 4xx summary.txt" } }] },
        { text: "Done: verified." },
        { calls: [{ name: "bash", args: { command: "grep -c '^4' access.log" } }] },
        { text: "Rechecked; still done." },
      ]);
      const events = await drain(engineFor(ws.dir, p).run(TASK, allowAll, { requirements: REQS }));
      const m = signoutMessages(p);
      assert.equal(m.length, 1, "exactly one round");
      assert.match(m[0]!, /"report the 4xx count" - you ran: `grep -c 4xx summary\.txt`/);
      assert.match(m[0]!, /"redact every email address" - not yet run/);
      assert.equal(events.filter((e) => e.kind === "info" && /signing out/.test(e.text)).length, 1);
      assert.equal(p.calls, 4, "the second claim is judged, not asked again");
    } finally {
      ws.cleanup();
    }
  });

  it("never puts a hidden check command into the message", async () => {
    const ws = workspace();
    try {
      const p = scriptedProvider([{ text: "Done." }, { text: "Done." }]);
      const taskChecks = [
        { name: "oracle", kind: "command" as const, run: "python3 secret_oracle.py --expect 40", timeoutMs: 5000, expectExit: 0, tags: ["task"], hidden: true },
      ];
      await drain(engineFor(ws.dir, p).run(TASK, allowAll, { requirements: REQS, taskChecks }));
      const m = signoutMessages(p);
      assert.equal(m.length, 1);
      assert.ok(!m[0]!.includes("secret_oracle") && !m[0]!.includes("--expect"));
    } finally {
      ws.cleanup();
    }
  });

  // 60 rounds rescued no task and doubled steps; the round is opt-in now.
  it("is off by default: no round, the first claim is judged", async () => {
    const ws = workspace();
    try {
      const p = scriptedProvider([{ text: "Done." }]);
      const events = await drain(engineFor(ws.dir, p, true, false).run(TASK, allowAll, { requirements: REQS }));
      assert.equal(signoutMessages(p).length, 0);
      assert.ok(!events.some((e) => e.kind === "info" && /signing out/.test(e.text)));
      assert.equal(p.calls, 1);
    } finally {
      ws.cleanup();
    }
  });

  it("is on with the flag (EngineConfig.signOut, --signout)", async () => {
    const ws = workspace();
    try {
      const p = scriptedProvider([{ text: "Done." }, { text: "Done again." }]);
      await drain(engineFor(ws.dir, p, true, true).run(TASK, allowAll, { requirements: REQS }));
      assert.equal(signoutMessages(p).length, 1);
      assert.equal(p.calls, 2);
    } finally {
      ws.cleanup();
    }
  });

  it("is not sent in an attended session", async () => {
    const ws = workspace();
    try {
      const p = scriptedProvider([{ text: "Done." }]);
      await drain(engineFor(ws.dir, p, false).run(TASK, allowAll, { requirements: REQS }));
      assert.equal(signoutMessages(p).length, 0);
    } finally {
      ws.cleanup();
    }
  });

  it("a turn with no requirement list is unchanged", async () => {
    const ws = workspace();
    try {
      const p = scriptedProvider([{ text: "Done." }]);
      await drain(engineFor(ws.dir, p).run(TASK, allowAll, {}));
      assert.equal(signoutMessages(p).length, 0);
      assert.equal(p.calls, 1);
    } finally {
      ws.cleanup();
    }
  });
});
