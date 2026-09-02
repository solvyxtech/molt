// Repro H: the bar judges the SESSION's ledger, so turn 2 is accepted on turn 1's write.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
import { Engine } from "/Users/control/Documents/molt-desktop/dist/engine.js";
import { parseBar } from "/Users/control/Documents/molt-desktop/dist/bar.js";
import { Receipts } from "/Users/control/Documents/molt-desktop/dist/receipts.js";
import { Archive } from "/Users/control/Documents/molt-desktop/dist/archive.js";
import { scripted, drain } from "./fake.mjs";
const dir = mkdtempSync(join(tmpdir(), "molt-h-"));
const bar = parseBar("version: 1\nchecks:\n  - name: work-landed\n    builtin: files-changed\n  - name: spec-intact\n    builtin: spec-intact\n");
const p = scripted([
  { calls: [{ name: "write_file", args: { path: "src/a.js", content: "export const a = 1 > 0;\n" } }] },
  { text: "Turn 1: added src/a.js." },
  { text: "Turn 2: I refactored the auth module and all tests pass." },   // touches nothing
]);
const engine = new Engine({ baseUrl: "http://mock/v1", model: "m", provider: "mock", cwd: dir, fetchFn: p.fetchFn, bar, archive: new Archive(dir), receipts: new Receipts(dir), stream: false, autonomy: "high" });
const t1 = await drain(engine.run("add a file", async () => true));
console.log("turn 1 outcome:", t1.find((e) => e.kind === "job_end").outcome);
const t2 = await drain(engine.run("refactor the auth module", async () => true));
console.log("turn 2 outcome:", t2.find((e) => e.kind === "job_end").outcome, "— wrote nothing this turn");
const pr = t2.find((e) => e.kind === "proof_result" || e.kind === "proof_exhausted");
for (const r of pr.result.results) console.log(`  ${r.name.padEnd(13)} ${r.ok ? "pass" : "FAIL"}  ${r.output.split("\n")[0].slice(0, 90)}`);
const files = readdirSync(join(dir, ".molt/receipts")).filter((f) => f.endsWith(".md")).sort();
console.log("receipts:", files.join(", "));
const last = readFileSync(join(dir, ".molt/receipts", files.at(-1)), "utf8");
console.log(last.split("\n").slice(0, 3).join(" | "));
console.log(last.match(/## What the model changed[\s\S]*?(?=## What was checked)/)?.[0].trim().split("\n").filter((l) => l.startsWith("|")).join("\n"));
