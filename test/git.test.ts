/**
 * Keeping what passed and putting back what did not.
 *
 * The whole feature is one loop — run, judge, keep or discard — and the only
 * part of it that can hurt someone is the discard. So the tests that matter
 * most here are the ones about what a revert must NOT do: it must not reach
 * a file the turn never wrote, it must not restore a file to HEAD when the
 * user had unsaved changes of their own, and it must not delete something git
 * has no copy of.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  commitMessage,
  commitPaths,
  isRepo,
  lastCommit,
  pathsIn,
  restore,
  revertPlan,
  snapshot,
  undoLast,
  MOLT_TRAILER,
  SUBJECT_MAX,
} from "../src/git.js";
import { workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

/** A workspace that is a git repository with one commit in it. */
function repo(): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: w.dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "molt test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(w.dir, "seed.txt"), "seed\n", "utf8");
  git("add", "seed.txt");
  git("commit", "-q", "-m", "seed");
  return w.dir;
}

const log = (dir: string, fmt: string): string =>
  execFileSync("git", ["log", "-1", `--format=${fmt}`], { cwd: dir, encoding: "utf8" }).trim();

describe("revertPlan", () => {
  it("removes what the turn created and restores what it edited", () => {
    const plan = revertPlan(
      [
        { path: "made.ts", before: null },
        { path: "edited.ts", before: "abc" },
      ],
      (p) => p === "edited.ts",
    );
    assert.deepEqual(plan.remove, ["made.ts"]);
    assert.deepEqual(plan.restore, ["edited.ts"]);
    assert.deepEqual(plan.keep, []);
  });

  it("leaves alone a file git has no copy of", () => {
    // Pre-existing and untracked. There is nothing to restore it TO, and
    // deleting it would destroy work no version control ever saw.
    const plan = revertPlan([{ path: "notes.txt", before: "abc" }], () => false);
    assert.deepEqual(plan, { restore: [], remove: [], keep: ["notes.txt"] });
  });

  it("treats a file created then edited as created", () => {
    // Written twice in one turn: the first write found nothing there, so the
    // turn is what put it on disk however many times it changed afterwards.
    const plan = revertPlan(
      [
        { path: "new.ts", before: null },
        { path: "new.ts", before: "abc" },
      ],
      () => true,
    );
    assert.deepEqual(plan.remove, ["new.ts"]);
    assert.deepEqual(plan.restore, []);
  });
});

describe("commitMessage", () => {
  it("says what was asked, what was checked, and where the evidence is", () => {
    const m = commitMessage({
      task: "fix the failing parser test",
      receipt: "0007-accepted.md",
      checks: ["types", "tests"],
      attempts: 2,
      session: "abc123",
    });
    assert.match(m.split("\n")[0]!, /^fix the failing parser test$/);
    assert.match(m, /Verified by 2 check\(s\): types, tests\./);
    assert.match(m, /Met on attempt 2\./);
    assert.match(m, new RegExp(`^${MOLT_TRAILER}: 0007-accepted\\.md$`, "m"));
  });

  it("cuts a subject nobody could read in a log", () => {
    const m = commitMessage({ task: "x".repeat(200) });
    const subject = m.split("\n")[0]!;
    assert.ok(subject.length <= SUBJECT_MAX, `subject ran to ${subject.length}`);
    assert.match(subject, /…$/);
  });

  it("takes the first line of a request that runs to paragraphs", () => {
    const m = commitMessage({ task: "\n\nadd the retry\n\nand while you are there, tidy up\n" });
    assert.equal(m.split("\n")[0], "add the retry");
  });
});

describe("committing what the bar verified", () => {
  it("commits only the named paths, and marks the commit as molt's", async () => {
    const dir = repo();
    writeFileSync(join(dir, "mine.ts"), "molt wrote this\n", "utf8");
    writeFileSync(join(dir, "theirs.ts"), "someone else was working here\n", "utf8");

    const r = await commitPaths(dir, ["mine.ts"], commitMessage({ task: "add mine", receipt: "0001-accepted.md" }));
    assert.equal(r.ok, true);

    const files = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    assert.equal(files, "mine.ts", "a concurrent edit was swept into molt's commit");
    assert.match(log(dir, "%b"), new RegExp(`^${MOLT_TRAILER}:`, "m"));
    // Still uncommitted, still on disk, exactly as it was.
    assert.equal(readFileSync(join(dir, "theirs.ts"), "utf8"), "someone else was working here\n");
  });

  it("says so rather than failing when there is nothing to commit", async () => {
    const dir = repo();
    const r = await commitPaths(dir, ["seed.txt"], "no change");
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /nothing to commit/);
  });
});

describe("undo", () => {
  it("takes back molt's commit and leaves the work on disk", async () => {
    const dir = repo();
    const head0 = log(dir, "%H");
    writeFileSync(join(dir, "work.ts"), "the change\n", "utf8");
    await commitPaths(dir, ["work.ts"], commitMessage({ task: "do the thing", receipt: "0001-accepted.md" }));

    const r = await undoLast(dir);
    assert.equal(r.ok, true);
    assert.equal(log(dir, "%H"), head0, "HEAD did not move back");
    // The point of --mixed over aider's --hard: the work is still yours.
    assert.equal(readFileSync(join(dir, "work.ts"), "utf8"), "the change\n");
  });

  it("refuses a commit molt did not make", async () => {
    const dir = repo();
    writeFileSync(join(dir, "human.ts"), "by hand\n", "utf8");
    execFileSync("git", ["add", "human.ts"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "a human commit"], { cwd: dir });

    const r = await undoLast(dir);
    assert.equal(r.ok, false, "rewound someone else's commit");
    assert.match(r.ok === false ? r.reason : "", /not molt's/);
    assert.equal(log(dir, "%s"), "a human commit");
  });

  it("refuses outside a repository", async () => {
    const w = workspace();
    cleanups.push(w.cleanup);
    const r = await undoLast(w.dir);
    assert.equal(r.ok, false);
  });
});

describe("restoring a turn that did not pass", () => {
  it("puts a file back the way the USER had it, not the way HEAD has it", async () => {
    const dir = repo();
    const file = join(dir, "seed.txt");
    // The user's own uncommitted edit, made before the turn started.
    writeFileSync(file, "seed\nthe user was here\n", "utf8");

    const ref = (await snapshot(dir))!;
    const tracked = await pathsIn(dir, ref);

    // Now the turn writes over it and the bar refuses the result.
    writeFileSync(file, "what the model did\n", "utf8");
    const plan = revertPlan([{ path: "seed.txt", before: "sha" }], (p) => tracked.has(p));
    const done = await restore(dir, ref, plan);

    assert.deepEqual(done.restored, ["seed.txt"]);
    assert.equal(
      readFileSync(file, "utf8"),
      "seed\nthe user was here\n",
      "restored to HEAD and threw away the user's uncommitted work",
    );
  });

  it("deletes what the turn created and keeps what it merely found", async () => {
    const dir = repo();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "untracked.md"), "notes I never committed\n", "utf8");
    const ref = (await snapshot(dir))!;
    const tracked = await pathsIn(dir, ref);

    writeFileSync(join(dir, "src", "new.ts"), "invented\n", "utf8");
    writeFileSync(join(dir, "untracked.md"), "overwritten by the model\n", "utf8");

    const plan = revertPlan(
      [
        { path: "src/new.ts", before: null },
        { path: "untracked.md", before: "sha" },
      ],
      (p) => tracked.has(p),
    );
    const done = await restore(dir, ref, plan);

    assert.deepEqual(done.removed, ["src/new.ts"]);
    assert.equal(existsSync(join(dir, "src", "new.ts")), false);
    assert.deepEqual(done.kept, ["untracked.md"]);
    assert.equal(
      readFileSync(join(dir, "untracked.md"), "utf8"),
      "overwritten by the model\n",
      "a file git never had a copy of must be left alone, not deleted",
    );
  });

  it("knows a directory that is not a repository", async () => {
    const w = workspace();
    cleanups.push(w.cleanup);
    assert.equal(await isRepo(w.dir), false);
    assert.equal(await lastCommit(w.dir), null);
  });
});
