/**
 * The reference check (src/reference.ts): two independent references and
 * Maat's own driver, built from the task text and the project as it was
 * before the work, joining the sealed checks at a claim.
 *
 * One reference alone refused 29 of 70 correct local solutions — its own bugs
 * (a Sunday off by one, a server's state) and behaviour the task never
 * decided. A second reviewer who never sees the first's code, and a driver
 * that judges only inputs where both agree, is what makes it safe to obey.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { draftReference, fencedPython, parseReferenceReply, referenceComparedAll, REFERENCE_MAX_SNAPSHOT_FILES, snapshotProject } from "../src/reference.js";
import type { Check } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

/** The first writer's module: doubles of 1..5, the deliverable run as `python3 double.py n`. */
const moduleA = (reference = "str(2 * n)", runDeliverable?: string) => [
  "import subprocess, sys",
  'INPUT_FORMAT = "an integer n"',
  'OUTPUT_FORMAT = "what double.py prints, stripped"',
  "INPUTS = [1, 2, 3, 4, 5]",
  "def reference(n):",
  `    return ${reference}`,
  "def run_deliverable(n):",
  runDeliverable ??
    [
      "    try:",
      "        r = subprocess.run([sys.executable, 'double.py', str(n)], capture_output=True, text=True, timeout=10)",
      "        return r.stdout.strip() if r.returncode == 0 else 'failed: ' + r.stderr.strip()[-80:]",
      "    except Exception as e:",
      "        return 'failed: %s' % e",
    ].join("\n"),
].join("\n");

const fenced = (program: string) => `{"applies": true, "reason": "computable"}\n\`\`\`python\n${program}\n\`\`\`\n`;
const secondModule = (body: string) => `\`\`\`python\ndef reference(n):\n    return ${body}\n\`\`\``;

/** A provider answering the first writer and the second reviewer from their own scripts. */
function writers(first: string[], second: string[]): { fetchFn: typeof fetch; firstPrompts: string[]; secondPrompts: string[] } {
  const firstPrompts: string[] = [];
  const secondPrompts: string[] = [];
  const fetchFn = (async (_u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const isSecond = /independently compute the right answers/.test(body.messages[0]!.content);
    const list = isSecond ? secondPrompts : firstPrompts;
    list.push(body.messages[1]!.content);
    const script = isSecond ? second : first;
    const content = script[Math.min(list.length - 1, script.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, firstPrompts, secondPrompts };
}

const ask = { baseUrl: "http://provider.test/v1", model: "m" };

describe("snapshotProject", () => {
  it("copies the project outside it, without Maat's folder, .git or node_modules", () => {
    const w = workspace();
    try {
      writeFileSync(join(w.dir, "a.txt"), "a\n");
      for (const d of [".maat", ".git", "node_modules"]) {
        mkdirSync(join(w.dir, d));
        writeFileSync(join(w.dir, d, "x"), "x");
      }
      const s = snapshotProject(w.dir);
      assert.ok(s);
      assert.equal(s.files, 1);
      for (const d of [".maat", ".git", "node_modules"]) assert.equal(existsSync(join(s.dir, "before", d)), false);
      assert.ok(!s.dir.startsWith(w.dir), "the snapshot never lives inside the project");
    } finally {
      w.cleanup();
    }
  });

  it("declines a project too large to copy quickly", () => {
    const w = workspace();
    try {
      for (let i = 0; i <= REFERENCE_MAX_SNAPSHOT_FILES; i++) writeFileSync(join(w.dir, `f${i}`), "");
      assert.equal(snapshotProject(w.dir), null);
    } finally {
      w.cleanup();
    }
  });
});

describe("referenceComparedAll", () => {
  it("needs the driver's last line to say every judged input was compared", () => {
    assert.ok(referenceComparedAll("5 inputs match two independent references\nREFERENCE COMPARED 5/5\n"));
    assert.ok(!referenceComparedAll(""), "an exit 0 with no output is not a pass");
    assert.ok(!referenceComparedAll("REFERENCE COMPARED 3/5"));
    assert.ok(!referenceComparedAll("REFERENCE COMPARED 0/0"));
    assert.ok(!referenceComparedAll("REFERENCE COMPARED 5/5\nREFERENCE COMPARED 2/5"), "the last one counts");
  });
});

describe("parsing the writers' replies", () => {
  it("reads the module from its own fenced block, braces and all", () => {
    const program = 'd = {"a": 1}\nprint("x\\ny")';
    assert.deepEqual(parseReferenceReply(fenced(program)), { applies: true, reason: "computable", source: program + "\n" });
    assert.deepEqual(parseReferenceReply('{"applies": false, "reason": "needs the network"}'), { applies: false, reason: "needs the network", source: "" });
    assert.equal(fencedPython(secondModule("n")), "def reference(n):\n    return n\n");
  });
});

describe("draftReference", () => {
  it("writes both references and the driver beside the snapshot, and keeps them when they fail on the untouched project", async () => {
    const w = workspace();
    try {
      const snapshot = snapshotProject(w.dir)!;
      const p = writers([fenced(moduleA())], [secondModule("str(n + n)")]);
      const r = await draftReference({ ...ask, task: "write double.py", snapshot, fetchFn: p.fetchFn });
      assert.ok(r.ok, r.ok ? "" : r.why);
      assert.equal(r.check.hidden, true);
      for (const f of ["check.py", "second.py", "driver.py", "runner.py"]) assert.ok(existsSync(join(snapshot.dir, f)));
      assert.equal(existsSync(join(w.dir, "check.py")), false, "nothing is written into the project");
      // The second reviewer is told the input format and inputs — never the first's code or answers.
      assert.match(p.secondPrompts[0]!, /ONE INPUT IS: an integer n/);
      assert.doesNotMatch(p.secondPrompts[0]!, /str\(2 \* n\)|run_deliverable/);
    } finally {
      w.cleanup();
    }
  });

  it("is declined when the first writer says no reference applies", async () => {
    const w = workspace();
    try {
      const p = writers(['{"applies": false, "reason": "needs training"}'], [secondModule("n")]);
      const r = await draftReference({ ...ask, task: "train a model", snapshot: snapshotProject(w.dir)!, fetchFn: p.fetchFn });
      assert.deepEqual(r, { ok: false, why: "does not apply: needs training" });
    } finally {
      w.cleanup();
    }
  });

  it("is dropped when the two references mostly disagree, without asking again", async () => {
    const w = workspace();
    try {
      const p = writers([fenced(moduleA())], [secondModule("str(3 * n)")]);
      const r = await draftReference({ ...ask, task: "t", snapshot: snapshotProject(w.dir)!, fetchFn: p.fetchFn });
      assert.equal(r.ok, false);
      assert.match(!r.ok ? r.why : "", /agree on only 0 of 5 inputs/);
      assert.equal(p.firstPrompts.length, 1);
    } finally {
      w.cleanup();
    }
  });

  it("asks the first writer once more when its module fails in its own code, with that output", async () => {
    const w = workspace();
    try {
      const p = writers([fenced(moduleA("int('x')")), fenced(moduleA())], [secondModule("str(n + n)")]);
      const r = await draftReference({ ...ask, task: "t", snapshot: snapshotProject(w.dir)!, fetchFn: p.fetchFn });
      assert.ok(r.ok, r.ok ? "" : r.why);
      assert.equal(p.firstPrompts.length, 2);
      assert.match(p.firstPrompts[1]!, /failed in its own code on the untouched project[\s\S]*first reference failed on input 1/);
    } finally {
      w.cleanup();
    }
  });

  it("asks again when the module does not compile, instead of letting a SyntaxError judge the work", async () => {
    const w = workspace();
    try {
      const p = writers([fenced("INPUTS = ['[\n]"), fenced(moduleA())], [secondModule("str(n + n)")]);
      const r = await draftReference({ ...ask, task: "t", snapshot: snapshotProject(w.dir)!, fetchFn: p.fetchFn });
      assert.ok(r.ok, r.ok ? "" : r.why);
      assert.equal(p.firstPrompts.length, 2);
    } finally {
      w.cleanup();
    }
  });

  it("is dropped when it already passes before any work, since it cannot tell work from none", async () => {
    const w = workspace();
    try {
      const p = writers([fenced(moduleA("str(2 * n)", "    return str(2 * n)"))], [secondModule("str(n + n)")]);
      const r = await draftReference({ ...ask, task: "t", snapshot: snapshotProject(w.dir)!, fetchFn: p.fetchFn });
      assert.equal(r.ok, false);
      assert.match(!r.ok ? r.why : "", /already passes/);
    } finally {
      w.cleanup();
    }
  });
});

describe("a reference check, in a turn", () => {
  async function turn(content: string, opts: { second?: string; first?: string; waitMs?: number; extra?: Check[]; refModel?: string } = {}) {
    const w = workspace();
    const snapshot = snapshotProject(w.dir)!;
    const p = writers([opts.first ?? fenced(moduleA())], [opts.second ?? secondModule("str(n + n)")]);
    // Written by a model other than the worker ("m"), unless a test says otherwise.
    const ref = await draftReference({ ...ask, model: opts.refModel ?? "ref-model", task: "write double.py", snapshot, fetchFn: p.fetchFn });
    assert.ok(ref.ok, ref.ok ? "" : ref.why);
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "double.py", content } }] },
      { text: "Done: double.py prints twice its argument." },
    ]);
    const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: w.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", maxProofAttempts: 1 });
    const pending =
      opts.waitMs === 0
        ? new Promise<{ check: Check; note: Record<string, unknown> } | null>(() => {})
        : Promise.resolve({ check: ref.check, note: { snapshot: snapshot.hash } });
    const events = await drain(
      engine.run("write double.py", allowAll, {
        referenceCheck: pending,
        ...(opts.waitMs === undefined ? {} : { referenceWaitMs: opts.waitMs }),
        ...(opts.extra ? { taskChecks: opts.extra } : {}),
      }),
    );
    w.cleanup();
    const end = events.find((e) => e.kind === "job_end");
    return { events, outcome: end && end.kind === "job_end" ? end.outcome : undefined, end: end && end.kind === "job_end" ? end : undefined };
  }

  it("records who wrote it, and a reference by the worker model is not independent", async () => {
    const other = await turn("import sys\nprint(2 * int(sys.argv[1]))\n");
    assert.equal(other.end?.checkAuthors?.["task:reference"], "reference ref-model");
    assert.equal(other.end?.claim, "verified (independent checks: ref-model)");
    const own = await turn("import sys\nprint(2 * int(sys.argv[1]))\n", { refModel: "m" });
    assert.deepEqual([own.outcome, own.end?.tier, own.end?.claim], ["unverified", "passed-own-checks", "passed own checks (m), not verified"]);
  });

  it("joins at the claim and refuses work both references disagree with, showing the input", async () => {
    const { events, outcome } = await turn("import sys\nn = int(sys.argv[1])\nprint(n + n if n < 4 else n * 3)\n");
    assert.ok(events.some((e) => e.kind === "info" && /independent reference check joined/.test(e.text)));
    const refused = events.find((e) => e.kind === "proof_refused" || e.kind === "proof_exhausted");
    assert.match(JSON.stringify(refused), /input: 4\\nexpected: '8'\\nactual:   '12'\\n\(two independent references agree/);
    assert.notEqual(outcome, "verified");
  });

  it("verifies work that agrees with both", async () => {
    assert.equal((await turn("import sys\nprint(2 * int(sys.argv[1]))\n")).outcome, "verified");
  });

  it("never judges an input where the references disagree", async () => {
    // The second reviewer is wrong about 5; the work is wrong only about 5. Not judged there, so not refused.
    const { outcome } = await turn("import sys\nn = int(sys.argv[1])\nprint(15 if n == 5 else 2 * n)\n", { second: secondModule("str(15) if n == 5 else str(n + n)") });
    assert.equal(outcome, "verified");
  });

  it("is retired, not obeyed, when its own code fails at the claim; the other checks judge", async () => {
    const raises = "    if __import__('os').path.exists('double.py'):\n        raise KeyError('oops')\n    return 'missing'";
    const made: Check = { name: "made", kind: "command", run: "[ \"$(python3 double.py)\" = \"1\" ]", timeoutMs: 5_000, expectExit: 0, tags: ["task", "value", "exact"], hidden: true, author: { kind: "judge", model: "judge-j" } };
    const { events, outcome } = await turn("print(1)\n", { first: fenced(moduleA("str(2 * n)", raises)), extra: [made] });
    assert.ok(events.some((e) => e.kind === "info" && /failed in its own code, not on the work/.test(e.text)));
    assert.equal(outcome, "verified", "judged by the check that remained");
  });

  it("leaves the claim unverified when the retired reference was the only check", async () => {
    const raises = "    if __import__('os').path.exists('double.py'):\n        raise KeyError('oops')\n    return 'missing'";
    const { events, outcome } = await turn("print(1)\n", { first: fenced(moduleA("str(2 * n)", raises)) });
    assert.ok(events.some((e) => e.kind === "info" && /no other check is left to judge the claim — this claim is unverified/.test(e.text)));
    assert.notEqual(outcome, "verified");
  });

  // An import-style deliverable: run_deliverable imports the work's module.
  const importing = [
    "    try:",
    "        import importlib, os, sys",
    "        sys.path.insert(0, os.getcwd())",
    "        return str(importlib.import_module('double').f(n))",
    "    except Exception as e:",
    "        return 'failed: %s' % e",
  ].join("\n");

  it("a deliverable that ends the process on import (os._exit(0)) is not a pass", async () => {
    // The driver used to import the work's module in its own process: `os._exit(0)` at top
    // level ended it with exit 0 before any comparison, and the check passed on wrong work.
    const { events, outcome } = await turn("import os\nos._exit(0)\ndef f(n):\n    return n * 999\n", { first: fenced(moduleA("str(2 * n)", importing)) });
    assert.notEqual(outcome, "verified");
    const refused = events.find((e) => e.kind === "proof_refused" || e.kind === "proof_exhausted");
    assert.match(JSON.stringify(refused), /the deliverable ended the process/);
  });

  it("a deliverable that calls sys.exit(0) on import, or exits during the call, is not a pass", async () => {
    for (const content of ["import sys\nsys.exit(0)\n", "import os\ndef f(n):\n    os._exit(0)\n"]) {
      const { outcome } = await turn(content, { first: fenced(moduleA("str(2 * n)", importing)) });
      assert.notEqual(outcome, "verified", content);
    }
  });

  it("an import-style deliverable that is right still verifies, judged out of process", async () => {
    const { outcome } = await turn("def f(n):\n    return 2 * n\n", { first: fenced(moduleA("str(2 * n)", importing)) });
    assert.equal(outcome, "verified");
  });

  it("the work's code cannot call reference() through the module it was handed", async () => {
    // A deliverable that reaches into the check module for the expected value gets nothing.
    const cheat = "import sys\ndef f(n):\n    m = [v for k, v in sys.modules.items() if hasattr(v, 'reference')]\n    return int(m[0].reference(n)) if m else -1\n";
    const { outcome } = await turn(cheat, { first: fenced(moduleA("str(2 * n)", importing)) });
    assert.notEqual(outcome, "verified");
  });

  it("is not waited for past its time: the claim is judged without it", async () => {
    const { events } = await turn("import sys\nprint(0)\n", { waitMs: 0 });
    assert.ok(events.some((e) => e.kind === "info" && /still being written; judging this claim without it/.test(e.text)));
  });
});
