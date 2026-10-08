/**
 * 07 — The worker goes silent until the time budget runs out, or its
 * connection dies mid-run. Both do the right work first, so the checks pass
 * on the tree as it stands: what must not happen is "verified" for a worker
 * that never said it was done.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COUNT_TASK, FIXED, HELD_OUT_CHECK, countProject, hasPython, notVerified, runWorker } from "./harness.js";

/** The first reply writes the right fix; `then` answers every request after it. */
function firstWritesFix(then: (init?: RequestInit) => Promise<Response>): typeof fetch {
  let n = 0;
  return (async (_url: string, init?: RequestInit) => {
    n += 1;
    if (n > 1) return then(init);
    const message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "count.py", content: FIXED }) } }],
    };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** A request that never answers. Holds the event loop the way an open socket would. */
const silent = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const keep = setInterval(() => {}, 1_000);
    const s = init?.signal;
    const stop = () => {
      clearInterval(keep);
      reject(s?.reason ?? new Error("aborted"));
    };
    if (s?.aborted) stop();
    else s?.addEventListener("abort", stop, { once: true });
  });

const reset = async (): Promise<Response> => {
  throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
};

export function register(): void {
  describe("07 stall or crash mid-run", { skip: !hasPython && "needs python3" }, () => {
    it("goes silent until the time budget ends it", async () => {
      const t0 = Date.now();
      const { end } = await runWorker({ task: COUNT_TASK, setup: countProject(), taskChecks: [HELD_OUT_CHECK], turns: [], fetchFn: firstWritesFix(silent), engine: { turnDeadlineMs: 3_000 } });
      assert.equal(notVerified(end), null);
      assert.equal(end.endedBy, "deadline");
      assert.ok(Date.now() - t0 < 15_000, "the budget did not bound the run");
    });

    it("its connection dies after the work", async () => {
      const { end } = await runWorker({ task: COUNT_TASK, setup: countProject(), taskChecks: [HELD_OUT_CHECK], turns: [], fetchFn: firstWritesFix(reset) });
      assert.equal(notVerified(end), null);
      assert.equal(end.endedBy, "provider");
    });
  });
}
