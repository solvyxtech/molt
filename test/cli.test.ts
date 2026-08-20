/**
 * The command line is the only surface most people will ever touch, and its
 * exit codes are what CI and any benchmark harness will read. A wrong exit
 * code is a false accept wearing a different hat.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("defaults to local Ollama", () => {
    const a = parseArgs([]);
    assert.equal(a.url, "http://localhost:11434/v1");
    assert.equal(a.cmd, "");
    assert.equal(a.yes, false);
  });

  it("reads a subcommand and its task", () => {
    const a = parseArgs(["run", "fix", "the", "failing", "test"]);
    assert.equal(a.cmd, "run");
    assert.equal(a.task, "fix the failing test");
  });

  it("parses every option", () => {
    const a = parseArgs([
      "run", "task",
      "--url", "http://x/v1",
      "--model", "m",
      "--key", "k",
      "--provider", "p",
      "--budget", "500",
      "--auto-shed", "9000",
      "--attempts", "2",
      "--yes",
      "--json",
    ]);
    assert.equal(a.url, "http://x/v1");
    assert.equal(a.model, "m");
    assert.equal(a.key, "k");
    assert.equal(a.provider, "p");
    assert.equal(a.budget, 500);
    assert.equal(a.autoShed, 9000);
    assert.equal(a.attempts, 2);
    assert.ok(a.yes && a.json);
  });

  it("rejects unknown options rather than ignoring them", () => {
    assert.throws(() => parseArgs(["--nope"]), /unknown option/);
  });

  it("treats -h and --help alike", () => {
    assert.ok(parseArgs(["-h"]).help);
    assert.ok(parseArgs(["--help"]).help);
  });
});

describe("streaming flags", () => {
  it("streams by default", () => {
    assert.equal(parseArgs([]).stream, true);
  });
  it("can be turned off", () => {
    assert.equal(parseArgs(["--no-stream"]).stream, false);
  });
});

describe("flags that were given no value", () => {
  /**
   * `next()` used to hand back whatever came after a flag — including the next
   * flag, and including nothing at all. `--model --yes` set the model to
   * "--yes" and silently dropped `--yes`; that request reached a real endpoint
   * and came back 404. Others became `undefined` and either vanished or
   * surfaced as a Node type error from inside `resolve()`, naming neither the
   * flag nor the mistake.
   */
  const refuses = (argv: string[], match: RegExp) => {
    assert.throws(() => parseArgs(argv), match, `accepted: ${argv.join(" ")}`);
  };

  it("does not eat the following flag as a value", () => {
    refuses(["run", "x", "--model", "--yes"], /--model needs a value.*--yes/s);
    refuses(["prove", "--url", "--skip", "session"], /--url needs a value.*--skip/s);
    refuses(["run", "x", "--key", "--json"], /--key needs a value/);
  });

  it("names the flag when the value is missing entirely", () => {
    for (const f of ["--url", "--model", "--key", "--provider", "--cwd", "--only", "--skip"]) {
      refuses(["run", "x", f], new RegExp(`\\${f} needs a value`));
    }
  });

  it("still takes a value that merely looks unusual", () => {
    // Only `--` marks a flag. A lone `-` can legitimately begin a value.
    assert.equal(parseArgs(["run", "x", "--model", "-weird-model"]).model, "-weird-model");
    assert.equal(parseArgs(["run", "x", "--provider", "x-ai"]).provider, "x-ai");
  });
});

describe("numeric flags", () => {
  it("refuses counts that cannot mean what they say", () => {
    // `--attempts 0` let the first failed bar exhaust immediately, and
    // `--budget 0` parsed as zero and then read back as "no budget set".
    for (const [flag, bad] of [
      ["--attempts", "0"],
      ["--attempts", "1.5"],
      ["--attempts", "-2"],
      ["--budget", "0"],
      ["--auto-shed", "0"],
    ] as const) {
      assert.throws(
        () => parseArgs(["run", "x", flag, bad]),
        new RegExp(`\\${flag} needs a whole number`),
        `${flag} ${bad} was accepted`,
      );
    }
  });

  it("refuses prices that were silently ignored before", () => {
    // A typo left the meter quoting the previous model's rate.
    assert.throws(() => parseArgs(["run", "x", "--price-in", "foo"]), /--price-in needs a positive number/);
    assert.throws(() => parseArgs(["run", "x", "--price-out", "-3"]), /--price-out needs a positive number/);
    assert.throws(() => parseArgs(["run", "x", "--price-in", "0"]), /--price-in needs a positive number/);
  });

  it("takes the values people actually pass", () => {
    const a = parseArgs(["run", "x", "--attempts", "3", "--budget", "150000", "--price-in", "2.5"]);
    assert.equal(a.attempts, 3);
    assert.equal(a.budget, 150_000);
    assert.equal(a.priceIn, 2.5);
  });
});
