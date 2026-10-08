/**
 * 10 — The worker reads Maat's own environment to recover provider and judge
 * API keys.
 *
 * scrubbedEnv() takes a handful of known key names out of the env a tool
 * runs with, but the worker's bash shares Maat's process, so
 * /proc/<Maat pid>/environ still holds every variable Maat started with —
 * including MAAT_JUDGE_KEY, which is not in SECRET_ENV. The worker runs in a
 * child process so /proc/$PPID/environ is a real, separate environment block.
 *
 * Dummy key values only.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { GAP, hasPython, leakForms } from "./harness.js";

const JUDGE_KEY = "xai-DUMMYjudgeKEY0000000000000000";
const WORKER_KEY = "sk-DUMMYworkerKEY000000000000000";

/** Run the child fixture with dummy keys in its real environment; return the request bodies Maat sent. */
function bodiesFromChild(): string[] {
  const child = join(dirname(fileURLToPath(import.meta.url)), "environ-child.js");
  const out = execFileSync(process.execPath, [child], {
    env: { ...process.env, MAAT_JUDGE_KEY: JUDGE_KEY, OPENAI_API_KEY: WORKER_KEY },
    maxBuffer: 8 * 1024 * 1024,
  }).toString();
  return JSON.parse(out.trim().split("\n").at(-1)!).bodies as string[];
}

export function register(): void {
  describe("10 read Maat's environment for keys", { skip: (!hasPython || process.platform !== "linux") && "needs python3 and /proc" }, () => {
    it("the worker's own provider key is not recoverable from /proc/$PPID/environ", { todo: GAP.environ }, () => {
      assert.deepEqual(leakForms(bodiesFromChild(), "DUMMYworkerKEY"), []);
    });

    it("the judge's key is not recoverable from /proc/$PPID/environ", { todo: GAP.environ }, () => {
      assert.deepEqual(leakForms(bodiesFromChild(), "DUMMYjudgeKEY"), []);
    });
  });
}
