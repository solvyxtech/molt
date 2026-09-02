/**
 * Closing the loop: the clock, the keep, the discard, and the pins.
 *
 * molt could always tell a verified turn from an unverified one. What it did
 * with the answer was nothing — both left the same dirty tree, and telling
 * them apart afterwards meant reading a receipt and remembering which files
 * it named. These are the tests for the half that acts on the verdict, plus
 * the two limits that decide when the verdict gets taken: a wall clock, and a
 * set of files the model is not allowed to touch.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { clipEnds, formatBarFailure, loadBar, parseBar, runBar } from "../src/bar.js";
import { keyForUrl } from "../src/providers.js";
import { defaultMapTokens } from "../src/cli.js";
import { DEFAULT_MAP_TOKENS } from "../src/repomap.js";
import { deletesOnlyCreated, gate } from "../src/autonomy.js";
import type { BarContext } from "../src/bar.js";
import type { LedgerEntry } from "../src/types.js";
import { Engine, readOnlyRefusal, SYSTEM_PROMPT } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import { Receipts } from "../src/receipts.js";
import { MOLT_TRAILER } from "../src/git.js";
import { sha256FileSync } from "../src/integrity.js";
import {
  cmdCommit,
  cmdFor,
  cmdRead,
  cmdRevert,
  cmdUndo,
  fmtDuration,
  parseDuration,
  parseToggle,
} from "../src/session-commands.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";
import type { EngineEvent } from "../src/types.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

function ws(): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

function writeBar(dir: string, yaml: string): void {
  mkdirSync(join(dir, ".molt"), { recursive: true });
  writeFileSync(join(dir, ".molt", "done.yml"), yaml, "utf8");
}

const LANDED = "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n";
const NEVER =
  "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n" +
  '  - name: suite\n    run: "false"\n';

function gitRepo(dir: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "molt test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "seed.txt"), "seed\n", "utf8");
  git("add", "seed.txt");
  git("commit", "-q", "-m", "seed");
}

/** A model that writes a file and then says it is done. */
function writerProvider(path = "r.txt", content = "the change\n") {
  return scriptedProvider([
    { calls: [{ name: "write_file", args: { path, content } }] },
    { text: `Done — I changed ${path}.` },
  ]);
}

type EngineExtras = ConstructorParameters<typeof Engine>[0];
function engineFor(dir: string, fetchFn: typeof fetch, extra: Partial<EngineExtras> = {}): Engine {
  return new Engine({
    baseUrl: "http://mock/v1",
    model: "test-model",
    cwd: dir,
    fetchFn,
    bar: loadBar(dir),
    archive: new Archive(dir),
    receipts: new Receipts(dir),
    ...extra,
  });
}

const infoText = (events: EngineEvent[]): string =>
  events.filter((e) => e.kind === "info").map((e) => (e as { text: string }).text).join("\n");

describe("the wall clock", () => {
  it("stops the turn on time and records that the clock, not a failure, ended it", async () => {
    const dir = ws();
    writeBar(dir, LANDED);
    const journal = new Journal(dir, "clock-1");
    const engine = engineFor(dir, writerProvider().fetchFn, {
      journal,
      // Already spent before the first request: the ceiling is checked where
      // the token and money ceilings are, at the top of the step loop.
      turnDeadlineMs: 1,
    });

    const events = await drain(engine.run("do the thing", allowAll));

    assert.match(infoText(events), /time budget reached/);
    const rows = Journal.read(journal.path).filter((e) => e.kind === "deadline");
    assert.equal(rows.length, 1, "a turn stopped by the clock left no record of why");
    assert.equal(rows[0]!.data.limitMs, 1);
    // Nothing was written, so nothing can have been verified.
    assert.equal(engine.getLedger().length, 0);
  });

  it("does not interfere when there is no budget", async () => {
    const dir = ws();
    writeBar(dir, LANDED);
    const engine = engineFor(dir, writerProvider().fetchFn);
    const events = await drain(engine.run("do the thing", allowAll));
    assert.ok(!infoText(events).includes("time budget"));
    assert.equal(readFileSync(join(dir, "r.txt"), "utf8"), "the change\n");
  });

  it("reads the durations people type", () => {
    assert.equal(parseDuration("5m"), 300_000);
    assert.equal(parseDuration("90s"), 90_000);
    assert.equal(parseDuration("1h"), 3_600_000);
    assert.equal(parseDuration("250ms"), 250);
    // A bare number is seconds. Reading it as milliseconds would stop every
    // turn instantly and look like a broken program rather than a wrong unit.
    assert.equal(parseDuration("300"), 300_000);
    assert.equal(parseDuration("off"), null);
    assert.equal(parseDuration("soon"), null);
    assert.equal(fmtDuration(300_000), "5m");
    assert.equal(fmtDuration(90_000), "1.5m");
    assert.equal(fmtDuration(45_000), "45s");
    // "(0s of 0s)" reads as a broken program rather than a very small limit.
    assert.equal(fmtDuration(1), "1ms");
  });
});

describe("keeping what the bar verified", () => {
  it("commits the turn's files, with the receipt named in the message", async () => {
    const dir = ws();
    gitRepo(dir);
    writeBar(dir, LANDED);
    const engine = engineFor(dir, writerProvider().fetchFn, { git: { commitOnPass: true } });

    const events = await drain(engine.run("add the file", allowAll));
    assert.ok(events.some((e) => e.kind === "proof_result"), "the bar did not pass");

    const subject = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim();
    const body = execFileSync("git", ["log", "-1", "--format=%b"], { cwd: dir, encoding: "utf8" });
    const files = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    assert.equal(subject, "add the file");
    assert.match(body, new RegExp(`^${MOLT_TRAILER}: \\d{4}-accepted\\.md$`, "m"));
    assert.equal(files, "r.txt");
    assert.match(infoText(events), /committed [0-9a-f]{8}/);
  });

  it("commits nothing when the policy is off", async () => {
    const dir = ws();
    gitRepo(dir);
    writeBar(dir, LANDED);
    const engine = engineFor(dir, writerProvider().fetchFn);
    await drain(engine.run("add the file", allowAll));
    const subject = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(subject, "seed", "committed without being asked to");
  });

  it("says so instead of failing when there is no repository to commit to", async () => {
    const dir = ws();
    writeBar(dir, LANDED);
    const engine = engineFor(dir, writerProvider().fetchFn, { git: { commitOnPass: true } });
    const events = await drain(engine.run("add the file", allowAll));
    assert.match(infoText(events), /not a git repository/);
    assert.equal(readFileSync(join(dir, "r.txt"), "utf8"), "the change\n");
  });
});

describe("discarding what the bar refused", () => {
  it("removes a file the failed turn created, and keeps the evidence", async () => {
    const dir = ws();
    gitRepo(dir);
    writeBar(dir, NEVER);
    const journal = new Journal(dir, "revert-1");
    const engine = engineFor(dir, writerProvider().fetchFn, {
      journal,
      maxProofAttempts: 1,
      git: { restoreOnFail: true },
    });

    const events = await drain(engine.run("add the file", allowAll));

    assert.ok(events.some((e) => e.kind === "proof_exhausted"), "the bar was supposed to fail");
    assert.equal(existsSync(join(dir, "r.txt")), false, "an unverified file was left on disk");
    assert.match(infoText(events), /back where the turn found it/);
    // Undoing the work must never undo the record of it.
    assert.ok(events.some((e) => e.kind === "receipt"), "no receipt was written");
    assert.equal(
      Journal.read(journal.path).filter((e) => e.kind === "git_restore").length,
      1,
    );
  });

  it("puts an edited file back the way the user had it, not the way HEAD has it", async () => {
    const dir = ws();
    gitRepo(dir);
    writeBar(dir, NEVER);
    // The user's own uncommitted edit, made before the turn started.
    writeFileSync(join(dir, "seed.txt"), "seed\nthe user was here\n", "utf8");

    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "seed.txt", content: "what the model did\n" } }] },
      { text: "Done." },
    ]);
    const engine = engineFor(dir, provider.fetchFn, {
      maxProofAttempts: 1,
      git: { restoreOnFail: true },
    });

    await drain(engine.run("change the seed", allowAll));

    assert.equal(
      readFileSync(join(dir, "seed.txt"), "utf8"),
      "seed\nthe user was here\n",
      "the revert threw away the user's uncommitted work",
    );
  });

  it("leaves the tree alone when the policy is off", async () => {
    const dir = ws();
    gitRepo(dir);
    writeBar(dir, NEVER);
    const engine = engineFor(dir, writerProvider().fetchFn, { maxProofAttempts: 1 });
    await drain(engine.run("add the file", allowAll));
    assert.equal(readFileSync(join(dir, "r.txt"), "utf8"), "the change\n");
  });
});

describe("files the model may read and may not write", () => {
  it("refuses the write and leaves the file exactly as it was", async () => {
    const dir = ws();
    writeBar(dir, LANDED);
    writeFileSync(join(dir, "locked.md"), "the specification\n", "utf8");
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "locked.md", content: "rewritten\n" } }] },
      { calls: [{ name: "edit_file", args: { path: "locked.md", old_text: "the", new_text: "a" } }] },
      { text: "I could not change it." },
    ]);
    const engine = engineFor(dir, provider.fetchFn, { readOnly: ["locked.md"] });

    await drain(engine.run("rewrite the spec", allowAll));

    assert.equal(readFileSync(join(dir, "locked.md"), "utf8"), "the specification\n");
    // Not in the ledger either: a refused write is not work, and a bar that
    // counted it would be verifying a change that never happened.
    assert.deepEqual(engine.getLedger().map((e) => e.path), []);
  });

  it("tells the model, in the part of the prompt that is cached", async () => {
    const dir = ws();
    writeBar(dir, LANDED);
    const engine = engineFor(dir, writerProvider().fetchFn, { readOnly: ["spec.md"] });
    const system = engine.getRecord()[0];
    assert.equal(system?.role, "system");
    assert.match(String(system?.content), /READ-ONLY/);
    assert.match(String(system?.content), /spec\.md/);
  });

  it("names the pin rather than the file system when it refuses", () => {
    const text = readOnlyRefusal("spec.md");
    assert.match(text, /pinned read-only/);
    assert.match(text, /Do not work around this/);
  });

  it("pins and releases through the command both surfaces call", async () => {
    const dir = ws();
    writeBar(dir, LANDED);
    const engine = engineFor(dir, writerProvider().fetchFn);
    assert.match(cmdRead(engine, "").text, /no read-only files/);
    assert.match(cmdRead(engine, "a.md b.md").text, /a\.md, b\.md/);
    assert.deepEqual(engine.readOnly, ["a.md", "b.md"]);
    assert.match(cmdRead(engine, "").text, /read-only \(2\)/);
    assert.match(cmdRead(engine, "clear").text, /released 2/);
    assert.deepEqual(engine.readOnly, []);
  });
});

describe("the commands that drive all of this", () => {
  it("toggles the two policies and reports what they are", () => {
    const dir = ws();
    writeBar(dir, LANDED);
    const engine = engineFor(dir, writerProvider().fetchFn);
    assert.equal(engine.gitPolicy.commitOnPass, undefined);
    assert.match(cmdCommit(engine, "on").text, /commit on pass: on/);
    assert.equal(engine.gitPolicy.commitOnPass, true);
    assert.match(cmdCommit(engine, "").text, /commit on pass: on/);
    assert.match(cmdRevert(engine, "on").text, /revert on fail: on/);
    assert.equal(engine.gitPolicy.restoreOnFail, true);
    // One toggle must not clear the other.
    assert.equal(engine.gitPolicy.commitOnPass, true);
    assert.match(cmdRevert(engine, "off").text, /revert on fail: off/);
    assert.equal(engine.gitPolicy.commitOnPass, true);
    assert.equal(parseToggle("yes"), true);
    assert.equal(parseToggle("maybe"), null);
  });

  it("sets and clears the turn clock", () => {
    const dir = ws();
    writeBar(dir, LANDED);
    const engine = engineFor(dir, writerProvider().fetchFn);
    assert.match(cmdFor(engine, "").text, /no time budget/);
    assert.match(cmdFor(engine, "5m").text, /5m/);
    assert.equal(engine.turnDeadlineMs, 300_000);
    assert.match(cmdFor(engine, "").text, /time budget 5m/);
    assert.match(cmdFor(engine, "off").text, /off/);
    assert.equal(engine.turnDeadlineMs, 0);
    assert.equal(cmdFor(engine, "soonish").kind, "error");
  });

  it("refuses to undo where there is nothing of molt's to undo", async () => {
    const dir = ws();
    writeBar(dir, LANDED);
    const engine = engineFor(dir, writerProvider().fetchFn);
    const r = await cmdUndo(engine);
    assert.equal(r.kind, "error");
    assert.match(r.text, /not a git repository/);
  });
});

/**
 * What a weak model does that a strong one does not, and what molt did with
 * it. All three of these come from one local run: a qwen3-coder-30b that
 * wrote the right code, then lost the turn to molt's own bookkeeping.
 */
describe("a scratch file is not a failed claim", () => {
  function barCtx(dir: string, ledger: LedgerEntry[]): BarContext {
    return { cwd: dir, record: [], ledger, archivedBatches: 0 };
  }
  const landedBar = parseBar("version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");

  it("passes when a file the turn created was tidied away and the real work stands", async () => {
    const dir = ws();
    writeFileSync(join(dir, "real.ts"), "export const x = 1;\n", "utf8");
    const r = await runBar(
      landedBar,
      barCtx(dir, [
        // Created, and gone again: `mv test-duration.js test-duration.cjs`.
        { path: "test-duration.js", before: null, after: "aaa", callId: "c1", substance: 1 },
        { path: "real.ts", before: null, after: sha256FileSync(join(dir, "real.ts")), callId: "c2", substance: 1 },
      ]),
    );
    assert.equal(r.ok, true, r.results[0]?.output);
    // Named, never hidden: the receipt still shows what was created and removed.
    assert.match(r.results[0].output, /scratch file\(s\) created and tidied away: test-duration\.js/);
  });

  it("still fails when every write was a scratch file", async () => {
    const dir = ws();
    const r = await runBar(
      landedBar,
      barCtx(dir, [{ path: "scratch.js", before: null, after: "aaa", callId: "c1", substance: 1 }]),
    );
    assert.equal(r.ok, false, "cleaning up after yourself is not the task being done");
    assert.match(r.results[0].output, /Nothing this turn wrote is still on disk/);
  });

  it("still fails when a file that already existed is gone", async () => {
    // Not a scratch file: work being destroyed. The exception must not reach it.
    const dir = ws();
    const r = await runBar(
      landedBar,
      barCtx(dir, [{ path: "was-here.ts", before: "old", after: "new", callId: "c1", substance: 1 }]),
    );
    assert.equal(r.ok, false);
    assert.match(r.results[0].output, /no longer on disk/);
  });
});

describe("the gate lets a model tidy up after itself", () => {
  const cwd = "/tmp/project";
  const created = new Set(["scratch.js", "sub/tmp.txt"]);

  it("allows rm of a file this session created, at high autonomy", () => {
    assert.equal(deletesOnlyCreated("rm scratch.js", created, cwd), true);
    assert.equal(deletesOnlyCreated("rm -f scratch.js sub/tmp.txt", created, cwd), true);
    assert.equal(gate("high", { name: "bash", args: { command: "rm scratch.js" }, cwd, created }).ask, false);
  });

  it("refuses everything else exactly as before", () => {
    // Not created by this session — someone's work.
    assert.equal(deletesOnlyCreated("rm src/engine.ts", created, cwd), false);
    // A second command riding along.
    assert.equal(deletesOnlyCreated("rm scratch.js && rm -rf /", created, cwd), false);
    // A glob is not a path anyone can check.
    assert.equal(deletesOnlyCreated("rm *.js", created, cwd), false);
    assert.equal(deletesOnlyCreated("rm -rf .", created, cwd), false);
    assert.equal(deletesOnlyCreated("shred scratch.js", created, cwd), false);
    // And with no exception in play, the prompt happens as it always did.
    assert.equal(gate("high", { name: "bash", args: { command: "rm src/engine.ts" }, cwd, created }).ask, true);
    assert.equal(gate("high", { name: "bash", args: { command: "rm scratch.js" }, cwd }).ask, true);
  });
});

describe("the failure a model should read first", () => {
  it("puts the project's own output above molt's bookkeeping", () => {
    const result = {
      ok: false,
      durationMs: 1,
      results: [
        { name: "work-landed", kind: "builtin" as const, ok: false, output: "a file is gone", detail: "builtin files-changed" },
        { name: "tests", kind: "command" as const, ok: false, output: "1 failing", detail: "npm test", exitCode: 1 },
      ],
    };
    const text = formatBarFailure(result as never, 2, 2);
    assert.ok(
      text.indexOf("FAILED: tests") < text.indexOf("FAILED: work-landed"),
      "a red suite must not sit below a bookkeeping complaint",
    );
    assert.match(text, /Start with `tests`/);
  });

  it("says nothing extra when only one kind failed", () => {
    const result = {
      ok: false,
      durationMs: 1,
      results: [{ name: "tests", kind: "command" as const, ok: false, output: "1 failing", detail: "npm test", exitCode: 1 }],
    };
    assert.doesNotMatch(formatBarFailure(result as never, 1, 2), /Start with/);
  });
});

describe("a vanished file the claim names is not scratch", () => {
  it("fails even when other work landed, because the claim rests on it", async () => {
    // The reverted-work case the scratch exception must not swallow: real
    // work disappears, the model says it is there, and a project that never
    // wired up `claims-grounded` would otherwise hear nothing about it.
    const dir = ws();
    writeFileSync(join(dir, "kept.ts"), "export const x = 1;\n", "utf8");
    const bar = parseBar("version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    const r = await runBar(bar, {
      cwd: dir,
      record: [],
      archivedBatches: 0,
      claim: "Done — the fix is in `src/fix.ts`.",
      ledger: [
        { path: "src/fix.ts", before: null, after: "aaa", callId: "c1", substance: 1 },
        { path: "kept.ts", before: null, after: sha256FileSync(join(dir, "kept.ts")), callId: "c2", substance: 1 },
      ],
    });
    assert.equal(r.ok, false, "a claimed file that is gone must still fail");
    assert.match(r.results[0].output, /src\/fix\.ts.*no longer on disk/);
  });
});

describe("the model must be shown the part that failed", () => {
  it("keeps the end of a long output, where every runner puts its verdict", () => {
    // The defect, verbatim: `npm test` emits ninety kilobytes of ✔ before it
    // says what broke. Keeping the head handed a model 2000 bytes of passing
    // tests and threw away the assertion it had to fix.
    const suite = [
      "> molt-desktop@0.1.0 test",
      ...Array.from({ length: 3000 }, (_, i) => `  ✔ a passing test number ${i} (0.1ms)`),
      "ℹ tests 3001",
      "ℹ fail 1",
      "✖ failing tests:",
      "AssertionError: expected '2h 00m' to equal '120m 00s'",
    ].join("\n");

    const clipped = clipEnds(suite, 2000);
    assert.ok(Buffer.byteLength(clipped, "utf8") <= 2400, "budget blown");
    assert.match(clipped, /AssertionError: expected '2h 00m'/, "the failure was thrown away again");
    assert.match(clipped, /✖ failing tests:/);
    // The head survives too: which command ran is context worth keeping.
    assert.match(clipped, /> molt-desktop@0\.1\.0 test/);
    assert.match(clipped, /line\(s\) cut from the middle/);
  });

  it("leaves a short output exactly as it is", () => {
    assert.equal(clipEnds("one\ntwo\nthree", 2000), "one\ntwo\nthree");
  });

  it("cuts on line boundaries, so no character is split in half", () => {
    const text = Array.from({ length: 400 }, (_, i) => `${i} — a line with a multi-byte character`).join("\n");
    const clipped = clipEnds(text, 500);
    assert.ok(!clipped.includes("�"), "a byte slice split a character");
  });
});

describe("a key is found for the endpoint you asked for", () => {
  it("uses the stored key for the requested URL, not the stored URL", () => {
    // `molt run --url https://api.x.ai/v1` returned 401 on a machine with a
    // working xai key, because storedEndpoint() only surfaces a key when
    // config.json's own baseUrl matches a provider — and it was pointed at a
    // local llama.cpp. The window never had this bug.
    const auth = { xai: "xai-key", anthropic: "ant-key" };
    assert.equal(keyForUrl("https://api.x.ai/v1", undefined, auth), "xai-key");
    assert.equal(keyForUrl("https://api.anthropic.com/v1", undefined, auth), "ant-key");
    // A typed key outranks a stored one: that is what typing it is for.
    assert.equal(keyForUrl("https://api.x.ai/v1", "typed", auth), "typed");
    // A self-hosted endpoint has no provider and needs no key.
    assert.equal(keyForUrl("http://127.0.0.1:8080/v1", undefined, auth), undefined);
  });
});

describe("the repo map default follows who is hosting the model", () => {
  it("is on for a provider and off for a local endpoint", () => {
    // Measured, not assumed: 3/3 paired wins against grok-4.6, 0/2 against
    // two local models, where a 20B handed a 41-file map made 25 greps and
    // never edited anything.
    assert.equal(defaultMapTokens("https://api.x.ai/v1"), DEFAULT_MAP_TOKENS);
    assert.equal(defaultMapTokens("https://api.anthropic.com/v1"), DEFAULT_MAP_TOKENS);
    assert.equal(defaultMapTokens("http://127.0.0.1:8080/v1"), 0);
    assert.equal(defaultMapTokens("http://192.168.0.218:8080/v1"), 0);
  });
});

describe("the prompt says what to do when behaviour changes", () => {
  it("tells the model to reconcile the tests that pinned the old behaviour", () => {
    // The failure this exists for, observed rather than imagined: a local 30B
    // implemented `fmtDuration` correctly, was shown the contradicting
    // assertion thirty-two times across nineteen bash runs, and answered by
    // ADDING an assertion for the new behaviour while leaving the old one in
    // place. It was never short of information. It was short of the rule.
    assert.match(SYSTEM_PROMPT, /tests that pinned the old behaviour/);
    assert.match(SYSTEM_PROMPT, /does not retire the old one/);
  });
});
