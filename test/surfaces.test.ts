/**
 * Capability with no surface is not a feature. The archive grep, the regrow
 * path, and the receipt index all existed before anything could reach them —
 * these tests exist so that cannot silently happen again.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { loadBar, parseBar, selectChecks } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}
function writeBar(dir: string, yaml: string): void {
  mkdirSync(join(dir, ".molt"), { recursive: true });
  writeFileSync(join(dir, ".molt", "done.yml"), yaml, "utf8");
}

describe("doctor", () => {
  const endpoint = (ids: string[]) =>
    (async (url: string) => {
      if (String(url).endsWith("/models")) {
        return { ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) } as unknown as Response;
      }
      return { ok: false, status: 404, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

  const engineWith = (dir: string, model: string, ids: string[]) =>
    new Engine({ baseUrl: "http://mock/v1", model, cwd: dir, bar: null, fetchFn: endpoint(ids) });

  it("fails when the configured model is not there", async () => {
    // A preflight that passes on a model the endpoint does not have only fails
    // once the work has already started, which is the one thing it exists to
    // prevent.
    const d = await engineWith(ws(), "does-not-exist", ["grok-4.6", "grok-4.5"]).doctor();
    assert.equal(d.ok, false);
    assert.equal(d.modelPresent, false);
    assert.match(d.detail, /NOT in list/);
  });

  it("passes when it is", async () => {
    const d = await engineWith(ws(), "grok-4.6", ["grok-4.6"]).doctor();
    assert.equal(d.ok, true);
    assert.equal(d.modelPresent, true);
  });

  it("does not guess when the endpoint publishes no list", async () => {
    // Endpoints that hide /models exist. Refusing them would be a guess
    // dressed up as a check.
    const d = await engineWith(ws(), "anything", []).doctor();
    assert.equal(d.ok, true);
    assert.match(d.detail, /model list unavailable/);
  });
});

describe("tag selection", () => {
  const bar = parseBar(`
version: 1
checks:
  - name: quick
    run: exit 0
    tags: [fast, local]
  - name: suite
    run: exit 0
    tags: [slow, ci]
  - name: always
    builtin: files-changed
`);

  it("parses tags", () => {
    assert.deepEqual(bar.checks[0].tags, ["fast", "local"]);
    assert.deepEqual(bar.checks[2].tags, []);
  });

  it("rejects tags that are not a list of strings", () => {
    assert.throws(
      () => parseBar("version: 1\nchecks:\n  - name: a\n    run: true\n    tags: nope\n"),
      /not a list of strings/,
    );
  });

  it("skips by tag", () => {
    const narrowed = selectChecks(bar, { skip: ["slow"] });
    assert.deepEqual(narrowed.checks.map((c) => c.name), ["quick", "always"]);
  });

  it("selects by tag but never drops an untagged check", () => {
    // Omitting a tag must not quietly remove a condition from the bar.
    const narrowed = selectChecks(bar, { only: ["fast"] });
    assert.deepEqual(narrowed.checks.map((c) => c.name), ["quick", "always"]);
  });

  it("is a no-op with no selection", () => {
    assert.equal(selectChecks(bar).checks.length, 3);
  });

  it("carries tags through to results so output can show them", () => {
    const c = bar.checks[0];
    assert.ok(c.kind === "command" && c.tags.includes("fast"));
  });
});

describe("regrow", () => {
  it("pulls archived context back in by pattern", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: l\n    builtin: files-changed\n");
    const provider = scriptedProvider([{ text: "ok" }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: null,
      archive: new Archive(dir),
    });

    await drain(engine.run(`the auth token refreshes every 900 seconds ${"x".repeat(1500)}`, allowAll));
    for (let i = 0; i < 5; i++) {
      await drain(engine.run(`unrelated ${i} ${"y".repeat(1500)}`, allowAll));
    }
    const shed = engine.shed();
    assert.ok(shed, "expected a shed");

    const before = JSON.stringify(engine.getRecord()).includes("900 seconds");
    const r = engine.regrowMatching("900 seconds");
    assert.ok(r.hits > 0, "the archive can be searched");
    assert.ok(r.attached > 0, "and the match is re-attached");
    assert.ok(r.tokens > 0, "with its token cost reported before it lands");

    const wireText = JSON.stringify(engine.getRecord());
    assert.match(wireText, /900 seconds/);
    assert.ok(before, "and it was in the record all along");
  });

  it("reports a miss instead of attaching nothing quietly", () => {
    const dir = ws();
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      bar: null,
      archive: new Archive(dir),
    });
    const r = engine.regrowMatching("nothing-like-this-exists");
    assert.deepEqual(r, { hits: 0, attached: 0, tokens: 0 });
  });
});

describe("shed --explain", () => {
  it("returns the digest and the original together, mutating nothing", async () => {
    const dir = ws();
    const provider = scriptedProvider([{ text: "ok" }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: null,
      archive: new Archive(dir),
    });
    for (let i = 0; i < 6; i++) {
      await drain(engine.run(`MARKER-${i} request ${"z".repeat(1500)}`, allowAll));
    }

    const before = JSON.stringify(engine.getRecord());
    const plan = engine.explainShed();
    assert.ok(plan);
    assert.equal(JSON.stringify(engine.getRecord()), before, "explaining must not mutate");

    assert.ok(plan.afterTokens < plan.beforeTokens);
    // The exuvia holds what the digest only excerpts.
    assert.ok(plan.exuvia.length > plan.digest.length, "the original is fuller than the digest");
    assert.match(plan.exuvia, /MARKER-0/);
  });
});

describe("receipt index and stats", () => {
  it("records one machine-readable row per attempt", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    const provider = scriptedProvider([
      { text: "Done." },
      { calls: [{ name: "write_file", args: { path: "r.txt", content: "real\n" } }] },
      { text: "Now done." },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "test-model",
      provider: "mock",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: loadBar(dir),
      archive: new Archive(dir),
      receipts: new Receipts(dir),
    });
    await drain(engine.run("go", allowAll));

    const receipts = new Receipts(dir);
    const rows = receipts.records();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].verdict, "refused");
    assert.deepEqual(rows[0].failed, ["landed"]);
    assert.equal(rows[1].verdict, "accepted");
    assert.deepEqual(rows[1].failed, []);

    const stats = receipts.stats();
    assert.equal(stats.attempts, 2);
    assert.equal(stats.accepted, 1);
    assert.equal(stats.refused, 1);
    assert.equal(stats.falseClaimRate, 0.5);
    // The denominator is the entire point of this metric. With two attempts
    // and one acceptance, dividing by attempts would halve it — and that is
    // precisely the misreading the number exists to prevent.
    assert.equal(
      stats.tokensPerVerifiedChange,
      stats.totalTokens,
      "tokens per VERIFIED change: denominator is acceptances, not attempts",
    );
    assert.notEqual(
      stats.tokensPerVerifiedChange,
      Math.round(stats.totalTokens / stats.attempts),
      "dividing by attempts would understate the cost of trustworthy work",
    );
    assert.equal(stats.byModel["test-model"].accepted, 1);
  });

  it("reports no rate rather than a fake one with nothing recorded", () => {
    const s = new Receipts(ws()).stats();
    assert.equal(s.attempts, 0);
    assert.equal(s.tokensPerVerifiedChange, undefined);
  });

  it("greps receipt bodies for the evidence behind a claim", async () => {
    const dir = ws();
    writeFileSync(join(dir, "check.sh"), 'echo "EVIDENCE-MARKER-5521"\nexit 1\n');
    writeBar(
      dir,
      "version: 1\nchecks:\n  - name: suite\n    run: sh check.sh\n    timeout: 10\n",
    );
    const provider = scriptedProvider([{ text: "Done." }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: loadBar(dir),
      receipts: new Receipts(dir),
      maxProofAttempts: 1,
    });
    await drain(engine.run("go", allowAll));

    const hits = new Receipts(dir).grep("EVIDENCE-MARKER-5521");
    assert.ok(hits.length > 0, "a claim's evidence must be findable by grep");
  });
});
