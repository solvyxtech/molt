/**
 * Does a check change the work it is supposed to judge?
 *
 * A check reads. On 2026-10-07 a drafted check was sealed as
 * `git checkout master && git merge --no-ff -m '…' about.md`: running it
 * switched the branch and tried to make the merge the task asked for. A
 * check that writes can pass because it did the work, fail because it
 * undid it, or leave the tree different from the one the receipt
 * describes, and the order the checks ran in decides which.
 *
 * This reads the command, never runs it. It knows the shell well enough to
 * ignore what is quoted (an awk `>` is not a redirect), to follow a `cd`
 * into a directory made with `mktemp` (work there touches nothing of the
 * project), and to let writes to /tmp, `$TMPDIR` and /dev/null through.
 * Everything it misses is still harmless to the work: task checks run
 * against a throwaway copy of the tree (src/scratch.ts). This is the
 * cheaper, earlier half: a mutating check is sent back to be redrafted
 * instead of sealed.
 */

/** Same length as the input; quoted text and `$((…))` replaced by `_`, so offsets line up. */
export function maskQuoted(cmd: string): string {
  const out = cmd.split("");
  // Each frame is a context: plain code, a "…" string, or `$(…)` inside one.
  type Frame = { kind: "code" | "dq" | "subst"; depth: number };
  const stack: Frame[] = [{ kind: "code", depth: 0 }];
  for (let i = 0; i < cmd.length; i++) {
    const top = stack[stack.length - 1]!;
    const ch = cmd[i]!;
    if (top.kind === "dq") {
      if (ch === "\\") {
        out[i] = "_";
        if (i + 1 < cmd.length) out[++i] = "_";
      } else if (ch === '"') stack.pop();
      else if (ch === "$" && cmd[i + 1] === "(" && cmd[i + 2] !== "(") {
        // Command substitution inside a string is code again.
        stack.push({ kind: "subst", depth: 0 });
        i += 1;
      } else out[i] = "_";
      continue;
    }
    // code or subst
    if (ch === "\\") {
      out[i] = "_";
      if (i + 1 < cmd.length) out[++i] = "_";
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== "'") out[j++] = "_";
      i = j;
      continue;
    }
    if (ch === '"') {
      stack.push({ kind: "dq", depth: 0 });
      continue;
    }
    if (ch === "[" && cmd[i + 1] === "[") {
      // `[[ a > b ]]` compares strings.
      const end = cmd.indexOf("]]", i + 2);
      for (let j = i + 2; j < (end < 0 ? cmd.length : end); j++) if (cmd[j] === ">" || cmd[j] === "<") out[j] = "_";
      continue;
    }
    if ((ch === "$" && cmd[i + 1] === "(" && cmd[i + 2] === "(") || (ch === "(" && cmd[i + 1] === "(" && /(^|[\s;&|])$/.test(cmd.slice(0, i)))) {
      // Arithmetic, `$((…))` or `((…))`: `>` there compares.
      let depth = 0;
      let j = ch === "$" ? i + 1 : i;
      for (; j < cmd.length; j++) {
        if (cmd[j] === "(") depth++;
        else if (cmd[j] === ")" && --depth === 0) break;
        else out[j] = "_";
      }
      i = j;
      continue;
    }
    if (top.kind === "subst") {
      if (ch === "(") top.depth++;
      else if (ch === ")") {
        if (top.depth === 0) {
          stack.pop();
          continue;
        }
        top.depth--;
      }
    }
  }
  return out.join("");
}

/** Variables the command fills from mktemp: `d=$(mktemp -d)`, `t="$(mktemp)"`, backticks too. */
function tempVars(cmd: string): Set<string> {
  const out = new Set(["TMPDIR", "TMP", "TEMP", "TEMPDIR"]);
  for (const m of cmd.matchAll(/\b([A-Za-z_]\w*)=["']?(?:\$\(|`)\s*mktemp\b/g)) out.add(m[1]!);
  return out;
}

/**
 * The value a shell gives one word: single quotes kept verbatim, double
 * quotes with their backslash escapes undone, bare backslashes dropped.
 * Enough to read a `bash -c '…'` payload; not a full shell.
 */
function shellWordValue(word: string): string {
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]!;
    if (ch === "'") {
      const end = word.indexOf("'", i + 1);
      out += word.slice(i + 1, end < 0 ? word.length : end);
      i = end < 0 ? word.length : end;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < word.length && word[j] !== '"'; j++) {
        if (word[j] === "\\" && /["\\$`]/.test(word[j + 1] ?? "")) j++;
        out += word[j];
      }
      i = j;
    } else if (ch === "\\") {
      out += word[++i] ?? "";
    } else out += ch;
  }
  return out;
}

function unquote(word: string): string {
  return word.replace(/^(["'])(.*)\1$/s, "$2").replace(/["']/g, "");
}

/** A path a check may write to without touching the project. */
export function isScratchPath(word: string, temps: Set<string>): boolean {
  const w = unquote(word.trim());
  if (!w) return false;
  if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(w)) return true;
  if (/^\/(private\/)?tmp(\/|$)/.test(w) || /^\/var\/folders\//.test(w) || /^\/var\/tmp(\/|$)/.test(w)) return true;
  const v = /^\$\{?([A-Za-z_]\w*)/.exec(w);
  if (v && temps.has(v[1]!)) return true;
  if (/^\$\(\s*mktemp\b/.test(w) || /^`\s*mktemp\b/.test(w)) return true;
  return false;
}

type Word = { text: string; at: number };

/** Split a segment into words on whitespace that is not quoted. */
function words(raw: string, masked: string, offset: number): Word[] {
  const out: Word[] = [];
  const re = /\S+/g;
  for (const m of masked.matchAll(re)) {
    const at = m.index ?? 0;
    out.push({ text: raw.slice(at, at + m[0].length), at: offset + at });
  }
  return out;
}

/** Leading words that run the next word as the command. */
const PREFIX = new Set(["{", "}", "then", "do", "else", "elif", "if", "while", "until", "!", "time", "sudo", "exec", "command", "nohup", "builtin", "nice", "timeout", "stdbuf"]);

const GIT_MUTATING = new Set([
  "checkout", "switch", "restore", "merge", "rebase", "cherry-pick", "revert", "reset", "commit", "add", "rm", "mv",
  "clean", "am", "pull", "fetch", "push", "gc", "prune", "repack", "init", "update-ref", "update-index", "read-tree",
  "checkout-index", "filter-branch", "bisect", "replace", "mergetool", "submodule", "worktree", "notes", "stash",
  "apply", "tag", "branch", "config", "symbolic-ref", "hash-object", "clone", "cherry", "pack-refs", "reflog",
]);

const INSTALLERS: Record<string, RegExp> = {
  pip: /^(install|uninstall|download)$/,
  pip3: /^(install|uninstall|download)$/,
  pipx: /^(install|uninstall|inject)$/,
  uv: /^(pip|add|remove|sync|tool)$/,
  poetry: /^(add|install|remove|update|lock)$/,
  npm: /^(i|install|ci|add|uninstall|remove|rm|update|up|link)$/,
  pnpm: /^(i|install|add|remove|rm|update|up|link)$/,
  yarn: /^(add|install|remove|upgrade|link)$/,
  bun: /^(i|install|add|remove|update|link)$/,
  gem: /^(install|uninstall|update)$/,
  cargo: /^(install|add|remove|update)$/,
  go: /^(get|install|mod)$/,
  "apt-get": /^(install|remove|purge|upgrade|update)$/,
  apt: /^(install|remove|purge|upgrade|update)$/,
  brew: /^(install|uninstall|upgrade|reinstall|link)$/,
  conda: /^(install|remove|update|create)$/,
  mamba: /^(install|remove|update|create)$/,
  dnf: /^(install|remove|upgrade|update)$/,
  yum: /^(install|remove|upgrade|update)$/,
  apk: /^(add|del|upgrade|update)$/,
  composer: /^(install|require|update|remove)$/,
};

const isFlag = (w: string) => /^-/.test(w);

/**
 * Why this command would change the work, or null when it only reads (as far
 * as reading the command can tell).
 */
export function checkMutates(cmd: string, outer?: { temps: Set<string>; depth: number }): string | null {
  const masked = maskQuoted(cmd);
  const temps = tempVars(cmd);
  // A nested shell sees the variables the outer command filled from mktemp.
  for (const t of outer?.temps ?? []) temps.add(t);
  const depth = outer?.depth ?? 0;

  // Where the command has `cd`-ed into a scratch directory, and for how long:
  // a subshell's cd ends with the subshell.
  const inScratch: boolean[] = new Array(cmd.length + 1).fill(false);
  {
    let depth = 0;
    let scratchDepth = -1;
    for (let i = 0; i < masked.length; i++) {
      const ch = masked[i]!;
      if (ch === "(") depth++;
      if (ch === ")") {
        depth--;
        if (scratchDepth > depth) scratchDepth = -1;
      }
      const atWord = i === 0 || /[\s;&|(){}`]/.test(masked[i - 1]!);
      if (atWord && /^(?:cd|pushd)\s/.test(masked.slice(i, i + 6))) {
        const rest = /^(?:cd|pushd)\s+(\S+)/.exec(masked.slice(i));
        if (rest) {
          const target = cmd.slice(i + rest[0].length - rest[1]!.length, i + rest[0].length);
          if (isScratchPath(target, temps)) scratchDepth = scratchDepth === -1 ? depth : Math.min(scratchDepth, depth);
          // A relative cd inside the scratch directory stays in it; anywhere else leaves it.
          else if (/^(-|~|\/|\$)/.test(unquote(target))) scratchDepth = -1;
        }
      }
      inScratch[i] = scratchDepth !== -1;
    }
  }

  // Simple commands: split at the shell's own separators, outside quotes.
  const segs: { raw: string; masked: string; at: number; viaXargs: boolean }[] = [];
  {
    const sep = /&&|\|\||[;&|\n()`]|\$\(/g;
    let last = 0;
    const push = (end: number) => {
      if (end > last) segs.push({ raw: cmd.slice(last, end), masked: masked.slice(last, end), at: last, viaXargs: false });
    };
    for (const m of masked.matchAll(sep)) {
      const at = m.index ?? 0;
      // `2>&1`, `&>` and `>&2` are redirects, not separators.
      if (m[0] === "&" && (masked[at - 1] === ">" || masked[at + 1] === ">")) continue;
      push(at);
      last = at + m[0].length;
    }
    push(cmd.length);
  }

  for (const seg of segs) {
    // Redirects first: `> file`, `>> file`, `&> file`, `2> file`. `>&2` duplicates a descriptor.
    const redirects = [...seg.masked.matchAll(/(\d*|&)(>>?|>\|)(\s*)/g)];
    const consumed = new Set<number>();
    for (const r of redirects) {
      const start = (r.index ?? 0) + r[0].length;
      if (seg.masked[start] === "&" || seg.masked[start] === "(") continue;
      const tm = /^\S+/.exec(seg.masked.slice(start));
      if (!tm) continue;
      const target = seg.raw.slice(start, start + tm[0].length);
      for (let k = r.index ?? 0; k < start + tm[0].length; k++) consumed.add(k);
      if (!isScratchPath(target, temps) && !inScratch[seg.at + start]) {
        return `it writes to ${unquote(target)} with a redirect; a check only reads (write to a mktemp directory instead)`;
      }
    }
    // Input redirects (`< file`, `<< EOF`, `<<< word`) only read, and their
    // target is not an operand: `xargs rm < files.txt` deletes what the file
    // lists, not a file called `<`.
    for (const r of seg.masked.matchAll(/(\d*)(<<<|<<-?|<)(?![<>&(])(\s*)/g)) {
      const start = (r.index ?? 0) + r[0].length;
      const tm = /^\S+/.exec(seg.masked.slice(start));
      const end = start + (tm ? tm[0].length : 0);
      for (let k = r.index ?? 0; k < end; k++) consumed.add(k);
    }
    // The words of the command, without its redirects.
    const keptRaw = seg.raw.split("").map((c, k) => (consumed.has(k) ? " " : c)).join("");
    const keptMasked = seg.masked.split("").map((c, k) => (consumed.has(k) ? " " : c)).join("");
    let ws = words(keptRaw, keptMasked, seg.at);
    let viaXargs = false;
    // Peel off what only runs the next word: keywords, assignments, env, xargs and their flags.
    for (;;) {
      const w = ws[0];
      if (!w) break;
      if (PREFIX.has(w.text)) {
        ws = ws.slice(1);
        if (w.text === "timeout") while (ws[0] && (isFlag(ws[0].text) || /^\d/.test(ws[0].text))) ws = ws.slice(1);
        continue;
      }
      if (/^[A-Za-z_]\w*=/.test(w.text)) {
        ws = ws.slice(1);
        continue;
      }
      if (w.text === "env") {
        ws = ws.slice(1);
        while (ws[0] && (isFlag(ws[0].text) || /^[A-Za-z_]\w*=/.test(ws[0].text))) ws = ws.slice(1);
        continue;
      }
      if (w.text === "xargs") {
        viaXargs = true;
        ws = ws.slice(1);
        while (ws[0] && isFlag(ws[0].text)) ws = ws.slice(/^-[IdnLPsE]$/.test(ws[0].text) ? 2 : 1);
        continue;
      }
      break;
    }
    const head = ws[0];
    if (!head) continue;
    const name = unquote(head.text).replace(/^.*\//, "");
    const args = ws.slice(1);
    const here = inScratch[head.at] === true;
    const scratch = (w: Word) => isScratchPath(w.text, temps) || (inScratch[w.at] === true && !/^\/|^~/.test(unquote(w.text)));
    const operands = args.filter((a) => !isFlag(a.text));
    const quoteOne = (w: Word | undefined) => (w ? unquote(w.text) : "its input");
    // xargs supplies the operands from a pipe: nothing can be said about them.
    const allScratch = (ops: Word[]) => !viaXargs && ops.every(scratch);

    // A shell run on a string, and eval: the payload is a command of its own,
    // quoted here and so invisible to everything above. Read it the same way.
    if (!here && depth < 4) {
      let payload: string | undefined;
      if (/^(ba|da|z|k)?sh$/.test(name)) {
        const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text));
        if (c >= 0 && args[c + 1]) payload = shellWordValue(args[c + 1]!.text);
      } else if (name === "eval") {
        payload = args.map((a) => shellWordValue(a.text)).join(" ");
      }
      if (payload !== undefined && payload.trim()) {
        const inner = checkMutates(payload, { temps, depth: depth + 1 });
        if (inner) return `${inner} (inside \`${name === "eval" ? "eval" : `${name} -c`}\`)`;
      }
    }

    switch (name) {
      case "rm":
      case "rmdir":
      case "unlink":
      case "shred":
        if (!allScratch(operands)) return `it deletes ${quoteOne(operands.find((o) => !scratch(o)))} (\`${name}\`); a check only reads`;
        break;
      case "mv":
        if (!allScratch(operands)) return `it moves ${quoteOne(operands.find((o) => !scratch(o)))} (\`mv\`); a check only reads`;
        break;
      case "cp":
      case "install":
      case "rsync":
      case "ln": {
        const dest = operands[operands.length - 1];
        if (viaXargs || (dest && !scratch(dest))) return `it writes ${quoteOne(dest)} (\`${name}\`); copy into a mktemp directory instead`;
        break;
      }
      case "touch":
      case "mkdir":
      case "mkfifo":
        if (!allScratch(operands)) return `it creates ${quoteOne(operands.find((o) => !scratch(o)))} (\`${name}\`) in the project; a check only reads`;
        break;
      case "chmod":
      case "chown":
      case "chgrp":
        if (!allScratch(operands.slice(1))) return `it changes permissions on ${quoteOne(operands.slice(1).find((o) => !scratch(o)))} (\`${name}\`); a check only reads`;
        break;
      case "truncate": {
        const f = operands[operands.length - 1];
        if (viaXargs || (f && !scratch(f))) return `it truncates ${quoteOne(f)}; a check only reads`;
        break;
      }
      case "tee":
        if (!allScratch(operands)) return `it writes ${quoteOne(operands.find((o) => !scratch(o)))} with tee; a check only reads (tee into a mktemp file instead)`;
        break;
      case "dd": {
        const of = args.find((a) => /^of=/.test(unquote(a.text)));
        if (of && !isScratchPath(unquote(of.text).slice(3), temps) && !here) return `it writes ${unquote(of.text).slice(3)} with dd; a check only reads`;
        break;
      }
      case "sed":
      case "perl":
      case "ruby": {
        const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a.text) || /^--in-place/.test(a.text));
        const f = operands[operands.length - 1];
        if (inPlace && (viaXargs || !f || !scratch(f))) return `it edits ${quoteOne(f)} in place (\`${name} -i\`); a check only reads`;
        break;
      }
      case "patch":
        if (!args.some((a) => /^--dry-run$|^-C$|^--check$/.test(a.text)) && !here) return "it applies a patch to the project; a check only reads";
        break;
      case "find":
        if (!here && !(operands[0] && scratch(operands[0]))) {
          if (args.some((a) => a.text === "-delete")) return "it deletes files (`find -delete`); a check only reads";
          const ex = args.findIndex((a) => a.text === "-exec" || a.text === "-execdir" || a.text === "-ok");
          if (ex >= 0 && /^(rm|mv|cp|sed|chmod|touch|truncate|tee|ln|git)$/.test(unquote(args[ex + 1]?.text ?? "").replace(/^.*\//, ""))) {
            return `it runs ${unquote(args[ex + 1]!.text)} on the files it finds (\`find -exec\`); a check only reads`;
          }
        }
        break;
      case "git": {
        let i = 0;
        let elsewhere = false;
        while (i < args.length && isFlag(args[i]!.text)) {
          const f = args[i]!.text;
          if (f === "-C") {
            elsewhere = isScratchPath(args[i + 1]?.text ?? "", temps);
            i += 2;
          } else if (f === "-c") i += 2;
          else if (/^--(git-dir|work-tree)=/.test(f)) {
            elsewhere = isScratchPath(f.replace(/^--[\w-]+=/, ""), temps);
            i += 1;
          } else i += 1;
        }
        const sub = unquote(args[i]?.text ?? "");
        const rest = args.slice(i + 1).map((a) => unquote(a.text));
        const pos = rest.filter((a) => !isFlag(a));
        if (here || elsewhere || !GIT_MUTATING.has(sub)) break;
        const has = (re: RegExp) => rest.some((a) => re.test(a));
        let reads = false;
        switch (sub) {
          case "stash":
            reads = /^(list|show)$/.test(pos[0] ?? "");
            break;
          case "apply":
            reads = has(/^--(check|stat|numstat|summary)$/);
            break;
          case "tag":
            reads = !has(/^-(d|a|s|f|m|u)$|^--(delete|annotate|sign|force)$/) && (pos.length === 0 || has(/^(-l|--list|--contains|--points-at|--merged|--no-merged|-n\d*)$/));
            break;
          case "branch":
            reads = !has(/^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)/) &&
              (pos.length === 0 || has(/^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at|-a|-r|--all|--remotes|-v|-vv|--show-current)$/));
            break;
          case "config":
            reads = !has(/^--(unset|unset-all|add|replace-all|rename-section|remove-section|edit)$|^-e$/) &&
              (has(/^--(get|get-all|get-regexp|get-urlmatch|list|show-origin)$|^-l$/) || pos.length < 2);
            break;
          case "symbolic-ref":
            reads = pos.length < 2;
            break;
          case "hash-object":
            reads = !has(/^-w$/);
            break;
          case "notes":
            reads = !/^(add|append|edit|remove|prune|copy|merge)$/.test(pos[0] ?? "");
            break;
          case "worktree":
            reads = pos[0] === "list";
            break;
          case "submodule":
            reads = pos.length === 0 || /^(status|summary|foreach)$/.test(pos[0] ?? "");
            break;
          case "reflog":
            reads = !/^(expire|delete)$/.test(pos[0] ?? "");
            break;
          case "bisect":
            reads = /^(log|visualize|view)$/.test(pos[0] ?? "");
            break;
          case "clone":
            reads = pos.length >= 2 && isScratchPath(args[args.length - 1]!.text, temps);
            break;
          case "cherry":
            reads = true;
            break;
          case "fetch":
            reads = has(/^--dry-run$/);
            break;
        }
        if (!reads) return `it runs \`git ${sub}\`, which changes the repository; a check only reads`;
        break;
      }
      default: {
        // Package installs change the environment the next check runs in.
        let tool = name;
        let sub = unquote(operands[0]?.text ?? "");
        if (/^python[\d.]*$/.test(name) && args[0]?.text === "-m" && /^pip3?$/.test(args[1]?.text ?? "")) {
          tool = "pip";
          sub = unquote(args.slice(2).find((a) => !isFlag(a.text))?.text ?? "");
        }
        const re = INSTALLERS[tool];
        if (re && re.test(sub)) return `it installs or removes packages (\`${tool} ${sub}\`); a check only reads`;
      }
    }
  }
  return null;
}
