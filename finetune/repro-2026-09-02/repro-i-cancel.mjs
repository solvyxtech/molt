// Repro I: ctrl+C while a bar check is running.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
import { Engine } from "/Users/control/Documents/molt-desktop/dist/engine.js";
import { parseBar } from "/Users/control/Documents/molt-desktop/dist/bar.js";
import { Receipts } from "/Users/control/Documents/molt-desktop/dist/receipts.js";
import { Journal } from "/Users/control/Documents/molt-desktop/dist/journal.js";
import { scripted } from "./fake.mjs";
const dir = mkdtempSync(join(tmpdir(), "molt-i-"));
const bar = parseBar("version: 1\nchecks:\n  - name: slow-suite\n    run: sleep 3\n    watch: [\"src/**\"]\n  - name: quick\n    run: \"true\"\n");
const p = scripted([
  { calls: [{ name: "write_file", args: { path: "src/a.js", content: "x\n" } }] },
  { text: "done" },
  { text: "done again" },
]);
const journal = new Journal(dir);
const engine = new Engine({ baseUrl: "http://mock/v1", model: "m", provider: "mock", cwd: dir, fetchFn: p.fetchFn, bar, receipts: new Receipts(dir), journal, stream: false, autonomy: "high", maxProofAttempts: 4 });
const seen = [];
const t0 = Date.now();
let cancelled = false;
for await (const ev of engine.run("do it", async () => true)) {
  seen.push(ev.kind + (ev.kind === "proof_start" ? "" : ""));
  if (ev.kind === "proof_start" && !cancelled) { cancelled = true; setTimeout(() => { console.log(`  [user presses ctrl+C at +${Date.now() - t0}ms, during slow-suite]`); engine.cancel(); }, 300); }
  if (ev.kind === "proof_refused" || ev.kind === "proof_result" || ev.kind === "proof_exhausted") {
    console.log(`  ${ev.kind} at +${Date.now() - t0}ms:`);
    for (const r of ev.result.results) console.log(`    ${r.name.padEnd(11)} ${r.ok ? "pass" : "FAIL"}${r.cached ? " (reused)" : ""}  exit=${r.exitCode}  ${r.output.split("\n")[0].slice(0, 70)}`);
  }
}
console.log("events:", seen.join(" "));
console.log("provider calls after cancel:", p.calls, "(2 before the first claim)");
console.log("receipts written:", readdirSync(join(dir, ".molt/receipts")).filter((f) => f.endsWith(".md")).join(", "));
const j = Journal.read(journal.path).map((e) => e.kind);
console.log("journal kinds:", j.join(" "));
console.log("journal has a `cancelled` entry:", j.includes("cancelled"));
// After the cancelled turn: is the killed check remembered as a failure?
const again = await engine.proveNow();
for (const r of again.results) console.log(`  proveNow: ${r.name.padEnd(11)} ${r.ok ? "pass" : "FAIL"}${r.cached ? " (reused — nothing it watches moved)" : " (fresh)"} exit=${r.exitCode}`);
