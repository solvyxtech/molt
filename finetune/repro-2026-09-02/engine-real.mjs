// R4 (two turns, one session) and R5 (ctrl+C during a bar check), through the engine both
// surfaces share, against the real provider. Uses the FIXED copy's build.
import { mkdtempSync, mkdirSync, readdirSync, existsSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
const D = "/private/tmp/claude-503/-Users-control/3246bbe8-ab78-4502-9525-67e79e246409/scratchpad/fixed/dist";
const { Engine } = await import(`${D}/engine.js`); const { parseBar } = await import(`${D}/bar.js`);
const { Receipts } = await import(`${D}/receipts.js`); const { Journal } = await import(`${D}/journal.js`); const { keyForUrl } = await import(`${D}/providers.js`);
const url = "https://openrouter.ai/api/v1", model = "inception/mercury-2.5-preview", apiKey = keyForUrl(url, undefined);
const yes = async () => true;
const receipts = (dir) => { const d = join(dir, ".molt/receipts"); return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")).sort() : []; };
const last = (evs) => evs.findLast((e) => e.kind === "proof_result" || e.kind === "proof_refused" || e.kind === "proof_exhausted");
async function drain(gen, onEv) { const out = []; for await (const ev of gen) { out.push(ev); onEv?.(ev); } return out; }

console.log("=== R4: two turns, one session (real provider) ===");
{
  const dir = mkdtempSync(join(tmpdir(), "molt-r4-"));
  const bar = parseBar("version: 1\nchecks:\n  - name: work-landed\n    builtin: files-changed\n  - name: spec-intact\n    builtin: spec-intact\n");
  const e = new Engine({ baseUrl: url, apiKey, model, provider: "openrouter", cwd: dir, bar, receipts: new Receipts(dir), journal: new Journal(dir, "r4"), autonomy: "high", maxProofAttempts: 2 });
  const t1 = await drain(e.run("Create a file named notes.txt containing the single word hello, then say you are done.", yes));
  console.log("turn 1:", t1.at(-1).outcome, "| bar:", last(t1)?.result.results.map((r) => `${r.name}=${r.ok ? "pass" : "FAIL"}`).join(" "));
  const t2 = await drain(e.run("Everything is already finished. Do not call any tool. Just reply that the work is done.", yes));
  const b2 = last(t2);
  console.log("turn 2:", t2.at(-1).outcome, "| bar:", b2?.result.results.map((r) => `${r.name}=${r.ok ? "pass" : "FAIL"}`).join(" "));
  console.log("turn 2 work-landed said:", JSON.stringify(b2?.result.results[0]?.output.split("\n")[0].slice(0, 110)));
  console.log("receipts:", receipts(dir).join(", "), "| tokens:", e.sessionTokens, "| cost:", e.costUsd());
}

console.log("\n=== R5: ctrl+C during a bar check (real provider for the claim) ===");
{
  const dir = mkdtempSync(join(tmpdir(), "molt-r5-"));
  mkdirSync(join(dir, "src"));
  const bar = parseBar("version: 1\nchecks:\n  - name: slow-suite\n    run: sleep 8\n    watch: [\"src/**\"]\n  - name: quick\n    run: \"true\"\n");
  const journal = new Journal(dir, "r5");
  const e = new Engine({ baseUrl: url, apiKey, model, provider: "openrouter", cwd: dir, bar, receipts: new Receipts(dir), journal, autonomy: "high" });
  const t0 = Date.now(); const seen = [];
  await drain(e.run("Write the word hi into src/a.txt, then say you are done.", yes), (ev) => {
    seen.push(ev.kind);
    if (ev.kind === "proof_start") setTimeout(() => { console.log(`  [ctrl+C at +${Date.now() - t0}ms, during slow-suite]`); e.cancel(); }, 500);
  });
  console.log("events:", seen.filter((k) => !["delta", "usage", "request", "message_end"].includes(k)).join(" "));
  console.log("receipts:", receipts(dir).length ? receipts(dir).join(", ") : "(none)", "| journal has cancelled:", Journal.read(journal.path).some((x) => x.kind === "cancelled"));
  const again = await e.proveNow();
  console.log("proveNow slow-suite:", again.results[0].ok ? "pass" : "FAIL", again.results[0].cached ? "(reused)" : "(fresh)", "| took", Date.now() - t0, "ms total");
}
