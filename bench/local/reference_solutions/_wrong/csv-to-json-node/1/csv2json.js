"use strict";
// plausible mistake: split on newlines first, then on commas (quoted commas ok, quoted newlines not), no BOM or duplicate header handling
let s = require("fs").readFileSync(0, "utf8");
const parse = (line) => {
  const out = [];
  let f = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { f += '"'; i++; }
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"' && f === "") q = true;
    else if (c === ",") { out.push(f); f = ""; }
    else f += c;
  }
  out.push(f);
  return out;
};
const lines = s.split(/\r?\n/).filter((l) => l !== "");
if (!lines.length) { console.log("[]"); process.exit(0); }
const head = parse(lines[0]);
const rows = lines.slice(1).map((l) => {
  const r = parse(l);
  const o = {};
  head.forEach((h, i) => (o[h] = r[i] === undefined ? "" : r[i]));
  return o;
});
console.log(JSON.stringify(rows));
