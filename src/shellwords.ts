/**
 * Enough of the shell's grammar to read a drafted check's arguments as the
 * shell will hand them to each program.
 *
 * The seal-time path lint used to scan the raw command with a regex, so it
 * read the inside of a sed program as a path: on 2026-10-07 three good
 * differential checks (`… | sed -E 's/^ +//; s/ +/ /g' | diff - $d/out`) were
 * dropped for using "/g, an absolute path outside the project", and a check
 * that built a Python file with `printf` lost to the `"/old.py"` it
 * concatenated onto `sys.argv[1]`. A path is an argument a program opens, and
 * which arguments those are depends on the program: a sed script, an awk
 * program, a grep pattern, a jq filter, printf's data are not paths.
 *
 * Not a full shell. Words, quotes, `$(…)`, backticks, `$((…))`, redirects,
 * heredocs and the command separators. Command substitutions and heredoc
 * bodies are kept as text for the caller to read again.
 */

/** One shell word: its value after quote removal, with every `$(…)` replaced by SUBST. */
export type ShellWord = {
  raw: string;
  value: string;
  /** Inner text of each command substitution in the word, in order. */
  substs: string[];
  /** True when any part of the word was quoted. */
  quoted: boolean;
};

export type ShellRedirect = { op: string; target: ShellWord };

export type ShellCommand = {
  words: ShellWord[];
  redirects: ShellRedirect[];
  /** Bodies of the command's `<<` heredocs. */
  heredocs: string[];
};

/** Stands in for a command substitution inside a word's value. Never the start of a path. */
export const SUBST = "\u0001";

const SEPARATORS = new Set([";", "&", "|", "\n", "(", ")"]);

/** The text of a `$(…)` or `` `…` `` starting at `open` (just past the opener), and where it ends. */
function readSubst(s: string, open: number, closer: ")" | "`"): { text: string; end: number } {
  if (closer === "`") {
    let j = open;
    while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
    return { text: s.slice(open, j), end: Math.min(j + 1, s.length) };
  }
  let depth = 1;
  let j = open;
  for (; j < s.length; j++) {
    const ch = s[j]!;
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "'") {
      const e = s.indexOf("'", j + 1);
      j = e < 0 ? s.length : e;
      continue;
    }
    if (ch === '"') {
      for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === "\\") j++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) break;
  }
  return { text: s.slice(open, j), end: Math.min(j + 1, s.length) };
}

/**
 * The simple commands of a shell command line, in order. Compound syntax
 * (`if`, `for`, `{ }`, `( )`) is flattened: its keywords come out as words
 * of the commands they start, which is what a reader of arguments needs.
 */
export function parseShell(src: string): ShellCommand[] {
  const out: ShellCommand[] = [];
  let cmd: ShellCommand = { words: [], redirects: [], heredocs: [] };
  let word: ShellWord | null = null;
  let pendingRedirect: string | null = null;
  const pendingHeredocs: { delim: string; strip: boolean }[] = [];

  const endWord = () => {
    if (!word) return;
    if (pendingRedirect !== null) {
      cmd.redirects.push({ op: pendingRedirect, target: word });
      if (pendingRedirect.startsWith("<<") && pendingRedirect !== "<<<") pendingHeredocs.push({ delim: word.value, strip: pendingRedirect === "<<-" });
      pendingRedirect = null;
    } else cmd.words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    pendingRedirect = null;
    if (cmd.words.length || cmd.redirects.length) out.push(cmd);
    cmd = { words: [], redirects: [], heredocs: [] };
  };
  const w = (): ShellWord => (word ??= { raw: "", value: "", substs: [], quoted: false });

  let i = 0;
  let wordStart = 0;
  const readHeredocs = () => {
    // Bodies start on the line after the operator; `i` is at that newline.
    let pos = i + 1;
    const owner = cmd.words.length || cmd.redirects.length ? cmd : out.at(-1);
    for (const h of pendingHeredocs.splice(0)) {
      const lines: string[] = [];
      for (;;) {
        if (pos >= src.length) break;
        const nl = src.indexOf("\n", pos);
        const line = src.slice(pos, nl < 0 ? src.length : nl);
        pos = nl < 0 ? src.length : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line).trim() === h.delim) break;
        lines.push(line);
      }
      owner?.heredocs.push(lines.join("\n"));
    }
    i = pos - 1;
  };

  for (i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    if (ch === "#" && !word) {
      while (i < src.length && src[i] !== "\n") i++;
      i--;
      continue;
    }
    if (ch === "\\") {
      if (src[i + 1] === "\n") {
        i++;
        continue;
      }
      if (!word) wordStart = i;
      w().value += src[i + 1] ?? "";
      w().quoted = true;
      w().raw = src.slice(wordStart, i + 2);
      i++;
      continue;
    }
    if (ch === "'") {
      if (!word) wordStart = i;
      const e = src.indexOf("'", i + 1);
      const end = e < 0 ? src.length : e;
      w().value += src.slice(i + 1, end);
      w().quoted = true;
      i = end;
      w().raw = src.slice(wordStart, i + 1);
      continue;
    }
    if (ch === '"') {
      if (!word) wordStart = i;
      const cur = w();
      cur.quoted = true;
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        const c = src[j]!;
        if (c === "\\" && /["\\$`\n]/.test(src[j + 1] ?? "")) {
          cur.value += src[++j];
        } else if (c === "$" && src[j + 1] === "(") {
          const r = readSubst(src, j + 2, ")");
          cur.substs.push(r.text);
          cur.value += SUBST;
          j = r.end - 1;
        } else if (c === "`") {
          const r = readSubst(src, j + 1, "`");
          cur.substs.push(r.text);
          cur.value += SUBST;
          j = r.end - 1;
        } else cur.value += c;
      }
      i = j;
      cur.raw = src.slice(wordStart, i + 1);
      continue;
    }
    if (ch === "$" && src[i + 1] === "(") {
      if (!word) wordStart = i;
      // `$((…))` is arithmetic, `$(…)` a command: both are a value here, not a path.
      const r = readSubst(src, i + 2, ")");
      if (src[i + 2] !== "(") w().substs.push(r.text);
      w().value += SUBST;
      i = r.end - 1;
      w().raw = src.slice(wordStart, i + 1);
      continue;
    }
    if (ch === "`") {
      if (!word) wordStart = i;
      const r = readSubst(src, i + 1, "`");
      w().substs.push(r.text);
      w().value += SUBST;
      i = r.end - 1;
      w().raw = src.slice(wordStart, i + 1);
      continue;
    }
    if (ch === ">" || ch === "<") {
      // `2>`, `&>`: the digits or & just read belong to the operator.
      const cur = word as ShellWord | null;
      if (cur && /^\d+$/.test(cur.raw) && !cur.quoted) word = null;
      else endWord();
      if (ch === "<" && src[i + 1] === "(") {
        // Process substitution: a command, not a file.
        const r = readSubst(src, i + 2, ")");
        wordStart = i;
        w().substs.push(r.text);
        w().value += SUBST;
        i = r.end - 1;
        w().raw = src.slice(wordStart, i + 1);
        continue;
      }
      let op = ch;
      while (/[<>|&-]/.test(src[i + 1] ?? "") && op.length < 3) {
        const nx = src[i + 1]!;
        if (nx === "&") {
          // `>&2`, `<&0`: a descriptor, not a file.
          op += nx;
          i++;
          break;
        }
        if (nx === "-" && op !== "<<") break;
        if (nx === "|" && op !== ">") break;
        op += nx;
        i++;
      }
      if (op.endsWith("&")) {
        // Skip the descriptor number.
        while (/[\d-]/.test(src[i + 1] ?? "")) i++;
        continue;
      }
      pendingRedirect = op;
      continue;
    }
    if (ch === "\n") {
      endCommand();
      if (pendingHeredocs.length) readHeredocs();
      continue;
    }
    if (ch === "&" && src[i + 1] === ">") {
      // `&> file`: both streams to the file. The `>` is read next.
      endWord();
      continue;
    }
    if (SEPARATORS.has(ch)) {
      endCommand();
      continue;
    }
    if (!word) wordStart = i;
    w().value += ch;
    w().raw = src.slice(wordStart, i + 1);
  }
  endCommand();
  return out;
}

/** Leading words that run the next word as the command (`timeout 5 cmd`, `env A=1 cmd`, `if cmd`). */
const PREFIX = new Set(["{", "}", "then", "do", "else", "elif", "if", "while", "until", "!", "time", "sudo", "exec", "command", "nohup", "builtin", "nice", "stdbuf", "done", "fi"]);

/** The command's own words: assignments, keyword and wrapper prefixes peeled off. */
export function commandWords(c: ShellCommand): { assignments: ShellWord[]; argv: ShellWord[] } {
  const assignments: ShellWord[] = [];
  let ws = c.words;
  for (;;) {
    const h = ws[0];
    if (!h) break;
    if (!h.quoted && PREFIX.has(h.value)) {
      ws = ws.slice(1);
      continue;
    }
    if (!h.quoted && h.value === "timeout") {
      ws = ws.slice(1);
      while (ws[0] && /^(-|\d)/.test(ws[0].value)) ws = ws.slice(/^-[sk]$/.test(ws[0].value) ? 2 : 1);
      continue;
    }
    if (!h.quoted && h.value === "env") {
      ws = ws.slice(1);
      while (ws[0] && (/^-/.test(ws[0].value) || /^[A-Za-z_]\w*=/.test(ws[0].raw))) {
        if (/^[A-Za-z_]\w*=/.test(ws[0].raw)) assignments.push(ws[0]);
        ws = ws.slice(1);
      }
      continue;
    }
    if (/^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(h.raw)) {
      assignments.push(h);
      ws = ws.slice(1);
      continue;
    }
    break;
  }
  return { assignments, argv: ws };
}

// ---------------------------------------------------------------- arguments that are paths

/** Programs whose first operand is a program or pattern, not a file (unless given by an option). */
const SCRIPT_FIRST: Record<string, { script: RegExp; file?: RegExp; valued: RegExp }> = {
  sed: { script: /^(-e|--expression)$/, file: /^(-f|--file)$/, valued: /^(-l|--line-length)$/ },
  awk: { script: /^$/, file: /^(-f|--file)$/, valued: /^(-F|-v|--assign|--field-separator)$/ },
  grep: { script: /^(-e|--regexp)$/, file: /^(-f|--file)$/, valued: /^(-m|-A|-B|-C|-d|-D|--max-count|--context|--after-context|--before-context|--label|--color|--colour)$/ },
  jq: { script: /^$/, file: /^(-f|--from-file)$/, valued: /^(--indent|--tab)$/ },
};
for (const a of ["gawk", "mawk", "nawk", "busybox-awk"]) SCRIPT_FIRST[a] = SCRIPT_FIRST.awk!;
for (const g of ["egrep", "fgrep", "zgrep", "rg", "ag", "ack"]) SCRIPT_FIRST[g] = SCRIPT_FIRST.grep!;
SCRIPT_FIRST.gsed = SCRIPT_FIRST.sed!;

/** Programs whose every argument is data or an operator, never a file to open. */
const DATA_ONLY = new Set(["echo", "printf", "tr", "expr", "true", "false", "exit", "return", "basename", "dirname", "seq", "sleep", "kill", "pkill", "date", "export", "local", "declare", "set", "shift", "read", "trap", "let", "case", "esac", "in", "for", "unset"]);

/** Interpreters and the option that gives them a program as text. */
const INLINE: Record<string, RegExp> = {
  python: /^-c$/,
  node: /^(-e|--eval|-p|--print)$/,
  deno: /^eval$/,
  perl: /^-[a-zA-Z]*[eE]$/,
  ruby: /^-[a-zA-Z]*e$/,
  php: /^-r$/,
  osascript: /^-e$/,
};
const SHELLS = /^(ba|da|z|k|a)?sh$/;

/** `test`/`[` operators whose operand is a file. */
const FILE_TEST = /^-[efdsrwxLhpSbcgukOGN]$/;

/** Every string literal in an inline program that is a whole absolute path, not one glued onto something with `+`. */
export function programPathLiterals(prog: string): string[] {
  const out: string[] = [];
  for (const m of prog.matchAll(/(['"])(\/[\w.@+-][^'"\s{}$]*)\1/g)) {
    const at = m.index ?? 0;
    const before = prog.slice(0, at).replace(/[rbRB]$/, "").trimEnd();
    const after = prog.slice(at + m[0].length).trimStart();
    // `base + "/old.py"`, `"/x" + y`, `os.path.join(d, "/x")`: built from a value, not a path of its own.
    if (/[+\w]$/.test(before) || after.startsWith("+")) continue;
    out.push(m[2]!);
  }
  return out;
}

const looksAbsolute = (v: string) => /^\/[\w.@+-]/.test(v);

/**
 * The absolute paths a command gives programs to open, in order: operands,
 * redirect targets, assignment values, `--opt=/path` values, and the
 * string literals of inline programs (`python3 -c`, heredocs to an
 * interpreter) that are a path on their own. Never a sed/awk/jq program, a
 * grep pattern, printf's or echo's data, a `find -name` pattern, a string
 * `test` compares, or a value built onto a variable or `$(…)`.
 */
export function absolutePathArgs(run: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 4) return out;
  const word = (w: ShellWord | undefined) => {
    if (w && looksAbsolute(w.value)) out.push(w.value.split(SUBST)[0]!);
  };
  const program = (text: string) => out.push(...programPathLiterals(text));
  for (const c of parseShell(run)) {
    const { assignments, argv } = commandWords(c);
    for (const ws of c.words) for (const s of ws.substs) out.push(...absolutePathArgs(s, depth + 1));
    for (const r of c.redirects) {
      for (const s of r.target.substs) out.push(...absolutePathArgs(s, depth + 1));
      if (!r.op.startsWith("<<")) word(r.target);
    }
    for (const a of assignments) {
      const v = { ...a, value: a.value.replace(/^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/, "") };
      // PATH-like lists: each element.
      for (const part of v.value.split(":")) word({ ...v, value: part });
    }
    const head = argv[0];
    if (!head) continue;
    word(head);
    const name = head.value.replace(/^.*\//, "").replace(/^(python|pypy)[\d.]*$/, "python");
    const args = argv.slice(1);
    const generic = (list: ShellWord[]) => {
      for (const a of list) {
        const eq = /^--?[\w-]+=(.*)$/s.exec(a.value);
        if (eq) word({ ...a, value: eq[1]! });
        else if (!a.value.startsWith("-")) word(a);
      }
    };
    if (DATA_ONLY.has(name)) continue;
    if (name === "xargs") {
      let k = 0;
      while (args[k] && args[k]!.value.startsWith("-")) k += /^-[IdnLPsEa]$/.test(args[k]!.value) ? 2 : 1;
      const rest = args.slice(k).map((a) => a.raw).join(" ");
      if (rest.trim()) out.push(...absolutePathArgs(rest, depth + 1));
      continue;
    }
    if (name === "test" || name === "[" || name === "[[") {
      args.forEach((a, k) => {
        if (FILE_TEST.test(a.value)) word(args[k + 1]);
      });
      continue;
    }
    if (name === "find") {
      // Start points, then an expression of patterns and actions.
      let k = 0;
      while (args[k] && !/^[-!(]/.test(args[k]!.value)) word(args[k++]);
      continue;
    }
    if (SCRIPT_FIRST[name]) {
      const spec = SCRIPT_FIRST[name]!;
      let scriptGiven = false;
      const operands: ShellWord[] = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k]!.value;
        if (a === "--") {
          operands.push(...args.slice(k + 1));
          break;
        }
        if (spec.script.source !== "^$" && spec.script.test(a)) {
          scriptGiven = true;
          k++;
        } else if (spec.file?.test(a)) {
          scriptGiven = true;
          word(args[++k]);
        } else if (spec.valued.test(a)) k++;
        else if (name === "jq" && /^--(arg|argjson)$/.test(a)) k += 2;
        else if (name === "jq" && /^--(slurpfile|rawfile)$/.test(a)) {
          word(args[k + 2]);
          k += 2;
        } else if (a.startsWith("-") && a.length > 1) {
          // `-e'expr'` glued, `--regexp=x`: the script, given inline.
          if (/^-e./.test(a) && name !== "jq") scriptGiven = true;
        } else operands.push(args[k]!);
      }
      // awk `var=value` operands are assignments, not files.
      const files = (scriptGiven ? operands : operands.slice(1)).filter((o) => !/^[A-Za-z_]\w*=/.test(o.value));
      for (const f of files) word(f);
      continue;
    }
    if (SHELLS.test(name) || name === "eval") {
      const k = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.value));
      if (name === "eval") out.push(...absolutePathArgs(args.map((a) => a.value).join(" "), depth + 1));
      else if (k >= 0) {
        if (args[k + 1]) out.push(...absolutePathArgs(args[k + 1]!.value, depth + 1));
      } else {
        generic(args.slice(0, 1));
        for (const h of c.heredocs) out.push(...absolutePathArgs(h, depth + 1));
      }
      continue;
    }
    if (INLINE[name]) {
      const opt = INLINE[name]!;
      const k = args.findIndex((a) => opt.test(a.value));
      if (k >= 0) {
        if (args[k + 1]) program(args[k + 1]!.value);
        // python3 -c '…' arg1 arg2: what follows is the program's argv.
        generic(args.slice(k + 2));
        generic(args.slice(0, k).filter((a) => !/^-[mW]$/.test(a.value)));
      } else {
        // The script is the first operand; a `-m module` is not a file.
        const m = args.findIndex((a) => a.value === "-m");
        generic(m >= 0 ? args.slice(0, m) : args);
        for (const h of c.heredocs) program(h);
      }
      continue;
    }
    generic(args);
  }
  return out;
}
