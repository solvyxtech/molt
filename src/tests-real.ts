/**
 * Tests that prove only their own premise.
 *
 * `mutation` breaks a changed line and asks whether the suite notices. It says
 * nothing about a test that could never notice anything, and `spec-intact`
 * only looks at what was taken away. Three shapes get past both, each a green
 * row that establishes nothing:
 *
 *  - **A tautology.** `assert.equal(f(x), f(x))`, `expect(a).toBe(a)`: the
 *    value compared against itself. It passes whatever `f` does, so it passes
 *    on the broken code as well as the fixed one — red-before-green can never
 *    happen, and a mutant in `f` survives it. When `f` is the only caller of
 *    the changed line, `mutation` sees the line "covered" and a test "run".
 *  - **A test with no assertion.** `it("handles the empty case", () => {
 *    parse(""); })`. It executes the line, which is all `diff-covered` asks,
 *    and it fails only if the code throws.
 *  - **A new test file that never touches the change.** The turn edits
 *    `src/parse.ts` and adds `test/parse.test.ts`, which imports nothing from
 *    it. The suite grows, stays green, and says nothing about the work.
 *
 * Every rule is textual and deliberately conservative. A false positive
 * refuses correct work, which is worse than a miss the other checks may still
 * catch, so:
 *
 *  - only what this turn added is judged. A tautology or an assertion-free
 *    test that was already in the file is somebody else's decision.
 *  - a test counts as asserting if it calls a helper, defined in the same
 *    file, that asserts — or any function whose name starts `assert`,
 *    `expect`, `verify`, `check`, `must` or `should` — or throws. A helper
 *    imported from elsewhere is given the benefit of the doubt by its name.
 *  - `it.todo`, `it.skip`, `xit` and a test with no callback are not judged.
 *  - a new test file is linked to the change if it imports a changed source
 *    by any relative path (`.js` meaning `.ts`, extensionless, `index`), or
 *    names one as a path — so a test that spawns `dist/cli.js` to exercise
 *    `src/cli.ts` counts. A turn that changed no code has no change to link to.
 *  - JavaScript and TypeScript only. Other languages are not read, and the
 *    report says a file was not examined rather than that it passed.
 */
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";

export type TestFinding = {
  path: string;
  kind: "tautology" | "assertion-free" | "unlinked-file";
  /** The test's name, or the assertion, or the file — whatever names it. */
  what: string;
  /** 1-indexed line in the file as it now stands, where known. */
  line?: number;
};

const JS_TEST = /\.[cm]?[jt]sx?$/;
const CODE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs)$/;

/** A test file path, by the same convention `spec-intact` uses. */
function isTestFile(path: string): boolean {
  return /(^|\/)tests?\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

// ---------------------------------------------------------------------------
// A scanner that knows where strings, comments and regex literals are, so a
// `)` inside `"("` or `/\(/` does not end a call.

/** Index just past the bracket that closes the one at `open`, or -1. */
export function closeOf(src: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  let lastSig = "";
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? src.length : e;
      continue;
    }
    if (c === "/" && n === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? src.length : e + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      lastSig = "a";
      continue;
    }
    if (c === "/" && (lastSig === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig))) {
      // A regex literal: `/` where a value is expected.
      let j = i + 1;
      let inClass = false;
      for (; j < src.length && src[j] !== "\n"; j++) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
      }
      i = j;
      lastSig = "a";
      continue;
    }
    if (c in pairs) stack.push(pairs[c]!);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
    if (!/\s/.test(c)) lastSig = /[\w$]/.test(c) ? "a" : c;
  }
  return -1;
}

function skipString(src: string, i: number): number {
  const q = src[i]!;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]!;
    if (c === "\\") {
      j++;
      continue;
    }
    if (q === "`" && c === "$" && src[j + 1] === "{") {
      const e = closeOf(src, j + 1);
      if (e < 0) return src.length;
      j = e - 1;
      continue;
    }
    if (c === q) return j;
    if (q !== "`" && c === "\n") return j;
  }
  return src.length;
}

/** Top-level comma-separated arguments of the call whose `(` is at `open`. */
function argsOf(src: string, open: number): string[] | null {
  const end = closeOf(src, open);
  if (end < 0) return null;
  const inner = src.slice(open + 1, end - 1);
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === "(" || c === "[" || c === "{") {
      const e = closeOf(inner, i);
      if (e < 0) return null;
      i = e - 1;
    } else if (c === '"' || c === "'" || c === "`") {
      i = skipString(inner, i);
    } else if (c === ",") {
      out.push(inner.slice(at, i));
      at = i + 1;
    }
  }
  out.push(inner.slice(at));
  return out.map((a) => a.trim()).filter((a, i, all) => a !== "" || i < all.length - 1);
}

const lineAt = (src: string, index: number) => src.slice(0, index).split("\n").length;
const norm = (s: string) => s.replace(/\s+/g, "").replace(/,$/, "");

/**
 * The source with every comment, regex literal and string's contents blanked
 * to spaces, lengths and newlines kept, so an index into one is an index into
 * the other.
 *
 * Test files are full of code held in strings — fixtures, expected output,
 * a whole `it(…)` written out as a payload for the parser under test. Read
 * unmasked, each of those is a test with no assertion and every
 * `assert.equal(x, x)` in a fixture is a tautology; this repository's own
 * suite for this module is exactly that.
 */
export function mask(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let lastSig = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const e = src.indexOf("\n", i);
      blank(i, e < 0 ? src.length : e);
      i = e < 0 ? src.length : e;
      continue;
    }
    if (c === "/" && n === "*") {
      const e = src.indexOf("*/", i + 2);
      blank(i, e < 0 ? src.length : e + 2);
      i = e < 0 ? src.length : e + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const e = skipString(src, i);
      blank(i + 1, e);
      i = e;
      lastSig = "a";
      continue;
    }
    if (c === "/" && (lastSig === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig))) {
      let j = i + 1;
      let inClass = false;
      for (; j < src.length && src[j] !== "\n"; j++) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
      }
      blank(i, j + 1);
      i = j;
      lastSig = "a";
      continue;
    }
    if (!/\s/.test(c)) lastSig = /[\w$]/.test(c) ? "a" : c;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------

/** Assertions that compare a value with itself, keyed by normalised text. */
export function tautologiesIn(src: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const code = mask(src);
  const assertCall =
    /\b(?:assert|t|chai\.assert)\.(?:equal|strictEqual|deepEqual|deepStrictEqual|is|same|deepEquals?)\s*\(/g;
  for (let m: RegExpExecArray | null; (m = assertCall.exec(code)); ) {
    const open = m.index + m[0].length - 1;
    const args = argsOf(src, open);
    if (args && args.length >= 2 && args[0] && norm(args[0]) === norm(args[1]!)) {
      out.push({ text: norm(src.slice(m.index, closeOf(src, open))), line: lineAt(src, m.index) });
    }
  }
  const expectCall = /\bexpect\s*\(/g;
  for (let m: RegExpExecArray | null; (m = expectCall.exec(code)); ) {
    const open = m.index + m[0].length - 1;
    const end = closeOf(src, open);
    if (end < 0) continue;
    const matcher = /^\s*\.(?:not\s*\.)?(toBe|toEqual|toStrictEqual)\s*\(/.exec(src.slice(end));
    if (!matcher || /\.not\s*\./.test(matcher[0])) continue;
    const mOpen = end + matcher[0].length - 1;
    const actual = argsOf(src, open);
    const expected = argsOf(src, mOpen);
    if (actual?.length === 1 && expected?.length === 1 && actual[0] && norm(actual[0]) === norm(expected[0]!)) {
      out.push({ text: norm(src.slice(m.index, closeOf(src, mOpen))), line: lineAt(src, m.index) });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** `body` is the masked text of the call's arguments after the name: code only. */
export type TestBlock = { name: string; body: string; line: number; judged: boolean };

/** Every `it(…)` / `test(…)` in a JS/TS file — in its code, not in its strings. */
export function testBlocksIn(src: string): TestBlock[] {
  const out: TestBlock[] = [];
  const code = mask(src);
  const re = /(^|[^\w$.])(x?it|test)((?:\.(?:only|skip|todo|concurrent|each\b[^(]*))*)\s*\(\s*(["'`])/g;
  for (let m: RegExpExecArray | null; (m = re.exec(code)); ) {
    const open = code.indexOf("(", m.index + m[1]!.length);
    const quote = open + code.slice(open).indexOf(m[4]!);
    const nameEnd = skipString(src, quote);
    const name = src.slice(quote + 1, nameEnd);
    const end = closeOf(src, open);
    if (end < 0) continue;
    const body = code.slice(nameEnd + 1, end - 1);
    const modifiers = m[3] ?? "";
    // No callback, or one that says it is not a test yet.
    const judged =
      (m[2] === "it" || m[2] === "test") &&
      !/\.(?:skip|todo|each)/.test(modifiers) &&
      /=>|function\b/.test(body) &&
      !/\b(?:skip|todo)\s*:\s*(?:true|["'`])/.test(body);
    out.push({ name, body, line: lineAt(src, m.index + m[1]!.length), judged });
  }
  return out;
}

const ASSERTS = new RegExp(
  [
    String.raw`\bassert\b`,
    String.raw`\bexpect\s*[(.]`,
    String.raw`\.should\b`,
    // tape, ava, node:test's t.assert, tap
    String.raw`\bt\.(?:ok|notOk|equals?|notEqual|strictEqual|notStrictEqual|deepEqual|deepStrictEqual|notDeepEqual|looseEqual|is|isNot|not|same|notSame|throws|doesNotThrow|rejects|resolves|assert|true|false|truthy|falsy|match|notMatch|fail|pass|plan|snapshot|regex|error|ifError)\b`,
    String.raw`\.(?:rejects|resolves)\b`,
    String.raw`\bthrow\b`,
    String.raw`\bfail\s*\(`,
    // A helper named for what it does: `assertParses(…)`, `util.assertEqual<A, B>(…)`.
    String.raw`\b(?:assert|expect|verify|check|must|should)\w*\s*[<(]`,
  ].join("|"),
  "i",
);
const ASSERTING_NAME = /^(?:assert|expect|verify|check|must|should)/i;

/** Names of functions in this file whose bodies assert, directly or a few calls down. */
function assertingHelpers(src: string): Set<string> {
  const defs = new Map<string, string>();
  // `function name(` and `const name = [async] function (` — the body is the
  // first brace after the parameter list closes, not the first brace after
  // the name: a parameter typed `{ stdout: … }` would be read as the body.
  const fn = /\bfunction\s*\*?\s*([\w$]+)?\s*(?:<[^>()]*>)?\s*\(/g;
  for (let m: RegExpExecArray | null; (m = fn.exec(src)); ) {
    const name =
      m[1] ?? /(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?$/.exec(src.slice(Math.max(0, m.index - 80), m.index))?.[1];
    if (!name) continue;
    const pEnd = closeOf(src, m.index + m[0].length - 1);
    if (pEnd < 0) continue;
    const brace = src.indexOf("{", pEnd);
    if (brace < 0) continue;
    const end = closeOf(src, brace);
    defs.set(name, src.slice(brace, end < 0 ? src.length : end));
  }
  // `const name = [async] (…) => …`
  const arrow = /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(\(|[\w$]+\s*=>)/g;
  for (let m: RegExpExecArray | null; (m = arrow.exec(src)); ) {
    let at = m.index + m[0].length;
    if (m[2] === "(") {
      const pEnd = closeOf(src, at - 1);
      if (pEnd < 0) continue;
      const rest = /^\s*(?::[^=]*?)?=>\s*/.exec(src.slice(pEnd));
      if (!rest) continue; // a call, not an arrow
      at = pEnd + rest[0].length;
    } else {
      at += /^\s*/.exec(src.slice(at))![0].length;
    }
    if (src[at] === "{") {
      const end = closeOf(src, at);
      defs.set(m[1]!, src.slice(at, end < 0 ? src.length : end));
    } else {
      const semi = src.indexOf(";", at);
      defs.set(m[1]!, src.slice(at, semi < 0 ? Math.min(src.length, at + 400) : semi));
    }
  }
  const asserting = new Set<string>();
  for (let round = 0; round < 3; round++) {
    for (const [name, body] of defs) {
      if (asserting.has(name)) continue;
      if (ASSERTS.test(body) || callsOneOf(body, asserting)) asserting.add(name);
    }
  }
  return asserting;
}

function callsOneOf(body: string, names: Set<string>): boolean {
  for (const m of body.matchAll(/([\w$]+)\s*(?:<[^>()]*>)?\s*\(/g)) {
    if (names.has(m[1]!) || ASSERTING_NAME.test(m[1]!)) return true;
  }
  return false;
}

/** Changed code this test file should reach, resolved from its imports and path mentions. */
function linksTo(testPath: string, src: string, sources: string[]): boolean {
  const dir = posix.dirname(testPath);
  const want = new Set(sources);
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)) {
    const spec = m[1]!;
    if (!spec.startsWith(".")) continue;
    const base = posix.normalize(posix.join(dir, spec));
    const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
    for (const cand of [
      base,
      `${stem}.ts`,
      `${stem}.tsx`,
      `${stem}.js`,
      `${stem}.mjs`,
      `${stem}.cjs`,
      `${stem}.jsx`,
      `${stem}.mts`,
      `${stem}.cts`,
      `${base}/index.ts`,
      `${base}/index.js`,
    ]) {
      if (want.has(cand)) return true;
    }
  }
  // Named as a path: a test that runs `dist/cli.js` or reads `src/cli.ts`.
  for (const s of sources) {
    const stem = posix.basename(s).replace(/\.[^.]+$/, "");
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`[/"'\`]${esc}(?:\\.[\\w]+)?["'\`]|/${esc}\\.[\\w]+`).test(src)) return true;
  }
  return false;
}

/**
 * What this turn added to one test file that proves nothing.
 *
 * `before` is the file when the turn began, or null if the turn created it.
 * `sources` are the non-test code files the turn changed, project-relative.
 */
export function selfProvingTests(
  path: string,
  before: string | null,
  after: string,
  sources: readonly string[],
): TestFinding[] {
  if (!JS_TEST.test(path)) return [];
  const out: TestFinding[] = [];

  const had = new Map<string, number>();
  for (const t of before === null ? [] : tautologiesIn(before)) had.set(t.text, (had.get(t.text) ?? 0) + 1);
  for (const t of tautologiesIn(after)) {
    const n = had.get(t.text) ?? 0;
    if (n > 0) {
      had.set(t.text, n - 1);
      continue;
    }
    out.push({ path, kind: "tautology", what: t.text, line: t.line });
  }

  const oldNames = new Set(before === null ? [] : testBlocksIn(before).map((b) => b.name));
  const helpers = assertingHelpers(mask(after));
  for (const b of testBlocksIn(after)) {
    if (!b.judged || oldNames.has(b.name)) continue;
    if (ASSERTS.test(b.body) || callsOneOf(b.body, helpers)) continue;
    out.push({ path, kind: "assertion-free", what: b.name, line: b.line });
  }

  const code = sources.filter((s) => CODE.test(s) && !isTestFile(s));
  if (before === null && code.length > 0 && testBlocksIn(after).length > 0 && !linksTo(path, after, code)) {
    out.push({ path, kind: "unlinked-file", what: path });
  }
  return out;
}

/** The narrow slice of a bar context this check reads. */
export type TestsRealInput = {
  cwd: string;
  /** Paths this turn wrote. */
  written: readonly string[];
  /**
   * A test file's text when the turn began: a string, null if it did not
   * exist, undefined if nobody knows (no snapshot, or it was too large).
   */
  before: (path: string) => string | null | undefined;
};

/** The whole check, over every test file the turn wrote. */
export function testsReal(input: TestsRealInput): {
  ok: boolean;
  output: string;
  established?: boolean;
} {
  const written = [...new Set(input.written)];
  const tests = written.filter(isTestFile);
  const sources = written.filter((p) => !isTestFile(p));
  if (tests.length === 0) {
    return { ok: true, established: false, output: "no test file was written this turn" };
  }
  const findings: TestFinding[] = [];
  const unread: string[] = [];
  let examined = 0;
  for (const path of tests) {
    const was = input.before(path);
    let now: string;
    try {
      now = readFileSync(resolve(input.cwd, path), "utf8");
    } catch {
      continue; // gone: `files-changed` names that.
    }
    if (was === undefined || !JS_TEST.test(path)) {
      unread.push(path);
      continue;
    }
    examined++;
    findings.push(...selfProvingTests(path, was, now, sources));
  }
  const tail = unread.length ? ` · ${unread.length} not examined: ${unread.slice(0, 6).join(", ")}` : "";
  if (findings.length === 0) {
    return {
      ok: true,
      established: examined > 0,
      output:
        examined > 0
          ? `${examined} test file(s) written this turn; every added test asserts something that can fail${tail}`
          : `no test file this turn could be examined${tail}`,
    };
  }
  const say: Record<TestFinding["kind"], string> = {
    tautology: "compares a value with itself, so it passes whatever the code does",
    "assertion-free": "asserts nothing, so it fails only if the code throws",
    "unlinked-file": `imports none of the code this turn changed (${sources.filter((s) => CODE.test(s)).slice(0, 4).join(", ")})`,
  };
  const lines = findings.slice(0, 12).map((f) => {
    const at = f.line ? `${f.path}:${f.line}` : f.path;
    const what = f.kind === "unlinked-file" ? "" : f.kind === "tautology" ? ` \`${f.what.slice(0, 100)}\`` : ` "${f.what}"`;
    return `  ${at}${what} — ${say[f.kind]}`;
  });
  return {
    ok: false,
    output:
      `${findings.length} test(s) added this turn prove nothing about the change:\n` +
      lines.join("\n") +
      (findings.length > 12 ? `\n  … and ${findings.length - 12} more` : "") +
      tail +
      "\n\nA test that cannot fail on broken code is not evidence the code works. Assert the " +
      "value the code should produce, written out, against what the code returns — or, if a " +
      "test exists only to execute a path, say so and remove it.",
  };
}

/** What `testsRealFor` reads off a bar context. Structural, so bar.ts need not change shape. */
export type TestsRealContext = {
  cwd: string;
  ledger: readonly { path: string }[];
  turnLedger?: readonly { path: string }[];
  treeBefore?: {
    truncated: boolean;
    files: ReadonlyMap<string, string>;
    testTexts?: ReadonlyMap<string, string>;
  };
};

/**
 * The check as a bar builtin runs it: this turn's writes, judged against the
 * test files as the turn-start snapshot held them. A file the snapshot did not
 * hash did not exist; one it hashed without keeping the text is unknown, and
 * is reported as not examined rather than passed.
 */
export function testsRealFor(ctx: TestsRealContext) {
  const snap = ctx.treeBefore;
  return testsReal({
    cwd: ctx.cwd,
    written: (ctx.turnLedger ?? ctx.ledger).map((e) => e.path),
    before: (p) => {
      if (!snap || snap.truncated) return undefined;
      const text = snap.testTexts?.get(p);
      if (text !== undefined) return text;
      return snap.files.has(p) ? undefined : null;
    },
  });
}
