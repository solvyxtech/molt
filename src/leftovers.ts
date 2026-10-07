/**
 * What running the checks left in the project, and removing it.
 *
 * A check that runs the task's own command runs its side effects too:
 * `gcc main.py.c -o /app/polyglot/cmain` left `cmain` beside the one file the
 * task asked for, and the grader, which requires that file to be alone,
 * failed two polyglot tasks molt had verified. Only paths that appeared while
 * the checks ran go — never a file that existed before them — and nothing at
 * all when the project could not be listed in full either time.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { TREE_SKIP, walk } from "./files.js";
import { STATE_DIRS } from "./statedir.js";

export type ProjectListing = { files: Set<string>; dirs: Set<string> };

/** Every file and folder under `root` (molt's skip list aside), or null when the walk was cut short. */
export function listProject(root: string): ProjectListing | null {
  const w = walk(root, { depth: 24, limit: 20_000, skip: TREE_SKIP, deadline: Date.now() + 3_000 });
  if (w.truncated || w.timedOut) return null;
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const e of w.entries) (e.kind === "file" ? files : dirs).add(e.path.replace(/\/$/, ""));
  return { files, dirs };
}

/** Remove what appeared under `root` since `before`. Returns what was removed (folders end in /). */
export function removeNew(root: string, before: ProjectListing | null): string[] {
  if (!before) return [];
  const after = listProject(root);
  if (!after) return [];
  const removed: string[] = [];
  for (const f of after.files) {
    if (before.files.has(f)) continue;
    try {
      rmSync(join(root, f), { force: true });
      removed.push(f);
    } catch {
      // left in place; only what was removed is reported
    }
  }
  const dirs = [...after.dirs].filter((d) => !before.dirs.has(d)).sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    try {
      rmdirSync(join(root, d));
      removed.push(`${d}/`);
    } catch {
      // not empty: something else lives there
    }
  }
  return removed;
}

/**
 * Keep molt's own records out of `git status`.
 *
 * molt writes `.maat/` (receipts, journal, spilled output) into the project.
 * In a git repository that showed up as an untracked folder, and a task
 * whose grader requires a clean working tree failed on it alone: git-revert-
 * one did exactly the right revert and was marked wrong for `?? .maat/`. A
 * person running `git status` sees the same noise. The repository's own
 * local exclude file (`info/exclude`, never committed, never shared) is the
 * place for it — not the project's .gitignore, which is theirs.
 */
export function excludeMoltFromGit(cwd: string): boolean {
  try {
    const path = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    if (!path) return false;
    const file = isAbsolute(path) ? path : join(cwd, path);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const missing = STATE_DIRS.filter((d) => !new RegExp(`^\\/?\\${d}\\/?$`, "m").test(text));
    if (!missing.length) return false;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}# Maat Agent's own records\n${missing.map((d) => `${d}/`).join("\n")}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Files that appeared since `before` which the task text never names — by
 * path, by file name, or by a folder they sit in ("sorted/" covers
 * sorted/a/b.txt). The likely leftovers: a helper script, a copy, a test
 * file the worker made for itself. On local redact-secrets the work was right
 * and failed only on the redact.py left beside it, against "create no other
 * files"; organize-files the same with organize.py.
 */
export function unnamedNewFiles(before: ProjectListing | null, after: ProjectListing | null, task: string): string[] {
  if (!before || !after) return [];
  const out: string[] = [];
  for (const f of after.files) {
    if (before.files.has(f)) continue;
    const parts = f.split("/");
    const names = [f, parts.at(-1)!, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"))];
    if (names.some((n) => n && task.includes(n))) continue;
    out.push(f);
  }
  return out.sort();
}
