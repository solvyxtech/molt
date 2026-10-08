/**
 * What kind of evidence a passing check is, and when that earns "verified".
 *
 * Measured over Mercury, Nemotron and Qwen runs, the word "verified" was right
 * 20-88% of the time depending on the model. Claims backed by a check that RAN
 * the deliverable and ASSERTED a value, with no reviewer contradiction and a
 * model that said done, were 7/7 right; everything else was right 28/50. A
 * word that means one thing on one model and another on the next is not a
 * label, so it is earned by the evidence, mechanically, the same way on every
 * model.
 *
 * Three classes, strongest last:
 *   surface  the critic read the check as only looking (`surface` tag)
 *   runs     it runs the deliverable (the critic did not mark it surface)
 *   value    its command asserts a concrete expected value (`value` tag)
 * "verified" needs a passing check that is runs AND value.
 */
import type { CheckAuthor, CheckResult } from "./types.js";
import { env } from "./env.js";

/** An operand that is a literal: a number, a quoted string without a variable in it (or a `$'...'` ANSI-C string), a list/dict opener, or a keyword value. */
const LIT_AFTER = /^(?:\\?["'](?![^"']*\$)[^"']|\$'[^']|-?\d|[[{]|(?:True|False|None|true|false|null)\b)/;
/** The operand just before an operator, when it is wholly a literal and not the tail of a name like `x2`. */
const LIT_BEFORE = /(?:(?<![\w.$)\]])-?\d+(?:\.\d+)?|\\?"[^"$]*\\?"|'[^']*')\s*$/;
/** A number that stands alone (`42`, `3.5`), not the 3 in `python3` or `x2`. */
const STANDALONE_NUMBER = /(?<![\w.])\d+(?:\.\d+)?(?!\w)/;
const LIT_ARG = String.raw`(?:-?\d|\\?["'](?![^"']*\$)|[[{])`;
/** An equality helper whose first or last argument is a literal: `assertEqual(f(2), 4)`, `a.strictEqual(x, "ok")`. */
const ASSERT_EQUAL = new RegExp(
  String.raw`(?:\bassert_?[Ee]qual|\bassert_eq|\.(?:deep|strict|deepStrict)?[Ee]qual)\w*\s*\((?:[^\n]*,\s*${LIT_ARG}[^,()]*\)|\s*${LIT_ARG}[^()]*,)`,
);

/** True when the operator at `at` in `s` has a literal on either side. */
function literalAround(s: string, at: number, len: number): boolean {
  const after = s.slice(at + len, at + len + 60).trimStart();
  const before = s.slice(Math.max(0, at - 60), at);
  return LIT_AFTER.test(after) || LIT_BEFORE.test(before);
}

/** A short-flag cluster (`-q`, `-qx`, `-Eq`) that holds one of `letters`; long options never match. */
function hasFlag(flags: string[], letters: string): boolean {
  return flags.some((f) => /^-[A-Za-z]+$/.test(f) && [...letters].some((l) => f.includes(l)));
}

/**
 * Does this command assert a concrete expected value?
 *
 * The rule, exactly. True when any of these holds:
 *  1. `==`, `!=`, `-eq`, `-ne`, or a single `=` inside a `[ ]`/`[[ ]]`/`test`
 *     comparison, with a literal on either side: a number, a quoted string
 *     with no `$` in it, a list/dict opener, or true/false/null/None. `[ "$a"
 *     = "$b" ]` and `assert x == y` compare two unknowns and do not count; an
 *     `assert` counts through this rule, when it compares to a literal.
 *  2. `assertEqual`/`assert_equal`/`assert_eq`/`assert.(deep|strict)Equal`
 *     handed a literal argument.
 *  3. `diff` or `cmp` against an expected file (a name with expect, golden,
 *     want, answer, baseline or correct in it) or against a heredoc, here
 *     string or `<(...)` written in the command. `diff out.txt in.txt` does
 *     not count: two files are not a value. With `goldenPredates` (the
 *     tier's pre-work record), each expected-file operand must also have
 *     existed before the work, unchanged since: otherwise the worker could
 *     have written it.
 *  4. `grep` with `-q` or `-x` whose pattern is a literal holding a
 *     standalone number, a whole expected line (`-x`), or anchored at both
 *     ends (`^...$`). `grep -q "def main"` does not count.
 *  5. A behavioural assertion: the deliverable is called or run on literal
 *     input and the outcome is asserted (`assertsBehaviour`), by
 *     a. `is None` / `is not None` on a call into the deliverable with a
 *        literal argument (rule 1 already takes `== None`), or a literal
 *        `in` / `not in` the result of such a call, under `assert`,
 *        `sys.exit(0 if ... else 1)` or `if ...: sys.exit(1)`.
 *     b. a specific exception: `try: f('<literal>')` / `except KeyError:`
 *        where only the path without the exception exits non-zero, or
 *        `pytest.raises(E)` / `assertRaises(E, ...)` / `assert.throws(...)`
 *        around a call with a literal argument. `except Exception` does not
 *        count, nor a handler that only prints.
 *     c. `grep` (plain, `-q`, `-x`; never `-v`, `-c`, `-l`) of a literal at
 *        the end of a pipeline that runs a program (python3, node, bash, sh,
 *        make, curl, `./tool`, `tool.py`, ...): `python3 slugify.py <<< '!!'
 *        | grep -q untitled`. A pipeline that only reads a file or git
 *        (`head -1 out.csv | grep -q id,name`, `git log | grep -q msg`) does
 *        not count: that is the shape of an output, not its behaviour.
 *     Structural checks (exists, `isinstance`, `hasattr`, `len(...) > 0`,
 *     non-empty), the truthiness of an arbitrary call, and timing bounds
 *     (`time.time() - t < 5`, `timeout 5`) never count. A specific exit code
 *     with literal stdin already counts through rule 1 (`[ $? -eq 2 ]`).
 *
 *     Not widened: a pattern the work wrote, tried on strings the check
 *     chose (`re.search(p, '10.0.0.1 2024-01-05')`, `p = re.compile(open(
 *     'regex.txt').read())`). Replayed over 2026-10-07's lanes, every run
 *     such a check alone would have verified was a regex task, and 4 of 7
 *     were grader failures: the judges' example lines all missed the case the
 *     grader tried (`x 1.2.3.4.5 on 2024-01-05`). A command that does this
 *     gets none of rule 5, and rule 1 reads its `[ ... = ... ]` as before
 *     (bench/local/value_replay.py).
 * Conservative on purpose: a check missed here costs one claim the word
 * "verified"; a check counted wrongly costs the word its meaning.
 */
/** A diff/cmp operand named like an expected file: what rule 3 trusts as "the value". */
const GOLDEN_NAME = /(?:^|[\s/'"])[\w.-]*(?:expect|golden|want|answer|baseline|correct)/i;

/**
 * The operands of `diff`/`cmp` in `run` that are named like an expected file
 * (rule 3 of assertsValue), unquoted. A golden file only stands for a value
 * when it predates the work: a worker that writes both `out.txt` and
 * `expected.txt` makes `diff out.txt expected.txt` pass on anything.
 */
export function goldenOperands(run: string): string[] {
  const out: string[] = [];
  for (const m of run.matchAll(/\b(?:diff|cmp)\b([^\n|;&]*)/g)) {
    const words: string[] = (m[1] ?? "").match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? [];
    for (const w of words) {
      if (w.startsWith("-") || w.startsWith("<")) continue;
      const bare = w.replace(/^(["'])(.*)\1$/s, "$2");
      if (GOLDEN_NAME.test(` ${bare}`)) out.push(bare);
    }
  }
  return out;
}

// ---------------------------------------------------------------- rule 5: behavioural assertions

/**
 * The shell nesting depth before each character of `s`: 0 at top level, more
 * inside quotes, `$(...)`, `(...)` and backticks. A heuristic scanner, not a
 * shell parser: it only has to tell `a; b` from `"$(x; y)"`.
 */
function shellDepths(s: string): number[] {
  const out: number[] = new Array(s.length);
  const stack: string[] = [];
  for (let i = 0; i < s.length; i++) {
    out[i] = stack.length;
    const ch = s[i]!;
    const top = stack[stack.length - 1];
    if (top === "'") {
      if (ch === "'") stack.pop();
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < s.length) out[i + 1] = stack.length;
      i++;
      continue;
    }
    if (top === "$'") {
      if (ch === "'") stack.pop();
      continue;
    }
    if (top === '"') {
      if (ch === '"') stack.pop();
      else if (ch === "$" && s[i + 1] === "(") (stack.push("("), (out[i + 1] = stack.length - 1), i++);
      else if (ch === "`") stack.push("`");
      continue;
    }
    if (top === "`" && ch === "`") {
      stack.pop();
      continue;
    }
    if (ch === "'") stack.push(s[i - 1] === "$" ? "$'" : "'");
    else if (ch === '"') stack.push('"');
    else if (ch === "`") stack.push("`");
    else if (ch === "(") stack.push("(");
    else if (ch === ")" && top === "(") stack.pop();
  }
  return out;
}

/** Top-level command segments of `s` (split on `;`, newline, `&&`, `||` outside quotes and substitutions), as [start, end). */
function shellSegments(s: string): [number, number][] {
  const d = shellDepths(s);
  const out: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (d[i] !== 0) continue;
    const two = s.slice(i, i + 2);
    const sep = two === "&&" || two === "||" ? 2 : s[i] === ";" || s[i] === "\n" ? 1 : 0;
    if (!sep) continue;
    out.push([start, i]);
    start = i + sep;
    i += sep - 1;
  }
  out.push([start, s.length]);
  return out;
}

/** Asks what type or shape a thing has: `type(x).__name__`, `isinstance`, `hasattr`, `callable`. */
const TYPE_PROBE = /\btype\([^()]*(?:\([^()]*\)[^()]*)*\)\.__name__|\.__class__|\b(?:isinstance|issubclass|hasattr|callable)\(/;
const BRACKET = /(?:^|\s)(?:\[\[?|test)\s/;
/** A whole shell word that is a literal: a non-empty quoted string with no expansion in it, `$'...'`, a number, or a keyword value. */
const SHELL_LITERAL = /^(?:"[^"$`]+"|'[^']+'|\$'(?:[^'\\]|\\.)+'|-?\d+(?:\.\d+)?|true|false|null|True|False|None)$/;

/** The shell word ending just before `at` (or starting just after `at + len`), quotes and substitutions kept whole. */
function shellWordAround(s: string, d: number[], at: number, len: number): [string, string] {
  let i = at - 1;
  while (i >= 0 && /\s/.test(s[i]!) && d[i] === 0) i--;
  let a = i;
  while (a >= 0 && !(d[a] === 0 && /\s/.test(s[a]!))) a--;
  let j = at + len;
  while (j < s.length && /\s/.test(s[j]!) && d[j] === 0) j++;
  let b = j;
  while (b < s.length && !(d[b] === 0 && /\s/.test(s[b]!))) b++;
  return [s.slice(a + 1, i + 1), s.slice(j, b)];
}

/** A top-level `=` inside `[ ]`/`[[ ]]`/`test`, with a literal shell word on either side. */
function bracketLiteral(s: string, at: number): boolean {
  const d = shellDepths(s);
  if (d[at] !== 0) return false;
  const seg = shellSegments(s).find(([a, b]) => a <= at && at <= b);
  if (!seg || !BRACKET.test(s.slice(seg[0], at))) return false;
  const [left, right] = shellWordAround(s, d, at, 1);
  return SHELL_LITERAL.test(left) || SHELL_LITERAL.test(right);
}

/** The stages of one top-level command split on `|` (never `||`). */
function pipeStages(cmd: string): string[] {
  const d = shellDepths(cmd);
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < cmd.length; i++) {
    if (d[i] === 0 && cmd[i] === "|" && cmd[i + 1] !== "|" && cmd[i - 1] !== "|" && cmd[i - 1] !== ">") {
      out.push(cmd.slice(start, i));
      start = i + 1;
    }
  }
  out.push(cmd.slice(start));
  return out;
}

/** The program a pipeline stage runs: leading `!`, `VAR=x`, `timeout 5`, `env`, `time` taken off. */
function stageProgram(stage: string): string {
  let t = stage.trim();
  for (;;) {
    const n = t.replace(/^(?:!\s*|\w+=\S*\s+|(?:env|time|nice|exec|command)\s+|timeout\s+(?:-\S+\s+)*\S+\s+)/, "");
    if (n === t) break;
    t = n;
  }
  return t.split(/\s+/)[0] ?? "";
}

/** A program that runs something: an interpreter, a build tool, a client of a server the work runs, or a script by path. */
const RUNNER = /^(?:python[\d.]*|node|bash|sh|zsh|dash|ruby|perl|php|deno|bun|npx|npm|make|gmake|java|go|cargo|sqlite3|curl|\.{1,2}\/\S+|\S+\.(?:py|js|mjs|cjs|ts|sh|rb|pl))$/;

/** Rule 5c: `<runs something> | ... | grep [-q] '<literal>'`. */
function grepsRunOutput(run: string): boolean {
  for (const [a, b] of shellSegments(run)) {
    const seg = run.slice(a, b).trim();
    // `! prog | grep -q X`, `prog | grep -q X && exit 1`, `if prog | grep -q X; then exit 1`:
    // the check passes when the text is ABSENT, which wrong output (nothing at all) also is.
    if (seg.startsWith("!") || /^\s*&&\s*(?:exit\s+[1-9]|false\b)/.test(run.slice(b)) || (/^if\b/.test(seg) && /^\s*;?\s*then\s+(?:exit\s+[1-9]|false\b)/.test(run.slice(b)))) continue;
    const stages = pipeStages(run.slice(a, b).replace(/^\s*if\s+/, ""));
    if (stages.length < 2) continue;
    const last = stages[stages.length - 1]!.trim();
    const words: string[] = last.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? [];
    if (!/^[ef]?grep$/.test(words[0] ?? "")) continue;
    const args = words.slice(1);
    const flags = args.filter((w) => w.startsWith("-"));
    if (hasFlag(flags, "vcLl") || flags.some((f) => /^--(?:invert|count|files)/.test(f))) continue;
    const e = args.indexOf("-e");
    const pat = e >= 0 ? args[e + 1] : args.find((w) => !w.startsWith("-"));
    if (!pat || pat.startsWith(">") || pat.startsWith("<")) continue;
    const body = pat.replace(/^(["'])(.*)\1$/s, "$2");
    // A pattern of a letter or two matches nearly any text, and `a|b` under -E passes on either outcome.
    if (/\$[\w{(]/.test(body) || (body.match(/\w/g) ?? []).length < 4) continue;
    if ((words[0] === "egrep" || hasFlag(flags, "E") || flags.includes("--extended-regexp")) && /(?<!\\)\|/.test(body)) continue;
    if (stages.slice(0, -1).some((s) => RUNNER.test(stageProgram(s)))) return true;
  }
  return false;
}

/** Python/JS names whose call is never "the deliverable on an input": builtins, the stdlib, string and container methods. */
const NOT_DELIVERABLE = new Set(
  (
    "all any bool list tuple set frozenset dict sorted reversed sum min max next iter zip map filter enumerate range str int float abs round " +
    "strip lstrip rstrip split rsplit splitlines join replace lower upper casefold startswith endswith find rfind index count get keys values items " +
    "read readline readlines write encode decode format append extend pop add update copy compile escape print open repr chr ord " +
    "isinstance issubclass hasattr getattr setattr callable len type id dir vars hash super object exit quit"
  ).split(" "),
);
/** Calls whose contents never count: they ask about a thing's shape, not what the work does. */
const OPAQUE = /^(?:isinstance|issubclass|hasattr|getattr|callable|len|type|id|dir|vars|open|print|repr|os(?:\.\w+)*|glob(?:\.\w+)*|json\.\w+|csv\.\w+|inspect\.\w+|time\.\w+|shutil\.\w+|subprocess\.\w+|Path|pathlib\.\w+)$/;
/**
 * A pattern the work wrote, tried on strings the check chose: `re.search(p, ...)`
 * or `re.compile(open('regex.txt').read())` with a pattern that is not a literal.
 * See "Not widened" under assertsValue.
 */
const PATTERN_DELIVERABLE = /(?<![\w.])re\.(?:compile|search|match|fullmatch|findall|finditer)\(\s*(?![rbuf]{0,2}\\?["'])/;

/** One balanced span starting at the `(` at `open`; its end index (exclusive), or -1. String-aware for '...' and "...". */
function closeParen(s: string, open: number): number {
  let depth = 0;
  let q: string | undefined;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === "\\") i++;
      else if (ch === q) q = undefined;
      else if (ch === "\n") return -1;
      continue;
    }
    if (ch === "\\" && (s[i + 1] === '"' || s[i + 1] === "'")) {
      q = s[i + 1];
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Split `s` on top-level (outside brackets and strings) matches of `sep`, a sticky (`y`) regex. */
function splitTop(s: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let q: string | undefined;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === "\\") i++;
      else if (ch === q) q = undefined;
      continue;
    }
    if (ch === "\\" && (s[i + 1] === '"' || s[i + 1] === "'")) {
      q = s[i + 1];
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') q = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (depth === 0) {
      sep.lastIndex = i;
      const m = sep.exec(s);
      if (m) {
        out.push(s.slice(start, i));
        start = i + m[0].length;
        i = start - 1;
      }
    }
  }
  out.push(s.slice(start));
  return out;
}

/** A literal argument: a quoted string, a number, or a list/tuple/dict that opens with one. */
const LITERAL_ARG = /^\s*(?:[rbuf]{0,2}\\?["']|-?\d|[[({]\s*(?:[rbuf]{0,2}\\?["']|-?\d|[[(]))/;

/**
 * Names bound to literal input in the command: `bad = ['a', 'b']`,
 * `line = '10.0.0.1 2024-01-05'`, and loop variables over such a name or a
 * literal (`for s in bad`, `for line, exp in zip(lines, expected)`).
 */
function literalNames(run: string): Set<string> {
  const names = new Set<string>();
  for (const m of run.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*(?<![=!<>])=(?!=)\s*/g)) {
    if (LITERAL_ARG.test(run.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 12))) names.add(m[1]!);
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const m of run.matchAll(/\bfor\s+\(?\s*([A-Za-z_][\w\s,]*?)\s*\)?\s+in\s+(?:(?:zip|enumerate|sorted|list)\(\s*)?([A-Za-z_][\w]*|[[({])/g)) {
      const src = m[2]!;
      if (/^[[({]$/.test(src) || names.has(src)) for (const v of m[1]!.split(",")) if (v.trim()) names.add(v.trim());
    }
  }
  return names;
}

/** Is this argument text literal input: a literal, or a name bound to one? */
function literalInput(arg: string, names: ReadonlySet<string>): boolean {
  const a = arg.trim().replace(/^[A-Za-z_]\w*\s*=(?!=)\s*/, "");
  return LITERAL_ARG.test(a) || names.has(a);
}

/** A call: its name and top-level arguments. */
type Call = { name: string; args: string[] };

/** The calls in `expr` outside opaque ones (isinstance, len, open, ...), with their top-level arguments. */
function callsIn(expr: string): Call[] {
  const out: Call[] = [];
  const re = /([A-Za-z_][\w.]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) {
    const open = m.index + m[0].length - 1;
    const end = closeParen(expr, open);
    if (end < 0) continue;
    const name = m[1]!;
    if (OPAQUE.test(name)) {
      re.lastIndex = end;
      continue;
    }
    out.push({ name, args: splitTop(expr.slice(open + 1, end - 1), /,/y) });
  }
  return out;
}

/** A call into the work's code (not a builtin, the stdlib or a string method) handed literal input. */
function deliverableCall(c: Call, names: ReadonlySet<string>): boolean {
  const last = c.name.split(".").pop() ?? c.name;
  if (NOT_DELIVERABLE.has(last) || /^(?:re|json|csv|os|sys|time|math|random|itertools|collections|datetime)\./.test(c.name)) return false;
  return c.args.some((a) => literalInput(a, names));
}

const COMPARISON = /==|!=|<=|>=|<|>|\s(?:not\s+)?in\s/y;

/** One `and`-conjunct of an asserted condition: does it assert the work's behaviour on literal input? */
function conjunctAsserts(raw: string, names: ReadonlySet<string>): boolean {
  let c = raw.trim();
  let negated = false;
  for (;;) {
    const unnot = c.replace(/^not\s+/, "");
    if (unnot !== c) negated = !negated;
    const n = unnot.replace(/^\((.*)\)$/s, (all, inner: string) => (closeParen(all, 0) === all.length ? inner : all)).trim();
    if (n === c) break;
    c = n;
  }
  // `'x' in f('lit')`: a literal in the work's answer. Its negation (`'x' not
  // in f(...)`, `not 'x' in ...`) holds for an empty answer, and `is not None`
  // for "", 0, False and []: weaker than truthiness, so neither counts.
  const member = /^([rbuf]{0,2}\\?["'][^"']*\\?["']|-?\d+)\s+(not\s+)?in\s+(.+)$/s.exec(c);
  if (member) return !negated && !member[2] && callsIn(member[3]!).some((k) => deliverableCall(k, names));
  if (/\s+is\s+not\s+None\s*$/.test(c)) return false;
  const none = !negated && /\s+is\s+None\s*$/.test(c);
  const body = c.replace(/\s+is\s+None\s*$/, "");
  // A comparison with no literal side is rule 1's to refuse (`f(x) == g(x)`), and an ordering is a bound, not a value.
  if (!none || splitTop(body, COMPARISON).length > 1) return false;
  return callsIn(body).some((k) => deliverableCall(k, names));
}

/** The condition text starting at `from`: up to a top-level `,`, `;`, `:`, newline, closing bracket, or `stop`. */
function conditionAt(s: string, from: number, stop?: RegExp): string {
  let depth = 0;
  let q: string | undefined;
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === "\\") i++;
      else if (ch === q) q = undefined;
      else if (ch === "\n") return s.slice(from, i);
      continue;
    }
    if (ch === "\\" && (s[i + 1] === '"' || s[i + 1] === "'")) {
      q = s[i + 1];
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // A quote that never closes on this line is the shell's, not Python's: the code ends here.
      const rest = s.slice(i + 1);
      const close = rest.search(new RegExp(`(?<!\\\\)${ch}`));
      const nl = rest.indexOf("\n");
      if (close < 0 || (nl >= 0 && nl < close)) return s.slice(from, i);
      q = ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) return s.slice(from, i);
      depth--;
    } else if (depth === 0 && (ch === "," || ch === ";" || ch === "\n" || ch === ":")) return s.slice(from, i);
    else if (depth === 0 && stop) {
      stop.lastIndex = i;
      if (stop.test(s)) return s.slice(from, i);
    }
  }
  return s.slice(from);
}

/** Rule 5a: an asserted condition (`assert`, `sys.exit(0 if ... else 1)`, `if ...: sys.exit(1)`) on the work's behaviour. */
function assertsCondition(run: string, names: ReadonlySet<string>): boolean {
  const conditions: string[] = [];
  for (const m of run.matchAll(/(?<![\w.])assert(?:\.ok)?(?=[\s(])\s*/g)) conditions.push(conditionAt(run, (m.index ?? 0) + m[0].length));
  for (const m of run.matchAll(/(?:(?<![\w.])(?:sys\.)?exit|SystemExit)\(\s*[01]\s+if\s+/g)) conditions.push(conditionAt(run, (m.index ?? 0) + m[0].length, /\s+else\s/y));
  for (const m of run.matchAll(/(?<![\w.])if\s+/g)) {
    const at = (m.index ?? 0) + m[0].length;
    const cond = conditionAt(run, at);
    if (/^:\s*(?:(?:sys\.)?exit\(\s*[1-9]|raise\s+(?:SystemExit\(\s*[1-9]|AssertionError))/.test(run.slice(at + cond.length))) conditions.push(cond);
  }
  return conditions.some((cond) => {
    // `a or b` asserts neither: one may be the always-true branch.
    if (splitTop(cond, /\sor\s/y).length > 1) return false;
    return splitTop(cond, /\sand\s/y).some((c) => conjunctAsserts(c, names));
  });
}

/** Exits non-zero: what makes the path that did NOT raise fail the check. */
const FAIL_EXIT = /(?:(?<![\w.])(?:sys\.)?exit\(\s*(?:[1-9]|True|["'])|SystemExit\(\s*(?:[1-9]|True|["'])|raise\s+AssertionError|(?<![\w.])assert\s+(?:False|0)\b|process\.exit\(\s*[1-9])/;

/** Rule 5b: a specific exception from a call on literal input, where only the raising path passes. */
function assertsException(run: string, names: ReadonlySet<string>): boolean {
  const literalCall = (text: string) => callsIn(text).some((k) => deliverableCall(k, names));
  // pytest.raises(KeyError) / assertRaises(KeyError, f, 'x') / assert.throws(() => f('x'))
  for (const m of run.matchAll(/(?:pytest\.raises|assertRaises)\(\s*([\w.]+)/g)) {
    if (/^(?:Base)?Exception$/.test(m[1]!)) continue;
    const tail = run.slice(m.index ?? 0, (m.index ?? 0) + 300);
    if (literalCall(tail) || /assertRaises\(\s*[\w.]+\s*,\s*[\w.]+\s*,\s*(?:[rbuf]{0,2}\\?["']|-?\d|[[({])/.test(tail)) return true;
  }
  for (const m of run.matchAll(/assert\.(?:throws|rejects)\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const end = closeParen(run, open);
    if (end > 0 && literalCall(run.slice(open, end))) return true;
  }
  // try: f('x') / except KeyError: ... with a failing exit outside the handler.
  for (const m of run.matchAll(/(?<![\w.])try\s*:/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const ex = /(?<![\w.])except\s+\(?\s*([\w.]+)[^:\n]*:/g;
    ex.lastIndex = start;
    const e = ex.exec(run);
    if (!e || /^(?:Base)?Exception$/.test(e[1]!)) continue;
    const body = run.slice(start, e.index);
    const calls = callsIn(body);
    const hit = calls.findIndex((k) => deliverableCall(k, names));
    if (hit < 0) continue;
    // In the try block after the call: reached only when the call did not raise.
    if (FAIL_EXIT.test(body.slice(body.indexOf(calls[hit]!.name)))) return true;
    // After the handler: a line indented no deeper than `except` (or an `else:`).
    const lineStart = run.lastIndexOf("\n", e.index) + 1;
    const indent = e.index - lineStart;
    const handlerEnd = run.indexOf("\n", e.index + e[0].length);
    if (handlerEnd < 0) continue;
    const handler: string[] = [];
    let after = "";
    const lines = run.slice(handlerEnd + 1).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const ind = line.length - line.trimStart().length;
      if (line.trim() && ind <= indent) {
        after = lines.slice(i).join("\n");
        break;
      }
      handler.push(line);
    }
    const handlerText = `${run.slice(e.index + e[0].length, handlerEnd)}\n${handler.join("\n")}`;
    if (!FAIL_EXIT.test(handlerText) && FAIL_EXIT.test(after.split(/\n\S*(?:except|finally)\b/)[0] ?? "")) return true;
  }
  return false;
}

/**
 * Rule 5 of assertsValue: the deliverable is called or run on literal input
 * and the outcome is asserted: `is None`, a literal in its answer, a specific
 * exception, or a literal grepped from its output. Never for a pattern the
 * work wrote tried on the check's own strings (PATTERN_DELIVERABLE).
 * Exported for the tests.
 */
export function assertsBehaviour(run: string): boolean {
  if (PATTERN_DELIVERABLE.test(run)) return false;
  if (grepsRunOutput(run)) return true;
  const names = literalNames(run);
  return assertsCondition(run, names) || assertsException(run, names);
}

export function assertsValue(run: string, goldenPredates?: (operand: string) => boolean): boolean {
  const ops = /(==|!=|(?<=\s)-eq(?=\s)|(?<=\s)-ne(?=\s)|(?<=\s)=(?=\s))/g;
  for (const m of run.matchAll(ops)) {
    const at = m.index ?? 0;
    if (m[1] === "=") {
      // A lone `=` is an assignment unless it sits in a test bracket. A `;` or
      // newline inside `$(python3 -c "a; b")` does not end the bracket's command.
      const segment = run.slice(0, at).split(/[;\n]|&&|\|\|/).pop() ?? "";
      if (!BRACKET.test(segment)) {
        // A `;` or newline inside `[ "$(python3 -c "a; b")" = "2" ]` does not end the bracket's
        // command: read that one shell-aware, its operands as whole shell words.
        // Not when what is compared is a type probe (`print(type(x).__name__)" = "int"`): that is a shape.
        if (!PATTERN_DELIVERABLE.test(run) && !TYPE_PROBE.test(run) && bracketLiteral(run, at)) return true;
        continue;
      }
    }
    if (literalAround(run, at, m[1]!.length)) return true;
  }
  if (ASSERT_EQUAL.test(run)) return true;
  for (const m of run.matchAll(/\b(?:diff|cmp)\b([^\n|;&]*)/g)) {
    const args = m[1] ?? "";
    if (/<<|<\(/.test(args)) return true;
    if (GOLDEN_NAME.test(args)) {
      // Without a pre-work record (the drafter tagging a check), the name is
      // taken at its word; the tier asks again with one (`goldenPredates`).
      if (!goldenPredates) return true;
      const named = goldenOperands(m[0]);
      if (named.length && named.every((g) => goldenPredates(g))) return true;
    }
  }
  for (const m of run.matchAll(/\bgrep\b([^\n|;&]*)/g)) {
    const words: string[] = (m[1] ?? "").match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? [];
    const flags = words.filter((w) => w.startsWith("-"));
    if (!hasFlag(flags, "qx")) continue;
    const e = words.indexOf("-e");
    const pat = e >= 0 ? words[e + 1] : words.find((w) => !w.startsWith("-"));
    if (!pat) continue;
    const body = pat.replace(/^(["'])(.*)\1$/s, "$2");
    if (!body || /\$[\w{(]/.test(body)) continue;
    if (STANDALONE_NUMBER.test(body) || /^\^.{3,}\$$/s.test(body) || (hasFlag(flags, "x") && /\S/.test(body))) return true;
  }
  return assertsBehaviour(run);
}

// ---------------------------------------------------------------- the exact tag

/**
 * Does this command compare the deliverable's output with an EXACT expected
 * value, or only test a property of it?
 *
 * The 2026-10-07 lanes earned a wrong "verified" on cron-next with four
 * passing judge checks that all tested properties: 8 lines, each minute a
 * multiple of 15, sorted, unique; "every date is the 13th or a Friday"; two
 * runs of the worker agree; "starts with 2024-06-1". Output that skips every
 * other occurrence has all of those properties. An exact check would not
 * have passed: from 00:07, `*\/15` gives 00:15 first, and the work gave 00:45.
 *
 * Exact, any one of these:
 *  1. An equality (`==`, `===`, `-eq`, `=` in a test bracket, a failing `if
 *     ... != ...` / `!==`, `assertEqual`/`strictEqual`/`deepEqual`) between
 *     what the work produced and a literal: a number, a quoted string, a
 *     list/dict/set of literals, true/false/null, `"$(printf '...')"`, or a
 *     name bound to one (a table of cases). Asserted: under `assert`, `if ...:
 *     exit/raise/throw`, `exit(0 if ...)`, a test bracket, or `jq -e`.
 *  2. `diff`/`cmp` against a heredoc, a here-string, `<(printf ...)` /
 *     `<(echo ...)`, or an expected file (the tier's pre-work record still
 *     has to vouch for the file: `valueUnproven`).
 *  3. `grep -x` (or a `^...$` pattern) of a literal line, with no regex
 *     wildcards unless `-F`, over the work's output or a file it wrote.
 *  4. `<call into the work on literal input> is None`, asserted.
 *  5. A specific worked-out value with a digit in it found in what a program
 *     printed on literal input: `nextrun.py '0 9 * * *' '2023-01-01 08:00' 1
 *     | grep -q '2023-01-01 09:00'` (containsValue).
 *  6. An oracle: the work's output equal to a value the check built from the
 *     task's input files without running anything (oracleEquality).
 *  7. An exit or HTTP status other than 0/200 the task names (`rc=$?; [ $rc
 *     -eq 2 ]`), not read only on the path where the command failed.
 * Forms 5 and 6 narrow the rule as first measured (literal equality, diff,
 * grep -x only): over the 2026-10-07 lanes that kept 48 of 79 grader-right
 * verifieds the base rule grants, under the two-thirds bar; with them, 56 of
 * 79, and every grader-wrong verified is still removed
 * (bench/local/exact_replay.py).
 * Property, never exact, whatever the literal:
 *  - counts and sizes: `len()`, `.length`, `wc`, `grep -c`, `count`, `sum()`,
 *    jq `length`;
 *  - types and shapes: `type()`, `typeof`, `isinstance`, `keys`;
 *  - modulo (`% 15 == 0`), prefixes/suffixes and slices, membership in a
 *    file, a format pattern, ordering;
 *  - exit status 0 and HTTP 200: they say only that it ran;
 *  - the same constant compared across every item (`all(...)`, `any(...)`,
 *    a comprehension, a `for` loop, `find -exec`, `xargs`, jq `.[]`): each
 *    item having the property is still a property;
 *  - two unknowns compared (`[ "$a" = "$b" ]`, `L == sorted(set(L))`, two
 *    runs of the work agreeing);
 *  - a command that cannot fail (`... || echo fail`, `...; true`, `print(x == 1)`);
 *  - a pattern the work wrote, tried on lines the check chose (`re.search(p, ...)`).
 * A constant compared inside a loop over a literal table of cases
 * (`for inp, want in CASES: assert f(inp) == want`) is exact: `want` changes
 * with the input.
 *
 * `literalOnly` turns forms 5 and 6 off: the rule as first measured, for
 * bench/local/exact_replay.py.
 */
/**
 * Python asserts that hold whatever the work does: `assert (x == 1, 'msg')`
 * (a non-empty tuple is always true), `assert x == 1 or True`, `assert x == 1
 * if False else True`, and any assert under `python -O` / PYTHONOPTIMIZE,
 * which strips it.
 */
export function pythonAssertNeverFails(cmd: string): string | null {
  if (!/\bpython[\d.]*\b/.test(cmd) || !/\bassert\b/.test(cmd)) return null;
  if (/\bpython[\d.]*\s+(?:-\w+\s+)*-\w*O/.test(cmd) || /\bPYTHONOPTIMIZE=(?!0\b|""|''|\s)/.test(cmd)) {
    return "python runs with -O (or PYTHONOPTIMIZE), which strips every assert, so it exits 0 whatever happened";
  }
  for (const m of cmd.matchAll(/\bassert\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let q: string | undefined;
    let found = false;
    for (let i = open; i < cmd.length; i++) {
      const ch = cmd[i]!;
      if (q) {
        if (ch === "\\") i++;
        else if (ch === q) q = undefined;
        continue;
      }
      if (ch === "'" || ch === '"') q = ch;
      else if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) {
        depth--;
        if (depth === 0) {
          const after = cmd.slice(i + 1).trimStart();
          // `assert (cond)` alone is fine; `assert (a, b)` is a tuple.
          if (/^(?:[;\n"']|$)/.test(after) && found) return "it asserts a tuple (`assert (x, 'msg')`), which is always true";
          break;
        }
      } else if (ch === "," && depth === 1) found = true;
    }
  }
  for (const m of cmd.matchAll(/\bassert\b([^;\n]*)/g)) {
    const body = m[1]!.replace(/(["'])(?:(?!\1)[^\\]|\\.)*\1/g, "''");
    if (/\bor\s+(?:True|1|not\s+False)\b/.test(body)) return "its assert ends in `or True`, so it holds whatever the work does";
    if (/\bif\b.*\belse\s+(?:True|1)\b/.test(body)) return "its assert is a conditional expression with a true branch, so it holds whatever the work does";
  }
  return null;
}

export function assertsExact(run: string, opts: { literalOnly?: boolean } = {}): boolean {
  // A pattern the work wrote, tried on lines the check chose: the judge's own examples
  // missed the grader's near-miss (see "Not widened" under assertsValue).
  if (cannotFail(run) || pythonAssertNeverFails(run) || PATTERN_DELIVERABLE.test(run)) return false;
  const names = exactNames(run);
  const narrow = !opts.literalOnly;
  if (exactEquality(run, names, narrow) || exactHelper(run, names) || exactDiff(run) || exactGrepLine(run) || exactNone(run, names) || (narrow && containsValue(run))) return true;
  // `bash -c '<script>'`: the script is a command of its own. Not under `find -exec` or `xargs`: that runs it once per item.
  for (const m of run.matchAll(/(?:^|[\s;&|(])(?:ba|z|da)?sh\s+-c\s+(['"])/g)) {
    const open = (m.index ?? 0) + m[0].length;
    const q = m[1]!;
    let end = open;
    while (end < run.length && !(run[end] === q && (q === "'" || run[end - 1] !== "\\"))) end++;
    if (end >= run.length) continue;
    const seg = shellSegments(run).find(([a, b]) => a <= (m.index ?? 0) && (m.index ?? 0) <= b);
    if (seg && /\s-exec(?:dir)?\b|\bxargs\b|\bparallel\b/.test(run.slice(seg[0], open))) continue;
    const body = q === '"' ? run.slice(open, end).replace(/\\(["\\$`])/g, "$1") : run.slice(open, end);
    if (body.trim() && body !== run && assertsExact(body, opts)) return true;
  }
  return false;
}

/**
 * Names bound to a WHOLE literal (`want = ['00:15', '00:30']`, `CASES = [('a', 1), ...]`)
 * and loop variables over one: stricter than `literalNames`, which also takes
 * `exp = [f"{n} {q}" for ...]`, a value the check computed.
 */
function exactNames(run: string): Set<string> {
  const names = new Set<string>();
  for (const m of run.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*(?<![=!<>])=(?!=)\s*/g)) {
    const rhs = rightOperand(run, (m.index ?? 0) + m[0].length);
    if (wholeLiteral(rhs, new Set())) names.add(m[1]!);
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const m of run.matchAll(/\bfor\s+\(?\s*([A-Za-z_][\w\s,]*?)\s*\)?\s+in\s+/g)) {
      const at = (m.index ?? 0) + m[0].length;
      const src = rightOperand(run, at).replace(/:$/, "");
      const zipped = /^(?:zip|enumerate)\((.*)\)$/s.exec(src);
      const parts = zipped ? splitTop(zipped[1]!, /,/y).map((x) => x.trim()) : [src];
      if (parts.every((x) => names.has(x) || wholeLiteral(x, new Set()))) for (const v of m[1]!.split(",")) if (v.trim()) names.add(v.trim());
    }
  }
  return names;
}

/** A command whose exit status cannot be non-zero: its last top-level command is `echo`, `true`, `:`, `kill`, `rm` or `exit 0` after `;` or `||`. */
function cannotFail(run: string): boolean {
  const segs = shellSegments(run);
  if (segs.length < 2) return false;
  const [a, b] = segs[segs.length - 1]!;
  const last = run.slice(a, b).trim();
  const sep = run.slice(segs[segs.length - 2]![1], a);
  if (sep.trim() === "&&") return false;
  return /^(?:echo|printf|true|kill|rm|wait|sleep|exit\s+0)\b/.test(last) || /^:(?:\s|$)/.test(last);
}

/** What the work's side of a comparison must not be: a count, a size, a type, a remainder, an exit code, a prefix. */
const PROPERTY_SIDE =
  /\blen\s*\(|\.length\b|\blength\b|\bwc\b|\bgrep\s+(?:-\w+\s+)*-\w*c|\buniq\s+-c|\.count\s*\(|\bcount\b|\bsum\s*\(|\btype\s*\(|\btypeof\b|\bisinstance\b|\bkeys\b|(?<![%\w'"])%\s*[\w(]|\breturncode\b|\$\?|\bexit_?[Cc]ode\b|\.(?:status|status_code|code)\b|\bhttp_code\b|\[\s*-?\d*\s*:\s*-?\d*\s*\]|\.\[\]|\.(?:startswith|endswith|startsWith|endsWith)\(/;

/** An exit status or an HTTP status: `$?`, `returncode`, `exitCode`, `.status`, `status_code`, `http_code`. */
const STATUS_SIDE = /\$\?|\breturncode\b|\bexit_?[Cc]ode\b|\.(?:status|status_code|code)\b|\bhttp_code\b/;

/**
 * A status counts as an exact output only when the task's specific one is
 * named: `exit 2 on a bad -n`, `404 for a missing id`. 0 and 200 say only
 * that it ran.
 */
function statusExpected(literal: string): boolean {
  const n = literal.trim().replace(/^(["'])(.*)\1$/, "$2");
  // 1 is what any crash exits with: on its own it cannot tell the work from a stub that raises.
  return /^-?\d+$/.test(n) && n !== "0" && n !== "1" && n !== "200";
}

/** A shell word that prints literal text: `"$(printf 'a\nb')"`, `"$(echo ok)"`, with no expansion inside. */
const PRINTF_LITERAL = /^"?\$\(\s*(?:printf|echo)(?:\s+-[ne]+)?\s+(?:'[^'$`]*'|"[^"$`]*"|[^\s$`'"();|&]+)\s*\)"?$/;

/** A whole literal: a number, a quoted string with no expansion, a keyword, or a bracketed list/dict/set/tuple of literals. */
function wholeLiteral(text: string, names: ReadonlySet<string>): boolean {
  const t = text.trim().replace(/^\\(["'])/, "$1").replace(/\\(["'])$/, "$1");
  if (!t) return false;
  if (names.has(t)) return true;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return true;
  if (/^(?:True|False|None|true|false|null|undefined)$/.test(t)) return true;
  if (/^[rbuf]{0,2}(["'])(?:(?!\1)[^\\$]|\\.)*\1$/s.test(t)) return true;
  if (/^\$'(?:[^'\\]|\\.)*'$/.test(t)) return true;
  if (/^[[({]/.test(t) && closeParen(t, 0) === t.length) {
    const bare = t.replace(/\\?(["'])(?:(?!\1)[^\\]|\\.)*?\\?\1/g, "''");
    return !/[A-Za-z_]\w*/.test(bare.replace(/\b(?:True|False|None|true|false|null)\b/g, ""));
  }
  return false;
}

const OPERAND_STOP_WORDS = /(?:^|[\s(;])(?:assert|and|or|not|if|elif|while|return|else|then|in|print|&&|\|\|)\s*$/;

/** The operand ending just before `at` in code: back to an unmatched bracket, a top-level separator, or a keyword. */
function leftOperand(s: string, at: number): { text: string; start: number } {
  let depth = 0;
  let i = at - 1;
  while (i >= 0 && /\s/.test(s[i]!)) i--;
  const end = i + 1;
  for (; i >= 0; i--) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"') {
      const open = s.lastIndexOf(ch, i - 1);
      if (depth === 0 && i + 1 !== end) break; // a quote that is not the operand's own string: the shell's
      if (open < 0) break;
      i = open;
      if (s[i - 1] === "\\") i--;
      continue;
    }
    if (")]}".includes(ch)) depth++;
    else if ("([{".includes(ch)) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0) {
      if (",;\n?:=!<>".includes(ch) && !(ch === "=" && s[i - 1] === "=")) break;
      if (/\s/.test(ch) && OPERAND_STOP_WORDS.test(s.slice(Math.max(0, i - 8), i + 1))) break;
      if (/\s/.test(ch) && /^\s*(?:and|or|if|else|not)\b/.test(s.slice(i + 1, end))) break;
    }
  }
  const start = i + 1;
  return { text: s.slice(start, end).trim().replace(/^(?:assert|not|if|return)\s+/, ""), start };
}

/** The operand starting just after `from` in code: up to an unmatched bracket, a top-level separator, or a keyword. */
function rightOperand(s: string, from: number): string {
  let depth = 0;
  let i = from;
  while (i < s.length && /\s/.test(s[i]!)) i++;
  const start = i;
  for (; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && (s[i + 1] === '"' || s[i + 1] === "'")) {
      if (depth === 0 && i !== start) break;
      const q = s[i + 1]!;
      const close = s.indexOf(`\\${q}`, i + 2);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (depth === 0 && i !== start && !/^[rbuf]{1,2}$/.test(s.slice(start, i))) break;
      const close = s.indexOf(ch, i + 1);
      if (close < 0) break;
      i = close;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0) {
      if (",;\n?:&|".includes(ch)) break;
      if (/\s/.test(ch) && /^\s*(?:and|or|if|else|for)\b/.test(s.slice(i))) break;
    }
  }
  return s.slice(start, i).trim();
}

/** The `(`/`[`/`{` openers enclosing `at`, innermost first. */
function enclosing(s: string, at: number): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = s[i]!;
    if (")]}".includes(ch)) depth++;
    else if ("([{".includes(ch)) {
      if (depth === 0) out.push(i);
      else depth--;
    }
  }
  return out;
}

/** `s` with nested brackets and quoted strings emptied: what is at its own top level. */
function topLevelText(s: string): string {
  let out = "";
  let depth = 0;
  let q: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === "\\") i++;
      else if (ch === q) q = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') q = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

/** Is the comparison at `at` made once per item of something: inside all()/any()/a comprehension, a for loop, find -exec, xargs, jq `.[]`? */
function quantified(s: string, at: number): boolean {
  for (const open of enclosing(s, at)) {
    const before = s.slice(Math.max(0, open - 12), open);
    if (/(?:\ball|\bany|\.every|\.some|\bfilter|\bmap|\.forEach|\bsum)\s*$/.test(before)) return true;
    const end = closeParen(s, open);
    const inner = s.slice(open + 1, end > 0 ? end - 1 : s.length);
    // A comprehension: `for ... in` at the top level of this bracket, not in a call or string nested in it.
    if (/\sfor\s[^\n]*?\sin\s/.test(topLevelText(inner)) && !/^\s*for\b/.test(inner)) return true;
  }
  const stmt = s.slice(0, at).split(/[;\n]/).pop() ?? "";
  if (/(?:^|[\s(])for\s*\(|(?:^|\s)for\s+[\w,\s()]+\s+in\s/.test(stmt)) return true;
  const seg = shellSegments(s).find(([a, b]) => a <= at && at <= b);
  const segText = seg ? s.slice(seg[0], at) : "";
  if (/\s-exec(?:dir)?\b|\bxargs\b|\bparallel\b/.test(segText)) return true;
  const lastDo = s.lastIndexOf(" do ", at);
  if (lastDo >= 0 && /\b(?:for|while)\b/.test(s.slice(0, lastDo)) && s.indexOf("done", at) > 0 && s.lastIndexOf("done", at) < lastDo) return true;
  return false;
}

/** Is the comparison at `at` what decides the exit status: under assert/if-exit/exit(0 if ...)/throw, a test bracket, or `jq -e`? */
function asserted(s: string, at: number): boolean {
  const stmt = s.slice(Math.max(0, at - 300), at).split(/[;\n]/).pop() ?? "";
  if (/(?:^|[\s(])assert(?:\.\w+)?[\s(]|\bif\s*\(|\bexit\(|\bSystemExit\(|\bexpect\(/.test(stmt)) return true;
  if (/(?:^|\s)if\s/.test(stmt) && !/\bprint\s*\(/.test(stmt)) {
    const after = s.slice(at, at + 400);
    if (/\b(?:sys\.)?exit\(|\braise\b|\bthrow\b|process\.exit\(|\bexit\s+[1-9]/.test(after)) return true;
  }
  if (/\bjq\s+(?:-\w+\s+)*-\w*e\w*\s/.test(s.slice(0, at)) && /\bjq\b[^|;&]*$/.test(s.slice(0, at))) return true;
  return false;
}

/** Rule 1: an asserted equality between the work's output and a literal. */
function exactEquality(run: string, names: ReadonlySet<string>, oracle: boolean): boolean {
  const ops = /(===|!==|==|!=|(?<=\s)-eq(?=\s)|(?<=\s)-ne(?=\s)|(?<=\s)=(?=\s))/g;
  const d = shellDepths(run);
  // Shell variables that hold an exit status: `rc=$?` makes `[ $rc -eq 2 ]` an exit-code check.
  const statusVars = [...run.matchAll(/(?<![\w$])(\w+)=\$\?/g)].map((m) => m[1]!);
  for (const m of run.matchAll(ops)) {
    const at = m.index ?? 0;
    const op = m[1]!;
    const seg = shellSegments(run).find(([a, b]) => a <= at && at <= b);
    const inBracket = !!seg && d[at] === 0 && BRACKET.test(run.slice(seg[0], at));
    let left: string;
    let right: string;
    if (inBracket) {
      [left, right] = shellWordAround(run, d, at, op.length);
      // `[ x != "lit" ]` asserts a difference, unless a failure follows it: `[ x != y ] && exit 1`.
      if ((op === "!=" || op === "-ne") && !/^\s*\]{1,2}\s*&&\s*(?:\{\s*)?(?:echo[^;&|]*[;&|]+\s*)?exit\s+[1-9]/.test(run.slice(at + op.length).replace(/^\s*\S+/, ""))) continue;
      const lit = (w: string) => SHELL_LITERAL.test(w) || PRINTF_LITERAL.test(w) || wholeLiteral(w, names);
      const work = lit(right) ? left : lit(left) ? right : undefined;
      if (work === undefined || lit(work)) continue;
      const expected = work === left ? right : left;
      if (STATUS_SIDE.test(work) || statusVars.some((v) => new RegExp(`\\$\\{?${v}\\b`).test(work))) {
        // `X || [ $? -eq 1 ]` passes whenever X succeeds: the status is only read on the path that failed.
        const before = seg ? run.slice(0, seg[0]).trimEnd() : "";
        if (!statusExpected(expected) || before.endsWith("||")) continue;
      } else if (PROPERTY_SIDE.test(work)) continue;
      if (quantified(run, at)) continue;
      if (trivialLiteral(expected)) continue;
      return true;
    }
    if (op === "=" || op === "-eq" || op === "-ne") continue;
    const l = leftOperand(run, at);
    const r = rightOperand(run, at + op.length);
    // A difference counts only when it is what fails the check: `if (x !== "lit") throw`.
    if (op.startsWith("!")) {
      const stmt = run.slice(Math.max(0, l.start - 40), l.start);
      if (!/\bif\s*\(?\s*(?:not\s+)?$/.test(stmt) && !/\bif\s*\(\s*$/.test(stmt)) continue;
      const after = run.slice(at, at + 200);
      if (!/\b(?:sys\.)?exit\(\s*[1-9"']|\braise\b|\bthrow\b|process\.exit\(\s*[1-9]/.test(after)) continue;
    } else if (!asserted(run, at)) continue;
    const litR = wholeLiteral(r, names);
    const litL = wholeLiteral(l.text, names);
    if (!litR && !litL) {
      if (oracle && oracleEquality(run, l.text, r)) return true;
      continue;
    }
    if (litR === litL) continue;
    const work = litR ? l.text : r;
    const expected = litR ? r : l.text;
    if (!work) continue;
    if (STATUS_SIDE.test(work)) {
      if (!statusExpected(expected)) continue;
    } else if (PROPERTY_SIDE.test(work)) continue;
    if (quantified(run, at) && !loopNames(run, names).has(expected.trim())) continue;
    if (trivialLiteral(expected)) continue;
    return true;
  }
  return false;
}

/**
 * A literal any stub or crash produces: an empty container or string, a
 * boolean, None, 0 or 1. On its own it cannot tell the work from a function
 * that returns [] or a program that dies.
 */
function trivialLiteral(text: string): boolean {
  const t = text.trim().replace(/^(["'])(\s*)\1$/, "''");
  return /^(?:\[\s*\]|\{\s*\}|\(\s*\)|''|""|True|False|None|true|false|null|undefined|-?[01](?:\.0+)?)$/.test(t);
}

/** Loop variables over a literal table of cases (`for inp, want in CASES`): they change with the input, unlike a constant bound once (`ok = True`). */
function loopNames(run: string, names: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const m of run.matchAll(/\bfor\s+\(?\s*([A-Za-z_][\w\s,]*?)\s*\)?\s+in\s+/g)) {
    for (const v of m[1]!.split(",")) if (v.trim() && names.has(v.trim())) out.add(v.trim());
  }
  return out;
}

/** What builds a value by running something: then it is the work's output, not an expectation. */
const RUNS_SOMETHING = /\bsubprocess\b|\bcheck_output\b|\bpopen\b|\bexec(?:File)?Sync\b|\bspawnSync\b|\bstdout\b|\bstdin\b|\binput\(|\$\(|`/;
/** What reads the task's input files. */
const READS_INPUT = /\bopen\(|\bjson\.load\(|\brequire\(\s*["'`]\.\/|\breadFileSync\(|\bcsv\.reader\(/;

/**
 * Rule 1, oracle form: the work's output equals a value the check computed
 * from the task's own input files without running anything:
 *   exp = [f"{n:>6} {q}" for q, n in top]  ...  assert open("report.txt").read().splitlines() == exp
 * The expected side is one name (a trailing `.strip()`-style call allowed),
 * assigned in the command from an expression that runs nothing and reads no
 * output stream; the other side does not use that name (`L == sorted(set(L))`
 * relates the output to itself).
 */
function oracleEquality(run: string, left: string, right: string): boolean {
  if (!READS_INPUT.test(run)) return false;
  const bare = (x: string) => /^([A-Za-z_]\w*)(?:\.(?:r?strip|splitlines)\([^()]*\))?$/.exec(x.trim())?.[1];
  for (const [exp, work] of [
    [bare(right), left],
    [bare(left), right],
  ] as const) {
    if (!exp || !work.trim() || new RegExp(`\\b${exp}\\b`).test(work) || PROPERTY_SIDE.test(work) || STATUS_SIDE.test(work)) continue;
    const defs = [...run.matchAll(new RegExp(`(?<![\\w.])${exp}\\s*(?<![=!<>])=(?!=)\\s*`, "g"))];
    if (!defs.length) continue;
    if (defs.every((m) => {
      const rhs = rightOperand(run, (m.index ?? 0) + m[0].length);
      return rhs && !RUNS_SOMETHING.test(rhs) && !wholeLiteral(rhs, new Set());
    })) return true;
  }
  return false;
}

/** Rule 1, helper form: `assertEqual(f('x'), 'y')`, `assert.strictEqual(f(2), 4)`, `assert.deepEqual(...)`. */
function exactHelper(run: string, names: ReadonlySet<string>): boolean {
  for (const m of run.matchAll(/(?:\bassert_?[Ee]qual|\bassert_eq!?|\.(?:deep|strict|deepStrict)?[Ee]qual)\w*\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const end = closeParen(run, open);
    if (end < 0) continue;
    const args = splitTop(run.slice(open + 1, end - 1), /,/y).map((a) => a.trim());
    if (args.length < 2) continue;
    const [a, b] = args as [string, string];
    const la = wholeLiteral(a, names);
    const lb = wholeLiteral(b, names);
    if (la === lb) continue;
    const work = la ? b : a;
    if (PROPERTY_SIDE.test(work) || quantified(run, open)) continue;
    return true;
  }
  return false;
}

/** Rule 2: `diff`/`cmp` against a heredoc, a here-string, `<(printf|echo ...)`, or an expected file. */
function exactDiff(run: string): boolean {
  for (const m of run.matchAll(/\b(?:diff|cmp)\b([^\n|;&]*)/g)) {
    const args = m[1] ?? "";
    if (/<<|<\(\s*(?:printf|echo|cat\s+<<)\b/.test(args) || GOLDEN_NAME.test(args)) return true;
  }
  return false;
}

/** Stages that turn output into a count: what a `grep -x '5'` after them reads. */
const COUNTING_STAGE = /^(?:wc\b|uniq\s+(?:-\w+\s+)*-\w*c|grep\s+(?:-\w+\s+)*-\w*c|jq\s+[^|]*\blength\b|awk\b[^|]*\bNR\b|sort\s[^|]*\|\s*uniq\s+-c)/;

/** Rule 3: `grep -x '<literal line>'` (or `^...$`) over the work's output or a file, not over a count. */
function exactGrepLine(run: string): boolean {
  for (const [a, b] of shellSegments(run)) {
    const stages = pipeStages(run.slice(a, b));
    if (/^\s*!\s/.test(stages[0] ?? "")) continue; // `! ... | grep -qx x` asserts the line is absent
    for (let k = 0; k < stages.length; k++) {
      const words: string[] = stages[k]!.trim().match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? [];
      if (!/^[ef]?grep$/.test(words[0] ?? "")) continue;
      const args = words.slice(1);
      const flags = args.filter((w) => w.startsWith("-"));
      if (hasFlag(flags, "vcLlo") || flags.some((f) => /^--(?:invert|count|files)/.test(f))) continue;
      const e = args.indexOf("-e");
      const pat = e >= 0 ? args[e + 1] : args.find((w) => !w.startsWith("-"));
      if (!pat) continue;
      let body = pat.replace(/^(["'])(.*)\1$/s, "$2");
      if (/\$[\w{(]/.test(body)) continue;
      const fixed = hasFlag(flags, "F");
      const whole = hasFlag(flags, "x");
      if (!whole) {
        if (fixed || !/^\^.+\$$/s.test(body)) continue;
        body = body.slice(1, -1);
      }
      if (!fixed && /(?<!\\)[*+?[\]{}()|^$]/.test(body)) continue;
      if ((body.match(/\w/g) ?? []).length < 1) continue;
      if (stages.slice(0, k).some((s) => COUNTING_STAGE.test(s.trim()))) continue;
      return true;
    }
  }
  return false;
}

/**
 * Rule 5: a specific expected value found in what a program printed on literal
 * input: `python3 nextrun.py '0 9 * * *' '2023-01-01 08:00' 1 | grep -q
 * '2023-01-01 09:00'`. Containment, not equality, but of one worked-out value
 * with a digit in it, not a pattern: output that skips or shifts occurrences
 * does not contain it. Not over a file (`head -1 clean.csv | grep -q
 * 'id,name'` passed with wrong rows below a right header), never inverted or
 * counted, and never a wildcard pattern (`^[0-9]{4}-...$` is a format).
 */
function containsValue(run: string): boolean {
  for (const [a, b] of shellSegments(run)) {
    const stages = pipeStages(run.slice(a, b));
    if (stages.length < 2 || /^\s*!\s/.test(stages[0] ?? "")) continue;
    const words: string[] = stages[stages.length - 1]!.trim().match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? [];
    if (!/^[f]?grep$/.test(words[0] ?? "")) continue;
    const args = words.slice(1);
    const flags = args.filter((w) => w.startsWith("-"));
    if (hasFlag(flags, "vcLloEiw") || flags.some((f) => f.startsWith("--"))) continue;
    const e = args.indexOf("-e");
    const pat = e >= 0 ? args[e + 1] : args.find((w) => !w.startsWith("-"));
    if (!pat || args.filter((w) => !w.startsWith("-")).length > 1) continue; // a file operand: not the pipe's output
    const body = pat.replace(/^(["'])(.*)\1$/s, "$2");
    if (/\$[\w{(]/.test(body) || /(?<!\\)[*+?[\]{}()|^$\\]/.test(body) || body.length < 4 || !/\d/.test(body)) continue;
    const upstream = stages.slice(0, -1);
    if (upstream.some((x) => COUNTING_STAGE.test(x.trim()))) continue;
    if (!RUNNER.test(stageProgram(upstream[0]!))) continue;
    // A crash's message repeats its input (`ValueError: bad date '2024-06-13'`):
    // a value the check handed the program, or one read from its stderr, is not one it worked out.
    if (upstream.some((x) => x.includes(body)) || /2>&1|\|&|&>/.test(run.slice(a, b))) continue;
    // The program is handed literal input: an argument or a redirect, not just run bare.
    if (!/\s(?:'[^']*'|"[^"$]*"|-?\d[\w.:-]*|<\s*\S+)/.test(upstream[0]!.replace(/^\s*\S+/, ""))) continue;
    return true;
  }
  return false;
}

/** Rule 4: `assert f('<literal>') is None`. */
function exactNone(run: string, names: ReadonlySet<string>): boolean {
  for (const m of run.matchAll(/\s+is\s+None\b/g)) {
    const at = m.index ?? 0;
    const l = leftOperand(run, at + 1);
    if (!asserted(run, at) || PROPERTY_SIDE.test(l.text) || quantified(run, at)) continue;
    if (PATTERN_DELIVERABLE.test(run)) continue;
    if (callsIn(l.text).some((k) => deliverableCall(k, names))) return true;
  }
  return false;
}

/** The tags a drafted check carries: surface from the critic, value and exact from the command. */
export function evidenceTags(run: string, surface: boolean | undefined): string[] {
  const value = assertsValue(run);
  return ["task", ...(surface ? ["surface"] : []), ...(value ? ["value"] : []), ...(value && assertsExact(run) ? ["exact"] : [])];
}

/**
 * "passed-own-checks": every passing check that ran the work and asserted a
 * value was written by the worker model itself (or by a judge that is the
 * same model). Never verified: Maat's rule is that the model that did the
 * work is never the one that judges it. On the 2026-10-06/07 container
 * bench, self-judged arms were right in 125 of 174 "verified" claims (72%),
 * separate-judge arms in 48 of 55 (87%).
 */
/**
 * "passed-untested": an independent check that ran the work and asserted a
 * value passed, but none of them FAILED on the tree as it was before the work.
 * A check that passes on the untouched tree too cannot tell this work from no
 * work; it guards against a regression and proves nothing here. On the
 * 2026-10-07 container bench, a judge's `python3 server.py & sleep 1; curl
 * ... || echo fail` passed before server.py existed and earned a wrong
 * "verified" (the grader got a non-JSON 404).
 */
export type Tier = "verified" | "passed-checks" | "passed-own-checks" | "passed-untested" | "verified-audit";
export type TierVerdict = {
  tier: Tier;
  reason?: string;
  /** The strongest class among the passing checks. */
  evidence: "person" | "runs+exact" | "runs+value" | "runs" | "surface" | "none";
  /** Advisory review mode only: what the review said, recorded on the receipt instead of gating. */
  reviewNote?: string;
  /**
   * Advisory review mode only: the review contradicted the task, or was asked
   * for and did not run. The tier still stands (the review gates nothing in
   * that mode), but every label says so: ", unconfirmed" / ", unreviewed".
   */
  reviewGap?: "unconfirmed" | "unreviewed";
  /**
   * Who stood behind the word, when the passing runs+value (or person) checks
   * decided it: "person", "independent" (another model), or "own" (the worker).
   */
  basis?: "person" | "independent" | "own";
  /** The models that wrote the independent passing runs+value checks ("independent" basis). */
  by?: string[];
  /** The worker model the checks were weighed against. */
  worker?: string;
};

/**
 * A model id with its provider's spelling taken off, so the same model
 * reached two ways compares equal: `minimax/minimax-m3:free` on OpenRouter
 * and `MiniMax-M3` direct are one model, and one model judging its own work
 * is not independent whichever door it came in by.
 */
export function normalizeModelId(id: string): string {
  let s = id.trim().toLowerCase();
  // Provider routing: `openrouter/qwen/qwen3-235b` -> `qwen3-235b`.
  s = s.slice(s.lastIndexOf("/") + 1);
  // Variant suffixes: `:free`, `:nitro`, Bedrock's `:0`.
  s = s.replace(/:.*$/, "");
  // Bedrock / Vertex vendor prefixes: `us.anthropic.claude-...`.
  s = s.replace(/^(?:[a-z]{2}\.)?(?:anthropic|meta|amazon|mistral|cohere|ai21|deepseek|qwen|google|openai|xai|minimax)\./, "");
  s = s.replace(/[._\s]+/g, "-");
  // Dated and alias releases of the same model: `-20250805`, `-2025-08-05`, `-latest`,
  // Bedrock's `-20240620-v1`. A bare `-v3` is a different model (deepseek-v3), never stripped.
  s = s.replace(/-(?:\d{8}(?:-v\d+)?|\d{4}-\d{2}-\d{2}|latest)$/, "");
  // Tuning names one provider spells and another drops: `qwen3-235b-a22b-instruct-2507`
  // on one is `qwen3-235b-a22b-2507` on another; `gemma-3-27b-it`. Erring toward
  // "same model" fails closed: it can only cost a judge its independence.
  s = s.replace(/-(?:instruct|chat|it)(?=-|$)/g, "");
  return s;
}

/** Same model, provider spelling aside. An empty id matches nothing. */
export function sameModel(a: string | undefined, b: string | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  return normalizeModelId(a) === normalizeModelId(b);
}

/**
 * Whether a check by this author can judge the worker's work. A person can.
 * A model can only when it is known and is not the worker model under any
 * of the worker's names. An author nobody recorded is the worker: unknown
 * authorship never earns the word.
 */
export function independentOf(author: CheckAuthor | undefined, worker: string | readonly string[] | undefined): boolean {
  if (!author) return false;
  if (author.kind === "person") return true;
  if (author.kind === "worker") return false;
  if (!author.model?.trim()) return false;
  const names = (typeof worker === "string" ? [worker] : [...(worker ?? [])]).filter((w) => w.trim());
  if (!names.length) return false;
  return !names.some((w) => sameModel(author.model, w));
}

/**
 * Can this result stand for a person's judgment of the task? Only a command
 * check (`kind: "command"`, never a builtin) that is not one of the session
 * checks. A result with no recorded kind cannot: every real result carries
 * one, so a missing kind is a caller that did not say, and that fails closed.
 */
export function personCheck(r: { kind?: CheckResult["kind"]; tags?: readonly string[] }): boolean {
  return r.kind === "command" && !r.tags?.includes("session");
}

/** One line for a receipt: who wrote this result's check. Builtins and session checks are Maat's, whatever done.yml says. */
export function resultAuthorWords(r: { kind?: CheckResult["kind"]; tags?: readonly string[]; hidden?: boolean }, a: CheckAuthor | undefined): string {
  if (r.kind === "builtin" || r.tags?.includes("session")) return "Maat (a session check: how the turn was done, never whether the task is right; does not count toward verified)";
  return authorWords(a ?? (r.hidden ? undefined : { kind: "person" }));
}

/** One line for a receipt: who wrote this check. */
export function authorWords(a: CheckAuthor | undefined): string {
  if (!a) return "unrecorded (treated as the worker model)";
  switch (a.kind) {
    case "person":
      return "a person (your check)";
    case "judge":
      return `the judge model${a.model ? ` ${a.model}` : ""}`;
    case "reference":
      return `the reference writer${a.model ? ` ${a.model}` : ""}`;
    default:
      return `the worker model${a.model ? ` ${a.model}` : ""}`;
  }
}

/** A check's author as one short machine-readable string: "person", "worker <model>", "judge <model>", "reference <model>". */
export function authorKey(a: CheckAuthor): string {
  return a.kind === "person" ? "person" : `${a.kind}${a.model ? ` ${a.model}` : ""}`;
}

/** A check's author, filled in where nobody recorded one: a hidden check is the worker's, a visible one a person's. */
export function withAuthor<T extends { hidden?: boolean; tags?: readonly string[]; author?: CheckAuthor }>(c: T, worker: string): T {
  if (c.author) return c;
  const person = c.hidden !== true || c.tags?.includes("mission") === true;
  return { ...c, author: person ? { kind: "person" } : { kind: "worker", model: worker } };
}

/**
 * The claim as every surface prints it, and as the bench's `claim` field
 * carries it, so an analysis can tell who stood behind each "verified":
 *   verified (independent checks: <judge model>)
 *   verified (your checks)
 *   passed own checks (<worker model>), not verified
 * Anything else is the outcome word unchanged.
 */
export function claimLabel(outcome: string, tier: Pick<TierVerdict, "tier" | "basis" | "by" | "worker" | "reviewGap"> | undefined): string {
  const gap = tier?.reviewGap ? `, ${tier.reviewGap}` : "";
  if (tier?.tier === "passed-own-checks") return `passed own checks (${tier.worker || "the worker model"}), not verified${gap}`;
  if (tier?.tier === "passed-untested") return `${UNTESTED_CLAIM}${gap}`;
  if (outcome === "verified" && tier?.tier === "verified") {
    if (tier.basis === "person") return `verified (your checks)${gap}`;
    if (tier.basis === "independent") return `verified (independent checks: ${(tier.by ?? []).join(", ") || "another model"})${gap}`;
  }
  return outcome;
}

/**
 * "verified-audit": the run was not verified by the checks sealed before the
 * work, and an independent judge's post-work audit check (src/post-audit.ts,
 * `--post-work-audit`) passed on the work, failed before it, failed on a
 * mutant of the changed code that still ran, and cleared the lints. A
 * separate tier and label, so its precision is read off apart from the
 * pre-work "verified".
 */
export function auditClaim(judge: string): string {
  return `${AUDIT_CLAIM_PREFIX}${judge || "another model"})`;
}
export const AUDIT_CLAIM_PREFIX = "verified (post-work audit: ";

/**
 * The reason a run whose passing independent checks only test properties of
 * the output (a count, an order, a format, membership, a type, two runs of the
 * work agreeing) gets "passed-checks": wrong output with the right shape passes
 * them all. See assertsExact.
 */
/**
 * Whether the exact-value rule (#46) is on: MAAT_REQUIRE_EXACT=1. Off by
 * default. On, "verified" needs an independent exact check, the drafter and
 * the post-work audit are asked for exact checks (criteria.ts draftSystem,
 * post-audit.ts auditSystem), and the audit drops property-only checks.
 */
export function exactRuleOn(): boolean {
  return env("REQUIRE_EXACT") === "1";
}

export const PROPERTY_ONLY_REASON = "passed checks that test properties only";

/** The claim for the "passed-untested" tier, on every surface. */
export const UNTESTED_CLAIM = "passed checks that did not test this work, not verified";

/**
 * Why the passing independent value checks did not test this work: each one
 * either passed on the tree before the work too, or was never tried there.
 */
export function untestedWords(names: readonly string[], passedBefore: ReadonlySet<string> | undefined): string {
  const why = (n: string) => `\`${n}\` ${passedBefore?.has(n) ? "passed before the work began too" : "was not tried before the work began"}`;
  return names.length === 1
    ? `the only independent check that ran the work and asserted an exact value did not fail before the work: ${why(names[0]!)}`
    : `no independent check that ran the work and asserted an exact value failed before the work: ${names.map(why).join("; ")}`;
}

/** The parts of a job_end event the verdict words are made from. */
export type JobEndWords = {
  outcome?: unknown;
  tier?: unknown;
  tierReason?: unknown;
  claim?: unknown;
  revealed?: unknown;
  review?: { confirmed?: boolean } | null;
  unreviewed?: unknown;
  selfChecked?: unknown;
  checksDisagree?: unknown;
};

/**
 * How a job ended, in the words the terminal and the window both print.
 *
 * Order matters: a review that contradicted the task, or one that was asked
 * for and did not run, qualifies every "verified", including one that carries
 * a claim. In review-advisory mode the tier stays verified with a review note,
 * and a claim branch tested first used to print "verified (independent checks:
 * j)" with no qualifier. The qualifier is now in the claim itself (claimLabel's
 * `reviewGap`); a claim from a build that did not put it there gets it added.
 */
export function jobEndWords(ev: JobEndWords): string {
  const claim = typeof ev.claim === "string" && ev.claim ? ev.claim : undefined;
  const verified = ev.outcome === "verified";
  const contradicted = verified && !!ev.review && ev.review.confirmed === false;
  const unreviewed = verified && !ev.review && !!ev.unreviewed;
  if (ev.tier === "passed-checks") return passedChecksWords(typeof ev.tierReason === "string" ? ev.tierReason : undefined);
  if ((ev.tier === "passed-own-checks" || ev.tier === "passed-untested") && claim) return claim;
  if (verified && Array.isArray(ev.revealed) && ev.revealed.length) return "verified (checks shown after a repeat failure)";
  if (verified && claim) {
    if (contradicted) return /, unconfirmed$/.test(claim) ? claim : `${claim}, unconfirmed`;
    if (unreviewed) return /, unreviewed$/.test(claim) ? claim : `${claim}, unreviewed`;
    return `${claim}${ev.review?.confirmed ? ", independently reviewed" : ""}`;
  }
  if (contradicted) return "passed its checks, unconfirmed";
  if (verified && ev.review?.confirmed) return "verified, independently reviewed";
  if (unreviewed) return "passed its checks, unreviewed";
  if (verified && ev.selfChecked) return "passed its own checks";
  if (ev.outcome === "unverified" && Array.isArray(ev.checksDisagree) && ev.checksDisagree.length) return "unverified, its own drafted checks disagree";
  return String(ev.outcome);
}

/**
 * The verdict words for a turn that passed its checks without earning
 * "verified". One phrase on every surface, so the same turn reads the same
 * whichever model ran it.
 */
export function passedChecksWords(reason: string | undefined): string {
  return `passed its checks (not verified: ${reason ?? "no check asserted an expected value"})`;
}

/** How many reviewers found a contradiction ("2/3" is 2); the violations list is the fallback. */
export function contradictions(review: { votes: string; violations: unknown[] } | null | undefined): number {
  if (!review) return 0;
  const n = Number.parseInt(review.votes, 10);
  return Number.isFinite(n) ? n : review.violations.length;
}

/**
 * The tier a passing turn has earned. "verified" needs (a) a passing check a
 * person wrote, or a passing drafted check that runs the deliverable (not
 * surface) AND asserts a value AND was written by someone other than the
 * worker model (and, with `requireDiscriminating`, failed on the tree before
 * the work began: see `failedBefore`), and (b) an independent review, when one ran, that found no
 * contradiction. (c) — the turn not ended by the clock or the provider — is
 * decided before this, by `passedAtEnd`.
 *
 * A person's check is not Maat's to second-guess: a passing command check
 * from the project's done.yml (not hidden), or one a person approved, carries
 * "verified". Builtins and `session` checks never do (`personCheck`): they
 * are in every `maat init` bar, nobody wrote them for this task, and any
 * worker that changes a file passes them.
 *
 * Never let a model both find and judge: when every passing runs+value check
 * was written by the worker model (no judge, or a judge that is the same
 * model reached another way), the best the turn earns is "passed-own-checks".
 * A check whose author was never recorded counts as the worker's.
 *
 * With `requireDiscriminating`, never let a check that cannot tell the work
 * from no work vouch for it: when independent runs+value checks passed but
 * none had failed before the work, the turn earns "passed-untested" — they
 * guard against a regression and did not test this work.
 *
 * And a check whose pass the worker arranged counts for nothing, whoever wrote
 * it (`discounted`, from control.ts): a runner shadowed by a file the worker
 * planted, an expected file the worker wrote, a drafted check whose only
 * input sat in the project for the worker to read. The reason names the file.
 */
export function tierOf(args: {
  results: readonly (Pick<CheckResult, "ok" | "hidden" | "advisory" | "skipped" | "tags"> & { name?: string; kind?: CheckResult["kind"] })[];
  review?: { votes: string; violations: unknown[] } | null;
  /** An independent review was asked for and did not run: it cannot have found nothing. */
  unreviewed?: boolean;
  /**
   * Experimental (MAAT_REVIEW_ADVISORY=1, `--review-advisory`): the review is
   * recorded but gates nothing, and the evidence rule is stricter in return:
   * it implies `requireDiscriminating`. reports/checkquality-2026-10-06.md §2.5 measured the 3-vote review as a
   * likelihood ratio of about 1.
   */
  reviewAdvisory?: boolean;
  /**
   * Opt-in (MAAT_REQUIRE_DISCRIMINATING=1, `--require-discriminating`; implied
   * by `reviewAdvisory`): only a check in `failedBefore` can earn "verified".
   * Off, `failedBefore` is ignored and the tier is #32's. Replayed over the
   * 2026-10-07 lanes the gate removed 2 wrong verifieds and denied 10 right
   * ones, so the default fixes the cause at seal time instead: a drafted
   * check that already passes before the work is redrafted or dropped.
   */
  requireDiscriminating?: boolean;
  /**
   * Opt-in (MAAT_REQUIRE_EXACT=1; default `exactRuleOn()`): "verified" needs a
   * passing independent check tagged `exact`, one that compares the output
   * with an exact expected value; independent value checks that only test
   * properties earn "passed-checks" (PROPERTY_ONLY_REASON). Off, the `exact`
   * tag is recorded but every independent runs+value check counts, as before
   * #46. Replayed over 2026-10-07 the rule removed every grader-wrong
   * verified and kept 71% of the right ones (bench/local/exact_replay.py).
   */
  requireExact?: boolean;
  /**
   * Names (as in `results`) of checks that were tried on the tree before the
   * work began and FAILED there. Only such a check discriminates: with
   * `requireDiscriminating`, "verified" needs a passing independent runs+value
   * check named here. A check that
   * passed before the work, could not run then, or joined after the work
   * began (no try) is not named here and cannot earn the word. Absent means
   * no check was tried, so none discriminates.
   */
  failedBefore?: ReadonlySet<string>;
  /** Names of checks that passed before the work too: only words the reason, never the tier. */
  guards?: ReadonlySet<string>;
  /** The worker model, under every name it ran as (configured id, the id the backend reported). */
  worker?: string | readonly string[];
  /** Who wrote each check, by result name, recorded at seal time. */
  authors?: ReadonlyMap<string, CheckAuthor>;
  /**
   * Checks whose `value` tag rests only on a `diff`/`cmp` against an
   * expected-looking file that was not there before the work, or changed
   * since (src/golden.ts). Their value tag does not count.
   */
  valueUnproven?: ReadonlySet<string>;
  /**
   * Passing checks whose pass the worker controlled, by result name, with why
   * (control.ts): a shadowed runner, an expected value the worker wrote, an
   * input the worker could read. They still passed; they are not evidence.
   */
  discounted?: ReadonlyMap<string, string>;
}): TierVerdict {
  const v = tierOfCounted(args);
  if (v.tier === "verified" || !args.discounted?.size) return v;
  const lost = args.results.filter((r) => r.ok && !r.advisory && !r.skipped && args.discounted!.has(r.name ?? ""));
  if (!lost.length || v.tier !== "passed-checks") return v;
  return { ...v, reason: lost.map((r) => `\`${r.name}\` does not count: ${args.discounted!.get(r.name!)}`).join("; ") };
}

function tierOfCounted(args: Parameters<typeof tierOf>[0]): TierVerdict {
  // A guard (tag `guard`, criteria.ts guardsFrom) passed before the work by
  // construction: it can refuse a claim at the bar, never carry the word.
  const passing = args.results
    .filter((r) => r.ok && !r.advisory && !r.skipped && !args.discounted?.has(r.name ?? "") && !r.tags?.includes("guard"))
    .map((r) => (args.valueUnproven?.has(r.name ?? "") && r.tags?.includes("value") ? { ...r, tags: r.tags.filter((t) => t !== "value") } : r));
  const workerNames = (typeof args.worker === "string" ? [args.worker] : [...(args.worker ?? [])]).filter((w) => w.trim());
  const worker = workerNames[0];
  // A mission's assertions are its contract, written before the work and
  // sealed with it (mission.ts): they are the person's bar, not a model's
  // guess at one, so they carry the word as a done.yml check does.
  const authorOf = (r: (typeof passing)[number]): CheckAuthor =>
    args.authors?.get(r.name ?? "") ??
    (r.hidden !== true || r.tags?.includes("mission") ? { kind: "person" } : { kind: "worker", ...(worker ? { model: worker } : {}) });
  // Only a command a person wrote or approved can carry the word for them.
  // Maat's builtins (work-landed, record-intact, claims-grounded, ...) and the
  // session checks every `maat init` bar ships say the turn was well-formed,
  // never that the task is right: nobody wrote them for this task, and a
  // worker that changes any file passes them.
  // A person's bar is one bar. When the worker subverted one of its checks
  // (a runner shadowed, an expected file rewritten), the rest of it is no
  // longer the bar the person wrote vouching for the work, and does not carry
  // the word on its own.
  const personSubverted = args.results.some(
    (r) => r.ok && !r.advisory && !r.skipped && args.discounted?.has(r.name ?? "") && authorOf(r).kind === "person",
  );
  const person = !personSubverted && passing.some((r) => personCheck(r) && authorOf(r).kind === "person");
  const drafted = passing.filter((r) => r.hidden === true && r.tags?.includes("task") && authorOf(r).kind !== "person");
  const strongAll = drafted.filter((r) => !r.tags?.includes("surface") && r.tags?.includes("value"));
  const strongIndependent = strongAll.filter((r) => independentOf(authorOf(r), workerNames));
  const strong = strongAll.length > 0;
  // Of those, the ones that compare the output with an exact expected value. A property
  // (a count, an order, a format, two runs agreeing) holds of wrong output too.
  // Only with the exact-value rule on (requireExact, MAAT_REQUIRE_EXACT=1).
  const exactGate = args.requireExact ?? exactRuleOn();
  const exactIndependent = exactGate ? strongIndependent.filter((r) => r.tags?.includes("exact")) : strongIndependent;
  // Of those, the ones that failed on the tree before the work and pass now:
  // the only passes that show THIS work did something.
  const gate = args.requireDiscriminating === true || args.reviewAdvisory === true;
  const discriminating = gate ? exactIndependent.filter((r) => args.failedBefore?.has(r.name ?? "") === true) : exactIndependent;
  const by = [...new Set(strongIndependent.map((r) => authorOf(r).model ?? "another model"))];
  const basis: TierVerdict["basis"] = person ? "person" : strongIndependent.length ? "independent" : strong ? "own" : undefined;
  const who = { ...(basis ? { basis } : {}), ...(by.length && !person ? { by } : {}), ...(worker ? { worker } : {}) };
  const evidence: TierVerdict["evidence"] = person
    ? "person"
    : exactGate && strongAll.some((r) => r.tags?.includes("exact"))
      ? "runs+exact"
      : strong
      ? "runs+value"
      : drafted.some((r) => !r.tags?.includes("surface"))
        ? "runs"
        : drafted.length
          ? "surface"
          : "none";
  const ownReason = `every passing check that ran the work and asserted a value was written by the worker model${worker ? ` (${worker})` : ""}`;
  const earned = person || discriminating.length > 0;
  const untestedReason = untestedWords(exactIndependent.map((r) => r.name ?? ""), args.guards);
  if (args.reviewAdvisory) {
    const n = contradictions(args.review);
    const reviewNote = n > 0 ? `advisory: the independent review found ${args.review!.votes} contradicting the task` : args.unreviewed ? "advisory: the independent review did not run" : undefined;
    const gap: Pick<TierVerdict, "reviewGap"> = n > 0 ? { reviewGap: "unconfirmed" } : args.unreviewed ? { reviewGap: "unreviewed" } : {};
    if (earned) return { tier: "verified", evidence, ...who, ...(reviewNote ? { reviewNote } : {}), ...gap };
    if (exactIndependent.length) return { tier: "passed-untested", evidence, ...who, reason: untestedReason, ...(reviewNote ? { reviewNote } : {}), ...gap };
    if (strongIndependent.length) return { tier: "passed-checks", evidence, ...who, reason: PROPERTY_ONLY_REASON, ...(reviewNote ? { reviewNote } : {}) };
    if (strong) return { tier: "passed-own-checks", evidence, ...who, reason: ownReason, ...(reviewNote ? { reviewNote } : {}), ...gap };
    return {
      tier: "passed-checks",
      evidence,
      ...who,
      reason:
        evidence === "runs"
          ? "no check that ran the work asserted an expected value"
          : "no passing check ran the work and asserted an expected value",
      ...(reviewNote ? { reviewNote } : {}),
    };
  }
  if (contradictions(args.review) > 0) {
    return { tier: "passed-checks", evidence, ...who, reason: `the independent review found ${args.review!.votes} contradicting the task` };
  }
  if (args.unreviewed && !person) return { tier: "passed-checks", evidence, ...who, reason: "the independent review did not run" };
  if (earned) return { tier: "verified", evidence, ...who };
  if (exactIndependent.length) return { tier: "passed-untested", evidence, ...who, reason: untestedReason };
  if (strongIndependent.length) return { tier: "passed-checks", evidence, ...who, reason: PROPERTY_ONLY_REASON };
  if (strong) return { tier: "passed-own-checks", evidence, ...who, reason: ownReason };
  return {
    tier: "passed-checks",
    evidence,
    ...who,
    reason:
      evidence === "runs"
        ? "no check that ran the work asserted an expected value"
        : "no passing check ran the work and asserted an expected value",
  };
}

const COVER_STOP = new Set(
  "the and for with that this from into must should shall will each every only all any are has have not but its was were been being file files output input when then than also exactly whole same handle handles".split(" "),
);

/** The words of a note or check that carry meaning: 3+ letters, not glue. */
function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !COVER_STOP.has(w)));
}

/**
 * Which discriminating checks plausibly cover each "Recorded, not verified"
 * note, matched by the words they share: at least two, and at least 60% of
 * the note's meaningful words appearing in the check's name or command.
 * Display only — it gates nothing, and a word match is a hint, not proof.
 */
export function noteCoverage(
  notes: readonly string[],
  checks: readonly { name: string; text: string }[],
): { note: string; by: string[] }[] {
  const cw = checks.map((c) => ({ name: c.name, words: contentWords(`${c.name.replace(/^task:/, "")} ${c.text}`) }));
  return notes.map((note) => {
    const nw = [...contentWords(note)];
    const need = Math.max(2, Math.ceil(nw.length * 0.6));
    const by = cw.filter((c) => nw.filter((w) => c.words.has(w)).length >= need).map((c) => c.name);
    return { note, by };
  });
}
