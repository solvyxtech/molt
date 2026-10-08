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
import { tmpdir } from "node:os";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Autonomy = "low" | "medium" | "high";

export const AUTONOMY_LEVELS: readonly Autonomy[] = ["low", "medium", "high"];

export const DEFAULT_AUTONOMY: Autonomy = "low";

/** One line each, for the status line and `/autonomy`. */
export const AUTONOMY_SUMMARY: Record<Autonomy, string> = {
  low: "asks before every command and every write",
  medium: "runs searches, read-only commands, and writes inside the project",
  high: "runs everything except a named list of destructive commands",
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

/**
 * Subcommands of `git` that only report. Anything else asks.
 *
 * `stash`, `config`, and `tag` were on this list and should never have been:
 * bare `git stash` moves the working tree, `git config` writes a file, and
 * `git tag` creates a ref. All three ran unattended at medium. Found by a
 * model reading this file and saying so — which is the review this list wants,
 * since every entry is a promise that a word cannot write.
 */
const GIT_READ_ONLY: Record<string, true> = {
  status: true, log: true, diff: true, show: true,
  "ls-files": true, "rev-parse": true, blame: true, describe: true,
  shortlog: true, "cat-file": true, "show-ref": true, "symbolic-ref": true,
};

/**
 * `git branch` and `git remote` read with no arguments, or with flags that
 * only list — and write the moment either is given a name. `branch` and
 * `remote` used to sit in `GIT_READ_ONLY` unconditionally, which is the same
 * bug `stash`/`config`/`tag` were caught for: `git branch feature` creates a
 * ref, `git branch -d old` deletes one, and `git remote add origin url`
 * rewrites `.git/config` — all of it ran unattended at medium. Checked apart
 * from the map above because the verb alone does not decide it here; the
 * argument after it does.
 */
function gitBranchOrRemoteIsRead(sub: string, rest: string[]): boolean {
  if (sub === "branch") {
    const WRITE_FLAGS = new Set(["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy"]);
    if (rest.some((w) => WRITE_FLAGS.has(w))) return false;
    // Any bare word is a branch (and optionally a start-point) to create or
    // target — `git branch` with zero positional args is the only case that
    // just lists.
    return !rest.some((w) => !w.startsWith("-"));
  }
  if (sub === "remote") {
    const WRITE_SUBS = new Set([
      "add", "remove", "rm", "rename", "set-url", "set-branches", "set-head", "prune", "update",
    ]);
    const first = rest[0];
    return !(first && WRITE_SUBS.has(first));
  }
  return false;
}

/** Package-manager subcommands that run project scripts rather than mutate deps. */
const PKG_SCRIPTS: Record<string, true> = { test: true, run: true, ls: true, why: true, outdated: true, view: true };

/**
 * curl and wget flags that stop them being a read.
 *
 * A GET is a lookup — the weather, a doc page, an API status. A POST, an
 * upload, or an `-o` that lands a file on disk is not, so any of these send
 * the call back to a prompt.
 */
/**
 * Listed commands that read by default and write when given `-o`.
 *
 * Kept as an explicit set rather than checking `-o` everywhere, because `-o`
 * means something harmless on plenty of others — `find -o` is a boolean OR,
 * `du -o` is a mount-point filter — and refusing those would push exploration
 * back to guesswork, which is how this list earned its members in the first
 * place.
 */
const OUTPUT_FLAG_WRITERS: Record<string, true> = { sort: true, uniq: true, tee: true };

/** `-o file`, `--output file`, `--output=file`, and the clustered `-uo file`. */
function isOutputFlag(w: string): boolean {
  if (w === "-o" || w === "--output") return true;
  if (w.startsWith("--output=")) return true;
  // Clustered short flags: `sort -uo out.txt` writes just as surely.
  return /^-[A-Za-z]*o$/.test(w);
}

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
 * `ls -la .maat 2>/dev/null` is how everybody writes an exploratory command,
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

/**
 * Operations that destroy something no later step can restore.
 *
 * This list is the whole content of the promise `high` makes, so it is worth
 * being exact about what that promise is: molt asks about every construction
 * NAMED HERE. It is not a claim to have enumerated every way a shell can lose
 * data, and it is not a sandbox — see the note at the top of this file.
 *
 * The first version of this list required a flag on `rm`, which meant plain
 * `rm secrets.env` ran unattended at high. Deleting one file by name is no
 * more reversible than deleting a tree, and the documentation said "except
 * what cannot be undone" — an overclaim in the one file where an overclaim
 * matters most. Every entry below exists because probing found it missing.
 */
/** Kept by identity so high autonomy can leave exactly this rule out. */
const INLINE_PROGRAM_RULE = /\b(python[\d.]*|node|ruby|perl|php|deno|bun|osascript)\b[^|;&]*\s-(c|e|eval)\b/i;

const IRREVERSIBLE = [
  // Deletion, in any form. No flag required: one named file is enough.
  /\brm\b/i,
  /\brmdir\b/i,
  /\bunlink\b/i,
  /\bshred\b/i,
  /-delete\b/i,
  /-exec\b/i, // find -exec runs an arbitrary command over many files
  // Emptying a file in place.
  /\btruncate\b/i,
  /\btee\b(?!\s+-a\b)/i,
  /\bmkfs\b/i,
  /\bdd\s+.*\bof=/i,
  // Redirection that replaces a file's contents. Appending is fine, and a
  // discard was already stripped before this list is consulted.
  /(?<!>)>(?!>)/,
  // Machine state.
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /\bsudo\b|\bdoas\b/i,
  /\bkillall\b|\bpkill\b/i,
  /\bchmod\s+(-[a-z]+\s+)?[0-7]*7[0-7]{2}\b/i,
  // History and published state.
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+checkout\b.*\s--(\s|$)/i,
  /\bgit\s+restore\b/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bgit\s+rebase\b|\bgit\s+filter-branch\b/i,
  /\bgit\s+stash\s+(drop|clear)\b/i,
  /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/i,
  // A download piped into an interpreter is an unread program.
  /\|\s*(sh|bash|zsh|python|node)\b/i,
  // And so is an interpreter handed a program on the command line. `python -c
  // "os.remove(x)"` deletes a file without the word `rm` appearing anywhere,
  // which is not a gap in the list below — it is the reason a list cannot be
  // the whole answer. The effect of an -e/-c program is not readable from the
  // text, which is the same rule that already sends `$(...)` to a prompt.
  INLINE_PROGRAM_RULE,
  /\b(sh|bash|zsh|fish)\b[^|;&]*\s-c\b/i,
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
    if (READ_ONLY[cmd]) {
      // Read-only in the common case, writing in the flag — the same reason
      // `sed` and `awk` were kept off the table entirely. `sort -o out.txt` and
      // `uniq -o out.txt` overwrite a named file, and being on this list meant
      // medium ran them unattended.
      if (OUTPUT_FLAG_WRITERS[cmd] && rest.some(isOutputFlag)) return false;
      return true;
    }
    if (cmd === "git") {
      const sub = rest[0];
      if (!sub) return false;
      if (GIT_READ_ONLY[sub]) return true;
      if (sub === "branch" || sub === "remote") return gitBranchOrRemoteIsRead(sub, rest.slice(1));
      return false;
    }
    if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn" || cmd === "npx") {
      return Boolean(rest[0] && PKG_SCRIPTS[rest[0]]);
    }
    if (cmd === "curl" || cmd === "wget") {
      return !rest.some((w) => NET_WRITE_FLAGS.includes(w) || /^--(data|output|form)/.test(w));
    }
    return false;
  });
}

/**
 * Does this command do nothing except delete paths molt created this session?
 *
 * The narrow exception to "a delete always asks". A file that did not exist
 * when the turn started cannot be someone's work, and removing it destroys
 * nothing that was not molt's own doing — so at high autonomy, tidying up
 * after itself is not a decision a person needs to be woken for. A local 30B
 * hit the other side of this rule: it wrote a scratch script, tried to remove
 * it, was refused, and told its own receipt "I don't have permission to remove
 * it". A gate that blocks the remedy for its own complaint is a trap.
 *
 * Deliberately literal-minded. Any shell metacharacter, any glob, any second
 * command, any path molt did not create, anything that is not `rm` — and the
 * exception does not apply and the prompt happens as before. A carve-out in a
 * safety gate has to be one that can be read at a glance and be obviously
 * true, not one that is clever.
 */
export function deletesOnlyCreated(
  command: string,
  created: ReadonlySet<string>,
  cwd: string,
): boolean {
  const trimmed = command.trim();
  // Chaining, substitution, redirection, globbing: not worth reasoning about
  // at a gate whose job is to decide whether a delete is safe.
  if (/[;&|`$><*?()\[\]{}]/.test(trimmed) || /\bcd\b/.test(trimmed)) return false;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts[0] !== "rm") return false;
  const paths = parts.slice(1).filter((p) => p !== "--" && !p.startsWith("-"));
  if (!paths.length) return false;
  for (const p of paths) {
    if (!insideProject(cwd, p)) return false;
    if (!created.has(relative(cwd, resolve(cwd, p)))) return false;
  }
  return true;
}

/** `tee [-flags] file...` with plain-word targets; the rest of the line is not matched. */
const TEE_TARGETS =
  /\btee((?:[ \t]+-[a-zA-Z]+)*)((?:[ \t]+(?:"[^"$`\\\s]+"|'[^'\s]+'|[^\s;&|<>$`*?{}()'"\\-][^\s;&|<>$`*?{}()'"\\]*))+)/g;

/**
 * The command with the body of every `cat`/`tee` heredoc taken out.
 *
 * `cat << 'EOF' > report.csv … EOF` is a file being written from text, and the
 * text is not run. But the same body fed to `bash` or `python` is a program,
 * so only a heredoc line that starts with cat or tee, has no second command
 * on it, and (when its delimiter is unquoted, so the shell expands it) holds
 * no `$(` or backtick is stripped. Anything else — an unterminated body, a
 * different consumer — is returned untouched, and the ordinary rules ask.
 */
function withoutHeredocData(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if ((m[1] ? lines[j]!.trim() : lines[j]) === m[3]) {
        end = j;
        break;
      }
    }
    const body = end < 0 ? [] : lines.slice(i + 1, end);
    const readable =
      end >= 0 &&
      /^\s*(cat|tee)\b/.test(line) &&
      !/;|&&|\|\|/.test(line) &&
      (m[2] !== "" || !body.some((b) => /\$\(|`/.test(b)));
    if (!readable) return command;
    out.push(line.replace(m[0], " "));
    i = end;
  }
  return out.join("\n");
}

const ECHO_ARG = `(?:'[^']*'|"(?:[^"$\`\\\\]|\\\\[nt\\\\"])*"|[^\\s;&|<>'"\`$()\\\\])+`;
const ECHO_DATA = new RegExp(`(^|[;&|\\n]\\s*)(?:echo|printf)(?:[ \\t]+${ECHO_ARG})*`, "g");

/** `echo`/`printf` and their literal arguments reduced to `echo`: text is not a command. */
function withoutEchoData(command: string): string {
  return command.replace(ECHO_DATA, (_m, lead: string) => `${lead}echo`);
}

/** Would this command do something no later step could undo? */
/**
 * Does this command's only irreversible act write files that did not exist?
 *
 * `echo x > out.txt` is on the irreversible list because `>` replaces a
 * file's contents, and a replaced file is gone. But a file that does not
 * exist yet has no contents to lose — and "save the result to result.txt" is
 * how a great deal of real work is phrased. A mission worker at high
 * autonomy was refused `python3 cli.py > /tmp/out` twice and had to find
 * another spelling; on a benchmark clock that is the task lost.
 *
 * So at high autonomy a redirect is allowed when every target is a path
 * inside the project (or under the OS temp directory) that either does not
 * exist or was created by this session, and nothing else in the command is
 * irreversible. `write_file` already overwrites project files at high
 * without asking, with the old contents in the ledger; this is narrower
 * than that, because a shell write leaves no ledger entry — the bar's
 * `tree-accounted` is what catches it, and only when a bar is present.
 */
export function overwritesOnlyNew(
  command: string,
  created: ReadonlySet<string>,
  cwd: string,
  tmp: string = tmpdir(),
): boolean {
  // Heredoc bodies and echo/printf arguments are text being written, not
  // commands: a script whose body mentions `rm` is not an rm. Both strips
  // are all-or-nothing and leave anything they cannot read exactly as it was.
  const prepared = withoutEchoData(withoutHeredocData(command));
  // A heredoc that was not stripped is one whose body could not be read.
  if (/<</.test(prepared)) return false;
  const teed: string[] = [];
  const text = prepared.replace(TEE_TARGETS, (_m, _flags: string, list: string) => {
    for (const w of list.trim().split(/[ \t]+/)) teed.push(w);
    return " ";
  });
  const bare = text.replace(HARMLESS_REDIRECT, " ");
  // Every `> target` and `N> target`.  `>>` never reached the list, and `>&2`
  // style duplications are not files.
  const re = /(?<![>&])\d?>(?![>&])\s*(\S+)/g;
  const targets: string[] = [];
  // Quotes off, and the shell punctuation a target can run into (`> out;`).
  for (const m of bare.matchAll(re)) targets.push(m[1].replace(/[;&|)]+$/, "").replace(/^['"]|['"]$/g, ""));
  for (const w of teed) targets.push(w.replace(/^['"]|['"]$/g, ""));
  // `>> file` loses nothing, but it is what `echo 'rm -- "$f"' >> rotate.sh`
  // is written with, so the stripped text above has to be allowed to stand on
  // its own. Only a plain path inside the project counts.
  const appended = [...bare.matchAll(/>>\s*(\S+)/g)].map((m) => m[1].replace(/[;&|)]+$/, "").replace(/^['"]|['"]$/g, ""));
  if (!targets.length && !appended.length) return false;
  for (const t of appended) {
    if (/[*?$`{}]/.test(t) || !insideProject(cwd, t)) return false;
    const abs = resolve(cwd, t);
    if (existsSync(abs) && statSync(abs).isDirectory()) return false;
  }
  // What is left must be reversible on its own: `rm a > log` is still an rm.
  if (isIrreversible(bare.replace(re, " "))) return false;
  for (const t of targets) {
    if (/[*?$`{}]/.test(t)) return false; // a target that is not a path
    const abs = resolve(cwd, t);
    if (!insideProject(cwd, t)) {
      // Scratch in the temp directory: fine while it is new. Checked second,
      // because a project can itself live under the temp directory — every
      // test workspace does — and a project file is judged as a project file.
      if (realLocation(abs).startsWith(realLocation(tmp) + sep) && !existsSync(abs)) continue;
      return false;
    }
    const rel = relative(cwd, abs);
    // The project root itself, or any directory, is not a file waiting to be
    // written; a directory cannot be new and the root is never a target.
    if (rel === "") return false;
    if (existsSync(abs) && (!created.has(rel) || statSync(abs).isDirectory())) return false;
  }
  return true;
}

/**
 * The command with everything that only touches a folder it made itself
 * with `mktemp` taken out.
 *
 * `d=$(mktemp -d); cat > $d/check.py <<EOF … EOF; python3 $d/check.py; rm -rf $d`
 * is how a careful agent tests its work without leaving anything in the
 * project, and it was refused at high autonomy for the `>` and the `rm`. A
 * folder the same command just created holds nothing anyone else owns.
 */
export function withoutOwnTempWork(command: string): string {
  const vars = [...command.matchAll(/\b([A-Za-z_]\w*)=["']?\$\(\s*mktemp\b[^)]*\)["']?/g)].map((m) => m[1]!);
  if (!vars.length) return command;
  // `$d/../..` climbs out of the folder: no exemption for this command at all.
  if (new RegExp(`\\$\\{?(?:${vars.join("|")})\\}?/[^\\s;&|]*\\.\\.`).test(command)) return command;
  const ref = `"?\\$\\{?(?:${vars.join("|")})\\}?(?:/[^\\s"';&|]*)?"?`;
  return command
    // Only an rm whose every operand is one of these folders: `rm -rf $d ~/x` stays.
    .replace(new RegExp(`\\brm(\\s+-[a-zA-Z]+)*(\\s+${ref})+(?=[ \\t]*(;|&|\\||\\n|$))`, "g"), " ")
    .replace(new RegExp(`(?<!>)>(?!>)\\s*${ref}`, "g"), " ");
}

/**
 * Irreversible at high autonomy. The same list, with two differences that
 * make high mean what it says.
 *
 * An inline program (`python3 -c`, `node -e`) runs here exactly as the same
 * program in a file does — and a file program already ran at high, so asking
 * about the inline one protected nothing; it only stopped the model checking
 * its own work. Headless with --yes, every such check was refused, and the
 * model claimed done without having tested anything. And work confined to a
 * folder the command made with `mktemp` is not a loss (see above).
 */
export function isIrreversibleAtHigh(command: string): boolean {
  const bare = withoutOwnTempWork(command).replace(HARMLESS_REDIRECT, " ");
  const inlineOk = !MUTATING_API.test(command);
  return IRREVERSIBLE.some((re) => !(re === INLINE_PROGRAM_RULE && inlineOk) && re.test(bare));
}

/**
 * What an inline program must not contain to run at high autonomy: any call
 * that deletes, moves, writes, spawns or reaches the network. A verification
 * one-liner — import, compute, print, assert — has none of these, and those
 * are the ones a careful model writes to test its work. The rule that sends
 * `python -c "os.remove(x)"` to a person stands for everything else, and
 * `sh -c` / `bash -c` always ask.
 */
const MUTATING_API = new RegExp(
  [
    "\\b(remove|unlink|rmdir|rmtree|removedirs|rename|replace|truncate|chmod|chown|symlink|link|makedirs|mkdir)\\s*\\(",
    "\\b(shutil|subprocess|system|popen|spawn|exec|execSync|execFile|fork|kill)\\b",
    "\\b(unlinkSync|rmSync|rmdirSync|writeFileSync|appendFileSync|renameSync|copyFileSync|writeFile|appendFile|createWriteStream|mkdirSync)\\b",
    "\\b(write_text|write_bytes|touch)\\s*\\(",
    // open() with a writing MODE — the mode argument, not any letter in the
    // path: open('data/orders.csv') is a read, open('a.txt', 'w') a write.
    "\\bopen\\s*\\([^)]*,\\s*(mode\\s*=\\s*)?['\"][rbt]*[wax+][rbtwax+]*['\"]",
    "\\.open\\s*\\(\\s*(mode\\s*=\\s*)?['\"][rbt]*[wax+][rbtwax+]*['\"]",
    "\\b(File|Dir|FileUtils)\\.(delete|unlink|rm|write|rename|mv)",
    "\\bunlink\\b",
    "\\b(urlopen|requests|fetch|http|socket)\\b",
    "\\b(eval|exec)\\s*\\(",
    "`",
  ].join("|"),
  "i",
);

export function isIrreversible(command: string): boolean {
  // A discard is not a write, so it must not read as one here either.
  const bare = command.replace(HARMLESS_REDIRECT, " ");
  return IRREVERSIBLE.some((re) => re.test(bare));
}

/**
 * The real location of a path, following symlinks, even if it does not exist
 * yet.
 *
 * A path that does not exist cannot be resolved, so this walks up to the
 * deepest ancestor that does, resolves that, and re-attaches the rest — which
 * is what makes a *new* file inside a symlinked directory resolve correctly.
 */
function realLocation(p: string): string {
  const tail: string[] = [];
  let cur = p;
  while (!existsSync(cur) && dirname(cur) !== cur) {
    tail.unshift(basename(cur));
    cur = dirname(cur);
  }
  try {
    return join(realpathSync(cur), ...tail);
  } catch {
    return p;
  }
}

/**
 * Is `p` inside `cwd` — the project molt was pointed at?
 *
 * Resolved through symlinks, not just lexically. `resolve()` alone reports
 * that `escape/secret.txt` is inside the project when `escape` is a link
 * pointing anywhere at all — so the one boundary no autonomy level is allowed
 * to imply could be crossed by a link the model itself created with `ln -s`.
 * Found by probing, like every other hole in this file.
 */
export function insideProject(cwd: string, p: unknown): boolean {
  const raw = typeof p === "string" ? p : "";
  if (!raw) return false;
  const target = realLocation(isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw));
  const root = realLocation(resolve(cwd));
  return target === root || target.startsWith(root + sep);
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
const READING_TOOLS = new Set(["read_file", "list_dir", "grep", "inspect"]);

/**
 * Tools that touch nothing at all. `act` is here for the case where it reaches
 * the gate as itself: a readable batch is expanded into its inner actions
 * (each gated on its own) before it gets here, so the one that arrives whole
 * is the one whose action list could not be parsed, and the dispatcher only
 * answers it with the shape error. Refusing it instead told the model "User
 * denied this action" (39/72/31 times per bench arm) for a call that ran
 * nothing, and it never learned the real problem. `plan` writes a note into the model's own
 * conversation and nowhere else; there is no disk, no process and no network
 * on its code path, so no autonomy level has anything to say about it.
 */
const INERT_TOOLS = new Set(["plan", "act"]);

/** Tools that write, and are gated exactly like write_file. */
const WRITING_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * Every tool this classifier has an opinion about.
 *
 * A level written today cannot have consented to a tool added tomorrow, and
 * "high" is a statement about the shell, not a blank endorsement of whatever
 * molt grows next. An unrecognised tool asks at every level — which is the
 * deny-by-default rule at the top of this file, applied to itself. Found
 * missing by the probe suite, at high, where it mattered most.
 */
const KNOWN_TOOLS = new Set([...READING_TOOLS, ...WRITING_TOOLS, ...INERT_TOOLS, "bash"]);

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
  call: {
    name: string;
    args: Record<string, unknown>;
    cwd: string;
    /** Project-relative paths this session created, for the delete exception. */
    created?: ReadonlySet<string>;
    /**
     * Where the boundary is. `project` (the default) asks about any path
     * outside the working directory at every level. `machine` is a sandbox
     * the person has declared disposable — a benchmark container, a throwaway
     * VM — and the boundary is the machine. It never lowers what asks for any
     * other reason.
     */
    boundary?: "project" | "machine";
  },
): Decision {
  const { name, args, cwd } = call;
  const bounded = call.boundary !== "machine";
  const command = typeof args.command === "string" ? args.command : "";
  const path = args.path;

  // Leaving the project is a prompt at every level. molt was pointed at one
  // directory, and "outside it" is the one boundary no autonomy setting is
  // allowed to imply. A path argument is only checked when there is one:
  // list_dir and grep default to the project root.
  const pathed = READING_TOOLS.has(name) || WRITING_TOOLS.has(name);
  const needsPath = name === "read_file" || WRITING_TOOLS.has(name);
  const hasPath = typeof path === "string" && path !== "";
  if (pathed && (hasPath || needsPath)) {
    // A missing path is not "outside the project", it is malformed — and a
    // model reading "undefined is outside this project" learns nothing about
    // what it did wrong. Malformed is malformed whatever the boundary.
    if (!hasPath) return { ask: true, why: `${name} was called with no path` };
    if (bounded && !insideProject(cwd, path)) {
      return { ask: true, why: `${String(path)} is outside this project` };
    }
  }

  if (!KNOWN_TOOLS.has(name)) {
    return { ask: true, why: `${name} is not a tool any autonomy level has agreed to` };
  }

  // A tool with no write in it needs no permission at any level.
  if (READING_TOOLS.has(name) || INERT_TOOLS.has(name)) return { ask: false };

  if (level === "high") {
    if (name === "bash" && isIrreversibleAtHigh(command)) {
      // Removing only what this session created undoes molt's own work and
      // nobody else's, so at this level it does not need a person.
      if (call.created?.size && deletesOnlyCreated(command, call.created, cwd)) {
        return { ask: false };
      }
      // Writing a file that did not exist loses nothing.
      if (overwritesOnlyNew(command, call.created ?? new Set(), cwd)) {
        return { ask: false };
      }
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
    return { ask: true, why: `${name} is not covered at medium autonomy` };
  }

  return { ask: true, why: "low autonomy asks before every command and write" };
}
