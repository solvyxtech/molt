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
import { CLAUDE_CODE_URL } from "../src/claude-code.js";
import { draftCriteria } from "../src/criteria.js";
import { scriptedClaudeCode } from "./helpers.js";

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

  it("fails the same way on a subscription backend", async () => {
    const cc = scriptedClaudeCode([{ text: "I would suggest running the tests." }]);
    const r = await draftCriteria({
      task: "x",
      scripts: [],
      barChecks: [],
      baseUrl: CLAUDE_CODE_URL,
      model: "opus",
      claudeCodeSdk: cc.sdk,
    });
    assert.equal(r.ok, false);
  });
});
