/**
 * What the post-work audit's judge may see of the finished work: its
 * interface, never its answers.
 *
 * The audit (src/post-audit.ts) asks an independent judge for checks after the
 * work exists, so the checks can fit the deliverable's real interface (a name,
 * a flag, a file it reads). The risk is the obvious one: a judge shown what the
 * work printed writes checks that confirm whatever it printed. So the view is
 * built from the two trees alone, never from the worker's transcript or its
 * claim (nothing here takes them), and it holds:
 *
 *  - the files the work added or changed, by name;
 *  - for code, the signature lines only (def/class/function/export, argparse
 *    `add_argument` flags), never a body, a constant, a default, help text or
 *    a usage string;
 *  - for each runnable new or changed script, how to run it, and nothing it
 *    prints: --help text is the work's to choose, and can carry an answer;
 *  - for anything else (data the work wrote), the name and a format word, never
 *    the contents: that is the deliverable's output on the task's example;
 *  - the top-level project listing.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { topLevel } from "./brief.js";
import { LINKED_DIRS } from "./scratch.js";
import { STATE_DIRS } from "./statedir.js";

export type Changed = { path: string; status: "new" | "changed" };

const SKIP = new Set([".git", "__pycache__", ".DS_Store", ...LINKED_DIRS, ...STATE_DIRS]);
const WALK_MAX_FILES = 5_000;
const FILE_MAX_BYTES = 2 * 1024 * 1024;

/** Every file under `root`, relative, with a content hash; skips state, VCS and dependency folders. */
function hashes(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    if (out.size >= WALK_MAX_FILES) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (out.size >= WALK_MAX_FILES) return;
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          const st = lstatSync(p);
          const h = st.size > FILE_MAX_BYTES ? `size:${st.size}:${st.mtimeMs}` : createHash("sha256").update(readFileSync(p)).digest("hex");
          out.set(relative(root, p).split(sep).join("/"), h);
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(root);
  return out;
}

/** The files the work added or changed: the pre-work copy against the tree now. */
export function changedFiles(preWorkDir: string, workDir: string): Changed[] {
  const before = hashes(preWorkDir);
  const after = hashes(workDir);
  const out: Changed[] = [];
  for (const [p, h] of [...after].sort(([a], [b]) => a.localeCompare(b))) {
    const was = before.get(p);
    if (was === undefined) out.push({ path: p, status: "new" });
    else if (was !== h) out.push({ path: p, status: "changed" });
  }
  return out;
}

const INTERPRETER: Record<string, string> = {
  ".py": "python3",
  ".js": "node",
  ".mjs": "node",
  ".cjs": "node",
  ".sh": "bash",
  ".bash": "bash",
  ".rb": "ruby",
  ".pl": "perl",
};
const CODE = new Set([...Object.keys(INTERPRETER), ".ts", ".tsx", ".jsx", ".go", ".rs", ".c", ".h", ".cpp", ".java", ".kt", ".swift", ".php", ".lua", ".r", ".R"]);

/** True when the file is code: by extension, or a shebang on its first line. */
export function isCode(path: string, text: string): boolean {
  return CODE.has(extname(path)) || text.startsWith("#!");
}

const FORMAT: Record<string, string> = {
  ".json": "JSON",
  ".jsonl": "JSON lines",
  ".csv": "CSV",
  ".tsv": "TSV",
  ".txt": "text",
  ".md": "Markdown",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".toml": "TOML",
  ".ini": "INI",
  ".xml": "XML",
  ".html": "HTML",
  ".log": "log text",
  ".sql": "SQL",
  ".db": "database file",
  ".sqlite": "database file",
};

/** Lines that say how code is called, and nothing it computes. Each cut at 160 characters. */
export function signatures(path: string, text: string, max = 25): string[] {
  const ext = extname(path);
  const lines = text.split("\n");
  const keep: string[] = [];
  const add = (l: string) => {
    const t = l.trimEnd().slice(0, 160);
    if (t.trim() && keep.length < max) keep.push(t);
  };
  for (const l of lines) {
    const t = l.trim();
    if (ext === ".py" || (!CODE.has(ext) && /^#!.*python/.test(lines[0] ?? ""))) {
      if (/^(async\s+)?def\s+\w+\s*\(/.test(t) || /^class\s+\w+/.test(t)) add(l.replace(/:\s*(#.*)?$/, ""));
      // The flags only: a `default=` or `help=` value is text the work chose, and can carry an answer.
      else if (/\badd_argument\s*\(/.test(t) || /\badd_parser\s*\(/.test(t)) add(stripArgValues(l));
    } else if ([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"].includes(ext)) {
      if (/^(export\s+)?(default\s+)?(async\s+)?function\b/.test(t) || /^(export\s+)?(default\s+)?class\s+\w+/.test(t)) add(l.replace(/\{\s*$/, ""));
      else if (/^export\s+(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>/.test(t)) add(l.replace(/=>.*$/, "=>"));
      else if (/^(module\.)?exports(\.\w+)?\s*=/.test(t) && t.length < 120) add(l);
      else if (/^(app|router|server)\.(get|post|put|delete|patch|use)\s*\(\s*["'`]/.test(t)) add(l.replace(/,.*$/, ", …)"));
    } else if (ext === ".go") {
      if (/^func\s/.test(t) || /^type\s+\w+\s+(struct|interface)/.test(t)) add(l.replace(/\{\s*$/, ""));
    } else if (ext === ".rs") {
      if (/^(pub\s+)?(async\s+)?fn\s/.test(t) || /^(pub\s+)?struct\s/.test(t)) add(l.replace(/\{\s*$/, ""));
    } else if ([".c", ".h", ".cpp", ".java", ".kt", ".swift", ".php"].includes(ext)) {
      if (/^[\w:<>*&\s]+\s+\**\w+\s*\([^;]*\)\s*\{?\s*$/.test(t) && !/^(if|for|while|switch|return)\b/.test(t)) add(l.replace(/\{\s*$/, ""));
    }
    // Usage text is the interface, whatever the language (a shell script's `echo "usage: ..."`).
    // No usage strings: they are text the work wrote, and can carry an answer.
  }
  return keep;
}

/** An argparse-style call with its `default=` and `help=` values cut out. */
export function stripArgValues(line: string): string {
  return line.replace(/\b(default|help|metavar|const)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,)]*)/g, "$1=…");
}

/**
 * Text that reads as a program's usage message rather than its answer: a line
 * that starts with `usage:`, or an argparse/getopt section heading at the
 * start of a line. The word "usage" anywhere else (a disk or CPU usage
 * report) is an answer, not a usage message.
 */
export function looksLikeUsage(text: string): boolean {
  return /^\s*usage\s*:/im.test(text) || /^\s*(options|optional arguments|arguments|positional arguments)\s*:/im.test(text);
}

export const HELP_TIMEOUT_MS = 3_000;
export const HELP_MAX_CHARS = 1_200;

/** How the file is run, or null when it is not a script. */
function invocation(path: string, text: string, workDir: string): string | null {
  const interp = INTERPRETER[extname(path)];
  if (interp) return `${interp} ${shellWord(path)}`;
  if (text.startsWith("#!")) {
    try {
      if (statSync(join(workDir, path)).mode & 0o111) return `./${shellWord(path)}`;
    } catch {
      return null;
    }
  }
  return null;
}

function shellWord(s: string): string {
  return /^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export type InterfaceViewInput = {
  /** The project as it was before the work: a copy taken at turn start. */
  preWorkDir: string;
  /** The project now, after the work. Only read; `--help` runs on a copy of it. */
  workDir: string;
  /** Bound on the scripts whose `--help` is asked. */
  maxHelp?: number;
  signal?: AbortSignal;
};

export type InterfaceView = { text: string; changed: Changed[] };

/**
 * The view. Takes the two trees and nothing else: no transcript, no claim,
 * no check output, so none of them can reach the judge through it.
 */
export async function interfaceView(input: InterfaceViewInput): Promise<InterfaceView> {
  const changed = changedFiles(input.preWorkDir, input.workDir);
  const lines: string[] = [];
  lines.push(
    changed.length
      ? `Files the work added or changed: ${changed.map((c) => `${c.path} (${c.status})`).join(", ")}`
      : "Files the work added or changed: (none found)",
  );
  const helpable: { path: string; cmd: string }[] = [];
  const code: string[] = [];
  const data: string[] = [];
  for (const c of changed) {
    let text = "";
    try {
      text = readFileSync(join(input.workDir, c.path)).subarray(0, 512 * 1024).toString("utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) {
      data.push(`  ${c.path}: binary file (contents not shown)`);
      continue;
    }
    if (isCode(c.path, text)) {
      const sig = signatures(c.path, text);
      code.push(`  ${c.path}:${sig.length ? `\n${sig.map((s) => `    ${s.trim()}`).join("\n")}` : " (no signature lines found)"}`);
      const cmd = invocation(c.path, text, input.workDir);
      if (cmd) helpable.push({ path: c.path, cmd });
    } else {
      data.push(`  ${c.path}: ${FORMAT[extname(c.path).toLowerCase()] ?? "file"} (contents not shown)`);
    }
  }
  if (code.length) lines.push("Signatures (declarations only, no bodies):", ...code);
  if (helpable.length) {
    // How to run each script, and nothing it prints: its --help text, or a
    // usage string in its source, is text the work chose, and a worker can put
    // any answer in it for the judge to copy (#49 status sweep, row 19).
    lines.push("How to run the new or changed scripts:", ...helpable.slice(0, input.maxHelp ?? 4).map((h) => `  run as: ${h.cmd}`));
  }
  if (data.length) lines.push("Other files the work wrote (formats only):", ...data);
  const listing = topLevel(input.workDir, 41).filter((n) => !STATE_DIRS.some((s) => n === s || n === `${s}/`)).slice(0, 40);
  lines.push(`Project files (top level): ${listing.join(" ") || "(empty)"}`);
  return { text: lines.join("\n"), changed };
}
