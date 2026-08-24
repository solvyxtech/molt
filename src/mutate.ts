/**
 * Breaking a line on purpose, to find out whether anything would notice.
 *
 * The last rung. `diff-covered` proves a line is executed; it cannot prove
 * anything *checks* what the line does. A test that runs code while asserting
 * nothing satisfies coverage completely, and a line covered that way is exactly
 * as unproven as one never run — the difference is that coverage says it is
 * fine.
 *
 * The only mechanical answer is to break the line and see if the suite goes
 * red. That is the discipline used by hand throughout this project's history,
 * and it has caught real things every time it was applied — including two
 * occasions where a mutation was written, silently failed to apply, and the
 * green run that followed meant nothing. Which is why `mutate` returns the
 * changed text and the caller verifies it differs before trusting a result.
 *
 * Operators are deliberately few and syntax-preserving. An ambitious mutator
 * that produces code which does not compile reports a false positive on every
 * line, and a check that is wrong often gets switched off.
 */

export type Mutation = { line: number; before: string; after: string; operator: string };

/**
 * Swaps that change behaviour without changing shape.
 *
 * Ordered: the first that applies to a line is the one used. Comparison
 * operators come first because a boundary is where the interesting mistakes
 * are, and a test that pins behaviour usually pins it there.
 */
const OPERATORS: { name: string; find: RegExp; swap: (m: string) => string }[] = [
  { name: ">= to >", find: /(?<![<>=!])>=(?!=)/, swap: () => ">" },
  { name: "<= to <", find: /(?<![<>=!])<=(?!=)/, swap: () => "<" },
  { name: "> to >=", find: /(?<![<>=!-])>(?![=>])/, swap: () => ">=" },
  { name: "< to <=", find: /(?<![<>=!])<(?![=<])/, swap: () => "<=" },
  { name: "=== to !==", find: /===/, swap: () => "!==" },
  { name: "!== to ===", find: /!==/, swap: () => "===" },
  { name: "&& to ||", find: /&&/, swap: () => "||" },
  { name: "|| to &&", find: /\|\|/, swap: () => "&&" },
  { name: "true to false", find: /\btrue\b/, swap: () => "false" },
  { name: "false to true", find: /\bfalse\b/, swap: () => "true" },
];

/** Lines that cannot be usefully broken, and would only waste a suite run. */
function skippable(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  if (/^(\/\/|#|\*|\/\*)/.test(t)) return true;
  // An import's behaviour is not the thing under test, and breaking one
  // produces a compile error rather than a red assertion.
  if (/^(import|export)\s/.test(t) && !/[<>=!&|]/.test(t)) return true;
  return false;
}

/**
 * Break one line, or return null if there is nothing to break.
 *
 * Null is a normal outcome, not a failure: plenty of real lines have no
 * operator to flip. The caller reports those as unmutated rather than counting
 * them against anyone.
 */
export function mutateLine(line: string): { after: string; operator: string } | null {
  if (skippable(line)) return null;
  for (const op of OPERATORS) {
    if (!op.find.test(line)) continue;
    const after = line.replace(op.find, op.swap);
    // A swap that changed nothing is not a mutation. Guarding here is what
    // stops a "mutation applied, tests still green" result that means only
    // that no mutation was applied — the exact way this discipline has been
    // fooled before.
    if (after === line) continue;
    return { after, operator: op.name };
  }
  return null;
}

/**
 * Choose which of a turn's changed lines to break.
 *
 * Spread across files rather than concentrated, because a check that spends
 * its whole budget on one file says nothing about the rest. Each mutation
 * costs a full run of the command, so the sample is small and the report says
 * plainly how much was left unexamined — a bound nobody is told about reads as
 * completeness.
 */
export function planMutations(
  files: { path: string; text: string; changedLines: number[] }[],
  sample: number,
): Mutation[] {
  const perFile = files.map((f) => {
    const lines = f.text.split("\n");
    const out: Mutation[] = [];
    for (const ln of f.changedLines) {
      const src = lines[ln - 1];
      if (src === undefined) continue;
      const m = mutateLine(src);
      if (m) out.push({ line: ln, before: src, after: m.after, operator: m.operator });
    }
    return { path: f.path, candidates: out };
  });

  const chosen: Mutation[] = [];
  let round = 0;
  while (chosen.length < sample) {
    let took = false;
    for (const f of perFile) {
      const next = f.candidates[round];
      if (!next) continue;
      chosen.push({ ...next, ...{ path: f.path } } as Mutation & { path: string });
      took = true;
      if (chosen.length >= sample) break;
    }
    if (!took) break;
    round++;
  }
  return chosen;
}

/** Apply a mutation to a file's text, or null if the line no longer matches. */
export function applyMutation(text: string, m: Mutation): string | null {
  const lines = text.split("\n");
  if (lines[m.line - 1] !== m.before) return null;
  lines[m.line - 1] = m.after;
  return lines.join("\n");
}
