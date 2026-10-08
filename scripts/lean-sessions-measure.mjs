#!/usr/bin/env node
/**
 * Measure the lean-sessions prototypes: run test/lean-sessions.test.ts once per
 * env configuration and print a markdown table of the results.
 *
 *   npx tsc -p tsconfig.test.json && node scripts/lean-sessions-measure.mjs [--json out.json]
 *
 * No model, no network: every scenario is scripted (see the test file).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONFIGS = [
  ["baseline", {}],
  // 1. the shed threshold, and the shed that frees nothing
  ["shed-at-40k", { MAAT_LEAN_SHED_AT: "40000" }],
  ["shed-at-30k", { MAAT_LEAN_SHED_AT: "30000" }],
  ["shed-at-20k", { MAAT_LEAN_SHED_AT: "20000" }],
  ["shed-minfree", { MAAT_LEAN_SHED_MINFREE: "0.25" }],
  // 2. ageing older results (and 3. long arguments)
  ["age", { MAAT_LEAN_AGE: "1" }],
  ["age+args", { MAAT_LEAN_AGE: "1", MAAT_LEAN_AGE_ARGS: "1" }],
  ["age+args-keep4-batch12k", { MAAT_LEAN_AGE: "keep=4,batch=12000", MAAT_LEAN_AGE_ARGS: "1" }],
  ["age+args-batch48k", { MAAT_LEAN_AGE: "batch=48000", MAAT_LEAN_AGE_ARGS: "1" }],
  ["soft-shed-30k", { MAAT_LEAN_AGE: "at=30000,batch=0", MAAT_LEAN_AGE_ARGS: "1" }],
  ["soft-shed-20k", { MAAT_LEAN_AGE: "at=20000,batch=0", MAAT_LEAN_AGE_ARGS: "1" }],
  // superseded output
  ["supersede", { MAAT_LEAN_SUPERSEDE: "1" }],
  // together
  ["shed-at-30k+minfree+supersede", { MAAT_LEAN_SHED_AT: "30000", MAAT_LEAN_SHED_MINFREE: "0.25", MAAT_LEAN_SUPERSEDE: "1" }],
  ["all (age+args, supersede, minfree)", { MAAT_LEAN_AGE: "1", MAAT_LEAN_AGE_ARGS: "1", MAAT_LEAN_SUPERSEDE: "1", MAAT_LEAN_SHED_MINFREE: "0.25" }],
];

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
const dir = mkdtempSync(join(tmpdir(), "lean-sessions-"));
const all = {};
try {
  for (const [name, flags] of CONFIGS) {
    if (only && !only.includes(name)) continue;
    const out = join(dir, `${name}.json`);
    const env = { ...process.env, ...flags, LEAN_SESSIONS_OUT: out, MOLT_CONFIG_DIR: dir };
    for (const k of Object.keys(env)) if (k.startsWith("MAAT_LEAN_") && !(k in flags)) delete env[k];
    const r = spawnSync("node", ["--test", "dist-test/test/lean-sessions.test.js"], { env, encoding: "utf8" });
    const ok = r.status === 0;
    const res = JSON.parse(readFileSync(out, "utf8"));
    all[name] = { flags, ok, res };
    if (!ok) process.stderr.write(`${name}: test FAILED\n${r.stdout.slice(-3000)}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const fmt = (n) => n.toLocaleString("en-US");
const delta = (n, b) => (b ? `${n <= b ? "−" : "+"}${Math.abs(Math.round((100 * (b - n)) / b))}%` : "");
const base = all.baseline?.res;
for (const scenario of Object.keys(Object.values(all)[0].res)) {
  console.log(`\n### ${scenario}\n`);
  console.log("| config | ok | steps | largest | total chars | vs base | cache-weighted | vs base | cacheable | cache breaks | sheds | ageings |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [name, { ok, res }] of Object.entries(all)) {
    const s = res[scenario];
    if (!s) continue;
    const b = base?.[scenario];
    console.log(
      `| ${name} | ${ok ? "yes" : "NO"} | ${s.steps} | ${fmt(s.largest)} | ${fmt(s.total)} | ${b ? delta(s.total, b.total) : ""} | ${fmt(s.weighted)} | ${b ? delta(s.weighted, b.weighted) : ""} | ${(100 * s.cacheable).toFixed(1)}% | ${s.breaks.length} | ${s.sheds} | ${s.ageings} |`,
    );
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(all, null, 1));
