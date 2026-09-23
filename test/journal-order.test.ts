/**
 * "The most recent session" has to mean the one that ran last.
 *
 * Session ids are random hex and the log directory was sorted by name, so
 * `molt log` with no `--session` opened whichever id sorted last. On this
 * project that was a one-line session from 2026-08-19, while the 681-entry
 * session that had actually run last — and been killed mid-turn — sat in the
 * middle of the list, unmentioned. And nothing said it had been killed: a
 * log that stops at a tool result read exactly like one that finished.
 */
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Journal } from "../src/journal.js";
import type { JournalEntry } from "../src/journal.js";
import { Archive } from "../src/archive.js";
import { parseBar, selectChecks } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import { allowAll, drain, scriptedProvider, workspace, type ScriptedTurn } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

function logDir(): { root: string; dir: string } {
  const w = workspace();
  cleanups.push(w.cleanup);
  const dir = join(w.dir, ".molt", "log");
  mkdirSync(dir, { recursive: true });
  return { root: w.dir, dir };
}

const line = (kind: string, iso: string) => JSON.stringify({ seq: 0, iso, kind, data: {}, prev: "", hash: "" });

describe("session order", () => {
  it("lists sessions by when they started, not by their random ids", () => {
    const { root, dir } = logDir();
    writeFileSync(join(dir, "fd691a47.jsonl"), line("session_start", "2026-08-19T17:50:29.983Z") + "\n");
    writeFileSync(join(dir, "9f3117b1.jsonl"), line("session_start", "2026-09-08T14:00:00.000Z") + "\n");
    writeFileSync(join(dir, "0e21c867.jsonl"), line("session_start", "2026-09-01T09:00:00.000Z") + "\n");
    assert.deepEqual(Journal.sessions(root), ["fd691a47.jsonl", "0e21c867.jsonl", "9f3117b1.jsonl"]);
  });

  it("falls back to the file's clock when the first line is unreadable", () => {
    const { root, dir } = logDir();
    writeFileSync(join(dir, "aaaa.jsonl"), line("session_start", "2026-09-01T00:00:00.000Z") + "\n");
    writeFileSync(join(dir, "ffff.jsonl"), "not json\n");
    const past = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(dir, "ffff.jsonl"), past, past);
    assert.deepEqual(Journal.sessions(root), ["ffff.jsonl", "aaaa.jsonl"]);
  });
});

describe("a session that never ended", () => {
  const entries = (...kinds: string[]): JournalEntry[] =>
    kinds.map((k, i) => JSON.parse(line(k, `2026-09-08T16:36:${String(i).padStart(2, "0")}.000Z`)));

  it("is named when the log stops mid-turn", () => {
    assert.equal(Journal.unfinished(entries("session_start", "request", "response", "tool_result"))?.kind, "tool_result");
    assert.equal(Journal.unfinished(entries("session_start", "request"))?.kind, "request", "a hung request");
    assert.equal(Journal.unfinished(entries("session_start", "bar_run", "receipt"))?.kind, "receipt");
  });

  it("is not claimed for a session that ended, or one that did nothing", () => {
    for (const end of ["session_end", "cancelled", "error", "salvage"]) {
      assert.equal(Journal.unfinished(entries("session_start", "request", end)), null, end);
    }
    assert.equal(Journal.unfinished(entries("session_start")), null);
    assert.equal(Journal.unfinished(entries("session_start", "note")), null, "unknown kinds are left unjudged");
    assert.equal(Journal.unfinished([]), null);
  });
});

describe("every way a turn ends is written down", () => {
  // `unfinished` is only as honest as the engine's record: a turn that ends
  // normally without a closing entry reads exactly like one that was killed.
  // Each path a turn can take to its end, and the journal after it.
  const BAR_OK = "version: 1\nchecks:\n  - name: ok\n    run: \"true\"\n";
  const BAR_RED = "version: 1\nchecks:\n  - name: red\n    run: \"false\"\n";
  const BAR_TAGGED = "version: 1\nchecks:\n  - name: fast\n    run: \"true\"\n    tags: [fast]\n  - name: slow\n    run: \"true\"\n    tags: [slow]\n";
  const writeThenClaim: ScriptedTurn[] = [
    { calls: [{ name: "write_file", args: { path: "a.txt", content: "a\n" } }] },
    { text: "Done: wrote a.txt." },
  ];

  async function ending(bar: string | null, opts: { ask?: boolean; skip?: string[] } = {}, turns = writeThenClaim) {
    const { root } = logDir();
    const journal = new Journal(root);
    let parsed = bar === null ? null : parseBar(bar);
    if (parsed && opts.skip) parsed = selectChecks(parsed, { skip: opts.skip });
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      provider: "mock",
      cwd: root,
      journal,
      fetchFn: scriptedProvider(turns).fetchFn,
      bar: parsed,
      archive: new Archive(root),
      receipts: new Receipts(root),
      maxProofAttempts: 1,
    });
    await drain(engine.run("write a.txt", allowAll, { ask: opts.ask }));
    return Journal.unfinished(Journal.read(journal.path));
  }

  it("accepted", async () => assert.equal(await ending(BAR_OK), null));
  it("refused to the attempt limit", async () => assert.equal(await ending(BAR_RED), null));
  it("no bar at all", async () => assert.equal(await ending(null), null));
  it("a question", async () => assert.equal(await ending(BAR_OK, { ask: true }, [{ text: "It checks ok." }]), null));
  it("undetermined", async () => assert.equal(await ending(BAR_TAGGED, { skip: ["slow"] }), null));
});

describe("the shared verify names an unfinished session for every surface", () => {
  it("carries it on Integrity.verifyProject, which the TUI and the window both read", async () => {
    const { Integrity } = await import("../src/integrity.js");
    const { root, dir } = logDir();
    writeFileSync(
      join(dir, "killed.jsonl"),
      [line("session_start", "2026-09-08T14:00:00.000Z"), line("request", "2026-09-08T14:00:01.000Z")].join("\n") + "\n",
    );
    const row = Integrity.verifyProject(root).journals.find((j) => j.file === "killed.jsonl");
    assert.equal(row?.unfinished, "request");
  });
});
