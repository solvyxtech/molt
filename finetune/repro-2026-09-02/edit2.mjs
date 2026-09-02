// File-based exact edit: node edit2.mjs <target> <oldfile> <newfile>  (no escaping involved)
import { readFileSync, writeFileSync } from "node:fs";
const [target, oldf, newf] = process.argv.slice(2);
const text = readFileSync(target, "utf8"); const old = readFileSync(oldf, "utf8"); const neu = readFileSync(newf, "utf8");
const n = text.split(old).length - 1;
if (n !== 1) { console.error(`EDIT FAILED: ${target}: ${n} occurrences of ${oldf}`); process.exit(1); }
writeFileSync(target, text.replace(old, () => neu)); console.log(`edited ${target} via ${oldf}`);
