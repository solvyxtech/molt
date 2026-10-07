/**
 * JSON as models actually write it inside tool arguments.
 *
 * Two kinds of damage are common and unambiguous, and both appear in long
 * writes, where they cost the most: a raw newline or tab inside a string
 * (the file's own line breaks, unescaped), and a backslash that starts no
 * JSON escape (`\.` from a regex, `\d`, a Windows path). Strict JSON.parse
 * refuses both, and on 2026-10-05 Nemotron sent thirty acts in a row whose
 * nested action list failed that way — every one answered "could not be
 * read", none ever ran, and the task ended with nothing written.
 *
 * Repaired here: control characters inside strings are escaped, and a lone
 * backslash is kept as a literal backslash. Nothing else is guessed: a
 * truncated object, a missing quote or brace is still a failure, because
 * there the intent is no longer certain.
 */
export function parseLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (first) {
    const fixed = repairJson(text);
    if (fixed === text) throw first;
    return JSON.parse(fixed);
  }
}

/** Escape control characters inside strings and double backslashes that start no valid escape. */
export function repairJson(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      continue;
    }
    if (c === "\\") {
      const next = text[i + 1] ?? "";
      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        out += text.slice(i, i + 6);
        i += 5;
      } else if (next !== "" && '"\\/bfnrt'.includes(next)) {
        out += c + next;
        i += 1;
      } else {
        out += "\\\\";
      }
      continue;
    }
    if (c === '"') {
      inString = false;
      out += c;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 0x20) {
      out += c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += c;
  }
  return out;
}
