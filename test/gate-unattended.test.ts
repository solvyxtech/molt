/**
 * The gate, as a headless `--yes` run meets it.
 *
 * Headless, every "ask" is answered "User denied this action.", so a command
 * the gate asks about is a command the model cannot run at all. The local
 * bench journals (v9-old/v9-new, 118/161 denials) showed which ones: writing
 * the deliverable with a heredoc or printf, removing a scratch file the model
 * itself had made with `echo > t1.txt`, and the batch tool arriving as itself.
 * Each test here is one of those real commands.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gate, overwritesOnlyNew } from "../src/autonomy.js";
import { Engine } from "../src/engine.js";
import type { Confirm } from "../src/types.js";
import { drain, scriptedProvider, workspace, type ScriptedTurn } from "./helpers.js";

describe("act as itself at the gate", () => {
  it("is inert: it runs nothing, so nothing is asked", () => {
    for (const level of ["low", "medium", "high"] as const) {
      const d = gate(level, { name: "act", args: { analysis: "a", actions: "oops" }, cwd: "/work/p" });
      assert.equal(d.ask, false, level);
    }
  });

  it("an unreadable act gets the engine's shape error, not 'User denied'", async () => {
    const ws = workspace();
    try {
      const asked: string[] = [];
      const deny: Confirm = async (name) => {
        asked.push(name);
        return false;
      };
      const provider = scriptedProvider([
        { calls: [{ name: "act", args: { analysis: "x", actions: "not-an-array" } }] },
        { text: "ok" },
      ]);
      const engine = new Engine({
        baseUrl: "http://mock/v1", model: "m", cwd: ws.dir, bar: null, stream: false,
        autonomy: "high", batch: true, fetchFn: provider.fetchFn,
      });
      const events = await drain(engine.run("do it", deny));
      assert.deepEqual(asked, [], "act was never put to a person");
      const text = events.map((e) => JSON.stringify(e)).join("\n");
      assert.match(text, /nothing ran, because at least one of its actions could not be read/);
      assert.doesNotMatch(text, /User denied/);
    } finally {
      ws.cleanup();
    }
  });
});

describe("writing a new deliverable with a heredoc, printf or tee", () => {
  const ws = workspace();
  const high = (command: string, created: string[] = []) =>
    gate("high", { name: "bash", args: { command }, cwd: ws.dir, created: new Set(created) }).ask;
  writeFileSync(join(ws.dir, "keep.csv"), "x\n");
  mkdirSync(join(ws.dir, "inbox"));

  it("a quoted heredoc into a new file", () => {
    assert.equal(high("cat << 'EOF' > top_customers.csv\nname,total\nann,5 > 3\nEOF"), false);
    assert.equal(high("cat <<EOF > top.csv\nname,total\nEOF"), false);
    assert.equal(high("cat > top.csv << 'EOF'\nrm -rf x\nEOF"), false, "the body is text, not an rm");
  });

  it("the heredoc then a query in the same command", () => {
    assert.equal(
      high('cat << EOF > top_customers.csv\nname,total\nEOF\nsqlite3 -header -csv shop.db "SELECT 1"'),
      false,
    );
  });

  it("printf and echo whose text mentions rm", () => {
    assert.equal(high("printf '#!/bin/sh\\nrm -f old.log\\n' > rotate.sh"), false);
    assert.equal(high('echo "rm -f a" > rotate.sh'), false);
    assert.equal(high("echo ' rm -- \"$file\"' >> rotate.sh"), false, "appended script text");
    assert.equal(high("echo ' rm -- x' >> /etc/rotate.sh"), true, "append outside the project");
    assert.equal(high("rm keep.csv >> log.txt"), true, "an rm is still an rm");
  });

  it("tee into a new file", () => {
    assert.equal(high("echo hello | tee out.txt"), false);
    assert.equal(high("tee notes.txt << 'EOF'\nline\nEOF"), false);
  });

  it("still asks when it cannot be sure", () => {
    assert.equal(high("cat << 'EOF' > keep.csv\nx\nEOF"), true, "existing file");
    assert.equal(high("cat << 'EOF' > keep.csv\nx\nEOF", ["keep.csv"]), false, "unless made this session");
    assert.equal(high("cat << 'EOF' > inbox\nx\nEOF"), true, "a directory");
    assert.equal(high("cat << 'EOF' > /etc/motd\nx\nEOF"), true, "outside the project");
    assert.equal(high("cat << EOF > a.txt\n$(rm -rf .)\nEOF"), true, "unquoted heredoc expands $()");
    assert.equal(high("bash << 'EOF' > a.txt\nrm -rf .\nEOF"), true, "the body is a program");
    assert.equal(high("cat << 'EOF' > a.txt\nx"), true, "unterminated heredoc");
    assert.equal(high("printf '%s' \"$(rm x)\" > a.txt"), true, "substitution in the text");
    assert.equal(high("echo x | tee keep.csv"), true, "tee over an existing file");
    assert.equal(high("echo x | tee /etc/molt-out.txt"), true, "tee outside the project");
    assert.equal(high("echo x > a.txt; rm keep.csv"), true, "a real rm alongside");
    assert.equal(high("tee *.txt << 'EOF'\nx\nEOF"), true, "a glob is not a path");
    assert.equal(overwritesOnlyNew("echo x", new Set(), ws.dir), false);
  });
});

describe("removing what bash itself made", () => {
  function run(dir: string, turns: ScriptedTurn[]) {
    const asked: string[] = [];
    const deny: Confirm = async (_n, detail) => {
      asked.push(detail);
      return false;
    };
    const provider = scriptedProvider(turns);
    const engine = new Engine({
      baseUrl: "http://mock/v1", model: "m", cwd: dir, bar: null, stream: false,
      autonomy: "high", fetchFn: provider.fetchFn,
    });
    return { engine, asked, deny };
  }
  const bash = (command: string): ScriptedTurn => ({ calls: [{ name: "bash", args: { command } }] });

  it("rm of a file an earlier bash call created is allowed", async () => {
    const ws = workspace();
    try {
      const { engine, asked, deny } = run(ws.dir, [bash("echo hi > t1.txt && cat t1.txt"), bash("rm t1.txt"), { text: "done" }]);
      await drain(engine.run("go", deny));
      assert.deepEqual(asked, []);
      assert.equal(existsSync(join(ws.dir, "t1.txt")), false);
    } finally {
      ws.cleanup();
    }
  });

  it("rm of a file that existed before the session still asks", async () => {
    const ws = workspace();
    try {
      mkdirSync(join(ws.dir, "inbox"));
      writeFileSync(join(ws.dir, "inbox", "a.txt"), "a\n");
      writeFileSync(join(ws.dir, "old.txt"), "o\n");
      const { engine, asked, deny } = run(ws.dir, [
        bash("echo hi > t1.txt"),
        bash("rm -rf inbox"),
        bash("rm old.txt"),
        { text: "done" },
      ]);
      await drain(engine.run("go", deny));
      assert.equal(asked.length, 2, "both pre-existing deletes asked");
      assert.ok(existsSync(join(ws.dir, "inbox", "a.txt")));
      assert.ok(existsSync(join(ws.dir, "old.txt")));
    } finally {
      ws.cleanup();
    }
  });

  it("a file bash only appended to (not created) is not counted as created", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "old.txt"), "o\n");
      const { engine, asked, deny } = run(ws.dir, [bash("echo n >> old.txt"), bash("rm old.txt"), { text: "done" }]);
      await drain(engine.run("go", deny));
      assert.equal(asked.length, 1);
      assert.ok(existsSync(join(ws.dir, "old.txt")));
    } finally {
      ws.cleanup();
    }
  });
});
