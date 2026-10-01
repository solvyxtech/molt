/**
 * Missions: a sealed executable contract, a feature queue, milestones that
 * seal, and a runner with no model in it.
 *
 * The runner is driven with real engines against scripted providers, so what
 * is asserted is what a worker was actually held to and what the files on
 * disk say afterwards — never what the runner reported about itself.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import {
  assertionChecks,
  assertionNotes,
  contractSha,
  coverageGate,
  hasMission,
  loadMission,
  MISSION_DIR,
  MissionError,
  missionStatus,
  nextFeature,
  parseContract,
  parseFeatures,
  parsePlan,
  readLibrary,
  readState,
  renderContract,
  runAssertions,
  runMission,
  workerPrompt,
  writePlan,
  type Contract,
  type Feature,
  type Features,
} from "../src/mission.js";
import { cmdMission } from "../src/session-commands.js";
import { scriptedProvider, workspace, type ScriptedTurn } from "./helpers.js";

const CONTRACT = `
version: 1
assertions:
  - id: VAL-A-001
    title: a.txt exists
    run: test -f a.txt
  - id: VAL-A-002
    title: a.txt says hello
    run: grep -q hello a.txt
  - id: VAL-B-001
    title: b.txt exists
    run: test -f b.txt
  - id: VAL-UI-001
    title: looks tidy
    note: a person judges the layout
`;

const FEATURES = {
  version: 1,
  features: [
    { id: "F1", title: "make a", description: "write a.txt containing hello", milestone: "M1", fulfills: ["VAL-A-001", "VAL-A-002"] },
    { id: "F2", title: "make b", description: "write b.txt", milestone: "M2", after: ["F1"], fulfills: ["VAL-B-001", "VAL-UI-001"] },
  ],
};

function seed(dir: string, features: unknown = FEATURES, contract = CONTRACT): void {
  mkdirSync(join(dir, MISSION_DIR), { recursive: true });
  writeFileSync(join(dir, MISSION_DIR, "contract.yml"), contract);
  writeFileSync(join(dir, MISSION_DIR, "features.json"), JSON.stringify(features, null, 2));
  writeFileSync(join(dir, MISSION_DIR, "mission.md"), "Two files.\n");
}

function worker(dir: string, turns: ScriptedTurn[]): Engine {
  const provider = scriptedProvider(turns);
  return new Engine({
    baseUrl: "http://provider.test/v1",
    model: "m",
    cwd: dir,
    fetchFn: provider.fetchFn,
    bar: null,
    receipts: new Receipts(dir),
    stream: false,
    autonomy: "high",
  });
}

const writes = (path: string, content: string): ScriptedTurn[] => [
  { calls: [{ name: "write_file", args: { path, content } }] },
  { text: `wrote ${path}` },
];
const idle: ScriptedTurn[] = [{ text: "I looked around and did nothing." }];

describe("the contract", () => {
  it("parses ids, runs, notes and timeouts, and refuses what it cannot judge", () => {
    const c = parseContract(CONTRACT);
    assert.equal(c.assertions.length, 4);
    assert.deepEqual(c.assertions[0], { id: "VAL-A-001", title: "a.txt exists", run: "test -f a.txt" });
    assert.equal(c.assertions[3].note, "a person judges the layout");
    assert.throws(() => parseContract("version: 2\nassertions: []"), /version must be 1/);
    assert.throws(() => parseContract("version: 1\nassertions: []"), /non-empty/);
    assert.throws(() => parseContract("version: 1\nassertions:\n  - id: X\n    title: t"), /needs a run command or a note/);
    assert.throws(() => parseContract("version: 1\nassertions:\n  - id: X\n    run: a\n    note: b"), /either a run or a note/);
    assert.throws(() => parseContract("version: 1\nassertions:\n  - id: X\n    run: a\n  - id: X\n    run: b"), /appears twice/);
    assert.throws(() => parseContract("version: 1\nassertions:\n  - id: 'bad id'\n    run: a"), /needs an id/);
    assert.throws(() => parseContract(": not yaml: ["), /not valid YAML/);
    const t = parseContract("version: 1\nassertions:\n  - id: X\n    run: sleep 1\n    timeout: 30");
    assert.equal(t.assertions[0].timeoutMs, 30_000);
  });

  it("renders back to YAML that parses to the same thing", () => {
    const c = parseContract(CONTRACT);
    const again = parseContract(renderContract(c));
    assert.deepEqual(again, c);
    assert.match(renderContract(c), /^# What this mission must make true/);
  });

  it("becomes sealed task criteria, notes kept apart", () => {
    const c = parseContract(CONTRACT);
    const checks = assertionChecks(c, ["VAL-A-001", "VAL-UI-001", "nope"]);
    assert.deepEqual(checks, [
      { name: "VAL-A-001", kind: "command", run: "test -f a.txt", timeoutMs: 120_000, expectExit: 0, tags: ["mission"], hidden: true },
    ]);
    assert.deepEqual(assertionNotes(c, ["VAL-A-001", "VAL-UI-001"]), ["VAL-UI-001: a person judges the layout"]);
  });
});

describe("the feature list", () => {
  it("parses, defaults, and refuses duplicates", () => {
    const f = parseFeatures(JSON.stringify(FEATURES));
    assert.equal(f.features[0].status, "pending");
    assert.equal(f.features[0].attempts, 0);
    assert.deepEqual(f.features[0].after, []);
    assert.deepEqual(f.features[1].after, ["F1"]);
    assert.throws(() => parseFeatures("nope"), /not valid JSON/);
    assert.throws(() => parseFeatures('{"version":1,"features":[]}'), /non-empty/);
    assert.throws(() => parseFeatures('{"version":1,"features":[{"id":"F1"},{"id":"F1"}]}'), /appears twice/);
  });

  it("runs the first pending feature whose dependencies are done", () => {
    const f = parseFeatures(JSON.stringify(FEATURES));
    assert.equal(nextFeature(f)?.id, "F1");
    f.features[0].status = "done";
    assert.equal(nextFeature(f)?.id, "F2");
    f.features[0].status = "blocked";
    assert.equal(nextFeature(f), null, "F2 waits on a blocked F1");
    f.features[0].status = "cancelled";
    assert.equal(nextFeature(f)?.id, "F2", "a cancelled dependency does not hold anything up");
  });
});

describe("the coverage gate", () => {
  const c = parseContract(CONTRACT);
  const feats = (list: Partial<Feature>[]): Features =>
    parseFeatures(JSON.stringify({ version: 1, features: list }));

  it("passes a complete plan", () => {
    assert.deepEqual(coverageGate(c, parseFeatures(JSON.stringify(FEATURES))), []);
  });

  it("names every orphan, double claim, unknown id, note-only feature, missing dependency and cycle", () => {
    const problems = coverageGate(
      c,
      feats([
        { id: "F1", fulfills: ["VAL-A-001", "VAL-A-002", "VAL-B-001"], after: ["F2"] },
        { id: "F2", fulfills: ["VAL-A-001", "VAL-ZZ-999"], after: ["F1"] },
        { id: "F3", fulfills: ["VAL-UI-001"], after: ["F9"] },
      ]),
    );
    assert.deepEqual(problems, [
      "feature F2 fulfills VAL-ZZ-999, which is not in the contract",
      "feature F3 fulfills no runnable assertion — nothing could ever verify it",
      "feature F3 comes after F9, which does not exist",
      "assertion VAL-A-001 is claimed by F1 and F2 — exactly one feature must own it",
      "features depend on each other in a cycle: F1 → F2 → F1",
    ]);
    const orphan = coverageGate(c, feats([{ id: "F1", fulfills: ["VAL-A-001"] }]));
    assert.ok(orphan.includes("assertion VAL-A-002 is claimed by no feature"));
    assert.ok(orphan.includes("assertion VAL-B-001 is claimed by no feature"));
    assert.ok(!orphan.some((p) => p.includes("VAL-UI-001")), "an unclaimed note is not a problem");
  });

  it("ignores cancelled features except as dependencies", () => {
    const problems = coverageGate(
      c,
      feats([
        { id: "F1", fulfills: ["VAL-A-001", "VAL-A-002"] },
        { id: "F2", fulfills: ["VAL-B-001"], status: "cancelled" },
      ]),
    );
    assert.deepEqual(problems, ["assertion VAL-B-001 is claimed by no feature"]);
  });
});

describe("the worker's brief", () => {
  it("names the feature, its assertions verbatim, the read-only files, and the library", () => {
    const c = parseContract(CONTRACT);
    const f = parseFeatures(JSON.stringify(FEATURES));
    f.features[0].status = "done";
    const p = workerPrompt({
      goal: "Two files.",
      feature: f.features[1],
      contract: c,
      features: f,
      library: "--- lib ---\nrun make first",
      attempt: 2,
      maxAttempts: 3,
    });
    assert.match(p, /^F2 make b\n\nYou are one worker in a mission\. Do this feature and nothing else\./);
    assert.match(p, /Mission: Two files\./);
    assert.match(p, /Feature F2 \(milestone M2\): make b/);
    assert.match(p, /- VAL-B-001: b\.txt exists$/m);
    assert.doesNotMatch(p, /test -f b\.txt/, "the command is not shown to the worker");
    assert.match(p, /a check you can see is a check you can copy/);
    assert.match(p, /- VAL-UI-001 \(note, not checked\): a person judges the layout/);
    assert.match(p, /This is attempt 2 of 3\./);
    assert.match(p, /Already done by earlier workers: F1 make a\./);
    assert.match(p, /contract \(\.maat\/mission\/contract\.yml\) and the feature list are read-only/);
    assert.match(p, /run make first/);
  });
});

describe("the library", () => {
  it("shows every markdown file within the budget and says how many it left out", () => {
    const ws = workspace();
    try {
      assert.equal(readLibrary(ws.dir), "");
      mkdirSync(join(ws.dir, MISSION_DIR, "library"), { recursive: true });
      writeFileSync(join(ws.dir, MISSION_DIR, "library", "env.md"), "PORT=4000\n");
      writeFileSync(join(ws.dir, MISSION_DIR, "library", "traps.md"), "x".repeat(8000));
      writeFileSync(join(ws.dir, MISSION_DIR, "library", "notes.txt"), "ignored");
      const lib = readLibrary(ws.dir, 200);
      assert.match(lib, /--- \.maat\/mission\/library\/env\.md ---\nPORT=4000/);
      assert.match(lib, /1 more library file\(s\) not shown/);
      assert.doesNotMatch(lib, /xxxx/);
    } finally {
      ws.cleanup();
    }
  });
});

describe("running assertions directly", () => {
  it("reports pass, fail, and could-not-run separately", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "a.txt"), "hello\n");
      const c: Contract = {
        version: 1,
        assertions: [
          { id: "A", title: "a", run: "test -f a.txt" },
          { id: "B", title: "b", run: "test -f zzz.txt" },
          { id: "C", title: "c", run: "no-such-command-xyz --flag" },
          { id: "N", title: "n", note: "prose" },
        ],
      };
      const r = await runAssertions(c, ["A", "B", "C", "N"], ws.dir);
      assert.deepEqual(r.map((x) => [x.id, x.ok, x.didNotRun]), [["A", true, false], ["B", false, false], ["C", false, true]]);
    } finally {
      ws.cleanup();
    }
  });
});

describe("running a mission", () => {
  it("does each feature with a fresh worker held to its assertions, seals milestones, and records it all", async () => {
    const ws = workspace();
    try {
      seed(ws.dir);
      const made: string[] = [];
      const ends: string[] = [];
      const seals: string[] = [];
      const summary = await runMission({
        cwd: ws.dir,
        makeWorker: (f) => {
          made.push(f.id);
          return worker(ws.dir, f.id === "F1" ? writes("a.txt", "hello\n") : writes("b.txt", "b\n"));
        },
        events: {
          featureEnd: (f, h) => ends.push(`${f.id}:${h.outcome}:${h.failed.join("|")}`),
          milestone: (n, ok) => seals.push(`${n}:${ok}`),
        },
      });
      assert.deepEqual(made, ["F1", "F2"]);
      assert.deepEqual(ends, ["F1:verified:", "F2:verified:"]);
      assert.deepEqual(seals, ["M1:true", "M2:true"]);
      assert.equal(summary.stopped, "complete");
      assert.deepEqual(summary.done, ["F1", "F2"]);
      assert.deepEqual(summary.sealed, ["M1", "M2"]);

      const { features, state } = loadMission(ws.dir);
      assert.equal(features.features[0].status, "done");
      assert.equal(features.features[0].attempts, 1);
      assert.equal(features.features[0].receipts.length, 1, "the receipt is on the feature");
      assert.equal(state.contractSha, contractSha(ws.dir));
      assert.equal(state.assertions["VAL-A-001"].status, "passed");
      assert.equal(state.assertions["VAL-A-001"].feature, "F1");
      assert.equal(state.assertions["VAL-UI-001"].status, "untested", "a note is never passed");
      assert.equal(state.milestones.M1.sealed, true);
      assert.ok(state.log.some((l) => /mission started · 2 feature\(s\) · 4 assertion\(s\)/.test(l)));
      const handoff = JSON.parse(readFileSync(join(ws.dir, MISSION_DIR, "handoffs", "F1-1.json"), "utf8"));
      assert.equal(handoff.outcome, "verified");
      assert.match(handoff.claim, /wrote a\.txt/);
      assert.ok(handoff.receipt);
    } finally {
      ws.cleanup();
    }
  });

  it("a worker is held to exactly its feature's assertions, by id, and cannot touch the contract", async () => {
    const ws = workspace();
    try {
      seed(ws.dir);
      const provider = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: ".maat/mission/contract.yml", content: "version: 1\nassertions: []\n" } }] },
        ...writes("a.txt", "hello\n"),
      ]);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const seen: string[] = [];
      await runMission({
        cwd: ws.dir,
        maxRuns: 1,
        makeWorker: () => engine,
        events: {
          worker: (_f, ev) => {
            if (ev.kind === "proof_result") seen.push(...ev.result.results.map((r) => `${r.name}:${r.ok}`));
          },
        },
      });
      assert.deepEqual(seen, ["task:VAL-A-001:true", "task:VAL-A-002:true"], "F1's two assertions, and nothing of F2's");
      const reqs = provider.requests() as { messages: { role: string; content: string }[] }[];
      const first = reqs[reqs.length - 1].messages.find((m) => m.role === "tool");
      assert.match(String(first?.content), /READ-ONLY/i, "the contract write was refused");
      assert.equal(contractSha(ws.dir), readState(ws.dir).contractSha, "the contract is what it was");
    } finally {
      ws.cleanup();
    }
  });

  it("retries a feature that was not verified, then blocks it, and never runs what depends on it", async () => {
    const ws = workspace();
    try {
      seed(ws.dir);
      const made: string[] = [];
      const summary = await runMission({
        cwd: ws.dir,
        maxAttempts: 2,
        makeWorker: (f) => {
          made.push(f.id);
          return worker(ws.dir, idle);
        },
      });
      assert.deepEqual(made, ["F1", "F1"]);
      assert.equal(summary.stopped, "nothing runnable");
      assert.deepEqual(summary.blocked, ["F1"]);
      assert.deepEqual(summary.pending, ["F2"]);
      const { features, state } = loadMission(ws.dir);
      assert.equal(features.features[0].status, "blocked");
      assert.equal(features.features[0].attempts, 2);
      assert.match(features.features[0].note ?? "", /^blocked after 2 attempt\(s\): /);
      assert.equal(state.assertions["VAL-A-001"].status, "failed");
      assert.ok(existsSync(join(ws.dir, MISSION_DIR, "handoffs", "F1-2.json")));
      assert.deepEqual(state.milestones, {}, "nothing sealed");
    } finally {
      ws.cleanup();
    }
  });

  it("a milestone that fails to seal reopens the feature whose assertion regressed", async () => {
    const ws = workspace();
    try {
      // F2's worker satisfies its own assertion and deletes F1's file: each
      // worker passes alone, and the milestone seal is what catches it.
      seed(ws.dir, {
        version: 1,
        features: [
          { id: "F1", title: "make a", milestone: "M1", fulfills: ["VAL-A-001", "VAL-A-002"] },
          { id: "F2", title: "make b", milestone: "M1", fulfills: ["VAL-B-001", "VAL-UI-001"] },
        ],
      });
      const made: string[] = [];
      const summary = await runMission({
        cwd: ws.dir,
        maxAttempts: 3,
        maxRuns: 3,
        makeWorker: (f) => {
          made.push(f.id);
          if (f.id === "F1") return worker(ws.dir, writes("a.txt", "hello\n"));
          return worker(ws.dir, [
            { calls: [{ name: "bash", args: { command: "rm a.txt" } }] },
            ...writes("b.txt", "b\n"),
          ]);
        },
      });
      // F1, F2 (seal fails, F1 reopened), F1 again (seal passes).
      assert.deepEqual(made, ["F1", "F2", "F1"]);
      assert.equal(summary.stopped, "complete");
      assert.deepEqual(summary.sealed, ["M1"]);
      const { features, state } = loadMission(ws.dir);
      assert.equal(features.features[0].attempts, 2);
      assert.equal(features.features[0].status, "done");
      assert.equal(state.milestones.M1.sealed, true);
      assert.ok(state.log.some((l) => /milestone M1 not sealed: VAL-A-001, VAL-A-002 failed together — reopened 1 feature\(s\)/.test(l)));
      const reopened = JSON.parse(readFileSync(join(ws.dir, MISSION_DIR, "handoffs", "F1-2.json"), "utf8"));
      assert.equal(reopened.attempt, 2);
    } finally {
      ws.cleanup();
    }
  });

  it("refuses to start on a plan with coverage problems, and to continue on a contract that moved", async () => {
    const ws = workspace();
    try {
      seed(ws.dir, { version: 1, features: [{ id: "F1", fulfills: ["VAL-A-001"] }] });
      await assert.rejects(
        runMission({ cwd: ws.dir, makeWorker: () => worker(ws.dir, idle) }),
        (e: Error) => e instanceof MissionError && /cannot start:\n- assertion VAL-A-002 is claimed by no feature/.test(e.message),
      );
      seed(ws.dir);
      await runMission({ cwd: ws.dir, maxRuns: 1, makeWorker: () => worker(ws.dir, writes("a.txt", "hello\n")) });
      writeFileSync(join(ws.dir, MISSION_DIR, "contract.yml"), CONTRACT + "  - id: VAL-NEW\n    run: 'true'\n");
      await assert.rejects(
        runMission({ cwd: ws.dir, makeWorker: () => worker(ws.dir, idle) }),
        /contract\.yml has changed since the mission started/,
      );
    } finally {
      ws.cleanup();
    }
  });

  it("resumes from the files: a second run picks up where the first stopped", async () => {
    const ws = workspace();
    try {
      seed(ws.dir);
      const first = await runMission({ cwd: ws.dir, maxRuns: 1, makeWorker: () => worker(ws.dir, writes("a.txt", "hello\n")) });
      assert.equal(first.stopped, "max runs");
      assert.deepEqual(first.done, ["F1"]);
      const made: string[] = [];
      const second = await runMission({
        cwd: ws.dir,
        makeWorker: (f) => {
          made.push(f.id);
          return worker(ws.dir, writes("b.txt", "b\n"));
        },
      });
      assert.deepEqual(made, ["F2"]);
      assert.equal(second.stopped, "complete");
    } finally {
      ws.cleanup();
    }
  });
});

describe("status", () => {
  it("says there is no mission, then where one stands, on both surfaces", async () => {
    const ws = workspace();
    try {
      assert.equal(hasMission(ws.dir), false);
      assert.match(missionStatus(ws.dir), /^no mission in \.maat\/mission/);
      seed(ws.dir);
      const before = missionStatus(ws.dir);
      assert.match(before, /^Two files\.\n2 feature\(s\): 0 done · 2 pending · 0 blocked\n  M1: 0\/1\n    \[ \] F1 make a\n  M2: 0\/1\n    \[ \] F2 make b\n4 assertion\(s\), 3 runnable, 0 passed\ncontract not yet sealed\nnext: F1 make a$/);
      await runMission({ cwd: ws.dir, maxRuns: 1, makeWorker: () => worker(ws.dir, writes("a.txt", "hello\n")) });
      const after = missionStatus(ws.dir);
      assert.match(after, /1 done · 1 pending/);
      assert.match(after, /M1: sealed\n    \[x\] F1 make a/);
      assert.match(after, /2 passed/);
      assert.match(after, /contract sealed [0-9a-f]{12}\nnext: F2 make b$/);
      const eng = worker(ws.dir, idle);
      assert.equal(cmdMission(eng, "").text, after, "/mission is the same text on both surfaces");
      writeFileSync(join(ws.dir, MISSION_DIR, "contract.yml"), CONTRACT + "\n# moved\n");
      assert.match(missionStatus(ws.dir), /contract sealed [0-9a-f]{12} — MOVED since/);
    } finally {
      ws.cleanup();
    }
  });
});

describe("planning", () => {
  it("parses a plan out of a fenced reply and reports its coverage problems", () => {
    const reply = "Here you go:\n```json\n" + JSON.stringify({
      mission: "Two files.",
      assertions: [
        { id: "VAL-A-001", title: "a", run: "test -f a.txt" },
        { id: "VAL-B-001", title: "b", run: "test -f b.txt" },
      ],
      features: [{ id: "F1", title: "a", description: "make a", milestone: "M1", fulfills: ["VAL-A-001"] }],
    }) + "\n```";
    const r = parsePlan(reply);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.plan.mission, "Two files.");
    assert.equal(r.plan.contract.assertions.length, 2);
    assert.deepEqual(coverageGate(r.plan.contract, r.plan.features), ["assertion VAL-B-001 is claimed by no feature"]);
  });

  it("says why a reply is not a plan", () => {
    const prose = parsePlan("I would start with the database.");
    assert.equal(prose.ok, false);
    assert.match(prose.ok ? "" : prose.error, /the plan reply was not JSON/);
    const cut = parsePlan('{"mission":"x","assertions":[{"id":"A","run":"tr', true);
    assert.match(cut.ok ? "" : cut.error, /cut off at the token limit/);
    const shape = parsePlan('{"mission":"x","assertions":[],"features":[]}');
    assert.match(shape.ok ? "" : shape.error, /JSON but not a mission: contract\.yml: assertions must be a non-empty list/);
  });

  it("writes the files once, and again only with force", () => {
    const ws = workspace();
    try {
      const r = parsePlan(JSON.stringify({
        mission: "Two files.",
        assertions: [{ id: "VAL-A-001", title: "a", run: "test -f a.txt" }],
        features: [{ id: "F1", title: "a", description: "make a", milestone: "M1", fulfills: ["VAL-A-001"] }],
      }));
      assert.ok(r.ok);
      if (!r.ok) return;
      const written = writePlan(ws.dir, r.plan);
      assert.deepEqual(written, [".maat/mission/mission.md", ".maat/mission/contract.yml", ".maat/mission/features.json"]);
      assert.ok(existsSync(join(ws.dir, MISSION_DIR, "library")));
      const loaded = loadMission(ws.dir);
      assert.equal(loaded.goal, "Two files.");
      assert.equal(loaded.contract.assertions[0].run, "test -f a.txt");
      assert.throws(() => writePlan(ws.dir, r.plan), /already exists .* --force/);
      writeFileSync(join(ws.dir, MISSION_DIR, "state.json"), JSON.stringify({ version: 1, contractSha: "old", assertions: {}, milestones: {}, log: [] }));
      const forced = writePlan(ws.dir, r.plan, { force: true });
      assert.ok(forced.includes(".maat/mission/state.json (reset)"));
      assert.equal(readState(ws.dir).contractSha, null);
    } finally {
      ws.cleanup();
    }
  });
});
