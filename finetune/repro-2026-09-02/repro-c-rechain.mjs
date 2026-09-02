// Repro C: rewrite a journal entry, re-chain it, and see whether `molt verify` — including the
// integrity ledger that "binds the journal root" — notices.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const root = process.argv[2];
const file = root + "/.molt/log/cc9e4d49.jsonl";
const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const hashEntry = (e) => createHash("sha256").update(JSON.stringify({ seq: e.seq, iso: e.iso, kind: e.kind, data: e.data, prev: e.prev })).digest("hex");
// Flip the first bar_run from ok:true to ok:false — the exact "one bar result" edit transparency.md says the chain rules out.
const i = entries.findIndex((e) => e.kind === "bar_run");
console.log("editing entry", entries[i].seq, "bar_run ok:", entries[i].data.ok, "->", !entries[i].data.ok);
entries[i].data.ok = !entries[i].data.ok;
entries[i].data.passed = 0;
let prev = "0".repeat(64);
for (const e of entries) { e.prev = prev; e.hash = hashEntry(e); prev = e.hash; }
writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log("re-chained", entries.length, "entries; new head", prev.slice(0, 12));
// What the integrity ledger bound for this session:
const led = readFileSync(root + "/.molt/integrity/ledger.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const roots = led.filter((r) => r.data.session === "cc9e4d49").map((r) => r.data.journalRoot.slice(0, 12));
const heads = new Set(entries.map((e) => e.hash.slice(0, 12)));
console.log("ledger-bound journalRoots for cc9e4d49:", roots.join(", "));
console.log("of which still present as an entry hash in the re-chained journal:", roots.filter((r) => heads.has(r)).length, "of", roots.length);
