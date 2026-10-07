/**
 * A criteria draft the model did not actually write.
 *
 * `parseDraft` turned a reply with no JSON in it — prose, an apology, a reply
 * cut off at its 500-token limit, nothing at all — into empty lists, and
 * returned `ok: true`. The window then printed "the model had nothing to add
 * beyond the project's bar": a considered answer, attributed to a model that
 * never gave one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftCriteria } from "../src/criteria.js";

function replying(content: string | null, finish = "stop"): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content }, finish_reason: finish }] }),
      text: async () => "",
    }) as unknown as Response) as unknown as typeof fetch;
}

const ask = (fetchFn: typeof fetch) =>
  draftCriteria({
    task: "add a --json flag",
    scripts: ["test"],
    barChecks: ["tests"],
    baseUrl: "http://provider.test/v1",
    model: "m",
    fetchFn,
  });

describe("a criteria draft", () => {
  it("that is prose, not JSON, is a failed draft rather than an empty one", async () => {
    const r = await ask(replying("Sure! I think the tests should cover the flag."));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /not JSON, so nothing was proposed: "Sure! I think/);
  });

  it("cut off at the token limit says so", async () => {
    const r = await ask(replying('{"checks":[{"name":"json-flag","run":"npm test -- js', "length"));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /cut off at the token limit/);
  });

  it("that is empty says it was empty", async () => {
    const r = await ask(replying(null));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /the reply was empty/);
  });

  it("that really proposes nothing is still an empty draft", async () => {
    const r = await ask(replying('```json\n{"checks": [], "notes": []}\n```'));
    assert.deepEqual(r, { ok: true, draft: { checks: [], notes: [] } });
  });

  it("fails clearly on a removed subscription backend", async () => {
    const r = await draftCriteria({
      task: "x",
      scripts: [],
      barChecks: [],
      baseUrl: "claude-code://subscription",
      model: "opus",
    });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /removed|no longer supported/i);
  });
});

describe("a drafted check that is too long", () => {
  it("is dropped, never cut into a command that does not parse", async () => {
    const { sanitizeCriteria, CRITERIA_MAX_RUN } = await import("../src/criteria.js");
    const long = `node -e "${"x".repeat(CRITERIA_MAX_RUN)}"`;
    const d = sanitizeCriteria({ checks: [{ name: "long", run: long }, { name: "ok", run: "test -f a" }] });
    assert.deepEqual(d.checks, [{ name: "ok", run: "test -f a" }]);
    const fits = `echo ${"y".repeat(CRITERIA_MAX_RUN - 5)}`;
    assert.equal(sanitizeCriteria({ checks: [{ name: "f", run: fits }] }).checks[0].run, fits, "not cut");
  });
});

describe("preflight", () => {
  it("reports a command the shell cannot parse as broken, not as failing work", async () => {
    const { preflightCriteria } = await import("../src/criteria.js");
    const { workspace } = await import("./helpers.js");
    const ws = workspace();
    try {
      const broken = await preflightCriteria(
        [
          { name: "unterminated", kind: "command", run: "node -e \"console.log('a", expectExit: 0 },
          { name: "python-cut", kind: "command", run: "python3 -c \"print('abc", expectExit: 0 },
          { name: "fails-honestly", kind: "command", run: "test -f nope.txt", expectExit: 0 },
        ],
        { cwd: ws.dir },
      );
      assert.deepEqual(broken.map((b) => b.name), ["unterminated", "python-cut"]);
      assert.match(broken[0].why, /could not parse it: .*(Syntax error|unterminated|unexpected)/i);
    } finally {
      ws.cleanup();
    }
  });
});

describe("the drafter's instructions", () => {
  it("forbid inventing limits the task does not state", async () => {
    const { draftCriteria } = await import("../src/criteria.js");
    let system = "";
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      system = (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages[0].content;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"checks":[],"notes":[]}' }, finish_reason: "stop" }] }), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    await draftCriteria({ task: "t", scripts: [], barChecks: [], baseUrl: "http://p.test/v1", model: "m", fetchFn });
    assert.match(system, /Never invent a number, limit, path or format the task does not state/);
    assert.match(system, /Prefer a check that FAILS now/);
    assert.match(system, /One line each/);
    assert.match(system, /every one the task DOES state is a check/);
    assert.match(system, /accuracy above 0\.62 gets a check of accuracy above 0\.62/);
    assert.match(system, /At least one check must run the thing and test its result/);
    assert.match(system, /mktemp -d\), never into\na directory the task names/);
  });
});

