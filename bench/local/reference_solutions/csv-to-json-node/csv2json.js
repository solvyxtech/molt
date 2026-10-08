"use strict";
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  let s = Buffer.concat(chunks).toString("utf8");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const recs = [];
  let rec = [];
  let field = "";
  let fstart = true;
  let inq = false;
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inq) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inq = false;
      } else field += c;
    } else if (c === '"' && fstart) {
      inq = true;
      fstart = false;
      any = true;
    } else if (c === ",") {
      rec.push(field);
      field = "";
      fstart = true;
      any = true;
    } else if (c === "\n" || (c === "\r" && s[i + 1] === "\n")) {
      if (c === "\r") i++;
      if (any) {
        rec.push(field);
        recs.push(rec);
      }
      rec = [];
      field = "";
      fstart = true;
      any = false;
    } else {
      field += c;
      fstart = false;
      any = true;
    }
  }
  const fail = (m) => {
    process.stderr.write("csv2json: " + m + "\n");
    process.exit(1);
  };
  if (inq) fail("unterminated quoted field");
  if (any) {
    rec.push(field);
    recs.push(rec);
  }
  if (recs.length === 0) {
    process.stdout.write("[]\n");
    return;
  }
  const seen = new Map();
  const names = recs[0].map((h, k) => {
    if (h === "") h = "col" + (k + 1);
    const n = (seen.get(h) || 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : h + "_" + n;
  });
  const out = [];
  for (let r = 1; r < recs.length; r++) {
    const row = recs[r];
    if (row.length > names.length) fail("row " + r + " has too many fields");
    const o = {};
    names.forEach((n, k) => {
      o[n] = k < row.length ? row[k] : "";
    });
    out.push(o);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
});
