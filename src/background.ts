/**
 * Processes that outlive the tool call that started them.
 *
 * A dev server, a watcher, a database: the shape of a great deal of real work
 * is "start this, keep going, and hit it later". Through a `bash` tool that
 * waits for exit, that shape is impossible — the call either blocks until the
 * timeout kills the server, or the model backgrounds it with `&` and the
 * shell's stdout pipe holds the tool open anyway. Watching a model try
 * `nohup`, `setsid`, `disown` and `sleep 5 &&` in four consecutive steps is
 * what makes the case for a controlled background-execution primitive.
 *
 * The rules:
 *
 *  - Output goes to a file under `.maat/bg/`, never to the tool result. The
 *    model reads the file when it wants to know, with `read_file`, so a chatty
 *    server costs nothing until it is asked about.
 *  - Every process is in its own group, and the group is what gets killed —
 *    `npm start` is a shell that spawns node that spawns the server, and
 *    killing the top of that tree leaves the port held by the bottom of it.
 *  - Everything started here is stopped when molt exits. A session that ends
 *    must not leave a server bound to a port for the next session to trip
 *    over. Found the hard way in another project: headless browsers leaked by
 *    the dozen until the process group and the exit hook were both in place.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { stateDirName } from "./statedir.js";
import { privSep } from "./privsep.js";

export type BackgroundProcess = {
  id: number;
  pid: number;
  command: string;
  /** Project-relative path of the log, as the model should read it. */
  log: string;
  startedAt: number;
  /** Set when the process has exited, with what it said on the way out. */
  exit?: { code: number | null; signal: string | null; at: number };
};

/** How the folder is named in messages; the real one is per project (statedir.ts). */
export const BG_DIR = ".maat/bg";

/**
 * One registry per process. Engines come and go — the window opens a new one
 * per session — but the servers they started are the machine's, and the exit
 * hook has to find all of them.
 */
const registry: BackgroundProcess[] = [];
let hooked = false;
let nextId = 1;

function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.once("exit", () => stopAllBackground());
  // The two signals a terminal sends. Node exits without running "exit"
  // handlers on a signal it has no listener for, so the listener is what makes
  // the exit hook reachable — and it re-raises, so the exit status is honest.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    if (process.listenerCount(sig) === 0) {
      process.once(sig, () => {
        stopAllBackground();
        process.exit(sig === "SIGINT" ? 130 : 143);
      });
    }
  }
}

/** Kill a process group, SIGTERM first, and ignore a group that is already gone. */
function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Start a command in the background.
 *
 * Resolves as soon as the process exists; it does not wait for the server to
 * be ready, because only the model knows what "ready" means for this command.
 * The result says where the output is, and the model reads it.
 */
export function startBackground(
  command: string,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; asWorker?: boolean },
): BackgroundProcess {
  hookExit();
  const id = nextId++;
  const bgRel = `${stateDirName(opts.cwd)}/bg`;
  const dir = join(opts.cwd, bgRel);
  const log = `${bgRel}/${id}.log`;
  const ps = opts.asWorker ? privSep() : undefined;
  let child;
  if (ps) {
    // Under privilege separation the job is the worker's, and so is its log:
    // the worker's own shell makes the folder and opens the file, so the
    // log is created with the worker's permissions. Maat (root) never creates
    // or opens a path in the worker's tree.
    const spec = ps.execSpec(
      "/bin/sh",
      ["-c", 'mkdir -p -- "$1" && exec >"$2" 2>&1 </dev/null && exec /bin/sh -c "$3"', "maat-bg", dir, join(opts.cwd, log), command],
      opts.cwd,
      opts.env,
    );
    child = spawn(spec.file, spec.args, {
      cwd: opts.cwd,
      env: spec.env,
      detached: true,
      stdio: "ignore",
      ...(spec.uid !== undefined ? { uid: spec.uid, gid: spec.gid } : {}),
    });
  } else {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(join(opts.cwd, log), "w");
    child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      env: opts.env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
  }
  const entry: BackgroundProcess = {
    id,
    pid: child.pid ?? -1,
    command,
    log,
    startedAt: Date.now(),
  };
  child.on("exit", (code, signal) => {
    entry.exit = { code, signal, at: Date.now() };
  });
  // Not our child to wait on: a background process must not hold molt open.
  child.unref();
  registry.push(entry);
  return entry;
}

/** Everything started in this process, exited or not. */
export function listBackground(): readonly BackgroundProcess[] {
  return registry;
}

/** Stop one by id. Returns false if there is no such process. */
export function stopBackground(id: number): boolean {
  const p = registry.find((e) => e.id === id);
  if (!p) return false;
  if (p.exit) return true;
  killGroup(p.pid, "SIGTERM");
  // A server that traps SIGTERM to drain connections gets two seconds, then
  // the group is killed for real. Unref'd, so a stop on the way out of the
  // process does not wait on its own timer.
  const t = setTimeout(() => {
    if (!p.exit) killGroup(p.pid, "SIGKILL");
  }, 2_000);
  t.unref();
  return true;
}

/** Stop everything still running. Called on exit; safe to call twice. */
export function stopAllBackground(): number {
  let n = 0;
  for (const p of registry) {
    if (p.exit) continue;
    if (killGroup(p.pid, "SIGTERM")) n += 1;
    killGroup(p.pid, "SIGKILL");
  }
  return n;
}

/** Testing seam: forget every entry without touching the processes. */
export function resetBackgroundRegistry(): void {
  registry.length = 0;
  nextId = 1;
}

/** What a background start reads back to the model. */
export function describeStart(p: BackgroundProcess): string {
  return (
    `started in the background as job ${p.id} (pid ${p.pid}). Output goes to ${p.log} — ` +
    `read that file to see what it printed; it is not returned here. Stop it with ` +
    `bash {"command":"...","stop_job":${p.id}} or by killing the pid.`
  );
}
