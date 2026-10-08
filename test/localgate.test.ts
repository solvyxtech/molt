/**
 * One request at a time to a self-hosted server (src/localgate.ts).
 *
 * The NUC's one-slot llama.cpp served Maat's turn behind its own drafter; the
 * turn was declared hung after five silent minutes, resent to the back of the
 * queue, and every local task failed with zero steps.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askModel } from "../src/ask.js";
import { takeTurn, waitingFor } from "../src/localgate.js";
import { isSelfHosted } from "../src/providers.js";

const LOCAL = "http://127.0.0.1:8080/v1";
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("takeTurn", { timeout: 10_000 }, () => {
  it("knows the NUC tunnel and a LAN host as self-hosted, and a cloud API as not", () => {
    assert.equal(isSelfHosted(LOCAL), true);
    assert.equal(isSelfHosted("http://192.168.0.218:8080/v1"), true);
    assert.equal(isSelfHosted("https://openrouter.ai/api/v1"), false);
  });

  // The local benchmark reached the Mac's Qwen from a container as
  // host.docker.internal and every self-hosted rule was off: thinking on,
  // no gate, cloud timeouts — zero steps in fourteen minutes.
  it("knows a container's host, Tailscale, and private DNS names and addresses as self-hosted", () => {
    for (const u of [
      "http://host.docker.internal:8090/v1",
      "http://host.containers.internal:8090/v1",
      "http://nuc.tail803225.ts.net:8080/v1",
      "http://100.101.102.103:8080/v1",
      "http://qc.internal/v1",
      "http://gpu.lan:8080/v1",
      "http://box.home.arpa/v1",
      "http://[fd7a:115c:a1e0::1]:8080/v1",
    ]) assert.equal(isSelfHosted(u), true, u);
    for (const u of ["https://api.openai.com/v1", "http://100.200.1.1/v1", "https://internal.example.com/v1"]) assert.equal(isSelfHosted(u), false, u);
  });

  it("takes MAAT_SELF_HOSTED as the final word when set", () => {
    process.env.MAAT_SELF_HOSTED = "1";
    try {
      assert.equal(isSelfHosted("https://models.example.com/v1"), true);
      process.env.MAAT_SELF_HOSTED = "0";
      assert.equal(isSelfHosted("http://127.0.0.1:8080/v1"), false);
    } finally {
      delete process.env.MAAT_SELF_HOSTED;
    }
  });

  it("hands a local endpoint to one caller at a time, in order", async () => {
    const order: string[] = [];
    const r1 = await takeTurn(LOCAL);
    const p2 = takeTurn(LOCAL).then((r) => (order.push("2"), r));
    const p3 = takeTurn(LOCAL).then((r) => (order.push("3"), r));
    await tick();
    assert.deepEqual(order, []);
    assert.equal(waitingFor(LOCAL), 2);
    r1();
    const r2 = await p2;
    await tick();
    assert.deepEqual(order, ["2"]);
    r2();
    r2(); // a second release does not let two through
    (await p3)();
    assert.deepEqual(order, ["2", "3"]);
    assert.equal(waitingFor(LOCAL), 0);
  });

  it("lets a cloud endpoint's requests run side by side", async () => {
    const a = await takeTurn("https://openrouter.ai/api/v1");
    // The second is granted while the first is still held.
    const second = await Promise.race([takeTurn("https://openrouter.ai/api/v1").then((r) => r), new Promise<null>((r) => setTimeout(() => r(null), 50))]);
    assert.notEqual(second, null);
    a();
    second!();
  });

  it("serves as many at once as MAAT_LOCAL_SLOTS says the server has", async () => {
    process.env.MAAT_LOCAL_SLOTS = "2";
    try {
      const url = "http://127.0.0.1:9999/v1";
      const a = await takeTurn(url);
      const b = await Promise.race([takeTurn(url), new Promise<null>((r) => setTimeout(() => r(null), 50))]);
      assert.notEqual(b, null, "two slots: the second goes straight through");
      const c = takeTurn(url);
      await tick();
      assert.equal(waitingFor(url), 1, "the third waits");
      a();
      (await c)();
      b!();
    } finally {
      delete process.env.MAAT_LOCAL_SLOTS;
    }
  });

  it("hands a released slot to the waiter, never to a newcomer arriving at the same moment", async () => {
    const r1 = await takeTurn(LOCAL);
    let waiterIn = false;
    const waiter = takeTurn(LOCAL).then((r) => ((waiterIn = true), r));
    await tick();
    r1();
    const newcomer = takeTurn(LOCAL); // arrives before the waiter has resumed
    const w = await waiter;
    await tick();
    assert.equal(waiterIn, true);
    assert.equal(waitingFor(LOCAL), 1, "the newcomer queues behind the waiter");
    w();
    (await newcomer)();
  });

  it("refuses at once a request that was cancelled before it asked", async () => {
    const r1 = await takeTurn(LOCAL);
    const c = new AbortController();
    c.abort();
    await assert.rejects(takeTurn(LOCAL, c.signal));
    assert.equal(waitingFor(LOCAL), 0);
    r1();
  });

  it("drops a waiter whose request was cancelled", async () => {
    const r1 = await takeTurn(LOCAL);
    const c = new AbortController();
    const p = takeTurn(LOCAL, c.signal);
    await tick();
    c.abort();
    await assert.rejects(p);
    assert.equal(waitingFor(LOCAL), 0);
    r1();
    (await takeTurn(LOCAL))();
  });
});

describe("questions to a self-hosted server", { timeout: 10_000 }, () => {
  it("never overlap, and each one's timeout starts at its turn", async () => {
    let active = 0;
    let most = 0;
    const fetchFn = (async () => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 40));
      active -= 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    // A 60 ms limit: three 40 ms answers in a row would blow it if the clock ran while queued.
    const ask = () => askModel({ baseUrl: LOCAL, model: "m", system: "s", prompt: "p", fetchFn, timeoutMs: 60 });
    const rs = await Promise.all([ask(), ask(), ask()]);
    assert.equal(most, 1);
    assert.ok(rs.every((r) => r.ok), JSON.stringify(rs));
  });
});
