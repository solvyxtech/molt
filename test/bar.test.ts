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
  FALLBACK_BAR,
  claimedWrites,
  loadBar,
  mentionedPaths,
  parseBar,
  runBar,
  writeDefaultBar,
} from "../src/bar.js";
import { Engine, asQuestion } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import type { BarContext } from "../src/bar.js";
import { createHash } from "node:crypto";
import { substanceOf } from "../src/files.js";
import type { CheckResult, LedgerEntry } from "../src/types.js";
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

describe("claims-grounded grounds a read", () => {
  it("accepts a file the model read, wherever it lives", async () => {
    // The reported failure: molt was asked to assess its own source, which is
    // installed outside the project directory. It read engine.ts, described it
    // accurately, and was told it had invented the name — then spent 1.13M
    // tokens rewriting a correct document. Reading a file is evidence it
    // exists; it is the same evidence a write is, one step earlier.
    const dir = ws();
    const bar = parseBar("version: 1\nchecks:\n  - name: grounded\n    builtin: claims-grounded\n");
    const ctx = {
      cwd: dir,
      record: [],
      ledger: [],
      liveLedger: [],
      archivedBatches: 0,
      expectedArchivedWrites: 0,
      expectedArchiveFiles: [],
      claim: "engine.ts holds the loop and bar.ts runs the checks.",
    };

    // Nothing read: the names are unsupported, and the check says so.
    assert.equal((await runBar(bar, ctx)).ok, false);

    // Read from anywhere, including outside the project.
    const grounded = await runBar(bar, {
      ...ctx,
      read: ["/opt/homebrew/lib/node_modules/@solvyx/molt/src/engine.ts", "/elsewhere/bar.ts"],
    });
    assert.equal(grounded.ok, true, grounded.results[0]?.output);
  });
});

describe("claims-grounded, on prose about code", () => {
  it("does not think e.g. is a file", () => {
    // Reported from use: a correct assessment of molt's own source was refused
    // because "e.g." parses as a stem and a one-letter extension — and the
    // model was then sent back to strip abbreviations out of its own writing.
    // A check that makes work worse in order to be satisfied is not a check.
    const claim = "engine.ts holds the loop, e.g. the proof gate. i.e. see bar.ts. 1.5x vs. before.";
    assert.deepEqual(mentionedPaths(claim).sort(), ["bar.ts", "engine.ts"]);
  });

  it("leaves the rest of English alone", () => {
    for (const prose of [
      "roughly 2.5x faster",
      "see section 3.1 for details",
      "at 9 a.m. or p.m.",
      "in the U.S. and U.K.",
      "cf. the earlier note",
      "approx. 40 steps",
      "Dr. Smith and Mr. Jones",
    ]) {
      assert.deepEqual(mentionedPaths(prose), [], `flagged prose: ${prose}`);
    }
  });

  it("still trusts a short name someone put in backticks", () => {
    // `a.c` is how a person writes a filename they mean.
    assert.deepEqual(mentionedPaths("look at `a.c` and `x.h`").sort(), ["a.c", "x.h"]);
  });

  it("still catches a fabricated reference", () => {
    assert.deepEqual(mentionedPaths("I created src/invented.ts for you"), ["src/invented.ts"]);
  });
});

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

  /**
   * The mutation builtin needs a `run` beside it, which every other builtin is
   * refused for having. Nothing here went through parseBar until this test:
   * the check's own tests build the Check object as a literal, so a parser that
   * rejected every possible mutation config still had a green suite. The
   * feature shipped unconfigurable.
   */
  describe("builtin: mutation", () => {
    it("accepts a builtin and a run together", () => {
      const bar = parseBar(
        "version: 1\nchecks:\n  - name: mut\n    builtin: mutation\n    run: npm test\n",
      );
      const c = bar.checks[0];
      assert.ok(c.kind === "builtin" && c.builtin === "mutation");
      assert.equal(c.run, "npm test");
    });

    it("defaults the sample and the per-run timeout", () => {
      const bar = parseBar(
        "version: 1\nchecks:\n  - name: mut\n    builtin: mutation\n    run: npm test\n",
      );
      const c = bar.checks[0];
      assert.ok(c.kind === "builtin");
      assert.equal(c.sample, 4);
      assert.equal(c.timeoutMs, 600_000);
    });

    it("carries a stated sample and timeout through", () => {
      const bar = parseBar(
        "version: 1\nchecks:\n  - name: mut\n    builtin: mutation\n    run: npm test\n" +
          "    sample: 9\n    timeout: 30\n",
      );
      const c = bar.checks[0];
      assert.ok(c.kind === "builtin");
      assert.equal(c.sample, 9);
      assert.equal(c.timeoutMs, 30_000);
    });

    it("reads a bare scalar run the way every other check does", () => {
      // `run: true` is /usr/bin/true, and the parser accepts it everywhere
      // else. Reporting it as a missing run here would be a lie about the file.
      const bar = parseBar(
        "version: 1\nchecks:\n  - name: mut\n    builtin: mutation\n    run: true\n",
      );
      const c = bar.checks[0];
      assert.ok(c.kind === "builtin");
      assert.equal(c.run, "true");
    });

    it("rejects a mutation check with no run", () => {
      assert.throws(
        () => parseBar("version: 1\nchecks:\n  - name: mut\n    builtin: mutation\n"),
        (e: unknown) => e instanceof BarError && /needs a `run`/.test((e as Error).message),
      );
    });

    it("still refuses a run beside any other builtin", () => {
      // The exemption is for mutation alone. A `run` on a session-scoped
      // builtin is a mistake, and widening the hole would hide it.
      assert.throws(
        () =>
          parseBar(
            "version: 1\nchecks:\n  - name: a\n    builtin: record-intact\n    run: npm test\n",
          ),
        (e: unknown) => e instanceof BarError && /exactly one of/.test((e as Error).message),
      );
    });
  });

  it("ships a default bar that is itself valid", () => {
    const bar = parseBar(FALLBACK_BAR);
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
  it("passes on the expected exit code and fails otherwise", async () => {
    const dir = ws();
    const bar = parseBar(
      "version: 1\nchecks:\n  - name: ok\n    run: exit 0\n  - name: nope\n    run: exit 3\n",
    );
    const result = await runBar(bar, ctx(dir));
    assert.equal(result.ok, false);
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[1].ok, false);
    assert.equal(result.results[1].exitCode, 3);
  });

  it("honours a non-zero expected exit code", async () => {
    const bar = parseBar("version: 1\nchecks:\n  - name: inverted\n    run: exit 7\n    expect_exit: 7\n");
    assert.equal((await runBar(bar, ctx(ws()))).ok, true);
  });

  it("captures stderr, not just stdout", async () => {
    const bar = parseBar('version: 1\nchecks:\n  - name: e\n    run: echo "to stderr" >&2; exit 1\n');
    assert.match((await runBar(bar, ctx(ws()))).results[0].output, /to stderr/);
  });

  it("reports a timeout as a failure rather than hanging", async () => {
    const bar = parseBar("version: 1\nchecks:\n  - name: slow\n    run: sleep 5\n    timeout: 1\n");
    const r = (await runBar(bar, ctx(ws()))).results[0];
    assert.equal(r.ok, false);
    assert.match(r.output, /timed out/);
  });

  it("runs every check even after one fails", async () => {
    const bar = parseBar(
      "version: 1\nchecks:\n  - name: a\n    run: exit 1\n  - name: b\n    run: exit 1\n  - name: c\n    run: exit 0\n",
    );
    const r = await runBar(bar, ctx(ws()));
    assert.equal(r.results.length, 3, "a partial bar is not a bar");
  });
});

describe("builtin: files-changed", () => {
  it("fails when nothing was written at all", async () => {
    const bar = parseBar("version: 1\nchecks:\n  - name: l\n    builtin: files-changed\n");
    const r = await runBar(bar, ctx(ws()));
    assert.equal(r.ok, false);
    assert.match(r.results[0].output, /No file was modified/);
  });

  it("fails when writes appear in the record but never landed", async () => {
    const dir = ws();
    const record = [
      { role: "assistant" as const, content: null, tool_calls: [toolCall("write_file", { path: "x.ts" })] },
    ];
    const bar = parseBar("version: 1\nchecks:\n  - name: l\n    builtin: files-changed\n");
    const r = await runBar(bar, ctx(dir, { record }));
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
  it("passes when nothing has been shed", async () => {
    const bar = parseBar("version: 1\nchecks:\n  - name: r\n    builtin: record-intact\n");
    assert.equal((await runBar(bar, ctx(ws()))).ok, true);
  });

  it("fails when the session shed more than the archive holds", async () => {
    const dir = ws();
    const bar = parseBar("version: 1\nchecks:\n  - name: r\n    builtin: record-intact\n");
    const r = await runBar(bar, ctx(dir, { archive: new Archive(dir), archivedBatches: 2 }));
    assert.equal(r.ok, false);
    assert.match(r.results[0].output, /evidence chain is incomplete/);
  });

  it("passes when the archive matches the session", async () => {
    const dir = ws();
    const archive = new Archive(dir);
    archive.write("# e\n\n## user\n\nhello\n", 1, "hello");
    const bar = parseBar("version: 1\nchecks:\n  - name: r\n    builtin: record-intact\n");
    assert.equal((await runBar(bar, ctx(dir, { archive, archivedBatches: 1 }))).ok, true);
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

describe("counting what was written", () => {
  const wrote = (path: string, name = "write_file") => ({
    role: "assistant" as const,
    content: null,
    tool_calls: [
      { id: `c${path}${Math.random()}`, type: "function" as const, function: { name, arguments: JSON.stringify({ path }) } },
    ],
  });

  it("counts files, not calls, because that is what it is compared against", () => {
    // The ledger is keyed by path — one entry per file, merging the first
    // `before` with the last `after`. Counting calls here compares two
    // different units, and a turn that edited four files nine times between
    // them wrote "5 further write(s) in the record did not land" into a
    // receipt while everything had landed.
    const record = [
      wrote("src/cli.tsx"),
      wrote("test/cli.test.ts"),
      wrote("src/cli.tsx", "edit_file"),
      wrote("src/cli.tsx", "edit_file"),
      wrote("test/cli.test.ts", "edit_file"),
    ];
    assert.deepEqual(
      claimedWrites(record),
      ["src/cli.tsx", "test/cli.test.ts"],
      "repeated edits to one file counted as separate writes",
    );
  });

  it("keeps first-seen order, so the names read as the work happened", () => {
    assert.deepEqual(claimedWrites([wrote("b.ts"), wrote("a.ts"), wrote("b.ts")]), ["b.ts", "a.ts"]);
  });
});

/**
 * The hole receipt 0025 went through.
 *
 * A local model was asked to read the rest of `src/cli.tsx`. It read the file,
 * claimed completion, and `work-landed` correctly refused: nothing had changed.
 * On the second attempt it added one line —
 *
 *     + // molt: CLI entry point - handles command parsing and execution
 *
 * — to a function whose signature already said that, and molt issued a receipt
 * certifying the task complete. The model wrote why in the receipt: "to satisfy
 * the work-landed check".
 *
 * Nothing there was a lie. A file changed, the hash matched, the tests passed.
 * The gate asked a question too weak to be worth answering, and the change
 * existed only because the gate asked it — which is the one thing a gate must
 * never cause.
 */
describe("work landing means work, not a keystroke", () => {
  /** Runs the files-changed builtin alone over a ledger. */
  async function runCheckFor(
    ledger: LedgerEntry[],
    allowCommentOnly = false,
  ): Promise<{ ok: boolean; output: string }> {
    const ws = workspace();
    try {
      // The files must exist and hash to `after`, or the check fails earlier
      // on grounds this test is not about.
      const entries = ledger.map((e) => {
        const abs = join(ws.dir, e.path);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, `contents of ${e.path}`, "utf8");
        return {
          ...e,
          after: createHash("sha256").update(`contents of ${e.path}`, "utf8").digest("hex"),
        };
      });
      const bar = parseBar(
        `version: 1\nchecks:\n  - name: work-landed\n    builtin: files-changed\n` +
          (allowCommentOnly ? `    comment-only: allow\n` : ""),
      );
      const ctx: BarContext = {
        cwd: ws.dir,
        record: [],
        ledger: entries,
        archivedBatches: 0,
      };
      const result = await runBar(bar, ctx);
      return { ok: result.ok, output: result.results[0]!.output };
    } finally {
      ws.cleanup();
    }
  }

  const ledgerOf = (path: string, substance: number): LedgerEntry[] => [
    { path, before: "aaa", after: "bbb", callId: "c1", substance },
  ];

  it("counts a line of code and does not count a comment", () => {
    // The receipt 0025 diff, exactly.
    assert.equal(
      substanceOf(
        "export async function main() {\n  return 0;\n}\n",
        "// molt: CLI entry point - handles command parsing and execution\nexport async function main() {\n  return 0;\n}\n",
      ),
      0,
    );
    // The same shape of change, carrying one line that the compiler reads.
    assert.equal(
      substanceOf(
        "export async function main() {\n  return 0;\n}\n",
        "export async function main() {\n  setup();\n  return 0;\n}\n",
      ),
      1,
    );
    // Deleting a body is work, and adds no lines at all.
    assert.ok(substanceOf("function f() {\n  doTheThing();\n}\n", "function f() {\n}\n") > 0);
    // Blank lines are not work; neither is a block comment.
    assert.equal(substanceOf("const a = 1;\n", "const a = 1;\n\n\n"), 0);
    assert.equal(
      substanceOf("const a = 1;\n", "/**\n * Explains a.\n */\nconst a = 1;\n"),
      0,
    );
    // Code with a trailing comment is still code.
    assert.equal(substanceOf("const a = 1;\n", "const a = 1;\nconst b = 2; // and b\n"), 1);
  });

  it("refuses a diff that is only comments", async () => {
    const out = await runCheckFor(ledgerOf("src/cli.tsx", 0));
    assert.equal(out.ok, false, "a comment-only diff may not satisfy work-landed");
    assert.match(out.output, /only comments|comment or blank/i);
    // The message has to offer the honest way out, or it is just a harder
    // puzzle to cheat at.
    assert.match(out.output, /comment-only: allow/);
  });

  it("accepts one line of real code", async () => {
    assert.equal((await runCheckFor(ledgerOf("src/cli.tsx", 1))).ok, true);
  });

  it("refuses comment-only files riding along with one real change", async () => {
    // Exploit: one substantive edit plus six comment-only word swaps.
    // Path: runBuiltin("files-changed") in src/bar.ts sums substance across
    // the whole turn (`total === 0` is the only refusal). One real line
    // makes total === 1, so the six empty files never trip the gate.
    // Receipt it would produce: work-landed ok, "7 file(s) modified and
    // verified byte-for-byte on disk" — accepted. That is receipt 0037's
    // remaining hole: the comment-only rule is a SUM, not per file.
    const riders = [
      "src/untouched-a.ts",
      "src/untouched-b.ts",
      "src/untouched-c.ts",
      "src/untouched-d.ts",
      "src/untouched-e.ts",
      "src/untouched-f.ts",
    ];
    const out = await runCheckFor([
      { path: "src/fix.ts", before: "aaa", after: "bbb", callId: "c1", substance: 1 },
      ...riders.map((path, i) => ({
        path,
        before: "aaa",
        after: "bbb",
        callId: `c${i + 2}`,
        substance: 0,
      })),
    ]);
    assert.equal(
      out.ok,
      false,
      "one real line must not launder comment-only files into an accepted receipt",
    );
    for (const path of riders) {
      assert.match(out.output, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(out.output, /comment-only: allow/);
  });

  it("lets a project say documentation is the work", async () => {
    assert.equal((await runCheckFor(ledgerOf("docs/guide.md", 0), true)).ok, true);
  });

  it("does not judge entries recovered from an older archive", async () => {
    // `substance` is absent on those. Unknown is not zero — holding an
    // unjudgeable entry against the model would fail real work after a shed.
    const old: LedgerEntry[] = [{ path: "src/a.ts", before: "a", after: "b", callId: "c1" }];
    assert.equal((await runCheckFor(old)).ok, true);
  });

  it("stops telling the model that any edit will do", async () => {
    const out = await runCheckFor([]);
    assert.equal(out.ok, false);
    // The old wording was "Nothing was done that can be shown." full stop, and
    // a model read it as a specification for the cheapest possible edit.
    assert.match(out.output, /say that plainly and stop|does not require a change|genuinely does not/i);
    assert.match(out.output, /will be refused|worst of the three/i);
  });
});

/**
 * The same refusal, driven through the engine that has to record the evidence.
 *
 * The gate above is only as good as the number the engine writes into the
 * ledger, and that wiring is a separate thing to get wrong: nothing in the
 * check can tell "this diff was all comments" from "nobody measured it". This
 * replays receipt 0025 end to end — a real edit_file adding a real comment to
 * a real file on disk — and requires the refusal to come out the far side.
 */
describe("replaying receipt 0025 through the engine", () => {
  const SOURCE = "export async function main() {\n  return 0;\n}\n";

  async function runWithEdit(newText: string): Promise<{ refused: boolean; output: string }> {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "cli.ts"), SOURCE, "utf8");
      writeFileSync(
        join(ws.dir, "done.yml"),
        "version: 1\nchecks:\n  - name: work-landed\n    builtin: files-changed\n",
        "utf8",
      );
      const p = scriptedProvider([
        {
          calls: [
            {
              name: "edit_file",
              args: {
                path: "cli.ts",
                old_text: "export async function main() {",
                new_text: newText,
              },
            },
          ],
        },
        { text: "Done — the work-landed check is satisfied now." },
      ]);
      const engine = new Engine({
        baseUrl: "http://provider.test/v1",
        model: "m",
        provider: "test",
        cwd: ws.dir,
        bar: parseBar("version: 1\nchecks:\n  - name: work-landed\n    builtin: files-changed\n"),
        fetchFn: p.fetchFn,
        stream: false,
        maxProofAttempts: 1,
      });
      const events = await drain(engine.run("read the file", allowAll));
      const proof = events.find((e) => e.kind === "proof_result" || e.kind === "proof_exhausted");
      const result =
        proof && "result" in proof ? proof.result : { ok: true, results: [] as CheckResult[] };
      return {
        refused: !result.ok,
        output: result.results.map((r) => r.output).join("\n"),
      };
    } finally {
      ws.cleanup();
    }
  }

  it("refuses the comment that closed receipt 0025", async () => {
    const out = await runWithEdit(
      "// molt: CLI entry point - handles command parsing and execution\nexport async function main() {",
    );
    assert.equal(out.refused, true, "a comment written to pass the gate must not pass it");
    assert.match(out.output, /comment or blank/i);
  });

  it("accepts the same edit carrying one line of code", async () => {
    const out = await runWithEdit("export async function main() {\n  setup();");
    assert.equal(out.refused, false, "one real line of code is work and must land");
  });
});

/**
 * What a question may be refused for.
 *
 * Reported from the desktop app: "I had ask only clicked and still got bar not
 * met." They had. `ask` dropped `files-changed` and left every command check
 * in place, so a turn that wrote nothing was refused because `tests` was red.
 *
 * The turn could not have caused that. A question touches no file, so if the
 * suite is failing it was failing before the question was asked — and the bar
 * exists to stop a model claiming work it did not do, which a question never
 * claims. Refusing one is a category error, not a strict gate.
 *
 * The checks still run, because knowing the suite is red is worth having. They
 * run advisory: they report, and they do not refuse.
 */
describe("a question is not refused for the state of the repository", () => {
  const BAR = `version: 1
checks:
  - name: types
    run: "true"
  - name: tests
    run: "false"
  - name: work-landed
    builtin: files-changed
`;

  it("drops the write check and keeps the rest", () => {
    const q = asQuestion(parseBar(BAR), true)!;
    assert.deepEqual(
      q.checks.map((c) => c.name),
      ["types", "tests"],
      "files-changed cannot be satisfied by a turn that writes nothing",
    );
  });

  it("leaves nothing that can refuse the answer", () => {
    const q = asQuestion(parseBar(BAR), true)!;
    assert.ok(
      q.checks.every((c) => c.advisory === true),
      "every surviving check must report rather than block",
    );
  });

  it("still reports the failure rather than hiding it", async () => {
    const ws = workspace();
    try {
      const q = asQuestion(parseBar(BAR), true)!;
      const result = await runBar(q, {
        cwd: ws.dir,
        record: [],
        ledger: [],
        archivedBatches: 0,
      });
      assert.equal(result.ok, true, "a question may not be refused");
      const warned = (result.warnings ?? []).map((w) => w.name);
      assert.ok(warned.includes("tests"), "the red suite must still be surfaced, as a warning");
    } finally {
      ws.cleanup();
    }
  });

  it("does not soften the bar for a turn that does change files", () => {
    // The whole gate depends on this staying strict for ordinary work.
    const normal = parseBar(BAR);
    assert.ok(
      normal.checks.every((c) => c.advisory !== true),
      "a normal turn's checks must still be able to refuse",
    );
  });

  it("has nothing to do when there is no bar", () => {
    assert.equal(asQuestion(null, true), null);
    assert.equal(asQuestion(undefined, true), null);
  });

  it("is not a way out of the bar for a turn that wrote something", () => {
    // Ticking "ask" drops the write check, not the ability to write. A turn
    // that edited a file can have broken the suite it is about to be judged
    // by, so the softening does not apply to it — whichever box was ticked.
    const q = asQuestion(parseBar(BAR), false)!;
    assert.ok(
      q.checks.every((c) => c.advisory !== true),
      "a turn that changed files must still be refusable",
    );
    assert.deepEqual(
      q.checks.map((c) => c.name),
      ["types", "tests"],
      "the write check is still dropped — ask mode does not require a change",
    );
  });
});
