/**
 * Tool-argument JSON as models write it (src/lenient-json.ts): raw line
 * breaks inside strings and backslashes that start no escape are repaired;
 * anything whose intent is no longer certain still fails.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandAct } from "../src/engine.js";
import { parseLenient } from "../src/lenient-json.js";

describe("parseLenient", () => {
  it("escapes raw control characters inside strings, and only there", () => {
    assert.deepEqual(parseLenient('{"content": "line one\nline two\ttab"}'), { content: "line one\nline two\ttab" });
    assert.deepEqual(parseLenient('{\n  "a": 1\n}'), { a: 1 });
  });

  it("keeps a backslash that starts no JSON escape as a literal backslash", () => {
    assert.deepEqual(parseLenient('{"pattern": "\\d+\\.\\d+", "ok": "\\n\\u0041"}'), { pattern: "\\d+\\.\\d+", ok: "\nA" });
  });

  it("does not guess at a truncated or unbalanced object", () => {
    assert.throws(() => parseLenient('{"content": "abc'));
    assert.throws(() => parseLenient('{"a": 1'));
  });
});

// Nemotron on local csv-clean: actions arrived as a string whose inner JSON
// had the script's own line breaks raw, and a regex escape; thirty acts in a
// row were "unreadable" and nothing was ever written.
describe("an act whose action list is a string of not-quite-JSON", () => {
  it("is read, and runs the write it holds", () => {
    const inner = '[{"tool": "write_file", "args": {"path": "clean.py", "content": "import re\nprint(re.sub(r\'\\s+\', \' \', \'a  b\'))\n"}}]';
    const e = expandAct({ id: "c", function: { name: "act", arguments: JSON.stringify({ analysis: "write it", actions: inner }) } });
    assert.ok(e);
    assert.equal(e.unusable, 0);
    assert.deepEqual(e.subs.map((s) => s.name), ["write_file"]);
    assert.equal((JSON.parse(e.subs[0]!.rawArgs) as { content: string }).content, "import re\nprint(re.sub(r'\\s+', ' ', 'a  b'))\n");
  });
});
