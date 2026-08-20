/**
 * Prompt caching across providers.
 *
 * Re-sending the conversation every step is what an agent loop is, and it is
 * where the money goes: a measured session spent 939,000 prompt tokens against
 * 7,900 completion tokens. Providers split into two camps — automatic (OpenAI,
 * xAI, Groq: match on the prefix, nothing to send) and explicit (Anthropic:
 * caches only up to a `cache_control` breakpoint you place). molt has to be
 * right on both, and the same session costs about 2.2× more when it is not.
 *
 * The invariant these exist to hold: **a marker may never change what the
 * model reads.** Caching is a billing concern, and buying a discount with a
 * altered conversation would be the one trade this tool exists to refuse.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  LOOKBACK_BLOCKS,
  MAX_BREAKPOINTS,
  breakpoints,
  cacheStyle,
  refusedCaching,
  withCaching,
} from "../src/cache.js";
import { Engine } from "../src/engine.js";
import type { Msg } from "../src/types.js";
import { allowAll, drain, workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws(): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

/** A conversation shaped the way an agent loop actually builds one. */
function conversation(steps: number): Omit<Msg, "molt">[] {
  const out: Omit<Msg, "molt">[] = [{ role: "system", content: "the system prompt" }];
  out.push({ role: "user", content: "do the thing" });
  for (let i = 0; i < steps; i++) {
    out.push({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    });
    out.push({ role: "tool", tool_call_id: `c${i}`, content: `result ${i}` });
  }
  return out;
}

describe("which caching a provider uses", () => {
  it("asks for breakpoints only where they are read", () => {
    // An Anthropic model needs markers however it is reached — the route
    // changes, the model's caching does not.
    assert.equal(cacheStyle("https://api.anthropic.com/v1", "claude-sonnet-5"), "explicit");
    assert.equal(cacheStyle("https://openrouter.ai/api/v1", "anthropic/claude-sonnet-5"), "explicit");
    assert.equal(cacheStyle("https://openrouter.ai/api/v1", "claude-opus-5"), "explicit");
    // These match on the prefix by themselves; there is nothing to send.
    assert.equal(cacheStyle("https://api.x.ai/v1", "grok-4.6"), "automatic");
    assert.equal(cacheStyle("https://api.openai.com/v1", "gpt-5"), "automatic");
    assert.equal(cacheStyle("http://localhost:11434/v1", "llama3"), "automatic");
    assert.equal(cacheStyle("https://api.groq.com/openai/v1", "llama-3.3"), "automatic");
  });
});

describe("where the breakpoints go", () => {
  it("marks the system prompt, which sits behind the tools", () => {
    // Render order is tools → system → messages, so a marker on system caches
    // the tool definitions with it.
    const bp = breakpoints(conversation(1));
    assert.equal(bp[0], 0, "the system prompt carries no breakpoint");
  });

  it("marks the newest message, which is what the next request reads back", () => {
    const msgs = conversation(3);
    const bp = breakpoints(msgs);
    assert.equal(bp.at(-1), msgs.length - 1, "the tip of the conversation is unmarked");
  });

  it("never spends more than the provider allows", () => {
    for (const steps of [1, 5, 20, 60, 200]) {
      const bp = breakpoints(conversation(steps));
      assert.ok(
        bp.length <= MAX_BREAKPOINTS,
        `${steps} steps produced ${bp.length} breakpoints, over the limit of ${MAX_BREAKPOINTS}`,
      );
    }
  });

  it("keeps a marker within the lookback window of the tip", () => {
    // A breakpoint walks back at most 20 blocks to find a prior entry. An
    // agent step appends an assistant turn plus one result per tool call, so a
    // busy step can push the previous marker out of range — and the miss is
    // silent: a full-price request that looks exactly like a cheap one.
    for (const steps of [10, 40, 120]) {
      const msgs = conversation(steps);
      const bp = breakpoints(msgs);
      const tail = bp.filter((i) => i > 0);
      for (let i = 1; i < tail.length; i++) {
        assert.ok(
          tail[i]! - tail[i - 1]! <= LOOKBACK_BLOCKS,
          `${steps} steps: markers ${tail[i - 1]} and ${tail[i]} are further apart than the ${LOOKBACK_BLOCKS}-block lookback`,
        );
      }
    }
  });

  it("does not mark an assistant turn that is carrying tool calls", () => {
    // Nothing to gain and a shape whose handling varies between providers:
    // caching is a prefix match, so a marker one message later covers it.
    const msgs = conversation(6);
    for (const i of breakpoints(msgs)) {
      const m = msgs[i]!;
      assert.ok(
        !(m.role === "assistant" && m.tool_calls?.length),
        `marked an assistant turn with tool calls at index ${i}`,
      );
    }
  });
});

describe("a marker never changes what the model reads", () => {
  /** The text of a message, however its content is carried. */
  const text = (m: Omit<Msg, "molt">): string | null => {
    const c = m.content as unknown;
    if (typeof c === "string" || c === null) return c as string | null;
    if (Array.isArray(c)) return c.map((p: { text?: string }) => p.text ?? "").join("");
    return null;
  };

  it("carries identical text, in identical order, with identical roles", () => {
    const msgs = conversation(8);
    const marked = withCaching(msgs, "explicit");
    assert.equal(marked.length, msgs.length, "the message count changed");
    msgs.forEach((before, i) => {
      const after = marked[i]!;
      assert.equal(after.role, before.role, `role changed at ${i}`);
      assert.equal(text(after), text(before), `text changed at ${i}`);
      assert.deepEqual(after.tool_calls, before.tool_calls, `tool calls changed at ${i}`);
      assert.equal(after.tool_call_id, before.tool_call_id, `tool_call_id changed at ${i}`);
    });
  });

  it("sends nothing at all to a provider that caches by itself", () => {
    const msgs = conversation(8);
    assert.deepEqual(
      withCaching(msgs, "automatic"),
      msgs,
      "sent cache markers to a provider that does not read them",
    );
  });

  it("sends nothing once the provider has refused them", () => {
    const msgs = conversation(8);
    assert.deepEqual(withCaching(msgs, "explicit", false), msgs);
  });
});

describe("an endpoint that refuses the markers", () => {
  it("recognises a refusal without mistaking an ordinary 400 for one", () => {
    assert.equal(refusedCaching('{"error":"cache_control is not supported"}'), true);
    assert.equal(refusedCaching("Extra inputs are not permitted: cache_control"), true);
    // A real 400 must stay a real 400, or molt turns off caching for the wrong
    // reason and never turns it back on.
    assert.equal(refusedCaching('{"error":"no such model"}'), false);
    assert.equal(refusedCaching('{"error":"invalid api key"}'), false);
  });

  it("drops caching for the session and finishes the turn", async () => {
    // A billing optimisation may cost a retry. It may not cost a turn.
    const dir = ws();
    writeFileSync(join(dir, "a.txt"), "alpha\n");
    const bodies: { messages: Omit<Msg, "molt">[] }[] = [];
    let refusals = 0;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Omit<Msg, "molt">[] };
      bodies.push(body);
      const sentMarkers = body.messages.some((m) => Array.isArray(m.content));
      if (sentMarkers) {
        refusals += 1;
        return {
          ok: false,
          status: 400,
          headers: { get: () => "application/json" },
          text: async () => '{"error":"cache_control is not supported on this endpoint"}',
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
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    // An OpenAI-compatible host carrying an Anthropic model — OpenRouter is
    // the real case. Anthropic's own endpoint no longer comes through here at
    // all: molt speaks its native protocol, where the markers are known to
    // work. This fallback is for the hosts in between.
    const engine = new Engine({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet-5",
      cwd: dir,
      bar: null,
      stream: false,
      autonomy: "high",
      fetchFn,
      retryBackoffMs: [5, 5, 5],
    });
    const events = await drain(engine.run("go", allowAll));

    assert.ok(
      events.some((e) => e.kind === "assistant_text" && e.text.includes("done")),
      "a refused optimisation took the turn down with it",
    );
    assert.equal(refusals, 1, `retried the markers ${refusals} times instead of giving up on them`);
    assert.ok(
      !bodies.at(-1)!.messages.some((m) => Array.isArray(m.content)),
      "kept sending markers after they were refused",
    );
  });
});

describe("what actually goes on the wire", () => {
  async function bodiesFor(model: string, baseUrl: string) {
    const dir = ws();
    writeFileSync(join(dir, "a.txt"), "alpha\n");
    const bodies: { messages: Omit<Msg, "molt">[] }[] = [];
    const turns = [
      { call: "a.txt" as string | undefined },
      { call: "a.txt" as string | undefined },
      { call: undefined },
    ];
    let n = 0;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      const t = turns[Math.min(n, turns.length - 1)]!;
      n += 1;
      const message = t.call
        ? {
            role: "assistant",
            content: "working",
            tool_calls: [
              {
                id: `c${n}`,
                type: "function",
                function: { name: "read_file", arguments: JSON.stringify({ path: t.call }) },
              },
            ],
          }
        : { role: "assistant", content: "done" };
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => "",
        json: async () => ({
          choices: [{ message }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const engine = new Engine({
      baseUrl,
      model,
      cwd: dir,
      bar: null,
      stream: false,
      autonomy: "high",
      fetchFn,
    });
    await drain(engine.run("go", allowAll));
    return bodies;
  }

  it("marks an Anthropic conversation and leaves an xAI one alone", async () => {
    const anthropic = await bodiesFor("anthropic/claude-sonnet-5", "https://openrouter.ai/api/v1");
    for (const [i, b] of anthropic.entries()) {
      assert.ok(
        b.messages.some((m) => Array.isArray(m.content)),
        `request ${i + 1} to Anthropic carried no breakpoints`,
      );
    }
    const xai = await bodiesFor("grok-4.6", "https://api.x.ai/v1");
    for (const [i, b] of xai.entries()) {
      assert.ok(
        !b.messages.some((m) => Array.isArray(m.content)),
        `request ${i + 1} to xAI carried breakpoints it cannot read`,
      );
    }
  });

  it("keeps the prefix byte-identical as the conversation grows", async () => {
    // Automatic providers cache on the prefix alone, so this is the whole
    // mechanism for them — and on explicit providers a moved prefix throws
    // away every entry behind it.
    for (const [model, url] of [
      ["grok-4.6", "https://api.x.ai/v1"],
      ["anthropic/claude-sonnet-5", "https://openrouter.ai/api/v1"],
    ] as const) {
      const bodies = await bodiesFor(model, url);
      for (let i = 1; i < bodies.length; i++) {
        const prev = bodies[i - 1]!.messages;
        const cur = bodies[i]!.messages;
        for (let m = 0; m < prev.length - 1; m++) {
          // Every message except the previous tip — which loses its marker as
          // the marker rolls forward — must be byte-identical.
          assert.deepEqual(
            cur[m],
            prev[m],
            `${model}: message ${m} changed between requests ${i} and ${i + 1}`,
          );
        }
      }
    }
  });
});
