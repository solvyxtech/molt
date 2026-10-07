/**
 * A backend subprocess, and everything it started, ended together.
 *
 * `child.kill()` signals one pid. A CLI agent (Grok Build, OpenCode) runs its
 * own helpers under it — a language server, a shell, a node worker — and those
 * outlived the agent they belonged to. On a bench run one ACP turn hung for
 * an hour; ending it has to end the whole tree, or the next job inherits
 * whatever the last one left running.
 *
 * So each backend is started as the leader of its own process group
 * (`detached`), and ending it signals the group: SIGTERM, then SIGKILL a
 * moment later for anything that did not listen. A group still registered
 * when Maat itself exits is killed on the way out, so a `process.exit` at the
 * end of a headless run never leaves an agent behind. Windows has no process
 * groups; there the leader is killed as before.
 */
import type { ChildProcess } from "node:child_process";

/** How long a group gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 1_500;

const groups = new Set<number>();
let hooked = false;

/** Spawn options that make the child lead its own process group, where that exists. */
export function groupSpawn(): { detached: boolean } {
  return { detached: process.platform !== "win32" };
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Track a child started with `groupSpawn()`. Its group is killed when the
 * leader exits (whatever it left running is an orphan nobody will reap) and
 * when Maat exits.
 */
export function trackGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || process.platform === "win32") return;
  groups.add(pid);
  if (!hooked) {
    hooked = true;
    process.on("exit", () => {
      for (const g of groups) signalGroup(g, "SIGKILL");
      groups.clear();
    });
  }
  child.once("exit", () => {
    // The leader is gone; anything still in its group was its, and stays only
    // because nobody ended it.
    signalGroup(pid, "SIGKILL");
    groups.delete(pid);
  });
}

/** End a backend child and everything in its process group. */
export function killTree(child: ChildProcess | undefined): void {
  if (!child) return;
  const pid = child.pid;
  if (pid === undefined || process.platform === "win32" || !groups.has(pid)) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    return;
  }
  if (!signalGroup(pid, "SIGTERM")) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  const t = setTimeout(() => {
    if (!groups.has(pid)) return;
    signalGroup(pid, "SIGKILL");
    groups.delete(pid);
  }, KILL_GRACE_MS);
  t.unref?.();
}
