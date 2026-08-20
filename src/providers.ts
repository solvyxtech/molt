/**
 * Provider presets, credential storage, and the selection rules behind
 * /login and /model.
 *
 * Kept pure and free of Ink for the same reason the command palette is: a
 * picker that commits a row other than the highlighted one is worse than no
 * picker, because it moves your session to another provider without saying
 * so — and bills a different account for the next turn.
 *
 * Keys live in ~/.config/molt/auth.json at 0600 — outside the repo, so a
 * tool whose whole pitch is an auditable record never writes a credential
 * into one.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { windowAround } from "./commands.js";

export type Provider = {
  url: string;
  needsKey: boolean;
  /** Shown once on connect — anything a key-holder should know up front. */
  hint?: string;
};

export const PROVIDERS: Record<string, Provider> = {
  ollama: { url: "http://localhost:11434/v1", needsKey: false },
  openrouter: { url: "https://openrouter.ai/api/v1", needsKey: true },
  anthropic: {
    url: "https://api.anthropic.com/v1",
    needsKey: true,
    hint: "Console API key (metered) — subscription logins are not permitted in third-party tools",
  },
  openai: { url: "https://api.openai.com/v1", needsKey: true },
  xai: { url: "https://api.x.ai/v1", needsKey: true },
  groq: { url: "https://api.groq.com/openai/v1", needsKey: true },
};

/** Providers you can hold a key for, in listing order. */
export function keyedProviders(): string[] {
  return Object.keys(PROVIDERS).filter((n) => PROVIDERS[n]!.needsKey);
}

/**
 * Headers that authenticate a request to a given endpoint.
 *
 * Nearly every OpenAI-compatible provider takes `Authorization: Bearer`, and
 * molt sent only that. Anthropic's compatibility layer accepts it on
 * /chat/completions but *not* on /models, which wants `x-api-key` and
 * `anthropic-version` — so a key that worked perfectly well for chat produced
 * a 401 on the model list, and /model showed an empty provider. Both header
 * styles go out to hosts that want them; a header a provider does not know is
 * a header it ignores.
 */
export function authHeaders(baseUrl: string, apiKey?: string): Record<string, string> {
  if (!apiKey) return {};
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    /* a malformed URL gets the common case and fails on its own terms */
  }
  if (host.endsWith("anthropic.com")) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

export function defaultConfigDir(): string {
  return join(homedir(), ".config", "molt");
}

function readJson(dir: string, file: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeJson(
  dir: string,
  file: string,
  data: Record<string, unknown>,
  secret = false,
): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, file);
    writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
    // chmod after write: the file must never exist world-readable, even briefly.
    if (secret) chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

export function readAuth(dir = defaultConfigDir()): Record<string, string> {
  return readJson(dir, "auth.json");
}

/** Returns false when the key could not be persisted — the caller says so. */
export function saveKey(provider: string, key: string, dir = defaultConfigDir()): boolean {
  return writeJson(dir, "auth.json", { ...readAuth(dir), [provider]: key }, true);
}

export function saveEndpoint(baseUrl: string, model: string, dir = defaultConfigDir()): boolean {
  return writeJson(dir, "config.json", { ...readJson(dir, "config.json"), baseUrl, model });
}

export type StoredEndpoint = {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** USD per 1M prompt / completion tokens. Undefined means no cost is shown. */
  priceIn?: number;
  priceOut?: number;
  /** USD per 1M cached prompt tokens, when the provider publishes one. */
  priceCachedIn?: number;
  /**
   * The model those prices belong to.
   *
   * Prices are per model, so a stored price is only usable while the stored
   * model is still the one selected. Without this, switching models kept
   * billing the session at the old model's rate — a meter that is confidently
   * wrong, which is worse than one that says nothing.
   */
  priceModel?: string;
};

/** A config value only counts as a price if it is a usable non-negative number. */
function price(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * The endpoint /login and /model last settled on, its key, and its pricing.
 *
 * Injected into parseArgs rather than read there, so argument parsing stays
 * a pure function of argv and the environment — a test must not depend on
 * whether the machine running it happens to have logged in.
 */
export function storedEndpoint(dir = defaultConfigDir()): StoredEndpoint {
  const cfg = readJson(dir, "config.json") as Record<string, unknown>;
  const auth = readAuth(dir);
  const name = Object.keys(PROVIDERS).find((n) => PROVIDERS[n]!.url === cfg.baseUrl);
  return {
    baseUrl: cfg.baseUrl as string | undefined,
    model: cfg.model as string | undefined,
    apiKey: name ? auth[name] : undefined,
    priceIn: price(cfg.priceIn),
    priceOut: price(cfg.priceOut),
    priceCachedIn: price(cfg.priceCachedIn),
    priceModel: typeof cfg.priceModel === "string" ? cfg.priceModel : undefined,
  };
}

/** USD per 1M tokens, and where the figure came from. */
export type Pricing = {
  in: number;
  out: number;
  /** Cached prompt tokens, when the provider publishes a separate rate. */
  cached?: number;
  /** Endpoint the numbers were read from, for /price to name. */
  source: string;
};

/**
 * xAI publishes prices on /language-models as integers.
 *
 * The unit is 1e-4 USD per 1M tokens — equivalently, cents per 100M tokens.
 * grok-4.6 reports 20000 / 60000, i.e. $2.00 in and $6.00 per 1M out, which
 * is the only reading in the right order of magnitude: /1e6 would price a
 * frontier model at two cents per million tokens, and /100 at two hundred
 * dollars. molt shows the resolved figure in /price precisely so a unit
 * that ever changes is visible rather than silently baked into a total.
 */
export const XAI_PRICE_UNIT = 10_000;

type XaiModel = {
  id?: string;
  aliases?: string[];
  prompt_text_token_price?: number;
  cached_prompt_text_token_price?: number;
  completion_text_token_price?: number;
};

export function xaiPricing(json: unknown, model: string): Pricing | null {
  const models = (json as { models?: XaiModel[] } | null)?.models;
  if (!Array.isArray(models)) return null;
  const m = models.find((x) => x.id === model || (x.aliases ?? []).includes(model));
  const pin = m?.prompt_text_token_price;
  const pout = m?.completion_text_token_price;
  if (typeof pin !== "number" || typeof pout !== "number") return null;
  const cached = m?.cached_prompt_text_token_price;
  return {
    in: pin / XAI_PRICE_UNIT,
    out: pout / XAI_PRICE_UNIT,
    cached: typeof cached === "number" ? cached / XAI_PRICE_UNIT : undefined,
    source: "x.ai/v1/language-models",
  };
}

type OpenRouterModel = {
  id?: string;
  pricing?: { prompt?: string | number; completion?: string | number; input_cache_read?: string | number };
};

/** OpenRouter quotes USD per single token, as strings. Scale to per-1M. */
export function openrouterPricing(json: unknown, model: string): Pricing | null {
  const data = (json as { data?: OpenRouterModel[] } | null)?.data;
  if (!Array.isArray(data)) return null;
  const m = data.find((x) => x.id === model);
  const n = (v: unknown): number | undefined => {
    const x = typeof v === "number" ? v : Number(v);
    return Number.isFinite(x) && x >= 0 ? x * 1e6 : undefined;
  };
  const pin = n(m?.pricing?.prompt);
  const pout = n(m?.pricing?.completion);
  if (pin === undefined || pout === undefined) return null;
  return { in: pin, out: pout, cached: n(m?.pricing?.input_cache_read), source: "openrouter.ai/api/v1/models" };
}

/**
 * Ask the endpoint what it charges for this model.
 *
 * Only providers that publish machine-readable prices are asked; the rest
 * return null and molt shows no cost at all, which is the existing and
 * correct behaviour. A hardcoded price table would go stale silently and
 * bill a session at a rate nobody can check — the exact failure this
 * function exists to remove.
 */
/**
 * Anthropic's published rates, in USD per million tokens.
 *
 * Carried here because Anthropic has no price endpoint to ask — every other
 * provider molt talks to publishes one, and the meter simply read "no price
 * for this model", which on the endpoint where caching does the most work is
 * the least useful place to go quiet.
 *
 * Standard rates, deliberately, even where an introductory rate is currently
 * lower: a promotional price expires and a budget that under-counts stops you
 * too late. Over-counting stops you early, which is the safe direction for a
 * ceiling. `/price` overrides both numbers when you want the real ones.
 *
 * Cache reads bill at a tenth of the input rate — which is the whole reason
 * the native protocol was worth writing.
 */
const ANTHROPIC_PRICES: { match: RegExp; in: number; out: number }[] = [
  { match: /^claude-(fable|mythos)-5/, in: 10, out: 50 },
  { match: /^claude-opus-/, in: 5, out: 25 },
  { match: /^claude-sonnet-/, in: 3, out: 15 },
  { match: /^claude-haiku-/, in: 1, out: 5 },
];

/** The published rate for an Anthropic model, or null if it is not one. */
export function anthropicPricing(model: string): Pricing | null {
  const id = model.replace(/^anthropic\//, "").toLowerCase();
  const row = ANTHROPIC_PRICES.find((r) => r.match.test(id));
  if (!row) return null;
  return {
    in: row.in,
    out: row.out,
    // A tenth of input, per Anthropic's published cache-read rate.
    cached: row.in / 10,
    source: "published rates (standard, not introductory) — /price to override",
  };
}

export async function fetchPricing(
  baseUrl: string,
  model: string,
  apiKey?: string,
  fetchFn: typeof fetch = fetch,
): Promise<Pricing | null> {
  if (!model) return null;
  const base = baseUrl.replace(/\/$/, "");
  // Asked before the network, because there is nothing to ask: Anthropic
  // publishes no price list to fetch.
  if (/anthropic\.com$/.test((() => { try { return new URL(base).hostname; } catch { return ""; } })())) {
    const known = anthropicPricing(model);
    if (known) return known;
  }
  const host = (() => {
    try {
      return new URL(base).hostname;
    } catch {
      return "";
    }
  })();

  const route = host.endsWith("x.ai")
    ? { path: "/language-models", parse: xaiPricing }
    : host.endsWith("openrouter.ai")
      ? { path: "/models", parse: openrouterPricing }
      : null;
  if (!route) return null;

  try {
    const res = await fetchFn(`${base}${route.path}`, { headers: authHeaders(base, apiKey) });
    if (!res.ok) return null;
    return route.parse(await res.json(), model);
  } catch {
    return null;
  }
}

/**
 * Should molt go and ask what this model costs?
 *
 * No, when the price was set by hand — that is the escape hatch for
 * endpoints that publish nothing and for accounts on a negotiated rate.
 * No, when a stored price is already stamped with this exact model.
 * Yes otherwise, which includes a stored price carrying no model at all:
 * a rate that cannot be attributed to a model cannot be trusted against
 * one, and that unattributed number is precisely how a session ends up
 * metered at a hundredth of the real price.
 */
export function needsPriceLookup(
  model: string,
  current: { in?: number; source?: string },
  stored: StoredEndpoint,
): boolean {
  if (!model) return false;
  if (current.source === "set by hand") return false;
  return !(stored.priceModel === model && current.in !== undefined);
}

/** Remember what this model costs, so the next run starts already priced. */
export function savePricing(
  model: string,
  p: Pricing | null,
  dir = defaultConfigDir(),
): boolean {
  const cfg = readJson(dir, "config.json");
  const next: Record<string, unknown> = { ...cfg, priceModel: model };
  if (p) {
    next.priceIn = p.in;
    next.priceOut = p.out;
    if (p.cached === undefined) delete next.priceCachedIn;
    else next.priceCachedIn = p.cached;
  } else {
    delete next.priceIn;
    delete next.priceOut;
    delete next.priceCachedIn;
  }
  return writeJson(dir, "config.json", next);
}

/**
 * Resolve `/login <name>` to a provider. Names only: the picker is driven by
 * the arrow keys and shows no numbers, so there is no ordinal for a user to
 * have seen and typed.
 */
export function resolveProvider(sel: string): string | null {
  return keyedProviders().includes(sel) ? sel : null;
}

/**
 * The short name for an endpoint, for the status line.
 *
 * Prefer a preset's name over parsing the host: `https://api.x.ai/v1` splits
 * to "api", which names the subdomain rather than the provider and reads the
 * same for every vendor that fronts their API that way.
 */
/**
 * Is this endpoint a machine you run?
 *
 * Decided on the address, deliberately, and not on whether molt knows a price.
 * A provider molt has no rate for still bills you — Anthropic did, until its
 * published rates were added — so absence of a price is not absence of a cost.
 * A loopback or private address is different in kind: nobody is invoicing you
 * for your own hardware, and a spending ceiling there protects against a bill
 * that does not exist while stopping work that costs nothing but electricity.
 *
 * Conservative in the direction that matters: anything routable on the public
 * internet is treated as billable, so a ceiling is never lifted from something
 * that might charge for the next token.
 */
export function isSelfHosted(baseUrl: string): boolean {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  // IPv6 loopback, with or without the brackets a URL puts round it.
  if (host === "::1" || host === "[::1]") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  // A bare name with no dots is a LAN hostname, not a public one.
  return host.length > 0 && !host.includes(".");
}

export function providerName(url: string): string {
  const match = Object.keys(PROVIDERS).find((n) => PROVIDERS[n]!.url === url);
  if (match) return match;
  try {
    const host = new URL(url).hostname.replace(/^(api|www)\./, "");
    return host.split(".")[0] ?? host;
  } catch {
    return "custom";
  }
}

export type ModelChoice = {
  provider: string;
  id: string;
  url: string;
  key?: string;
};

/** Everywhere you hold a key, plus anything local that needs none. */
/**
 * Every endpoint the picker should ask for models.
 *
 * `current` is the endpoint molt is pointed at right now, and it belongs in
 * the list whether or not it is one of the presets. Without it, connecting to
 * a server you run and then opening `/model` showed the providers you hold
 * keys for and nothing from the machine you had just connected to — reported
 * as "/model only shows anthropic and xai, not the models being hosted". The
 * endpoint you are using is the one whose models you most obviously want.
 *
 * Listed first, for the same reason, and never twice: a preset you are already
 * pointed at is matched by URL rather than by name, so `/endpoint` to Ollama's
 * default address does not produce two Ollamas.
 */
export function modelSources(
  auth: Record<string, string>,
  current?: { url: string; key?: string; name?: string },
): { name: string; url: string; key?: string }[] {
  const presets = Object.entries(PROVIDERS)
    .filter(([name, p]) => !p.needsKey || auth[name])
    .map(([name, p]) => ({ name, url: p.url, key: auth[name] }));
  if (!current?.url) return presets;
  const same = (a: string, b: string): boolean => a.replace(/\/$/, "") === b.replace(/\/$/, "");
  if (presets.some((p) => same(p.url, current.url))) return presets;
  return [
    { name: current.name || providerName(current.url), url: current.url, key: current.key },
    ...presets,
  ];
}

/**
 * One rendered line of the picker. Headers group the list by provider and
 * are not selectable — the arrow keys step over them, so a header can never
 * be "chosen" and there is nothing to number.
 */
export type PickerRow =
  | { kind: "header"; provider: string }
  | { kind: "model"; choice: ModelChoice };

/**
 * The picker's rows, in display order: each provider's header followed by
 * its models, providers in first-seen order.
 *
 * Rendering and selection both read this one array, so the highlighted row
 * is always the row that gets chosen.
 */
export function pickerRows(choices: ModelChoice[]): PickerRow[] {
  const byProvider = new Map<string, ModelChoice[]>();
  for (const c of choices) {
    const arr = byProvider.get(c.provider) ?? [];
    arr.push(c);
    byProvider.set(c.provider, arr);
  }
  return [...byProvider.entries()].flatMap(([provider, models]): PickerRow[] => [
    { kind: "header", provider },
    ...models.map((choice): PickerRow => ({ kind: "model", choice })),
  ]);
}

/** Index of the first selectable row, or -1 when there is nothing to pick. */
export function firstSelectable(rows: PickerRow[]): number {
  return rows.findIndex((r) => r.kind === "model");
}

/**
 * Step the highlight by `delta`, skipping headers and wrapping at both ends.
 * Returns the current index unchanged when no row is selectable, so a caller
 * cannot land the cursor on a header by holding an arrow key down.
 */
export function moveSelection(rows: PickerRow[], index: number, delta: number): number {
  const total = rows.length;
  if (total === 0 || firstSelectable(rows) === -1) return index;
  const step = delta < 0 ? -1 : 1;
  let i = index;
  // At most `total` hops: enough to wrap the whole list and find the next
  // model row, and bounded so a list of only headers cannot spin forever.
  for (let hops = 0; hops < total; hops++) {
    i = (i + step + total) % total;
    if (rows[i]!.kind === "model") return i;
  }
  return index;
}

/** How many picker rows are on screen at once. */
export const PICKER_ROWS = 10;

/**
 * The slice of rows to draw, keeping the highlight on screen.
 *
 * Each entry carries its index in the full list, so the renderer compares
 * against the real selection rather than a position within the window — the
 * bug that makes a scrolled list highlight the wrong row.
 */
export function windowRows(
  rows: PickerRow[],
  index: number,
  size = PICKER_ROWS,
): { row: PickerRow; i: number }[] {
  return windowAround(rows, index, size).map(({ item, i }) => ({ row: item, i }));
}

