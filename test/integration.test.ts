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
    // Each mocked turn reports 290 tokens. 400 stops it on the third check,
    // before the no-progress guard has seen two dry steps — the two limits are
    // independent and both have to work.
    engine.setBudget(400);

    const events = await drain(engine.run("spin", allowAll));
    const err = events.find((e) => e.kind === "error") as { text: string } | undefined;
    assert.ok(err && /budget hit/.test(err.text), `wrong stop: ${err?.text}`);
    assert.ok(received.length <= 3, `budget should cap requests, saw ${received.length}`);
  });

  it("stops a model that keeps asking a question it has already answered", async () => {
    // The reported failure: thirty steps of re-reading the same four files,
    // stopped only by the step guard, at a real cost of about fifty cents.
    const dir = ws();
    writeDefaultBar(dir);
    writeFileSync(join(dir, "notes.md"), "the same content every time\n");
    const { url, received } = await mockProvider({
      turns: [{ calls: [{ name: "read_file", args: { path: "notes.md" } }] }],
    });
    const engine = engineAt(dir, url);

    const events = await drain(engine.run("study the notes", allowAll));
    const err = events.find((e) => e.kind === "error") as { text: string } | undefined;

    assert.ok(err && /repeating calls/.test(err.text), `wrong stop: ${err?.text}`);
    assert.ok(
      received.length <= 4,
      `should stop within a few steps, not ${received.length} (the step guard is 32)`,
    );
    // The waste is named while it is happening, not only at the end.
    assert.ok(events.some((e) => e.kind === "info" && /nothing new came back/.test(e.text)));
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
    const { url, received } = await mockProvider({
      turns: Array.from({ length: 8 }, () => ({
        // Each turn asks for a window inside what it has already been shown.
        calls: [{ name: "read_file", args: { path: "big.txt", offset: (n += 1) } }],
      })),
    });
    const engine = engineAt(dir, url);
    const events = await drain(engine.run("study it", allowAll));

    const err = events.find((e) => e.kind === "error") as { text: string } | undefined;
    assert.ok(err && /repeating calls|already/.test(err.text), `wrong stop: ${err?.text}`);
    assert.ok(received.length <= 5, `should stop early, not after ${received.length} steps`);
    const tools = events.filter((e): e is Extract<EngineEvent, { kind: "tool" }> => e.kind === "tool");
    assert.ok(
      tools.some((t) => t.note === "repeat"),
      "a shifted offset walked straight past the guard",
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
    const { url, received } = await mockProvider({
      turns: Array.from({ length: 10 }, () => ({
        calls: [{ name: "read_file", args: { path: "big.ts", offset: (n += 3) } }],
      })),
    });
    const engine = engineAt(dir, url);
    const events = await drain(engine.run("study it", allowAll));

    assert.ok(received.length <= 5, `ran ${received.length} steps on a drifting re-reader`);
    const tools = events.filter((e): e is Extract<EngineEvent, { kind: "tool" }> => e.kind === "tool");
    assert.ok(tools.some((t) => t.note === "repeat"), "a three-line drift walked past the guard");
    assert.match(
      tools.find((t) => t.note === "repeat")?.preview ?? "",
      /offset=\d+ or later/,
      "told the model it was repeating without telling it where to go instead",
    );
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
