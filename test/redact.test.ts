/**
 * Credentials must not reach the files molt tells you to share.
 *
 * The journal already refused to log message content for this reason, and then
 * logged `curl -H "authorization: Bearer sk-live-…"` verbatim in the `detail`
 * of a tool call. A log whose purpose is to be committed, and a receipt whose
 * purpose is to be handed to someone who does not trust you, are the two worst
 * possible places for a key to end up.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import { MASK, redact, redactData } from "../src/redact.js";
import { Receipts } from "../src/receipts.js";
import { needsPriceLookup, savePricing, storedEndpoint } from "../src/providers.js";
import { parseBar } from "../src/bar.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const KEY = "xai-abcdefghijklmnopqrstuvwxyz0123456789";

describe("redaction", () => {
  it("masks a value molt actually holds, wherever it appears", () => {
    // The precise half: no false negatives are possible for a known string.
    const text = `curl -H "authorization: Bearer ${KEY}" https://api.x.ai/v1/models`;
    const out = redact(text, [KEY]);
    assert.ok(!out.includes(KEY), out);
    assert.match(out, /authorization/, "kept nothing about what was redacted");
  });

  it("masks things that are only ever secrets", () => {
    for (const secret of [
      "sk-ant-api03-AbCdEfGhIjKlMnOpQrSt",
      "sk-proj-0123456789abcdefghij",
      "gsk_0123456789abcdefghijklmn",
      "ghp_0123456789abcdefghijklmnopqrstuv",
      "github_pat_11ABCDEFG0123456789_abcdefghij",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-1234567890-abcdefghij",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    ]) {
      const out = redact(`the value is ${secret} ok`, []);
      assert.ok(!out.includes(secret), `leaked: ${secret} → ${out}`);
    }
  });

  it("keeps the field name, so the record still says what was hidden", () => {
    // "authorization: [redacted]" is auditable. A bare mask is not.
    assert.match(redact('api_key = "hunter2hunter2"'), /api_key = "?\[redacted\]/);
    assert.match(redact("password: correcthorse"), /password: \[redacted\]/);
    assert.match(redact("x-api-key: 0123456789abcdef"), /x-api-key: \[redacted\]/);
  });

  it("masks a private key block whole", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAKC\n-----END RSA PRIVATE KEY-----";
    assert.equal(redact(`before ${pem} after`), `before ${MASK} after`);
  });

  it("leaves ordinary text alone", () => {
    // Masking a hash, a UUID, or a build id would shred an audit log to no
    // purpose — "looks random" is not the signal.
    for (const ordinary of [
      "sha256: 9f4ad2794c1b8e0d",
      "commit ef97757",
      "session 6ce0972f · ollama/qwen2.5-coder:7b",
      "npm test exited 1",
      "read_file src/app.tsx lines 1-42 of 430",
      "550e8400-e29b-41d4-a716-446655440000",
    ]) {
      assert.equal(redact(ordinary), ordinary, `over-redacted: ${ordinary}`);
    }
  });

  it("walks a whole record, at any depth", () => {
    const out = redactData(
      { name: "bash", detail: `export TOKEN=${KEY}`, nested: { list: [`k=${KEY}`], n: 5 } },
      [KEY],
    );
    assert.ok(!JSON.stringify(out).includes(KEY));
    assert.equal((out.nested as { n: number }).n, 5, "mangled a non-string value");
  });
});

describe("the log", () => {
  it("does not record a key that appeared in a command", async () => {
    const ws = workspace();
    try {
      const journal = new Journal(ws.dir);
      const provider = scriptedProvider([
        { calls: [{ name: "bash", args: { command: `curl -H "authorization: Bearer ${KEY}" https://x` } }] },
        { text: "done" },
      ]);
      const engine = new Engine({
        baseUrl: "http://mock/v1",
        model: "m",
        apiKey: KEY,
        cwd: ws.dir,
        bar: null,
        journal,
        fetchFn: provider.fetchFn,
        autonomy: "high",
      });
      await drain(engine.run(`use ${KEY} to check the models`, allowAll));

      const raw = readFileSync(journal.path, "utf8");
      assert.ok(!raw.includes(KEY), "the session key reached the log");
      // The entry is still there and still says what happened.
      assert.match(raw, /"kind":"tool_call"/);
      assert.match(raw, /redacted/);
    } finally {
      ws.cleanup();
    }
  });
});

describe("what scrolls past", () => {
  it("redacts the transcript but not the permission prompt", async () => {
    // The prompt is where you judge a command, so it shows it in full. The
    // transcript is pasted into bug reports and screenshotted into chat
    // windows, which makes the screen a distribution channel like any other —
    // this very session had a full transcript pasted into it.
    const ws = workspace();
    try {
      const command = `curl -H "authorization: Bearer ${KEY}" https://x`;
      const provider = scriptedProvider([
        { calls: [{ name: "bash", args: { command } }] },
        { text: `Called it with ${KEY}.` },
      ]);
      const engine = new Engine({
        baseUrl: "http://mock/v1",
        model: "m",
        apiKey: KEY,
        cwd: ws.dir,
        bar: null,
        fetchFn: provider.fetchFn,
        autonomy: "low",
      });

      const prompts: string[] = [];
      const events = await drain(
        engine.run("call it", async (_name, detail) => {
          prompts.push(detail);
          return true;
        }),
      );

      assert.ok(prompts[0]?.includes(KEY), "hid the command someone had to approve");

      const tool = events.find((e) => e.kind === "tool");
      assert.ok(tool?.kind === "tool");
      assert.ok(!tool.detail.includes(KEY), "the key scrolled past in the transcript");
      assert.match(tool.detail, /authorization: Bearer \[redacted\]/);

      const answer = events.find((e) => e.kind === "assistant_text");
      assert.ok(answer?.kind === "assistant_text");
      assert.ok(!answer.text.includes(KEY), "the model quoted the key back and molt printed it");
    } finally {
      ws.cleanup();
    }
  });
});

describe("receipts", () => {
  it("carry the cost, and not the key", () => {
    const ws = workspace();
    try {
      const receipts = new Receipts(ws.dir);
      receipts.protect(KEY);
      const r = receipts.write({
        claim: `Done — I called it with ${KEY}.`,
        result: {
          ok: true,
          durationMs: 12,
          results: [
            { name: "tests", kind: "command", detail: `curl -H "authorization: Bearer ${KEY}"`, ok: true, output: `key ${KEY}`, durationMs: 5 },
          ],
        },
        attempt: 1,
        verdict: "accepted",
        model: "grok-4.6",
        provider: "xai",
        sessionTokens: 1234,
        costUsd: 0.0123,
        shedBatches: 0,
      });

      const text = readFileSync(r.path, "utf8");
      assert.ok(!text.includes(KEY), "a receipt is handed to strangers; it leaked the key");
      assert.match(text, /session cost: \$0\.0123/);
      assert.ok(!readFileSync(join(ws.dir, ".molt", "receipts", "index.jsonl"), "utf8").includes(KEY));
    } finally {
      ws.cleanup();
    }
  });

  it("report cost per verified change, with the same denominator caveat", () => {
    const ws = workspace();
    try {
      const receipts = new Receipts(ws.dir);
      const bar = (ok: boolean) => ({ ok, durationMs: 1, results: [] });
      receipts.write({ claim: "a", result: bar(false), attempt: 1, verdict: "refused", model: "m", provider: "p", sessionTokens: 500, costUsd: 0.01, shedBatches: 0 });
      receipts.write({ claim: "b", result: bar(true), attempt: 2, verdict: "accepted", model: "m", provider: "p", sessionTokens: 900, costUsd: 0.03, shedBatches: 0 });

      const s = receipts.stats();
      assert.equal(s.attempts, 2);
      assert.equal(s.accepted, 1);
      // Per verified change, never per attempt: one accepted claim cost the
      // whole session, refusals included. That is the honest number.
      assert.equal(s.totalUsd, 0.03);
      assert.equal(s.usdPerVerifiedChange, 0.03);
      assert.equal(s.tokensPerVerifiedChange, 900);
    } finally {
      ws.cleanup();
    }
  });

  it("omit cost entirely when no price is known", () => {
    const ws = workspace();
    try {
      const receipts = new Receipts(ws.dir);
      const r = receipts.write({
        claim: "done",
        result: { ok: true, durationMs: 1, results: [] },
        attempt: 1,
        verdict: "accepted",
        model: "m",
        provider: "ollama",
        sessionTokens: 10,
        shedBatches: 0,
      });
      assert.ok(!readFileSync(r.path, "utf8").includes("session cost"), "invented a cost");
      assert.equal(receipts.stats().usdPerVerifiedChange, undefined);
    } finally {
      ws.cleanup();
    }
  });
});

describe("a price belongs to one model", () => {
  it("is not inherited by the next model", () => {
    // Reported from use: switching from grok-4.6 to claude-sonnet-4-6 kept
    // grok's $2/$6 because Anthropic publishes no prices — so a session was
    // shown $0.42 for something that cost about $0.69. A meter that is 40%
    // under is worse than one that is blank.
    const ws = workspace();
    try {
      savePricing("grok-4.6", { in: 2, out: 6, cached: 0.5, source: "x.ai" }, ws.dir);
      const stored = storedEndpoint(ws.dir);
      assert.equal(stored.priceModel, "grok-4.6");

      // The stamp is what makes the mismatch detectable at all.
      assert.equal(needsPriceLookup("claude-sonnet-4-6", { in: 2, source: "x.ai" }, stored), true);
      assert.equal(needsPriceLookup("grok-4.6", { in: 2, source: "x.ai" }, stored), false);
    } finally {
      ws.cleanup();
    }
  });

  it("computes a session at one rate, not a blend", () => {
    // The arithmetic behind the report: 206k tokens is $0.44 at grok's rates
    // and $0.69 at Claude Sonnet's. Same tokens, different model, and the
    // wrong one was on screen.
    const tokens = 206_295;
    const at = (i: number, o: number) => ((tokens * 0.97) / 1e6) * i + ((tokens * 0.03) / 1e6) * o;
    assert.ok(Math.abs(at(2, 6) - 0.44) < 0.02);
    assert.ok(Math.abs(at(3, 15) - 0.69) < 0.02);
  });
});

describe("advisory checks", () => {
  const barWith = (advisory: boolean) =>
    parseBar(`
version: 1
checks:
  - name: blocking
    run: "true"
  - name: opinion
    run: "false"
    advisory: ${advisory}
`);

  it("report without refusing", () => {
    const ws = workspace();
    try {
      const bar = barWith(true);
      assert.equal(bar.checks[1]!.advisory, true);
      const engine = new Engine({
        baseUrl: "http://mock/v1",
        model: "m",
        cwd: ws.dir,
        bar,
        fetchFn: scriptedProvider([{ text: "done" }]).fetchFn,
      });
      const result = engine.proveNow()!;
      assert.equal(result.ok, true, "an advisory failure refused a completion");
      assert.equal(result.warnings?.length, 1);
      assert.equal(result.warnings?.[0]!.name, "opinion");
      // It still ran, and its result is still on the record.
      assert.equal(result.results.length, 2);
      assert.equal(result.results[1]!.ok, false);
    } finally {
      ws.cleanup();
    }
  });

  it("refuse when the same check is not advisory", () => {
    const ws = workspace();
    try {
      const engine = new Engine({
        baseUrl: "http://mock/v1",
        model: "m",
        cwd: ws.dir,
        bar: barWith(false),
        fetchFn: scriptedProvider([{ text: "done" }]).fetchFn,
      });
      const result = engine.proveNow()!;
      assert.equal(result.ok, false);
      assert.equal(result.warnings, undefined);
    } finally {
      ws.cleanup();
    }
  });

  it("refuse a bar that says advisory is something other than true or false", () => {
    assert.throws(
      () => parseBar('version: 1\nchecks:\n  - name: a\n    run: "true"\n    advisory: maybe\n'),
      /non-boolean/,
    );
  });
});
