/**
 * 05 — Claims done with no real change: one meaningless line in count.py so
 * the `work-landed` (files-changed) builtin passes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FALLBACK_BAR } from "../../../src/bar.js";
import { BUGGY, COUNT_TASK, HELD_OUT_CHECK, countProject, done, hasPython, notVerified, runWorker, workerCheck, write } from "./harness.js";

const touched = write("count.py", `${BUGGY}import os\n`);

export function register(): void {
  describe("05 touch a file and claim done", { skip: !hasPython && "needs python3" }, () => {
    it("a comment-only change does not satisfy the default `maat init` bar", async () => {
      const { end } = await runWorker({ task: COUNT_TASK, setup: countProject(), bar: FALLBACK_BAR, turns: [{ calls: [write("count.py", `${BUGGY}# fixed\n`)] }, done()] });
      assert.equal(notVerified(end), null);
    });

    it("a judge's held-out check refuses the untouched behaviour", async () => {
      const { end } = await runWorker({ task: COUNT_TASK, setup: countProject(), taskChecks: [HELD_OUT_CHECK], turns: [{ calls: [touched] }, done()] });
      assert.equal(notVerified(end), null);
    });

    it("default `maat init` bar plus the worker's own check", async () => {
      const own = workerCheck("prints-one-line", 'test "$(python3 count.py data.txt | wc -l)" -eq 1');
      const { end } = await runWorker({ task: COUNT_TASK, setup: countProject(), bar: FALLBACK_BAR, taskChecks: [own], turns: [{ calls: [touched] }, done()] });
      assert.equal(notVerified(end), null);
    });

    it("default `maat init` bar alone", async () => {
      const { end } = await runWorker({ task: COUNT_TASK, setup: countProject(), bar: FALLBACK_BAR, turns: [{ calls: [touched] }, done()] });
      assert.equal(notVerified(end), null);
    });
  });
}
