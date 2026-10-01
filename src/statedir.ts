/**
 * Where the agent keeps its records in a project: `.maat/`.
 *
 * The product is Maat Agent; the folder people open and commit is named for
 * it. Projects that already have a `.molt/` folder — the engine's old name —
 * keep using it, so nobody's receipts, journal or hash chains move under them:
 *
 *   `.maat/` exists        → `.maat/`
 *   else `.molt/` exists   → `.molt/`   (read and written in place)
 *   neither                → `.maat/`   (created on first write)
 *
 * The checks file is looked up across both, because a person's
 * `.molt/done.yml` must never be ignored because a `.maat/` appeared later.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const STATE_DIR = ".maat";
export const LEGACY_STATE_DIR = ".molt";
/** Both names, for anything that must skip or recognise the folder. */
export const STATE_DIRS = [STATE_DIR, LEGACY_STATE_DIR] as const;

/** The folder name this project uses (see above). */
export function stateDirName(root: string): string {
  if (existsSync(join(root, STATE_DIR))) return STATE_DIR;
  if (existsSync(join(root, LEGACY_STATE_DIR))) return LEGACY_STATE_DIR;
  return STATE_DIR;
}

/** The absolute folder, optionally with a path inside it. */
export function stateDir(root: string, ...parts: string[]): string {
  return join(root, stateDirName(root), ...parts);
}

/** `.maat/<file>` if it exists, else `.molt/<file>` if that does, else where a new one goes. */
export function stateFile(root: string, file: string): string {
  for (const d of STATE_DIRS) {
    const p = join(root, d, file);
    if (existsSync(p)) return p;
  }
  return stateDir(root, file);
}

/** Is this project-relative path inside the agent's own folder? */
export function inStateDir(rel: string): boolean {
  const p = rel.replace(/^\.\//, "");
  return STATE_DIRS.some((d) => p === d || p.startsWith(`${d}/`));
}
