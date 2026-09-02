// Repro L: an ask turn that wrote nothing cannot be refused, is "verified", and gets an accepted receipt.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
import { Engine } from "/Users/control/Documents/molt-desktop/dist/engine.js";
import { parseBar } from "/Users/control/Documents/molt-desktop/dist/bar.js";
import { Receipts } from "/Users/control/Documents/molt-desktop/dist/receipts.js";
import { scripted, drain } from "./fake.mjs";
const dir = mkdtempSync(join(tmpdir(), "molt-l-"));
const bar = parseBar("version: 1\nchecks:\n  - name: tests\n    run: \"false\"\n  - name: work-landed\n    builtin: files-changed\n");
const p = scripted([{ text: "Yes — the suite passes and the project is healthy." }]);
const engine = new Engine({ baseUrl: "http://mock/v1", model: "m", provider: "mock", cwd: dir, fetchFn: p.fetchFn, bar, receipts: new Receipts(dir), stream: false });
const ev = await drain(engine.run("does the test suite pass?", async () => true, { ask: true, taskChecks: [{ name: "grep-proof", kind: "command", run: "false", timeoutMs: 1000, expectExit: 0, tags: [] }] }));
console.log("outcome:", ev.find((e) => e.kind === "job_end").outcome);
const pr = ev.find((e) => e.kind === "proof_result");
console.log("bar ok:", pr.result.ok, "warnings:", (pr.result.warnings ?? []).map((w) => w.name).join(", "));
const f = readdirSync(join(dir, ".molt/receipts")).find((x) => x.endsWith(".md"));
console.log("receipt:", f, "|", readFileSync(join(dir, ".molt/receipts", f), "utf8").split("\n")[2]);
const stats = new Receipts(dir).stats();
console.log("stats:", JSON.stringify({ accepted: stats.accepted, falseClaimRate: stats.falseClaimRate, tokensPerVerifiedChange: stats.tokensPerVerifiedChange }));
