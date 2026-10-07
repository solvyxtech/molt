/**
 * The worker's file tools, performed as the worker (src/privsep.ts).
 *
 * Maat starts this as the worker user and sends it one JSON request per line
 * on stdin; it answers one JSON line per request on stdout. Every read, write,
 * walk and grep the model asks for happens here, under the worker's uid, so
 * the kernel — not a path check in Maat — decides what it may touch.
 */
import { createHash } from "node:crypto";
import { accessSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { grepFiles, walkAsync, type WalkOptions } from "./files.js";
import { inspectDir, inspectFile } from "./inspect.js";

type Op = (...args: never[]) => unknown;

const ops: Record<string, Op> = {
  read: (p: string) => readFileSync(p, "utf8"),
  write: (p: string, content: string) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf8");
    return null;
  },
  exists: (p: string) => existsSync(p),
  isDir: (p: string) => statSync(p).isDirectory(),
  sha256: (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null),
  walk: (p: string, o: WalkOptions) => walkAsync(p, o),
  grep: (p: string, pattern: string, o: { glob?: string; ignoreCase?: boolean }) => grepFiles(p, pattern, o),
  inspectDir: (p: string, rel: string) => inspectDir(p, rel),
  inspectFile: (p: string, rel: string, o: { offset?: number; length?: number }) => inspectFile(p, rel, o),
  access: (p: string, mode: number) => {
    try {
      accessSync(p, mode);
      return true;
    } catch {
      return false;
    }
  },
};

const reply = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(line: string): Promise<void> {
  let req: { id: number; op: string; args: unknown[] };
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const op = ops[req.op];
  try {
    if (!op) throw new Error(`unknown op ${req.op}`);
    const value = await (op as (...a: unknown[]) => unknown)(...(req.args ?? []));
    reply({ id: req.id, ok: true, value: value === undefined ? null : value });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    reply({ id: req.id, ok: false, error: { message: err?.message ?? String(e), ...(err?.code ? { code: err.code } : {}) } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) void handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));
