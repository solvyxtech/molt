import { runCheck } from "/Users/control/Documents/molt-desktop/dist/bar.js";
const ctx = { cwd: "/Users/control/Documents/molt-desktop", record: [], ledger: [
  { path: "src/bar.ts", before: "a", after: "b", callId: "c1", substance: 3, changedLines: [1, 2, 3] },
], archivedBatches: 0 };
const r = await runCheck({ name: "work-proven", kind: "builtin", builtin: "diff-covered", tags: [], lcov: "coverage/lcov.info" }, ctx);
console.log(JSON.stringify({ ok: r.ok, output: r.output }, null, 1));
// And with a line that is provably NEVER executed anywhere (line 1_000_000):
const ctx2 = { ...ctx, ledger: [{ path: "src/bar.ts", before: "a", after: "b", callId: "c1", substance: 1, changedLines: [1000000] }] };
const r2 = await runCheck({ name: "work-proven", kind: "builtin", builtin: "diff-covered", tags: [], lcov: "coverage/lcov.info" }, ctx2);
console.log(JSON.stringify({ ok: r2.ok, output: r2.output }, null, 1));
