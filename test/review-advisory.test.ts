/**
 * Experimental review-advisory mode (`--review-advisory`, MAAT_REVIEW_ADVISORY=1):
 * the review is recorded and does not gate; "verified" additionally needs a
 * drafted runs+value check that did not already pass before the work.
 * Default behaviour is pinned beside it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../src/cli.js";
import { tierOf } from "../src/tiers.js";

describe("tierOf, review advisory", () => {
  const ck = (name: string, tags: string[]) => ({ name, ok: true, hidden: true as const, tags });
  const strong = ck("task:counts", ["task", "value"]);

  it("the review is recorded and does not gate", () => {
    const review = { votes: "2/3", violations: [] };
    assert.equal(tierOf({ results: [strong], review }).tier, "passed-checks", "default: a contradiction demotes");
    const r = tierOf({ results: [strong], review, reviewAdvisory: true });
    assert.equal(r.tier, "verified");
    assert.match(r.reviewNote!, /2\/3 contradicting/);
    assert.equal(tierOf({ results: [strong], unreviewed: true, reviewAdvisory: true }).tier, "verified");
    assert.equal(tierOf({ results: [strong], unreviewed: true }).tier, "passed-checks", "default unchanged");
  });

  it("needs a value check that did not already pass before the work", () => {
    const guards = new Set(["task:counts"]);
    assert.equal(tierOf({ results: [strong], guards }).tier, "verified", "off by default: guards are ignored");
    const r = tierOf({ results: [strong], guards, reviewAdvisory: true });
    assert.equal(r.tier, "passed-checks");
    assert.match(r.reason!, /also passed before the work/);
    const two = tierOf({ results: [strong, ck("task:other", ["task", "value"])], guards, reviewAdvisory: true });
    assert.equal(two.tier, "verified", "another value check that failed on the pristine tree carries it");
  });

  it("a surface-only or value-less pass is still not verified", () => {
    assert.equal(tierOf({ results: [ck("task:a", ["task"])], reviewAdvisory: true }).tier, "passed-checks");
    assert.equal(tierOf({ results: [ck("task:a", ["task", "surface", "value"])], reviewAdvisory: true }).tier, "passed-checks");
  });

  it("a person's passing check still verifies", () => {
    assert.equal(tierOf({ results: [{ ok: true, tags: [] }], reviewAdvisory: true, review: { votes: "3/3", violations: [] } }).tier, "verified");
  });
});

describe("parseArgs --review-advisory", () => {
  it("is off unless asked for", () => {
    assert.equal(parseArgs([]).reviewAdvisory, undefined);
    assert.equal(parseArgs(["--review-advisory"]).reviewAdvisory, true);
  });
});
