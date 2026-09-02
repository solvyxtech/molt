// Repro B: `tests` watch omits electron/** and ui/**, which the suite compiles and tests.
import { CheckCache } from "/Users/control/Documents/molt-desktop/dist/bar.js";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = mkdtempSync(join(tmpdir(), "molt-stale-"));
for (const d of ["src", "test", "electron", "ui"]) mkdirSync(join(root, d));
writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
writeFileSync(join(root, "test/a.test.ts"), "import '../electron/criteria.js';\n");
writeFileSync(join(root, "electron/criteria.ts"), "export const x = 1;\n");
writeFileSync(join(root, "package.json"), "{}");
const tests = { name: "tests", kind: "command", run: "npm test", timeoutMs: 1, expectExit: 0, tags: [],
  watch: ["src/**", "test/**", "tsconfig*.json", "package.json"] };  // verbatim from .molt/done.yml
const cache = new CheckCache();
cache.put(tests, root, { name: "tests", kind: "command", detail: "npm test", ok: true, exitCode: 0, output: "`npm test` exited 0", durationMs: 17000 });
// A turn now changes electron/criteria.ts — a file the suite compiles (tsconfig.test.json) and tests (desktop-shell.test.ts).
await new Promise((r) => setTimeout(r, 20));
writeFileSync(join(root, "electron/criteria.ts"), "export const x = 2; // behaviour changed\n");
const reused = cache.get(tests, root);
console.log("after editing electron/criteria.ts, tests result reused?", reused ? `YES (cached=${reused.cached}, ok=${reused.ok})` : "no — re-run");
// Control: the same edit under src/ invalidates.
writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
console.log("after editing src/a.ts, tests result reused?", cache.get(tests, root) ? "YES" : "no — re-run");
