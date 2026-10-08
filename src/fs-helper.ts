/**
 * The worker's file tools, performed as the worker (src/privsep.ts).
 *
 * Maat starts this as the worker user and sends it one JSON request per line
 * on stdin; it answers one JSON line per request on stdout. Every read, write,
 * walk and grep the model asks for happens here, under the worker's uid, so
 * the kernel — not a path check in Maat — decides what it may touch.
 */
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileFingerprint, grepFiles, walkAsync, type WalkOptions } from "./files.js";
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
  fingerprint: (p: string) => fileFingerprint(p),
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

// ---------------------------------------------------------------------------
// One-shot modes, run as the worker so Maat never walks the worker's tree.
//
//   fs-helper.js pack    stdin {src, skip, clear}  stdout {entries, skipped}
//   fs-helper.js unpack  stdin {dest, entries}     stdout {written, failed}
//
// `pack` reads the project's `.maat/` for Maat to seed its private state dir
// from; `unpack` writes Maat's records back into it when the job ends. The
// worker owns the tree, so whatever a symlink in it reaches is what the worker
// could reach anyway; Maat, on its side, only ever gets regular files and
// folders by name (src/privsep.ts).

export type PackEntry = { rel: string; kind: "dir" | "file"; mode: number; data?: string };

function pack(req: { src: string; skip?: string[]; clear?: { dir: string; keep: string[] } }): { entries: PackEntry[]; skipped: string[] } {
  const entries: PackEntry[] = [];
  const skipped: string[] = [];
  const skip = new Set(req.skip ?? []);
  let top;
  try {
    top = lstatSync(req.src);
  } catch {
    return { entries, skipped };
  }
  if (!top.isDirectory()) return { entries, skipped: ["."] };
  const walk = (rel: string): void => {
    for (const name of readdirSync(rel ? join(req.src, rel) : req.src)) {
      const r = rel ? `${rel}/${name}` : name;
      if (skip.has(r)) continue;
      const p = join(req.src, r);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        entries.push({ rel: r, kind: "dir", mode: st.mode & 0o777 });
        walk(r);
      } else if (st.isFile()) {
        // O_NOFOLLOW: what was a file at lstat is still not a symlink at open.
        const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!fstatSync(fd).isFile()) {
            skipped.push(r);
            continue;
          }
          entries.push({ rel: r, kind: "file", mode: st.mode & 0o777, data: readFileSync(fd).toString("base64") });
        } finally {
          closeSync(fd);
        }
      } else {
        // Symlinks, FIFOs, sockets, devices: never carried into Maat's state dir.
        skipped.push(r);
      }
    }
  };
  walk("");
  if (req.clear) {
    const d = join(req.src, req.clear.dir);
    try {
      if (lstatSync(d).isDirectory()) {
        for (const name of readdirSync(d)) if (!req.clear.keep.includes(name)) rmSync(join(d, name), { recursive: true, force: true });
      }
    } catch {
      /* nothing to clear */
    }
  }
  return { entries, skipped };
}

function unpack(req: { dest: string; entries: PackEntry[] }): { written: number; failed: string[] } {
  let written = 0;
  const failed: string[] = [];
  mkdirSync(req.dest, { recursive: true });
  for (const e of req.entries) {
    const p = join(req.dest, e.rel);
    try {
      if (e.kind === "dir") {
        mkdirSync(p, { recursive: true });
        continue;
      }
      mkdirSync(dirname(p), { recursive: true });
      try {
        if (!lstatSync(p).isFile()) rmSync(p, { recursive: true, force: true });
      } catch {
        /* not there yet */
      }
      writeFileSync(p, Buffer.from(e.data ?? "", "base64"), { mode: e.mode & 0o777 });
      written += 1;
    } catch {
      failed.push(e.rel);
    }
  }
  return { written, failed };
}

function oneShot(mode: string): void {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (d: Buffer) => chunks.push(d));
  process.stdin.on("end", () => {
    try {
      const req = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const out = mode === "pack" ? pack(req) : unpack(req);
      process.stdout.write(JSON.stringify(out), () => process.exit(0));
    } catch (e) {
      process.stderr.write(`${(e as Error)?.message ?? String(e)}\n`);
      process.exit(1);
    }
  });
}

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

const mode = process.argv[2];
if (mode === "pack" || mode === "unpack") oneShot(mode);
else {
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
}
