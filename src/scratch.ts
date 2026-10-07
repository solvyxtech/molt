/**
 * A throwaway copy of the tree for a task check to run in.
 *
 * A check is supposed to read the work. A drafted one is written by a model
 * before the work exists, and on 2026-10-07 one was sealed as
 * `git checkout master && git merge …`: run in the real folder, it switches
 * the branch and does part of the task itself. The seal-time lint
 * (src/checkwrites.ts) catches the commands it can read; this is the half
 * that does not depend on reading them. Each task check runs in a fresh copy
 * of the tree, `.git` included, and the copy is deleted afterwards, so what
 * a check writes, moves or commits in the project's own files and history
 * never reaches the work it is judging. Linked dependency folders (below)
 * are the exception: they are the real folders, so a check that installs
 * into `node_modules` or builds into `target` still writes there.
 *
 * Cost is kept down three ways:
 *  - files are cloned where the filesystem can (APFS, btrfs, XFS reflinks),
 *    which makes a copy close to free;
 *  - dependency folders (`node_modules`, virtualenvs, build caches) are
 *    linked, not copied: a check needs to import from them, and they are
 *    not the work;
 *  - a large `.git/objects` is shared through git's own alternates file
 *    instead of copied: new objects land in the copy, existing ones are
 *    read from the original, and git never deletes from an alternate.
 * A tree too big to copy within the limits below (or a `.git` that is a
 * pointer file, as in a worktree, which a copy cannot detach from) runs in
 * place, as every check did before this existed; `copyTree` returns null,
 * `whyNoCopy` says why, and the caller records it on the result.
 */
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { STATE_DIRS } from "./statedir.js";

/** Folders that are dependencies or caches, linked into the copy rather than copied. */
export const LINKED_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  ".nox",
  ".gradle",
  ".next",
  ".nuxt",
  ".cache",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "target",
  ".terraform",
  "bower_components",
  ".yarn",
  ".pnpm-store",
]);

/** Beyond these a copy is not taken and the check runs in place. */
export const COPY_MAX_FILES = 20_000;
export const COPY_MAX_BYTES = 512 * 1024 * 1024;
/** A `.git/objects` larger than this is shared through alternates instead of copied. */
export const OBJECTS_COPY_MAX_BYTES = 64 * 1024 * 1024;

export type TreeCopy = {
  /** The copy of the project root. Same base name as the original. */
  dir: string;
  files: number;
  bytes: number;
  ms: number;
  /** Remove the copy. Safe to call twice. */
  cleanup: () => void;
  /** Rewrite the copy's path back to the project's in text a check printed. */
  unmap: (text: string) => string;
};

class TooBig extends Error {}

/** Bytes under a directory, stopping once past `cap`. */
function sizeUpTo(dir: string, cap: number): number {
  let total = 0;
  const walk = (d: string): void => {
    if (total > cap) return;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (total > cap) return;
      const p = join(d, n);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  walk(dir);
  return total;
}

/** Files under `root` the copy would take, stopping once past `cap`. */
function countUpTo(root: string, cap: number): number {
  let n = 0;
  const walk = (d: string, top: boolean): void => {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (n > cap) return;
      if (top && (STATE_DIRS as readonly string[]).includes(e.name)) continue;
      if (e.isDirectory()) {
        if (LINKED_DIRS.has(e.name)) continue;
        walk(join(d, e.name), false);
      } else if (e.isFile()) n += 1;
    }
  };
  walk(root, true);
  return n;
}

/**
 * Copy `root` to a fresh temporary directory. Null when the tree is over
 * the limits or cannot be copied; the caller then runs in place.
 */
export function copyTree(root: string, limits: { maxFiles?: number; maxBytes?: number } = {}): TreeCopy | null {
  const r = copyTreeOrWhy(root, limits);
  return "why" in r ? null : r;
}

/** Why the last tree had no copy, for a caller that got null. */
export function copyTreeOrWhy(
  root: string,
  limits: { maxFiles?: number; maxBytes?: number } = {},
): TreeCopy | { why: string } {
  const t0 = Date.now();
  const maxFiles = limits.maxFiles ?? COPY_MAX_FILES;
  const maxBytes = limits.maxBytes ?? COPY_MAX_BYTES;
  let gitLink = false;
  try {
    gitLink = lstatSync(join(root, ".git")).isFile();
  } catch {
    /* no .git */
  }
  if (gitLink) return { why: "its .git is a pointer file (a worktree or submodule), which a copy cannot detach from" };
  // Counted first, names only: a tree over the limit is found out in a
  // fraction of what copying up to the limit and throwing it away costs.
  if (countUpTo(root, maxFiles) > maxFiles) return { why: `the tree has over ${maxFiles} files` };
  let tmp: string;
  try {
    tmp = mkdtempSync(join(tmpdir(), "maat-check-"));
  } catch (e) {
    return { why: `no temporary directory (${e instanceof Error ? e.message : String(e)})` };
  }
  const dest = join(tmp, basename(root) || "work");
  let files = 0;
  let bytes = 0;
  const copyDir = (src: string, dst: string, top: boolean, inGit: boolean): void => {
    mkdirSync(dst, { recursive: true });
    for (const ent of readdirSync(src, { withFileTypes: true })) {
      const name = ent.name;
      if (top && (STATE_DIRS as readonly string[]).includes(name)) continue;
      const s = join(src, name);
      const d = join(dst, name);
      if (ent.isSymbolicLink()) {
        symlinkSync(readlinkSync(s), d);
        continue;
      }
      if (ent.isDirectory()) {
        if (!inGit && LINKED_DIRS.has(name)) {
          symlinkSync(s, d);
          continue;
        }
        if (name === ".git" && !inGit) {
          copyGit(s, d);
          continue;
        }
        copyDir(s, d, false, inGit);
        continue;
      }
      if (!ent.isFile()) continue;
      const st = lstatSync(s);
      files += 1;
      bytes += st.size;
      if (files > maxFiles || bytes > maxBytes) throw new TooBig();
      copyFileSync(s, d, constants.COPYFILE_FICLONE);
      // Same mtimes: `make`, git's index and a check that compares ages all read them.
      utimesSync(d, st.atime, st.mtime);
    }
  };
  const copyGit = (src: string, dst: string): void => {
    mkdirSync(dst, { recursive: true });
    for (const ent of readdirSync(src, { withFileTypes: true })) {
      const s = join(src, ent.name);
      const d = join(dst, ent.name);
      if (ent.name === "objects" && ent.isDirectory() && sizeUpTo(s, OBJECTS_COPY_MAX_BYTES) > OBJECTS_COPY_MAX_BYTES) {
        // Shared, read-only from the copy's side: git writes new objects to
        // the copy's own store and never prunes an alternate.
        mkdirSync(join(d, "info"), { recursive: true });
        mkdirSync(join(d, "pack"), { recursive: true });
        writeFileSync(join(d, "info", "alternates"), `${realpathSync(s)}\n`);
        continue;
      }
      if (ent.isSymbolicLink()) symlinkSync(readlinkSync(s), d);
      else if (ent.isDirectory()) copyDir(s, d, false, true);
      else if (ent.isFile()) {
        const st = lstatSync(s);
        files += 1;
        bytes += st.size;
        if (files > maxFiles || bytes > maxBytes) throw new TooBig();
        copyFileSync(s, d, constants.COPYFILE_FICLONE);
        utimesSync(d, st.atime, st.mtime);
      }
    }
  };
  const cleanup = () => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* a temp dir left behind is the OS's to clear */
    }
  };
  try {
    copyDir(root, dest, true, false);
  } catch (e) {
    cleanup();
    return {
      why: e instanceof TooBig
        ? `the tree is over ${maxFiles} files or ${Math.round(maxBytes / 1024 / 1024)} MB`
        : `the copy failed (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  let realDest = dest;
  let realRoot = root;
  try {
    realDest = realpathSync(dest);
    realRoot = realpathSync(root);
  } catch {
    /* compare as given */
  }
  const pairs: [string, string][] = [
    [realDest, realRoot],
    [dest, root],
  ];
  return {
    dir: dest,
    files,
    bytes,
    ms: Date.now() - t0,
    cleanup,
    unmap: (text) => {
      let out = text;
      for (const [from, to] of pairs) if (from !== to) out = out.split(from).join(to);
      return out;
    },
  };
}

/**
 * Should this check run in a copy? Every task check does: drafted, hidden,
 * passed with --criteria, or a mission's assertion. A project's own done.yml
 * checks run where they always ran — a person wrote them to build and test
 * in place — and so do builtins, which read Maat's records, not the tree.
 * MAAT_CHECK_COPY=0 turns it off.
 */
export function runsInCopy(check: { kind: string; hidden?: boolean; tags?: readonly string[] }): boolean {
  if (process.env.MAAT_CHECK_COPY === "0") return false;
  if (check.kind !== "command") return false;
  return check.hidden === true || (check.tags ?? []).some((t) => t === "task" || t === "mission");
}
