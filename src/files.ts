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
import { readFileSync, readdirSync, statSync } from "node:fs";
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
export function walk(
  root: string,
  opts: {
    depth?: number;
    glob?: string;
    limit?: number;
    dirsOnly?: boolean;
    skip?: ReadonlySet<string>;
  } = {},
): { entries: Entry[]; truncated: boolean; skipped: string[] } {
  const skip = opts.skip ?? SKIP_DIRS;
  const depth = opts.depth ?? 1;
  const limit = opts.limit ?? MAX_ENTRIES;
  const entries: Entry[] = [];
  const skipped: string[] = [];
  let truncated = false;

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
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      let isDir = false;
      let bytes: number | undefined;
      try {
        const st = statSync(abs);
        isDir = st.isDirectory();
        bytes = isDir ? undefined : st.size;
      } catch {
        continue;
      }

      if (isDir && skip.has(name)) {
        skipped.push(rel);
        continue;
      }
      if (entries.length >= limit) {
        truncated = true;
        return { entries, truncated, skipped };
      }
      if (isDir) {
        if (!opts.glob) entries.push({ path: rel + "/", kind: "dir" });
        if (level + 1 < depth) queue.push({ dir: abs, level: level + 1 });
      } else if (!opts.dirsOnly && matchesGlob(rel, opts.glob)) {
        entries.push({ path: rel, kind: "file", bytes });
      }
    }
  }
  return { entries, truncated, skipped };
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
    const { entries, truncated } = walk(root, { depth: 24, glob, limit: 20_000 });
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

export function grepFiles(
  root: string,
  pattern: string,
  opts: { glob?: string; depth?: number; limit?: number; ignoreCase?: boolean } = {},
): { matches: Match[]; truncated: boolean; scanned: number; invalid?: string; timedOut?: boolean } {
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
  const { entries } = walk(root, {
    depth: opts.depth ?? 12,
    glob: opts.glob,
    limit: 5000,
    skip: SEARCH_SKIP_DIRS,
  });
  const matches: Match[] = [];
  let scanned = 0;

  for (const e of entries) {
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
      // Checked between lines rather than per file: one enormous file must not
      // be able to outrun the deadline on its own.
      if ((i & 0x3f) === 0 && Date.now() > deadline) {
        return { matches, truncated: true, scanned, timedOut: true };
      }
      // A match past this column is not something anyone reads, and an
      // unbounded line is what makes a slow pattern into a hung one.
      if (!re.test(lines[i]!.slice(0, MAX_LINE_CHARS))) continue;
      if (matches.length >= limit) return { matches, truncated: true, scanned };
      matches.push({ path: e.path, line: i + 1, text: lines[i]!.slice(0, 240).trim() });
    }
  }
  return { matches, truncated: false, scanned };
}

export function formatMatches(
  pattern: string,
  result: { matches: Match[]; truncated: boolean; scanned: number; invalid?: string; timedOut?: boolean },
): string {
  if (result.invalid) return `[molt: /${pattern}/ was not run — ${result.invalid}]`;
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
  const tail = result.truncated ? [`[molt: stopped at ${MAX_MATCHES} matches — narrow the pattern or the glob]`] : [];
  return [head, ...lines, ...tail].join("\n");
}

export type EditResult =
  | { ok: true; text: string; replacements: number }
  | { ok: false; why: string };

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
): EditResult {
  if (oldText === "") return { ok: false, why: "old_text is empty; nothing to find" };
  if (oldText === newText) return { ok: false, why: "old_text and new_text are identical" };

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
