/**
 * What compaction costs the cache.
 *
 * Elision replaces a tool result in place, in the middle of the conversation.
 * Providers cache on exact prefix match, so everything after the edit is a
 * miss on the next request. `docs/shed.md` said the opposite — "costs
 * nothing, and is strictly less disruptive than shedding, because it does not
 * rewrite the context prefix" — and a real session measured the truth: the
 * step after each elision reused 0% of a 20,000-token prompt while its
 * neighbours reused 51% and 80%.
 *
 * The warning that reports a lost cache had the mirror-image fault: it fired
 * on one 4% step and told the reader every step from then on would re-bill
 * the whole context, which the next step disproved.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { ELIDED_PREFIX, ELISION_PAYBACK_STEPS, Transcript } from "../src/transcript.js";
import { CACHE_LOST_STREAK, Engine } from "../src/engine.js";
import { drain, workspace } from "./helpers.js";
import type { Msg } from "../src/types.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

/** A transcript holding one superseded read, then `tail` tokens after it. */
function withSupersededRead(readBytes: number, tailBytes: number): Transcript {
  const t = new Transcript("system");
  const read = (id: string) => ({
    role: "assistant" as const,
    content: null,
    tool_calls: [
      { id, type: "function" as const, function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
    ],
  });
  t.push(read("c1"));
  t.push({ role: "tool", tool_call_id: "c1", content: "x".repeat(readBytes) });
  // The same window read again: the first copy is superseded.
  t.push(read("c2"));
  t.push({ role: "tool", tool_call_id: "c2", content: "y".repeat(readBytes) });
  if (tailBytes > 0) t.push({ role: "user", content: "z".repeat(tailBytes) });
  return t;
}

const elidedCount = (t: Transcript): number =>
  t.record().filter((m: Msg) => (m.content ?? "").startsWith(ELIDED_PREFIX)).length;

describe("elision pays for the prefix it strands", () => {
  it("prunes freely when nothing has ever come back cached", () => {
    // A self-hosted endpoint, or a provider that does not cache: there is no
    // prefix to protect, so the saving is pure.
    const t = withSupersededRead(4_000, 200_000);
    const r = t.elideSupersededReads();
    assert.equal(r.elided, 1);
    assert.equal(r.deferred, 0);
    assert.ok(r.tokensSaved > 0);
    assert.equal(elidedCount(t), 1);
  });

  it("defers a prune that strands more than it saves", () => {
    // 4KB saved (~1k tokens) against a 200KB tail (~50k tokens): eliding here
    // buys a thousand tokens a step and pays fifty thousand once.
    const t = withSupersededRead(4_000, 200_000);
    const r = t.elideSupersededReads({ protectCache: true });
    assert.equal(r.elided, 0, "elided a result that would cost more than it saved");
    assert.equal(r.deferred, 1);
    assert.equal(r.tokensSaved, 0);
    assert.equal(elidedCount(t), 0, "the message was rewritten anyway");
  });

  it("still prunes when the saving earns the strand back quickly", () => {
    // A large superseded read with little after it: gone within the payback.
    const t = withSupersededRead(60_000, 1_000);
    const r = t.elideSupersededReads({ protectCache: true });
    assert.equal(r.elided, 1, "refused a prune that pays for itself immediately");
    assert.equal(r.deferred, 0);
    assert.equal(elidedCount(t), 1);
  });

  it("states its payback window rather than hiding a constant", () => {
    assert.equal(ELISION_PAYBACK_STEPS, 3);
    const doc = readFileSync("docs/shed.md", "utf8");
    assert.match(doc, /ELISION_PAYBACK_STEPS/, "the doc does not name the rule it describes");
    assert.doesNotMatch(
      doc,
      /does not rewrite the context prefix/,
      "shed.md still claims elision leaves the prefix alone; it rewrites it in place",
    );
    assert.match(doc, /in place/, "shed.md should say plainly what elision does to a message");
  });
});

describe("a lost cache is a streak, not a step", () => {
  /** A provider whose cached-token count follows a script. */
  function cachingProvider(hits: number[]): typeof fetch {
    let n = 0;
    return (async () => {
      const cached = hits[Math.min(n, hits.length - 1)] ?? 0;
      n += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "still working" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20_000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: cached } },
        }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  const infoText = (events: { kind: string; text?: string }[]): string =>
    events.filter((e) => e.kind === "info").map((e) => e.text ?? "").join("\n");

  async function run(hits: number[]): Promise<string> {
    const engine = new Engine({
      baseUrl: "http://provider.test/v1",
      model: "m",
      cwd: ws(),
      bar: null,
      stream: false,
      fetchFn: cachingProvider(hits),
    });
    let out = "";
    for (const _ of hits) {
      out += infoText((await drain(engine.run("go", async () => true))) as { kind: string; text?: string }[]) + "\n";
    }
    return out;
  }

  it("says nothing about one low step after a good one", async () => {
    // 80% then 4%: exactly the shape a load-balanced prefix cache produces,
    // and exactly what the old warning called the end of caching.
    const text = await run([16_000, 800]);
    assert.doesNotMatch(text, /caching/, `warned on a single dip: ${text.slice(0, 200)}`);
  });

  it("says so once the cache has stayed gone", async () => {
    const text = await run([16_000, ...Array(CACHE_LOST_STREAK).fill(800)]);
    assert.match(text, /prompt caching has not recovered/);
    assert.match(text, new RegExp(`${CACHE_LOST_STREAK} steps in a row`));
    assert.doesNotMatch(
      text,
      /Every step from here/,
      "still promises the future it cannot see",
    );
  });

  it("forgets the streak when the cache comes back", async () => {
    // low, low, then a real hit, then low: never three in a row.
    const text = await run([16_000, 800, 800, 16_000, 800, 800]);
    assert.doesNotMatch(text, /caching has not recovered/, `warned across a recovery: ${text.slice(0, 200)}`);
  });
});
