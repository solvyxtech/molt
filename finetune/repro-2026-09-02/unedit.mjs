import { readFileSync, writeFileSync } from "node:fs";
const root = process.argv[2];
for (const n of [13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]) {
  const spec = JSON.parse(readFileSync(`${process.argv[3]}/e${n}.json`, "utf8")).reverse();
  for (const { file, old, new: neu } of spec) {
    const p = `${root}/${file}`; const t = readFileSync(p, "utf8");
    const k = t.split(neu).length - 1;
    if (k !== 1) { console.error(`UNEDIT FAILED e${n} ${file}: ${k} occurrences`); process.exit(1); }
    writeFileSync(p, t.replace(neu, () => old));
  }
}
console.log("reversed e1..e13");
