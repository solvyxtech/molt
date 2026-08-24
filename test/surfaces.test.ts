/**
 * Capability with no surface is not a feature. The archive grep, the regrow
 * path, and the receipt index all existed before anything could reach them —
 * these tests exist so that cannot silently happen again.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { loadBar, parseBar, selectChecks } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { gate } from "../src/autonomy.js";
import { Receipts } from "../src/receipts.js";
import type { BarResult } from "../src/types.js";
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

describe("switching endpoints", () => {
  it("does not carry the model across", () => {
    // Reported from use: after logging into Anthropic the status line read
    // `anthropic · grok-4.6` — a pairing that exists nowhere, shown as fact,
    // on the row whose whole job is to say what you are pointed at.
    const engine = new Engine({
      baseUrl: "https://api.x.ai/v1",
      model: "grok-4.6",
      provider: "xai",
      cwd: ws(),
      bar: null,
    });
    assert.equal(engine.model, "grok-4.6");

    engine.setBaseUrl("https://api.anthropic.com/v1", "k", "anthropic");
    assert.equal(engine.provider, "anthropic");
    assert.equal(engine.model, "", "a model name belongs to the endpoint that serves it");
  });

  it("keeps the model when the endpoint has not moved", () => {
    // Re-authenticating against the same endpoint is not a switch.
    const engine = new Engine({
      baseUrl: "https://api.x.ai/v1",
      model: "grok-4.6",
      provider: "xai",
      cwd: ws(),
      bar: null,
    });
    engine.setBaseUrl("https://api.x.ai/v1", "new-key", "xai");
    assert.equal(engine.model, "grok-4.6");
  });
});

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

describe("receipt numbers are not reused", () => {
  it("numbers from the highest ever issued, not from how many survive", () => {
    // `count()` is only the same as "next number" while nobody deletes one.
    // Delete 0000 and the next write is numbered 0001 again, so two different
    // receipts share a number and the index lists both under it. This project's
    // own .molt reached 26 index rows over 9 files with 0000-0008 each
    // duplicated. A receipt is the document you hand to someone who does not
    // trust you; reusing its number is not cosmetic.
    const dir = ws();
    const receipts = new Receipts(dir);
    const result: BarResult = { ok: true, results: [], durationMs: 1 };
    const base = {
      result,
      attempt: 1,
      model: "m",
      provider: "p",
      sessionTokens: 1,
      shedBatches: 0,
      changed: [],
      did: [],
    };

    const first = receipts.write({ claim: "one", verdict: "accepted", ...base });
    const second = receipts.write({ claim: "two", verdict: "refused", ...base });
    assert.match(first.path, /0000-accepted\.md$/);
    assert.match(second.path, /0001-refused\.md$/);

    rmSync(first.path);
    const third = receipts.write({ claim: "three", verdict: "accepted", ...base });
    assert.match(third.path, /0002-accepted\.md$/, "reused a number a deleted receipt already had");

    // And the index does not end up with two rows under one sequence.
    const seqs = receipts.records().map((r) => String(r.file).slice(0, 4));
    assert.equal(new Set(seqs).size, seqs.length, `duplicated sequence in the index: ${seqs.join(",")}`);
  });

  it("says a receipt is indexed but missing rather than absent", () => {
    // The listing reads the index and --show reads the directory, so a receipt
    // whose file is gone was printed by one and denied by the other.
    const dir = ws();
    const receipts = new Receipts(dir);
    const r = receipts.write({
      claim: "gone",
      verdict: "accepted",
      result: { ok: true, results: [], durationMs: 1 } as BarResult,
      attempt: 1,
      model: "m",
      provider: "p",
      sessionTokens: 1,
      shedBatches: 0,
      changed: [],
      did: [],
    });
    rmSync(r.path);
    assert.equal(receipts.list().length, 0, "the file should be gone");
    assert.equal(receipts.records().length, 1, "the index should still remember it");
  });
});

describe("receipts --repair", () => {
  const result: BarResult = { ok: true, results: [], durationMs: 1 };
  const base = {
    result,
    attempt: 1,
    model: "m",
    provider: "p",
    sessionTokens: 1,
    shedBatches: 0,
    changed: [] as { path: string; before: string | null; after: string }[],
    did: [] as string[],
  };

  it("leaves a healthy index untouched", () => {
    // Repair is reconciliation, not a rewrite. A project whose files match
    // its index must be able to run this twice — or once — and find the
    // bytes of the audit trail exactly where they were.
    const dir = ws();
    const receipts = new Receipts(dir);
    receipts.write({ claim: "one", verdict: "accepted", ...base });
    receipts.write({ claim: "two", verdict: "refused", ...base });
    const index = join(dir, ".molt", "receipts", "index.jsonl");
    const before = readFileSync(index);

    const report = receipts.repair();

    assert.equal(report.marked, 0);
    assert.equal(report.kept, 2);
    assert.deepEqual(readFileSync(index), before, "rewrote an index that already matched disk");
    assert.equal(receipts.records().every((r) => !r.missing), true);
  });

  it("marks a ghost row missing rather than deleting it", () => {
    // The record of a receipt is itself evidence. Silently dropping a row
    // whose file is gone would be the tool editing its own audit trail —
    // the same shape of hole this index exists to prevent.
    const dir = ws();
    const receipts = new Receipts(dir);
    const kept = receipts.write({ claim: "stays", verdict: "accepted", ...base });
    const ghost = receipts.write({ claim: "gone", verdict: "refused", ...base });
    const index = join(dir, ".molt", "receipts", "index.jsonl");
    const keptLine = readFileSync(index, "utf8")
      .split("\n")
      .find((l) => l.includes(kept.path.slice(kept.path.lastIndexOf("/") + 1)));
    rmSync(ghost.path);

    const report = receipts.repair();

    const rows = receipts.records();
    assert.equal(rows.length, 2, "deleted a row instead of marking it");
    assert.equal(rows[0].missing, undefined, "touched a row whose file exists");
    assert.equal(rows[1].missing, true);
    assert.equal(report.marked, 1);
    assert.equal(report.kept, 1);
    assert.ok(
      readFileSync(index, "utf8").includes(keptLine!),
      "rewrote a row whose file exists",
    );
  });

  it("changes nothing the second time it runs", () => {
    const dir = ws();
    const receipts = new Receipts(dir);
    const ghost = receipts.write({ claim: "gone", verdict: "refused", ...base });
    rmSync(ghost.path);
    receipts.repair();
    const index = join(dir, ".molt", "receipts", "index.jsonl");
    const afterFirst = readFileSync(index);
    const rowsFirst = receipts.records();

    const report = receipts.repair();

    assert.equal(report.marked, 0, "marked the same ghost twice");
    assert.deepEqual(readFileSync(index), afterFirst);
    assert.deepEqual(receipts.records(), rowsFirst);
  });
});

describe("stats over receipts that still exist", () => {
  it("does not compute a false-claim rate over files that are gone", () => {
    // `molt stats` used to treat every index row as checkable evidence.
    // Sixteen of this project's own rows pointed at files that were not
    // there; the rate was a number nobody could open.
    const dir = ws();
    const receipts = new Receipts(dir);
    const result: BarResult = { ok: true, results: [], durationMs: 1 };
    const base = {
      result,
      attempt: 1,
      model: "m",
      provider: "p",
      sessionTokens: 100,
      shedBatches: 0,
      changed: [] as { path: string; before: string | null; after: string }[],
      did: [] as string[],
    };
    receipts.write({ claim: "keep", verdict: "accepted", ...base });
    const ghost = receipts.write({ claim: "gone", verdict: "refused", ...base });
    rmSync(ghost.path);

    const s = receipts.stats();
    assert.equal(s.attempts, 2, "the index still recorded both");
    assert.equal(s.present, 1, "conflated recorded attempts with receipts still on disk");
    assert.equal(s.accepted, 1);
    assert.equal(s.refused, 0, "counted a refused receipt nobody can open");
    assert.equal(s.falseClaimRate, 0, "rate used a receipt that is gone");
  });
});

describe("commands that are not sessions", () => {
  it("sort and uniq ask at medium when they are told to write", () => {
    // Read-only in the common case, writing in the flag — the same reason sed
    // and awk were kept off the read-only table entirely.
    const w = ws();
    const ask = (command: string, level: "medium" | "high") =>
      gate(level, { name: "bash", args: { command }, cwd: w }).ask;

    for (const c of ["sort -o out.txt in.txt", "sort --output=out.txt in.txt", "uniq -o out.txt", "sort -uo out.txt in.txt"]) {
      assert.equal(ask(c, "medium"), true, `medium ran "${c}" unattended`);
    }
    for (const c of ["sort in.txt", "uniq in.txt", "sort -u in.txt"]) {
      assert.equal(ask(c, "medium"), false, `medium started asking about "${c}"`);
    }
    // `-o` means something harmless elsewhere and must not be swept up.
    assert.equal(ask("find . -name a -o -name b", "medium"), false, "find's boolean OR read as a write");
    assert.equal(ask("du -o /tmp", "medium"), false, "du's mount filter read as a write");
  });
});

describe("build output is not work", () => {
  const base = {
    baseUrl: "http://p.test/v1",
    model: "m",
    bar: null,
    stream: false,
    autonomy: "high" as const,
  };

  /** A model that writes `path`, then claims done. */
  function writerFor(path: string) {
    let n = 0;
    return (async () => {
      n += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => "",
        json: async () => ({
          choices: [
            {
              message:
                n === 1
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "c1",
                          type: "function",
                          function: {
                            name: "write_file",
                            arguments: JSON.stringify({ path, content: "generated\n" }),
                          },
                        },
                      ],
                    }
                  : { role: "assistant", content: "done" },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("does not count a write into a build directory as work landed", async () => {
    // molt hit this and reasoned its way through it: a ledgered file under
    // dist-test/ no longer matched disk because a rebuild had overwritten it,
    // and rather than conclude that a generated file has no business in the
    // ledger it rewrote the compiled artifact so the hashes would agree. Bar
    // met in 34ms — a path under dist-test/ is outside every watch glob in the
    // bar, so the command checks were reused as well. A route to "bar met"
    // with no verification in it is the one defect this cannot carry.
    const dir = ws();
    const engine = new Engine({ ...base, cwd: dir, fetchFn: writerFor("dist-test/src/x.js") });
    await drain(engine.run("go", allowAll));
    assert.deepEqual(
      engine.mergedLedger().map((e) => e.path),
      [],
      "a build artifact was ledgered as work",
    );
  });

  it("still writes the file, and says why it does not count", async () => {
    // Not a refusal to touch the path — molt writes it and is plain about what
    // the write is worth.
    const dir = ws();
    const engine = new Engine({ ...base, cwd: dir, fetchFn: writerFor("dist/cli.js") });
    const events = await drain(engine.run("go", allowAll));
    assert.ok(existsSync(join(dir, "dist/cli.js")), "the write did not happen");
    const tool = events.find((e) => e.kind === "tool") as { preview?: string } | undefined;
    assert.match(tool?.preview ?? "", /not counted as work/, "wrote it without saying it was free");
  });

  it("still counts an ordinary source file", async () => {
    const dir = ws();
    const engine = new Engine({ ...base, cwd: dir, fetchFn: writerFor("src/real.ts") });
    await drain(engine.run("go", allowAll));
    assert.deepEqual(engine.mergedLedger().map((e) => e.path), ["src/real.ts"]);
  });
});
