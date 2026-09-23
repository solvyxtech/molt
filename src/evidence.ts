/**
 * What a passing command actually established.
 *
 * A command check is judged on its exit code, and an exit code is the
 * command's own account of itself. Two ways it lies are common enough in
 * real projects that molt reads the output before believing it:
 *
 *  1. **Zero tests is not a suite.** `node --test` over a glob that matched
 *     nothing, `vitest --passWithNoTests`, a `-t` filter that selected
 *     nothing, `go test` in a package with no test files — every one exits 0,
 *     and a bar that reads the exit code alone records a green suite that
 *     executed nothing. A model that deletes or renames the tests it was
 *     failing gets exactly this.
 *  2. **The runner's exit can be thrown away.** `npm test | tee log` exits
 *     with tee's status; `npm test || true` cannot fail at all. The runner
 *     printed "3 failed" and the check passed.
 *
 * Both are judged from the output the runner already prints — its own
 * summary line — never from a guess about what the command "should" print.
 * When no summary is recognised, nothing is concluded: this module only ever
 * turns a pass into a refusal on the runner's own words, so an unknown
 * runner is left exactly as it was.
 */

export type RunnerSummary = {
  runner: string;
  /** Tests the runner says it ran, when it said. */
  total?: number;
  /** Tests the runner says failed, when it said. */
  failed?: number;
};

const num = (s: string | undefined): number => Number(s ?? "0");

/** The last match of a global regex, or null. Final summaries come last. */
function last(re: RegExp, s: string): RegExpExecArray | null {
  let m: RegExpExecArray | null;
  let out: RegExpExecArray | null = null;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) out = m;
  return out;
}

/**
 * Read the runner's own summary out of its output.
 *
 * Final summaries only: node's runner and TAP print per-file plans and
 * subtest counts before the totals, and a nested run (a test that spawns the
 * runner on a fixture) prints its own summary in the middle of the outer
 * one. The outer runner's totals are the last lines it writes, so the last
 * match is the one that describes this command.
 */
export function readSummary(output: string): RunnerSummary | null {
  // Colour codes would split "tests" from its number.
  const s = output.replace(/\x1b\[[0-9;]*m/g, "");

  // node:test (spec reporter: "ℹ tests 12"; TAP reporter: "# tests 12").
  const nodeTests = last(/^(?:ℹ|#) tests (\d+)\s*$/gm, s);
  if (nodeTests) {
    const fail = last(/^(?:ℹ|#) fail (\d+)\s*$/gm, s);
    return { runner: "node:test", total: num(nodeTests[1]), failed: fail ? num(fail[1]) : undefined };
  }

  // jest: "Tests:       1 failed, 11 passed, 12 total".
  const jest = last(/^Tests:\s+(.*?)(\d+) total\s*$/gm, s);
  if (jest) {
    const f = /(\d+) failed/.exec(jest[1] ?? "");
    return { runner: "jest", total: num(jest[2]), failed: f ? num(f[1]) : 0 };
  }
  if (/^No tests found, exiting with code 0/m.test(s)) return { runner: "jest", total: 0 };

  // vitest: " Tests  1 failed | 11 passed (12)" / "No test files found".
  const vitest = last(/^\s*Tests\s+(.*?)\((\d+)\)\s*$/gm, s);
  if (vitest) {
    const f = /(\d+) failed/.exec(vitest[1] ?? "");
    return { runner: "vitest", total: num(vitest[2]), failed: f ? num(f[1]) : 0 };
  }
  if (/^No test files found/m.test(s)) return { runner: "vitest", total: 0 };

  // pytest: "collected 0 items" / "no tests ran" / "=== 2 failed, 10 passed in 0.3s ===".
  if (/^collected 0 items\b/m.test(s) || /^=+ no tests ran\b/m.test(s)) {
    return { runner: "pytest", total: 0 };
  }
  const pytest = last(/^=+ (.*\b(?:passed|failed|error|errors)\b.*) in [\d.]+s.*=+\s*$/gm, s);
  if (pytest) {
    const counts = [...(pytest[1] ?? "").matchAll(/(\d+) (passed|failed|errors?|skipped|xfailed|xpassed)/g)];
    const total = counts.reduce((a, m) => a + num(m[1]), 0);
    const failed = counts
      .filter((m) => m[2] === "failed" || m[2]!.startsWith("error"))
      .reduce((a, m) => a + num(m[1]), 0);
    return { runner: "pytest", total, failed };
  }

  // cargo: one "running N tests" per test binary, one "test result:" each.
  const cargoRuns = [...s.matchAll(/^running (\d+) tests?\s*$/gm)];
  if (cargoRuns.length) {
    const results = [...s.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed/gm)];
    return {
      runner: "cargo",
      total: cargoRuns.reduce((a, m) => a + num(m[1]), 0),
      failed: results.length ? results.reduce((a, m) => a + num(m[2]), 0) : undefined,
    };
  }

  // mocha: "12 passing (40ms)" / "1 failing".
  const passing = last(/^\s*(\d+) passing\b/gm, s);
  if (passing) {
    const failing = last(/^\s*(\d+) failing\s*$/gm, s);
    const f = failing ? num(failing[1]) : 0;
    return { runner: "mocha", total: num(passing[1]) + f, failed: f };
  }

  // go test: "ok  pkg 0.01s", "FAIL pkg", "?   pkg [no test files]".
  const goOk = s.match(/^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/gm)?.length ?? 0;
  const goFail = s.match(/^(?:FAIL\s+\S+\s+[\d.]+s|--- FAIL: )/gm)?.length ?? 0;
  const goEmpty = s.match(/^\?\s+\S+\s+\[no test files\]/gm)?.length ?? 0;
  if (goOk || goFail || goEmpty) {
    // go prints no per-package count without -v, so "ran something" is the
    // most it can say. An all-"[no test files]" run is the zero case.
    return { runner: "go test", total: goOk || goFail ? undefined : 0, failed: goFail };
  }

  return null;
}

/**
 * The tail of a command that makes its exit status meaningless.
 *
 * Only the END of the command is read. `rm -f x || true; npm test` is an
 * ordinary cleanup followed by a real check; `npm test || true` is a check
 * that cannot fail. The difference is which status the shell hands back.
 */
const SWALLOW_TAIL = /(?:\|\|\s*(?:true|:|exit\s+0)|;\s*(?:true|:|exit\s+0))\s*$/;

export function swallowsExit(run: string): string | null {
  const m = SWALLOW_TAIL.exec(run.trim());
  return m ? m[0].trim() : null;
}

/** A top-level pipe (`a | b`, not `a || b`), without pipefail in force. */
export function pipesWithoutPipefail(run: string): boolean {
  if (/\bpipefail\b/.test(run)) return false;
  return /(^|[^|])\|(?!\|)/.test(run.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''"));
}

export type PassJudgement =
  | { ok: true; summary: RunnerSummary | null }
  | { ok: false; summary: RunnerSummary | null; why: string; broken?: boolean };

/**
 * Should this exit-0 result stand?
 *
 * Refuses on the runner's own summary (zero tests, or failures it reported
 * while the command still exited 0) and on a command whose last word throws
 * the status away. `emptyAllowed` is the project saying a suite may
 * legitimately be empty; it never excuses reported failures.
 */
export function judgePass(run: string, output: string, emptyAllowed = false): PassJudgement {
  const summary = readSummary(output);
  if (summary?.failed && summary.failed > 0) {
    const piped = pipesWithoutPipefail(run);
    return {
      ok: false,
      summary,
      why:
        `the command exited 0, but ${summary.runner} reported ${summary.failed} failed ` +
        `test${summary.failed === 1 ? "" : "s"}. ` +
        (piped
          ? "The runner's exit status is lost in a pipe: the shell returns the LAST stage's " +
            "status. Add `set -o pipefail;` to the check, or drop the pipe."
          : "Something between the runner and molt replaced its exit status.") +
        " A red suite does not become green by exiting 0.",
      broken: piped,
    };
  }
  if (summary && summary.total === 0 && !emptyAllowed) {
    return {
      ok: false,
      summary,
      why:
        `the command exited 0, but ${summary.runner} ran zero tests. A suite that executed ` +
        "nothing establishes nothing — check the test glob or filter, and that the tests " +
        "still exist. If this suite may legitimately be empty, set `empty: allow` on the check.",
    };
  }
  const swallowed = swallowsExit(run);
  if (swallowed && !(summary && summary.total && summary.failed === 0)) {
    return {
      ok: false,
      summary,
      broken: true,
      why:
        `this check ends in \`${swallowed}\`, so it exits 0 whatever happened and its pass ` +
        "establishes nothing. Remove it from the check in .molt/done.yml.",
    };
  }
  return { ok: true, summary };
}
