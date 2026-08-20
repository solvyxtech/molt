/**
 * Shedding is only allowed to shrink context, never to lose it. Every proof
 * molt produces is checked against the preserved record, so a defect here
 * silently invalidates everything downstream.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { Engine } from "../src/engine.js";
import { DIGEST_HEADER, Transcript } from "../src/transcript.js";
import type { Msg } from "../src/types.js";
import { allowAll, drain, scriptedProvider, toolCall, workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

function conversation(exchanges: number): Transcript {
  const t = new Transcript("SYSTEM");
  for (let i = 0; i < exchanges; i++) {
    t.push({ role: "user", content: `request ${i} ${"x".repeat(800)}` });
    t.push({
      role: "assistant",
      content: null,
      tool_calls: [toolCall("read_file", { path: `file${i}.ts` }, `c${i}`)],
    });
    t.push({ role: "tool", tool_call_id: `c${i}`, content: `contents ${i} ${"y".repeat(800)}` });
    t.push({ role: "assistant", content: `answer ${i} ${"z".repeat(800)}` });
  }
  return t;
}

describe("planShed", () => {
  it("mutates nothing", () => {
    const t = conversation(6);
    const before = JSON.stringify(t.all());
    const plan = t.planShed(2);
    assert.ok(plan, "a six-exchange conversation is worth shedding");
    assert.equal(JSON.stringify(t.all()), before, "planning must be pure");
  });

  it("declines when there is too little to shed", () => {
    assert.equal(conversation(2).planShed(2), null);
    assert.equal(new Transcript("SYSTEM").planShed(2), null);
  });

  it("declines when the digest would cost more than it saves", () => {
    const t = new Transcript("SYSTEM");
    for (let i = 0; i < 4; i++) {
      t.push({ role: "user", content: "hi" });
      t.push({ role: "assistant", content: "ok" });
    }
    const plan = t.planShed(2);
    if (plan) assert.ok(plan.afterTokens < plan.beforeTokens, "a shed must shrink or not happen");
  });

  it("actually shrinks the working context", () => {
    const t = conversation(6);
    const plan = t.planShed(2)!;
    assert.ok(plan.afterTokens < plan.beforeTokens);
    t.commitShed(plan);
    assert.ok(t.historyTokens() < plan.beforeTokens);
  });
});

describe("commitShed", () => {
  it("preserves every shed message in the record", () => {
    const t = conversation(6);
    const beforeRecord = t.record().length;
    const plan = t.planShed(2)!;
    t.commitShed(plan);

    // The digest adds one message; nothing is removed from the record.
    assert.equal(t.record().length, beforeRecord + 1);
    const joined = t
      .record()
      .map((m) => m.content ?? "")
      .join("\n");
    for (let i = 0; i < 6; i++) {
      assert.match(joined, new RegExp(`request ${i}`), `request ${i} survives in the record`);
    }
  });

  it("files the digest as a system message, never as a user turn", () => {
    const t = conversation(6);
    t.commitShed(t.planShed(2)!);
    const digest = t.all().find((m) => m.molt?.digest);
    assert.ok(digest, "a digest exists");
    assert.equal(digest.role, "system", "a user-role digest would re-trigger completed work");
  });

  it("strips molt metadata before anything goes on the wire", () => {
    const t = conversation(6);
    t.commitShed(t.planShed(2)!);
    for (const m of t.wire()) {
      assert.ok(!("molt" in m), "provider payloads must not carry molt bookkeeping");
    }
  });
});

describe("repeated shedding", () => {
  it("carries earlier digests through whole instead of re-truncating them", () => {
    const t = new Transcript("SYSTEM");
    // Markers lead each early request. Once several are folded into one
    // digest, that digest is far longer than the 300-char excerpt cap — so
    // re-excerpting a carried digest would silently drop the later markers.
    const markers = Array.from({ length: 6 }, (_, i) => `MARKER-${i}-${(i + 3) * 9317}`);
    let sheds = 0;
    for (const m of markers) {
      t.push({ role: "user", content: `${m} ${"a".repeat(1500)}` });
      t.push({ role: "assistant", content: `${"b".repeat(1500)}` });
      const plan = t.planShed(2);
      if (plan) {
        t.commitShed(plan);
        sheds++;
      }
    }
    // Two more rounds to force the carried digest through further sheds.
    for (let r = 0; r < 4; r++) {
      t.push({ role: "user", content: `filler ${r} ${"c".repeat(1500)}` });
      t.push({ role: "assistant", content: `reply ${r} ${"d".repeat(1500)}` });
      const plan = t.planShed(2);
      if (plan) {
        t.commitShed(plan);
        sheds++;
      }
    }
    assert.ok(sheds >= 3, `expected repeated shedding, got ${sheds}`);

    const digests = t.all().filter((m) => m.molt?.digest);
    assert.equal(digests.length, 1, "digests are merged, never stacked");
    const body = digests[0].content ?? "";

    const lost = markers.filter((m) => !body.includes(m));
    assert.deepEqual(lost, [], `re-truncation dropped ${lost.length} marker(s): ${lost.join(", ")}`);

    const headers = body.split(DIGEST_HEADER).length - 1;
    assert.equal(headers, 1, "one header, not one per generation");
  });

  it("keeps digest growth sub-linear across sheds", () => {
    const t = new Transcript("SYSTEM");
    const sizes: number[] = [];
    for (let i = 0; i < 14; i++) {
      t.push({ role: "user", content: `req ${i} ${"q".repeat(1500)}` });
      t.push({ role: "assistant", content: `res ${i} ${"r".repeat(1500)}` });
      const plan = t.planShed(2);
      if (plan) {
        t.commitShed(plan);
        const d = t.all().find((m) => m.molt?.digest);
        if (d) sizes.push((d.content ?? "").length);
      }
    }
    assert.ok(sizes.length >= 3, "expected several sheds");
    const growth = sizes[sizes.length - 1] / sizes[0];
    assert.ok(growth < sizes.length, `digest grew ${growth.toFixed(1)}x over ${sizes.length} sheds`);
  });
});

describe("round-trip recovery", () => {
  it("regrows every seeded fact back into live context after shedding", () => {
    // The bar is not "the bytes are on disk somewhere". It is: seed N facts,
    // shed them out of context, regrow, and find all N in the messages that
    // would actually be sent to the model.
    const dir = ws();
    const archive = new Archive(dir);
    const t = new Transcript("SYSTEM");
    const facts = Array.from({ length: 120 }, (_, i) => `FACT-${i}-${(i * 7919) % 10007}`);

    // Facts are placed PAST the digest's 300-char excerpt cap on purpose.
    // A fact at the front of a message survives shedding in the digest, so
    // putting it there would test nothing.
    facts.forEach((f, i) => {
      t.push({ role: "user", content: `remember this ${"p".repeat(1200)} ${f}` });
      t.push({ role: "assistant", content: `noted at step ${i} ${"q".repeat(1200)} ${f}` });
    });

    let batches = 0;
    for (;;) {
      const plan = t.planShed(2);
      if (!plan) break;
      archive.write(plan.exuvia, plan.droppedCount, "seed");
      t.commitShed(plan);
      batches++;
      if (batches > 200) break;
    }
    assert.ok(batches > 0, "expected at least one shed");

    // Live context alone must NOT still hold everything — otherwise the test
    // would pass without shedding having done anything.
    const afterShed = t.wire().map((m) => m.content ?? "").join("\n");
    const shedOut = facts.filter((f) => !afterShed.includes(f));
    assert.ok(shedOut.length > 0, "shedding must actually remove facts from context");

    // Now regrow every archived batch and require all N in live context.
    for (const entry of archive.list()) {
      t.regrow(archive.read(entry.index));
    }
    const live = t.wire().map((m) => m.content ?? "").join("\n");
    const lost = facts.filter((f) => !live.includes(f));
    assert.deepEqual(lost, [], `${lost.length}/120 facts not recoverable into live context`);
  });

  it("finds a specific shed fact by pattern", () => {
    const dir = ws();
    const archive = new Archive(dir);
    const t = new Transcript("SYSTEM");
    t.push({ role: "user", content: "the auth token refreshes every 900 seconds" });
    t.push({ role: "assistant", content: "understood" });
    for (let i = 0; i < 6; i++) {
      t.push({ role: "user", content: `unrelated ${i} ${"u".repeat(1500)}` });
      t.push({ role: "assistant", content: `fine ${i} ${"f".repeat(1500)}` });
    }
    const plan = t.planShed(2)!;
    archive.write(plan.exuvia, plan.droppedCount, "auth");
    t.commitShed(plan);

    const hits = archive.grep("900 seconds");
    assert.equal(hits.length, 1);
    assert.match(hits[0].excerpt, /auth token refreshes/);
  });
});

describe("two-phase shed", () => {
  it("loses nothing when the archive write fails", async () => {
    const dir = ws();
    const failing = {
      dir,
      write(): never {
        throw new Error("ENOSPC: no space left on device");
      },
      list: () => [],
      read: () => "",
    };

    const provider = scriptedProvider([{ text: "hi" }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: null,
      archive: failing,
    });

    for (let i = 0; i < 6; i++) {
      await drain(engine.run(`request ${i} ${"x".repeat(1500)}`, allowAll));
    }

    const before = JSON.stringify(engine.getRecord());
    assert.throws(() => engine.shed(), /ENOSPC/);
    assert.equal(
      JSON.stringify(engine.getRecord()),
      before,
      "a failed archive write must leave context byte-identical",
    );
  });

  it("writes the archive before mutating the transcript", async () => {
    const dir = ws();
    const order: string[] = [];
    const archive = new Archive(dir);
    const spy = {
      dir: archive.dir,
      write(exuvia: string, n: number, ask: string) {
        order.push("archive");
        return archive.write(exuvia, n, ask);
      },
      list: () => archive.list(),
      read: (i: number) => archive.read(i),
    };

    const provider = scriptedProvider([{ text: "ok" }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: null,
      archive: spy,
    });
    for (let i = 0; i < 6; i++) {
      await drain(engine.run(`req ${i} ${"y".repeat(1500)}`, allowAll));
    }
    const shed = engine.shed();
    order.push("commit");

    assert.ok(shed, "expected a shed");
    assert.deepEqual(order, ["archive", "commit"]);
    assert.ok(existsSync(join(archive.dir, shed.path)), "the exuvia is on disk");
  });
});

describe("archive", () => {
  it("maintains a browsable index", () => {
    const dir = ws();
    const archive = new Archive(dir);
    archive.write("# one\n\n## user\n\nfirst\n", 1, "first ask");
    archive.write("# two\n\n## user\n\nsecond\n", 1, "second ask");

    const index = readFileSync(join(archive.dir, "index.md"), "utf8");
    assert.match(index, /first ask/);
    assert.match(index, /second ask/);
    assert.equal(archive.list().length, 2);
  });

  it("survives a reopened session and keeps numbering", () => {
    const dir = ws();
    new Archive(dir).write("# a\n\n## user\n\nx\n", 1, "a");
    const reopened = new Archive(dir);
    const entry = reopened.write("# b\n\n## user\n\ny\n", 1, "b");
    assert.equal(entry.index, 1, "numbering continues across sessions");
    assert.equal(reopened.list().length, 2);
  });

  it("escapes pipes so one message cannot corrupt the index table", () => {
    const dir = ws();
    const archive = new Archive(dir);
    archive.write("# x\n\n## user\n\nz\n", 1, "run a | b | c");
    const index = readFileSync(join(archive.dir, "index.md"), "utf8");
    const row = index.trim().split("\n").at(-1)!;
    assert.equal(row.split(/(?<!\\)\|/).length - 1, 7, "one row, columns intact");
  });

  it("never reissues an index that already belongs to a surviving exuvia", () => {
    // Seeding the next index from `list().length` breaks the instant a
    // middle exuvia is gone: the count drops below the highest index still on
    // disk, and the next write reissues that index onto a second file.
    // `read()`/`grep()` then resolve to whichever of the two sorts first,
    // making the *new* batch — which was never deleted or tampered with —
    // unreachable by index. The next index must always be one past the
    // highest that ever existed, not a count of what remains.
    const dir = ws();
    const archive = new Archive(dir);
    for (let i = 0; i < 5; i++) archive.write(`# batch ${i}\n\n## user\n\nm${i}\n`, 1, `ask ${i}`);
    const middle = readdirSync(archive.dir).find((f) => f.startsWith("0002-"))!;
    unlinkSync(join(archive.dir, middle));

    const reopened = new Archive(dir);
    const entry = reopened.write("# new\n\n## user\n\nafter delete\n", 1, "after delete");
    assert.equal(entry.index, 5, "the next index must be past the highest ever issued, not a count");

    const indices = reopened.list().map((e) => e.index);
    const dupes = indices.filter((v, i) => indices.indexOf(v) !== i);
    assert.deepEqual(dupes, [], "no index should ever be shared by two files");
    assert.match(reopened.read(5), /after delete/, "the new batch must be reachable by its own index");
  });
});

describe("digest content", () => {
  it("excerpts verbatim rather than paraphrasing", () => {
    const t = conversation(6);
    const plan = t.planShed(2)!;
    assert.match(plan.digest, /request 0/);
    assert.match(plan.digest, /read_file: file0\.ts/);
    assert.ok(plan.digest.startsWith(DIGEST_HEADER));
  });

  it("survives malformed tool arguments without throwing", () => {
    const t = new Transcript("SYSTEM");
    const bad: Msg = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "x", function: { name: "bash", arguments: "{not json" } }],
    };
    for (let i = 0; i < 6; i++) {
      t.push({ role: "user", content: `r ${i} ${"m".repeat(1500)}` });
      t.push(bad);
      t.push({ role: "assistant", content: `a ${i} ${"n".repeat(1500)}` });
    }
    const plan = t.planShed(2);
    assert.ok(plan);
    assert.match(plan.digest, /unparseable arguments/);
  });
});
