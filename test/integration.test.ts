/**
 * End-to-end over a real socket.
 *
 * The injected-fetch tests prove the logic. This one proves the wire: that
 * what molt serializes is what a provider receives, that molt survives the
 * malformed and hostile responses a local server actually produces, and
 * that the proof loop holds up when nothing is stubbed.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { loadBar, writeDefaultBar } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import type { EngineEvent } from "../src/types.js";
import { allowAll, denyAll, drain, kinds, workspace } from "./helpers.js";

type Turn = { text: string } | { calls: { name: string; args: Record<string, unknown> }[] };

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

/** Write a project bar, creating .molt/ if it does not exist yet. */
function writeBar(dir: string, yaml: string): void {
  mkdirSync(join(dir, ".molt"), { recursive: true });
  writeFileSync(join(dir, ".molt", "done.yml"), yaml, "utf8");
}

/** A provider that replays scripted turns and records what it was sent. */
async function mockProvider(opts: {
  turns?: Turn[];
  status?: number;
  body?: string;
  received?: unknown[];
}): Promise<{ url: string; close: () => Promise<void>; received: unknown[] }> {
  const received: unknown[] = opts.received ?? [];
  let n = 0;
  let id = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        received.push(JSON.parse(raw));
      } catch {
        received.push({ unparseable: raw });
      }

      if (opts.status && opts.status !== 200) {
        res.writeHead(opts.status, { "content-type": "text/plain" });
        res.end(opts.body ?? "upstream exploded");
        return;
      }
      if (opts.body !== undefined) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(opts.body);
        return;
      }

      const turns = opts.turns ?? [{ text: "ok" }];
      const turn = turns[Math.min(n, turns.length - 1)];
      n += 1;
      const message =
        "text" in turn
          ? { role: "assistant", content: turn.text }
          : {
              role: "assistant",
              content: null,
              tool_calls: turn.calls.map((c) => ({
                id: `call_${++id}`,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            };

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message }],
          usage: { prompt_tokens: 250, completion_tokens: 40 },
        }),
      );
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const close = () => new Promise<void>((r) => server.close(() => r()));
  cleanups.push(() => void close());
  return { url: `http://127.0.0.1:${port}/v1`, close, received };
}

function engineAt(dir: string, url: string, over: Record<string, unknown> = {}) {
  return new Engine({
    baseUrl: url,
    model: "mock-model",
    provider: "mock",
    cwd: dir,
    bar: loadBar(dir),
    archive: new Archive(dir),
    receipts: new Receipts(dir),
    // These prove what molt does with a bad response, not how patiently it
    // waits between asking again. The real backoff added eight seconds to each
    // of three tests, on a suite that runs on every proof attempt.
    retryBackoffMs: [5, 5, 5],
    ...over,
  });
}

describe("over a real socket", () => {
  it("refuses a lying model and accepts the honest retry", async () => {
    const dir = ws();
    writeBar(dir,
      "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n",
    );

    const { url } = await mockProvider({
      turns: [
        { text: "All done — I refactored the module and tests pass." },
        { calls: [{ name: "write_file", args: { path: "src/real.ts", content: "export const x = 1;\n" } }] },
        { text: "Refactor complete." },
      ],
    });

    const engine = engineAt(dir, url);
    const events = await drain(engine.run("refactor the module", allowAll));
    const order = kinds(events);

    assert.ok(order.includes("proof_refused"));
    assert.ok(order.includes("proof_result"));
    assert.ok(existsSync(join(dir, "src", "real.ts")));
    assert.equal(events.filter((e) => e.kind === "assistant_text").length, 1);
  });

  it("sends clean OpenAI-shaped payloads with no molt bookkeeping", async () => {
    const dir = ws();
    writeDefaultBar(dir);
    const { url, received } = await mockProvider({
      turns: [
        { calls: [{ name: "write_file", args: { path: "a.txt", content: "hello\n" } }] },
        { text: "done" },
      ],
    });

    const engine = engineAt(dir, url);
    await drain(engine.run("write a file", allowAll));

    assert.ok(received.length >= 2);
    for (const body of received as {
      model: string;
      messages: Record<string, unknown>[];
      tools: unknown[];
      tool_choice: string;
    }[]) {
      assert.equal(body.model, "mock-model");
      assert.equal(body.tool_choice, "auto");
      assert.equal(body.tools.length, 6);
      for (const m of body.messages) {
        assert.ok(!("molt" in m), "internal metadata must never reach a provider");
        assert.ok(["system", "user", "assistant", "tool"].includes(String(m.role)));
      }
    }
  });

  it("carries bar failures back to the provider as real message content", async () => {
    const dir = ws();
    writeFileSync(join(dir, "fail.sh"), 'echo "ERR-8823 migration incomplete" >&2\nexit 1\n');
    writeBar(dir,
      "version: 1\nchecks:\n  - name: migrate\n    run: sh fail.sh\n    timeout: 10\n",
    );

    const { url, received } = await mockProvider({ turns: [{ text: "Migrated." }] });
    const engine = engineAt(dir, url, { maxProofAttempts: 3 });
    await drain(engine.run("run the migration", allowAll));

    const last = received.at(-1) as { messages: { content: string }[] };
    const joined = last.messages.map((m) => m.content ?? "").join("\n");
    assert.match(joined, /ERR-8823 migration incomplete/);
  });

  it("survives an HTTP error without corrupting the session", async () => {
    const dir = ws();
    writeDefaultBar(dir);
    const { url } = await mockProvider({ status: 503, body: "service unavailable" });
    const engine = engineAt(dir, url);

    const events = await drain(engine.run("hello", allowAll));
    const err = events.find((e) => e.kind === "error") as { text: string } | undefined;
    assert.ok(err && /HTTP 503/.test(err.text));
    assert.ok(!kinds(events).includes("assistant_text"));
  });

  it("survives a non-JSON response", async () => {
    const dir = ws();
    writeDefaultBar(dir);
    const { url } = await mockProvider({ body: "<html>nginx</html>" });
    const engine = engineAt(dir, url);
    const events = await drain(engine.run("hello", allowAll));
    assert.ok(
      (events.find((e) => e.kind === "error") as { text: string } | undefined)?.text.includes(
        "non-JSON",
      ),
    );
  });

  it("survives a response with no choices", async () => {
    const dir = ws();
    writeDefaultBar(dir);
    const { url } = await mockProvider({ body: JSON.stringify({ id: "x", object: "nothing" }) });
    const engine = engineAt(dir, url);
    const events = await drain(engine.run("hello", allowAll));
    assert.match(
      (events.find((e) => e.kind === "error") as { text: string }).text,
      /missing choices/,
    );
  });

  it("treats a denied write as a write that did not happen", async () => {
    const dir = ws();
    writeBar(dir,
      "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n",
    );
    const { url } = await mockProvider({
      turns: [
        { calls: [{ name: "write_file", args: { path: "nope.txt", content: "x\n" } }] },
        { text: "Wrote it." },
      ],
    });
    const engine = engineAt(dir, url, { maxProofAttempts: 1 });
    const events = await drain(engine.run("write it", denyAll));

    assert.ok(!existsSync(join(dir, "nope.txt")));
    assert.ok(!kinds(events).includes("assistant_text"), "a denied write is not a completed task");
    const ex = events.find((e) => e.kind === "proof_exhausted") as
      | { result: { results: { output: string }[] } }
      | undefined;
    assert.match(ex!.result.results.map((r) => r.output).join("\n"), /none landed on disk/);
  });

  it("keeps API keys out of the environment of shelled commands", async () => {
    const dir = ws();
    writeDefaultBar(dir);
    // Assembled, not written out: this file should hold no literal a secret
    // scanner has to make a judgement about.
    const planted = `sk-${"should-not-leak-4471"}`;
    process.env.OPENROUTER_API_KEY = planted;
    const { url } = await mockProvider({
      turns: [
        { calls: [{ name: "bash", args: { command: "env > leaked.txt" } }] },
        { calls: [{ name: "write_file", args: { path: "ok.txt", content: "fine\n" } }] },
        { text: "done" },
      ],
    });
    const engine = engineAt(dir, url);
    await drain(engine.run("dump env", allowAll));
    delete process.env.OPENROUTER_API_KEY;

    const leaked = readFileSync(join(dir, "leaked.txt"), "utf8");
    assert.ok(!leaked.includes(planted), "provider keys must be scrubbed");
  });

  it("stops on budget before spending past it", async () => {
    const dir = ws();
    writeDefaultBar(dir);
    const { url, received } = await mockProvider({
      turns: [{ calls: [{ name: "bash", args: { command: "echo loop" } }] }],
    });
    const engine = engineAt(dir, url);
    // Each mocked turn reports 290 tokens, so 400 stops it on the third check.
    engine.setBudget(400);

    const events = await drain(engine.run("spin", allowAll));
    const err = events.find((e) => e.kind === "error") as { text: string } | undefined;
    assert.ok(err && /budget hit/.test(err.text), `wrong stop: ${err?.text}`);
    assert.ok(received.length <= 3, `budget should cap requests, saw ${received.length}`);
  });

  it("names a model repeating itself, and does not end the turn over it", async () => {
    // molt used to kill the turn on the second repeated step. Repetition is a
    // guess at waste and a bad one — re-reading a file you just edited is a
    // repeat and is progress — and the guess cost a real session 384,000
    // tokens of work for nothing. Spend is bounded by the instruments that
    // measure spend; this one only has to be visible.
    const dir = ws();
    writeDefaultBar(dir);
    writeFileSync(join(dir, "notes.md"), "the same content every time\n");
    const { url } = await mockProvider({
      turns: [{ calls: [{ name: "read_file", args: { path: "notes.md" } }] }],
    });
    const engine = engineAt(dir, url);

    const events = await drain(engine.run("study the notes", allowAll));

    // Named while it happens, every time it happens.
    assert.ok(
      events.some((e) => e.kind === "info" && /nothing new came back/.test(e.text)),
      "repetition passed in silence",
    );
    // And named as a streak once it is one, so it is legible without the log.
    assert.ok(
      events.some((e) => e.kind === "info" && /steps in a row/.test(e.text)),
      "never said it was going in circles",
    );
    const err = events.find((e) => e.kind === "error") as { text: string } | undefined;
    assert.ok(
      !err || !/repeating calls/.test(err.text),
      `still ending the turn on the repeat heuristic: ${err?.text}`,
    );
  });

  it("lets the budget be what stops a model going in circles", async () => {
    // What replaces the removed guard: a limit the user set, measured in the
    // unit they set it in, checked before every step.
    const dir = ws();
    writeDefaultBar(dir);
    writeFileSync(join(dir, "notes.md"), "the same content every time\n");
    const { url, received } = await mockProvider({
      turns: [{ calls: [{ name: "read_file", args: { path: "notes.md" } }] }],
    });
    const engine = engineAt(dir, url);
    engine.setBudget(400);

    const events = await drain(engine.run("study the notes", allowAll));
    const err = events.find((e) => e.kind === "error") as { text: string } | undefined;
    assert.ok(err && /budget hit/.test(err.text), `wrong stop: ${err?.text}`);
    assert.ok(received.length <= 3, `budget should cap requests, saw ${received.length}`);
    // The turn still hands back what it paid for rather than throwing it away.
    assert.ok(
      events.some((e) => e.kind === "assistant_text" || e.kind === "info"),
      "stopped without reporting anything it had found",
    );
  });

  it("does not resend a result the model already has", async () => {
    const dir = ws();
    writeDefaultBar(dir);
    writeFileSync(join(dir, "notes.md"), "x".repeat(1200) + "\n");
    const { url } = await mockProvider({
      turns: [{ calls: [{ name: "read_file", args: { path: "notes.md" } }] }],
    });
    const engine = engineAt(dir, url);
    const events = await drain(engine.run("study the notes", allowAll));

    const tools = events.filter((e): e is Extract<EngineEvent, { kind: "tool" }> => e.kind === "tool");
    assert.ok(tools.length >= 2, "expected the model to repeat the call");
    assert.equal(tools[0]!.note, undefined);
    assert.equal(tools[1]!.note, "repeat", "resent the same payload instead of pointing at it");
    // A pointer, not a payload: the second result is a fraction of the first.
    assert.ok((tools[1]!.bytes ?? 0) < (tools[0]!.bytes ?? 0) / 3);
  });

  it("stops a model that walks the same file with shifted offsets", async () => {
    // The 661,000-token failure, from the other side. Exact-match detection
    // was defeated by asking for line 181 and then line 182 — almost the same
    // bytes under a different key. Coverage answers the question that matters:
    // has this already been shown?
    const dir = ws();
    writeDefaultBar(dir);
    writeFileSync(join(dir, "big.txt"), Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"));
    let n = 0;
    const { url } = await mockProvider({
      turns: Array.from({ length: 8 }, () => ({
        // Each turn asks for a window inside what it has already been shown.
        calls: [{ name: "read_file", args: { path: "big.txt", offset: (n += 1) } }],
      })),
    });
    const engine = engineAt(dir, url);
    const events = await drain(engine.run("study it", allowAll));

    const tools = events.filter((e): e is Extract<EngineEvent, { kind: "tool" }> => e.kind === "tool");
    assert.ok(
      tools.some((t) => t.note === "repeat"),
      "a shifted offset walked straight past the detection",
    );
    // Detection is what earns its keep: the re-read gets a pointer instead of
    // the bytes, so a model circling costs less each time round rather than
    // having its turn taken away.
    const repeat = tools.find((t) => t.note === "repeat")!;
    const first = tools.find((t) => t.note === undefined)!;
    assert.ok(
      (repeat.bytes ?? 0) < (first.bytes ?? 0),
      "resent the payload it had already sent",
    );
  });

  it("stops a model drifting its offset a few lines at a time", async () => {
    // Found by the stress harness after the first fix: a window overlapping an
    // earlier one by 99% and running three lines past it is not *contained* by
    // it, so containment alone let a drifting reader run to the step guard —
    // 32 steps and 99,000 tokens. What matters is how much of a read is new.
    const dir = ws();
    writeDefaultBar(dir);
    writeFileSync(join(dir, "big.ts"), Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n"));
    let n = 0;
    const { url } = await mockProvider({
      turns: Array.from({ length: 10 }, () => ({
        calls: [{ name: "read_file", args: { path: "big.ts", offset: (n += 3) } }],
      })),
    });
    const engine = engineAt(dir, url);
    const events = await drain(engine.run("study it", allowAll));

    const tools = events.filter((e): e is Extract<EngineEvent, { kind: "tool" }> => e.kind === "tool");
    assert.ok(tools.some((t) => t.note === "repeat"), "a three-line drift walked past the detection");
    assert.match(
      tools.find((t) => t.note === "repeat")?.preview ?? "",
      /offset=\d+ or later/,
      "told the model it was repeating without telling it where to go instead",
    );
  });

  it("reports the actual line range in a repeat warning, not the header lines", async () => {
    // `read_file` results are prefixed with a header and may end with a
    // continuation notice. The coverage tracker used to count those lines as
    // file content, so a one-line read was reported as covering three lines,
    // and the guidance told the model to continue past what it had actually
    // seen. This matters most when a model reads a file in tiny parts and the
    // wrong range accumulates into a skipped section.
    const dir = ws();
    writeDefaultBar(dir);
    writeFileSync(join(dir, "sample.txt"), Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
    const { url } = await mockProvider({
      turns: [
        { calls: [{ name: "read_file", args: { path: "sample.txt", offset: 0, limit: 2 } }] },
        { calls: [{ name: "read_file", args: { path: "sample.txt", offset: 1, limit: 1 } }] },
        { text: "done" },
      ],
    });
    const engine = engineAt(dir, url);
    const events = await drain(engine.run("read it carefully", allowAll));

    const tools = events.filter((e): e is Extract<EngineEvent, { kind: "tool" }> => e.kind === "tool");
    const repeat = tools.find((t) => t.note === "repeat");
    assert.ok(repeat, "the overlapping read should have been flagged as a repeat");
    // The second read asked for line 2 (offset 1, 1-based). The warning must
    // say that exact line was already shown, not inflate the range with the
    // header/tail lines. And the continuation hint must point at the real next
    // unread line (offset 2), not beyond it.
    assert.match(
      repeat.preview ?? "",
      /lines 2-2 of sample\.txt/,
      "reported the wrong line range for the repeated read",
    );
    assert.match(
      repeat.preview ?? "",
      /offset=2 or later/,
      "told the model to continue past what it had actually shown",
    );
    assert.ok(
      !/lines 2-\d{2,}/.test(repeat.preview ?? ""),
      "the range must not include the header or continuation notice as content lines",
    );
  });

  it("serves a file again after shedding removed it from context", async () => {
    // The trap, from a real session: shedding archives the messages holding a
    // file's contents, and the read-coverage map went on believing the model
    // had them — so molt refused the re-read and told it to scroll up to
    // something molt had just deleted. 29 of that session's 31 repeat-refusals
    // came after the first shed, and the no-progress guard then called the
    // stall a loop and killed the turn.
    const dir = ws();
    writeDefaultBar(dir);
    writeFileSync(join(dir, "notes.md"), Array.from({ length: 40 }, (_, i) => `note ${i}`).join("\n"));
    const filler = "z".repeat(1500);
    const { url } = await mockProvider({
      turns: [
        { calls: [{ name: "read_file", args: { path: "notes.md" } }] },
        // Enough traffic to force a shed.
        ...Array.from({ length: 6 }, (_, i) => ({
          calls: [{ name: "bash", args: { command: `echo ${i} ${filler}` } }],
        })),
        // The same read again, now that context no longer holds it.
        { calls: [{ name: "read_file", args: { path: "notes.md" } }] },
        { text: "done" },
      ],
    });
    const engine = engineAt(dir, url, { autoShedAtTokens: 1500 });
    const events = await drain(engine.run("read and then work", allowAll));

    assert.ok(events.some((e) => e.kind === "shed"), "the fixture did not actually shed");
    const reads = events.filter(
      (e): e is Extract<EngineEvent, { kind: "tool" }> => e.kind === "tool" && e.name === "read_file",
    );
    assert.equal(reads.length, 2);
    assert.notEqual(reads[1]!.note, "repeat", "refused to re-serve a file it had shed");
    assert.match(reads[1]!.preview ?? "", /note 0/, "the second read did not return the contents");
  });

  it("keeps every part of a file it was shown, so it never re-reads one", async () => {
    // Elision was keyed on the path, so page two deleted page one and the
    // model had to fetch it again — forever.
    const dir = ws();
    writeDefaultBar(dir);
    // 1000 lines at ~68 bytes each: a 16KB part is roughly 230 lines, so these
    // offsets walk forward without ever re-asking for a line already shown.
    writeFileSync(join(dir, "big.txt"), Array.from({ length: 1000 }, (_, i) => `line ${i} ${"y".repeat(60)}`).join("\n"));
    const { url } = await mockProvider({
      turns: [
        { calls: [{ name: "read_file", args: { path: "big.txt" } }] },
        { calls: [{ name: "read_file", args: { path: "big.txt", offset: 240 } }] },
        { calls: [{ name: "read_file", args: { path: "big.txt", offset: 480 } }] },
        { text: "read it" },
      ],
    });
    const engine = engineAt(dir, url);
    const events = await drain(engine.run("read the whole file", allowAll));

    assert.ok(
      !events.some((e) => e.kind === "info" && /pruned/.test(e.text)),
      "pruned a part of the file that nothing had superseded",
    );
    const tools = events.filter((e): e is Extract<EngineEvent, { kind: "tool" }> => e.kind === "tool");
    assert.ok(tools.every((t) => t.note !== "repeat"), "paging forward read as repetition");
    // And a step back into what was already shown is caught, which is the
    // other half of the same rule.
    assert.equal(tools.length, 3);
  });

  it("can read a file bigger than one tool result, a part at a time", async () => {
    // Before paging there was no way to see past the first 2KB of a file, so a
    // model that needed more had exactly one move: ask again, and get the same
    // 2KB back. The dead end was the loop.
    const dir = ws();
    writeDefaultBar(dir);
    // 400 lines plus a trailing newline: the terminator must not be counted as
    // a 401st line, or every offset molt hands back is one past what it means.
    // Lines long enough that one 16KB part is ~80 of them, so offset 100 is a
    // part the model has genuinely not been shown. (With short lines the first
    // read returns most of the file, and asking for line 40 afterwards is a
    // re-read — correctly flagged as one.)
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${"y".repeat(190)}`);
    writeFileSync(join(dir, "big.txt"), lines.join("\n") + "\n");
    const { url } = await mockProvider({
      turns: [
        { calls: [{ name: "read_file", args: { path: "big.txt" } }] },
        { calls: [{ name: "read_file", args: { path: "big.txt", offset: 100 } }] },
        { text: "read it" },
      ],
    });
    const engine = engineAt(dir, url);
    const events = await drain(engine.run("read the file", allowAll));
    const tools = events.filter((e): e is Extract<EngineEvent, { kind: "tool" }> => e.kind === "tool");

    // The first part says where it stops and how to continue — and the notice
    // survives the byte cap, which it did not in the first version: it was
    // appended after the budget was spent, so truncation cut off the one
    // sentence that told the model how to get the rest.
    assert.match(tools[0]!.preview ?? "", /lines 1-\d+ of 400/);
    assert.ok(!/capped/.test(tools[0]!.note ?? ""), `part was double-truncated: ${tools[0]!.note}`);
    assert.ok(!/repeat/.test(tools[1]!.note ?? ""), "a later part must not read as a repeat");
    const second = tools[1]!.preview ?? "";
    assert.match(second, /lines 101-/, "offset did not move the window");
    assert.ok(!second.includes("line 0 "), "the second part repeated the first");
  });

  it("proves work that was shed out of context forty turns ago", async () => {
    const dir = ws();
    writeBar(dir,
      "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n  - name: intact\n    builtin: record-intact\n",
    );

    const filler = "z".repeat(1500);
    const { url } = await mockProvider({
      turns: [
        { calls: [{ name: "write_file", args: { path: "early.ts", content: "export const early = 1;\n" } }] },
        ...Array.from({ length: 10 }, (_, i) => ({ calls: [{ name: "bash", args: { command: `echo ${i} ${filler}` } }] })),
        { text: "Everything is in place." },
      ],
    });

    const engine = engineAt(dir, url, { autoShedAtTokens: 2000 });
    const events = await drain(engine.run("build the thing", allowAll));

    assert.ok(engine.shedBatches > 0, "the session must actually have shed");
    assert.ok(kinds(events).includes("shed"));

    // The write is long gone from working context; the record still has it.
    const claims = engine
      .getRecord()
      .flatMap((m) => m.tool_calls ?? [])
      .filter((c) => c.function.name === "write_file");
    assert.ok(claims.length >= 1, "the shed write survives in the record");

    assert.ok(kinds(events).includes("proof_result"), "the bar passes against the full record");
    const archive = new Archive(dir);
    assert.ok(archive.list().length > 0, "exuviae on disk");
  });
});
