// Repro D: what does record-intact notice about a damaged exuvia, in a later process?
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCheck } from "/Users/control/Documents/molt-desktop/dist/bar.js";
import { Archive } from "/Users/control/Documents/molt-desktop/dist/archive.js";
import { Journal } from "/Users/control/Documents/molt-desktop/dist/journal.js";
const src = "/Users/control/Documents/molt-desktop/.molt";
async function check(label, mutate) {
  const root = mkdtempSync(join(tmpdir(), "molt-ri-"));
  cpSync(src, join(root, ".molt"), { recursive: true });
  const ex = join(root, ".molt/exuviae/0011-2026-08-25T16-46-50-039Z.md");
  mutate(ex);
  // Exactly what Engine.barContext supplies for a fresh session that has shed nothing.
  const ctx = { cwd: root, record: [], ledger: [], liveLedger: [], archive: new Archive(root),
    archivedBatches: 0, expectedArchivedWrites: 0, sessionArchives: new Set(),
    expectedArchiveFiles: Journal.expectedArchives(root) };
  const r = await runCheck({ name: "record-intact", kind: "builtin", builtin: "record-intact", tags: [] }, ctx);
  console.log(`${label.padEnd(52)} -> ${r.ok ? "PASS" : "FAIL"}: ${r.output.split("\n")[0].slice(0, 110)}`);
  rmSync(root, { recursive: true, force: true });
}
await check("untouched", () => {});
await check("exuvia deleted", (f) => rmSync(f));
await check("ledger block JSON corrupted (evidence unreadable)", (f) => writeFileSync(f, readFileSync(f, "utf8").replace("```molt-ledger\n[", "```molt-ledger\n[GARBAGE")));
await check("ledger `after` hash edited", (f) => writeFileSync(f, readFileSync(f, "utf8").replace(/"after": "[0-9a-f]{12}/, '"after": "deadbeefdead')));
await check("whole body replaced by one heading", (f) => writeFileSync(f, "## nothing here\n"));
await check("whole body replaced by garbage (no heading)", (f) => writeFileSync(f, "garbage\n"));
