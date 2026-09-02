import { readFileSync } from "node:fs";
import { runCheck } from "/Users/control/Documents/molt-desktop/dist/bar.js";
const { dead, live } = JSON.parse(readFileSync(process.argv[2] + "/lines.json", "utf8"));
const src = readFileSync("/Users/control/Documents/molt-desktop/src/bar.ts", "utf8").split("\n");
console.log(`src/bar.ts:${dead} (never executed) = ${JSON.stringify(src[dead - 1].trim().slice(0, 60))}`);
for (const [label, lines] of [["dead line", [dead]], ["live line", [live]]]) {
  const ctx = { cwd: "/Users/control/Documents/molt-desktop", record: [], ledger: [{ path: "src/bar.ts", before: "a", after: "b", callId: "c", substance: 1, changedLines: lines }], archivedBatches: 0 };
  const r = await runCheck({ name: "work-proven", kind: "builtin", builtin: "diff-covered", tags: [], lcov: "coverage/lcov.info" }, ctx);
  console.log(`${label.padEnd(10)} -> ${r.ok ? "pass" : "FAIL"}: ${r.output.split("\n").slice(0, 2).join(" / ").slice(0, 120)}`);
}
