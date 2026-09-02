/**
 * The repository map: what is here, before the model asks.
 *
 * aider's signature feature, and the one thing it does that no amount of
 * tool-calling replaces. A session that starts blind spends its first three
 * or four steps — and, because every tool result is resent on every later
 * request, a share of every step after that — establishing facts that were
 * always knowable for free: which files exist, and what is defined in them.
 * Watching a local model burn eleven steps discovering `src/engine.ts` is
 * what makes the case; the map costs a few hundred tokens once, inside the
 * cached prefix, and it is the same few hundred tokens on step thirty.
 *
 * What this is not: aider builds a tree-sitter parse of every file and ranks
 * the graph with PageRank over symbol references. This does neither. It reads
 * top-level declarations with per-language regexes, and ranks each file by how
 * many other files import it — one hop, not a graph. That is cruder, and it is
 * stated as such rather than dressed up, but it puts the file everyone imports
 * at the top, which is the whole job, with no parser, no native dependency and
 * no build step.
 *
 * Two rules it does not break:
 *
 *  - **A map is never evidence.** Nothing here is shown to the bar, written
 *    to a receipt, or counted as work. It is context, and context can be
 *    wrong — a stale map is a wasted hint, not a false claim.
 *  - **The budget is real.** Files are emitted until the token budget is
 *    spent and then it stops, saying how many it left out. A "map" that
 *    quietly grew to 40k tokens on a large repository would cost more than
 *    the exploration it replaces.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { walkAsync, SEARCH_SKIP_DIRS } from "./files.js";
import { estTokens } from "./types.js";

/** Extensions worth reading for symbols, with the shape of each language's declarations. */
const LANGUAGES: { ext: string[]; patterns: RegExp[] }[] = [
  {
    ext: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    patterns: [
      /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*class\s+([A-Za-z_$][\w$]*)/gm,
    ],
  },
  {
    ext: [".py"],
    patterns: [/^\s*def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm],
  },
  {
    ext: [".go"],
    patterns: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^\s*type\s+([A-Za-z_]\w*)/gm],
  },
  {
    ext: [".rs"],
    patterns: [
      /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm,
      /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm,
    ],
  },
  {
    ext: [".rb"],
    patterns: [/^\s*def\s+([A-Za-z_]\w*)/gm, /^\s*(?:class|module)\s+([A-Za-z_]\w*)/gm],
  },
  {
    ext: [".java", ".kt", ".cs", ".swift"],
    patterns: [
      /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|struct)\s+([A-Za-z_]\w*)/gm,
      /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?[\w<>,\[\]]+\s+([A-Za-z_]\w*)\s*\(/gm,
    ],
  },
  {
    ext: [".c", ".h", ".cc", ".cpp", ".hpp"],
    patterns: [
      /^\s*(?:struct|union|enum)\s+([A-Za-z_]\w*)/gm,
      /^[A-Za-z_][\w\s*]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm,
    ],
  },
];

const EXT_OF = new Map<string, RegExp[]>();
for (const lang of LANGUAGES) for (const e of lang.ext) EXT_OF.set(e, lang.patterns);

/** How much of a file is read. A map is made of declarations, which are at the top. */
export const READ_HEAD_BYTES = 64 * 1024;

/** Symbols per file in the map line, before it says "+N". */
export const SYMBOLS_SHOWN = 6;

export function extensionOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i).toLowerCase();
}

/** Is this a file the map knows how to read? */
export function isMappable(path: string): boolean {
  return EXT_OF.has(extensionOf(path));
}

/**
 * Top-level declarations, in the order they appear, deduplicated.
 *
 * Deliberately shallow: a method on a class is not a top-level declaration
 * and does not belong in a map whose job is "which file would I open". The
 * regexes anchor to the start of a line for the same reason — an indented
 * `function` is a callback, not an export.
 */
export function symbolsIn(path: string, text: string): string[] {
  const patterns = EXT_OF.get(extensionOf(path));
  if (!patterns) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const re of patterns) {
    // Each pattern carries /g, so its lastIndex survives between calls.
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const name = m[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      found.push(name);
    }
  }
  return found;
}

export type MapFile = { path: string; symbols: string[]; imports: string[] };

/**
 * Every module specifier a file imports, as written.
 *
 * The first version of this ranked by asking which files *mention* a name the
 * file defines, which sounds equivalent and is not: run it on this repository
 * and `src/line.ts` outranks `src/engine.ts`, because it defines `line`,
 * `left`, `right` and `insert` — ordinary English words that appear in every
 * file for reasons that have nothing to do with `line.ts`. Ranking on a signal
 * that common vocabulary can spoof produces a map that is confidently wrong
 * about which file matters, which is worse than no map.
 *
 * An import is the thing "who uses this file" actually means, it is written
 * down explicitly in every language worth mapping, and no amount of prose can
 * fake one.
 */
export function importsIn(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    // import x from "y" · export { x } from "y" · import "y"
    /(?:^|[\s;{(])(?:import|export)\s[^;\n]*?from\s*['"]([^'"\n]+)['"]/g,
    /^\s*import\s+['"]([^'"\n]+)['"]/gm,
    /require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    // python: from a.b import c · import a.b
    /^\s*from\s+([\w.]+)\s+import\s/gm,
    /^\s*import\s+([\w.]+)\s*$/gm,
    // go, inside a grouped import; c and c++
    /^\s*(?:[\w.]+\s+)?"([\w./-]+)"\s*$/gm,
    /#include\s*[<"]([^>"\n]+)[>"]/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const spec = (m[1] ?? "").trim();
      if (spec) out.add(spec);
    }
  }
  return [...out];
}

const SOURCE_EXT_RE = /\.(?:m?[jt]sx?|cjs|py|go|rs|rb|java|kt|cs|swift|cc|cpp|hpp|[ch])$/i;

/**
 * A path or specifier reduced to what two of them can be compared on: forward
 * slashes, no extension, no leading `./` or `../`, dots as separators for
 * python's `a.b.c`.
 */
export function importKey(spec: string): string {
  // Only a real source extension is stripped. Stripping "the bit after the
  // last dot" turns python's `pack.cells` into `pack`, which then matches
  // every file called pack — a wrong answer produced confidently.
  let s = spec.replace(/\\/g, "/").replace(SOURCE_EXT_RE, "");
  s = s.replace(/^(?:\.\.?\/)+/, "").replace(/^\//, "");
  if (!s.includes("/") && s.includes(".")) s = s.replace(/\./g, "/");
  return s;
}

export type Ranked = { path: string; symbols: string[]; users: number };

/**
 * Rank files by how many other files import them.
 *
 * The file everyone imports comes first, which is the file a stranger should
 * read first. A file nothing imports is not worthless — it may be the entry
 * point — so it is ranked last rather than dropped, and ties break toward the
 * file that defines more, then alphabetically, so the map is stable between
 * runs. A map that reshuffles every session is a map nobody learns.
 */
export function rankFiles(files: MapFile[]): Ranked[] {
  // Every file, keyed the way an import would name it. Matching is by path
  // suffix — `./line.js` from anywhere resolves to `src/line.ts` — which is
  // the same rule this codebase already uses to match coverage records to
  // source, and it fails the same way: two files with the same trailing path
  // both count. That is a rank being slightly generous, not a file being
  // invented.
  const keys = files.map((f) => importKey(f.path));
  return files
    .map((f, i) => {
      const key = keys[i]!;
      let users = 0;
      files.forEach((g, j) => {
        if (i === j) return;
        const hit = g.imports.some((spec) => {
          const s = importKey(spec);
          return s.length > 0 && (key === s || key.endsWith(`/${s}`));
        });
        if (hit) users += 1;
      });
      return { path: f.path, symbols: f.symbols, users };
    })
    .sort(
      (a, b) =>
        b.users - a.users || b.symbols.length - a.symbols.length || a.path.localeCompare(b.path),
    );
}

/** One line per file: the path, then what it defines. */
export function mapLine(r: Ranked): string {
  if (!r.symbols.length) return `  ${r.path}`;
  const shown = r.symbols.slice(0, SYMBOLS_SHOWN).join(", ");
  const rest = r.symbols.length - SYMBOLS_SHOWN;
  return `  ${r.path}  ${shown}${rest > 0 ? ` +${rest}` : ""}`;
}

export type RepoMap = {
  text: string;
  /** Files the map names. */
  shown: number;
  /** Files it had room for but left out. */
  omitted: number;
  tokens: number;
};

/**
 * Render a ranked list into a budgeted map.
 *
 * The header says what the thing is and how complete it is, because a partial
 * map presented as a whole one is how a model concludes a file does not exist.
 */
export function renderMap(ranked: Ranked[], budgetTokens: number): RepoMap {
  if (!ranked.length) return { text: "", shown: 0, omitted: 0, tokens: 0 };
  const lines: string[] = [];
  let used = 0;
  for (const r of ranked) {
    const line = mapLine(r);
    const cost = estTokens(line) + 1;
    if (used + cost > budgetTokens) break;
    lines.push(line);
    used += cost;
  }
  const omitted = ranked.length - lines.length;
  if (!lines.length) return { text: "", shown: 0, omitted: ranked.length, tokens: 0 };
  const header =
    `Repository map — the ${lines.length} file(s) most referenced by the rest, and what each defines.` +
    (omitted > 0 ? ` ${omitted} more file(s) are not listed.` : "") +
    `\nIt is a starting point, not an inventory: it is regex-derived, it lists top-level` +
    `\ndeclarations only, and it can be stale. Read a file before believing it.`;
  const text = `${header}\n${lines.join("\n")}`;
  return { text, shown: lines.length, omitted, tokens: estTokens(text) };
}

export type RepoMapOptions = {
  /** Token ceiling for the map body. */
  budgetTokens?: number;
  /** Stop after examining this many candidate files. */
  maxFiles?: number;
};

/** Default map budget: enough for a few dozen files, small enough to forget about. */
export const DEFAULT_MAP_TOKENS = 900;
export const DEFAULT_MAP_MAX_FILES = 400;

/**
 * Directories a map must not walk into, beyond the ones every search skips.
 *
 * Built output and agent scratch space are not source, and mapping them is
 * not merely wasteful — it is actively wrong. Run the first version of this
 * on molt's own repository and a third of the map is `dist-test/src/line.js`
 * and `.claude/worktrees/agent-a03f.../src/engine.ts`: the same files two and
 * three times over, crowding real ones out of the budget and each copy
 * standing as evidence that the others are important.
 *
 * `dist` is in the shared skip set; `dist-test`, `dist-esm` and friends are
 * not and cannot be, because a set holds names rather than shapes — so the
 * top level is read once and every directory whose name starts with `dist` is
 * added by hand.
 */
export function mapSkipDirs(cwd: string): Set<string> {
  const skip = new Set<string>([...SEARCH_SKIP_DIRS, ".claude", ".husky", "__snapshots__"]);
  try {
    for (const e of readdirSync(cwd, { withFileTypes: true })) {
      if (e.isDirectory() && /^dist/i.test(e.name)) skip.add(e.name);
    }
  } catch {
    /* an unreadable root is a map with nothing in it, which renderMap handles */
  }
  return skip;
}

/**
 * Build the map for a working directory.
 *
 * Bounded twice over — by how many files it will look at and by how many
 * tokens it will spend — because this runs at session start, in front of the
 * user, on a directory nobody promised was small.
 */
export async function buildRepoMap(cwd: string, opts: RepoMapOptions = {}): Promise<RepoMap> {
  const budget = opts.budgetTokens ?? DEFAULT_MAP_TOKENS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAP_MAX_FILES;
  if (budget <= 0) return { text: "", shown: 0, omitted: 0, tokens: 0 };

  const walked = await walkAsync(cwd, {
    depth: 12,
    limit: maxFiles * 4,
    skip: mapSkipDirs(cwd),
  });
  const candidates = walked.entries
    .filter((e) => e.kind === "file" && isMappable(e.path))
    .slice(0, maxFiles);

  const files: MapFile[] = [];
  for (const entry of candidates) {
    let text = "";
    try {
      text = readFileSync(join(cwd, entry.path), "utf8").slice(0, READ_HEAD_BYTES);
    } catch {
      // A file that cannot be read is a file the map does not describe. It is
      // not an error: permissions and races are ordinary, and a map is a hint.
      continue;
    }
    files.push({ path: entry.path, symbols: symbolsIn(entry.path, text), imports: importsIn(text) });
  }
  if (!files.length) return { text: "", shown: 0, omitted: 0, tokens: 0 };
  return renderMap(rankFiles(files), budget);
}
