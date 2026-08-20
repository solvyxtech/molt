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
import {
  Engine,
  systemPromptFor,
  contextOverflow,
  NETWORK_RETRIES,
  SYSTEM_PROMPT,
} from "../src/engine.js";
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

describe("the ceiling asks before it gives up", () => {
  /** Keeps calling tools, so the turn runs long enough to reach a limit. */
  function grinder(steps: number, perStep: number) {
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
                n > steps
                  ? { role: "assistant", content: "finished the work" }
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
          usage: { prompt_tokens: perStep, completion_tokens: 10 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchFn, steps: () => n };
  }

  const engineFor = (dir: string, g: { fetchFn: typeof fetch }) =>
    engineWith(dir, {
      fetchFn: g.fetchFn,
      stream: false,
      autonomy: "high",
      maxTurnTokens: 60_000,
    });

  it("carries on and finishes when told to", async () => {
    // The reported waste: $1.02 spent, twenty steps of real work, and no answer
    // for any of it. The money is gone either way — ending there is what turns
    // it into nothing.
    const ws = workspace();
    try {
      const g = grinder(10, 20_000);
      const engine = engineFor(ws.dir, g);
      const events = [];
      for await (const ev of engine.run("grind", allowAll, { onCeiling: async () => true })) {
        events.push(ev);
      }
      assert.ok(
        events.some((e) => e.kind === "assistant_text" && e.text.includes("finished the work")),
        "said yes to carrying on and still got no answer",
      );
      assert.ok(
        events.some((e) => e.kind === "info" && /carrying on past/.test(e.text)),
        "carried on without saying that it had",
      );
    } finally {
      ws.cleanup();
    }
  });

  it("stops and reports when told to stop", async () => {
    const ws = workspace();
    try {
      const g = grinder(50, 20_000);
      const engine = engineFor(ws.dir, g);
      const events = [];
      for await (const ev of engine.run("grind", allowAll, { onCeiling: async () => false })) {
        events.push(ev);
      }
      const err = events.find((e) => e.kind === "error") as { text: string } | undefined;
      assert.match(err?.text ?? "", /ceiling for a single turn/);
      // And still hands back what the turn paid for.
      assert.ok(events.some((e) => e.kind === "info" || e.kind === "assistant_text"));
    } finally {
      ws.cleanup();
    }
  });

  it("stops when nobody is there to ask", async () => {
    // A headless run has no one watching, and a ceiling that can be waved
    // through unattended is not a ceiling. `--yes` means "do not ask me about
    // tool calls", not "spend without limit".
    const ws = workspace();
    try {
      const g = grinder(50, 20_000);
      const engine = engineFor(ws.dir, g);
      const events = await drain(engine.run("grind", allowAll));
      const err = events.find((e) => e.kind === "error") as { text: string } | undefined;
      assert.match(err?.text ?? "", /ceiling for a single turn/, "ran past the ceiling with nobody watching");
    } finally {
      ws.cleanup();
    }
  });

  it("asks again at the new ceiling rather than removing it", async () => {
    // Carrying on is a decision taken once per ceiling, not a limit quietly
    // switched off.
    const ws = workspace();
    try {
      const g = grinder(80, 20_000);
      const engine = engineFor(ws.dir, g);
      let asked = 0;
      await drain(
        engine.run("grind", allowAll, {
          onCeiling: async () => {
            asked += 1;
            return asked < 3;
          },
        }),
      );
      assert.equal(asked, 3, `asked ${asked} time(s); the ceiling should return at each new limit`);
    } finally {
      ws.cleanup();
    }
  });
});

describe("the step guard asks too", () => {
  /** Never finishes on its own, so the guard is the only way out. */
  function endless() {
    let n = 0;
    return (async () => {
      n += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => "",
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "working",
                tool_calls: [
                  {
                    id: `c${n}`,
                    type: "function",
                    function: { name: "bash", arguments: JSON.stringify({ command: `echo ${n}` }) },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  const engineFor = (dir: string) =>
    engineWith(dir, { fetchFn: endless(), stream: false, autonomy: "high" });

  it("offers to carry on rather than stopping dead", async () => {
    // A reported run reached the guard with 1,344,777 tokens and $0.89 spent
    // and got nothing for any of it — the same waste the spending ceiling used
    // to produce, reached by the other door.
    const ws = workspace();
    try {
      const engine = engineFor(ws.dir);
      let asked = 0;
      const events = [];
      for await (const ev of engine.run("grind", allowAll, {
        onCeiling: async () => {
          asked += 1;
          return asked < 2;
        },
      })) {
        events.push(ev);
      }
      assert.equal(asked, 2, `asked ${asked} time(s); the guard should return at each new cap`);
      assert.ok(
        events.some((e) => e.kind === "info" && /carrying on past/.test(e.text)),
        "carried on without saying so",
      );
    } finally {
      ws.cleanup();
    }
  });

  it("stops at the guard when nobody is there to ask", async () => {
    const ws = workspace();
    try {
      const engine = engineFor(ws.dir);
      const events = await drain(engine.run("grind", allowAll));
      const err = events.find((e) => e.kind === "error") as { text: string } | undefined;
      assert.match(err?.text ?? "", /loop guard/, "ran past the guard with nobody watching");
    } finally {
      ws.cleanup();
    }
  });
});

describe("no ceiling on hardware you own", () => {
  /** Never stops on its own, so only a ceiling or the guard can end it. */
  function endless() {
    let n = 0;
    return (async () => {
      n += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => "",
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "working",
                tool_calls: [
                  {
                    id: `c${n}`,
                    type: "function",
                    function: { name: "bash", arguments: JSON.stringify({ command: `echo ${n}` }) },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 40_000, completion_tokens: 10 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("does not stop a local model at a spending ceiling", async () => {
    // A ceiling exists to stop a bill, and a box you own does not send one.
    // Stopping there spends nothing and throws away the work, which is the
    // most expensive way to spend nothing.
    const ws = workspace();
    try {
      const engine = engineWith(ws.dir, {
        baseUrl: "http://192.168.0.218:8080/v1",
        fetchFn: endless(),
        stream: false,
        autonomy: "high",
      });
      const events = await drain(engine.run("grind", allowAll));
      const err = events.find((e) => e.kind === "error") as { text: string } | undefined;
      assert.ok(
        !/ceiling for a single turn/.test(err?.text ?? ""),
        "stopped a local model at a spending ceiling",
      );
      // The step guard still ends it — that one is about loops, not money.
      assert.match(err?.text ?? "", /loop guard/, "nothing stopped it at all");
    } finally {
      ws.cleanup();
    }
  });

  it("still stops a remote one", async () => {
    const ws = workspace();
    try {
      const engine = engineWith(ws.dir, {
        baseUrl: "https://api.x.ai/v1",
        fetchFn: endless(),
        stream: false,
        autonomy: "high",
      });
      const events = await drain(engine.run("grind", allowAll));
      const err = events.find((e) => e.kind === "error") as { text: string } | undefined;
      assert.match(err?.text ?? "", /ceiling for a single turn/, "a billable endpoint ran uncapped");
    } finally {
      ws.cleanup();
    }
  });

  it("honours a ceiling you set yourself, local or not", async () => {
    // The default is removed, not the control.
    const ws = workspace();
    try {
      const engine = engineWith(ws.dir, {
        baseUrl: "http://localhost:11434/v1",
        fetchFn: endless(),
        stream: false,
        autonomy: "high",
      });
      engine.setBudget(120_000);
      const events = await drain(engine.run("grind", allowAll));
      const err = events.find((e) => e.kind === "error") as { text: string } | undefined;
      assert.ok(
        /budget hit|ceiling for a single turn/.test(err?.text ?? ""),
        `a budget set by hand was ignored on a local endpoint: ${err?.text}`,
      );
    } finally {
      ws.cleanup();
    }
  });
});

/**
 * The refusal that says how to fix itself.
 *
 * A local llama.cpp serving qwen3-coder answered step 5 of a real session with
 *
 *     request (17222 tokens) exceeds the available context size (16384
 *     tokens) ... "n_ctx": 16384
 *
 * and molt threw the turn away — five steps, four minutes, nothing verified —
 * having shed nothing at all, because its own shed threshold is 60,000 tokens
 * and it had no idea the endpoint served a quarter of that. Nobody had told it,
 * and nothing in the OpenAI-compatible protocol offers to.
 *
 * This is the most recoverable failure molt can hit: the request was rejected
 * rather than billed, the fix is to carry less, and the server has just said
 * how much less. Ending the turn on it is a choice, and it was the wrong one.
 */
describe("an endpoint too small for the conversation", () => {
  it("reads the window out of the refusal", () => {
    // llama.cpp, verbatim from the session that prompted this.
    assert.equal(
      contextOverflow(
        `{"error":{"code":400,"message":"request (17222 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":17222,"n_ctx":16384}}`,
      ),
      16384,
    );
    // OpenAI's wording for the same thing.
    assert.equal(
      contextOverflow(
        `{"error":{"message":"This model's maximum context length is 8192 tokens, however you requested 9000."}}`,
      ),
      8192,
    );
    // Refused for context reasons without naming a number: still an overflow.
    assert.equal(contextOverflow(`{"error":"too many tokens in context"}`), -1);
    // A 400 that is not about size at all must stay a plain 400 — shedding
    // would destroy a working conversation to fix something else.
    assert.equal(contextOverflow(`{"error":"invalid api key"}`), 0);
    assert.equal(contextOverflow(`{"error":"unsupported tool_choice value"}`), 0);
  });

  it("sheds and carries on instead of losing the turn", async () => {
    const ws = workspace();
    try {
      const bodies: Body[] = [];
      const fetchFn = (async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
        if (bodies.length === 1) {
          return {
            ok: false,
            status: 400,
            text: async () =>
              `{"error":{"message":"request (17222 tokens) exceeds the available context size (16384 tokens)","type":"exceed_context_size_error","n_ctx":16384}}`,
            json: async () => ({}),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => "",
          json: async () => ({
            choices: [{ message: { role: "assistant", content: "carried on and answered." } }],
            usage: { prompt_tokens: 500, completion_tokens: 40 },
          }),
        } as unknown as Response;
      }) as unknown as typeof fetch;

      const engine = engineWith(ws.dir, { fetchFn, stream: false });
      const events = await drain(engine.run("do the work", allowAll));

      assert.equal(bodies.length, 2, "the refusal must be retried, not reported and dropped");
      // Two requests is also what a salvage looks like, and a salvaged answer
      // would satisfy every other assertion here while the turn was in fact
      // over. `tool_choice` is what tells them apart: the salvage sets it to
      // "none" to ask for a last word, and a real retry leaves the model free
      // to keep working.
      assert.notEqual(
        bodies[1]!.tool_choice,
        "none",
        "the second request must be the work resuming, not a eulogy for it",
      );
      const said = events.some(
        (e) => e.kind === "assistant_text" && e.text.includes("carried on"),
      );
      assert.ok(said, "the turn must reach an answer rather than dying on a fixable refusal");

      // The window is learned, not just survived: two thirds of 16384, leaving
      // room for the reply and the next few tool results.
      assert.equal(
        (engine as unknown as { cfg: { autoShedAtTokens?: number } }).cfg.autoShedAtTokens,
        Math.floor(16384 * 0.66),
        "the endpoint's real window must be adopted for the rest of the session",
      );

      // And it is said out loud, with the flag that skips the round trip next
      // time — a silent adaptation is one the user cannot make permanent.
      const told = events.find(
        (e) => e.kind === "info" && e.text.includes("16384") && e.text.includes("--auto-shed"),
      );
      assert.ok(told, "the user must be told the window and how to set it up front");
    } finally {
      ws.cleanup();
    }
  });
});
