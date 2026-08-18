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
export async function fetchPricing(
  baseUrl: string,
  model: string,
  apiKey?: string,
  fetchFn: typeof fetch = fetch,
): Promise<Pricing | null> {
  if (!model) return null;
  const base = baseUrl.replace(/\/$/, "");
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
export function modelSources(
  auth: Record<string, string>,
): { name: string; url: string; key?: string }[] {
  return Object.entries(PROVIDERS)
    .filter(([name, p]) => !p.needsKey || auth[name])
    .map(([name, p]) => ({ name, url: p.url, key: auth[name] }));
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

