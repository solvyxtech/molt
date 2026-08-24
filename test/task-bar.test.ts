/**
 * What "done" means for one task, on top of what it means for the project.
 *
 * `.molt/done.yml` is per-project on purpose and is never read from the prompt:
 * a bar the model can define is not a bar, it is the model marking its own
 * homework with extra steps. But that leaves it blind in one direction — it
 * proves the project is healthy, not that the task was done. A comment added to
 * a file satisfies `work-landed` and a green suite, and neither of them knows
 * what was asked for.
 *
 * Task criteria close that gap without handing over the pen. A model may draft
 * them, because it is good at "what would prove this?"; a person approves them,
 * because it is never to be trusted with "did I do it?"; and they are sealed
 * before the first request, because an approval that can be revised after
 * seeing the work is not an approval.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBar } from "../src/bar.js";
import { Engine, sealOf, withTaskChecks, asQuestion } from "../src/engine.js";
import type { Check } from "../src/types.js";
import { allowAll, drain, workspace } from "./helpers.js";

const cmd = (name: string, run: string): Check => ({
  name,
  kind: "command",
  run,
  timeoutMs: 30_000,
  expectExit: 0,
  tags: [],
});

const PROJECT = `version: 1
checks:
  - name: types
    run: "true"
`;

describe("task criteria are added to the bar, never substituted for it", () => {
  it("keeps the project's checks and appends the task's", () => {
    const merged = withTaskChecks(parseBar(PROJECT), [cmd("builds", "true")])!;
    assert.deepEqual(merged.checks.map((c) => c.name), ["types", "task:builds"]);
  });

  it("namespaces them, so a receipt never confuses the two", () => {
    // Reading a receipt six weeks later, "builds" alone does not say whether it
    // was this project's standing rule or one turn's idea.
    const merged = withTaskChecks(parseBar(PROJECT), [cmd("types", "false")])!;
    assert.deepEqual(merged.checks.map((c) => c.name), ["types", "task:types"]);
    // And the project's own `types` is the one that survived unchanged.
    const project = merged.checks.find((c) => c.name === "types")!;
    assert.equal(project.kind === "command" && project.run, "true");
  });

  it("cannot remove a project check by colliding with it", () => {
    // The failure mode this guards: a task check named to shadow a project one,
    // quietly replacing a real gate with a permissive one.
    const merged = withTaskChecks(parseBar(PROJECT), [
      { ...cmd("task:types", "false") },
    ])!;
    assert.equal(merged.checks.filter((c) => c.name === "types").length, 1);
    const project = merged.checks.find((c) => c.name === "types")!;
    assert.equal(project.kind === "command" && project.run, "true", "the project's rule stands");
  });

  it("works with no project bar at all", () => {
    const merged = withTaskChecks(null, [cmd("builds", "true")])!;
    assert.deepEqual(merged.checks.map((c) => c.name), ["task:builds"]);
  });

  it("changes nothing when there are no task criteria", () => {
    const bar = parseBar(PROJECT);
    assert.equal(withTaskChecks(bar, []), bar, "the same object, not a rebuilt copy");
  });

  it("still drops the write check for a question", () => {
    // ask mode and task criteria have to compose: a question with criteria is
    // still a question.
    const merged = withTaskChecks(
      parseBar(`version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n`),
      [cmd("builds", "true")],
    );
    const q = asQuestion(merged, true)!;
    assert.deepEqual(q.checks.map((c) => c.name), ["task:builds"]);
    assert.ok(q.checks.every((c) => c.advisory === true), "and it cannot refuse an answer");
  });
});

describe("the seal", () => {
  it("is stable for the same criteria and different for any change", () => {
    const a = sealOf([cmd("builds", "npm run build")], ["reads well"]);
    assert.equal(a, sealOf([cmd("builds", "npm run build")], ["reads well"]));
    assert.notEqual(a, sealOf([cmd("builds", "npm run build")], ["reads badly"]));
    assert.notEqual(a, sealOf([cmd("builds", "npm run buiId")], ["reads well"]));
    assert.notEqual(a, sealOf([cmd("built", "npm run build")], ["reads well"]));
    assert.notEqual(a, sealOf([], ["reads well"]));
  });

  it("is short enough to compare by eye", () => {
    // It exists to be checked by a person against the journal, so it has to be
    // a length someone will actually read rather than skim past.
    assert.equal(sealOf([cmd("a", "true")], []).length, 16);
  });
});

describe("criteria cannot move once the turn has started", () => {
  it("ignores the caller mutating the array it passed", async () => {
    // The attack this exists to stop: hand molt a strict criterion, wait until
    // the work is done and the checks are about to run, then swap it for one
    // that passes. molt copies and freezes at the top of the turn, so the
    // caller is editing an array nothing reads any more.
    const ws = workspace();
    try {
      const criteria: Check[] = [cmd("must-fail", "false")];
      const fetchFn = (async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => "",
          json: async () => ({
            choices: [{ message: { role: "assistant", content: "Done." } }],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          }),
        }) as unknown as Response) as unknown as typeof fetch;

      const engine = new Engine({
        baseUrl: "http://provider.test/v1",
        model: "m",
        cwd: ws.dir,
        bar: parseBar(PROJECT),
        fetchFn,
        stream: false,
        maxProofAttempts: 1,
        retryBackoffMs: [5],
      });

      const run = engine.run("do it", allowAll, { taskChecks: criteria });
      // Swap the criterion for a passing one while the turn is in flight.
      criteria[0] = cmd("must-fail", "true");
      const events = await drain(run);

      const proof = events.find(
        (e) => e.kind === "proof_result" || e.kind === "proof_refused" || e.kind === "proof_exhausted",
      );
      assert.ok(proof && "result" in proof, "the turn must reach the bar");
      const names = proof.result.results.map((r) => r.name);
      assert.ok(names.includes("task:must-fail"), `ran ${names.join(", ")}`);
      const swapped = proof.result.results.find((r) => r.name === "task:must-fail")!;
      assert.equal(swapped.ok, false, "the criterion set before the turn is the one that ran");
      assert.equal(proof.result.ok, false, "and it refused the claim");
    } finally {
      ws.cleanup();
    }
  });

  it("seals before the first request, and says so on the record", async () => {
    const ws = workspace();
    try {
      const sent: string[] = [];
      const fetchFn = (async (_u: string, init?: RequestInit) => {
        sent.push(String(init?.body ?? ""));
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => "",
          json: async () => ({
            choices: [{ message: { role: "assistant", content: "Done." } }],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          }),
        } as unknown as Response;
      }) as unknown as typeof fetch;

      const engine = new Engine({
        baseUrl: "http://provider.test/v1",
        model: "m",
        cwd: ws.dir,
        bar: parseBar(PROJECT),
        fetchFn,
        stream: false,
        maxProofAttempts: 1,
        retryBackoffMs: [5],
      });

      const events = await drain(
        engine.run("do it", allowAll, {
          taskChecks: [cmd("builds", "true")],
          taskNotes: ["the copy should read plainly"],
        }),
      );

      const sealed = events.find((e) => e.kind === "info" && /sealed for this turn/.test(e.text));
      assert.ok(sealed, "the turn must announce the seal");

      // The model is told, because a gate it does not know about is a trap
      // rather than a specification.
      assert.match(sent[0]!, /Acceptance criteria for this task/);
      assert.match(sent[0]!, /\[checked\] builds/);
      assert.match(sent[0]!, /recorded, not machine-checked/);
      assert.match(sent[0]!, /never reported as verified/);
    } finally {
      ws.cleanup();
    }
  });

  it("never treats a written note as a check", async () => {
    // A sentence nobody machine-checked cannot pass or fail. If notes could
    // reach the bar, molt would be reporting intent as evidence — the exact
    // dishonesty it exists to refuse, pointed inward.
    const ws = workspace();
    try {
      const fetchFn = (async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => "",
          json: async () => ({
            choices: [{ message: { role: "assistant", content: "Done." } }],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          }),
        }) as unknown as Response) as unknown as typeof fetch;

      const engine = new Engine({
        baseUrl: "http://provider.test/v1",
        model: "m",
        cwd: ws.dir,
        bar: parseBar(PROJECT),
        fetchFn,
        stream: false,
        maxProofAttempts: 1,
        retryBackoffMs: [5],
      });

      const events = await drain(
        engine.run("do it", allowAll, { taskNotes: ["it should feel fluid"] }),
      );
      const proof = events.find((e) => e.kind === "proof_result");
      assert.ok(proof && "result" in proof);
      assert.ok(
        proof.result.results.every((r) => !r.name.includes("fluid")),
        "a note must never appear as a check",
      );
    } finally {
      ws.cleanup();
    }
  });
});
