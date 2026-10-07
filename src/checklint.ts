/**
 * Seal-time lint for drafted checks.
 *
 * A drafted check is written before any work exists, by a model that has not
 * run it. reports/checkquality-2026-10-06.md read the 143 drafted checks that
 * refused correct work: 63% were broken by construction (an invented path or
 * signature, a shell construct this shell does not have, a tool that is not
 * installed, a tail the product's own evidence rules later refuse), not wrong
 * about the task. Each of those classes can be read off the command, the task
 * text and the untouched project, with no model and no run.
 *
 * A check that fails here is sent back to the drafter once (criteria.ts) and
 * dropped if the redraft fails too. The lint only ever RETIRES or REDRAFTS a
 * check: it cannot pass anything, mark anything verified, or lower a bar.
 *
 * Rules and the replay counts they were kept for (658 checks, 143 of which
 * refused correct work; the rule ids are the replay's):
 *   L1  tool or module not installed (pytest, python, rg, …)          10
 *   L2  git in a project with no repository the task never mentions    1
 *   L3  `kill %N`/`fg` under sh; `pkill -f` matching the check itself 17
 *   L4  `$(…)`/`${…}` inside single quotes (never expands)             4
 *   L5  grep with an unquoted multi-word pattern                       3
 *   L6  `test -z "literal command"`                                    .
 *   L7  `\d`, `{n}` under mawk, `+`/`?` in a basic regex               5
 *   L8  bashisms under sh                                              4
 *   L9  `|| exit 0` tail, test runner piped away (evidence.ts)         4
 *   L11 absolute path outside the project (strayPath)                  7
 *   L12 call to a function the project defines, wrong argument count  14
 *   L13 string literal passed to a project function, from nowhere      5
 *   L15 the check changes the work: git checkout/merge/commit/…, rm,
 *       mv, sed -i, tee or a redirect into the project, a package
 *       install (src/checkwrites.ts). Always on, MAAT_CHECK_LINT or not.
 *   L16 the check cannot fail (cannotFail): a trailing `|| echo …`,
 *       `|| true`, `; exit 0`; `find … -exec … \;`, whose status ignores
 *       what -exec ran; a script that prints PASS/FAIL and never exits
 *       non-zero. Always on. On 2026-10-07 a judge's `curl … || echo
 *       'fail'` checks passed before server.py existed and earned a wrong
 *       "verified".
 * Left out as noisy in the replay: hand-computed numbers (L14) and paths not
 * in the tree (L10) — each fired as often on good checks as on bad ones.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { swallowsExit, runnerPipedAway } from "./evidence.js";
import { strayPath } from "./criteria.js";
import { checkMutates } from "./checkwrites.js";

export type LintHit = { rule: string; why: string };

/** What the lint may ask the machine. All cheap, all cached; tests and the replay inject their own. */
export type Probes = {
  /** `command -v name` */
  hasCommand: (name: string) => boolean;
  /** `python3 -c "import name"` */
  hasPyModule: (name: string) => boolean;
  /** Does this awk understand `{n}` interval expressions? (mawk 1.3.4-2020 does not.) */
  awkIntervals: () => boolean;
};

export type LintCtx = {
  /** The untouched project. Without one, the rules that read the tree are skipped. */
  cwd?: string;
  /** `readTree(cwd)` taken before the work began; read fresh from `cwd` when absent. */
  tree?: Tree;
  task: string;
  /** The shell the check will run under. Under bash, `kill %1` and `[[` are fine. */
  shell: "bash" | "sh";
  probes?: Partial<Probes>;
};

const cache = new Map<string, boolean>();
function probeOnce(key: string, f: () => boolean): boolean {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let v = false;
  try {
    v = f();
  } catch {
    v = false;
  }
  cache.set(key, v);
  return v;
}

export const realProbes: Probes = {
  hasCommand: (n) => /^[\w.+-]+$/.test(n) && probeOnce(`cmd:${n}`, () => (execFileSync("sh", ["-c", `command -v ${n}`], { stdio: "ignore", timeout: 2_000 }), true)),
  hasPyModule: (m) => /^\w+$/.test(m) && probeOnce(`py:${m}`, () => (execFileSync("python3", ["-c", `import ${m}`], { stdio: "ignore", timeout: 4_000 }), true)),
  awkIntervals: () =>
    probeOnce("awk{n}", () => execFileSync("awk", ["BEGIN{print match(\"1.00\",/[0-9]{2}$/)}"], { timeout: 2_000 }).toString().trim() !== "0"),
};

// ---------------------------------------------------------------- the untouched tree

type Sig = { file: string; req: number; max: number; text: string };
export type Tree = { files: Set<string>; text: string; defs: Map<string, Sig[]>; hasGit: boolean };

const TREE_MAX_FILES = 400;
const TREE_MAX_BYTES = 200_000;
const SKIP_DIRS = new Set([".git", ".maat", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", "target"]);

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\") cur += s[++i] ?? "";
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** The module-level and nested `def`s of a python file with their positional arity. Methods are skipped. */
export function pythonDefs(src: string, file: string): Map<string, Sig[]> {
  const out = new Map<string, Sig[]>();
  for (const m of src.matchAll(/^[ \t]*(?:async\s+)?def\s+(\w+)\s*\(/gm)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let quote = "";
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i]!;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(" ) depth++;
      else if (ch === ")") depth--;
    }
    if (depth !== 0) continue;
    const params = splitTop(src.slice(start, i - 1));
    if (/^(self|cls)\b/.test(params[0] ?? "")) continue;
    let req = 0;
    let max = 0;
    let star = false;
    let kwOnly = false;
    for (const p of params) {
      if (p === "/") continue;
      if (p === "*") {
        kwOnly = true;
        continue;
      }
      if (p.startsWith("**")) {
        max = 99;
        continue;
      }
      if (p.startsWith("*")) {
        star = true;
        kwOnly = true;
        continue;
      }
      max += 1;
      if (!kwOnly && !p.includes("=")) req += 1;
    }
    if (star) max = 99;
    const sig: Sig = { file, req, max, text: `${m[1]}(${params.join(", ")})` };
    out.set(m[1]!, [...(out.get(m[1]!) ?? []), sig]);
  }
  return out;
}

export function readTree(cwd: string): Tree {
  const t: Tree = { files: new Set(), text: "", defs: new Map(), hasGit: existsSync(join(cwd, ".git")) };
  const bufs: string[] = [];
  let n = 0;
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 6 || n >= TREE_MAX_FILES) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (n >= TREE_MAX_FILES) return;
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs, r, depth + 1);
        continue;
      }
      n++;
      t.files.add(r);
      t.files.add(name);
      if (st.size > TREE_MAX_BYTES) continue;
      let body = "";
      try {
        body = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (body.includes("\0")) continue;
      bufs.push(body);
      if (name.endsWith(".py")) for (const [k, v] of pythonDefs(body, r)) t.defs.set(k, [...(t.defs.get(k) ?? []), ...v]);
    }
  };
  walk(cwd, "", 0);
  t.text = bufs.join("\n");
  return t;
}

// ---------------------------------------------------------------- helpers

/** Positional arguments in the text just after a call's `(`: top-level commas up to the closing paren. */
export function countArgs(call: string): number {
  let depth = 0;
  let n = 0;
  let seen = false;
  let quote = "";
  for (let i = 0; i < call.length; i++) {
    const ch = call[i]!;
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = "";
      seen = true;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) n++;
    else if (!/\s/.test(ch)) seen = true;
  }
  return seen ? n + 1 : 0;
}

const MISSABLE = ["python", "pip", "pip3", "pytest", "rg", "fd", "bat", "tree", "lsof", "netstat", "column", "perl", "ruby", "nc", "bc", "ss"];
const PY_MODULES = ["pytest", "numpy", "pandas", "requests", "yaml", "hypothesis", "flask"];

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Every rule the command breaks. Pure apart from the cheap probes in `ctx.probes`.
 */
export function lintAll(run: string, ctx: LintCtx): LintHit[] {
  const hits: LintHit[] = [];
  const add = (rule: string, why: string) => hits.push({ rule, why });
  const probes: Probes = { ...realProbes, ...ctx.probes };
  const cmd = run;
  const low = ctx.task.toLowerCase();
  const tree = ctx.tree ?? (ctx.cwd ? readTree(ctx.cwd) : undefined);
  const bash = ctx.shell === "bash";

  // L1 tool or module not installed
  if (/python3?\s+-m\s+pytest|\bpytest\b/.test(cmd) && !probes.hasPyModule("pytest") && !probes.hasCommand("pytest")) {
    add("L1-pytest", "pytest is not installed here (use `python3 -m unittest`, or run the script directly)");
  }
  const seenTools = new Set<string>();
  for (const m of cmd.matchAll(/(?:^|[;&|(]\s*)(?:time\s+)?([A-Za-z_][\w.-]*)(?=\s|$)/g)) {
    const w = m[1]!;
    if (seenTools.has(w) || !MISSABLE.includes(w) || w === "pytest") continue;
    seenTools.add(w);
    if (tree?.files.has(w)) continue;
    if (!probes.hasCommand(w)) add(`L1-${w}`, `\`${w}\` is not installed here`);
  }
  for (const mod of PY_MODULES) {
    if (mod === "pytest") continue;
    if (new RegExp(`(?:^|[^\\w.])(?:import|from)\\s+${mod}\\b|python3?\\s+-m\\s+${mod}\\b`).test(cmd) && !probes.hasPyModule(mod)) {
      add(`L1-module:${mod}`, `the python module ${mod} is not installed here`);
    }
  }
  // L2 git in a project with no repository (and a task that never mentions git)
  if (tree && !tree.hasGit && /(?:^|[;&|(]\s*|\s)git\s/.test(cmd) && !/\bgit\b|\brepo\b|\bcommit\b/.test(low)) {
    add("L2-git-norepo", "it runs git in a project that is not a git repository");
  }
  // L3 job control under sh; pkill -f matching the check's own command line
  if (!bash && /\bkill\s+%/.test(cmd)) add("L3-jobcontrol", "`kill %N` needs job control, which sh does not have");
  if (/(?:^|[;&|(]\s*)(?:fg|bg|jobs)\b/.test(cmd)) add("L3-jobcontrol", "`fg`/`bg`/`jobs` need an interactive shell");
  const pk = /pkill\s+-f\s+(['"]?)([^'"]+)\1/.exec(cmd);
  if (pk && pk[2]!.trim() && cmd.replace(pk[0], "").includes(pk[2]!.trim())) {
    add("L3-pkill-self", `\`pkill -f '${pk[2]!.trim()}'\` also matches the check's own shell and kills it`);
  }
  // L4 single-quoted substitution
  if (/'[^']*\$[({][^']*'/.test(cmd) && !/awk|sed|perl|python3? -c '/.test(cmd)) {
    add("L4-quoted-subst", "`$(…)` or `${…}` inside single quotes never expands");
  }
  // L5 grep with an unquoted multi-word pattern
  if (/grep(?:\s+-\S+)*\s+[A-Za-z]+(?:\s+[a-z]+){2,}\s*(?:$|[|;&)])/.test(cmd)) {
    add("L5-grep-unquoted", "a multi-word grep pattern is not quoted, so the extra words are taken as file names");
  }
  // L6 test -z on a quoted literal
  if (/test\s+-[zn]\s+"[a-z]+ [^$"]*"/.test(cmd)) add("L6-test-literal", "`test -z \"command words\"` tests the literal text, not the command's output");
  // L7 regex dialects
  if (/\bawk\b[^|;]*\\d/.test(cmd) || /\bgrep\s+(?:-[a-zA-Z]*\s+)*(?:-e\s+)?['"][^'"]*\\d/.test(cmd) || /\bgrep\s+-[a-zA-Z]*E[a-zA-Z]*[^|;]*\\d/.test(cmd)) {
    add("L7-backslash-d", "`\\d` is not a POSIX regex class in grep/awk (use [0-9])");
  }
  if (/\bawk\b[^|;]*\{\d+(?:,\d*)?\}/.test(cmd) && !probes.awkIntervals()) {
    add("L7-mawk-interval", "this awk (mawk) does not support {n} interval expressions");
  }
  for (const gm of cmd.matchAll(/\bgrep\s+((?:-\S+\s+)*)(['"])(.*?)\2/g)) {
    const flags = gm[1]!;
    const pat = gm[3]!;
    if (!/-\w*[EP]/.test(flags) && /(?<=[\w\])*.])(?<!\\)[+?]|(?<=[\w\]])(?<!\\)\{\d/.test(pat) && !pat.includes("\\|")) {
      add("L7-bre-plus", "`+`, `?` or `{n}` in a basic-regex grep is taken literally (use grep -E)");
      break;
    }
  }
  // L8 bashisms under sh
  if (!bash && /\[\[|\becho\s+-n\b|\btime\s+python|(?:^|[;&|(]\s*)source\s|\bdeclare\b|\blocal\s+-|<<</.test(cmd)) {
    add("L8-bashism", "it uses a bash-only construct, and checks run under sh");
  }
  // L9 what the bar refuses after the fact (evidence.ts): moved to seal time
  const sw = swallowsExit(cmd);
  if (sw) add("L9-swallows-exit", `it ends in \`${sw}\`, so it exits 0 whatever happened`);
  const piped = runnerPipedAway(cmd);
  if (piped) add("L9-pipe-no-pipefail", `\`${piped}\` feeds a pipe without pipefail, so its failure is lost`);
  // L11 absolute path outside the project
  const stray = strayPath(cmd, { cwd: ctx.cwd ?? "/nonexistent-project-root", task: ctx.task });
  if (stray) add("L11-abs", `it uses ${stray}, an absolute path outside the project (paths must be relative to the working directory)`);

  if (tree) {
    // L12 call to a project function with the wrong number of arguments
    const reported = new Set<string>();
    for (const [name, sigs] of tree.defs) {
      for (const cm of cmd.matchAll(new RegExp(String.raw`(?<![\w.])(?:\w+\.)?${name}\(`, "g"))) {
        const n = countArgs(cmd.slice((cm.index ?? 0) + cm[0].length));
        if (sigs.some((s) => n >= s.req && n <= s.max)) continue;
        if (reported.has(name)) break;
        reported.add(name);
        const s = sigs[0]!;
        add(`L12-arity:${name}(${n})`, `it calls ${name} with ${plural(n, "argument")}; ${s.file} defines ${s.text}`);
        break;
      }
    }
    // L13 a string literal passed to a project function that is nowhere in the task or the tree
    if (!/Error|raise|except|-q 'Traceback/.test(cmd)) {
      outer: for (const name of tree.defs.keys()) {
        for (const cm of cmd.matchAll(new RegExp(String.raw`(?<![\w.])(?:\w+\.)?${name}\(([^)]*)\)`, "g"))) {
          for (const sm of cm[1]!.matchAll(/['"]([^'"]{1,40})['"]/g)) {
            const lit = sm[1]!;
            if (lit.trim() && !ctx.task.includes(lit) && !tree.text.includes(lit)) {
              add(`L13-input:${lit}`, `it passes "${lit}" to ${name}, a value that appears nowhere in the task or the project`);
              break outer;
            }
          }
        }
      }
    }
  }
  // L15 the check changes the work it judges (src/checkwrites.ts). No task
  // wording excuses it: "merge them into master" is what the WORK must do, and
  // a check that does the merge passes on its own effort.
  const writes = checkMutates(cmd);
  if (writes) add("L15-mutates", writes);
  const never = cannotFail(cmd);
  if (never && !sw) add("L16-cannot-fail", never);
  return hits;
}

/** Mask quoted text so operators inside strings are not read as the shell's. */
function maskQuotes(s: string): string {
  return s.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (m) => "_".repeat(m.length));
}

/**
 * Why this command exits 0 whatever happens, or null. Read off the command
 * alone, before anything runs:
 *  - its last top-level step is `|| echo …`/`|| printf …`, or it ends in
 *    `|| true`, `|| :`, `|| exit 0`, `; true`, `; exit 0` (evidence.ts);
 *  - it ends in `find … -exec … \;` (or `';'`): find's own status ignores
 *    what -exec ran, so `-exec sh -c '… exit 1' \;` reports nothing;
 *  - it prints a literal PASS/FAIL verdict (`print('PASS' if … else 'FAIL')`,
 *    `echo FAIL`) and nothing in it exits non-zero, asserts or raises.
 */
export function cannotFail(run: string): string | null {
  const cmd = run.trim();
  const masked = maskQuotes(cmd);
  const sw = swallowsExit(cmd);
  if (sw) return `it ends in \`${sw}\`, so it exits 0 whatever happened`;
  const echoTail = /\|\|\s*(?:echo|printf)\b[^|;&]*$/.exec(masked);
  if (echoTail) return `it ends in \`${cmd.slice(echoTail.index).trim()}\`, so a failure prints a word and still exits 0`;
  const find = /(?:^|[;&|(]\s*)find\s[^|;]*-exec(?:dir)?\s/.exec(masked);
  if (find) {
    const rest = cmd.slice(find.index);
    const end = /(?:\\;|';'|";")/.exec(rest);
    const after = end ? maskQuotes(rest.slice(end.index + end[0].length)).trim() : "";
    // Only when nothing after the find reads its output: `find … | grep -q .` is fine.
    if (end && !/^\|(?!\|)/.test(after) && !/^[;&|]*\s*\S/.test(after.replace(/^&&\s*(?:echo|printf|true|:)\b.*$/, ""))) {
      return "it ends in `find … -exec … \\;`, whose exit status ignores what -exec ran, so it passes whatever the files hold";
    }
  }
  if (/\bFAIL(?:ED)?\b/.test(cmd) && /\bPASS(?:ED)?\b/.test(cmd) && !/\bexit\s*\(?\s*[1-9]|sys\.exit|\bassert\b|\braise\b|process\.exit|\bfalse\b/.test(cmd)) {
    return "it prints PASS or FAIL but always exits 0, and only the exit status is read";
  }
  return null;
}

/** The first rule broken, or null. */
export function lintCheck(run: string, ctx: LintCtx): LintHit | null {
  return lintAll(run, ctx)[0] ?? null;
}

