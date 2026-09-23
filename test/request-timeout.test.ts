/**
 * A model request that never answers.
 *
 * molt put no clock on a request. A server that accepted the connection and
 * said nothing held the turn open for ever — no error, no retry, no salvage,
 * and `molt run` never exited. `--for` did not help: the wall clock was read
 * only at the top of the step loop, and the loop was parked on the request.
 *
 * These run real `fetch` against a local server, because the failure is in
 * what happens to a socket, and a stand-in fetch would only test itself.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { Engine, NETWORK_RETRIES } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import {
  GENERATE_MS_PER_TOKEN,
  PREFILL_MS_PER_TOKEN,
  REQUEST_IDLE_MS,
  firstByteMs,
  requestIdleMs,
} from "../src/watchdog.js";
import type { EngineEvent } from "../src/types.js";
import { allowAll, drain, workspace } from "./helpers.js";

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});

type Handler = (n: number, req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A local server; `handler` gets the request's ordinal, from 1. */
async function serve(handler: Handler): Promise<{ url: string; requests: () => number }> {
  let n = 0;
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    n += 1;
    const i = n;
    req.resume();
    req.on("end", () => handler(i, req, res));
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests: () => n,
  };
}

const sse = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const DONE =
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` + "data: [DONE]\n\n";

function answer(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  );
}

function engineAt(url: string, extra: Partial<ConstructorParameters<typeof Engine>[0]> = {}) {
  const w = workspace();
  cleanups.push(w.cleanup);
  const journal = new Journal(w.dir, "timeout");
  const engine = new Engine({
    baseUrl: url,
    model: "test-model",
    provider: "mock",
    cwd: w.dir,
    journal,
    retryBackoffMs: [5],
    ...extra,
  });
  return { engine, journal };
}

const texts = (events: EngineEvent[], kind: "info" | "error") =>
  events.filter((e): e is Extract<EngineEvent, { kind: typeof kind }> => e.kind === kind).map((e) => e.text);

const answers = (events: EngineEvent[]) =>
  events
    .filter((e): e is Extract<EngineEvent, { kind: "assistant_text" }> => e.kind === "assistant_text")
    .map((e) => e.text);

describe("a request that never answers", () => {
  it("is abandoned as hung, retried, and the turn ends", async () => {
    // Accepts, reads the request, and never writes a byte.
    const server = await serve(() => {});
    const { engine, journal } = engineAt(server.url, { requestIdleMs: 100, requestFirstByteMs: 100 });
    const t0 = Date.now();
    const events = await drain(engine.run("hi", allowAll));
    const took = Date.now() - t0;

    assert.ok(took < 5_000, `took ${took}ms — the turn did not end on its own`);
    const errors = texts(events, "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /no response from the provider for 100ms — the connection looks hung/);
    assert.match(errors[0]!, new RegExp(`gave up after ${NETWORK_RETRIES + 1} attempts`));
    // Every attempt, then the salvage — which is watched as well, or the
    // closing summary would be the request that hangs instead.
    assert.equal(server.requests(), NETWORK_RETRIES + 2);
    assert.ok(texts(events, "info").some((t) => /could not write a closing summary/.test(t)));
    assert.equal(events.at(-1)!.kind, "job_end");
    assert.match(readFileSync(journal.path, "utf8"), /looks hung/);
  });

  it("is abandoned when a stream goes quiet after it started", async () => {
    const server = await serve((n, _req, res) => {
      if (n === 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sse("I will "));
        return; // and nothing more, ever
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse("recovered") + DONE);
    });
    const { engine } = engineAt(server.url, { requestIdleMs: 150, requestFirstByteMs: 2_000 });
    const events = await drain(engine.run("hi", allowAll));

    assert.ok(texts(events, "info").some((t) => /no response from the provider for 150ms/.test(t)));
    // The abandoned attempt's words are taken back before the retry replays.
    assert.ok(events.some((e) => e.kind === "stream_reset"));
    assert.deepEqual(answers(events), ["recovered"]);
    assert.equal(server.requests(), 2);
  });
});

describe("a long answer that keeps talking", () => {
  it("is never cut off, however long it runs past the idle window", async () => {
    const words = Array.from({ length: 12 }, (_, i) => `w${i} `);
    const server = await serve((_n, _req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const tick = setInterval(() => {
        if (i < words.length) {
          res.write(sse(words[i]!));
          i += 1;
        } else {
          clearInterval(tick);
          res.end(DONE);
        }
      }, 40);
    });
    // 12 chunks, 40 ms apart: about half a second of answer against a 150 ms
    // silence allowance. A budget would kill it; a watchdog on silence must not.
    const { engine } = engineAt(server.url, { requestIdleMs: 150, requestFirstByteMs: 150 });
    const t0 = Date.now();
    const events = await drain(engine.run("hi", allowAll));
    assert.ok(Date.now() - t0 > 300, "the answer ran longer than the idle window");
    assert.deepEqual(answers(events), [words.join("")]);
    assert.equal(server.requests(), 1, "not retried");
    assert.equal(texts(events, "error").length, 0);
  });

  it("waits out a slow first byte scaled to the prompt, not the idle window", () => {
    // Reading a 100k-token prompt at the slowest plausible prefill rate is
    // far longer than five minutes, and must not be mistaken for a hang.
    assert.equal(
      firstByteMs(REQUEST_IDLE_MS, { promptTokens: 100_000, maxTokens: 32_768, stream: true }),
      100_000 * PREFILL_MS_PER_TOKEN,
    );
    // A request that is not streamed says nothing until the whole answer is
    // written, so the output ceiling is part of its silence.
    assert.equal(
      firstByteMs(REQUEST_IDLE_MS, { promptTokens: 1_000, maxTokens: 32_768, stream: false }),
      1_000 * PREFILL_MS_PER_TOKEN + 32_768 * GENERATE_MS_PER_TOKEN,
    );
    assert.equal(firstByteMs(REQUEST_IDLE_MS, { promptTokens: 10, maxTokens: 10, stream: true }), REQUEST_IDLE_MS);
    assert.equal(firstByteMs(0, { promptTokens: 1e6, maxTokens: 1e6, stream: false }), 0, "0 is off");
  });

  it("takes its allowance from the engine, then the environment, then the default", () => {
    assert.equal(requestIdleMs(250, "9"), 250);
    assert.equal(requestIdleMs(0, "9"), 0);
    assert.equal(requestIdleMs(undefined, "9000"), 9000);
    assert.equal(requestIdleMs(undefined, "nonsense"), REQUEST_IDLE_MS);
    assert.equal(requestIdleMs(undefined, undefined), REQUEST_IDLE_MS);
  });
});

describe("the wall clock", () => {
  it("interrupts a request in flight and closes the turn with a salvage", async () => {
    // The step request hangs; the salvage, the next request, answers.
    const server = await serve((n, _req, res) => {
      if (n === 1) return;
      answer(res, "Nothing was done: the model never replied.");
    });
    // The watchdog is off, so only the deadline can end the first request.
    const { engine, journal } = engineAt(server.url, { requestIdleMs: 0, turnDeadlineMs: 300 });
    const t0 = Date.now();
    const events = await drain(engine.run("hi", allowAll));
    const took = Date.now() - t0;

    assert.ok(took < 3_000, `took ${took}ms against a 300ms deadline`);
    assert.ok(texts(events, "info").some((t) => /time budget reached/.test(t)));
    assert.deepEqual(answers(events), ["Nothing was done: the model never replied."]);
    assert.equal(server.requests(), 2, "the hung request is not retried after the deadline");
    const log = readFileSync(journal.path, "utf8");
    assert.match(log, /"kind":"deadline"/);
    assert.match(log, /"kind":"salvage"/);
    assert.equal(texts(events, "error").length, 0, "running out of time is not a provider error");
  });
});
