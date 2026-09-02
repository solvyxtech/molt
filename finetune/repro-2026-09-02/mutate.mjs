// Break each fix, run its test, expect red, restore. Reports one line per mutation.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const M = [
  ["integrity: journal-root drift", "dist-test/src/integrity.js", "} else if (!heads.has(bound)) {", "} else if (false && !heads.has(bound)) {", "integrity", "catches a journal rewritten"],
  ["integrity: verifyProject includes journals", "dist-test/src/integrity.js", "ok: ledger.ok && journals.every((j) => j.ok),", "ok: ledger.ok,", "integrity", "gives every surface one verdict"],
  ["journal: unparseable lines", "dist-test/src/journal.js", "if (unparsed > 0 && !tolerated) {", "if (false) {", "journal", "does not call a log whose lines"],
  ["bar: turn must write", "dist-test/src/bar.js", "if (ctx.turnLedger !== undefined && ctx.turnLedger.length === 0) {", "if (ctx.turnLedger !== undefined && ctx.turnLedger.length === -1) {", "record-scope", "refuses a second turn"],
  ["bar: damaged evidence", "dist-test/src/bar.js", "if (damaged.length > 0) {", "if (damaged.length > 1e9) {", "archive-verification", "unreadable evidence block"],
  ["bar: cancelled result", "dist-test/src/bar.js", "...(aborted() ? { cancelled: true } : {}),", "", "record-scope", "marks a bar result cancelled"],
  ["engine: cancelled bar ends turn", "dist-test/src/engine.js", "if (result.cancelled) {", "if (false) {", "record-scope", "ends the turn as cancelled"],
  ["engine: did per turn", "dist-test/src/engine.js", "this.did = [];", "", "record-scope", "lists on a receipt only what this turn ran"],
  ["engine: shed journalled in shed()", "dist-test/src/engine.js", 'this.cfg.journal?.append("shed", {', "void ({", "record-scope", "records a shed made by hand"],
  ["config: sourceMap", "tsconfig.test.json", '"sourceMap": true', '"sourceMap": false', "coverage", "source coordinates"],
  ["config: tests watch", ".molt/done.yml", '"electron/**", ', "", "record-scope", "tests watch covers"],
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
    const ok = fails > 0 && named;
    if (!ok) bad++;
    console.log(`${ok ? "RED " : "STILL GREEN"}  ${label.padEnd(40)} fails=${fails} named=${named}`);
  } finally {
    writeFileSync(file, orig);
  }
}
console.log(bad === 0 ? "every fix has a test that goes red without it" : `${bad} mutation(s) did not go red`);
process.exit(bad === 0 ? 0 : 1);
