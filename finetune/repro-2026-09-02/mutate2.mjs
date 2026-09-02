import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const M = [
  ["integrity: journal-root drift", "dist-test/src/integrity.js", "!heads.has(bound)", "false && !heads.has(bound)", "integrity", "catches a journal rewritten"],
  ["config: tests watch", ".molt/done.yml", '"test/**", "electron/**", "ui/**", "test-run.mjs"', '"test/**", "ui/**", "test-run.mjs"', "record-scope", "tests watch covers"],
];
let bad = 0;
for (const [label, file, old, neu, testFile, testName] of M) {
  const orig = readFileSync(file, "utf8");
  const n = orig.split(old).length - 1;
  if (n !== 1) { console.log(`?? ${label}: pattern found ${n}x`); bad++; continue; }
  writeFileSync(file, orig.replace(old, () => neu));
  try {
    const out = (() => { const r = spawnSync("node", ["--test", `dist-test/test/${testFile}.test.js`], { encoding: "utf8" }); return r.stdout + r.stderr; })();
    const fails = Number(/^ℹ fail (\d+)/m.exec(out)?.[1] ?? -1);
    const named = out.split("\n").some((l) => l.includes("✖") && l.includes(testName));
    const ok = fails > 0 && named; if (!ok) bad++;
    console.log(`${ok ? "RED " : "STILL GREEN"}  ${label.padEnd(40)} fails=${fails} named=${named}`);
  } finally { writeFileSync(file, orig); }
}
process.exit(bad ? 1 : 0);
