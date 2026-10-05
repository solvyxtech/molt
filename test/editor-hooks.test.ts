/**
 * What the engine exposes for a surface that renders one row per tool call —
 * an editor's agent panel over ACP — and what it does when the editor holds
 * the files.
 *
 * Each of these is a hook the engine did not have: ids tying a call's start,
 * its permission question and its result together; the before-and-after text
 * of a write; reasoning streamed apart from the answer; file access through a
 * caller-supplied reader and writer; which ceiling stopped a turn; and a
 * cancel that lands between the things a turn is doing.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Engine, MAX_STEPS, type FileAccess } from "../src/engine.js";
import type { ConfirmCall, EngineEvent } from "../src/types.js";
import { scriptFetch, type Script } from "./acp-provider.js";
import { allowAll, drain, workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

function ws(): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

function engine(dir: string, script: Script, extra: { stream?: boolean; files?: FileAccess } = {}) {
  const provider = scriptFetch(script);
  const e = new Engine({
    baseUrl: "http://mock/v1",
    model: "m",
    cwd: dir,
    fetchFn: provider.fetchFn,
    stream: extra.stream ?? false,
    files: extra.files,
    retryBackoffMs: [0, 0, 0],
  });
  return { e, provider };
}

/** One tool call, then "done". */
const once =
  (name: string, args: Record<string, unknown>): Script =>
  (r) =>
    r.toolsSinceUser === 0 ? { calls: [{ name, args }] } : { text: "done" };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("tool call identity", () => {
  it("gives the start, the permission question and the result the model's id", async () => {
    const dir = ws();
    const { e } = engine(dir, once("write_file", { path: "a.txt", content: "hi\n" }));
    const asked: ConfirmCall[] = [];
    const events = await drain(
      e.run("write it", async (_n, _d, call) => {
        asked.push(call!);
        return true;
      }),
    );
    const start = events.find((x) => x.kind === "tool_start") as Extract<EngineEvent, { kind: "tool_start" }>;
    const done = events.find((x) => x.kind === "tool") as Extract<EngineEvent, { kind: "tool" }>;
    assert.ok(start.id, "tool_start carries an id");
    assert.equal(done.id, start.id);
    assert.equal(asked.length, 1, "low autonomy asks about a write");
    assert.equal(asked[0]!.id, start.id);
    assert.deepEqual(asked[0]!.args, { path: "a.txt", content: "hi\n" });
    assert.match(asked[0]!.why ?? "", /low autonomy/);
    assert.deepEqual(JSON.parse(start.args!), { path: "a.txt", content: "hi\n" });
  });

  it("redacts a secret in the arguments it announces", async () => {
    const dir = ws();
    const key = "sk-ant-" + "a".repeat(40);
    const { e } = engine(dir, once("bash", { command: `echo ${key}` }));
    e.setAutonomy("high");
    const events = await drain(e.run("go", allowAll));
    const start = events.find((x) => x.kind === "tool_start") as Extract<EngineEvent, { kind: "tool_start" }>;
    assert.ok(!start.args!.includes(key));
  });
});

describe("write diffs", () => {
  it("a new file's diff has no old text", async () => {
    const dir = ws();
    const { e } = engine(dir, once("write_file", { path: "n.txt", content: "new\n" }));
    const events = await drain(e.run("go", allowAll));
    const done = events.find((x) => x.kind === "tool") as Extract<EngineEvent, { kind: "tool" }>;
    assert.deepEqual(done.diff, { path: join(dir, "n.txt"), oldText: null, newText: "new\n" });
  });

  it("an edit's diff has the text before and after", async () => {
    const dir = ws();
    writeFileSync(join(dir, "f.txt"), "one\ntwo\n");
    const { e } = engine(dir, once("edit_file", { path: "f.txt", old_text: "two", new_text: "2" }));
    const events = await drain(e.run("go", allowAll));
    const done = events.find((x) => x.kind === "tool") as Extract<EngineEvent, { kind: "tool" }>;
    assert.deepEqual(done.diff, { path: join(dir, "f.txt"), oldText: "one\ntwo\n", newText: "one\n2\n" });
  });

  it("a refused write carries no diff", async () => {
    const dir = ws();
    const { e } = engine(dir, once("edit_file", { path: "missing.txt", old_text: "a", new_text: "b" }));
    const events = await drain(e.run("go", allowAll));
    const done = events.find((x) => x.kind === "tool") as Extract<EngineEvent, { kind: "tool" }>;
    assert.equal(done.diff, undefined);
  });

  it("a read carries no diff", async () => {
    const dir = ws();
    writeFileSync(join(dir, "r.txt"), "x\n");
    const { e } = engine(dir, once("read_file", { path: "r.txt" }));
    const events = await drain(e.run("go", allowAll));
    const done = events.find((x) => x.kind === "tool") as Extract<EngineEvent, { kind: "tool" }>;
    assert.equal(done.diff, undefined);
  });
});

describe("file access through the editor", () => {
  it("writes through the supplied writer, and ledgers what landed on disk", async () => {
    const dir = ws();
    const written: [string, string][] = [];
    const files: FileAccess = {
      write: async (abs, content) => {
        written.push([abs, content]);
        writeFileSync(abs, content);
      },
    };
    const { e } = engine(dir, once("write_file", { path: "a.txt", content: "via editor\n" }), { files });
    await drain(e.run("go", allowAll));
    assert.deepEqual(written, [[join(dir, "a.txt"), "via editor\n"]]);
    const entry = e.getLedger().find((l) => l.path === "a.txt")!;
    assert.equal(entry.after, sha("via editor\n"));
  });

  it("an editor that reformats on save: the ledger follows the disk, and the model is told", async () => {
    const dir = ws();
    const files: FileAccess = {
      write: async (abs, content) => writeFileSync(abs, content.replace(/;;/g, ";")),
    };
    const { e } = engine(dir, once("write_file", { path: "a.ts", content: "let a = 1;;\n" }), { files });
    const events = await drain(e.run("go", allowAll));
    const entry = e.getLedger().find((l) => l.path === "a.ts")!;
    assert.equal(entry.after, sha("let a = 1;\n"), "hash of the file on disk, not of what was sent");
    assert.equal(entry.after, sha(readFileSync(join(dir, "a.ts"), "utf8")));
    const done = events.find((x) => x.kind === "tool") as Extract<EngineEvent, { kind: "tool" }>;
    assert.match(done.preview ?? "", /reformatted it on save/);
    assert.equal(done.diff?.newText, "let a = 1;\n");
  });

  it("an editor that refuses the write: molt writes disk itself", async () => {
    const dir = ws();
    const files: FileAccess = {
      write: async () => {
        throw new Error("invalid path");
      },
    };
    const { e } = engine(dir, once("write_file", { path: "sub/a.txt", content: "fallback\n" }), { files });
    await drain(e.run("go", allowAll));
    assert.equal(readFileSync(join(dir, "sub", "a.txt"), "utf8"), "fallback\n");
  });

  it("an editor that takes the write but never saves it: disk is brought level", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.txt"), "old\n");
    const files: FileAccess = { write: async () => {} };
    const { e } = engine(dir, once("write_file", { path: "a.txt", content: "new\n" }), { files });
    await drain(e.run("go", allowAll));
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "new\n");
    assert.equal(e.getLedger().find((l) => l.path === "a.txt")!.after, sha("new\n"));
  });

  it("reads through the supplied reader, so the model sees the buffer, not the stale disk", async () => {
    const dir = ws();
    writeFileSync(join(dir, "b.txt"), "on disk\n");
    const files: FileAccess = { read: async () => "unsaved in the editor\n" };
    const { e } = engine(dir, once("read_file", { path: "b.txt" }), { files });
    const events = await drain(e.run("go", allowAll));
    const done = events.find((x) => x.kind === "tool") as Extract<EngineEvent, { kind: "tool" }>;
    assert.match(done.preview ?? "", /unsaved in the editor/);
  });

  it("edits the buffer's text, not the disk's", async () => {
    const dir = ws();
    writeFileSync(join(dir, "c.txt"), "alpha\n");
    let buffer = "alpha\nbeta (unsaved)\n";
    const files: FileAccess = {
      read: async () => buffer,
      write: async (abs, content) => {
        buffer = content;
        writeFileSync(abs, content);
      },
    };
    const { e } = engine(dir, once("edit_file", { path: "c.txt", old_text: "beta", new_text: "BETA" }), { files });
    await drain(e.run("go", allowAll));
    assert.equal(readFileSync(join(dir, "c.txt"), "utf8"), "alpha\nBETA (unsaved)\n");
  });

  it("a reader that fails falls back to disk", async () => {
    const dir = ws();
    writeFileSync(join(dir, "d.txt"), "disk copy\n");
    const files: FileAccess = {
      read: async () => {
        throw new Error("not in project");
      },
    };
    const { e } = engine(dir, once("read_file", { path: "d.txt" }), { files });
    const events = await drain(e.run("go", allowAll));
    const done = events.find((x) => x.kind === "tool") as Extract<EngineEvent, { kind: "tool" }>;
    assert.match(done.preview ?? "", /disk copy/);
  });
});

describe("reasoning", () => {
  it("streams reasoning as thought events and keeps it out of the answer", async () => {
    const dir = ws();
    const { e, provider } = engine(dir, () => ({ thought: "let me think about it", text: "the answer" }), {
      stream: true,
    });
    const events = await drain(e.run("question?", allowAll, { ask: true }));
    const thoughts = events.filter((x) => x.kind === "thought").map((x) => (x as { text: string }).text);
    assert.equal(thoughts.join(""), "let me think about it");
    const deltas = events.filter((x) => x.kind === "delta").map((x) => (x as { text: string }).text);
    assert.equal(deltas.join(""), "the answer");
    // Nothing of the reasoning reaches the transcript sent back next time.
    assert.ok(provider.requests.length >= 1);
    assert.ok(!e.getRecord().some((m) => (m.content ?? "").includes("let me think")));
  });
});

describe("ceilings name themselves", () => {
  it("the step guard says steps", async () => {
    const dir = ws();
    let n = 0;
    const { e } = engine(dir, () => ({ calls: [{ name: "list_dir", args: { path: ".", depth: ++n } }] }));
    const events = await drain(e.run("loop", allowAll));
    const err = events.find((x) => x.kind === "error" && x.ceiling) as Extract<EngineEvent, { kind: "error" }>;
    assert.equal(err.ceiling, "steps");
    assert.match(err.text, new RegExp(`stopped after ${MAX_STEPS} steps`));
  });

  it("the session budget says budget", async () => {
    const dir = ws();
    const { e } = engine(dir, once("list_dir", { path: "." }));
    e.setBudget(1);
    const events = await drain(e.run("go", allowAll));
    const err = events.find((x) => x.kind === "error" && x.ceiling) as Extract<EngineEvent, { kind: "error" }>;
    assert.equal(err.ceiling, "budget");
  });
});

describe("a cancel between the things a turn does", () => {
  it("a cancel during a permission question ends the turn, runs nothing and rolls back", async () => {
    const dir = ws();
    const { e, provider } = engine(dir, once("write_file", { path: "no.txt", content: "x" }));
    const before = e.getRecord().length;
    const events = await drain(
      e.run("go", async () => {
        e.cancel();
        return true; // the answer arrives after the cancel, and must not count
      }),
    );
    assert.equal(existsSync(join(dir, "no.txt")), false);
    assert.ok(events.some((x) => x.kind === "cancelled"));
    const end = events.find((x) => x.kind === "job_end") as Extract<EngineEvent, { kind: "job_end" }>;
    assert.equal(end.outcome, "cancelled");
    assert.equal(provider.requests.length, 1, "no request after the cancel");
    assert.equal(e.getRecord().length, before, "the transcript is rolled back");
  });

  it("a cancel at an idle prompt does not cancel the next turn", async () => {
    const dir = ws();
    const { e } = engine(dir, () => ({ text: "fine" }));
    e.cancel();
    const events = await drain(e.run("hello", allowAll, { ask: true }));
    assert.ok(!events.some((x) => x.kind === "cancelled"));
    assert.ok(events.some((x) => x.kind === "assistant_text"));
  });
});
