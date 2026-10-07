/**
 * Hidden checks stay hidden on disk, and checks cannot change the work.
 *
 * 2026-10-07, fix-git with a Grok worker: after one refusal the worker
 * grepped the filesystem for the check names it had been shown and found
 * every sealed command in full, in `.maat/receipts/0000-refused.md`, the
 * journal's `bar_run` entries and Maat's own copy of its grep under
 * `.maat/out/`. In the same run a sealed check was
 * `git checkout master && git merge …`, so running the check changed the
 * repository it was judging.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { Engine, sealOf } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import { Receipts } from "../src/receipts.js";
import { Integrity } from "../src/integrity.js";
import { runCheck, type BarContext } from "../src/bar.js";
import { preflightCriteria } from "../src/criteria.js";
import { checkMutates } from "../src/checkwrites.js";
import { lintAll } from "../src/checklint.js";
import { copyTree } from "../src/scratch.js";
import { WITHHELD, maskText } from "../src/withhold.js";
import type { BarResult, Check, CheckResult, EngineEvent } from "../src/types.js";
import { allowAll, scriptedProvider, workspace } from "./helpers.js";

const TASK = "Write out.txt containing the greeting the release notes ask for.";
const SECRET_A = "grep -q 'zebra-quantum-42' out.txt";
const SECRET_B = "test \"$(wc -l < out.txt)\" -ge 1 && grep -c 'zebra' out.txt";
const checks = (hidden: boolean): Check[] => [
  { name: "task:has-greeting", kind: "command", run: SECRET_A, timeoutMs: 5_000, expectExit: 0, tags: ["task", "value"], hidden },
  { name: "task:non-empty", kind: "command", run: SECRET_B, timeoutMs: 5_000, expectExit: 0, tags: ["task"], hidden },
];

/** Every file under `dir`, as text. */
function filesUnder(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push({ path: relative(dir, p), text: readFileSync(p, "utf8") });
    }
  };
  walk(dir);
  return out;
}

const containing = (dir: string, needle: string) => filesUnder(dir).filter((f) => f.text.includes(needle)).map((f) => f.path);

/** A fingerprint of every byte under `dir`, paths and modes included (.git too). */
/** Every path under `dir` with its mode and content hash, for saying what a check changed. */
function treeListing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p);
      out.push(`${relative(dir, p)} ${st.mode} ${st.isFile() ? createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12) : ""}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

function changed(before: string[], after: string[]): string[] {
  return [...after.filter((x) => !before.includes(x)).map((x) => `+ ${x}`), ...before.filter((x) => !after.includes(x)).map((x) => `- ${x}`)];
}

function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p);
      h.update(`${relative(dir, p)}\0${st.mode}\0`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

function engineIn(dir: string, fetchFn: typeof fetch) {
  const journal = new Journal(dir);
  const receipts = new Receipts(dir);
  const integrity = new Integrity(dir);
  const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: dir, fetchFn, bar: null, stream: false, autonomy: "high", journal, receipts, integrity });
  return { engine, journal, receipts };
}

const write = (path: string, content: string) => ({ name: "write_file", args: { path, content } });
// The worker hunts for the check names, the way the Grok worker did.
const hunt = { name: "bash", args: { command: "grep -r 'has-greeting' .maat || true" } };

describe("hidden checks are not on disk while the job runs", () => {
  it("after a refusal no file under the task folder holds a hidden command; after the job, the full receipt does", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([
        { calls: [write("out.txt", "hello\n")] },
        { text: "Done." },
        { calls: [hunt] },
        { calls: [write("out.txt", "hello zebra-quantum-42\n")] },
        { text: "Done now." },
      ]);
      const { engine } = engineIn(ws.dir, provider.fetchFn);
      const events: EngineEvent[] = [];
      let scannedAfterRefusal = false;
      let scannedAfterHunt = false;
      for await (const raw of engine.run(TASK, allowAll, { taskChecks: checks(true) })) {
        const ev = engine.maskEvent(raw);
        events.push(raw);
        if (raw.kind !== "checks_released") {
          // What a harness would print (bench/harbor tees this into a file the worker can read).
          const line = JSON.stringify(ev);
          assert.ok(!line.includes("grep -q 'zebra-quantum-42'") && !line.includes("wc -l < out.txt"), `event ${raw.kind} quotes a hidden command`);
        }
        if (raw.kind === "proof_refused" && !scannedAfterRefusal) {
          scannedAfterRefusal = true;
          assert.ok(existsSync(join(ws.dir, ".maat", "receipts", "0000-refused.md")), "the refused receipt is on disk");
          for (const needle of [SECRET_A, SECRET_B, "zebra-quantum-42"]) {
            assert.deepEqual(containing(ws.dir, needle), [], `"${needle}" is readable mid-run`);
          }
          const receipt = readFileSync(join(ws.dir, ".maat", "receipts", "0000-refused.md"), "utf8");
          assert.match(receipt, /task:has-greeting/, "the receipt still names the check");
          assert.ok(receipt.includes(WITHHELD), "and says the command is withheld");
          assert.ok(!existsSync(join(ws.dir, ".maat", "receipts", "full")), "no full twin before the job ends");
        }
        if (raw.kind === "tool" && raw.name === "bash" && !scannedAfterHunt) {
          scannedAfterHunt = true;
          assert.deepEqual(containing(ws.dir, "zebra-quantum-42"), [], "Maat's copy of the hunt's output quotes nothing hidden");
        }
      }
      assert.ok(scannedAfterRefusal, "the claim was refused once");
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.outcome === "verified", "the second claim passed");

      // After the job: the commands are on the record.
      const released = events.find((e) => e.kind === "checks_released");
      assert.ok(released && released.kind === "checks_released");
      assert.deepEqual(released.checks.map((c) => c.run).sort(), [SECRET_A, SECRET_B].sort());
      const full = join(ws.dir, ".maat", "receipts", "full", "0000-refused.md");
      assert.ok(existsSync(full), "the full receipt exists after the job");
      const fullText = readFileSync(full, "utf8");
      assert.ok(fullText.includes(SECRET_A) && fullText.includes(SECRET_B), "with the commands in it");
      assert.match(fullText, /The full text of `0000-refused\.md`/);
      // The receipt on disk is untouched: the integrity chain still verifies, the twin bound too.
      const v = Integrity.verify(ws.dir);
      assert.equal(v.ok, true, v.reason);
      assert.deepEqual(v.drift, []);
      const ledger = readFileSync(join(ws.dir, ".maat", "integrity", "ledger.jsonl"), "utf8");
      assert.match(ledger, /"kind":"release".*full\/0000-refused\.md/);
      // The journal now holds the commands, and the seal they were published under checks out.
      const log = readdirSync(join(ws.dir, ".maat", "log")).map((f) => readFileSync(join(ws.dir, ".maat", "log", f), "utf8")).join("");
      const entries = log.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });
      const sealed = entries.find((e) => /task criteria sealed/.test(String(e.data.text)));
      const rel = entries.find((e) => e.data.kind === "checks-released");
      assert.ok(sealed && rel, "sealed before, released after");
      assert.ok(entries.indexOf(sealed!) < entries.indexOf(rel!));
      assert.equal(rel!.data.seal, sealed!.data.seal);
      assert.equal(sealed!.data.seal, sealOf(checks(true), []));
      assert.ok(JSON.stringify(rel!.data).includes("zebra-quantum-42"));
      // Every bar_run written during the job named the checks and masked the commands.
      for (const e of entries.filter((x) => x.kind === "bar_run")) assert.ok(!JSON.stringify(e).includes("zebra-quantum-42"));
    } finally {
      ws.cleanup();
    }
  });

  it("checks a person approved are not hidden, and their receipts quote them as before", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([{ calls: [write("out.txt", "hello\n")] }, { text: "Done." }, { calls: [write("out.txt", "zebra-quantum-42\n")] }, { text: "Done." }]);
      const { engine } = engineIn(ws.dir, provider.fetchFn);
      const events: EngineEvent[] = [];
      for await (const ev of engine.run(TASK, allowAll, { taskChecks: checks(false) })) events.push(ev);
      assert.ok(!events.some((e) => e.kind === "checks_released"));
      const receipt = readFileSync(join(ws.dir, ".maat", "receipts", "0000-refused.md"), "utf8");
      assert.ok(receipt.includes(SECRET_A), "an approved check's command is on its receipt");
      assert.ok(!existsSync(join(ws.dir, ".maat", "receipts", "full")));
    } finally {
      ws.cleanup();
    }
  });
});

describe("a hidden command is masked before it is cut or escaped", () => {
  // A command with a pipe, long enough that the receipt's 90-character cell
  // cuts it: the cut leaves a prefix, and the cell escapes `|` to `\|`.
  const CMD = "python3 -c 'import sys; print(sys.argv)' zebra-quantum-42 | grep -q 'zebra-quantum-42' && test -s out.txt && echo ok-long-tail";

  it("maskText matches a command whose pipes were escaped for a table", () => {
    assert.equal(maskText(`| x | ${CMD.replace(/\|/g, "\\|")} |`, [CMD]), `| x | ${WITHHELD} |`);
  });

  it("a failing hidden check whose output echoes its command shows the mask, not a prefix", async () => {
    const ws = workspace();
    try {
      const run = `cat echo.txt; exit 1; # ${CMD}`;
      writeFileSync(join(ws.dir, "echo.txt"), `bash: line 1: ${run}\n`);
      const ctx = { cwd: ws.dir, record: [], ledger: [], archivedBatches: 0 } as unknown as BarContext;
      const r = await runCheck({ name: "task:echo", kind: "command", run, timeoutMs: 5_000, expectExit: 0, tags: ["task"], hidden: true }, ctx);
      assert.equal(r.ok, false);
      assert.ok(r.output.includes(WITHHELD), r.output);
      assert.ok(!r.output.includes("zebra-quantum-42"), r.output);
    } finally {
      ws.cleanup();
    }
  });

  it("a receipt's table cell is masked before the cut and the escape", () => {
    const ws = workspace();
    try {
      const receipts = new Receipts(ws.dir);
      receipts.withhold([CMD]);
      const failed: CheckResult = {
        name: "task:greets", hidden: true, kind: "command", detail: CMD, ok: false, exitCode: 1, durationMs: 3,
        output: `${CMD}\n`,
      } as CheckResult;
      const result = { ok: false, results: [failed], durationMs: 3 } as unknown as BarResult;
      const rec = receipts.write({ claim: "done", result, attempt: 0, verdict: "refused", model: "m", provider: "p", sessionTokens: 0, shedBatches: 0 });
      const text = readFileSync(rec.path, "utf8");
      assert.ok(!text.includes("zebra-quantum-42"), text);
      assert.ok(!text.includes("python3 -c 'import sys"), "no prefix of the command survives the cut");
      const index = readFileSync(join(ws.dir, ".maat", "receipts", "index.jsonl"), "utf8");
      assert.ok(!index.includes("zebra-quantum-42"), index);
    } finally {
      ws.cleanup();
    }
  });
});

describe("checks cannot change the work", () => {
  const MUTATING: [string, string][] = [
    ["git checkout", "git checkout master && git merge --no-ff -m 'Merge about page changes' about.md"],
    ["git merge", "git merge feature"],
    ["git commit", "git commit -am wip"],
    ["git reset", "git reset --hard HEAD~1"],
    ["git stash", "git stash && git status --short"],
    ["git add", "git add about.md && git diff --cached --quiet"],
    ["git rm", "git rm -q about.md"],
    ["rm", "rm -f out.txt && test ! -e out.txt"],
    ["mv", "mv about.md about.bak"],
    ["redirect into the project", "python3 wc.py > out.txt && diff out.txt expected.txt"],
    ["append redirect", "echo x >> notes.md"],
    ["sed -i", "sed -i 's/a/b/' about.md"],
    ["tee into a file", "python3 wc.py | tee result.txt | grep -q 3"],
    ["pip install", "pip install requests && python3 -c 'import requests'"],
    ["python -m pip install", "python3 -m pip install -q pytest"],
    ["npm install", "npm install && npm test"],
    ["apt-get install", "apt-get install -y jq"],
    ["git checkout inside bash -c", "bash -c 'git checkout main' && grep -q x a.txt"],
    ["rm inside sh -c", 'sh -c "rm -rf src"'],
    ["a write inside eval", "eval 'echo x > notes.md'"],
    ["a nested bash -c", `bash -c "sh -c 'git merge feature'"`],
  ];
  for (const [what, run] of MUTATING) {
    it(`the lint flags ${what}`, () => {
      assert.ok(checkMutates(run), `${run} was not flagged`);
      const hits = lintAll(run, { task: "Find the lost about-page changes and merge them into master", shell: "bash", probes: { hasCommand: () => true, hasPyModule: () => true, awkIntervals: () => true } });
      assert.ok(hits.some((h) => h.rule === "L15-mutates"), `${run}: ${JSON.stringify(hits)}`);
    });
  }

  it("the lint lets reads and scratch writes through", () => {
    for (const run of [
      "git log --oneline -n 5 | grep -q 'about page changes'",
      "git diff --cached --name-only | grep -q 'about.md'",
      "git stash list | grep -q wip",
      "awk '$2 > 10 {n++} END {exit !(n == 3)}' data.txt",
      "python3 wc.py > /tmp/out.txt && diff /tmp/out.txt expected.txt",
      "d=$(mktemp -d) && python3 wc.py > \"$d/out\" && diff \"$d/out\" expected.txt; rm -rf \"$d\"",
      "t=$(mktemp -d) && git clone -q . \"$t/r\" && cd \"$t/r\" && git merge -q feature && grep -q x a.txt",
      "python3 app.py 2>&1 >/dev/null | grep -q Traceback; test $? -eq 1",
      "python3 wc.py | tee /dev/null | grep -q 3",
      "bash -c 'grep -q x a.txt && git log -1'",
      "d=$(mktemp -d) && bash -c \"echo x > $d/out\" && test -s \"$d/out\"",
      "eval 'test -f a.txt'",
    ]) {
      assert.equal(checkMutates(run), null, run);
    }
  });

  it("says which shell a nested write is in, and reads xargs input as input", () => {
    assert.match(checkMutates("bash -c 'git checkout main'") ?? "", /git checkout.*inside `bash -c`/);
    assert.match(checkMutates("eval 'rm -f a.txt'") ?? "", /deletes a\.txt.*inside `eval`/);
    assert.equal(checkMutates("xargs rm < files.txt"), "it deletes its input (`rm`); a check only reads");
    assert.equal(checkMutates("grep -c x < a.txt"), null);
  });

  function repo(): { dir: string; cleanup: () => void } {
    const ws = workspace();
    const git = (...a: string[]) => execFileSync("git", a, { cwd: ws.dir, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "master");
    // The checks below commit and merge with the ambient environment. On a
    // machine with no global git identity that failed ("Committer identity
    // unknown"); the repo's own config is copied into the throwaway tree.
    git("config", "user.name", "t");
    git("config", "user.email", "t@t");
    // No detached `gc --auto`/maintenance still writing under .git while a test copies it.
    git("config", "gc.auto", "0");
    git("config", "maintenance.auto", "false");
    writeFileSync(join(ws.dir, "about.md"), "# About\nI am a student.\n");
    writeFileSync(join(ws.dir, "index.md"), "welcome\n");
    mkdirSync(join(ws.dir, "docs"));
    writeFileSync(join(ws.dir, "docs", "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(ws.dir, "about.md"), "# About\nI am a postdoc.\n");
    git("commit", "-qam", "Move to Stanford");
    git("checkout", "-q", "master");
    return ws;
  }

  const MUTATOR =
    "git checkout -q feature && git merge -q --no-ff -m 'Merge about page changes' master; " +
    "git checkout -q master && git merge -q --no-ff -m m feature; echo junk >> index.md; rm -rf docs; " +
    "git stash -q; git commit -qam x; touch made-by-check; grep -q postdoc about.md";

  it("a mutating task check leaves the real tree byte-identical, and still sees the work", async () => {
    const ws = repo();
    try {
      const before = treeHash(ws.dir);
      const listed = treeListing(ws.dir);
      const check: Check = { name: "task:merged", kind: "command", run: MUTATOR, timeoutMs: 20_000, expectExit: 0, tags: ["task"], hidden: true };
      const ctx = { cwd: ws.dir, record: [], ledger: [], archivedBatches: 0 } as unknown as BarContext;
      const r = await runCheck(check, ctx);
      assert.equal(r.ok, true, r.output);
      assert.equal(r.ranInPlace, undefined, "the check got no copy");
      assert.equal(treeHash(ws.dir), before, `the check changed the real tree:\n${changed(listed, treeListing(ws.dir)).join("\n")}`);
      // And a check that only reads sees exactly the tree it judges.
      const read = await runCheck({ ...check, name: "task:reads", run: "git rev-parse --abbrev-ref HEAD | grep -qx master && grep -q student about.md && test -f docs/a.txt" }, ctx);
      assert.equal(read.ok, true, read.output);
      assert.ok(!r.output.includes("maat-check-"), "the copy's path never reaches the output");
    } finally {
      ws.cleanup();
    }
  });

  it("a mutating check tried before the work leaves the tree byte-identical too", async () => {
    const ws = repo();
    try {
      const before = treeHash(ws.dir);
      await preflightCriteria([{ name: "task:merged", kind: "command", run: MUTATOR, expectExit: 0 }], { cwd: ws.dir, timeoutMs: 20_000 });
      assert.equal(treeHash(ws.dir), before);
    } finally {
      ws.cleanup();
    }
  });

  it("a task check with no throwaway copy says it ran in place, in the result and the receipt", async () => {
    const ws = workspace();
    try {
      // A worktree's .git is a pointer file, which a copy cannot detach from.
      writeFileSync(join(ws.dir, ".git"), "gitdir: /nowhere/.git/worktrees/x\n");
      const ctx = { cwd: ws.dir, record: [], ledger: [], archivedBatches: 0 } as unknown as BarContext;
      const r = await runCheck({ name: "task:reads", kind: "command", run: "true", timeoutMs: 5_000, expectExit: 0, tags: ["task"] }, ctx);
      assert.equal(r.ok, true);
      assert.match(r.ranInPlace ?? "", /pointer file/);
      const receipts = new Receipts(ws.dir);
      const rec = receipts.write({ claim: "done", result: { ok: true, results: [r], durationMs: 1 } as unknown as BarResult, attempt: 0, verdict: "accepted", model: "m", provider: "p", sessionTokens: 0, shedBatches: 0 });
      assert.match(readFileSync(rec.path, "utf8"), /ran in place: no throwaway copy of the tree — .*pointer file/);
      const plain = await runCheck({ name: "build", kind: "command", run: "true", timeoutMs: 5_000, expectExit: 0, tags: [] }, ctx);
      assert.equal(plain.ranInPlace, undefined, "a project check is meant to run in place, and says nothing");
    } finally {
      ws.cleanup();
    }
  });

  it("a project's own done.yml check still runs in place", async () => {
    const ws = repo();
    try {
      const ctx = { cwd: ws.dir, record: [], ledger: [], archivedBatches: 0 } as unknown as BarContext;
      const r = await runCheck({ name: "build", kind: "command", run: "echo built > build.log", timeoutMs: 5_000, expectExit: 0, tags: [] }, ctx);
      assert.equal(r.ok, true);
      assert.ok(existsSync(join(ws.dir, "build.log")));
    } finally {
      ws.cleanup();
    }
  });

  it("the copy copies a small dependency folder, links a large one, and leaves Maat's records out", async () => {
    const ws = repo();
    try {
      mkdirSync(join(ws.dir, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(ws.dir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
      mkdirSync(join(ws.dir, "target"), { recursive: true });
      for (let i = 0; i < 5; i++) writeFileSync(join(ws.dir, "target", `o${i}`), "x");
      mkdirSync(join(ws.dir, ".maat", "receipts"), { recursive: true });
      writeFileSync(join(ws.dir, ".maat", "receipts", "0000-refused.md"), "x");
      const c = await copyTree(ws.dir, { linkOverFiles: 3 });
      assert.ok(c);
      try {
        // Small: a copy, so a write into it stays in the copy.
        assert.ok(!lstatSync(join(c.dir, "node_modules")).isSymbolicLink());
        writeFileSync(join(c.dir, "node_modules", "dep", "index.js"), "changed\n");
        assert.equal(readFileSync(join(ws.dir, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
        // Large: linked, and the copy says so.
        assert.ok(lstatSync(join(c.dir, "target")).isSymbolicLink());
        assert.deepEqual(c.linked, ["target"]);
        assert.ok(!existsSync(join(c.dir, ".maat")));
        assert.equal(readFileSync(join(c.dir, "about.md"), "utf8"), "# About\nI am a student.\n");
        assert.equal(execFileSync("git", ["log", "--oneline", "--all"], { cwd: c.dir }).toString().split("\n").filter(Boolean).length, 2);
      } finally {
        await c.cleanup();
      }
      assert.ok(!existsSync(c.dir), "cleaned up");
      assert.equal(await copyTree(ws.dir, { maxFiles: 2 }), null, "over the limit runs in place");
    } finally {
      ws.cleanup();
    }
  });

  it("the copy does not block the event loop", async () => {
    const ws = repo();
    try {
      for (let i = 0; i < 300; i++) writeFileSync(join(ws.dir, `f${i}.txt`), "x\n");
      let ticks = 0;
      const t = setInterval(() => ticks++, 0);
      const c = await copyTree(ws.dir);
      clearInterval(t);
      assert.ok(c);
      await c.cleanup();
      assert.ok(ticks > 0, "no timer ran while the tree was copied");
    } finally {
      ws.cleanup();
    }
  });
});
