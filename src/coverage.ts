/**
 * Reading coverage, so a change can be asked whether anything executes it.
 *
 * `work-landed` proves a file changed. `substance` proves the change was not
 * only comments. Neither can tell whether the new code does anything, and that
 * is where the remaining cosmetic changes live — a constant declared and never
 * referenced, a guard no test ever trips, a branch that exists so a diff exists.
 *
 * One real example, which is why this file is here. A turn added:
 *
 *     export const MAX_COMMAND_LENGTH = 16384;      // referenced nowhere
 *     if (path.length > MAX_PATH_LENGTH) return false;   // branch never taken
 *
 * Six checks passed on it: types, tests, both app checks, record-intact, and
 * work-landed. It was caught by a person reading the diff, which does not
 * scale and is the thing molt exists to replace.
 *
 * lcov, because every coverage tool emits it. Node's own test runner does
 * (`--test-reporter=lcov`), as do c8, nyc, pytest-cov, and go's cover with a
 * converter, so this is not tied to one language.
 */

export type FileCoverage = {
  /** line number -> times executed. Only lines the tool considers executable. */
  lines: Map<number, number>;
  /** line number -> counts for each branch on that line. */
  branches: Map<number, number[]>;
};

export type Coverage = Map<string, FileCoverage>;

/**
 * Parse lcov into per-file line and branch counts.
 *
 * Deliberately tolerant: an unrecognised record is skipped rather than thrown
 * on. A coverage format that gains a record type should not break a build.
 */
export function parseLcov(text: string): Coverage {
  const out: Coverage = new Map();
  let file: FileCoverage | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      file = { lines: new Map(), branches: new Map() };
      out.set(normalise(line.slice(3)), file);
      continue;
    }
    if (!file) continue;
    if (line.startsWith("DA:")) {
      const [n, hits] = line.slice(3).split(",");
      const ln = Number(n);
      if (Number.isFinite(ln)) file.lines.set(ln, Number(hits) || 0);
    } else if (line.startsWith("BRDA:")) {
      // BRDA:<line>,<block>,<branch>,<taken>   taken is "-" when never reached
      const parts = line.slice(5).split(",");
      const ln = Number(parts[0]);
      const taken = parts[3] === "-" ? 0 : Number(parts[3]) || 0;
      if (!Number.isFinite(ln)) continue;
      const list = file.branches.get(ln) ?? [];
      list.push(taken);
      file.branches.set(ln, list);
    } else if (line === "end_of_record") {
      file = null;
    }
  }
  return out;
}

/** Paths differ by prefix and separator between tools; compare by suffix. */
export function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Find a file's coverage, matching by the longest shared path suffix.
 *
 * Coverage is reported against whatever the tests ran — compiled output, an
 * absolute path, a path relative to a different root. The ledger holds project
 * paths. Requiring them to be equal would make this check impossible to satisfy
 * on any project with a build step, which is most of them.
 */
export function coverageFor(cov: Coverage, path: string): FileCoverage | null {
  const want = normalise(path);
  const direct = cov.get(want);
  if (direct) return direct;
  const wantParts = want.split("/");
  let best: FileCoverage | null = null;
  let bestScore = 0;
  for (const [key, value] of cov) {
    const keyParts = key.split("/");
    let score = 0;
    while (
      score < wantParts.length &&
      score < keyParts.length &&
      wantParts[wantParts.length - 1 - score] === keyParts[keyParts.length - 1 - score]
    ) {
      score++;
    }
    // One shared segment is a filename collision, not a match.
    if (score > bestScore && score >= 2) {
      bestScore = score;
      best = value;
    }
  }
  return best;
}

export type Unproven = {
  path: string;
  /** Changed lines the tests never executed. */
  deadLines: number[];
  /** Changed lines whose branches were never all taken. */
  deadBranches: number[];
};

/**
 * Which of this turn's changed lines nothing executed.
 *
 * A changed line absent from the report is not counted against the model: lcov
 * lists only what the tool considers executable, so a type, an import, or a
 * declaration simply is not there. Silence means "not instrumented", not "not
 * run", and treating the two alike would fail honest work.
 */
export function unprovenIn(
  cov: Coverage,
  path: string,
  changedLines: number[],
): Unproven | null {
  const file = coverageFor(cov, path);
  if (!file) return null;
  const deadLines: number[] = [];
  const deadBranches: number[] = [];
  for (const ln of changedLines) {
    const hits = file.lines.get(ln);
    if (hits !== undefined && hits === 0) {
      deadLines.push(ln);
      continue;
    }
    const br = file.branches.get(ln);
    // A line that ran but whose branch never went one of its ways is code
    // whose behaviour has not been shown — the guard that returns false and
    // is never tripped.
    if (br && br.length > 0 && br.some((n) => n === 0)) deadBranches.push(ln);
  }
  if (deadLines.length === 0 && deadBranches.length === 0) return null;
  return { path, deadLines, deadBranches };
}
