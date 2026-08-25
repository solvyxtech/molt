/**
 * The PATH a GUI app does not inherit.
 *
 * A desktop app launched from Finder, the Dock or `open` gets its environment
 * from launchd, not from a login shell: `/usr/bin:/bin:/usr/sbin:/sbin` and
 * nothing else. Homebrew, nvm, asdf, pyenv, cargo and every other tool a
 * project's bar actually calls live outside those four directories.
 *
 * The consequence is specific and it is the worst one molt has: every command
 * check fails with `/bin/sh: npm: command not found`, exit 127, in about four
 * milliseconds. From a real session — 4.8M tokens, three turns, all refused —
 * `types`, `tests`, `app-boots` and `app-drives` failed that way every time,
 * while the model was separately running the same commands by hand with an
 * explicit PATH and getting 938 passing tests. molt refused work that was
 * correct, told the model its suite was broken when it was not, and the model
 * spent its last eight steps of a thirty-two step budget diagnosing molt.
 *
 * A verification tool that cannot run the verification is worse than no
 * verification tool, because its failures are indistinguishable from yours.
 *
 * So the shell is asked what PATH a login would have had. The pieces below are
 * split into pure functions because the spawn is the only part that cannot be
 * tested honestly, and it is kept to as few lines as possible.
 */
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Wrapped in markers because an interactive shell prints whatever the user's
 * rc files print — banners, version notices, direnv output. Without them the
 * first line of a motd becomes the PATH.
 */
export const PATH_BEGIN = "__MOLT_PATH_BEGIN__";
export const PATH_END = "__MOLT_PATH_END__";

/** What molt asks the login shell to print. */
export const PATH_PROBE = `printf '%s%s%s' '${PATH_BEGIN}' "$PATH" '${PATH_END}'`;

/** The PATH between the markers, or null if the shell said nothing usable. */
export function parseLoginPath(stdout: string): string | null {
  const a = stdout.indexOf(PATH_BEGIN);
  if (a < 0) return null;
  const b = stdout.indexOf(PATH_END, a + PATH_BEGIN.length);
  if (b < 0) return null;
  const found = stdout.slice(a + PATH_BEGIN.length, b).trim();
  return found.length > 0 ? found : null;
}

/**
 * Where a Homebrew/nvm-shaped toolchain lives, for when the shell cannot be
 * asked. A guess, and used only as one — it is appended after whatever the
 * process already had, and a directory that does not exist is dropped.
 */
export function fallbackDirs(home: string | undefined, platform: string): string[] {
  if (platform === "win32") return [];
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
  if (home) {
    dirs.push(join(home, ".local", "bin"));
    dirs.push(join(home, ".volta", "bin"));
    dirs.push(join(home, ".cargo", "bin"));
  }
  return dirs;
}

/**
 * Existing entries first, then new ones, without duplicates.
 *
 * Order matters and the inherited PATH wins: a project pinned to a particular
 * toolchain by whatever launched it must not be silently switched to another
 * one because a login shell prefers it. This only ever *adds* places to look,
 * which is the whole of what a GUI launch is missing.
 */
export function mergePath(current: string | undefined, extra: string | undefined): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [...(current ?? "").split(delimiter), ...(extra ?? "").split(delimiter)]) {
    const p = part.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join(delimiter);
}

/**
 * Whether a PATH can already find a command.
 *
 * Used to skip the shell entirely when molt was started from a terminal, which
 * is every developer run of `npm run app` and every CLI invocation. `exists`
 * is injected so this is testable without depending on what is installed on
 * the machine running the tests.
 */
export function pathCanFind(
  path: string | undefined,
  cmd: string,
  exists: (p: string) => boolean = existsSync,
): boolean {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir.trim()) continue;
    if (exists(join(dir.trim(), cmd))) return true;
  }
  return false;
}

export type PathFixReport = {
  /** What happened, for the log and the settings pane. */
  outcome: "already-usable" | "from-login-shell" | "from-fallback" | "unchanged";
  path: string;
  /** Directories that were not on PATH before. */
  added: string[];
  shell?: string;
  error?: string;
};

/**
 * Decide the PATH the app should run with. Pure: the caller does the spawning.
 *
 * `probe` returns the login shell's stdout, or null if it could not be asked.
 * It is only called when the current PATH cannot already find `cmd`, so the
 * common case costs nothing.
 */
export function resolvePath(opts: {
  current: string | undefined;
  cmd: string;
  platform: string;
  home: string | undefined;
  probe: () => string | null;
  exists?: (p: string) => boolean;
}): PathFixReport {
  const { current, cmd, platform, home, probe } = opts;
  const exists = opts.exists ?? existsSync;
  const before = new Set((current ?? "").split(delimiter).filter(Boolean));
  const added = (next: string): string[] =>
    next.split(delimiter).filter((p) => p && !before.has(p));

  if (pathCanFind(current, cmd, exists)) {
    return { outcome: "already-usable", path: current ?? "", added: [] };
  }

  const out = probe();
  if (out !== null) {
    const login = parseLoginPath(out);
    if (login && pathCanFind(login, cmd, exists)) {
      const merged = mergePath(current, login);
      return { outcome: "from-login-shell", path: merged, added: added(merged) };
    }
  }

  // The shell could not be asked, or its PATH could not find the command
  // either. Guessing is worse than asking and better than failing at exit 127
  // with a message about a command the user has definitely installed.
  const guess = fallbackDirs(home, platform).filter((d) => exists(d));
  const merged = mergePath(current, guess.join(delimiter));
  if (merged !== (current ?? "")) {
    return { outcome: "from-fallback", path: merged, added: added(merged) };
  }
  return { outcome: "unchanged", path: current ?? "", added: [] };
}
