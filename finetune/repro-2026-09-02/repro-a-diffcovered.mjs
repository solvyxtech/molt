// Repro A: diff-covered cannot match any src/*.ts against the lcov the suite writes.
import { readFileSync } from "node:fs";
import { parseLcov, coverageFor } from "/Users/control/Documents/molt-desktop/dist/coverage.js";
const cov = parseLcov(readFileSync("/Users/control/Documents/molt-desktop/coverage/lcov.info", "utf8"));
console.log("lcov files:", cov.size);
for (const p of ["src/bar.ts", "src/files.ts", "src/engine.ts", "electron/run-options.ts", "test/bar.test.ts", "src/bar.js"]) {
  const f = coverageFor(cov, p);
  console.log(p.padEnd(26), f ? `MATCHED (${f.lines.size} lines)` : "NO MATCH");
}
