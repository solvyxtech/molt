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
 * a check writes, moves or commits in the project's files and history never
 * reaches the work it is judging.
 *
 * What the copy does NOT cover: a large dependency folder (below) is linked,
 * not copied, so it is the real folder, and a check that installs into
 * `node_modules`, builds into `target` or writes a `.cache` still writes
 * there. A symlink already in the tree is copied as a link and writes
 * through to wherever it points. A check can change those; it cannot change
 * the rest of the tree.
 *
 * Cost is kept down three ways:
 *  - files are cloned where the filesystem can (APFS, btrfs, XFS reflinks),
 *    which makes a copy close to free;
 *  - dependency folders (`node_modules`, virtualenvs, build caches) over
 *    LINK_OVER_FILES files or LINK_OVER_BYTES are linked, not copied; a
 *    small one is copied like the rest (and so is a source folder that only
 *    happens to be called `target`);
 *  - a large `.git/objects` is shared through git's own alternates file
 *    instead of copied: new objects land in the copy, existing ones are
 *    read from the original, and git never deletes from an alternate.
 * The copy is asynchronous, so the event loop (timers, Ctrl-C, the deadline)
 * keeps running while it is taken on a filesystem that cannot clone.
 * A tree too big to copy within the limits below (or a `.git` that is a
 * pointer file, as in a worktree, which a copy cannot detach from) gets no
 * copy: `copyTreeOrWhy` says why, and the caller records it (a task check
 * then runs in place and says so; a reviewer's objection is not run).
 */
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
/** A dependency folder over either of these is linked; under both, copied. */
export const LINK_OVER_FILES = 2_000;
export const LINK_OVER_BYTES = 32 * 1024 * 1024;

export type TreeCopy = {
  /** The copy of the project root. Same base name as the original. */
  dir: string;
  files: number;
  bytes: number;
  ms: number;
  /** Folders linked to the real ones rather than copied, relative to the root. */
  linked: string[];
  /** Remove the copy. Safe to call twice. */
  cleanup: () => Promise<void>;
  /** Rewrite the copy's path back to the project's in text a check printed. */
  unmap: (text: string) => string;
};

class TooBig extends Error {}

/**
 * A file or folder that went away between being listed and being copied.
 *
 * git runs `maintenance --auto` / `gc --auto` detached after a commit, and it
 * creates and removes files under `.git` while the copy is being taken. One
 * vanished temp file failed the whole copy, and the check then ran in place —
 * on the work. A path that is gone is simply not in the tree any more.
 */
function vanished(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Files and bytes under a directory, stopping once past either cap. */
async function sizeUpTo(dir: string, capFiles: number, capBytes: number): Promise<{ files: number; bytes: number }> {
  const total = { files: 0, bytes: 0 };
  const over = () => total.files > capFiles || total.bytes > capBytes;
  const walk = async (d: string): Promise<void> => {
    if (over()) return;
    let ents;
    try {
      ents = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (over()) return;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        total.files += 1;
        try {
          total.bytes += (await lstat(p)).size;
        } catch {
          /* gone */
        }
      }
    }
  };
  await walk(dir);
  return total;
}

/** Files under `root` the copy would take, stopping once past `cap`. Dependency folders are counted when copied. */
async function countUpTo(root: string, cap: number): Promise<number> {
  let n = 0;
  const walk = async (d: string, top: boolean): Promise<void> => {
    let ents;
    try {
      ents = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (n > cap) return;
      if (top && (STATE_DIRS as readonly string[]).includes(e.name)) continue;
      if (e.isDirectory()) {
        if (LINKED_DIRS.has(e.name)) continue;
        await walk(join(d, e.name), false);
      } else if (e.isFile()) n += 1;
    }
  };
  await walk(root, true);
  return n;
}

/**
 * Copy `root` to a fresh temporary directory. Null when the tree is over
 * the limits or cannot be copied; the caller then runs in place.
 */
export type CopyLimits = { maxFiles?: number; maxBytes?: number; linkOverFiles?: number };

export async function copyTree(root: string, limits: CopyLimits = {}): Promise<TreeCopy | null> {
  const r = await copyTreeOrWhy(root, limits);
  return "why" in r ? null : r;
}

/** A copy of the tree, or why there is none. */
export async function copyTreeOrWhy(
  root: string,
  limits: CopyLimits = {},
): Promise<TreeCopy | { why: string }> {
  const t0 = Date.now();
  const linkOverFiles = limits.linkOverFiles ?? LINK_OVER_FILES;
  const maxFiles = limits.maxFiles ?? COPY_MAX_FILES;
  const maxBytes = limits.maxBytes ?? COPY_MAX_BYTES;
  let gitLink = false;
  try {
    gitLink = (await lstat(join(root, ".git"))).isFile();
  } catch {
    /* no .git */
  }
  if (gitLink) return { why: "its .git is a pointer file (a worktree or submodule), which a copy cannot detach from" };
  // Counted first, names only: a tree over the limit is found out in a
  // fraction of what copying up to the limit and throwing it away costs.
  if ((await countUpTo(root, maxFiles)) > maxFiles) return { why: `the tree has over ${maxFiles} files` };
  let tmp: string;
  try {
    tmp = await mkdtemp(join(tmpdir(), "maat-check-"));
  } catch (e) {
    return { why: `no temporary directory (${e instanceof Error ? e.message : String(e)})` };
  }
  const dest = join(tmp, basename(root) || "work");
  let files = 0;
  let bytes = 0;
  const linked: string[] = [];
  const copyOne = async (s: string, d: string): Promise<void> => {
    let st;
    try {
      st = await lstat(s);
    } catch (e) {
      if (vanished(e)) return;
      throw e;
    }
    files += 1;
    bytes += st.size;
    if (files > maxFiles || bytes > maxBytes) throw new TooBig();
    try {
      await copyFile(s, d, constants.COPYFILE_FICLONE);
      // Same mtimes: `make`, git's index and a check that compares ages all read them.
      await utimes(d, st.atime, st.mtime);
    } catch (e) {
      if (!vanished(e)) throw e;
      await rm(d, { force: true }).catch(() => {});
    }
  };
  const copyLink = async (s: string, d: string): Promise<void> => {
    try {
      await symlink(await readlink(s), d);
    } catch (e) {
      if (!vanished(e)) throw e;
    }
  };
  const list = async (src: string) => {
    try {
      return await readdir(src, { withFileTypes: true });
    } catch (e) {
      if (vanished(e)) return [];
      throw e;
    }
  };
  const copyDir = async (src: string, dst: string, top: boolean, inGit: boolean): Promise<void> => {
    await mkdir(dst, { recursive: true });
    for (const ent of await list(src)) {
      const name = ent.name;
      if (top && (STATE_DIRS as readonly string[]).includes(name)) continue;
      const s = join(src, name);
      const d = join(dst, name);
      if (ent.isSymbolicLink()) {
        await copyLink(s, d);
        continue;
      }
      if (ent.isDirectory()) {
        if (!inGit && LINKED_DIRS.has(name)) {
          const size = await sizeUpTo(s, linkOverFiles, LINK_OVER_BYTES);
          if (size.files > linkOverFiles || size.bytes > LINK_OVER_BYTES) {
            await symlink(s, d);
            linked.push(s.slice(root.length + 1));
            continue;
          }
        }
        if (name === ".git" && !inGit) {
          await copyGit(s, d);
          continue;
        }
        await copyDir(s, d, false, inGit);
        continue;
      }
      if (!ent.isFile()) continue;
      await copyOne(s, d);
    }
  };
  const copyGit = async (src: string, dst: string): Promise<void> => {
    await mkdir(dst, { recursive: true });
    for (const ent of await list(src)) {
      const s = join(src, ent.name);
      const d = join(dst, ent.name);
      if (ent.name === "objects" && ent.isDirectory() && (await sizeUpTo(s, Infinity, OBJECTS_COPY_MAX_BYTES)).bytes > OBJECTS_COPY_MAX_BYTES) {
        // Shared, read-only from the copy's side: git writes new objects to
        // the copy's own store and never prunes an alternate.
        await mkdir(join(d, "info"), { recursive: true });
        await mkdir(join(d, "pack"), { recursive: true });
        await writeFile(join(d, "info", "alternates"), `${await realpath(s)}\n`);
        continue;
      }
      if (ent.isSymbolicLink()) await copyLink(s, d);
      else if (ent.isDirectory()) await copyDir(s, d, false, true);
      else if (ent.isFile()) await copyOne(s, d);
    }
  };
  const cleanup = async () => {
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      /* a temp dir left behind is the OS's to clear */
    }
  };
  try {
    await copyDir(root, dest, true, false);
  } catch (e) {
    await cleanup();
    return {
      why: e instanceof TooBig
        ? `the tree is over ${maxFiles} files or ${Math.round(maxBytes / 1024 / 1024)} MB`
        : `the copy failed (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  let realDest = dest;
  let realRoot = root;
  try {
    realDest = await realpath(dest);
    realRoot = await realpath(root);
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
    linked,
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

/**
 * A digest of a tree as it stands: every path, its type and mode, each file's
 * size and content hash, each link's target. Links are not followed. Two
 * calls agree only if nothing under `dir` was added, removed or changed.
 */
export async function digestTree(dir: string): Promise<string> {
  const h = createHash("sha256");
  const walk = async (abs: string, rel: string): Promise<void> => {
    const names = (await readdir(abs)).sort();
    for (const n of names) {
      const p = join(abs, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = await lstat(p);
      if (st.isSymbolicLink()) h.update(`l ${r} ${await readlink(p)}\0`);
      else if (st.isDirectory()) {
        h.update(`d ${r} ${st.mode}\0`);
        await walk(p, r);
      } else if (st.isFile()) {
        h.update(`f ${r} ${st.mode} ${st.size} `).update(createHash("sha256").update(await readFile(p)).digest("hex")).update("\0");
      } else h.update(`o ${r} ${st.mode}\0`);
    }
  };
  await walk(dir, "");
  return h.digest("hex");
}

/**
 * A copy of the project taken before the work, that can say whether it is
 * still as it was taken.
 *
 * The copy lives in a fresh 0700 directory under Maat's temporary folder
 * (with --worker-user that folder is Maat's private state dir, out of the
 * worker uid's reach). A worker running as Maat's own uid can still reach it,
 * and editing it would turn a check that passes on the pristine tree into one
 * that "failed before the work". So its digest is taken when it is made and
 * checked around every later try: a copy that changed is not the tree before
 * the work, and checks tried on it count as not tried.
 */
export type PreWorkCopy = TreeCopy & { digest: string; intact: () => Promise<boolean> };

export async function preWorkCopy(root: string): Promise<PreWorkCopy | null> {
  const c = await copyTree(root);
  if (!c) return null;
  try {
    await chmod(join(c.dir, ".."), 0o700);
    const digest = await digestTree(c.dir);
    return {
      ...c,
      digest,
      intact: async () => {
        try {
          return (await digestTree(c.dir)) === digest;
        } catch {
          return false;
        }
      },
    };
  } catch {
    await c.cleanup();
    return null;
  }
}
