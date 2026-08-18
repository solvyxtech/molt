/**
 * The prompt line, as a value.
 *
 * molt's input used to be a bare string with an implicit caret at the end, so
 * the only way to fix a typo three words back was to delete everything after
 * it. Editing needs a caret, and a caret needs somewhere to live.
 *
 * Kept here, pure and free of Ink, for the same reason the command palette is:
 * off-by-one caret arithmetic is the kind of bug that survives a hundred
 * manual tries and then eats a sentence, and it can only be pinned down by a
 * test that reads like the keystrokes it models.
 *
 * Every operation returns a new line and clamps the caret into range, so no
 * caller can produce a caret outside the text it points into.
 */

export type Line = {
  text: string;
  /** Caret offset: 0 is before the first character, text.length is past the last. */
  at: number;
};

export const EMPTY: Line = { text: "", at: 0 };

const clamp = (n: number, max: number): number => Math.max(0, Math.min(n, max));

/** A line from a string, caret at the end unless placed. */
export function line(text: string, at = text.length): Line {
  return { text, at: clamp(at, text.length) };
}

export function insert(l: Line, s: string): Line {
  const at = clamp(l.at, l.text.length);
  return { text: l.text.slice(0, at) + s + l.text.slice(at), at: at + s.length };
}

/** Delete the character before the caret — what backspace does. */
export function backspace(l: Line): Line {
  const at = clamp(l.at, l.text.length);
  // Even the do-nothing paths return a clamped caret: a caller that handed in
  // a stale offset must not get it back, or the next edit lands on the wrong
  // character.
  if (at === 0) return { ...l, at };
  return { text: l.text.slice(0, at - 1) + l.text.slice(at), at: at - 1 };
}

/** Delete the character under the caret — what the delete key does. */
export function deleteForward(l: Line): Line {
  const at = clamp(l.at, l.text.length);
  if (at >= l.text.length) return { ...l, at };
  return { text: l.text.slice(0, at) + l.text.slice(at + 1), at };
}

export function left(l: Line): Line {
  return { ...l, at: clamp(l.at - 1, l.text.length) };
}

export function right(l: Line): Line {
  return { ...l, at: clamp(l.at + 1, l.text.length) };
}

export function home(l: Line): Line {
  return { ...l, at: 0 };
}

export function end(l: Line): Line {
  return { ...l, at: l.text.length };
}

/**
 * Delete the word before the caret, including the whitespace that led to it.
 * A word is a run of non-space characters, so a path or a flag goes in one
 * stroke rather than a dozen.
 */
export function deleteWord(l: Line): Line {
  const at = clamp(l.at, l.text.length);
  if (at === 0) return { ...l, at };
  let i = at;
  while (i > 0 && /\s/.test(l.text[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(l.text[i - 1]!)) i--;
  return { text: l.text.slice(0, i) + l.text.slice(at), at: i };
}

/**
 * Move by words, the way every other prompt does.
 *
 * `deleteWord` existed and the movements did not, so a long line could be
 * chopped but not traversed — you could delete "src/app.tsx" in one stroke and
 * then had to arrow back over it a character at a time to get in front of it.
 */
export function wordLeft(l: Line): Line {
  const at = clamp(l.at, l.text.length);
  let i = at;
  while (i > 0 && /\s/.test(l.text[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(l.text[i - 1]!)) i--;
  return { ...l, at: i };
}

export function wordRight(l: Line): Line {
  const at = clamp(l.at, l.text.length);
  let i = at;
  while (i < l.text.length && /\s/.test(l.text[i]!)) i++;
  while (i < l.text.length && !/\s/.test(l.text[i]!)) i++;
  return { ...l, at: i };
}

/** Delete the word ahead of the caret, and the whitespace before it. */
export function deleteWordForward(l: Line): Line {
  const at = clamp(l.at, l.text.length);
  const to = wordRight({ ...l, at }).at;
  if (to === at) return { ...l, at };
  return { text: l.text.slice(0, at) + l.text.slice(to), at };
}

/** Drop everything from the caret to the end of the line. */
export function killToEnd(l: Line): Line {
  const at = clamp(l.at, l.text.length);
  return { text: l.text.slice(0, at), at };
}

/** Drop everything before the caret, keeping what is ahead of it. */
export function killToStart(l: Line): Line {
  const at = clamp(l.at, l.text.length);
  return { text: l.text.slice(at), at: 0 };
}

/**
 * The line split for rendering: what is behind the caret, what sits under it,
 * and what follows.
 *
 * `under` is a single space when the caret is past the end, so a block caret
 * can be drawn the same way in both cases rather than the renderer having to
 * special-case the end of the line.
 */
export function split(l: Line): { before: string; under: string; after: string; atEnd: boolean } {
  const at = clamp(l.at, l.text.length);
  const atEnd = at >= l.text.length;
  return {
    before: l.text.slice(0, at),
    under: atEnd ? " " : l.text[at]!,
    after: atEnd ? "" : l.text.slice(at + 1),
    atEnd,
  };
}
