/**
 * Inspect a file the way a careful person does before touching it: as bytes.
 *
 * On the local comparison the work molt lost to a better agent was mostly
 * not hard — an email left in upper case, a user whose only record was an
 * ignored type, a CRLF file rewritten with LF. The other agent looked at the
 * exact input first (`cat -A`, `xxd`, `repr`) and saw them; molt read the file
 * as text and did not. Reading text hides exactly the things a grader checks:
 * the line ending, the byte-order mark, the trailing space, the one value in
 * a different case, the row with a field missing.
 *
 * `inspectPath` is the tool's answer; `profileLine` is the one-line version
 * molt puts in front of the model for each input file a task names.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const READ_CAP = 4 * 1024 * 1024;

type Facts = {
  bytes: number;
  binary: boolean;
  encoding: string;
  bom: string | null;
  lines: number;
  crlf: number;
  lf: number;
  cr: number;
  finalNewline: boolean;
  tabs: number;
  trailingSpace: number;
  nonAscii: number;
  nonAsciiSample: string[];
  control: number;
  controlSample: string[];
  longest: number;
};

function hex(b: number): string {
  return b.toString(16).padStart(2, "0");
}

/** Facts about raw bytes. Pure. */
export function byteFacts(buf: Buffer): Facts {
  const bom =
    buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      ? "UTF-8 BOM (EF BB BF)"
      : buf[0] === 0xff && buf[1] === 0xfe
        ? "UTF-16 LE BOM (FF FE)"
        : buf[0] === 0xfe && buf[1] === 0xff
          ? "UTF-16 BE BOM (FE FF)"
          : null;
  let crlf = 0, lf = 0, cr = 0, tabs = 0, control = 0, nul = 0;
  const controlSample: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0x0d) {
      if (buf[i + 1] === 0x0a) {
        crlf++;
        i++;
      } else cr++;
    } else if (b === 0x0a) lf++;
    else if (b === 0x09) tabs++;
    else if (b === 0) nul++;
    else if (b < 0x20 || b === 0x7f) {
      control++;
      if (controlSample.length < 5) controlSample.push(`0x${hex(b)} at byte ${i}`);
    }
  }
  const binary = nul > 0 || (buf.length > 0 && control / buf.length > 0.05);
  const text = buf.toString("utf8");
  const validUtf8 = !text.includes("�") || buf.includes(Buffer.from([0xef, 0xbf, 0xbd]));
  const nonAsciiChars = [...text].filter((c) => c.codePointAt(0)! > 0x7e);
  const seen = new Set<string>();
  const nonAsciiSample: string[] = [];
  for (const c of nonAsciiChars) {
    if (seen.has(c) || c === "﻿") continue;
    seen.add(c);
    if (nonAsciiSample.length < 6) nonAsciiSample.push(`${JSON.stringify(c)} U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  return {
    bytes: buf.length,
    binary,
    encoding: binary ? "binary" : bom?.startsWith("UTF-16") ? "UTF-16" : validUtf8 ? (nonAsciiChars.length ? "UTF-8" : "ASCII") : "not valid UTF-8 (Latin-1 or similar?)",
    bom,
    lines: lines.length,
    crlf,
    lf,
    cr,
    finalNewline: buf.length > 0 && (buf.at(-1) === 0x0a || buf.at(-1) === 0x0d),
    tabs,
    trailingSpace: lines.filter((l) => /[ \t]$/.test(l)).length,
    nonAscii: nonAsciiChars.length,
    nonAsciiSample,
    control,
    controlSample,
    longest: lines.reduce((m, l) => Math.max(m, l.length), 0),
  };
}

function endings(f: Facts): string {
  const kinds = [f.crlf && `${f.crlf} CRLF`, f.lf && `${f.lf} LF`, f.cr && `${f.cr} bare CR`].filter(Boolean);
  if (!kinds.length) return "no line breaks";
  return kinds.length > 1 ? `MIXED line endings: ${kinds.join(", ")}` : `${kinds[0]} line endings`;
}

/** `xxd`-style dump. */
export function hexdump(buf: Buffer, offset = 0, length = 256): string {
  const out: string[] = [];
  const end = Math.min(buf.length, offset + length);
  for (let i = offset; i < end; i += 16) {
    const row = buf.subarray(i, Math.min(i + 16, end));
    const hx = [...row].map(hex).join(" ").padEnd(47, " ");
    const asc = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    out.push(`${i.toString(16).padStart(8, "0")}  ${hx}  ${asc}`);
  }
  return out.join("\n");
}

/** Split one delimited line, honouring double quotes. */
function splitRow(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === sep && !q) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function tableFacts(text: string, sep: string): string[] {
  const rows = text.split(/\r\n|\n|\r/).filter((l, i, a) => l !== "" || i < a.length - 1).map((l) => splitRow(l, sep));
  if (rows.length < 2) return [];
  const header = rows[0]!;
  const body = rows.slice(1);
  const out: string[] = [];
  const widths = new Map<number, number>();
  for (const r of body) widths.set(r.length, (widths.get(r.length) ?? 0) + 1);
  out.push(`table: ${body.length} data rows, header ${JSON.stringify(header)}`);
  if (widths.size > 1) {
    const bad = body.map((r, i) => [r.length, i + 2] as const).filter(([n]) => n !== header.length).slice(0, 5);
    out.push(`ROWS WITH A DIFFERENT FIELD COUNT: ${[...widths].map(([n, c]) => `${c} row(s) with ${n}`).join(", ")}; e.g. line ${bad.map(([n, l]) => `${l} (${n})`).join(", ")}`);
  }
  const dup = body.length - new Set(body.map((r) => r.join("\u0001"))).size;
  if (dup) out.push(`${dup} exact duplicate row(s)`);
  header.forEach((name, c) => {
    const vals = body.map((r) => r[c] ?? "");
    const notes: string[] = [];
    const empty = vals.filter((v) => v.trim() === "").length;
    if (empty) notes.push(`${empty} empty`);
    const padded = vals.filter((v) => v !== v.trim()).length;
    if (padded) notes.push(`${padded} with surrounding whitespace`);
    const letters = vals.filter((v) => /[a-z]/i.test(v));
    const upper = letters.filter((v) => /[A-Z]/.test(v) && v !== v.toLowerCase());
    if (letters.length && upper.length && upper.length < letters.length) {
      notes.push(`mixed case: ${upper.length} of ${letters.length} contain capitals, e.g. ${JSON.stringify(upper[0])}`);
    }
    const nums = vals.filter((v) => /^\s*-?\d+(\.\d+)?\s*$/.test(v)).length;
    if (nums && nums < vals.length - empty) {
      const odd = vals.find((v) => v.trim() && !/^\s*-?\d+(\.\d+)?\s*$/.test(v));
      notes.push(`mostly numbers but ${vals.length - empty - nums} not, e.g. ${JSON.stringify(odd)}`);
    }
    const distinct = new Set(vals.map((v) => v.trim().toLowerCase())).size;
    const caseDup = new Set(vals.map((v) => v.trim())).size - distinct;
    if (caseDup > 0) notes.push(`${caseDup} value(s) differ only by case or spacing`);
    if (notes.length) out.push(`  column ${JSON.stringify(name)}: ${notes.join("; ")}`);
  });
  return out;
}

function jsonFacts(text: string): string[] {
  let v: unknown;
  try {
    v = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    return [`JSON: does not parse — ${e instanceof Error ? e.message : String(e)}`];
  }
  const records = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as object).find(Array.isArray) : null;
  const out = [`JSON: top level is ${Array.isArray(v) ? `an array of ${(v as unknown[]).length}` : typeof v === "object" && v ? `an object with keys ${JSON.stringify(Object.keys(v as object).slice(0, 12))}` : typeof v}`];
  if (Array.isArray(records) && records.length && records.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    const keys = new Map<string, number>();
    const types = new Map<string, Set<string>>();
    for (const r of records as Record<string, unknown>[]) {
      for (const [k, x] of Object.entries(r)) {
        keys.set(k, (keys.get(k) ?? 0) + 1);
        const t = x === null ? "null" : Array.isArray(x) ? "array" : typeof x;
        (types.get(k) ?? types.set(k, new Set()).get(k)!).add(t);
      }
    }
    for (const [k, n] of keys) {
      const notes: string[] = [];
      if (n < records.length) notes.push(`missing in ${records.length - n} of ${records.length} records`);
      const ts = types.get(k)!;
      if (ts.size > 1) notes.push(`MIXED types: ${[...ts].join(", ")}`);
      if (notes.length) out.push(`  key ${JSON.stringify(k)}: ${notes.join("; ")}`);
    }
    const vals = (k: string) => (records as Record<string, unknown>[]).map((r) => r[k]).filter((x) => typeof x === "string") as string[];
    for (const k of keys.keys()) {
      const s = vals(k);
      const distinct = new Set(s);
      if (s.length > 3 && distinct.size <= 12) out.push(`  key ${JSON.stringify(k)} takes ${distinct.size} values: ${JSON.stringify([...distinct])}`);
    }
  }
  return out;
}

/** Recurring line shapes, digits and letters folded, for logs. */
function lineShapes(text: string): string[] {
  const shapes = new Map<string, { n: number; eg: string }>();
  for (const l of text.split(/\r\n|\n|\r/).slice(0, 20_000)) {
    if (!l.trim()) continue;
    const s = l.replace(/\d+/g, "9").replace(/[a-z]+/g, "a").replace(/[A-Z]+/g, "A").slice(0, 60);
    const e = shapes.get(s);
    if (e) e.n++;
    else shapes.set(s, { n: 1, eg: l.slice(0, 100) });
  }
  const top = [...shapes.values()].sort((a, b) => b.n - a.n);
  if (top.length < 2) return [];
  return [
    `${shapes.size} distinct line shape(s); most common:`,
    ...top.slice(0, 4).map((x) => `  ${x.n}× ${JSON.stringify(x.eg)}`),
    ...(top.length > 4 ? [`  …and ${top.length - 4} rarer shape(s), e.g. ${JSON.stringify(top.at(-1)!.eg)}`] : []),
  ];
}

/** The full report the `inspect` tool returns for one file. */
export function inspectFile(abs: string, rel: string, opts: { offset?: number; length?: number } = {}): string {
  const st = statSync(abs);
  const buf = readFileSync(abs).subarray(0, READ_CAP);
  const f = byteFacts(buf);
  const out: string[] = [`${rel}: ${st.size} bytes${st.size > READ_CAP ? ` (first ${READ_CAP} examined)` : ""}, ${f.encoding}${f.bom ? `, starts with a ${f.bom}` : ""}`];
  if (!f.binary) {
    out.push(
      `${f.lines} line(s), ${endings(f)}, ${f.finalNewline ? "ends with a newline" : "NO final newline"}, longest line ${f.longest} chars`,
    );
    const odd = [
      f.tabs && `${f.tabs} tab(s)`,
      f.trailingSpace && `${f.trailingSpace} line(s) with trailing whitespace`,
      f.nonAscii && `${f.nonAscii} non-ASCII char(s): ${f.nonAsciiSample.join(", ")}`,
      f.control && `${f.control} control byte(s): ${f.controlSample.join(", ")}`,
    ].filter(Boolean);
    if (odd.length) out.push(odd.join("; "));
    const text = buf.toString("utf8");
    const ext = extname(rel).toLowerCase();
    if (ext === ".csv" || ext === ".tsv" || (ext === ".txt" && /^[^\n]*[,\t][^\n]*\n[^\n]*[,\t]/.test(text))) {
      out.push(...tableFacts(text, ext === ".tsv" || (!text.split("\n")[0]!.includes(",") && text.includes("\t")) ? "\t" : ","));
    } else if (ext === ".json" || /^\s*[[{]/.test(text.slice(0, 50))) out.push(...jsonFacts(text));
    else if (ext === ".log" || ext === ".txt" || ext === "") out.push(...lineShapes(text));
  }
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const length = Math.min(4096, Math.max(16, Math.floor(opts.length ?? (f.binary ? 256 : 128))));
  out.push(`bytes ${offset}–${Math.min(buf.length, offset + length)}:`, hexdump(buf, offset, length));
  return out.join("\n");
}

/** One line per file: what a person would want to know before writing code against it. */
export function profileLine(abs: string, rel: string): string {
  const buf = readFileSync(abs).subarray(0, READ_CAP);
  const f = byteFacts(buf);
  if (f.binary) return `${rel}: binary, ${f.bytes} bytes`;
  const parts = [
    `${f.bytes} bytes`,
    f.encoding,
    f.bom ? f.bom : "",
    endings(f),
    f.finalNewline ? "" : "no final newline",
    f.trailingSpace ? `${f.trailingSpace} line(s) end in whitespace` : "",
    f.nonAscii ? `${f.nonAscii} non-ASCII` : "",
    f.control ? `${f.control} control bytes` : "",
  ].filter(Boolean);
  let extra = "";
  const ext = extname(rel).toLowerCase();
  const text = buf.toString("utf8");
  if (ext === ".csv" || ext === ".tsv") {
    const t = tableFacts(text, ext === ".tsv" ? "\t" : ",");
    const flags = t.filter((l) => l.startsWith("  column") || /DIFFERENT|duplicate/.test(l)).map((l) => l.trim());
    if (flags.length) extra = ` — ${flags.slice(0, 4).join("; ")}`;
  } else if (ext === ".json") {
    const j = jsonFacts(text)
      .filter((l) => /missing|MIXED|does not parse/.test(l) || /takes [1-6] values/.test(l))
      .map((l) => l.trim());
    if (j.length) extra = ` — ${j.slice(0, 4).join("; ")}`;
  }
  return `${rel}: ${parts.join(", ")}${extra}`;
}

/** The tool on a directory: one profile line per file, up to `max`. */
export function inspectDir(abs: string, rel: string, max = 25): string {
  const names = readdirSync(abs).filter((n) => n !== ".maat" && n !== ".molt" && n !== ".git").sort();
  const lines: string[] = [];
  for (const n of names) {
    const p = join(abs, n);
    try {
      if (statSync(p).isFile()) lines.push(profileLine(p, join(rel, n)));
    } catch {
      /* unreadable entries are skipped */
    }
    if (lines.length >= max) break;
  }
  const rest = names.length - lines.length;
  return (lines.length ? lines.join("\n") : `${rel}: no files`) + (rest > 0 && lines.length >= max ? `\n…${rest} more` : "");
}

const DATA_EXT = /\.(csv|tsv|json|jsonl|ndjson|log|txt|xml|ya?ml|ini|cfg|conf|dat|tex|html?)$/i;

/**
 * Files the task text names that exist under `cwd` — the inputs worth
 * profiling before any work. Paths are found as tokens with a slash or an
 * extension; a named directory contributes its files.
 */
export function namedInputs(task: string, cwd: string, max = 12): string[] {
  const found = new Set<string>();
  for (const m of task.matchAll(/(?:^|[\s`'"(])((?:\/[\w.@-]+)+\/?|(?:[\w.@-]+\/)*[\w@-]+\.[A-Za-z0-9]{1,8}|[\w@-]+\/)(?=$|[\s`'",.;:)])/g)) {
    const raw = m[1]!;
    const p = raw.startsWith("/") ? raw : join(cwd, raw);
    try {
      const st = statSync(p);
      if (st.isFile()) found.add(p);
      else if (st.isDirectory() && p !== cwd && p !== "/") {
        for (const n of readdirSync(p).sort().slice(0, 6)) {
          const q = join(p, n);
          if (statSync(q).isFile()) found.add(q);
        }
      }
    } catch {
      /* named but not there yet: an output, not an input */
    }
    if (found.size >= max) break;
  }
  // Source code is read, not profiled; the inputs are the data.
  const named = [...found].filter((p) => !/\.(py|js|mjs|ts|c|h|rs|go|java|rb|sh|tsx|jsx|cpp|hpp|cc)$/i.test(p)).slice(0, max);
  if (named.length) return named;
  // Nothing named: the data files at the top of the project are the likely
  // inputs ("reads a JSON array of transactions" with transactions.json beside it).
  try {
    return readdirSync(cwd)
      .filter((n) => DATA_EXT.test(n) && !n.startsWith("."))
      .sort()
      .map((n) => join(cwd, n))
      .filter((p) => statSync(p).isFile())
      .slice(0, 8);
  } catch {
    return [];
  }
}
