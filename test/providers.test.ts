/**
 * The picker moves your session between providers. A selection that resolves
 * to the wrong row does not just pick the wrong model — it silently bills a
 * different account and files the receipt under the wrong endpoint. So the
 * resolution rules, and the mode that hides a pasted key, are pinned here.
 */
import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fmtDuration, statusSegments } from "../src/banner.js";
import {
  PICKER_ROWS,
  PROVIDERS,
  authHeaders,
  XAI_PRICE_UNIT,
  fetchPricing,
  firstSelectable,
  needsPriceLookup,
  openrouterPricing,
  savePricing,
  xaiPricing,
  keyedProviders,
  modelSources,
  moveSelection,
  pickerRows,
  providerName,
  readAuth,
  saveEndpoint,
  saveKey,
  storedEndpoint,
  resolveProvider,
  windowRows,
  type ModelChoice,
  isSelfHosted,
} from "../src/providers.js";
import { workspace } from "./helpers.js";

const choice = (provider: string, id: string): ModelChoice => ({
  provider,
  id,
  url: PROVIDERS[provider]!.url,
});

describe("resolveProvider", () => {
  it("accepts a provider name", () => {
    assert.equal(resolveProvider("anthropic"), "anthropic");
    assert.equal(resolveProvider("xai"), "xai");
  });

  it("rejects a provider that takes no key", () => {
    // ollama is reachable without credentials, so it is not on the login list.
    assert.equal(resolveProvider("ollama"), null);
  });

  it("rejects an ordinal — the picker shows no numbers to type", () => {
    assert.equal(resolveProvider("1"), null);
    assert.equal(resolveProvider(""), null);
    assert.equal(resolveProvider("anthropi"), null);
  });

  it("offers exactly the providers that need a key, and nothing else", () => {
    // The login list and what /login <name> accepts must be the same set, or
    // the picker shows a row that typing its name cannot reach.
    const listed = keyedProviders();
    assert.deepEqual(
      listed.filter((n) => resolveProvider(n) === n),
      listed,
    );
    assert.ok(!listed.includes("ollama"));
  });
});

describe("pickerRows", () => {
  it("puts a header above each provider's models, in first-seen order", () => {
    const rows = pickerRows([
      choice("xai", "grok-4.6"),
      choice("anthropic", "claude-opus-5"),
      choice("xai", "grok-4"),
    ]);
    assert.deepEqual(
      rows.map((r) => (r.kind === "header" ? `#${r.provider}` : r.choice.id)),
      ["#xai", "grok-4.6", "grok-4", "#anthropic", "claude-opus-5"],
    );
  });

  it("starts the highlight on a model, never on a header", () => {
    const rows = pickerRows([choice("xai", "grok-4.6")]);
    assert.equal(rows[firstSelectable(rows)]!.kind, "model");
  });

  it("reports nothing selectable for an empty list", () => {
    assert.equal(firstSelectable([]), -1);
  });
});

describe("moveSelection", () => {
  const rows = pickerRows([
    choice("xai", "grok-4.6"),
    choice("anthropic", "claude-opus-5"),
    choice("anthropic", "claude-sonnet-5"),
  ]);

  it("steps over a header rather than landing on it", () => {
    // rows: #xai, grok-4.6, #anthropic, claude-opus-5, claude-sonnet-5
    const afterFirst = moveSelection(rows, 1, 1);
    assert.equal(afterFirst, 3, "should skip the anthropic header");
    assert.equal(rows[afterFirst]!.kind, "model");
  });

  it("wraps both ways, always onto a model", () => {
    const last = moveSelection(rows, 4, 1);
    assert.equal(rows[last]!.kind, "model");
    assert.equal(last, 1, "wraps past the leading header to the first model");
    const back = moveSelection(rows, 1, -1);
    assert.equal(rows[back]!.kind, "model");
    assert.equal(back, 4);
  });

  it("cannot spin forever when no row is selectable", () => {
    const headersOnly = [{ kind: "header" as const, provider: "xai" }];
    assert.equal(moveSelection(headersOnly, 0, 1), 0);
  });
});

describe("windowRows", () => {
  const many = pickerRows(
    Array.from({ length: 40 }, (_, i) => choice("xai", `grok-${i}`)),
  );

  it("keeps the highlighted row on screen when the list is long", () => {
    for (const index of [0, 1, 20, many.length - 1]) {
      const win = windowRows(many, index);
      assert.ok(
        win.some((r) => r.i === index),
        `selection ${index} scrolled off screen`,
      );
      assert.ok(win.length <= PICKER_ROWS);
    }
  });

  it("carries each row's true index so a scrolled list highlights correctly", () => {
    const win = windowRows(many, 30);
    for (const { row, i } of win) assert.equal(many[i], row);
  });

  it("shows a short list whole", () => {
    const few = pickerRows([choice("xai", "grok-4.6")]);
    assert.equal(windowRows(few, 1).length, few.length);
  });
});

describe("modelSources", () => {
  it("offers a keyless provider without a login", () => {
    assert.ok(modelSources({}).some((s) => s.name === "ollama"));
  });

  it("offers a keyed provider only once its key exists, and carries the key", () => {
    assert.ok(!modelSources({}).some((s) => s.name === "xai"));
    const withKey = modelSources({ xai: "sk-test" }).find((s) => s.name === "xai");
    assert.equal(withKey?.key, "sk-test");
  });
});

describe("credential storage", () => {
  it("writes auth.json 0600 — a key must not be group- or world-readable", () => {
    const ws = workspace();
    try {
      assert.equal(saveKey("xai", "sk-secret", ws.dir), true);
      const mode = statSync(join(ws.dir, "auth.json")).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
      assert.equal(readAuth(ws.dir).xai, "sk-secret");
    } finally {
      ws.cleanup();
    }
  });

  it("keeps other providers' keys when one is added", () => {
    const ws = workspace();
    try {
      saveKey("xai", "sk-xai", ws.dir);
      saveKey("anthropic", "sk-ant", ws.dir);
      assert.deepEqual(readAuth(ws.dir), { xai: "sk-xai", anthropic: "sk-ant" });
    } finally {
      ws.cleanup();
    }
  });

  it("reports failure instead of throwing when the key cannot be persisted", () => {
    // A directory where a file must go: the write fails, and the caller has
    // to be able to say "session only" rather than crash mid-login.
    assert.equal(saveKey("xai", "sk", "/dev/null/nope"), false);
  });

  it("survives a corrupt auth.json rather than taking the session down", () => {
    const ws = workspace();
    try {
      saveKey("xai", "sk", ws.dir);
      writeFileSync(join(ws.dir, "auth.json"), "{not json");
      assert.deepEqual(readAuth(ws.dir), {});
    } finally {
      ws.cleanup();
    }
  });

  it("carries pricing through, so the meter can show a cost", () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.dir, "config.json"),
        JSON.stringify({ baseUrl: PROVIDERS.xai!.url, model: "grok-4.6", priceIn: 0.02, priceOut: 0.06 }),
      );
      const e = storedEndpoint(ws.dir);
      assert.equal(e.priceIn, 0.02);
      assert.equal(e.priceOut, 0.06);
      assert.equal(e.model, "grok-4.6");
    } finally {
      ws.cleanup();
    }
  });

  it("ignores an unusable price rather than letting NaN reach the meter", () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.dir, "config.json"),
        JSON.stringify({ priceIn: "free", priceOut: -1 }),
      );
      const e = storedEndpoint(ws.dir);
      assert.equal(e.priceIn, undefined);
      assert.equal(e.priceOut, undefined);
    } finally {
      ws.cleanup();
    }
  });

  it("keeps pricing when /model rewrites the endpoint", () => {
    // saveEndpoint rewrites config.json on every model switch; prices live in
    // the same file and must survive it.
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "config.json"), JSON.stringify({ priceIn: 0.02, priceOut: 0.06 }));
      saveEndpoint(PROVIDERS.xai!.url, "grok-4", ws.dir);
      const e = storedEndpoint(ws.dir);
      assert.equal(e.model, "grok-4");
      assert.equal(e.priceIn, 0.02);
      assert.equal(e.priceOut, 0.06);
    } finally {
      ws.cleanup();
    }
  });

  it("reads back nothing on a fresh machine", () => {
    const ws = workspace();
    try {
      assert.deepEqual(storedEndpoint(ws.dir), {
        baseUrl: undefined,
        model: undefined,
        apiKey: undefined,
        priceIn: undefined,
        priceOut: undefined,
        priceCachedIn: undefined,
        priceModel: undefined,
      });
    } finally {
      ws.cleanup();
    }
  });
});

describe("status line with no model", () => {
  it("says so instead of naming a model nobody selected", () => {
    const text = statusSegments({ provider: "ollama", model: "", sessionTokens: 0 })
      .map((s) => s.text)
      .join("");
    assert.match(text, /no model/);
    assert.match(text, /\/login/);
    assert.ok(!text.includes("ollama"), "endpoint is unverified until a model is chosen");
  });

  it("withholds usage and cost until there is a model to attribute them to", () => {
    const text = statusSegments({
      provider: "xai",
      model: "",
      sessionTokens: 1234,
      costUsd: 0.42,
    })
      .map((s) => s.text)
      .join("");
    assert.ok(!/tok/.test(text), `leaked a token count: ${text}`);
    assert.ok(!/0\.42|\$/.test(text), `leaked a cost: ${text}`);
  });

  it("shows the model with its usage once one is selected", () => {
    const text = statusSegments({ provider: "xai", model: "grok-4.6", sessionTokens: 1234 })
      .map((s) => s.text)
      .join("");
    assert.match(text, /grok-4\.6/);
    assert.match(text, /tok/);
  });
});

describe("the meter", () => {
  it("puts the cost next to the token count", () => {
    const text = statusSegments({
      provider: "xai",
      model: "grok-4.6",
      sessionTokens: 18_400,
      costUsd: 0.07,
    })
      .map((s) => s.text)
      .join("");
    assert.match(text, /18k tokens · \$0\.07/);
  });

  it("spells out tokens rather than abbreviating", () => {
    const text = statusSegments({ provider: "xai", model: "grok-4.6", sessionTokens: 900 })
      .map((s) => s.text)
      .join("");
    assert.match(text, /900 tokens/);
    assert.ok(!/\btok\b/.test(text), `still abbreviated: ${text}`);
  });

  it("shows a budget with the cost beside it", () => {
    const text = statusSegments({
      provider: "xai",
      model: "grok-4.6",
      sessionTokens: 1000,
      budgetTokens: 50_000,
      costUsd: 0.0042,
    })
      .map((s) => s.text)
      .join("");
    assert.match(text, /1\.0k\/50k tokens · \$0\.004/);
  });

  it("omits the cost when no pricing is configured", () => {
    const text = statusSegments({ provider: "xai", model: "grok-4.6", sessionTokens: 1234 })
      .map((s) => s.text)
      .join("");
    assert.ok(!text.includes("$"), `faked a cost with no pricing: ${text}`);
  });
});

describe("elapsed time", () => {
  it("reads at one useful unit, not five digits", () => {
    assert.equal(fmtDuration(0), "0ms");
    assert.equal(fmtDuration(340), "340ms");
    assert.equal(fmtDuration(1000), "1.0s");
    assert.equal(fmtDuration(2400), "2.4s");
    assert.equal(fmtDuration(12_000), "12s");
    assert.equal(fmtDuration(64_000), "1m 04s");
    assert.equal(fmtDuration(3_600_000), "60m 00s");
  });

  it("never renders a negative or fractional millisecond", () => {
    // Clock skew between two Date.now() reads must not print "-1ms".
    assert.equal(fmtDuration(-5), "0ms");
    assert.equal(fmtDuration(0.4), "0ms");
  });

  it("holds a stable width once past a second, so the line does not jitter", () => {
    // The spinner row redraws ~11×/s; a field that changes width shifts
    // everything after it on every tick.
    for (const ms of [1000, 5500, 9900]) assert.equal(fmtDuration(ms).length, 4);
    for (const ms of [10_000, 30_000, 59_000]) assert.equal(fmtDuration(ms).length, 3);
  });
});

describe("cost formatting", () => {
  const cost = (usd: number, estimated = false) =>
    statusSegments({
      provider: "p",
      model: "m",
      sessionTokens: 1,
      costUsd: usd,
      costEstimated: estimated,
    })
      .map((s) => s.text)
      .join("")
      .split("· ")
      .pop();

  it("keeps the run of zeros short", () => {
    // The first bug: sub-cent sums rendered as "$0.000024" — six digits the
    // reader has to count before the number means anything, in the one field
    // on screen that has to be legible at a glance. Three decimals is the
    // whole budget; below that the figure says "under" instead.
    assert.equal(cost(12.5), "$12.50");
    assert.equal(cost(0.07), "$0.070");
    assert.equal(cost(0.0042), "$0.004");
    assert.equal(cost(0.0004), "<$0.001");
    for (const usd of [12.5, 0.07, 0.0042, 0.00024]) {
      assert.ok(!/000\d/.test(cost(usd)!), `zero run survived: ${cost(usd)}`);
    }
  });

  it("never changes unit as the session grows", () => {
    // The second bug, and the worse one: quoting small sums in cents made the
    // meter read "0.9¢" and then "$0.029" — which looks like it went DOWN.
    // A running total has to be comparable against its own previous value
    // without arithmetic, so the unit is fixed and only the digits move.
    const series = [0.002, 0.009, 0.029, 0.061, 0.42, 1.2, 12.5].map((u) => cost(u)!);
    for (const s of series) assert.ok(s.startsWith("$"), `changed unit: ${s}`);
    // Monotone as rendered, not just as computed.
    const asNumbers = series.map((s) => Number(s.replace("$", "")));
    for (let i = 1; i < asNumbers.length; i++) {
      assert.ok(asNumbers[i]! > asNumbers[i - 1]!, `${series[i - 1]} → ${series[i]} reads as a fall`);
    }
  });

  it("never flattens a real charge to zero", () => {
    // A meter reading zero while the token count climbs reads as broken
    // pricing rather than a cheap turn, so the floor says "under", not "none".
    assert.equal(cost(0.0000001), "<$0.001");
    assert.notEqual(cost(0.0000001), "$0.00");
  });

  it("marks a cost that rests on molt's own token estimate", () => {
    // A guess and a bill must not render identically in the field people
    // quote back at each other.
    assert.equal(cost(0.42, true), "~$0.42");
    assert.equal(cost(0.42, false), "$0.42");
    assert.equal(cost(0.0031, true), "~$0.003");
  });

  it("shows a true zero as zero", () => {
    const text = statusSegments({
      provider: "p",
      model: "m",
      sessionTokens: 5,
      costUsd: 0,
    })
      .map((s) => s.text)
      .join("");
    assert.match(text, /\$0\.00\b/);
  });
});

describe("authentication headers", () => {
  it("sends what each provider actually accepts", () => {
    // Reported from use: /model showed no Anthropic models after a successful
    // login. Their compatibility layer takes `Authorization: Bearer` on
    // /chat/completions but not on /models, which wants x-api-key and a
    // version — so the key worked for chat and 401'd on the model list.
    const fake = `sk-${"ant-key-value"}`;
    const anthropic = authHeaders("https://api.anthropic.com/v1", fake);
    assert.equal(anthropic["x-api-key"], fake);
    assert.equal(anthropic["anthropic-version"], "2023-06-01");
    assert.equal(anthropic.authorization, `Bearer ${fake}`);

    // Everyone else gets the common case, and nothing extra.
    const xai = authHeaders("https://api.x.ai/v1", `xai-${"key-value"}`);
    assert.deepEqual(Object.keys(xai), ["authorization"]);
  });

  it("sends nothing at all without a key", () => {
    assert.deepEqual(authHeaders("http://localhost:11434/v1", undefined), {});
    assert.deepEqual(authHeaders("https://api.anthropic.com/v1", ""), {});
  });

  it("does not throw on a malformed url", () => {
    assert.deepEqual(Object.keys(authHeaders("not a url", "k")), ["authorization"]);
  });
});

describe("the status line with no model", () => {
  it("points at the step that is actually next", () => {
    // Telling someone who just logged in to log in is the kind of small lie
    // that makes a status line stop being read.
    const say = (hint?: string) =>
      statusSegments({ provider: "anthropic", model: "", sessionTokens: 0, hint })
        .map((x) => x.text)
        .join("");
    assert.match(say(), /no model · \/login/);
    assert.match(say("/model"), /no model · \/model/);
  });
});

describe("providerName", () => {
  it("names the provider, not the subdomain", () => {
    // https://api.x.ai/v1 split on "." gives "api", which is what the status
    // line was showing — and would read the same for every vendor.
    assert.equal(providerName(PROVIDERS.xai!.url), "xai");
    assert.equal(providerName(PROVIDERS.anthropic!.url), "anthropic");
    assert.equal(providerName(PROVIDERS.ollama!.url), "ollama");
  });

  it("falls back to the host for an endpoint molt has no preset for", () => {
    assert.equal(providerName("https://api.together.xyz/v1"), "together");
    assert.equal(providerName("https://inference.example.com/v1"), "inference");
  });

  it("does not throw on a malformed url", () => {
    assert.equal(providerName("not a url"), "custom");
  });
});

describe("token formatting", () => {
  const tokens = (n: number) =>
    statusSegments({ provider: "p", model: "m", sessionTokens: n })
      .map((s) => s.text)
      .join("")
      .match(/([\d.]+[kM]?) tokens/)?.[1];

  it("scales past a thousand and past a million", () => {
    assert.equal(tokens(998), "998");
    assert.equal(tokens(2400), "2.4k");
    assert.equal(tokens(45_000), "45k");
    assert.equal(tokens(2_400_000), "2.4M");
    assert.equal(tokens(12_000_000), "12M");
  });

  it("does not make the reader finish the arithmetic", () => {
    // A 1M-token context is ordinary now; "2400k" is not a number anyone
    // reads at a glance.
    assert.ok(!tokens(2_400_000)!.endsWith("k"));
  });
});

/**
 * A price molt cannot check is a number it should not show. These pin the
 * conversion from what each provider publishes to USD per 1M tokens — the
 * arithmetic that, when wrong, produces a meter that is confidently and
 * invisibly off by a factor of a hundred.
 */
describe("pricing, read from the provider", () => {
  const xai = {
    models: [
      {
        id: "grok-4.6",
        aliases: ["grok-4.6-latest"],
        prompt_text_token_price: 20_000,
        cached_prompt_text_token_price: 5000,
        completion_text_token_price: 60_000,
      },
    ],
  };

  it("converts xAI's integers to USD per 1M tokens", () => {
    const p = xaiPricing(xai, "grok-4.6");
    assert.equal(p?.in, 2);
    assert.equal(p?.cached, 0.5);
    assert.equal(p?.out, 6);
    assert.equal(XAI_PRICE_UNIT, 10_000);
  });

  it("matches a model by alias, not only by id", () => {
    assert.equal(xaiPricing(xai, "grok-4.6-latest")?.in, 2);
  });

  it("returns null for a model the endpoint does not list", () => {
    // Better no cost than another model's cost.
    assert.equal(xaiPricing(xai, "grok-9"), null);
    assert.equal(xaiPricing({}, "grok-4.6"), null);
    assert.equal(xaiPricing(null, "grok-4.6"), null);
  });

  it("scales OpenRouter's per-token strings to per-1M", () => {
    const p = openrouterPricing(
      {
        data: [
          {
            id: "anthropic/claude-opus-5",
            pricing: { prompt: "0.000005", completion: "0.000025", input_cache_read: "0.0000005" },
          },
        ],
      },
      "anthropic/claude-opus-5",
    );
    assert.equal(p?.in, 5);
    assert.equal(p?.out, 25);
    assert.equal(p?.cached, 0.5);
  });

  it("asks each provider at the route that actually publishes prices", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(String(url));
      return { ok: true, json: async () => xai } as unknown as Response;
    }) as unknown as typeof fetch;

    const p = await fetchPricing("https://api.x.ai/v1", "grok-4.6", "sk", fake);
    assert.equal(p?.in, 2);
    assert.deepEqual(seen, ["https://api.x.ai/v1/language-models"]);
  });

  it("asks nothing of a provider that publishes nothing", async () => {
    let called = 0;
    const fake = (async () => {
      called++;
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    assert.equal(await fetchPricing("http://localhost:11434/v1", "qwen", undefined, fake), null);
    assert.equal(called, 0, "guessed at a price nobody published");
  });

  it("survives an endpoint that errors rather than taking the session down", async () => {
    const fake = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    assert.equal(await fetchPricing("https://api.x.ai/v1", "grok-4.6", "sk", fake), null);
  });

  it("refuses to trust a price that names no model", () => {
    // The shipped bug: config.json held priceIn/priceOut with nothing saying
    // which model they were for, so a hand-typed figure that was off by a
    // hundred was applied to every model, forever, without a lookup.
    const legacy = { priceIn: 0.02, priceOut: 0.06 };
    assert.equal(needsPriceLookup("grok-4.6", { in: 0.02, source: "stored" }, legacy), true);
    assert.equal(
      needsPriceLookup("grok-4.6", { in: 2, source: "x.ai" }, { ...legacy, priceModel: "grok-4.6" }),
      false,
    );
    // A different model's stored price is not this model's price.
    assert.equal(
      needsPriceLookup("grok-4.3", { in: 2, source: "x.ai" }, { ...legacy, priceModel: "grok-4.6" }),
      true,
    );
    // Set by hand wins: it is the escape hatch for endpoints that publish
    // nothing and for accounts that do not pay list price.
    assert.equal(needsPriceLookup("gpt-5", { in: 1, source: "set by hand" }, {}), false);
  });

  it("files a saved price under the model it belongs to", () => {
    const ws = workspace();
    try {
      savePricing("grok-4.6", { in: 2, out: 6, cached: 0.5, source: "test" }, ws.dir);
      const stored = storedEndpoint(ws.dir);
      assert.equal(stored.priceIn, 2);
      assert.equal(stored.priceCachedIn, 0.5);
      assert.equal(stored.priceModel, "grok-4.6");

      // Clearing must not leave the old model's rate behind to be applied
      // to the next one.
      savePricing("grok-4.6", null, ws.dir);
      assert.equal(storedEndpoint(ws.dir).priceIn, undefined);
    } finally {
      ws.cleanup();
    }
  });
});

describe("the endpoint you are pointed at is a model source", () => {
  it("lists a self-hosted endpoint that holds no key", () => {
    // Reported from use: "/model only shows anthropic and xai, not the models
    // being hosted". modelSources built its list from providers you hold keys
    // for, so a server you had just connected to was invisible in the one
    // place you would go to choose one of its models.
    const sources = modelSources(
      { anthropic: "k1", xai: "k2" },
      { url: "http://192.168.0.218:8080/v1" },
    );
    assert.equal(sources[0]?.url, "http://192.168.0.218:8080/v1", "the current endpoint is not first");
    assert.ok(
      sources.some((s) => s.url.includes("anthropic")),
      "adding the current endpoint dropped the keyed providers",
    );
  });

  it("does not list a preset twice when it is also the current one", () => {
    const sources = modelSources({}, { url: "http://localhost:11434/v1" });
    const ollama = sources.filter((s) => s.url.replace(/\/$/, "") === "http://localhost:11434/v1");
    assert.equal(ollama.length, 1, "pointing at a preset produced two of it");
  });

  it("ignores a trailing slash when deciding that", () => {
    const sources = modelSources({}, { url: "http://localhost:11434/v1/" });
    assert.equal(
      sources.filter((s) => s.url.startsWith("http://localhost:11434/v1")).length,
      1,
      "a trailing slash made the same endpoint look like two",
    );
  });

  it("carries the key, so a keyed custom endpoint can still be asked", () => {
    const sources = modelSources({}, { url: "https://gateway.internal/v1", key: "secret", name: "work" });
    assert.equal(sources[0]?.key, "secret");
    assert.equal(sources[0]?.name, "work");
  });

  it("is unchanged when there is no current endpoint", () => {
    assert.deepEqual(modelSources({ xai: "k" }), modelSources({ xai: "k" }, undefined));
  });
});

describe("telling your own hardware from someone's meter", () => {
  it("recognises the addresses that cannot bill you", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:8080/v1",
      "http://192.168.0.218:8080/v1",
      "http://10.1.2.3:8000/v1",
      "http://172.16.4.5:8000/v1",
      "http://172.31.255.1:8000/v1",
      "http://nuc:11434/v1",
      "http://workstation.local:8080/v1",
      "http://[::1]:8080/v1",
    ]) {
      assert.equal(isSelfHosted(url), true, `${url} should be self-hosted`);
    }
  });

  it("treats anything routable as billable, because it might be", () => {
    // Conservative in the one direction that matters: a ceiling is never
    // lifted from something that could charge for the next token.
    for (const url of [
      "https://api.anthropic.com/v1",
      "https://api.x.ai/v1",
      "https://openrouter.ai/api/v1",
      "https://api.openai.com/v1",
      // Adjacent to a private range without being in one.
      "http://172.32.0.1:8000/v1",
      "http://11.0.0.1:8000/v1",
      "http://192.169.0.1:8000/v1",
      "not a url",
    ]) {
      assert.equal(isSelfHosted(url), false, `${url} should be treated as billable`);
    }
  });
});

/**
 * An address is not a name.
 *
 * Receipt 0025 was filed under `provider: 127`. The endpoint was a model on
 * 127.0.0.1:8080, and `providerName` had split the hostname on dots and taken
 * the first field — which for a preset like `api.x.ai` yields "x" and for an
 * IP address yields the first octet. Every loopback endpoint on the machine
 * collides under that name, and none of them is identified by it, so the one
 * field in a receipt that says where the work was done said nothing.
 */
describe("naming an endpoint you can point at", () => {
  it("prefers a preset's own name", () => {
    assert.equal(providerName("https://api.x.ai/v1"), "xai");
    assert.equal(providerName("https://api.anthropic.com/v1"), "anthropic");
  });

  it("keeps an IP address whole, with the port that distinguishes it", () => {
    assert.equal(providerName("http://127.0.0.1:8080/v1"), "127.0.0.1:8080");
    assert.equal(providerName("http://192.168.0.218:8080/v1"), "192.168.0.218:8080");
    // Two servers on one box differ only by port, so dropping it merges them.
    assert.notEqual(
      providerName("http://192.168.0.218:8080/v1"),
      providerName("http://192.168.0.218:9090/v1"),
    );
  });

  it("keeps a bare LAN hostname whole", () => {
    assert.equal(providerName("http://workshop:11434/v1"), "workshop:11434");
    assert.equal(providerName("http://localhost:8080/v1"), "localhost:8080");
  });

  it("still shortens a real domain", () => {
    // The subdomain strip is what makes a vendor host readable, and it stays.
    assert.equal(providerName("https://api.together.xyz/v1"), "together");
  });

  it("says so when the URL is not one", () => {
    assert.equal(providerName("not a url"), "custom");
  });
});
