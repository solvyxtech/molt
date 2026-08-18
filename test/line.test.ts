/**
 * The prompt line.
 *
 * Reported from use: a typo three words back could only be fixed by deleting
 * everything after it. Caret arithmetic is where that fix goes wrong quietly,
 * so these read like the keystrokes they model.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  backspace,
  deleteForward,
  deleteWord,
  end,
  home,
  insert,
  killToEnd,
  killToStart,
  left,
  line,
  right,
  split,
  type Line,
} from "../src/line.js";

/** Render a line as "text" with a caret marker, so failures read at a glance. */
const show = (l: Line) => `${l.text.slice(0, l.at)}|${l.text.slice(l.at)}`;

/** Type a string one character at a time, the way a keyboard does. */
const type = (l: Line, s: string) => [...s].reduce((acc, ch) => insert(acc, ch), l);

describe("typing", () => {
  it("puts the caret after what was typed", () => {
    assert.equal(show(type(line(""), "fix the bug")), "fix the bug|");
  });

  it("inserts where the caret is, not at the end", () => {
    // The whole point: move back, fix it, and the rest of the line survives.
    let l = line("fix the bg");
    l = left(l); // before "g"
    l = insert(l, "u");
    assert.equal(show(l), "fix the bu|g");
    assert.equal(l.text, "fix the bug");
  });
});

describe("deleting", () => {
  it("backspace takes the character before the caret", () => {
    assert.equal(show(backspace(line("abc"))), "ab|");
    assert.equal(show(backspace(line("abc", 1))), "|bc");
  });

  it("backspace at the start of the line does nothing", () => {
    const l = line("abc", 0);
    assert.deepEqual(backspace(l), l);
  });

  it("delete takes the character under the caret", () => {
    assert.equal(show(deleteForward(line("abc", 1))), "a|c");
  });

  it("delete past the end does nothing", () => {
    const l = line("abc");
    assert.deepEqual(deleteForward(l), l);
  });

  it("deletes a word, and the space that led to it", () => {
    assert.equal(show(deleteWord(line("read src/app.tsx"))), "read |");
    assert.equal(show(deleteWord(line("read src/app.tsx "))), "read |");
    // Back to the previous whitespace, the way readline's ctrl+W does — the
    // space that separated the next word is not this word's to take.
    assert.equal(show(deleteWord(line("one two three", 7))), "one | three");
    const start = line("abc", 0);
    assert.deepEqual(deleteWord(start), start);
    assert.deepEqual(deleteWord(line("   ", 3)), line("", 0));
  });

  it("kills to the end and to the start, keeping the other half", () => {
    assert.equal(show(killToEnd(line("keep this drop this", 10))), "keep this |");
    assert.equal(show(killToStart(line("drop this keep this", 10))), "|keep this");
  });
});

describe("moving", () => {
  it("steps and stops at both edges", () => {
    assert.equal(show(left(line("ab", 0))), "|ab");
    assert.equal(show(right(line("ab"))), "ab|");
    assert.equal(show(left(line("ab"))), "a|b");
    assert.equal(show(right(line("ab", 0))), "a|b");
  });

  it("jumps to either end", () => {
    assert.equal(show(home(line("abc", 2))), "|abc");
    assert.equal(show(end(line("abc", 0))), "abc|");
  });
});

describe("clamping", () => {
  it("never lets the caret point outside the text", () => {
    // Every operation has to hold this, because one that does not produces a
    // caret that renders in the wrong place and edits the wrong character.
    const wild: Line = { text: "abc", at: 99 };
    for (const op of [left, right, home, end, backspace, deleteForward, deleteWord, killToEnd, killToStart]) {
      const out = op(wild);
      assert.ok(out.at >= 0 && out.at <= out.text.length, `${op.name} produced at=${out.at}`);
    }
    const negative: Line = { text: "abc", at: -5 };
    for (const op of [left, right, backspace, deleteForward, deleteWord, killToEnd, killToStart]) {
      const out = op(negative);
      assert.ok(out.at >= 0 && out.at <= out.text.length, `${op.name} produced at=${out.at}`);
    }
    assert.equal(line("abc", 99).at, 3);
    assert.equal(line("abc", -1).at, 0);
  });
});

describe("rendering", () => {
  it("gives the renderer three pieces and says which end it is at", () => {
    assert.deepEqual(split(line("abc", 1)), { before: "a", under: "b", after: "c", atEnd: false });
    assert.deepEqual(split(line("abc")), { before: "abc", under: " ", after: "", atEnd: true });
    assert.deepEqual(split(line("")), { before: "", under: " ", after: "", atEnd: true });
  });

  it("reassembles into exactly the text it came from", () => {
    for (const at of [0, 1, 5, 11]) {
      const l = line("fix the bug", at);
      const { before, under, after, atEnd } = split(l);
      assert.equal(before + (atEnd ? "" : under) + after, l.text);
    }
  });
});
