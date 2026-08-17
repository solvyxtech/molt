/**
 * The bar is the contract. A malformed bar must fail loudly — silently
 * degrading to "no checks" would switch the product's central promise off
 * by accident, which is worse than crashing.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import {
  BarError,
  DEFAULT_BAR,
  claimedWrites,
  loadBar,
  parseBar,
  runBar,
  writeDefaultBar,
} from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import type { BarContext } from "../src/bar.js";
import { allowAll, drain, kinds, scriptedProvider, toolCall, workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

function ctx(dir: string, over: Partial<BarContext> = {}): BarContext {
  return { cwd: dir, record: [], ledger: [], archivedBatches: 0, ...over };
}

describe("parseBar", () => {
  it("accepts a well-formed bar", () => {
    const bar = parseBar(`
version: 1
checks:
  - name: types
    run: npm run typecheck
  - name: tests
    run: npm test
    timeout: 300
    expect_exit: 0
  - name: landed
    builtin: files-changed
`);
    assert.equal(bar.checks.length, 3);
    assert.equal(bar.checks[1].kind, "command");
    assert.equal(bar.checks[2].kind, "builtin");
    const tests = bar.checks[1];
    assert.ok(tests.kind === "command" && tests.timeoutMs === 300_000);
  });

  it("defaults timeout and expected exit code", () => {
    const bar = parseBar("version: 1\nchecks:\n  - name: a\n    run: true\n");
    const c = bar.checks[0];
    assert.ok(c.kind === "command");
    assert.equal(c.expectExit, 0);
    assert.equal(c.timeoutMs, 120_000);
  });

  const bad: [string, string, RegExp][] = [
    ["not yaml", ":\n  - [", /not valid YAML|must be a mapping/],
    ["not a mapping", "just a string", /must be a mapping/],
    ["wrong version", "version: 2\nchecks:\n  - name: a\n    run: true\n", /unsupported version/],
    ["no checks", "version: 1\nchecks: []\n", /non-empty list/],
    ["missing checks key", "version: 1\n", /non-empty list/],
    ["nameless check", "version: 1\nchecks:\n  - run: true\n", /missing a name/],
    [
      "duplicate names",
      "version: 1\nchecks:\n  - name: a\n    run: true\n  - name: a\n    run: false\n",
      /duplicate check name/,
    ],
    ["neither run nor builtin", "version: 1\nchecks:\n  - name: a\n", /exactly one of/],
    [
      "both run and builtin",
      "version: 1\nchecks:\n  - name: a\n    run: true\n    builtin: files-changed\n",
      /exactly one of/,
    ],
    [
      "unknown builtin",
      "version: 1\nchecks:\n  - name: a\n    builtin: vibes\n",
      /unknown builtin "vibes"/,
    ],
    [
      "bad timeout",
      "version: 1\nchecks:\n  - name: a\n    run: true\n    timeout: -5\n",
      /invalid timeout/,
    ],
    [
      "non-integer expect_exit",
      "version: 1\nchecks:\n  - name: a\n    run: true\n    expect_exit: 1.5\n",
      /non-integer expect_exit/,
    ],
  ];

  for (const [label, source, pattern] of bad) {
    it(`rejects ${label}`, () => {
      assert.throws(() => parseBar(source), (e: unknown) => e instanceof BarError && pattern.test((e as Error).message));
    });
  }

  it("ships a default bar that is itself valid", () => {
    const bar = parseBar(DEFAULT_BAR);
    assert.ok(bar.checks.length >= 2);
  });

  it("writes the default bar without clobbering an existing one", () => {
    const dir = ws();
    writeDefaultBar(dir);
    const mine = "version: 1\nchecks:\n  - name: mine\n    run: true\n";
    writeFileSync(join(dir, ".molt", "done.yml"), mine);
    writeDefaultBar(dir);
    assert.equal(loadBar(dir)!.checks[0].name, "mine");
  });

  it("returns null when no bar exists", () => {
    assert.equal(loadBar(ws()), null);
  });
});

describe("command checks", () => {
  it("passes on the expected exit code and fails otherwise", () => {
    const dir = ws();
    const bar = parseBar(
      "version: 1\nchecks:\n  - name: ok\n    run: exit 0\n  - name: nope\n    run: exit 3\n",
    );
    const result = runBar(bar, ctx(dir));
    assert.equal(result.ok, false);
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[1].ok, false);
    assert.equal(result.results[1].exitCode, 3);
  });

  it("honours a non-zero expected exit code", () => {
    const bar = parseBar("version: 1\nchecks:\n  - name: inverted\n    run: exit 7\n    expect_exit: 7\n");
    assert.equal(runBar(bar, ctx(ws())).ok, true);
  });

  it("captures stderr, not just stdout", () => {
    const bar = parseBar('version: 1\nchecks:\n  - name: e\n    run: echo "to stderr" >&2; exit 1\n');
    assert.match(runBar(bar, ctx(ws())).results[0].output, /to stderr/);
  });

  it("reports a timeout as a failure rather than hanging", () => {
    const bar = parseBar("version: 1\nchecks:\n  - name: slow\n    run: sleep 5\n    timeout: 1\n");
    const r = runBar(bar, ctx(ws())).results[0];
    assert.equal(r.ok, false);
    assert.match(r.output, /timed out/);
  });

  it("runs every check even after one fails", () => {
    const bar = parseBar(
      "version: 1\nchecks:\n  - name: a\n    run: exit 1\n  - name: b\n    run: exit 1\n  - name: c\n    run: exit 0\n",
    );
    const r = runBar(bar, ctx(ws()));
    assert.equal(r.results.length, 3, "a partial bar is not a bar");
  });
});

describe("builtin: files-changed", () => {
  it("fails when nothing was written at all", () => {
    const bar = parseBar("version: 1\nchecks:\n  - name: l\n    builtin: files-changed\n");
    const r = runBar(bar, ctx(ws()));
    assert.equal(r.ok, false);
    assert.match(r.results[0].output, /No file was modified/);
  });

  it("fails when writes appear in the record but never landed", () => {
    const dir = ws();
    const record = [
      { role: "assistant" as const, content: null, tool_calls: [toolCall("write_file", { path: "x.ts" })] },
    ];
    const bar = parseBar("version: 1\nchecks:\n  - name: l\n    builtin: files-changed\n");
    const r = runBar(bar, ctx(dir, { record }));
    assert.equal(r.ok, false);
    assert.match(r.results[0].output, /none landed on disk/);
    assert.match(r.results[0].output, /x\.ts/);
  });

  it("reads claimed writes out of the full record, including shed context", () => {
    const record = [
      { role: "assistant" as const, content: null, tool_calls: [toolCall("write_file", { path: "a.ts" }, "1")] },
      { role: "assistant" as const, content: null, tool_calls: [toolCall("read_file", { path: "b.ts" }, "2")] },
      { role: "assistant" as const, content: null, tool_calls: [toolCall("write_file", { path: "c.ts" }, "3")] },
    ];
    assert.deepEqual(claimedWrites(record), ["a.ts", "c.ts"]);
  });
});

describe("builtin: record-intact", () => {
  it("passes when nothing has been shed", () => {
    const bar = parseBar("version: 1\nchecks:\n  - name: r\n    builtin: record-intact\n");
    assert.equal(runBar(bar, ctx(ws())).ok, true);
  });

  it("fails when the session shed more than the archive holds", () => {
    const dir = ws();
    const bar = parseBar("version: 1\nchecks:\n  - name: r\n    builtin: record-intact\n");
    const r = runBar(bar, ctx(dir, { archive: new Archive(dir), archivedBatches: 2 }));
    assert.equal(r.ok, false);
    assert.match(r.results[0].output, /evidence chain is incomplete/);
  });

  it("passes when the archive matches the session", () => {
    const dir = ws();
    const archive = new Archive(dir);
    archive.write("# e\n\n## user\n\nhello\n", 1, "hello");
    const bar = parseBar("version: 1\nchecks:\n  - name: r\n    builtin: record-intact\n");
    assert.equal(runBar(bar, ctx(dir, { archive, archivedBatches: 1 })).ok, true);
  });
});

describe("tamper detection", () => {
  it("fails the bar when the agent edits done.yml mid-session", async () => {
    const dir = ws();
    mkdirSync(join(dir, ".molt"), { recursive: true });
    writeFileSync(
      join(dir, ".molt", "done.yml"),
      "version: 1\nchecks:\n  - name: suite\n    run: exit 1\n",
    );

    const provider = scriptedProvider([
      {
        calls: [
          {
            name: "write_file",
            args: {
              path: ".molt/done.yml",
              content: "version: 1\nchecks:\n  - name: suite\n    run: exit 0\n",
            },
          },
        ],
      },
      { text: "Done — all checks pass now." },
    ]);

    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: loadBar(dir),
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      maxProofAttempts: 1,
    });

    const events = await drain(engine.run("make the tests pass", allowAll));
    assert.ok(!kinds(events).includes("assistant_text"), "a lowered bar must not yield an answer");

    const exhausted = events.find((e) => e.kind === "proof_exhausted") as
      | { result: { results: { name: string; output: string }[] } }
      | undefined;
    assert.ok(exhausted, "expected the attempt to be rejected");
    const tamper = exhausted.result.results.find((r) => r.name === "bar-unmodified");
    assert.ok(tamper, "tamper check must be present");
    assert.match(tamper.output, /cannot be edited by the work being judged/);
  });

  it("does not cry tamper when done.yml is untouched", async () => {
    const dir = ws();
    writeDefaultBar(dir);
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "real.txt", content: "work\n" } }] },
      { text: "Done." },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: loadBar(dir),
      archive: new Archive(dir),
      receipts: new Receipts(dir),
    });
    const events = await drain(engine.run("do work", allowAll));
    assert.ok(kinds(events).includes("assistant_text"));
    assert.ok(!kinds(events).includes("proof_refused"));
  });
});

describe("YAML scalar handling", () => {
  it("treats bare scalars as commands rather than rejecting them", () => {
    // `true`, `false`, `no`, and numbers are all coerced by YAML. They are
    // also all valid shell words, so they must survive the parser.
    for (const literal of ["true", "false", "no", "off", "1"]) {
      const bar = parseBar(`version: 1\nchecks:\n  - name: c\n    run: ${literal}\n`);
      const c = bar.checks[0];
      assert.ok(c.kind === "command");
      assert.equal(typeof c.run, "string");
      assert.ok(c.run.length > 0, `\`run: ${literal}\` must survive as a command`);
    }
  });

  it("rejects a run that cannot be a command", () => {
    assert.throws(
      () => parseBar("version: 1\nchecks:\n  - name: c\n    run:\n      - a\n      - b\n"),
      /not a shell command/,
    );
    assert.throws(() => parseBar('version: 1\nchecks:\n  - name: c\n    run: "   "\n'), /empty/);
  });
});
