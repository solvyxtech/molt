/**
 * Listing, searching, and editing.
 *
 * The edit tool is the one to be strict about. A write that lands on the wrong
 * occurrence of a string looks exactly like a write that worked, and molt's
 * whole claim is that it does not hand you something that merely looks
 * finished — so an edit that cannot identify its target has to refuse rather
 * than pick.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  MAX_MATCHES,
  SEARCH_DEADLINE_MS,
  applyEdit,
  formatListing,
  formatMatches,
  globToRegExp,
  grepFiles,
  isCatastrophic,
  matchesGlob,
  walk,
} from "../src/files.js";
import { Engine } from "../src/engine.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

/** A small project to walk and search. */
function project(): { dir: string; cleanup: () => void } {
  const ws = workspace();
  mkdirSync(join(ws.dir, "src", "deep"), { recursive: true });
  mkdirSync(join(ws.dir, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(join(ws.dir, "dist"), { recursive: true });
  writeFileSync(join(ws.dir, "README.md"), "# project\nverify the thing\n");
  writeFileSync(join(ws.dir, "src", "auth.ts"), "export function verify(t: string) {\n  return t;\n}\n");
  writeFileSync(join(ws.dir, "src", "util.ts"), "export const noop = () => {};\n");
  writeFileSync(join(ws.dir, "src", "deep", "nested.ts"), "// verify deeper\n");
  writeFileSync(join(ws.dir, "node_modules", "left-pad", "index.js"), "verify in a dependency\n");
  writeFileSync(join(ws.dir, "dist", "bundle.js"), "verify in a build\n");
  return ws;
}

describe("globs", () => {
  it("means what everyone thinks it means", () => {
    assert.ok(matchesGlob("src/auth.ts", "**/*.ts"));
    assert.ok(matchesGlob("auth.ts", "**/*.ts"), "**/ must also match the top level");
    assert.ok(matchesGlob("src/deep/nested.ts", "src/**/*.ts"));
    assert.ok(matchesGlob("src/auth.ts", "*.ts"), "a bare pattern is a name filter");
    assert.ok(matchesGlob("src/a.ts", "src/?.ts"));
    assert.ok(!matchesGlob("src/auth.js", "**/*.ts"));
    assert.ok(!matchesGlob("src/deep/nested.ts", "src/*.ts"), "* must not cross a separator");
  });

  it("treats the rest of the pattern as literal", () => {
    // A pattern language with unpredictable corners is worse than a small one.
    assert.ok(globToRegExp("a.b").test("a.b"));
    assert.ok(!globToRegExp("a.b").test("axb"));
    assert.ok(globToRegExp("a+b(c)").test("a+b(c)"));
  });

  it("matches everything when there is no pattern", () => {
    assert.ok(matchesGlob("anything/at/all", undefined));
  });
});

describe("listing", () => {
  it("skips build output and dependencies, and says that it did", () => {
    const p = project();
    try {
      const r = walk(p.dir, { depth: 1 });
      const names = r.entries.map((e) => e.path);
      assert.ok(names.includes("README.md"));
      assert.ok(names.includes("src/"));
      assert.ok(!names.some((n) => n.startsWith("node_modules")), "walked into node_modules");
      assert.ok(!names.some((n) => n.startsWith("dist")), "walked into dist");
      assert.deepEqual(r.skipped.sort(), ["dist", "node_modules"]);

      // Silently invisible is not the same as skipped, so the listing says so.
      const text = formatListing(".", r);
      assert.match(text, /skipped 2 build\/dependency directories/);
      assert.match(text, /node_modules/);
    } finally {
      p.cleanup();
    }
  });

  it("lists molt's own directory but does not search it", async () => {
    // done.yml is the most relevant file in a molt project; hiding it from a
    // listing hides the bar the agent is judged against. The session logs
    // under it are prose, and searching them buries the answer in molt's own
    // record of looking for it.
    const p = project();
    try {
      mkdirSync(join(p.dir, ".molt", "log"), { recursive: true });
      writeFileSync(join(p.dir, ".molt", "done.yml"), "version: 1\nchecks: []\n");
      writeFileSync(join(p.dir, ".molt", "log", "s.jsonl"), '{"text":"verify"}\n');

      const listed = walk(p.dir, { depth: 2 }).entries.map((e) => e.path);
      assert.ok(listed.includes(".molt/"), "hid the project's own bar directory");
      assert.ok(listed.includes(".molt/done.yml"));

      const hits = (await grepFiles(p.dir, "verify")).matches.map((m) => m.path);
      assert.ok(!hits.some((h) => h.startsWith(".molt")), "searched molt's own logs");
    } finally {
      p.cleanup();
    }
  });

  it("goes deeper only when asked", () => {
    const p = project();
    try {
      const shallow = walk(p.dir, { depth: 1 }).entries.map((e) => e.path);
      assert.ok(!shallow.includes("src/auth.ts"));
      const deeper = walk(p.dir, { depth: 3 }).entries.map((e) => e.path);
      assert.ok(deeper.includes("src/auth.ts"));
      assert.ok(deeper.includes("src/deep/nested.ts"));
    } finally {
      p.cleanup();
    }
  });

  it("stops at a bound rather than returning a repository", () => {
    const p = project();
    try {
      const r = walk(p.dir, { depth: 5, limit: 2 });
      assert.equal(r.entries.length, 2);
      assert.equal(r.truncated, true);
      assert.match(formatListing(".", r), /stopped at \d+ entries/);
    } finally {
      p.cleanup();
    }
  });

  it("filters by glob, and then lists files only", () => {
    const p = project();
    try {
      const r = walk(p.dir, { depth: 5, glob: "**/*.ts" });
      assert.deepEqual(
        r.entries.map((e) => e.path).sort(),
        ["src/auth.ts", "src/deep/nested.ts", "src/util.ts"],
      );
    } finally {
      p.cleanup();
    }
  });
});

describe("searching", () => {
  it("finds matches with their line numbers, outside the noise", async () => {
    const p = project();
    try {
      const r = await grepFiles(p.dir, "verify");
      const hits = r.matches.map((m) => `${m.path}:${m.line}`);
      assert.ok(hits.includes("README.md:2"));
      assert.ok(hits.includes("src/auth.ts:1"));
      assert.ok(!hits.some((h) => h.startsWith("node_modules")), "searched a dependency");
      assert.ok(!hits.some((h) => h.startsWith("dist")), "searched build output");
    } finally {
      p.cleanup();
    }
  });

  it("narrows by glob", async () => {
    const p = project();
    try {
      const r = await grepFiles(p.dir, "verify", { glob: "**/*.ts" });
      assert.ok(r.matches.every((m) => m.path.endsWith(".ts")));
      assert.ok(r.matches.length > 0);
    } finally {
      p.cleanup();
    }
  });

  it("reports a bad pattern instead of throwing", async () => {
    const p = project();
    try {
      const r = await grepFiles(p.dir, "unclosed(");
      assert.ok(r.invalid, "an invalid regex must be reported, not raised");
      assert.match(formatMatches("unclosed(", r), /was not run/);
    } finally {
      p.cleanup();
    }
  });

  it("refuses a pattern that can take exponential time", async () => {
    // Found by probing: `(a+)+$` against a long line hung molt with no
    // ceiling — no output, no error, no way back except killing it. JavaScript
    // cannot time-limit a regex once it starts, so the pattern is declined
    // before it runs.
    const p = project();
    try {
      writeFileSync(join(p.dir, "long.txt"), "a".repeat(5000) + "b\n");
      for (const bad of ["(a+)+$", "(\\s*)*x", "([a-z]+)*!", "(ab|a)+c"]) {
        if (!isCatastrophic(bad)) continue;
        const t0 = Date.now();
        const r = await grepFiles(p.dir, bad);
        assert.ok(Date.now() - t0 < 1000, `ran a catastrophic pattern: ${bad}`);
        assert.match(formatMatches(bad, r), /exponential time/);
      }
      assert.ok(isCatastrophic("(a+)+$"));
      assert.ok(isCatastrophic("(\\s*)*"));
      // Ordinary patterns are untouched.
      for (const fine of ["verify", "^export function", "TODO|FIXME", "a+b*", "[a-z]+"]) {
        assert.ok(!isCatastrophic(fine), `refused an ordinary pattern: ${fine}`);
      }
    } finally {
      p.cleanup();
    }
  });

  it("stops a search that runs too long", async () => {
    // The deadline is the backstop for slow patterns the shape check misses.
    const p = project();
    try {
      for (let i = 0; i < 60; i++) {
        writeFileSync(join(p.dir, `big${i}.txt`), ("x".repeat(3000) + "\n").repeat(400));
      }
      const t0 = Date.now();
      const r = await grepFiles(p.dir, "x{2,}y?z?q?");
      const ms = Date.now() - t0;
      assert.ok(ms < SEARCH_DEADLINE_MS * 3, `ran ${ms}ms past a ${SEARCH_DEADLINE_MS}ms deadline`);
      if (r.timedOut) assert.match(formatMatches("x", r), /was stopped/);
    } finally {
      p.cleanup();
    }
  });

  it("says plainly when there is nothing to find", async () => {
    const p = project();
    try {
      const r = await grepFiles(p.dir, "nothing-here-at-all");
      assert.equal(r.matches.length, 0);
      assert.match(formatMatches("nothing-here-at-all", r), /no match/);
      assert.match(formatMatches("nothing-here-at-all", r), /file\(s\) searched/);
    } finally {
      p.cleanup();
    }
  });

  it("caps its own output", async () => {
    const p = project();
    try {
      writeFileSync(join(p.dir, "many.txt"), Array.from({ length: MAX_MATCHES + 50 }, () => "hit").join("\n"));
      const r = await grepFiles(p.dir, "hit");
      assert.equal(r.matches.length, MAX_MATCHES);
      assert.equal(r.truncated, true);
      assert.match(formatMatches("hit", r), /stopped at \d+ matches/);
    } finally {
      p.cleanup();
    }
  });

  it("does not search a binary file", async () => {
    const p = project();
    try {
      writeFileSync(join(p.dir, "blob.bin"), Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69]));
      const r = await grepFiles(p.dir, "hi");
      assert.ok(!r.matches.some((m) => m.path === "blob.bin"));
    } finally {
      p.cleanup();
    }
  });
});

describe("editing", () => {
  it("replaces exactly what it was given", () => {
    const r = applyEdit("const a = 1;\nconst b = 2;\n", "const b = 2;", "const b = 3;");
    assert.ok(r.ok);
    assert.equal(r.ok && r.text, "const a = 1;\nconst b = 3;\n");
    assert.equal(r.ok && r.replacements, 1);
  });

  it("refuses text that is not there rather than guessing at a near match", () => {
    const r = applyEdit("const a = 1;\n", "const  a = 1;", "const a = 2;");
    assert.ok(!r.ok);
    assert.match(r.ok ? "" : r.why, /does not appear/);
    assert.match(r.ok ? "" : r.why, /will not guess/);
  });

  it("refuses an ambiguous edit rather than picking one", () => {
    // A write that lands on the wrong occurrence looks exactly like a write
    // that worked. That is the failure molt exists to refuse.
    const r = applyEdit("x = 1;\nx = 1;\n", "x = 1;", "x = 2;");
    assert.ok(!r.ok);
    assert.match(r.ok ? "" : r.why, /appears 2 times/);
  });

  it("changes every occurrence when told to", () => {
    const r = applyEdit("x = 1;\nx = 1;\n", "x = 1;", "x = 2;", true);
    assert.ok(r.ok);
    assert.equal(r.ok && r.text, "x = 2;\nx = 2;\n");
    assert.equal(r.ok && r.replacements, 2);
  });

  it("treats the replacement as literal text, dollar signs and all", () => {
    // String.replace reads `$&`, `$1`, "$`" and `$'` in a replacement as
    // substitutions, so a model editing a regex, a shell script, or anything
    // with jQuery in it got silently different text than it asked for — in the
    // one tool whose entire job is exactness.
    for (const [oldText, newText] of [
      ["OLD", "$& and more"],
      ["OLD", "$1"],
      ["OLD", "$`"],
      ["OLD", "$'"],
      ["OLD", "$$"],
      ["OLD", "text.replace(/x/g, '$&')"],
    ]) {
      const r = applyEdit(`const a = ${oldText};`, oldText, newText);
      assert.ok(r.ok);
      assert.equal(r.ok && r.text, `const a = ${newText};`, `mangled: ${newText}`);
    }
  });

  it("keeps replace_all literal too", () => {
    const r = applyEdit("A and A", "A", "$&!", true);
    assert.ok(r.ok);
    assert.equal(r.ok && r.text, "$&! and $&!");
  });

  it("only replaces the first occurrence when not told otherwise", () => {
    const r = applyEdit("x = 1; y = 1;", "= 1", "= 2");
    assert.ok(!r.ok, "two occurrences without replace_all must be refused");
  });

  it("refuses edits that cannot mean anything", () => {
    assert.ok(!applyEdit("abc", "", "x").ok);
    assert.ok(!applyEdit("abc", "abc", "abc").ok);
  });
});

describe("the tools, through the engine", () => {
  function engineIn(dir: string, turns: Parameters<typeof scriptedProvider>[0]) {
    const provider = scriptedProvider(turns);
    return new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      provider: "mock",
      cwd: dir,
      bar: null,
      fetchFn: provider.fetchFn,
      autonomy: "low",
    });
  }

  it("lists and searches without asking permission, even at low autonomy", async () => {
    // The point of having these as tools: their shape is read-only, so no
    // classifier has to have an opinion about a shell string.
    const p = project();
    try {
      const asked: string[] = [];
      const engine = engineIn(p.dir, [
        { calls: [{ name: "list_dir", args: { path: ".", depth: 2 } }] },
        { calls: [{ name: "grep", args: { pattern: "verify", glob: "**/*.ts" } }] },
        { text: "found it" },
      ]);
      const events = await drain(
        engine.run("find verify", async (name) => {
          asked.push(name);
          return true;
        }),
      );
      assert.deepEqual(asked, [], "asked permission for a tool that cannot write");
      const tools = events.filter((e) => e.kind === "tool");
      assert.ok(tools.every((t) => t.kind === "tool" && t.auto === true));
      assert.match(tools[0]!.kind === "tool" ? (tools[0]!.preview ?? "") : "", /README\.md/);
      assert.match(tools[1]!.kind === "tool" ? (tools[1]!.preview ?? "") : "", /auth\.ts:1/);
    } finally {
      p.cleanup();
    }
  });

  it("ledgers an edit, so files-changed can still prove it", async () => {
    const p = project();
    try {
      const engine = engineIn(p.dir, [
        {
          calls: [
            {
              name: "edit_file",
              args: { path: "src/util.ts", old_text: "noop", new_text: "nothing" },
            },
          ],
        },
        { text: "renamed it" },
      ]);
      await drain(engine.run("rename noop", allowAll));

      assert.match(readFileSync(join(p.dir, "src", "util.ts"), "utf8"), /nothing/);
      const ledger = engine.mergedLedger();
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.path, "src/util.ts");
      assert.ok(ledger[0]!.before && ledger[0]!.after);
      assert.notEqual(ledger[0]!.before, ledger[0]!.after);
    } finally {
      p.cleanup();
    }
  });

  it("reports a refused edit to the model instead of writing something wrong", async () => {
    const p = project();
    try {
      const engine = engineIn(p.dir, [
        {
          calls: [
            {
              name: "edit_file",
              args: { path: "src/util.ts", old_text: "not in the file", new_text: "x" },
            },
          ],
        },
        { text: "could not do it" },
      ]);
      const events = await drain(engine.run("edit it", allowAll));
      const tool = events.find((e) => e.kind === "tool");
      assert.match(tool?.kind === "tool" ? (tool.preview ?? "") : "", /edit refused/);
      // The file is untouched, and the ledger records no write that did not happen.
      assert.match(readFileSync(join(p.dir, "src", "util.ts"), "utf8"), /noop/);
      assert.equal(engine.mergedLedger().length, 0);
    } finally {
      p.cleanup();
    }
  });

  it("says what a call was, not what its JSON looked like", async () => {
    const p = project();
    try {
      const engine = engineIn(p.dir, [
        { calls: [{ name: "grep", args: { pattern: "verify", glob: "**/*.ts" } }] },
        { text: "found" },
      ]);
      const events = await drain(engine.run("search", allowAll));
      const tool = events.find((e) => e.kind === "tool");
      assert.equal(tool?.kind === "tool" ? tool.detail : "", "/verify/ **/*.ts");
    } finally {
      p.cleanup();
    }
  });

  it("will not walk outside the project", async () => {
    const p = project();
    try {
      const engine = engineIn(p.dir, [
        { calls: [{ name: "list_dir", args: { path: "../.." } }] },
        { text: "denied" },
      ]);
      const events = await drain(engine.run("look around", allowAll));
      const tool = events.find((e) => e.kind === "tool");
      assert.match(tool?.kind === "tool" ? (tool.preview ?? "") : "", /outside this project/);
    } finally {
      p.cleanup();
    }
  });

  it("caps a single line that is bigger than the whole read budget", async () => {
    // read_file pages by line and bounds the page to READ_MAX_BYTES — except
    // for one line that is itself larger than the budget, where "always
    // return at least one line, even an enormous one" meant returning it
    // *whole*, uncapped, bypassing the budget entirely. A file with one 5MB
    // line (no newline in it at all — a minified bundle, a data dump, a log
    // line a process never terminated) came back as a single 5,242,880-byte
    // tool result: no truncation, no note, no ceiling of any kind. A hostile
    // or merely careless file blows the token budget the paging exists to
    // enforce.
    const p = project();
    try {
      const big = "x".repeat(5 * 1024 * 1024);
      writeFileSync(join(p.dir, "oneline.txt"), big);
      const engine = engineIn(p.dir, [
        { calls: [{ name: "read_file", args: { path: "oneline.txt" } }] },
        { text: "read it" },
      ]);
      const events = await drain(engine.run("read the file", allowAll));
      const tool = events.find((e) => e.kind === "tool" && e.name === "read_file");
      assert.ok(tool && tool.kind === "tool");
      const bytes = tool!.kind === "tool" ? (tool.bytes ?? 0) : 0;
      assert.ok(
        bytes <= 40_000,
        `a single line escaped the read budget entirely: got ${bytes} bytes back for a 5MB line`,
      );
    } finally {
      p.cleanup();
    }
  });
});
