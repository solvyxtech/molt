/**
 * Reusing a check result.
 *
 * This is the most dangerous feature in the project, because a wrong cache is
 * a false "verified" — the exact claim molt exists to refuse, produced by molt
 * itself. So these tests are mostly about when it must NOT reuse. The saving
 * is worth having; it is not worth one stale pass.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CheckCache, parseBar, runBar } from "../src/bar.js";
import { fingerprint } from "../src/files.js";
import { workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

/** A project with a marker file the check counts. */
function project(): string {
  const dir = ws();
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "docs", "readme.md"), "# docs\n");
  return dir;
}

const context = (dir: string, cache?: CheckCache) => ({
  cwd: dir,
  record: [],
  ledger: [],
  liveLedger: [],
  archivedBatches: 0,
  expectedArchivedWrites: 0,
  expectedArchiveFiles: [],
  ...(cache ? { cache } : {}),
});

/** A check that appends to a file each time it runs, so runs are countable. */
function countingBar(dir: string, watch?: string) {
  const counter = join(dir, "runs.txt");
  const yaml =
    "version: 1\nchecks:\n  - name: tally\n" +
    `    run: printf x >> ${counter}\n` +
    (watch ? `    watch: [${watch}]\n` : "");
  return { bar: parseBar(yaml), counter };
}

const runs = (dir: string): number => {
  try {
    return readFileSync(join(dir, "runs.txt"), "utf8").length;
  } catch {
    return 0;
  }
};

describe("reusing a check result", () => {
  it("re-runs when a watched file changes", () => {
    const dir = project();
    const { bar } = countingBar(dir, '"src/**"');
    const cache = new CheckCache();

    runBar(bar, context(dir, cache));
    assert.equal(runs(dir), 1);

    writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
    runBar(bar, context(dir, cache));
    assert.equal(runs(dir), 2, "a change inside the watched scope must re-run the check");
  });

  it("reuses when nothing it watches changed", () => {
    // The whole point: four proof attempts against a ten-second suite is forty
    // seconds of inner loop spent re-proving the same thing.
    const dir = project();
    const { bar } = countingBar(dir, '"src/**"');
    const cache = new CheckCache();

    runBar(bar, context(dir, cache));
    writeFileSync(join(dir, "docs", "readme.md"), "# docs, edited\n");
    const second = runBar(bar, context(dir, cache));

    assert.equal(runs(dir), 1, "a docs edit re-ran a check that only watches src");
    assert.equal(second.results[0]!.cached, true, "a reused result must say so");
  });

  it("never reuses without a declared scope in a changing project", () => {
    // An undeclared check is fingerprinted against the whole project, which is
    // correct and almost never reusable. That is the right default here: molt
    // does not guess what a command reads.
    const dir = project();
    const { bar } = countingBar(dir);
    const cache = new CheckCache();

    runBar(bar, context(dir, cache));
    writeFileSync(join(dir, "docs", "readme.md"), "# anything at all\n");
    runBar(bar, context(dir, cache));
    assert.equal(runs(dir), 2, "an undeclared check reused a result after the project changed");
  });

  it("re-runs when the command changes, even if no file did", () => {
    // A bar that was edited cannot reuse a result from the bar before it.
    const dir = project();
    const cache = new CheckCache();
    const one = parseBar('version: 1\nchecks:\n  - name: t\n    run: "true"\n    watch: ["src/**"]\n');
    const two = parseBar('version: 1\nchecks:\n  - name: t\n    run: "false"\n    watch: ["src/**"]\n');

    assert.equal(runBar(one, context(dir, cache)).ok, true);
    const second = runBar(two, context(dir, cache));
    assert.equal(second.ok, false, "reused a result from a different command");
    assert.equal(second.results[0]!.cached, undefined);
  });

  it("re-runs when expect_exit changes", () => {
    const dir = project();
    const cache = new CheckCache();
    const zero = parseBar('version: 1\nchecks:\n  - name: t\n    run: "true"\n    watch: ["src/**"]\n');
    const one = parseBar(
      'version: 1\nchecks:\n  - name: t\n    run: "true"\n    expect_exit: 1\n    watch: ["src/**"]\n',
    );
    assert.equal(runBar(zero, context(dir, cache)).ok, true);
    assert.equal(runBar(one, context(dir, cache)).ok, false, "reused across a changed contract");
  });

  it("never reuses a builtin", () => {
    // Builtins read the session record, not the filesystem — nothing to save
    // and everything to get wrong.
    const dir = project();
    const cache = new CheckCache();
    const bar = parseBar("version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");

    assert.equal(runBar(bar, context(dir, cache)).results[0]!.cached, undefined);
    assert.equal(runBar(bar, context(dir, cache)).results[0]!.cached, undefined);
  });

  it("works at all only when a cache is supplied", () => {
    // molt prove runs in a fresh process and gets no cache, so it always
    // measures rather than remembers.
    const dir = project();
    const { bar } = countingBar(dir, '"src/**"');
    runBar(bar, context(dir));
    runBar(bar, context(dir));
    assert.equal(runs(dir), 2);
  });
});

describe("the fingerprint", () => {
  it("changes when a watched file's contents change", () => {
    const dir = project();
    const before = fingerprint(dir, ["src/**"]);
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 999;\n");
    assert.notEqual(fingerprint(dir, ["src/**"]), before);
  });

  it("changes when a file is added to the scope", () => {
    const dir = project();
    const before = fingerprint(dir, ["src/**"]);
    writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
    assert.notEqual(fingerprint(dir, ["src/**"]), before);
  });

  it("changes when a file is touched without editing it", () => {
    // Over-invalidation is the safe direction: this costs a re-run, and the
    // alternative costs a stale pass.
    const dir = project();
    const before = fingerprint(dir, ["src/**"]);
    const later = new Date(Date.now() + 10_000);
    utimesSync(join(dir, "src", "a.ts"), later, later);
    assert.notEqual(fingerprint(dir, ["src/**"]), before);
  });

  it("ignores what is outside the declared scope", () => {
    const dir = project();
    const before = fingerprint(dir, ["src/**"]);
    writeFileSync(join(dir, "docs", "readme.md"), "# rewritten entirely\n");
    assert.equal(fingerprint(dir, ["src/**"]), before);
  });

  it("is stable when nothing happens", () => {
    const dir = project();
    assert.equal(fingerprint(dir, ["src/**"]), fingerprint(dir, ["src/**"]));
    assert.equal(fingerprint(dir), fingerprint(dir));
  });

  it("refuses to sign a scope it could not finish reading", () => {
    // A signature of an unknown subset is not a signature.
    const dir = ws();
    mkdirSync(join(dir, "many"), { recursive: true });
    for (let i = 0; i < 20_100; i++) writeFileSync(join(dir, "many", `f${i}.txt`), "x");
    assert.match(fingerprint(dir), /^unbounded:/);
  });
});
