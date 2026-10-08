/**
 * Provider credentials, kept in memory and out of every environment Maat
 * hands to anything else.
 *
 * The worker's commands run as children of Maat. Scrubbing a handful of key
 * names from the child's environment (what the engine used to do) left two
 * ways through: any credential shape the list did not name reached the child
 * directly, and every key was still in Maat's own environment, which a child
 * of the same user reads back from `/proc/$PPID/environ` on Linux (and with
 * `ps -E` on macOS). Three layers here:
 *
 *  1. `captureSecrets()` runs at startup. Every credential-shaped variable is
 *     moved out of `process.env` into a private map, so nothing Maat spawns
 *     afterwards inherits it, whatever env the spawn site builds.
 *  2. Keys can arrive without ever being in Maat's exec environment:
 *     `MAAT_KEYS_FD` (an inherited descriptor, read to the end and closed) or
 *     `MAAT_KEYS_FILE` (a mode-0600 file of this user). Step 1 cannot reach the
 *     copy of the environment the kernel kept from exec; this does, because
 *     the key was never in it.
 *  3. `scrubEnv()` is the child-side filter, kept for library callers that
 *     never call `captureSecrets()`.
 *
 * All of this is best effort while the worker runs as Maat's own user: such
 * a worker can still read a keys file while it exists, Maat's auth file, or
 * (where ptrace is allowed) Maat's memory. Running the worker as another user
 * (`--worker-user`) is the boundary; see docs/secrets.md.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Names that hold a credential: any `*_API_KEY`, `*_TOKEN`, `*_SECRET` shape, and the like. */
const SECRET_SUFFIX = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET(?:_ACCESS)?_?KEY|PRIVATE_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)$/i;
/** Whole families: a provider's other variables can carry or point at its key. */
const SECRET_PREFIX = /^(?:XAI|GROK|TOGETHER)_/i;
/** Named outright, whatever the patterns above say. */
const SECRET_NAMES = new Set([
  "MAAT_API_KEY",
  "MOLT_API_KEY",
  "MAAT_JUDGE_KEY",
  "MOLT_JUDGE_KEY",
  "MAAT_KEYS_FD",
  "MAAT_KEYS_FILE",
]);

/** `MAAT_KEEP_ENV=NAME,NAME`: credential-shaped names the user wants the worker to keep (a task's own token). */
function kept(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.MAAT_KEEP_ENV ?? env.MOLT_KEEP_ENV ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !SECRET_NAMES.has(s.toUpperCase())),
  );
}

export function isSecretName(name: string): boolean {
  return SECRET_NAMES.has(name.toUpperCase()) || SECRET_SUFFIX.test(name) || SECRET_PREFIX.test(name);
}

const store = new Map<string, string>();

export type CaptureReport = {
  /** Variables moved out of the environment into memory. */
  moved: string[];
  /** Names read from MAAT_KEYS_FD / MAAT_KEYS_FILE. */
  loaded: string[];
  /** Why a keys source was refused or unreadable. Never contains a value. */
  problems: string[];
};

/** `NAME=value` lines (`export` and quotes allowed, `#` comments), or a JSON object of strings. */
export function parseKeys(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const t = text.trim();
  if (t.startsWith("{")) {
    const obj = JSON.parse(t) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) if (typeof v === "string") out.set(k, v);
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out.set(m[1]!, v);
  }
  return out;
}

/** Read a descriptor to its end. A non-blocking pipe end is waited on, briefly. */
function readAll(fd: number): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(64 * 1024);
  const deadline = Date.now() + 5_000;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n: number;
    try {
      n = readSync(fd, buf, 0, buf.length, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN" && Date.now() < deadline) {
        Atomics.wait(nap, 0, 0, 10);
        continue;
      }
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function loadFd(raw: string, report: CaptureReport): Map<string, string> | null {
  const fd = Number(raw);
  if (!Number.isInteger(fd) || fd < 3) {
    report.problems.push(`MAAT_KEYS_FD must be a descriptor number of 3 or more, not ${JSON.stringify(raw.slice(0, 20))}`);
    return null;
  }
  try {
    return parseKeys(readAll(fd));
  } catch (e) {
    report.problems.push(`MAAT_KEYS_FD ${fd} could not be read: ${(e as NodeJS.ErrnoException).code ?? "unreadable"}`);
    return null;
  } finally {
    // Closed whatever happened: a worker started later must not inherit it,
    // and /proc/<maat>/fd/<n> must not lead anywhere.
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

function loadFile(path: string, report: CaptureReport): Map<string, string> | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    report.problems.push(`MAAT_KEYS_FILE could not be opened: ${(e as NodeJS.ErrnoException).code ?? "unreadable"}`);
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      report.problems.push("MAAT_KEYS_FILE is not a regular file");
      return null;
    }
    if (process.platform !== "win32") {
      if ((st.mode & 0o077) !== 0) {
        report.problems.push(`MAAT_KEYS_FILE is readable by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
        return null;
      }
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
        report.problems.push("MAAT_KEYS_FILE belongs to another user");
        return null;
      }
    }
    return parseKeys(readAll(fd));
  } catch (e) {
    report.problems.push(`MAAT_KEYS_FILE could not be read: ${(e as Error).message.split("\n")[0]}`);
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Move every credential out of `env` (by default `process.env`, which is what
 * every spawn without an explicit env inherits) and into memory, after
 * loading any keys passed through MAAT_KEYS_FD / MAAT_KEYS_FILE. Idempotent:
 * a second call moves whatever arrived since and reloads nothing.
 */
export function captureSecrets(env: NodeJS.ProcessEnv = process.env): CaptureReport {
  const report: CaptureReport = { moved: [], loaded: [], problems: [] };
  const fdRaw = env.MAAT_KEYS_FD ?? env.MOLT_KEYS_FD;
  const fileRaw = env.MAAT_KEYS_FILE ?? env.MOLT_KEYS_FILE;
  delete env.MAAT_KEYS_FD;
  delete env.MOLT_KEYS_FD;
  delete env.MAAT_KEYS_FILE;
  delete env.MOLT_KEYS_FILE;
  for (const got of [fdRaw ? loadFd(fdRaw, report) : null, fileRaw ? loadFile(fileRaw, report) : null]) {
    if (!got) continue;
    for (const [k, v] of got) {
      store.set(k, v);
      report.loaded.push(k);
    }
  }
  const keep = kept(env);
  for (const k of Object.keys(env)) {
    if (!isSecretName(k) || keep.has(k)) continue;
    const v = env[k];
    // A key handed over explicitly wins over the same name in the environment.
    if (v !== undefined && !store.has(k)) store.set(k, v);
    delete env[k];
    report.moved.push(k);
  }
  return report;
}

/** A credential by name: the in-memory copy first, then the environment (for callers that never captured). */
export function secretValue(name: string): string | undefined {
  return store.get(name) ?? process.env[name];
}

/** Every credential held, for redaction (a value too short to be a key would redact ordinary text). */
export function secretValues(): string[] {
  return [...store].filter(([k, v]) => isSecretName(k) && v.length >= 8).map(([, v]) => v);
}

/**
 * `base` plus the credentials held in memory. Only for the model's own
 * client processes (an ACP or OpenCode backend), which need their keys; never
 * for anything that runs the worker's or a check's commands.
 */
export function withSecrets(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [k, v] of store) out[k] ??= v;
  return out;
}

/** A copy of `base` with every credential-shaped variable removed (MAAT_KEEP_ENV names stay). */
export function scrubEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = kept(base);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!isSecretName(k) || keep.has(k)) out[k] = v;
  return out;
}

/** Tests only. */
export function _resetSecrets(): void {
  store.clear();
}
