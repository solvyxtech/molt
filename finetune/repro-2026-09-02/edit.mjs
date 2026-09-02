// Exact-string edits with a uniqueness check. Usage: node edit.mjs spec.json
import { readFileSync, writeFileSync } from "node:fs";
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const { file, old, new: neu } of spec) {
  const text = readFileSync(file, "utf8");
  const n = text.split(old).length - 1;
  if (n !== 1) { console.error(`EDIT FAILED: ${file}: expected 1 occurrence, found ${n}\n--- old ---\n${old.slice(0, 300)}`); process.exit(1); }
  writeFileSync(file, text.replace(old, () => neu), "utf8");
  console.log(`edited ${file} (+${neu.split("\n").length - old.split("\n").length} lines)`);
}
