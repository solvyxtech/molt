// Repro G: what runs unattended at each level, for commands that write around the ledger.
import { gate } from "/Users/control/Documents/molt-desktop/dist/autonomy.js";
const cwd = "/Users/control/Documents/molt-desktop";
const cmds = [
  "sed -i '' 's/timeout: 300/timeout: 1/' .molt/done.yml",
  "sed -i '' 's/assert.equal(r.ok, true)/assert.equal(r.ok, false)/' test/bar.test.ts",
  "node scratch.cjs",
  "cp /dev/null test/bar.test.ts",
  "mv test/bar.test.ts test/bar.test.ts.bak",
  "git stash",
  "git checkout main",
  "perl -pi -e 's/true/false/' test/bar.test.ts",
  "printf x >> test/bar.test.ts",
];
for (const level of ["medium", "high"]) {
  console.log(`== ${level}`);
  for (const command of cmds) {
    const d = gate(level, { name: "bash", args: { command }, cwd });
    console.log(`  ${d.ask ? "ASK " : "RUN "} ${command}${d.why ? `   (${d.why})` : ""}`);
  }
}
