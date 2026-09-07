/**
 * A receipt that proves a change happened, and shows what it was.
 *
 * On 2026-09-07 a turn was accepted at 11 of 11 checks having quietly made a
 * message less specific than the evidence allowed. Every check passed. No
 * check could have seen it — "this discards information molt already had" is
 * not a property any of them measures — and it was caught only because a
 * person read the change.
 *
 * That is the residual no harness removes, so the useful move is not another
 * check: it is making the reading cheap. The receipt proved the change with
 * two hashes and then said "read the diff", meaning `git diff` — the wrong
 * instrument twice over. It shows the working tree rather than this turn, and
 * that day this repository had three agents writing to it, so what git showed
 * was attributable to nobody.
 *
 * molt has what git cannot supply here: the ledger records which lines each
 * tool call wrote. The receipt shows those.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Receipts } from "../src/receipts.js";
import { workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws(): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

function receipt(
  dir: string,
  changed: { path: string; before: string | null; after: string; lines?: number[] }[],
): string {
  const r = new Receipts(dir);
  const out = r.write({
    claim: "did the thing",
    result: { ok: true, results: [], durationMs: 1 },
    attempt: 1,
    verdict: "accepted",
    model: "m",
    provider: "p",
    sessionTokens: 1,
    shedBatches: 0,
    cwd: dir,
    changed,
  } as never);
  return readFileSync(typeof out === "string" ? out : (out as { path: string }).path, "utf8");
}

describe("a receipt shows the lines the turn wrote", () => {
  it("prints them, with their numbers, from the file molt wrote", () => {
    const dir = ws();
    const body = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    writeFileSync(join(dir, "a.ts"), body);
    const text = receipt(dir, [{ path: "a.ts", before: null, after: sha(body), lines: [2, 3] }]);

    assert.match(text, /## What the model wrote/);
    assert.match(text, /const b = 2;/);
    assert.match(text, /const c = 3;/);
    assert.doesNotMatch(text, /const a = 1;/, "only the lines this turn wrote");
    assert.match(text, /2 │/, "numbered, so it can be found in the file");
  });

  /**
   * The load-bearing refusal. Line numbers index the file as it stood at the
   * write; if anything has changed it since, those indices point at text this
   * turn did not write. Printing that under "what the model wrote" would be
   * the exact fabrication this file exists to prevent — and the multi-writer
   * tree that prompted the section is where it would happen.
   */
  it("refuses to show lines from a file that has changed since", () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "const a = 1;\nconst b = 2;\n");
    const stale = sha("something molt wrote earlier");
    const text = receipt(dir, [{ path: "a.ts", before: null, after: stale, lines: [1, 2] }]);

    assert.match(text, /changed since molt wrote it/);
    assert.doesNotMatch(text, /const b = 2;/, "content that is not what molt wrote is not shown");
    assert.match(text, /hashes above are what can still be proven/);
  });

  it("says so rather than inventing when the file is gone", () => {
    const dir = ws();
    const text = receipt(dir, [
      { path: "vanished.ts", before: null, after: sha("x"), lines: [1] },
    ]);
    assert.match(text, /gone from disk/);
  });

  it("adds nothing when the ledger recorded no lines", () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
    const text = receipt(dir, [{ path: "a.ts", before: null, after: sha("const a = 1;\n") }]);
    assert.doesNotMatch(text, /## What the model wrote/);
  });

  it("marks a gap rather than letting distant edits read as adjacent", () => {
    const dir = ws();
    const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    writeFileSync(join(dir, "a.ts"), body);
    const text = receipt(dir, [{ path: "a.ts", before: null, after: sha(body), lines: [2, 30] }]);
    const block = text.slice(text.indexOf("## What the model wrote"));
    assert.match(block, /…/, "a jump from line 2 to line 30 must not look contiguous");
  });

  it("bounds itself, so a large turn does not bury the verdict", () => {
    const dir = ws();
    const body = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    writeFileSync(join(dir, "a.ts"), body);
    const lines = Array.from({ length: 400 }, (_, i) => i + 1);
    const text = receipt(dir, [{ path: "a.ts", before: null, after: sha(body), lines }]);
    assert.match(text, /more changed line\(s\) in this file/);
    const shown = (text.match(/^\s*\d+ │/gm) ?? []).length;
    assert.ok(shown <= 120, `printed ${shown} lines; a receipt has to stay readable`);
  });
});

/**
 * A test that matches source text can pass while the thing it names is broken.
 *
 * Receipt 0062 wired the `claude-code` shorthand into the window and pinned it
 * with assertions like
 *
 *     /return typed \? endpointProblem\(endpointFieldValue\(\)\) : null;/
 *
 * which still passes if `endpointFieldValue` quietly stops expanding: the line
 * it matches never changes. It pinned a call site while reading like it pinned
 * behaviour, and `mutation` cannot catch it, because the assertion runs against
 * a string read off disk rather than executed code.
 *
 * The cure is not a better regex, it is a function a test can call — the same
 * move that produced ui/markdown.ts, ui/wait-words.ts and src/endpoint.ts. What
 * stays in app.ts is wiring, and wiring is the one thing a source assertion is
 * the honest tool for.
 */
describe("the endpoint guard is run, not matched", () => {
  it("answers for every shape the box can hold", async () => {
    const { typedEndpointProblem } = await import("../src/endpoint.js");
    assert.equal(typedEndpointProblem("claude-code"), null, "the shorthand is an endpoint");
    assert.equal(typedEndpointProblem("  claude-code  "), null, "however it is spaced");
    assert.equal(typedEndpointProblem("https://api.openai.com/v1"), null);
    assert.equal(typedEndpointProblem("http://localhost:11434/v1"), null);
    assert.equal(typedEndpointProblem(""), null, "an empty box is not a problem yet");
    assert.equal(typedEndpointProblem("   "), null, "nor is a box of spaces");
    assert.match(typedEndpointProblem("claude-cod") ?? "", /is not an endpoint/);
    assert.match(typedEndpointProblem("ftp://x/v1") ?? "", /ftp/);
  });

  /**
   * The mutation this guards against, written out. Break the expansion and the
   * shorthand stops being an endpoint — which the old source-matching
   * assertion would not have noticed.
   */
  it("fails if the expansion is ever dropped", async () => {
    const { endpointProblem, expandEndpointShorthand } = await import("../src/endpoint.js");
    const withExpansion = endpointProblem(expandEndpointShorthand("claude-code"));
    const without = endpointProblem("claude-code");
    assert.equal(withExpansion, null);
    assert.ok(without, "the two paths must not agree, or the test proves nothing");
  });
});
