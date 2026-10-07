/**
 * finetune/extract.mjs leaves out every attempt an xAI model touched.
 *
 * xAI's Acceptable Use Policy forbids using its output to develop machine
 * learning models. A run carries that output when Grok did the work, and
 * equally when Grok was the judge: the drafted checks and the review are its
 * words, and the training target is built from them.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const EXTRACT = resolve("finetune", "extract.mjs");

function receipt(seq: number, meta: Record<string, string>): string {
  return [
    `# Maat receipt ${String(seq).padStart(4, "0")} — accepted`,
    "",
    "## What the model claimed",
    "",
    `> claim ${seq}`,
    "",
    "## What was checked, and what it established",
    "",
    "| check | verdict | established | ms |",
    "|---|---|---|---|",
    "| task:works | pass | it works | 5 |",
    "",
    "---",
    "",
    "## Session",
    "",
    `- when: 2026-10-07T00:00:0${seq}.000Z`,
    `- attempt: 1`,
    ...Object.entries(meta).map(([k, v]) => `- ${k}: ${v}`),
    "- session tokens: 10",
    "",
  ].join("\n");
}

const cases: { name: string; meta: Record<string, string>; kept: boolean }[] = [
  { name: "clean", meta: { provider: "openrouter", model: "inception/mercury-2.5" }, kept: true },
  { name: "clean-judge", meta: { provider: "openrouter", model: "inception/mercury-2.5", judge: "opencode/big-pickle at opencode://zen" }, kept: true },
  { name: "grok-worker-plan", meta: { provider: "grok-build", model: "grok-4.7" }, kept: false },
  { name: "grok-worker-reseller", meta: { provider: "openrouter", model: "x-ai/grok-4.1-fast" }, kept: false },
  { name: "grok-judge-model", meta: { provider: "openrouter", model: "inception/mercury-2.5", judge: "x-ai/grok-4.1-fast at https://openrouter.ai/api/v1" }, kept: false },
  { name: "grok-judge-plan", meta: { provider: "openrouter", model: "inception/mercury-2.5", judge: "grok-4.7 at grok-build://subscription" }, kept: false },
  { name: "xai-judge-api", meta: { provider: "openrouter", model: "inception/mercury-2.5", judge: "some-model at https://api.x.ai/v1" }, kept: false },
  { name: "grok-judge-same-endpoint", meta: { provider: "openrouter", model: "inception/mercury-2.5", judge: "x-ai/grok-code-fast-1" }, kept: false },
];

describe("finetune/extract.mjs excludes xAI output", () => {
  const dir = mkdtempSync(join(tmpdir(), "maat-extract-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "proj");
  const out = join(dir, "out");
  mkdirSync(join(root, ".maat", "receipts"), { recursive: true });
  cases.forEach((c, i) => writeFileSync(join(root, ".maat", "receipts", `${String(i + 1).padStart(4, "0")}-${c.name}.md`), receipt(i + 1, c.meta)));

  const run = spawnSync(process.execPath, [EXTRACT, "--out", out, root], { encoding: "utf8" });

  it("runs", () => {
    assert.equal(run.status, 0, run.stderr);
  });

  it("keeps only attempts where neither the worker nor the judge was a Grok/xAI model", () => {
    const rows = readFileSync(join(out, "records.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { provenance: { receipt: string } });
    const kept = rows.map((r) => r.provenance.receipt.replace(/^\d{4}-|\.md$/g, "")).sort();
    assert.deepEqual(kept, cases.filter((c) => c.kept).map((c) => c.name).sort());
  });

  it("leaves no trace of an excluded attempt in any split", () => {
    for (const f of ["records.jsonl", "train.jsonl", "valid.jsonl", "train.provenance.jsonl"]) {
      const text = readFileSync(join(out, f), "utf8");
      assert.doesNotMatch(text, /grok|x\.ai/i, f);
    }
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { excludedReceipts: number };
    assert.equal(manifest.excludedReceipts, cases.filter((c) => !c.kept).length);
  });
});
