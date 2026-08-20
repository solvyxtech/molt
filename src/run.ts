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

export type RunOptions = {
  cwd: string;
  /** Kill the command after this long. 0 or undefined means no limit. */
  timeoutMs?: number;
  /** Cap on captured output, per stream. */
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  /** Kills the command when it aborts, so a turn can be cancelled mid-command. */
  signal?: AbortSignal;
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
};

const KILL_GRACE_MS = 2_000;

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
    try {
      child = spawn(command, {
        cwd: opts.cwd,
        shell: true,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
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
    const kill = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
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

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code, signal, timedOut, truncated });
    };

    // "close" rather than "exit": exit fires when the process ends, which can
    // be before its pipes have drained, and reading a command's output only to
    // lose the last of it is its own quiet lie.
    child.on("close", finish);
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
  });
}
