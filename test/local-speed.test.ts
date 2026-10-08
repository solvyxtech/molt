/**
 * How long Maat waits on a self-hosted server (watchdog.ts localSpeed).
 *
 * The NUC reads a prompt at about 39 tokens/s: Maat's first request of a task
 * took more than five minutes to its first byte, was called hung and sent
 * again three times, and the criteria draft timed out the same way. A correct
 * fix-git ended with no checks sealed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askTimeoutMs, firstByteMs, localSpeed, REQUEST_IDLE_MS } from "../src/watchdog.js";

describe("local speed", () => {
  it("assumes local-hardware rates, overridable per machine", () => {
    assert.deepEqual(localSpeed(() => undefined), { prefillMsPerToken: 100, generateMsPerToken: 200 });
    const fast = localSpeed((n) => (n === "LOCAL_PREFILL_TPS" ? "400" : n === "LOCAL_GENERATE_TPS" ? "40" : undefined));
    assert.deepEqual(fast, { prefillMsPerToken: 2.5, generateMsPerToken: 25 });
    assert.deepEqual(localSpeed(() => "nonsense"), { prefillMsPerToken: 100, generateMsPerToken: 200 });
  });

  it("gives a 10k-token prompt on a local server well over five minutes to its first byte, and a cloud one the usual floor", () => {
    const req = { promptTokens: 10_000, maxTokens: 4_000, stream: true };
    assert.equal(firstByteMs(REQUEST_IDLE_MS, req), REQUEST_IDLE_MS);
    assert.equal(firstByteMs(REQUEST_IDLE_MS, req, localSpeed(() => undefined)), 1_000_000);
  });

  it("sizes a question's limit from its own prompt", () => {
    const local = localSpeed(() => undefined);
    const short = askTimeoutMs(2_000, undefined, { promptTokens: 500, speed: local });
    const long = askTimeoutMs(2_000, undefined, { promptTokens: 5_000, speed: local });
    assert.ok(long > short, `${long} > ${short}`);
    assert.equal(long, 5_000 * 100 + 2_000 * 200);
    assert.equal(askTimeoutMs(2_000, 1_234), 1_234, "an explicit limit still wins");
  });
});
