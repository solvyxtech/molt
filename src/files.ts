/**
 * Listing, searching, and editing — as tools rather than as shell strings.
 *
 * molt's design rule was three tools, everything else bash. It held until a
 * real session showed what it costs. Exploring a repo through `bash` means
 * every `ls` and every `grep` is a shell string, and a shell string has to be
 * *guessed about*: the autonomy classifier parses it, an unfamiliar
 * construction sends it to a prompt, and a model that cannot list a directory
 * starts guessing filenames. Meanwhile the only way to change one line of a
 * file was to resend the whole file.
 *
 * A tool whose shape is read-only needs no guessing. `list_dir` cannot write,
 * whatever its arguments say, so it can run at any autonomy level without a
 * classifier having an opinion — the safety comes from the tool's type, not
 * from a regex over a command line. Same for `grep`. And an edit expressed as
 * "replace exactly this text with exactly that" is both cheaper to send and
 * possible to *verify*: molt can refuse an edit that does not match, instead
 * of writing a file the model reconstructed from memory.
 *
 * Everything here is bounded and mechanical. No model summarizes anything, no
 * result is unlimited, and every truncation says what it left out.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * How long a search may run, and how much of a line it may examine.
 *
 * `bash` has a timeout. Bar checks have a timeout. `grep` had neither, and a
 * pattern the model wrote — `(a+)+$` against a long line — hung molt with no
 * ceiling at all: no output, no error, no way back except killing it. Anything
 * that runs input molt did not write needs a bound.
 */
export const SEARCH_DEADLINE_MS = 5_000;
export const MAX_LINE_CHARS = 2_000;

/**
 * Directories that are never worth walking into.
 *
 * A build output or a dependency tree is not the project; searching them
 * buries the answer and spends the budget. Skipped by name at any depth, and
 * the caller is told when a skip happened so nothing is silently invisible.
 */
export const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", "target", "vendor",
  ".next", ".nuxt", ".svelte-kit", ".venv", "venv", "__pycache__", ".mypy_cache",
  ".pytest_cache", ".gradle", ".idea", ".cache", ".turbo",
]);

/**
 * molt's own artifacts: listed, but not searched.
 *
 * `.molt/done.yml` is the most relevant file in the project — hiding it from a
 * listing means the agent cannot discover the bar it is being judged against.
 * But `.molt/log/` holds session logs full of prose, and a content search that
 * walks them buries the answer in molt's own record of looking for it.
 */
export const SEARCH_SKIP_DIRS = new Set([...SKIP_DIRS, ".molt"]);

/** How many entries or matches a single result may carry. */
export const MAX_ENTRIES = 400;
/**
 * How many directory entries a single walk may look at.
 *
 * The bound that was missing. `limit` caps what a walk *keeps*, which bounds
 * nothing when a glob keeps almost nothing — a `grep` for `*.{ts,tsx}` under a
 * home directory collected no entries at all and walked for eight minutes.
 * This counts the syscalls instead, which is the thing that actually costs.
 */
export const MAX_EXAMINED = 50_000;
/** How long a directory walk may run before it reports what it has. */
export const WALK_DEADLINE_MS = 3_000;
export const MAX_MATCHES = 200;
/** Files bigger than this are not searched — they are data, not source. */
export const MAX_SEARCH_BYTES = 2_000_000;

/**
 * A glob, as a regular expression.
 *
 * Supports `*` (anything but a separator), `**` (anything, separators
 * included), `?` (one character), and a leading `**\/` that also matches the
 * top level, so `**\/*.ts` finds `a.ts` as well as `src/a.ts`. Everything else
 * is literal — a pattern language with corners nobody can predict is worse
 * than a small one everybody can.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        // `**/` may match nothing at all, so `**/*.ts` matches a top-level file.
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      continue;
    }
    // `{ts,tsx}` — an alternation, which is what everyone writing a glob means
    // by it. These used to be escaped into literal braces, so the very common
    // `*.{ts,tsx}` matched a file actually named that and nothing else: no
    // error, no matches, and a full-tree walk to discover it.
    if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close !== -1) {
        const alts = pattern.slice(i + 1, close).split(",");
        out += `(?:${alts.map((a) => a.replace(/[.+^${}()|[\]\\*?]/g, "\\$&")).join("|")})`;
        i = close;
        continue;
      }
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function matchesGlob(path: string, pattern?: string): boolean {
  if (!pattern) return true;
  const p = path.split(sep).join("/");
  const re = globToRegExp(pattern);
  // A bare pattern with no separator is a name filter: `*.ts` should find
  // `src/a.ts`, because that is what everyone means by it.
  return re.test(p) || (!pattern.includes("/") && re.test(p.split("/").pop()!));
}

export type Entry = { path: string; kind: "file" | "dir"; bytes?: number };

/**
 * Walk a directory, breadth-first, skipping the noise and stopping at a
 * bound. Returns entries relative to `root`.
 */
export type WalkOptions = {
  depth?: number;
  glob?: string;
  limit?: number;
  dirsOnly?: boolean;
  skip?: ReadonlySet<string>;
  /** Absolute ms timestamp to stop at. Bounds the walk itself, not its output. */
  deadline?: number;
  /**
   * How many directory entries may be *looked at*, as opposed to kept.
   *
   * `limit` counts entries collected, which is not a bound on the work: with a
   * glob, directories and non-matching files are never collected, so a
   * selective pattern makes `limit` unreachable while the walk grinds through
   * the whole tree. That is exactly how one `grep` with `*.{ts,tsx}` over a
   * home directory ran for eight minutes and returned nothing.
   */
  examine?: number;
};

export type WalkResult = {
  entries: Entry[];
  /** True when the walk stopped early — by entry limit, examine cap, or time. */
  truncated: boolean;
  skipped: string[];
  /** True when it was the clock that stopped it. */
  timedOut: boolean;
  /** How many directory entries were looked at. */
  examined: number;
};

/**
 * The real path of `abs` if it resolves inside `rootReal`, otherwise
 * undefined. Dangling links fail `realpath` and are refused — `insideProject`
 * cannot be reused here, because it reconstructs a missing link as a new
 * path under cwd.
 *
 * Compared with `relative(root, target).startsWith("..")`, a prefix on the
 * real path keeps an in-workspace file named `..foo` inside.
 */
function realPathInside(rootReal: string, abs: string): string | undefined {
  let target: string;
  try {
    target = realpathSync(abs);
  } catch {
    return undefined;
  }
  if (target === rootReal || target.startsWith(rootReal + sep)) return target;
  return undefined;
}

/**
 * The traversal itself, as a generator so it can be drained two ways.
 *
 * Yields between directories. A synchronous caller drains it in one go; a
 * caller that must not block the terminal awaits between pulls. Sharing the
 * body means the bounds cannot drift apart between the two.
 */
function* walkSteps(root: string, opts: WalkOptions, out: WalkResult): Generator<void> {
  const skip = opts.skip ?? SKIP_DIRS;
  const depth = opts.depth ?? 1;
  const limit = opts.limit ?? MAX_ENTRIES;
  const examine = opts.examine ?? MAX_EXAMINED;

  // Bound every followed path against the real workspace, not the lexical
  // one. `statSync` resolves links, so a symlink to /etc or to
  // ~/.config/molt/auth.json would otherwise be listed and grepped as if it
  // lived in the project. A root that cannot be resolved is not a tree we
  // can police, so the walk is empty rather than unbounded.
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return;
  }

  const queue: { dir: string; level: number }[] = [{ dir: root, level: 0 }];
  while (queue.length > 0) {
    const { dir, level } = queue.shift()!;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue; // unreadable directory: reported by its absence, never fatal
    }
    for (const name of names) {
      // Checked here, where the cost is: one `lstatSync` per entry is cheap
      // and a million of them is not.
      out.examined += 1;
      if (out.examined > examine) {
        out.truncated = true;
        return;
      }
      if (opts.deadline !== undefined && (out.examined & 0xff) === 0 && Date.now() > opts.deadline) {
        out.truncated = true;
        out.timedOut = true;
        return;
      }
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      let isDir = false;
      let bytes: number | undefined;
      try {
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) {
          // Dangling, or a target outside rootReal: refuse. `insideProject`
          // cannot be reused here — it reconstructs a missing link as a new
          // path under cwd, which would let a broken outbound link through.
          const target = realPathInside(rootReal, abs);
          if (target === undefined) continue;
          const followed = statSync(target);
          isDir = followed.isDirectory();
          bytes = isDir ? undefined : followed.size;
        } else {
          isDir = st.isDirectory();
          bytes = isDir ? undefined : st.size;
        }
      } catch {
        continue;
      }

      if (isDir && skip.has(name)) {
        out.skipped.push(rel);
        continue;
      }
      if (out.entries.length >= limit) {
        out.truncated = true;
        return;
      }
      if (isDir) {
        if (!opts.glob) out.entries.push({ path: rel + "/", kind: "dir" });
        if (level + 1 < depth) queue.push({ dir: abs, level: level + 1 });
      } else if (!opts.dirsOnly && matchesGlob(rel, opts.glob)) {
        out.entries.push({ path: rel, kind: "file", bytes });
      }
    }
    yield;
  }
}

function emptyWalk(): WalkResult {
  return { entries: [], truncated: false, skipped: [], timedOut: false, examined: 0 };
}

export function walk(root: string, opts: WalkOptions = {}): WalkResult {
  const out = emptyWalk();
  for (const _ of walkSteps(root, opts, out)) {
    // drained whole: callers of the sync form are bounded by `deadline`
  }
  return out;
}

/**
 * The same walk, without holding the terminal.
 *
 * Used by everything the model can trigger. A walk is thousands of blocking
 * syscalls, and doing them all in one turn of the event loop is what makes a
 * search look like a hang.
 */
export async function walkAsync(root: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const out = emptyWalk();
  // Every directory, not every sixteenth. A `readdirSync` on a contended disk
  // can take a long time on its own, and batching the yields stacks however
  // many of those land in one batch into a single stall. A `setImmediate` costs
  // microseconds; the walk is dominated by the syscalls either way.
  for (const _ of walkSteps(root, opts, out)) {
    await new Promise((r) => setImmediate(r));
  }
  return out;
}

/** Render a listing for the model: one entry per line, sizes where they help. */
export function formatListing(
  shown: string,
  result: { entries: Entry[]; truncated: boolean; skipped: string[] },
): string {
  const lines = result.entries.map((e) =>
    e.kind === "dir" ? e.path : `${e.path}${e.bytes === undefined ? "" : `  ${e.bytes}B`}`,
  );
  const head = `[molt: ${shown || "."} · ${result.entries.length} entr${result.entries.length === 1 ? "y" : "ies"}]`;
  const notes: string[] = [];
  if (result.truncated) notes.push(`[molt: stopped at ${MAX_ENTRIES} entries — narrow with glob or depth]`);
  if (result.skipped.length > 0) {
    notes.push(`[molt: skipped ${result.skipped.length} build/dependency director${result.skipped.length === 1 ? "y" : "ies"}: ${result.skipped.slice(0, 6).join(", ")}]`);
  }
  return [head, ...lines, ...notes].join("\n");
}

/**
 * A cheap, conservative signature of the files a check reads.
 *
 * Path, size, and modification time — not content hashes, because this runs
 * before every check on every attempt and reading a repository to decide
 * whether to read a repository is not a saving. Every build tool in existence
 * makes the same trade.
 *
 * The failure mode that matters is a stale *pass*, so the bias is toward
 * over-invalidation: a file touched without changing invalidates and the check
 * re-runs, which costs time. The reverse — a change that leaves size and mtime
 * identical — would have to be a same-length edit written within the
 * filesystem's timestamp granularity, and molt's own writes always move mtime.
 */
/** Makes every unreadable-scope signature unique, even within a millisecond. */
let unreadable = 0;

export function fingerprint(root: string, globs?: string[]): string {
  const parts: string[] = [];
  const patterns = globs?.length ? globs : [undefined];
  const seen = new Set<string>();

  for (const glob of patterns) {
    // Bounded like every other walk. This one runs synchronously on the
    // check-cache path, so an unbounded version freezes the terminal exactly
    // the way the search did — and a fingerprint that could not be taken in
    // time is handled below as one that cannot be trusted, which is already
    // the correct conservative answer.
    const { entries, truncated } = walk(root, {
      depth: 24,
      glob,
      limit: 20_000,
      deadline: Date.now() + WALK_DEADLINE_MS,
    });
    // A listing that hit its bound has not seen the whole scope, and a
    // signature of an unknown subset is not a signature. Say so, and the
    // caller treats it as never matching.
    // Never equal to anything, including itself: a signature of a scope that
    // could not be read in full must not match on the next call, and Date.now()
    // repeats inside a millisecond.
    if (truncated) return `unbounded:${Date.now()}:${unreadable++}`;
    for (const e of entries) {
      if (e.kind !== "file" || seen.has(e.path)) continue;
      seen.add(e.path);
      let mtime = 0;
      try {
        mtime = statSync(join(root, e.path)).mtimeMs;
      } catch {
        continue;
      }
      parts.push(`${e.path}:${e.bytes ?? 0}:${mtime}`);
    }
  }
  parts.sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export type Match = { path: string; line: number; text: string };

/** Does this look like text? A null byte in the first block says no. */
function isText(buf: Buffer): boolean {
  return !buf.subarray(0, 4096).includes(0);
}

/**
 * Search file contents for a regular expression.
 *
 * Bounded three ways: files skipped by size, matches capped, and each matching
 * line trimmed. A search that returns everything is a search nobody reads.
 */
/**
 * A quantifier inside a quantified group: `(a+)+`, `(\s*)*`, `([a-z]+)*`.
 *
 * This is the shape behind catastrophic backtracking, and JavaScript offers no
 * way to time-limit a regex once it starts — so the only defence is to decline
 * the pattern before running it. Refusing is safe: every such pattern has a
 * simpler equivalent, and the message says so. Detection is conservative and
 * will miss exotic cases, which is why the deadline below exists as well.
 */
export function isCatastrophic(pattern: string): boolean {
  return /\([^)]*[+*{][^)]*\)\s*[+*{]/.test(pattern);
}

export type GrepResult = {
  matches: Match[];
  truncated: boolean;
  scanned: number;
  invalid?: string;
  timedOut?: boolean;
  /** True when the *walk* was cut short, so files exist that were never opened. */
  partialWalk?: boolean;
};

export async function grepFiles(
  root: string,
  pattern: string,
  opts: { glob?: string; depth?: number; limit?: number; ignoreCase?: boolean } = {},
): Promise<GrepResult> {
  if (isCatastrophic(pattern)) {
    return {
      matches: [],
      truncated: false,
      scanned: 0,
      invalid:
        "a quantifier inside a quantified group can take exponential time to match. " +
        "Rewrite it without the nesting — /(a+)+/ is /a+/, /(\\s*)*/ is /\\s*/",
    };
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.ignoreCase ? "i" : undefined);
  } catch (e) {
    return { matches: [], truncated: false, scanned: 0, invalid: String(e) };
  }
  const deadline = Date.now() + SEARCH_DEADLINE_MS;

  const limit = opts.limit ?? MAX_MATCHES;
  // The deadline covers the walk, which is where the time actually goes. It
  // used to be created here and first consulted in the scan loop below — after
  // the walk had already finished — so the one phase that could run for
  // minutes was the one phase it did not bound.
  const { entries, truncated: partialWalk } = await walkAsync(root, {
    depth: opts.depth ?? 12,
    glob: opts.glob,
    limit: 5000,
    skip: SEARCH_SKIP_DIRS,
    deadline: Math.min(deadline, Date.now() + WALK_DEADLINE_MS),
  });
  const matches: Match[] = [];
  let scanned = 0;

  for (const e of entries) {
    // Every file. Gating this on `scanned & 7` meant a search over eight large
    // files yielded twice and blocked for everything in between — and reading
    // a file off a busy disk is not reliably quick either.
    await new Promise((r) => setImmediate(r));
    if (e.kind !== "file") continue;
    if ((e.bytes ?? 0) > MAX_SEARCH_BYTES) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(join(root, e.path));
    } catch {
      continue;
    }
    if (!isText(buf)) continue;
    scanned++;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Inside the file too, not only between files. The cost of a search is
      // not always in the reading: `.*with.*some.*words.*absent` over ten
      // megabytes spends four hundred milliseconds in the regex engine, and
      // yielding only between files froze the terminal for all of it. A model
      // writing a pattern like that is ordinary, so this cannot depend on the
      // pattern being cheap.
      if (i > 0 && (i & 0x3ff) === 0) await new Promise((r) => setImmediate(r));
      // Checked between lines rather than per file: one enormous file must not
      // be able to outrun the deadline on its own.
      if ((i & 0x3f) === 0 && Date.now() > deadline) {
        return { matches, truncated: true, scanned, timedOut: true, partialWalk };
      }
      // A match past this column is not something anyone reads, and an
      // unbounded line is what makes a slow pattern into a hung one.
      if (!re.test(lines[i]!.slice(0, MAX_LINE_CHARS))) continue;
      if (matches.length >= limit) return { matches, truncated: true, scanned, partialWalk };
      matches.push({ path: e.path, line: i + 1, text: lines[i]!.slice(0, 240).trim() });
    }
  }
  return { matches, truncated: Boolean(partialWalk), scanned, partialWalk };
}

export function formatMatches(pattern: string, result: GrepResult): string {
  if (result.invalid) return `[molt: /${pattern}/ was not run — ${result.invalid}]`;
  // A search that never reached most of the tree and found nothing is not the
  // same answer as "it is not there", and reporting them identically is how a
  // model concludes a symbol does not exist and acts on it.
  if (result.partialWalk && result.matches.length === 0) {
    return (
      `[molt: /${pattern}/ found nothing, but the search did not reach the whole tree — it ` +
      `stopped while listing files. This is NOT evidence the pattern is absent. Search a ` +
      `subdirectory, or narrow it with a glob.]`
    );
  }
  if (result.timedOut) {
    return (
      `[molt: the search for /${pattern}/ ran past ${SEARCH_DEADLINE_MS}ms and was stopped ` +
      `after ${result.matches.length} match(es) in ${result.scanned} file(s). Narrow it with a ` +
      `glob or a simpler pattern.]\n` +
      result.matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n")
    );
  }
  if (result.matches.length === 0) {
    return `[molt: no match for /${pattern}/ in ${result.scanned} file(s) searched]`;
  }
  const head = `[molt: ${result.matches.length} match(es) for /${pattern}/ in ${result.scanned} file(s)]`;
  const lines = result.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
  const tail = result.partialWalk
    ? [
        `[molt: the file listing was cut short, so there may be matches in files this search ` +
          `never opened — narrow it to a subdirectory to be sure]`,
      ]
    : result.truncated
      ? [`[molt: stopped at ${MAX_MATCHES} matches — narrow the pattern or the glob]`]
      : [];
  return [head, ...lines, ...tail].join("\n");
}

export type EditResult =
  | { ok: true; text: string; replacements: number }
  | { ok: false; why: string };

/**
 * Paths whose content is *supposed* to be a diff. Nothing below applies to
 * them.
 */
export function isPatchPath(path: string): boolean {
  return /\.(diff|patch|rej|orig)$/i.test(path.trim());
}

/**
 * Does this text look like unified-diff body rather than the file content it
 * claims to be?
 *
 * Receipt 0040. Asked to add a comment to `src/engine.ts`, a 20B local model
 * sent `new_text` as diff body and molt wrote it literally:
 *
 *     +// TODO: Implement multi-agent support. This will allow running several
 *     +// concurrent agent instances to speed up work. The current engine only
 *     +// handles one agent loop at a time.
 *     import { runCommand } from "./run.ts";
 *
 * `tsc` said `TS1109: Expression expected` and stayed saying it. The model then
 * spent 47 steps and roughly 800,000 tokens re-reading those same twenty lines
 * without ever once seeing the character it had put there. A refusal at the
 * moment of writing costs one step; this cost a session.
 *
 * Note the shape, because it decides the rule: that payload is not a clean
 * diff. Three lines carry a marker and the fourth does not. A test for "every
 * line looks like diff" — the obvious rule, and the first one written here —
 * passes it straight through. What is actually diagnostic is a `+` at column
 * zero, more than once.
 *
 * Precision matters far more than recall: wrongly refusing a legal edit blocks
 * real work, while a miss costs one bad write that the bar still catches. So:
 *
 *  - markers must sit at column 0. Indented `+` is string concatenation or a
 *    continued expression — ordinary code, never refused.
 *  - `+ ` followed by a single space and text is a markdown bullet, not an
 *    added line. Diff hunks indent by the original line's own indentation, so
 *    a real added line reads `+import`, `+// x`, or `+    const x`.
 *  - two such lines, or one paired with a removal. A lone marked line is too
 *    little to be sure of.
 *
 * Hunk and file headers are conclusive on their own.
 *
 * Returns the reason it looks like a diff, or null if it does not.
 */
export function diffSyntaxIn(text: string): string | null {
  if (/^@@ +-\d+(,\d+)? +\+\d+(,\d+)? +@@/m.test(text)) {
    return "it contains a unified-diff hunk header (`@@ ... @@`)";
  }
  if (/^--- [^\n]*\n\+\+\+ /m.test(text)) {
    return "it contains unified-diff file headers (`--- ` then `+++ `)";
  }
  const lines = text.split("\n");
  const marked = (mark: string) =>
    lines.filter(
      (l) =>
        l.startsWith(mark) &&
        l.slice(1).trim() !== "" &&
        // `+ item` / `- item`: a list, in markdown or YAML.
        !new RegExp(`^\\${mark} \\S`).test(l),
    ).length;
  const added = marked("+");
  if (added === 0) return null;
  const removed = marked("-");
  if (added < 2 && removed === 0) return null;
  return (
    `${added} line${added === 1 ? "" : "s"} begin${added === 1 ? "s" : ""} with \`+\`` +
    (removed > 0 ? ` and ${removed} with \`-\`` : "") +
    " at column 0"
  );
}

/**
 * Does this text already hold diff-shaped lines? Then diff-shaped lines belong
 * in it, and the guard above has nothing to say about an edit to it.
 *
 * Used on both the text being replaced and the file around it: a doc comment
 * quoting a patch, a test fixture, a changelog, a markdown list bulleted with
 * `+`. The file itself is the evidence.
 */
export function holdsDiffText(text: string): boolean {
  return text.split("\n").some((l) => l.startsWith("+") && l.slice(1).trim() !== "");
}

/** What to tell a model that sent a diff where file content belongs. */
export function diffSyntaxRefusal(field: string, why: string): string {
  return (
    `${field} looks like a unified diff, not file content: ${why}. molt writes what you ` +
    `send, byte for byte — those markers would go into the file and break it. Send the ` +
    `literal lines as they should appear on disk, with no leading \`+\`, \`-\` or diff headers.`
  );
}

/**
 * Replace exact text in a file.
 *
 * Refuses rather than guesses. Text that is absent is a failed edit, and text
 * that appears more than once is ambiguous unless the caller says it means all
 * of them — a "helpful" edit that lands on the wrong occurrence is worse than
 * one that did not happen, because it looks like it worked.
 */
export function applyEdit(
  current: string,
  oldText: string,
  newText: string,
  replaceAll = false,
  opts: { allowDiffText?: boolean } = {},
): EditResult {
  if (oldText === "") return { ok: false, why: "old_text is empty; nothing to find" };
  if (oldText === newText) return { ok: false, why: "old_text and new_text are identical" };

  // Only when the text being REPLACED is not itself diff-shaped. A model
  // editing an example diff — in a doc comment, a test fixture, a changelog —
  // is doing something legitimate, and the surrounding text is the evidence.
  if (!opts.allowDiffText && !holdsDiffText(oldText) && !holdsDiffText(current)) {
    const why = diffSyntaxIn(newText);
    if (why) return { ok: false, why: diffSyntaxRefusal("new_text", why) };
  }

  const parts = current.split(oldText);
  const found = parts.length - 1;
  if (found === 0) {
    return {
      ok: false,
      why:
        "old_text does not appear in the file. Read the file again and copy the exact " +
        "text, including indentation — molt will not guess at a near match",
    };
  }
  if (found > 1 && !replaceAll) {
    return {
      ok: false,
      why:
        `old_text appears ${found} times. Include enough surrounding text to identify ` +
        `one of them, or pass replace_all to change every occurrence`,
    };
  }
  // Split and join, never String.replace: a replacement string is not literal
  // to `replace`, which reads `$&`, `$1`, "$`" and `$'` as substitutions. A
  // model editing code that contains any of them — regex replacements, shell,
  // jQuery — got silently different text than it asked for, which is the worst
  // possible failure in the tool whose job is exactness. `replaceAll` already
  // joined; only the single case was wrong.
  const [first, ...rest] = parts;
  return {
    ok: true,
    text: replaceAll ? parts.join(newText) : first + newText + rest.join(oldText),
    replacements: replaceAll ? found : 1,
  };
}

/**
 * How many lines of a change carry something other than a comment.
 *
 * Receipt 0025 was issued for this diff, and molt called it a completion:
 *
 *     + // molt: CLI entry point - handles command parsing and execution
 *       export async function main(argv = process.argv.slice(2))
 *
 * The model said in the receipt what it was for — "to satisfy the work-landed
 * check" — and `work-landed` had no way to disagree. It asks whether a file
 * changed, a comment is a change, and so a sentence restating the function's
 * own signature closed a task the model had not done.
 *
 * This is the cheap half of telling work from a keystroke: of the lines that
 * differ, how many are neither blank nor purely a comment. Zero means the
 * model moved characters without saying anything to the compiler.
 *
 * Two honest limitations, both in the direction of over-counting rather than
 * refusing real work:
 *
 *  - Comment syntax is guessed from the line, not parsed from the language. A
 *    line inside a block string that begins with `#` reads as a comment here.
 *  - Lines are compared as a multiset, so a change that only *moves* code
 *    scores zero. Reordering functions is real work that this cannot see, and
 *    `comment-only` in done.yml is the way to say so.
 */
/**
 * Which lines of `after` are new or changed, 1-indexed.
 *
 * The companion to `substanceOf`, which answers how many and is used to refuse
 * a diff of pure comments. This answers *which*, so a check can ask whether the
 * tests actually execute them.
 *
 * Same multiset comparison: a line that survives in the same quantity did not
 * change, wherever it moved to. Blank and comment lines are excluded, because
 * requiring a test to execute a comment is nonsense and would make the check
 * impossible to satisfy rather than merely strict.
 */
export function changedLinesOf(before: string, after: string): number[] {
  if (before === after) return [];
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  const changed: number[] = [];
  const lines = after.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const n = counts.get(line) ?? 0;
    if (n > 0) {
      counts.set(line, n - 1);
      continue;
    }
    if (isSubstantive(line)) changed.push(i + 1);
  }
  return changed;
}

export function substanceOf(before: string, after: string): number {
  if (before === after) return 0;
  // Multiset difference: a line that survives in the same quantity did not
  // change, wherever it ended up.
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  const changed: string[] = [];
  for (const line of after.split("\n")) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else changed.push(line);
  }
  // Whatever is left unmatched in `before` was removed, and a deletion is a
  // change too — removing a function body is work, and it adds no new lines.
  for (const [line, n] of counts) for (let i = 0; i < n; i++) changed.push(line);
  return changed.filter(isSubstantive).length;
}

/**
 * Does this line say anything to the compiler?
 *
 * Blank lines and whole-line comments do not. A line with code *and* a
 * trailing comment does, and counts.
 */
function isSubstantive(line: string): boolean {
  const t = line.trim();
  if (t === "") return false;
  // Line comments across the languages molt is pointed at, plus the
  // continuation lines of a block comment, which begin with `*`.
  if (/^(\/\/|#|--|;|%|<!--)/.test(t)) return false;
  if (/^\/\*/.test(t) || /^\*/.test(t)) return false;
  if (t === "*/" || t === "-->") return false;
  return true;
}
