/**
 * The repository map.
 *
 * Two things have to hold or it is worse than nothing: the ranking has to put
 * the file everyone uses at the top (otherwise it is a random sample dressed
 * as a summary), and the budget has to be real (otherwise a large repository
 * quietly adds tens of thousands of tokens to every request in the session).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildRepoMap,
  importKey,
  importsIn,
  isMappable,
  mapLine,
  mapSkipDirs,
  rankFiles,
  renderMap,
  symbolsIn,
  SYMBOLS_SHOWN,
} from "../src/repomap.js";
import { estTokens } from "../src/types.js";
import { workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws(): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

describe("reading declarations", () => {
  it("finds the top-level names in TypeScript", () => {
    const src = [
      "import { x } from './x.js';",
      "export function runBar() {}",
      "export class Engine {",
      "  private hidden() {}",
      "}",
      "export const MAX = 4;",
      "export type Bar = { checks: number };",
      "function helper() {}",
    ].join("\n");
    const found = symbolsIn("src/bar.ts", src);
    assert.deepEqual(
      found.sort(),
      ["Bar", "Engine", "MAX", "helper", "runBar"],
      "a method on a class is not a top-level declaration and does not belong in a map",
    );
    assert.ok(!found.includes("hidden"));
  });

  it("reads python and go too", () => {
    assert.deepEqual(symbolsIn("a.py", "class Cell:\n    def charge(self):\n        pass\n").sort(), [
      "Cell",
      "charge",
    ]);
    assert.deepEqual(symbolsIn("a.go", "type Pack struct{}\nfunc Weld(a int) {}\n").sort(), [
      "Pack",
      "Weld",
    ]);
  });

  it("says nothing about a language it cannot read", () => {
    assert.equal(isMappable("notes.md"), false);
    assert.deepEqual(symbolsIn("notes.md", "# Heading\n"), []);
  });
});

describe("reading imports", () => {
  it("finds the specifiers of every language it maps", () => {
    assert.deepEqual(importsIn(`import { Engine } from "./engine.js";`), ["./engine.js"]);
    assert.deepEqual(importsIn(`export { x } from '../src/x.js';`), ["../src/x.js"]);
    assert.deepEqual(importsIn(`const fs = require("node:fs");`), ["node:fs"]);
    assert.deepEqual(importsIn(`import "./side-effect.css";`), ["./side-effect.css"]);
    assert.deepEqual(importsIn("from pack.cells import Cell\n"), ["pack.cells"]);
    assert.deepEqual(importsIn('#include "engine.h"\n'), ["engine.h"]);
  });

  it("compares a specifier and a path on the part they share", () => {
    assert.equal(importKey("./line.js"), "line");
    assert.equal(importKey("../src/engine.js"), "src/engine");
    assert.equal(importKey("src/line.ts"), "src/line");
    assert.equal(importKey("pack.cells"), "pack/cells");
  });
});

describe("ranking", () => {
  it("puts the file everyone else imports first", () => {
    const files = [
      { path: "src/leaf.ts", symbols: ["leafOnly"], imports: [] },
      { path: "src/core.ts", symbols: ["Engine"], imports: [] },
      { path: "src/a.ts", symbols: ["a"], imports: ["./core.js"] },
      { path: "src/b.ts", symbols: ["b"], imports: ["../src/core.js"] },
    ];
    const ranked = rankFiles(files);
    assert.equal(ranked[0]!.path, "src/core.ts");
    assert.equal(ranked[0]!.users, 2);
    // Nothing imports it — last, but still listed. It may be the entry point.
    assert.equal(ranked.at(-1)!.users, 0);
  });

  it("is not fooled by a file whose symbols are ordinary words", () => {
    // The defect that made this rewrite necessary: `line.ts` defines `line`,
    // `left` and `right`, which appear in every file in the repository for
    // reasons that have nothing to do with it. Mentioning is not using.
    const files = [
      { path: "src/line.ts", symbols: ["line", "left", "right", "insert"], imports: [] },
      { path: "src/core.ts", symbols: ["Engine"], imports: [] },
      {
        path: "src/a.ts",
        symbols: ["a"],
        imports: ["./core.js"],
      },
      {
        path: "src/b.ts",
        symbols: ["b"],
        imports: ["./core.js"],
      },
    ];
    assert.equal(rankFiles(files)[0]!.path, "src/core.ts");
    assert.equal(rankFiles(files).find((r) => r.path === "src/line.ts")!.users, 0);
  });

  it("does not count a file importing itself", () => {
    const files = [{ path: "solo.ts", symbols: ["solo"], imports: ["./solo.js"] }];
    assert.equal(rankFiles(files)[0]!.users, 0);
  });

  it("orders the same way twice", () => {
    // A map that reshuffles between sessions is a map nobody learns.
    const files = [
      { path: "b.ts", symbols: ["x"], imports: [] },
      { path: "a.ts", symbols: ["y"], imports: [] },
    ];
    assert.deepEqual(
      rankFiles(files).map((r) => r.path),
      ["a.ts", "b.ts"],
    );
  });
});

describe("rendering, inside a budget", () => {
  it("stops at the budget and says how much it left out", () => {
    const ranked = Array.from({ length: 200 }, (_, i) => ({
      path: `src/file${i}.ts`,
      symbols: ["alpha", "beta"],
      users: 200 - i,
    }));
    const map = renderMap(ranked, 200);
    assert.ok(map.tokens <= 400, `map came to ${map.tokens} tokens against a 200-token budget`);
    assert.ok(map.shown > 0 && map.shown < 200);
    assert.equal(map.shown + map.omitted, 200);
    assert.match(map.text, /are not listed/);
  });

  it("says it is partial and regex-derived, so nothing reads it as an inventory", () => {
    const map = renderMap([{ path: "a.ts", symbols: ["x"], users: 1 }], 500);
    assert.match(map.text, /Read a file before believing it/);
  });

  it("produces nothing at all for a budget of nothing", () => {
    const map = renderMap([{ path: "a.ts", symbols: ["x"], users: 1 }], 0);
    assert.equal(map.text, "");
    assert.equal(map.shown, 0);
  });

  it("truncates a long symbol list rather than a file's presence", () => {
    const line = mapLine({ path: "a.ts", symbols: ["a", "b", "c", "d", "e", "f", "g", "h"], users: 0 });
    assert.match(line, /\+2$/);
    assert.equal(line.split(" ").filter((t) => t.endsWith(",")).length, SYMBOLS_SHOWN - 1);
  });
});

describe("building one for a real directory", () => {
  it("maps the files that are there and skips what it cannot read", async () => {
    const dir = ws();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "core.ts"), "export class Engine {}\nexport function run() {}\n");
    writeFileSync(join(dir, "src", "user.ts"), "import { Engine } from './core.js';\nexport const u = new Engine();\n");
    writeFileSync(join(dir, "README.md"), "# not a source file\n");

    const map = await buildRepoMap(dir, { budgetTokens: 500 });
    assert.match(map.text, /src\/core\.ts/);
    assert.match(map.text, /Engine/);
    assert.ok(!map.text.includes("README.md"), "mapped a file it cannot read symbols from");
    assert.equal(map.tokens, estTokens(map.text));
    // The most-referenced file leads.
    const body = map.text.split("\n").filter((l) => l.startsWith("  "));
    assert.match(body[0]!, /src\/core\.ts/);
  });

  it("does not map the same file three times over", async () => {
    // The defect this caught on molt's own repository: a third of the map was
    // `dist-test/src/line.js` and `.claude/worktrees/agent-a03f…/src/line.ts`
    // — copies of one file, crowding real ones out of the budget, each copy
    // standing as evidence that the others mattered.
    const dir = ws();
    for (const sub of ["src", "dist-test/src", ".claude/worktrees/agent-1/src"]) {
      mkdirSync(join(dir, sub), { recursive: true });
      writeFileSync(join(dir, sub, "core.ts"), "export class Engine {}\n");
    }
    const skip = mapSkipDirs(dir);
    assert.ok(skip.has("dist-test"), "a dist-* directory is built output, whatever it is called");
    assert.ok(skip.has(".claude"), "agent worktrees are whole copies of the repository");

    const map = await buildRepoMap(dir, { budgetTokens: 500 });
    const lines = map.text.split("\n").filter((l) => l.includes("core.ts"));
    assert.deepEqual(lines.map((l) => l.trim().split(/\s+/)[0]), ["src/core.ts"]);
  });

  it("returns nothing for a directory with no source in it", async () => {
    const dir = ws();
    writeFileSync(join(dir, "notes.md"), "just notes\n");
    const map = await buildRepoMap(dir, { budgetTokens: 500 });
    assert.equal(map.text, "");
    assert.equal(map.shown, 0);
  });
});
