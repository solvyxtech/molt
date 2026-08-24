/**
 * Showing a step as it happens, without showing it twice.
 *
 * The engine used to buffer a whole streamed message and yield it in one piece
 * once the read finished. The comment defending that said earlier paint was
 * worth only a few hundred milliseconds — true against a hosted provider, and
 * badly wrong against a local one, where a step is tens of seconds and the
 * window showed nothing at all for the whole of it. Three runs in one session
 * were cancelled during that silence, the last three seconds before its first
 * tool call would have fired.
 *
 * Two properties have to survive the change, and both are why it was buffered:
 * a secret split across chunk boundaries must still be masked, and text from an
 * attempt that gets retried must not be left on screen.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fragments, SafeStream, REDACT_TAIL } from "../src/live.js";

describe("Fragments", () => {
  it("delivers what the callback pushes, in order", async () => {
    const f = new Fragments();
    const out: string[] = [];
    const reading = (async () => {
      for await (const x of f.drain()) out.push(x);
    })();
    f.push("a");
    f.push("b");
    f.finish();
    await reading;
    assert.deepEqual(out, ["a", "b"]);
  });

  it("waits rather than ending when nothing has arrived yet", async () => {
    // The whole point: the generator must block on an empty queue instead of
    // concluding the stream is over, or it ends before the first token.
    const f = new Fragments();
    const out: string[] = [];
    const reading = (async () => {
      for await (const x of f.drain()) out.push(x);
    })();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(out, [], "nothing yet, and not finished either");
    f.push("late");
    f.finish();
    await reading;
    assert.deepEqual(out, ["late"]);
  });

  it("drains what is queued before ending", async () => {
    const f = new Fragments();
    f.push("one");
    f.push("two");
    f.finish();
    const out: string[] = [];
    for await (const x of f.drain()) out.push(x);
    assert.deepEqual(out, ["one", "two"], "finish must not discard the queue");
  });

  it("ignores empty fragments", async () => {
    const f = new Fragments();
    f.push("");
    f.push("x");
    f.finish();
    const out: string[] = [];
    for await (const x of f.drain()) out.push(x);
    assert.deepEqual(out, ["x"]);
  });
});

describe("SafeStream", () => {
  const KEY = "sk-" + "a".repeat(40);
  const mask = (s: string) => s.split(KEY).join("[redacted]");

  it("masks a secret split across two fragments", () => {
    // The reason streaming was buffered. Redacting each fragment on its own
    // matches neither half of a key that straddles the boundary, and the key
    // reaches the screen in two pieces that a reader can trivially rejoin.
    const s = new SafeStream(mask);
    const filler = "x".repeat(REDACT_TAIL * 2);
    let shown = "";
    shown += s.take(filler + KEY.slice(0, 12));
    shown += s.take(KEY.slice(12) + " done");
    shown += s.flush();
    assert.ok(!shown.includes(KEY), "the key must never appear whole");
    assert.ok(!shown.includes(KEY.slice(12)), "nor the second half of it");
    assert.match(shown, /\[redacted\]/);
    assert.match(shown, /done$/, "and the rest of the text still arrives");
  });

  it("loses nothing: everything in comes out", () => {
    const s = new SafeStream((x) => x);
    const parts = ["alpha ", "beta ", "gamma ", "x".repeat(REDACT_TAIL * 3)];
    let shown = "";
    for (const p of parts) shown += s.take(p);
    shown += s.flush();
    assert.equal(shown, parts.join(""));
  });

  it("holds a short message entirely until flush", () => {
    // Short messages are the common case and arrive whole at the end, which is
    // imperceptible — the alternative is emitting a boundary no redactor can
    // see across.
    const s = new SafeStream((x) => x);
    assert.equal(s.take("hello"), "");
    assert.equal(s.flush(), "hello");
  });

  it("flushes only once", () => {
    const s = new SafeStream((x) => x);
    s.take("abc");
    assert.equal(s.flush(), "abc");
    assert.equal(s.flush(), "", "a second flush must not repeat the tail");
  });
});
