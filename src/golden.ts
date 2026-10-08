/**
 * Expected files ("golden" operands of a `diff`/`cmp` check) and whether they
 * predate the work.
 *
 * `diff out.txt expected.txt` asserts a value only when expected.txt is the
 * task's, not the worker's: a worker that writes both files makes it pass on
 * anything. The seal records each expected-looking operand's content before
 * the first step; at the tier, a check whose value rests only on such a file
 * counts as asserting a value only when the file was there then and is
 * byte-identical now. A check that joined after the work began has no record,
 * so its golden file proves nothing.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertsValue, goldenOperands } from "./tiers.js";

/** Content digest of a regular file, or null when there is none. */
export function fileDigest(abs: string): string | null {
  try {
    if (!statSync(abs).isFile()) return null;
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

function resolveIn(cwd: string, operand: string): string {
  return isAbsolute(operand) ? operand : join(cwd, operand);
}

/** Each expected-looking operand of these checks, by resolved path, with its digest now (null: absent). */
export function recordGoldens(checks: readonly { run?: string }[], cwd: string, into = new Map<string, string | null>()): Map<string, string | null> {
  for (const c of checks) {
    if (!c.run) continue;
    for (const g of goldenOperands(c.run)) {
      const abs = resolveIn(cwd, g);
      if (!into.has(abs)) into.set(abs, fileDigest(abs));
    }
  }
  return into;
}

/**
 * Names of value-tagged checks whose value rests only on expected files that
 * did not predate the work (absent from `before`, absent then, or changed
 * since). tierOf drops their value tag.
 */
export function valueUnproven(
  checks: readonly { name: string; run?: string; tags?: readonly string[] }[],
  cwd: string,
  before: ReadonlyMap<string, string | null>,
): Set<string> {
  const out = new Set<string>();
  const predates = (g: string): boolean => {
    const abs = resolveIn(cwd, g);
    const then = before.get(abs);
    return typeof then === "string" && fileDigest(abs) === then;
  };
  for (const c of checks) {
    if (!c.run || !c.tags?.includes("value")) continue;
    // Only a check whose value came from an expected file by name; one tagged
    // value for another reason (a literal, the reference driver) is untouched.
    if (assertsValue(c.run) && !assertsValue(c.run, predates)) {
      out.add(c.name);
      if (!c.name.startsWith("task:")) out.add(`task:${c.name}`);
    }
  }
  return out;
}
