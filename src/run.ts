/**
 * Running a child process without stopping the world.
 *
 * molt used `execSync` for the `bash` tool and for every bar check, which
 * blocks Node's event loop for the whole life of the command — not "is slow",
 * but *stops*: no timers fire, no input is read, nothing repaints. A measured
 * two-second `sleep` produced exactly zero ticks of a 90ms spinner. So the
 * spinner froze mid-frame, the elapsed counter stopped, and every keystroke sat
 * unread in the buffer until the command finished. On a bar whose default
 * timeout is two minutes, that is a two-minute freeze, and the thing you most
 * want to interrupt — a test suite that has clearly gone wrong — was the one
 * thing you could not, because ctrl+C could not be read until it was over.
 *
 * The semantics are `execSync`'s, deliberately, so the callers did not have to
 * change what they promise: stdout and stderr captured separately, a timeout
 * that kills with SIGTERM, and an output cap. What changes is only that the
 * process gets to keep breathing while it waits.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

export type RunOptions = {
  cwd: string;
  /** Kill the command after this long. 0 or undefined means no limit. */
  timeoutMs?: number;
  /** Cap on captured output, per stream. */
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  /** The shell to run it with: `true` is the platform's `sh` (the default); a path runs `<path> -c command`. */
  shell?: string | true;
  /** Kills the command when it aborts, so a turn can be cancelled mid-command. */
  signal?: AbortSignal;
  /**
   * Keep the command out of the process's argv (`/proc/<pid>/cmdline`, `ps`).
   *
   * A hidden check's command is a secret the worker must not learn. Spawned
   * the ordinary way it is an argument to the shell, so it shows up in the
   * command line of a process any user on the box can read — and a check that
   * runs the worker's own deliverable hands that deliverable a process it can
   * read the command out of (even inside a per-check PID namespace, a child
   * can read its parent's cmdline). With this on, the shell is invoked with a
   * tiny fixed wrapper and the real command is streamed in on an inherited
   * file descriptor (fd 3) instead, so it never appears in any argv. stdin is
   * left untouched (the check keeps whatever stdin it had), which is why fd 3
   * is used rather than `sh -s` on stdin. Linux/macOS only; on Windows (no
   * `/proc`, no cheap fd passing) the command is spawned the ordinary way.
   */
  hideCommand?: boolean;
};

export type RunResult = {
  stdout: string;
  stderr: string;
  /** Exit code, or null when the command was killed by a signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when molt killed it for running past `timeoutMs`. */
  timedOut: boolean;
  /** True when output was cut at `maxBuffer`. */
  truncated: boolean;
  /**
   * The command ended, but something it started (a server, a daemon) still
   * held its output open, so molt stopped reading rather than wait for it.
   */
  heldOpen?: boolean;
};

const KILL_GRACE_MS = 2_000;

/**
 * How long to keep reading after the shell itself has exited. Output still in
 * the pipe arrives within milliseconds; anything later belongs to a process
 * the command left running, which may never close it.
 */
export const DRAIN_GRACE_MS = 1_000;

let bashFound: string | null | undefined;

/**
 * Where bash is, or null. Drafted checks run under it rather than `sh`: on a
 * Debian image `/bin/sh` is dash, which has no job control (`kill %1` after a
 * backgrounded server), no `[[`, no `<<<`. Replayed under bash, every
 * `kill %1` check that dash refused passed (reports/checkquality-2026-10-06).
 * `MAAT_CHECK_SHELL=sh` turns it off.
 */
export function bashPath(): string | null {
  if (process.platform === "win32") return null;
  if ((process.env.MAAT_CHECK_SHELL ?? process.env.MOLT_CHECK_SHELL) === "sh") return null;
  if (bashFound !== undefined) return bashFound;
  bashFound = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"].find((p) => existsSync(p)) ?? null;
  return bashFound;
}

/** The shell a drafted (hidden, task-tagged) check runs under; anything else keeps `sh`. */
export function draftedShell(check: { hidden?: boolean; tags?: readonly string[] }): string | true {
  return check.hidden === true && check.tags?.includes("task") ? (bashPath() ?? true) : true;
}

/**
 * Run a command through the shell and resolve with what it did.
 *
 * Never rejects on a non-zero exit — an exit code is a result, not an error,
 * and both callers here treat it as one. It rejects only if the process could
 * not be spawned at all.
 */
export function runCommand(command: string, opts: RunOptions): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcess;
    const hide = opts.hideCommand === true && process.platform !== "win32";
    try {
      if (hide) {
        // The command is streamed in on fd 3 and the shell reads it from
        // there (`eval "$(cat <&3)"`), so the only thing in argv is that fixed
        // wrapper — never the hidden command (see `hideCommand`). `eval` of
        // the whole text runs it exactly as `-c` would; `$0` is the shell, as
        // with `-c`. stdin stays what it was (ignored here), so a check that
        // reads stdin is unaffected.
        const shellPath = opts.shell === undefined || opts.shell === true ? "/bin/sh" : opts.shell;
        child = spawn(shellPath, ["-c", 'eval "$(cat <&3)"'], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ["ignore", "pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
        const sink = child.stdio[3] as NodeJS.WritableStream | null | undefined;
        if (!sink || typeof sink.write !== "function") {
          throw new Error("could not pass the command on fd 3");
        }
        // A check that exits before reading its whole script closes the pipe;
        // the EPIPE that follows is expected, not a failure of the run.
        sink.on("error", () => {});
        sink.end(command);
      } else {
        child = spawn(command, {
          cwd: opts.cwd,
          shell: opts.shell ?? true,
          env: opts.env,
          stdio: ["ignore", "pipe", "pipe"],
          // Its own process group, so a timeout can kill everything the command
          // started and not just the shell (see `kill`).
          detached: process.platform !== "win32",
        });
      }
    } catch (e) {
      reject(e as Error);
      return;
    }

    const cap = opts.maxBuffer ?? Infinity;
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    /**
     * SIGTERM first, SIGKILL if it is ignored. A command that traps SIGTERM
     * would otherwise hold the turn open forever — which is the same freeze
     * this module exists to remove, arriving by a different road.
     */
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    /**
     * The whole group, not the shell. Killing only the shell left a server it
     * had started holding the output pipe, and "close" never came: Terminal-
     * Bench's mailman, reshard-c4-data and install-windows trials sat on one
     * such call until the harness killed them, molt's own deadline included.
     */
    const signalAll = (sig: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        child.kill(sig);
      }
    };
    const kill = () => {
      signalAll("SIGTERM");
      killTimer = setTimeout(() => {
        signalAll("SIGKILL");
        // Killed, and still something holds the pipe (a process that left
        // the group): stop reading so the call returns at all.
        drainTimer ??= setTimeout(() => finish(child.exitCode, child.signalCode, true), DRAIN_GRACE_MS);
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const collect = (which: "out" | "err") => (chunk: Buffer | string) => {
      if (truncated) return;
      const text = String(chunk);
      const current = which === "out" ? stdout : stderr;
      if (current.length + text.length > cap) {
        const room = Math.max(0, cap - current.length);
        if (which === "out") stdout += text.slice(0, room);
        else stderr += text.slice(0, room);
        truncated = true;
        kill();
        return;
      }
      if (which === "out") stdout += text;
      else stderr += text;
    };

    child.stdout?.on("data", collect("out"));
    child.stderr?.on("data", collect("err"));

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs);
    }

    const onAbort = () => kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, signal: NodeJS.Signals | null, heldOpen = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (heldOpen) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      resolve({ stdout, stderr, code, signal, timedOut, truncated, ...(heldOpen ? { heldOpen } : {}) });
    };

    // "close" rather than "exit": exit fires when the process ends, which can
    // be before its pipes have drained, and reading a command's output only to
    // lose the last of it is its own quiet lie. But a process the command
    // started can hold the pipes open forever, so after exit the wait for
    // "close" is bounded.
    child.on("close", (code, signal) => finish(code, signal));
    child.on("exit", (code, signal) => {
      drainTimer ??= setTimeout(() => finish(code, signal, true), DRAIN_GRACE_MS);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
  });
}
