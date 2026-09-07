/**
 * Nothing committed may depend on a file that was not committed.
 *
 * Earned on 2026-09-07 by breaking `main`. A commit staged src/criteria.ts,
 * src/interview.ts, src/cli.tsx and src/engine.ts and left src/acp.ts and
 * src/mcp-bridge.ts untracked — the modules all four import. A fresh clone
 * failed typecheck on four files.
 *
 * `npm run check` had passed at 1,296 tests minutes earlier and could not have
 * seen it: it reads the working tree, and the working tree had the files. What
 * is committed is a different artifact from what is verified — the same fault
 * as the stale installed app that started the day, one directory up.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseBar, runBar, type BarContext } from "../src/bar.js";
import { workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

const BAR = parseBar(
  "version: 1\nchecks:\n  - name: complete\n    builtin: imports-tracked\n",
);

function ctxIn(dir: string): BarContext {
  return {
    cwd: dir,
    ledger: [],
    turnLedger: [],
    record: [],
    archivedBatches: 0,
    sessionArchives: [],
  } as unknown as BarContext;
}

/** A repository with `files` on disk and `commit` of them tracked. */
function repo(files: Record<string, string>, commit: string[]): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  const dir = w.dir;
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path.split("/").slice(0, -1).join("/") || "."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  if (commit.length) {
    execFileSync("git", ["add", ...commit], { cwd: dir });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"],
      { cwd: dir },
    );
  }
  return dir;
}

async function check(dir: string) {
  const [r] = (await runBar(BAR, ctxIn(dir))).results;
  assert.ok(r, "the check must run");
  return r;
}

describe("imports-tracked", () => {
  /** The 2026-09-07 mistake, reduced to two files. */
  it("refuses when committed code imports a file git does not have", async () => {
    const dir = repo(
      { "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n', "src/b.ts": "export const b = 1;\n" },
      ["src/a.ts"],
    );
    const r = await check(dir);
    assert.equal(r.ok, false);
    assert.match(r.output, /src\/b\.ts — imported by src\/a\.ts/);
    // Say why it passes here and fails everywhere else, or the finding reads
    // as nonsense to the person whose machine is working perfectly.
    assert.match(r.output, /a clone would not have them/);
  });

  it("passes once the dependency is committed too", async () => {
    const dir = repo(
      { "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n', "src/b.ts": "export const b = 1;\n" },
      ["src/a.ts", "src/b.ts"],
    );
    const r = await check(dir);
    assert.equal(r.ok, true, r.output);
    assert.notEqual(r.established, false, "it compared something");
  });

  /**
   * An untracked file importing another untracked file is nobody's problem:
   * neither is committed, so no clone can be broken by them.
   */
  it("ignores imports between files that are both untracked", async () => {
    const dir = repo(
      {
        "src/kept.ts": "export const k = 1;\n",
        "src/scratch.ts": 'import { t } from "./tmp.js";\nexport const s = t;\n',
        "src/tmp.ts": "export const t = 1;\n",
      },
      ["src/kept.ts"],
    );
    const r = await check(dir);
    assert.equal(r.ok, true, r.output);
  });

  /** A broken import is the typechecker's finding, and it says it better. */
  it("says nothing about an import that resolves to no file at all", async () => {
    const dir = repo({ "src/a.ts": 'import { z } from "./gone.js";\nexport const a = z;\n' }, ["src/a.ts"]);
    const r = await check(dir);
    assert.equal(r.ok, true, r.output);
  });

  it("establishes nothing where there is no git to ask", async () => {
    const w = workspace();
    cleanups.push(w.cleanup);
    writeFileSync(join(w.dir, "a.ts"), "export const a = 1;\n");
    const r = await check(w.dir);
    assert.equal(r.ok, true);
    assert.equal(r.established, false, "no repository is not a clean bill of health");
  });

  it("is a builtin the bar will name", () => {
    assert.throws(
      () => parseBar("version: 1\nchecks:\n  - name: x\n    builtin: imports-trackd\n"),
      /unknown builtin/,
    );
  });
});

/**
 * The adaptation, not the patch.
 *
 * Two of the three failures on 2026-09-07 were one fault — molt judges the
 * working tree, and the tree is not what anyone receives — so the lesson has
 * to live where new projects get it, not only in this repository's own bar.
 */
describe("what molt proposes to a project it has never seen", () => {
  it("includes the completeness check, with no configuration to get wrong", async () => {
    const { proposeBar } = await import("../src/detect.js");
    const w = workspace();
    cleanups.push(w.cleanup);
    const { yaml } = proposeBar(w.dir);
    assert.match(yaml, /builtin: imports-tracked/, "every git project wants this one");
    // It reads no ledger, so it must not be tagged session — `molt prove`
    // standalone should still be able to answer it.
    const after = yaml.slice(yaml.indexOf("builtin: imports-tracked"));
    assert.doesNotMatch(
      after.slice(0, 80),
      /tags: \[session\]/,
      "imports-tracked needs no session and must run under `molt prove`",
    );
  });

  it("still parses as a bar", async () => {
    const { proposeBar } = await import("../src/detect.js");
    const w = workspace();
    cleanups.push(w.cleanup);
    const bar = parseBar(proposeBar(w.dir).yaml);
    assert.ok(bar.checks.some((c) => c.name === "work-complete"));
  });
});
