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
 *
 * A detached group is out of the terminal's foreground group, so Ctrl-C and a
 * hangup no longer reach the agent with Maat — and Node runs no `exit`
 * handlers when it dies of a signal it has no listener for. So the first
 * tracked group also installs SIGINT/SIGTERM/SIGHUP listeners (only where
 * nobody else listens, as src/background.ts does): they end every group and
 * exit with the conventional 128 + signal number, which runs the `exit`
 * handlers of everything else on the way out.
 */
import type { ChildProcess } from "node:child_process";

/** How long a group gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 1_500;

/** Tracked group leaders, and the pending SIGKILL of a group being ended. */
const groups = new Map<number, ReturnType<typeof setTimeout> | null>();
let hooked = false;

const SIGNAL_EXIT: Record<"SIGINT" | "SIGTERM" | "SIGHUP", number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function killAllNow(): void {
  for (const [g, t] of groups) {
    if (t) clearTimeout(t);
    signalGroup(g, "SIGKILL");
  }
  groups.clear();
}

function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", killAllNow);
  for (const sig of Object.keys(SIGNAL_EXIT) as (keyof typeof SIGNAL_EXIT)[]) {
    if (process.listenerCount(sig) === 0) {
      process.once(sig, () => {
        // A moment's SIGTERM would be kinder, but the process is going now and
        // nothing would be left to send the SIGKILL after it.
        for (const g of groups.keys()) signalGroup(g, "SIGTERM");
        killAllNow();
        process.exit(SIGNAL_EXIT[sig]);
      });
    }
  }
}

/**
 * End a group: SIGTERM now, SIGKILL after KILL_GRACE_MS for whatever did not
 * listen. A group already being ended keeps the SIGKILL it has.
 */
function endGroup(pid: number, termSent = false): void {
  if (groups.get(pid)) return;
  if (!termSent) signalGroup(pid, "SIGTERM");
  const t = setTimeout(() => {
    if (!groups.has(pid)) return;
    signalGroup(pid, "SIGKILL");
    groups.delete(pid);
  }, KILL_GRACE_MS);
  t.unref?.();
  groups.set(pid, t);
}

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
  groups.set(pid, null);
  hookExit();
  child.once("exit", () => {
    // The leader is gone; anything still in its group was its, and stays only
    // because nobody ended it. It gets the same SIGTERM-then-SIGKILL as
    // killTree (and keeps killTree's timer if that is what ended the leader).
    if (groups.has(pid)) endGroup(pid);
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
  if (groups.get(pid)) return;
  if (!signalGroup(pid, "SIGTERM")) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  endGroup(pid, true);
}
