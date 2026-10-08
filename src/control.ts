/**
 * What of a passing check the worker controlled.
 *
 * A check is evidence only when the worker could not have arranged its pass
 * without doing the work. Three arrangements pass a sound-looking check with
 * the deliverable still wrong, and each leaves a mark on the tree Maat can
 * read mechanically:
 *
 *  1. **The runner was shadowed.** The person's bar runs `python3 -m pytest`
 *     or `npm test`; the worker drops a file that runner loads on its own — a
 *     `conftest.py` that rewrites failures into passes, a
 *     `node_modules/.bin/node` that exits 0, a module named after the runner
 *     in the project root — and the command exits 0 over wrong work. The
 *     command the person wrote ran; the program it named did not.
 *  2. **The expected value was the worker's.** `diff out expected.txt` asserts
 *     a value only while expected.txt is not something the worker wrote. One
 *     it created or changed this turn (or a test snapshot it rewrote) is the
 *     worker grading its own answer.
 *  3. **The only input was one the worker could read.** A drafted check that
 *     runs the deliverable on nothing but the project's own example files can
 *     be met by special-casing those files — `if path.endswith('data.txt'):
 *     print(3)`. Hidden or not, its input was in plain view. Applied to
 *     drafted checks only: a person who chose to test on their own fixtures
 *     made that call, and Maat does not second-guess the person's bar.
 *
 * None of these refuses anything. A discounted check still passes and still
 * shows on the receipt; it just does not count toward the word "verified"
 * (tiers.ts), and the reason says which file did it. Legitimate work that
 * adds a conftest fixture or regenerates a snapshot loses the label, never the
 * claim — the same trade the rest of the tier rule makes: a check missed here
 * costs one claim the word, a check counted wrongly costs the word its
 * meaning.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { treeChanges, type TreeSnapshot } from "./files.js";
import type { CheckAuthor, CheckResult } from "./types.js";

export type TurnFiles = {
  cwd: string;
  /** The tree when the turn began, when one was taken. */
  before?: TreeSnapshot | null;
  /** Project-relative paths Maat's own tools wrote this turn. */
  written: readonly string[];
  /** Who wrote each check, by result name. Missing means unknown. */
  authors?: ReadonlyMap<string, CheckAuthor>;
};

/** Project-relative paths created or changed this turn, by any route. */
export function touchedThisTurn(t: TurnFiles): Set<string> {
  const out = new Set(t.written.map((p) => norm(t.cwd, p)).filter((p): p is string => p !== null));
  if (t.before && !t.before.truncated) {
    try {
      const d = treeChanges(t.cwd, t.before);
      for (const p of [...d.changed, ...d.created]) out.add(p);
    } catch {
      /* the ledger alone, then */
    }
  }
  return out;
}

/** `p` as a project-relative POSIX path, or null when it is outside the project. */
function norm(cwd: string, p: string): string | null {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** Path-looking words in a command: `count.py`, `"tests/data in.txt"`, `./expected.txt`. */
export function pathWords(run: string): string[] {
  const out = new Set<string>();
  for (const m of run.matchAll(/"([^"$`\n]+)"|'([^'\n]+)'|((?:\.{0,2}\/)?[\w@%+=:,.-]+(?:\/[\w@%+=:,.-]+)*)/g)) {
    const w = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    // Quoted program text (`python3 -c "..."`) holds paths as words too; a
    // quoted plain path (spaces and all) is one word.
    if ((m[1] || m[2]) && !/^[\w@%+=:,./ -]+$/.test(w)) {
      for (const inner of pathWords(w.replace(/["'()[\]{},;]/g, " "))) out.add(inner);
      continue;
    }
    if (/\.[A-Za-z0-9]{1,8}$/.test(w) || w.includes("/")) out.add(w.replace(/^\.\//, ""));
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// 1. Runner hooks.

const PY = /(?:^|[\s;&|(`'"])(?:python[\d.]*|py\.?test|pip[\d.]*|tox|nox|uv|poetry)(?=$|[\s;&|)`'"])/;
const PYTEST = /\bpy\.?test\b/;
const NODE = /(?:^|[\s;&|(`'"])(?:npm|npx|pnpm|yarn|bun|node|jest|vitest|mocha|ava|tap)(?=$|[\s;&|)`'"])/;
const NPM_LIKE = /(?:^|[\s;&|(`'"])(?:npm|npx|pnpm|yarn|bun)(?=$|[\s;&|)`'"])/;

/** Files a Python interpreter or pytest loads with no word about them in the command. */
function pythonHook(path: string, run: string, cwd: string): string | null {
  const name = basename(path);
  if (/^(?:sitecustomize|usercustomize)\.py$/.test(name) || name.endsWith(".pth")) {
    return PY.test(run) ? `${path} is loaded by every Python interpreter that starts` : null;
  }
  if (!PYTEST.test(run)) return null;
  if (name === "conftest.py") return `${path} is a pytest plugin pytest loads on its own`;
  if (name === "pytest.ini" || name === ".pytest.ini" || name === "tox.ini") return `${path} configures how pytest runs`;
  if (name === "pyproject.toml" || name === "setup.cfg") {
    try {
      const text = readFileSync(resolve(cwd, path), "utf8");
      if (/\[tool[.:]pytest/.test(text)) return `${path} holds pytest's configuration`;
    } catch {
      /* gone: nothing loads it */
    }
  }
  return null;
}

/** A project-root module named after one the command runs with `-m`: it is what runs instead. */
function shadowedModule(path: string, run: string): string | null {
  for (const m of run.matchAll(/\bpython[\d.]*\s+(?:-\w+\s+)*-m\s+([\w.]+)/g)) {
    const top = m[1]!.split(".")[0]!;
    if (path === `${top}.py` || path.startsWith(`${top}/`)) return `${path} shadows the \`${top}\` module the check runs with -m`;
  }
  if (PYTEST.test(run) && (path === "pytest.py" || path.startsWith("pytest/") || path.startsWith("_pytest/"))) {
    return `${path} shadows pytest itself`;
  }
  return null;
}

/** JS runner config and setup files the runner reads unasked. */
function nodeHook(path: string, run: string): string | null {
  if (!NODE.test(run)) return null;
  const name = basename(path);
  if (/^(?:jest|vitest|vite|mocha|ava|babel)\.config\.[cm]?[jt]s(?:on)?$/.test(name) || /^\.mocharc(?:\.\w+)?$/.test(name)) {
    return `${path} configures the test runner`;
  }
  if (name === ".npmrc" && NPM_LIKE.test(run)) return `${path} configures npm (it can replace the shell scripts run in)`;
  return null;
}

/**
 * Entries in node_modules/.bin made or changed since `since` that are not a
 * package's own link: a plain file, or a link that leaves node_modules. npm
 * puts this folder first on PATH for every script, so one named `node` or
 * after any command a script runs is what that script runs instead. An
 * install the worker ran leaves links into node_modules, which are not
 * flagged. node_modules is outside the tree snapshot, so it is read here.
 */
export function plantedBins(cwd: string, since: number): string[] {
  const dir = resolve(cwd, "node_modules", ".bin");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const p = resolve(dir, n);
    try {
      const st = lstatSync(p);
      // A link into node_modules whose target the turn wrote: the link can be
      // old while the program it runs is new (node_modules/jest/bin/jest.js
      // edited in place), or the link new and its package one nobody installed.
      if (st.isSymbolicLink()) {
        const why = tamperedTarget(cwd, p, since);
        if (why) {
          out.push(`node_modules/.bin/${n} (${why})`);
          continue;
        }
      }
      if (st.mtimeMs < since - 1_000 && st.ctimeMs < since - 1_000) continue;
      // A bin named after a command the system already has (node, sh,
      // python3) shadows it whatever it links to; no package needs that.
      const shadowsSystem = onSystemPath(n, cwd);
      if (st.isSymbolicLink() && !shadowsSystem) {
        const target = resolve(dir, readlinkSync(p));
        const inModules = !relative(resolve(cwd, "node_modules"), target).startsWith("..");
        if (inModules) continue;
      }
      out.push(`node_modules/.bin/${n}`);
    } catch {
      /* raced away */
    }
  }
  return out;
}

/**
 * Why a `.bin` link's real target inside node_modules is the worker's, or null.
 * npm installs files with a fixed old mtime, so a target modified since the
 * turn began was written by hand. A target whose package has no package.json,
 * or whose package.json does not declare it as a bin, was put there by hand
 * too, when it appeared this turn.
 */
function tamperedTarget(cwd: string, link: string, since: number): string | null {
  const modules = resolve(cwd, "node_modules");
  let real: string;
  try {
    real = realpathSync(link);
  } catch {
    return null;
  }
  let modulesReal = modules;
  try {
    modulesReal = realpathSync(modules);
  } catch {
    /* as is */
  }
  const rel = relative(modulesReal, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const st = statSync(real);
  if (st.mtimeMs >= since - 1_000) return `${rel} was modified this turn`;
  if (st.ctimeMs < since - 1_000) return null;
  const parts = rel.split(sep);
  const pkgDir = join(modulesReal, ...(parts[0]!.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)));
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { name?: string; bin?: string | Record<string, string> };
    const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
    if (bins.some((b) => resolve(pkgDir, b) === real)) return null;
    return `${rel} is not a bin its package declares`;
  } catch {
    return `${rel} appeared this turn in a folder with no package.json`;
  }
}

/** True when `name` is a command on PATH outside the project. */
function onSystemPath(name: string, cwd: string): boolean {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (!d || !relative(cwd, resolve(d)).startsWith("..")) continue;
    if (existsFile(resolve(d, name))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 2. Expected values the worker wrote.

/** A file named as the expected side of a comparison. Same words as tiers.ts rule 3, and a few more. */
const EXPECTED_NAME = /(?:expect|golden|want|answer|baseline|correct|oracle|truth)/i;

/** Snapshot files a JS runner compares output against. */
function isSnapshotFile(path: string): boolean {
  return /(^|\/)__snapshots__\//.test(path) || path.endsWith(".snap");
}

// ---------------------------------------------------------------------------
// 3. Inputs in plain view.

/** Source, build and manifest files: what a command runs, not what it reads as data. */
const CODE_EXT = /\.(?:py|pyw|[cm]?[jt]sx?|sh|bash|zsh|rb|go|rs|java|kt|kts|scala|c|cc|cpp|cxx|h|hpp|cs|swift|php|pl|pm|lua|r|jl|ex|exs|erl|hs|ml|clj|dart|groovy|ps1|bat|cmd|mk|gradle|toml|lock|cfg|ini)$/i;
const MANIFEST = /^(?:package(?:-lock)?\.json|tsconfig(?:\.[\w-]+)?\.json|jsconfig\.json|composer\.json|deno\.json|Makefile|Dockerfile|Cargo\.toml|go\.mod|go\.sum|pyproject\.toml|setup\.py|requirements[\w.-]*\.txt|Gemfile|\.?[\w-]*rc)$/;

/** True when the command makes some of the data it feeds the work, rather than only reading files. */
export function suppliesOwnInput(run: string): boolean {
  return /<<|\bprintf\b|\becho\b|\bcat\s*>|\btee\b|\bseq\b|\byes\b|\bshuf\b|\$RANDOM|\/dev\/urandom|\brandom\b/.test(run);
}

/**
 * The project files a command reads as data that were already there when the
 * turn began and are unchanged: inputs the worker could open and tailor its
 * answer to. Empty when the command supplies any input of its own.
 */
export function visibleInputs(run: string, cwd: string, touched: ReadonlySet<string>, before?: TreeSnapshot | null): string[] {
  if (suppliesOwnInput(run)) return [];
  const out: string[] = [];
  for (const w of pathWords(run)) {
    const rel = norm(cwd, w);
    if (!rel || touched.has(rel)) continue;
    const name = basename(rel);
    if (CODE_EXT.test(name) || MANIFEST.test(name)) continue;
    if (before && !before.truncated ? !before.files.has(rel) : !existsFile(resolve(cwd, rel))) continue;
    out.push(rel);
  }
  return out;
}

function existsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

/**
 * Passing command checks whose pass the worker controlled, by result name,
 * with the reason in a sentence fit for a receipt.
 */
export function discountedChecks(
  results: readonly Pick<CheckResult, "name" | "kind" | "detail" | "ok" | "skipped" | "hidden" | "tags">[],
  t: TurnFiles,
): Map<string, string> {
  const out = new Map<string, string>();
  const passing = results.filter((r) => r.ok && !r.skipped && r.kind === "command" && r.detail);
  if (!passing.length) return out;
  const touched = touchedThisTurn(t);
  const bins = plantedBins(t.cwd, t.before?.takenAt ?? Number.POSITIVE_INFINITY);
  for (const r of passing) {
    const run = r.detail;
    const why = (() => {
      for (const p of touched) {
        const hook = pythonHook(p, run, t.cwd) ?? shadowedModule(p, run) ?? nodeHook(p, run);
        if (hook) return `it passed through ${hook}, and the worker ${createdOrChanged(p, t)} it this turn`;
      }
      if (bins.length && NPM_LIKE.test(run)) {
        return `the worker put ${bins.join(", ")} on the PATH npm gives every script, so the command did not run what it names`;
      }
      for (const w of pathWords(run)) {
        const rel = norm(t.cwd, w);
        if (rel && touched.has(rel) && EXPECTED_NAME.test(basename(rel))) {
          return `it compares against ${rel}, which the worker ${createdOrChanged(rel, t)} this turn — the expected value was the worker's`;
        }
      }
      if (NODE.test(run)) {
        const snaps = [...touched].filter(isSnapshotFile);
        if (snaps.length) return `the worker rewrote the test snapshot(s) ${snaps.slice(0, 3).join(", ")} the runner compares against`;
      }
      const author = t.authors?.get(r.name);
      // Drafted by another model: the worker's own checks never earn the word
      // anyway, and their label says so more exactly than this would.
      const drafted =
        r.hidden === true && author !== undefined && author.kind !== "person" && author.kind !== "worker" && !r.tags?.includes("mission");
      if (drafted) {
        const seen = visibleInputs(run, t.cwd, touched, t.before);
        if (seen.length) {
          return (
            `its only input was ${seen.slice(0, 3).join(", ")}, already in the project for the worker to read; ` +
            "an answer special-cased for that input passes it — no check ran the work on an input the worker never saw"
          );
        }
      }
      return null;
    })();
    if (why) out.set(r.name, why);
  }
  return out;
}

function createdOrChanged(rel: string, t: TurnFiles): string {
  if (t.before && !t.before.truncated) return t.before.files.has(rel) ? "changed" : "created";
  return "wrote";
}
