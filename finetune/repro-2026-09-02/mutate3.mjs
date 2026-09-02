import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const M = [
  ["tree-accounted: outside is refused", "dist-test/src/bar.js", "if (outside.length === 0) {", "if (true) {", "tree-accounted", "is refused, and the assertion it deleted"],
  ["tree-accounted: deletions seen", "dist-test/src/bar.js", "...diff.deleted.filter((p) => !accounted.has(p)).map((p) => `${p} (deleted)`),", "", "tree-accounted", "names sed, cp and rm routes too"],
  ["tree-accounted: fails closed on truncation", "dist-test/src/bar.js", "snap.truncated\n        ?", "false\n        ?", "tree-accounted", "fails closed"],
  ["spec-intact: disk route", "dist-test/src/bar.js", "if (ctx.treeBefore && !ctx.treeBefore.truncated) {\n            for (const [path, before] of ctx.treeBefore.assertions) {", "if (false) {\n            for (const [path, before] of ctx.treeBefore.assertions) {", "tree-accounted", "is refused, and the assertion it deleted"],
  ["engine: snapshot taken at turn start", "dist-test/src/engine.js", "this.turnTree = snapshotTree(this.cwd);", "this.turnTree = null;", "tree-accounted", "is refused, and the assertion it deleted"],
  ["stats: answered not counted", "dist-test/src/receipts.js", "if (r.ask)\n                    answered += 1;", "if (false)\n                    answered += 1;", "stats-honesty", "does not count an accepted answer"],
  ["stats: priced denominator", "dist-test/src/receipts.js", "pricedVerified && totalUsd !== undefined ? totalUsd / pricedVerified : undefined", "accepted && totalUsd !== undefined ? totalUsd / accepted : undefined", "stats-honesty", "divides priced dollars"],
  ["stats: one file one row", "dist-test/src/receipts.js", "byFile.set(r.file, r);", "byFile.set(r.file + Math.random(), r);", "stats-honesty", "reissued sequence"],
  ["engine: answered outcome", "dist-test/src/engine.js", "? \"answered\"\n                        : \"verified\"", "? \"verified\"\n                        : \"verified\"", "stats-honesty", "does not count an accepted answer"],
  ["cli: criteria reach the engine", "dist-test/src/cli.js", "return taskChecksFrom({ checks: args.criteria ?? [], notes: args.notes ?? [] });", "return taskChecksFrom({ checks: [], notes: args.notes ?? [] });", "stats-honesty", "reaches the engine"],
  ["commands: attempts setter", "dist-test/src/session-commands.js", "engine.setMaxProofAttempts(n);", "", "stats-honesty", "sets and reports them"],
];
let bad = 0;
for (const [label, file, old, neu, testFile, testName] of M) {
  const orig = readFileSync(file, "utf8");
  const n = orig.split(old).length - 1;
  if (n !== 1) { console.log(`?? ${label}: pattern found ${n}x in ${file}`); bad++; continue; }
  writeFileSync(file, orig.replace(old, () => neu));
  try {
    const r = spawnSync("node", ["--test", `dist-test/test/${testFile}.test.js`], { encoding: "utf8" });
    const out = r.stdout + r.stderr;
    const fails = Number(/^ℹ fail (\d+)/m.exec(out)?.[1] ?? -1);
    const named = out.split("\n").some((l) => l.includes("✖") && l.includes(testName));
    const ok = fails > 0 && named; if (!ok) bad++;
    console.log(`${ok ? "RED " : "STILL GREEN"}  ${label.padEnd(42)} fails=${fails} named=${named}`);
  } finally { writeFileSync(file, orig); }
}
console.log(bad === 0 ? "every fix has a test that goes red without it" : `${bad} mutation(s) did not go red`);
process.exit(bad ? 1 : 0);
