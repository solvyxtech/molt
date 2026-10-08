/**
 * Keeping an unattended worker on its task.
 *
 * 2026-10-07, the ml4b bench lanes: a worker spent its whole time budget,
 * 90 to 125 tool calls a task, reading things that were not the task: the
 * other tasks' folders and logs in the shared bench folder, Maat's installed
 * source, and Maat's own records of the job under `.maat/` (receipts, the
 * journal, spilled output), hunting for the hidden checks. The checks' text
 * was withheld (src/withhold.ts); the time was gone all the same.
 *
 * Three instruments, all for unattended runs:
 *
 *  - While a job with hidden checks runs, read_file, list_dir, grep and
 *    inspect refuse paths outside the project and paths under its `.maat/`,
 *    saying plainly that this is outside the task (`outsideTask`). Two
 *    exceptions: a path the task itself names (a task may say "the config is
 *    in /etc/app"), and the files Maat itself points the model at under
 *    `.maat/` (spilled output in `out/`, background logs in `bg/`).
 *  - bash is not blocked (a shell can reach anything; a regex over a command
 *    line is not a wall), but a command that names `.maat/` or a path outside
 *    the project is journalled (`bashReach`).
 *  - The no-progress guard (engine.ts) counts tool calls in a row that did
 *    not advance anything (`ProgressMeter`): no file in the project changed
 *    (`treeStamp`), and the call returned nothing it had not returned before.
 *    Reading a file not read before, a command not run before, or a command
 *    whose output differs from every earlier run of it is progress, wherever
 *    it works: a build into dist/, a venv, a config under /etc. What stops a
 *    run is the same call coming back with the same answer, over and over.
 */
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TREE_SKIP, walk } from "./files.js";
import { STATE_DIRS } from "./statedir.js";

/** Calls without a change before the nudge; as many again and the turn ends. */
export const NO_PROGRESS_CALLS = 30;

/** MAAT_NO_PROGRESS_CALLS when it is a whole number (0 turns the guard off), else the default. */
export function noProgressCallsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAAT_NO_PROGRESS_CALLS?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return NO_PROGRESS_CALLS;
}

/** The path with every existing ancestor's symlinks resolved; the rest kept as written. */
function real(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(p);
      tail.push(head.slice(up.length).replace(/^[/\\]/, ""));
      head = up;
    }
  }
}

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Absolute paths the task text names, and everything under them. Only the
 * path itself: a task that names `/srv/bench/shared.toml` has not opened
 * `/srv/bench/`, where the other tasks' folders are.
 */
export function taskPathsIn(task: string): string[] {
  const out = new Set<string>();
  for (const m of task.matchAll(/(?:^|[\s"'`(=:,<])((?:\/|~\/)[\w.@+-][\w.@+\-/]*)/g)) {
    let p = m[1]!.replace(/[.,:;)]+$/, "");
    if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
    if (p.length < 2) continue;
    out.add(real(p));
  }
  return [...out];
}

export type ScopeVerdict = { kind: "state" | "outside"; message: string } | null;

/**
 * Whether a file tool's path is outside the task, and the refusal to give.
 * Null when the path is part of the task.
 */
export function outsideTask(
  cwd: string,
  path: string,
  opts: { tool: string; taskPaths?: readonly string[] },
): ScopeVerdict {
  const root = real(cwd);
  const target = real(isAbsolute(path) ? path : resolve(cwd, path));
  const shown = path || ".";
  if (!under(target, root)) {
    if ((opts.taskPaths ?? []).some((p) => under(target, p))) return null;
    return {
      kind: "outside",
      message:
        `refused: ${shown} is outside this task. While this job runs, ${opts.tool} reads only the ` +
        `project (${cwd}) and paths the task names. Nothing outside it bears on the task or on how ` +
        `the work will be judged; work on the task's own files. (A scratch file you made outside ` +
        `the project with bash can still be read with bash.)`,
    };
  }
  const rel = relative(root, target).split(sep).join("/");
  // On a case-insensitive disk (macOS, Windows) `.MAAT/log` is `.maat/log`.
  const fold = process.platform === "darwin" || process.platform === "win32" ? rel.toLowerCase() : rel;
  const state = STATE_DIRS.find((d) => fold === d.toLowerCase() || fold.startsWith(`${d.toLowerCase()}/`));
  if (!state) return null;
  // What Maat itself points the model at: a long output it spilled, a background job's log.
  if (opts.tool === "read_file" && /^[^/]+\/(out|bg)\/[^/]+$/.test(fold)) return null;
  return {
    kind: "state",
    message:
      `refused: ${shown} is Maat's own record of this job (${state}/), not part of the task. ` +
      `While the job runs it is closed to ${opts.tool}: nothing in it says how to do the task, and ` +
      `the checks that will judge the work are not in it. Work on the task's own files.`,
  };
}

/** System places a command names to run something, not to look at anything. */
const BENIGN = /^\/(?:dev\/(?:null|zero|u?random|std(?:in|out|err)|fd\/\d+|tty)|proc\/self\/fd\/\d+|(?:usr\/(?:local\/)?)?s?bin(?:\/[\w.+-]+)?)$/;

/**
 * What a bash command reaches outside the task: whether it names the state
 * folder, and the paths outside the project it names. A note for the
 * journal, not a wall: heuristics over a command line, so it may miss a
 * path built at run time, and names a path that is only written to.
 */
export function bashReach(
  cwd: string,
  command: string,
  taskPaths: readonly string[] = [],
): { stateDir: boolean; outside: string[] } {
  const stateDir = new RegExp(`(?:^|[\\s"'\`=:(/<>|;&])(?:${STATE_DIRS.map((d) => d.replace(".", "\\.")).join("|")})(?:/|\\b)`).test(command);
  const root = real(cwd);
  const outside = new Set<string>();
  for (const m of command.matchAll(/(?:^|[\s"'`=:(<>|;&])((?:\/|~\/|\.\.\/|\.\.(?=$|[\s"'`;|&)]))[^\s"'`;|&<>()$*?[\]{}]*)/g)) {
    let p = m[1]!;
    if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
    if (BENIGN.test(p)) continue;
    const abs = real(isAbsolute(p) ? p : resolve(cwd, p));
    if (under(abs, root)) continue;
    if (taskPaths.some((t) => under(abs, t))) continue;
    outside.add(m[1]!);
  }
  return { stateDir, outside: [...outside].slice(0, 20) };
}

/**
 * A fingerprint of the project's files (path, size, modification time),
 * skipping what TREE_SKIP skips (`.maat/`, node_modules, build output). Null
 * when the walk was cut short: a tree that cannot be measured is never
 * counted as one that did not change.
 */
export function treeStamp(root: string): string | null {
  const w = walk(root, { depth: 24, limit: 20_000, skip: TREE_SKIP, deadline: Date.now() + 1_500 });
  if (w.truncated || w.timedOut) return null;
  const h = createHash("sha256");
  for (const e of w.entries) {
    if (e.kind !== "file") {
      h.update(`d\0${e.path}\0`);
      continue;
    }
    let mtime = 0;
    try {
      mtime = statSync(join(root, e.path)).mtimeMs;
    } catch {
      /* gone between the walk and the stat: its absence is in the next stamp */
    }
    h.update(`f\0${e.path}\0${e.bytes ?? 0}\0${mtime}\0`);
  }
  return h.digest("hex");
}

/**
 * Output that differs between two runs of the same command for no reason that
 * matters: durations, clock times, process ids in a "[1] 12345" job line. Left
 * in, every timed test run would count as new output forever.
 */
function settled(result: string): string {
  return result
    .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:[.,]\d+)?)?(?:Z|[+-]\d\d:?\d\d)?/g, "<time>")
    .replace(/\b\d\d:\d\d:\d\d(?:[.,]\d+)?\b/g, "<time>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|s|sec|secs|seconds?|m|min|minutes?)\b/g, "<dur>")
    .replace(/^\[\d+\]\s+\d+$/gm, "<job>");
}

/**
 * Whether each tool call advanced the work, for the no-progress guard.
 *
 * A call advances when its (call, result) pair is new for this turn: a file
 * read for the first time, a command run for the first time, or a command or
 * read whose result differs from every earlier time it was made. The same
 * call with the same answer again is not progress, however it is spelled.
 * Maat's own answers (`[molt: ...]` pointers and complaints) and refusals of
 * paths outside the task are never progress: nothing was read or run.
 * Writes are measured separately, by the tree stamp, and by their result.
 */
export class ProgressMeter {
  private seen = new Set<string>();

  /** `key` is the call in canonical form (tool and arguments); `result` what it returned. */
  advanced(key: string, result: string): boolean {
    const r = result.trimStart();
    if (r.startsWith("[molt:") || r.startsWith("refused:")) return false;
    const pair = createHash("sha256").update(key).update("\0").update(settled(result)).digest("hex");
    if (this.seen.has(pair)) return false;
    this.seen.add(pair);
    return true;
  }
}
