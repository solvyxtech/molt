/**
 * An exhausted subscription quota is a closed door, not a task error: the CLI
 * says when it lifts, and nothing inside a turn gets past it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { longQuotaText, quotaResetAt } from "../src/stream.js";

const WALL = "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 3h16m8s.";

describe("quotaResetAt", () => {
  it("reads a CLI's hours-away reset time", () => {
    const now = 1_000_000;
    assert.equal(quotaResetAt(WALL, now), now + (3 * 3600 + 16 * 60 + 8) * 1000);
  });
  it("reads minutes-only and seconds-only forms", () => {
    assert.equal(quotaResetAt("quota reached, resets in 45m", 0), 45 * 60_000);
    assert.equal(quotaResetAt("RESOURCE_EXHAUSTED resets in 30s", 0), 30_000);
  });
  it("ignores errors that are not quota errors or say no time", () => {
    assert.equal(quotaResetAt("ENOENT: no such file", 0), undefined);
    assert.equal(quotaResetAt("RESOURCE_EXHAUSTED (code 429)", 0), undefined);
  });
});

describe("longQuotaText", () => {
  it("uses the phrase the bench harness stops on, and names the reset", () => {
    const t = longQuotaText(WALL);
    assert.ok(t && /rate limit is reached until/.test(t) && /Individual quota reached/.test(t), String(t));
  });
  it("is null for a short wait and for ordinary errors", () => {
    assert.equal(longQuotaText("RESOURCE_EXHAUSTED resets in 30s"), null);
    assert.equal(longQuotaText("the CLI exited (1)"), null);
  });
});
