/**
 * How much molt may do without asking.
 *
 * Every approval prompt is a tax on a task that was going to be approved
 * anyway, and a prompt that is always answered "yes" stops being a control
 * at all — it becomes a reflex. Autonomy levels move that decision up a
 * layer: you say once how far molt may go, and molt asks only at the edge of
 * it.
 *
 * Three rules govern everything here:
 *
 *  1. **Mechanical.** No model judges what is safe. Every decision is a pure
 *     function of the level, the tool call, and the project directory, so it
 *     can be tested exhaustively and read by a person who wants to know what
 *     they just agreed to.
 *  2. **Deny by default.** Anything the classifier does not positively
 *     recognise is a prompt. A new tool, an unusual flag, a shell
 *     construction nobody thought about — all ask.
 *  3. **Not a sandbox.** This decides what to ASK about, not what is
 *     possible. Autonomy is a convenience over a permission prompt, and a
 *     command that runs is a command that can do anything the user can. High
 *     autonomy on a machine that matters is the user's call to make, in the
 *     open, with the level on screen while it works.
 */
import { isAbsolute, resolve } from "node:path";

export type Autonomy = "low" | "medium" | "high";

export const AUTONOMY_LEVELS: readonly Autonomy[] = ["low", "medium", "high"];

export const DEFAULT_AUTONOMY: Autonomy = "low";

/** One line each, for the status line and `/autonomy`. */
export const AUTONOMY_SUMMARY: Record<Autonomy, string> = {
  low: "asks before every command and every write",
  medium: "runs searches, read-only commands, and writes inside the project",
  high: "runs everything except what cannot be undone",
};

export function isAutonomy(v: string): v is Autonomy {
  return (AUTONOMY_LEVELS as readonly string[]).includes(v);
}

/** Cycle low → medium → high → low, for a single key that raises the ceiling. */
export function nextAutonomy(a: Autonomy): Autonomy {
  const i = AUTONOMY_LEVELS.indexOf(a);
  return AUTONOMY_LEVELS[(i + 1) % AUTONOMY_LEVELS.length]!;
}

/**
 * Commands that only read.
 *
 * Deliberately short. Every entry is something whose whole purpose is to
 * report, and anything that can write a file, install a package, reach the
 * network with a payload, or change history is absent — including tools like
 * `sed` and `awk` that read in the common case and write in the flag.
 */
const READ_ONLY: Record<string, true> = {
  ls: true, cat: true, head: true, tail: true, wc: true, nl: true,
  grep: true, egrep: true, fgrep: true, rg: true, ag: true, ack: true,
  find: true, fd: true, file: true, stat: true, tree: true, du: true, df: true,
  pwd: true, echo: true, printf: true, which: true, whoami: true, date: true,
  basename: true, dirname: true, realpath: true, readlink: true,
  sort: true, uniq: true, cut: true, tr: true, diff: true, cmp: true, jq: true,
  true: true, false: true, env: true, uname: true, hostname: true, sleep: true,
};

/** Subcommands of `git` that only report. Anything else asks. */
const GIT_READ_ONLY: Record<string, true> = {
  status: true, log: true, diff: true, show: true, branch: true, remote: true,
  "ls-files": true, "rev-parse": true, blame: true, describe: true,
  shortlog: true, "cat-file": true, tag: true, config: true, stash: true,
};

/** Package-manager subcommands that run project scripts rather than mutate deps. */
const PKG_SCRIPTS: Record<string, true> = { test: true, run: true, ls: true, why: true, outdated: true, view: true };

/**
 * curl and wget flags that stop them being a read.
 *
 * A GET is a lookup — the weather, a doc page, an API status. A POST, an
 * upload, or an `-o` that lands a file on disk is not, so any of these send
 * the call back to a prompt.
 */
const NET_WRITE_FLAGS = [
  "-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
  "-F", "--form", "-T", "--upload-file", "-o", "--output", "-O", "--remote-name",
  "--create-dirs", "-i", "--head",
];

/**
 * Redirections that cannot write anything: throwing output away, or pointing
 * one file descriptor at another.
 *
 * The name must end there: `> /dev/nullx` is an ordinary file, and a pattern
 * without that boundary would wave it through.
 *
 * `ls -la .molt 2>/dev/null` is how everybody writes an exploratory command,
 * and treating its `>` as a file write sent every such call to a prompt — in a
 * headless run, to a refusal. A model that cannot list a directory guesses
 * filenames instead, which is worse for everyone than allowing a discard.
 */
const HARMLESS_REDIRECT = /(?:\d?>>?|&>)\s*\/dev\/null(?![\w/])|\d?>&\d/g;

/**
 * Constructions that make a command's effect unreadable from its text.
 *
 * Substitution and redirection to a path can write files or run words that are
 * not in the command as written, so their presence alone is enough to ask — no
 * attempt is made to reason about what is inside them.
 */
const OPAQUE = /(\$\(|`|>|<|\bsudo\b|\bsu\b)/;

/** Things that cannot be undone, and are therefore never automatic. */
const IRREVERSIBLE = [
  /\brm\s+(-[a-z]*[rf]|--recursive|--force)/i,
  /\brmdir\b/i,
  /\bmkfs\b/i,
  /\bdd\s+.*\bof=/i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /\bsudo\b|\bdoas\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+checkout\s+--\s/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/i,
  /\|\s*(sh|bash|zsh|python|node)\b/i,
  /\bchmod\s+(-[a-z]+\s+)?[0-7]*7[0-7]{2}\b/i,
  /\bkillall\b|\bpkill\b/i,
  /:\(\)\s*\{/, // fork bomb, and anything else that opens with a function trap
];

/** Split a command line into the pieces that will each run as a command. */
function segments(command: string): string[] {
  return command
    .split(/(?:\|\||&&|;|\||\n)+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function words(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

/** Is every part of this command line something that only reads? */
export function isReadOnlyCommand(command: string): boolean {
  if (!command.trim()) return false;
  // Discards come out first, so the check that follows is about redirection
  // that could actually land bytes somewhere.
  const bare = command.replace(HARMLESS_REDIRECT, " ");
  // Substitution, redirection to a path, and privilege escalation are never
  // read-only, and are not worth parsing further.
  if (OPAQUE.test(bare)) return false;

  return segments(bare).every((seg) => {
    const [cmd, ...rest] = words(seg);
    if (!cmd) return false;
    // A leading VAR=value assignment hides the real command behind it.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) return false;
    if (READ_ONLY[cmd]) return true;
    if (cmd === "git") return Boolean(rest[0] && GIT_READ_ONLY[rest[0]]);
    if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn" || cmd === "npx") {
      return Boolean(rest[0] && PKG_SCRIPTS[rest[0]]);
    }
    if (cmd === "curl" || cmd === "wget") {
      return !rest.some((w) => NET_WRITE_FLAGS.includes(w) || /^--(data|output|form)/.test(w));
    }
    return false;
  });
}

/** Would this command do something no later step could undo? */
export function isIrreversible(command: string): boolean {
  return IRREVERSIBLE.some((re) => re.test(command));
}

/** Is `p` inside `cwd` — the project molt was pointed at? */
export function insideProject(cwd: string, p: unknown): boolean {
  const raw = typeof p === "string" ? p : "";
  if (!raw) return false;
  const target = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  return target === resolve(cwd) || target.startsWith(resolve(cwd) + "/");
}

/**
 * Tools that cannot change anything, whatever their arguments say.
 *
 * This is the argument for having them at all. `ls` through bash is a string
 * the classifier has to reason about; `list_dir` is a tool that has no code
 * path to a write. The safety comes from the shape of the tool rather than
 * from a regex over a command line, which is a better kind of safety — there
 * is nothing to outsmart.
 */
const READING_TOOLS = new Set(["read_file", "list_dir", "grep"]);

/** Tools that write, and are gated exactly like write_file. */
const WRITING_TOOLS = new Set(["write_file", "edit_file"]);

export type Decision = {
  /** True when a human has to answer before this runs. */
  ask: boolean;
  /** Why it is being asked, in the user's terms. Present only when asking. */
  why?: string;
};

/**
 * Decide whether a tool call needs a person.
 *
 * The shape of the answer matters as much as the answer: when molt does ask,
 * it can say which rule sent it back, so raising the level is an informed
 * choice rather than a way to make a dialog go away.
 */
export function gate(
  level: Autonomy,
  call: { name: string; args: Record<string, unknown>; cwd: string },
): Decision {
  const { name, args, cwd } = call;
  const command = typeof args.command === "string" ? args.command : "";
  const path = args.path;

  // Leaving the project is a prompt at every level. molt was pointed at one
  // directory, and "outside it" is the one boundary no autonomy setting is
  // allowed to imply. A path argument is only checked when there is one:
  // list_dir and grep default to the project root.
  const pathed = READING_TOOLS.has(name) || WRITING_TOOLS.has(name);
  const needsPath = name === "read_file" || WRITING_TOOLS.has(name);
  const hasPath = typeof path === "string" && path !== "";
  if (pathed && (hasPath || needsPath) && !insideProject(cwd, path)) {
    return { ask: true, why: `${String(path)} is outside this project` };
  }

  // A tool with no write in it needs no permission at any level.
  if (READING_TOOLS.has(name)) return { ask: false };

  if (level === "high") {
    if (name === "bash" && isIrreversible(command)) {
      return { ask: true, why: "this cannot be undone" };
    }
    return { ask: false };
  }

  if (level === "medium") {
    if (WRITING_TOOLS.has(name)) return { ask: false };
    if (name === "bash") {
      if (isIrreversible(command)) return { ask: true, why: "this cannot be undone" };
      if (isReadOnlyCommand(command)) return { ask: false };
      return { ask: true, why: "this command does more than read" };
    }
    // An unrecognised tool is not covered by a level that predates it.
    return { ask: true, why: `${name} is not covered at medium autonomy` };
  }

  return { ask: true, why: "low autonomy asks before every command and write" };
}
