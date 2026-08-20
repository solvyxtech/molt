/**
 * What a turn is allowed to lose when it ends badly.
 *
 * Two sessions on one machine died mid-turn and reported nothing: one to
 * `TypeError: fetch failed` on the step after a laptop woke up, one to the
 * spending ceiling. The ceiling salvaged and the network error did not, and
 * the difference was worth about fifty thousand tokens of reading each time.
 * The network path has since learned to retry and salvage; a refused request
 * had not, and a 429 arriving at step nine threw the turn away just as
 * completely as a dropped socket did.
 *
 * The rule these pin: molt may fail a turn, but it may not fail one silently
 * with work in hand.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Engine, systemPromptFor, NETWORK_RETRIES, SYSTEM_PROMPT } from "../src/engine.js";
import type { Msg } from "../src/types.js";
import { allowAll, drain, workspace } from "./helpers.js";

type Body = { messages: Msg[]; tool_choice?: string };

/**
 * A provider that refuses the first `refusals` requests and answers after.
 *
 * `refusals` matters because a transient status is now retried before the turn
 * gives up: refusing once proves the retry works, and refusing more times than
 * there are attempts proves the salvage does. The request that answers a
 * persistent refusal is the salvage — it is the one carrying
 * `tool_choice: "none"`, which is how the turn asks for a last word rather
 * than another tool call.
 */
function refusingProvider(status: number, answer: string, refusals = 1) {
  const bodies: Body[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    bodies.push(body);
    if (bodies.length <= refusals) {
      return {
        ok: false,
        status,
        text: async () => `{"error":"rate limited"}`,
        json: async () => ({}),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => "",
      json: async () => ({
        choices: [{ message: { role: "assistant", content: answer } }],
        usage: { prompt_tokens: 500, completion_tokens: 40 },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, bodies };
}

function engineWith(dir: string, over: Record<string, unknown> = {}): Engine {
  return new Engine({
    baseUrl: "http://provider.test/v1",
    model: "m",
    provider: "test",
    cwd: dir,
    bar: null,
    // The policy is what is under test, not the waiting.
    retryBackoffMs: [5, 5, 5],
    ...over,
  });
}

describe("a turn that ends badly still says what it found", () => {
  it("salvages a closing answer when the provider refuses the request", async () => {
    const ws = workspace();
    try {
      const p = refusingProvider(
        429,
        "I read three files and found one bug; I did not verify it.",
        NETWORK_RETRIES + 1,
      );
      const engine = engineWith(ws.dir, { fetchFn: p.fetchFn, stream: false });
      const events = await drain(engine.run("look for bugs", allowAll));

      // The error is still reported — salvage does not paper over the refusal.
      const err = events.find((e) => e.kind === "error");
      assert.ok(err, "the HTTP failure must still be reported as an error");
      assert.match(err.kind === "error" ? err.text : "", /429/);

      // And the turn closes with what it had rather than with nothing.
      assert.equal(
        p.bodies.length,
        NETWORK_RETRIES + 2,
        "every attempt, and then exactly one salvage request",
      );
      assert.equal(p.bodies.at(-1)!.tool_choice, "none", "the salvage may not call more tools");
      const said = events.some(
        (e) => e.kind === "assistant_text" && e.text.includes("I read three files"),
      );
      assert.ok(said, "the salvaged answer must reach the user");
    } finally {
      ws.cleanup();
    }
  });

  it("rides out a rate limit instead of ending the turn on it", async () => {
    // The cheapest possible outcome, and the one worth having: a 429 is the
    // provider saying "not this second", and a turn nine steps deep should
    // wait rather than throw away what it has read. Salvage is the consolation
    // prize; recovering is the point.
    const ws = workspace();
    try {
      const p = refusingProvider(429, "the work is done");
      const engine = engineWith(ws.dir, { fetchFn: p.fetchFn, stream: false });
      const events = await drain(engine.run("look for bugs", allowAll));

      assert.ok(
        !events.some((e) => e.kind === "error"),
        "a single rate limit ended the turn instead of being waited out",
      );
      assert.ok(
        events.some((e) => e.kind === "assistant_text" && e.text.includes("the work is done")),
        "the turn did not carry on to its real answer",
      );
      // The wait is said out loud — you are paying for it in wall clock.
      assert.ok(events.some((e) => e.kind === "info" && /retrying/.test(e.text)));
      // And it is the real request that continues, not a salvage.
      assert.notEqual(p.bodies.at(-1)!.tool_choice, "none", "recovered into a salvage, not a step");
    } finally {
      ws.cleanup();
    }
  });

  it("waits as long as the provider asked, when it says", async () => {
    // `Retry-After` is the provider naming its own price. Guessing shorter
    // buys a second refusal; guessing longer spends the wait for nothing.
    const ws = workspace();
    try {
      let calls = 0;
      const waits: number[] = [];
      let last = Date.now();
      const fetchFn = (async () => {
        calls += 1;
        waits.push(Date.now() - last);
        last = Date.now();
        if (calls === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? "1" : null) },
            text: async () => "slow down",
            json: async () => ({}),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => "",
          json: async () => ({
            choices: [{ message: { role: "assistant", content: "done" } }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
        } as unknown as Response;
      }) as unknown as typeof fetch;
      const engine = engineWith(ws.dir, { fetchFn, stream: false });
      await drain(engine.run("hello", allowAll));

      assert.equal(calls, 2, "did not retry after being told when to come back");
      // A second, as asked — not the 500ms the fixed backoff would have used.
      assert.ok(waits[1]! >= 900, `waited only ${waits[1]}ms after Retry-After: 1`);
    } finally {
      ws.cleanup();
    }
  });

  it("labels the salvaged answer as unverified rather than as a completion", async () => {
    const ws = workspace();
    try {
      const p = refusingProvider(502, "here is what I have.", NETWORK_RETRIES + 1);
      const engine = engineWith(ws.dir, { fetchFn: p.fetchFn, stream: false });
      const events = await drain(engine.run("look for bugs", allowAll));

      const warned = events.some(
        (e) => e.kind === "info" && /NOT checked against the bar/i.test(e.text),
      );
      assert.ok(warned, "a salvaged answer must be marked as unchecked");
    } finally {
      ws.cleanup();
    }
  });

  it("does not salvage twice when the salvage itself is refused", async () => {
    const ws = workspace();
    try {
      let calls = 0;
      const fetchFn = (async () => {
        calls += 1;
        return {
          ok: false,
          status: 503,
          text: async () => "down",
          json: async () => ({}),
        } as unknown as Response;
      }) as unknown as typeof fetch;
      const engine = engineWith(ws.dir, { fetchFn, stream: false });
      const events = await drain(engine.run("look for bugs", allowAll));

      assert.equal(
        calls,
        NETWORK_RETRIES + 2,
        "every attempt, one failed salvage, and then it stops",
      );
      const told = events.some((e) => e.kind === "info" && /could not write a closing summary/.test(e.text));
      assert.ok(told, "a safety net that fails must say that it failed");
    } finally {
      ws.cleanup();
    }
  });
});

describe("the working directory is a fact, not a guess", () => {
  it("names the cwd in the system prompt", () => {
    const prompt = systemPromptFor("/Users/control/Documents/molt");
    assert.match(prompt, /The working directory is \/Users\/control\/Documents\/molt/);
    assert.ok(prompt.startsWith(SYSTEM_PROMPT), "the stable prefix must stay first, for the cache");
  });

  it("sends that directory to the provider", async () => {
    const ws = workspace();
    try {
      const p = refusingProvider(429, "done");
      const engine = engineWith(ws.dir, { fetchFn: p.fetchFn, stream: false });
      await drain(engine.run("hello", allowAll));

      const system = p.bodies[0]!.messages[0]!;
      assert.equal(system.role, "system");
      assert.ok(
        String(system.content).includes(ws.dir),
        "the model must be told which directory it is in",
      );
    } finally {
      ws.cleanup();
    }
  });
});

describe("a refusal molt cannot argue with", () => {
  it("does not pay for a salvage after a 400, which would fail identically", async () => {
    const ws = workspace();
    try {
      let calls = 0;
      const fetchFn = (async () => {
        calls += 1;
        return {
          ok: false,
          status: 400,
          headers: { get: () => "application/json" },
          text: async () => '{"error":"no such model"}',
          json: async () => ({}),
        } as unknown as Response;
      }) as unknown as typeof fetch;
      const engine = engineWith(ws.dir, { fetchFn, stream: false });
      const events = await drain(engine.run("hello", allowAll));

      assert.equal(calls, 1, "a malformed request is not worth asking twice");
      assert.ok(events.some((e) => e.kind === "error" && /400/.test(e.text)));
    } finally {
      ws.cleanup();
    }
  });
});

describe("a ceiling raised mid-turn", () => {
  /** A provider that keeps calling tools, so the turn runs long enough to hit a limit. */
  function grinder(costPerStep: number) {
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => "",
        json: async () => ({
          choices: [
            {
              message:
                n > 12
                  ? { role: "assistant", content: "finished" }
                  : {
                      role: "assistant",
                      content: "working",
                      tool_calls: [
                        {
                          id: `c${n}`,
                          type: "function",
                          function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) },
                        },
                      ],
                    },
            },
          ],
          usage: { prompt_tokens: costPerStep, completion_tokens: 10 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchFn, steps: () => n };
  }

  it("carries the turn past the limit that would have stopped it", async () => {
    // The point of raising it. The engine reads the ceiling at the top of each
    // step, so the change lands on the next one — but only if something can
    // deliver it while the turn is running.
    const ws = workspace();
    try {
      const g = grinder(20_000);
      const engine = engineWith(ws.dir, {
        fetchFn: g.fetchFn,
        stream: false,
        autonomy: "high",
        maxTurnTokens: 60_000,
        priceInPerMtok: undefined,
        priceOutPerMtok: undefined,
      });
      const events: string[] = [];
      for await (const ev of engine.run("grind", allowAll)) {
        events.push(ev.kind);
        // Raise it the moment molt says the ceiling is close, the way a person
        // reading the warning would.
        if (ev.kind === "info" && /% of the ceiling/.test(ev.text)) {
          engine.setBudget(500_000);
        }
      }
      assert.ok(
        !events.includes("error"),
        "the turn stopped at a ceiling that had already been raised",
      );
      assert.ok(g.steps() > 4, `only ran ${g.steps()} steps, so nothing was actually rescued`);
    } finally {
      ws.cleanup();
    }
  });
});
