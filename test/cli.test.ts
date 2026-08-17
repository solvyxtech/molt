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
