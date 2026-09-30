/**
 * Everything molt can run, as an editor's model picker.
 *
 * The terminal has `/model` and `/endpoint`; the window has its model list.
 * Over ACP the same choice is a session config option: one grouped select
 * whose groups are the three ways molt reaches a model — a subscription CLI
 * the person is signed in to, an API key they saved, or a server they run.
 *
 * Only what can actually run is listed. "Can run" is molt's existing answer
 * to that question, not a new one: the subscription health checks `doctor`
 * and the window use, and each endpoint's own `/models` — the same probe
 * `/model` makes. Those take seconds (a health check spawns the CLI and asks
 * it to open a session), so discovery runs in the background and the list
 * grows as answers arrive; the endpoint in use is always listed, answered or
 * not, because it is the current value.
 *
 * A value is `<endpoint url>#<model id>`. Endpoint URLs molt uses never carry
 * a fragment, so the first `#` separates them unambiguously whatever the
 * model id contains, and the value reads as what it is in a settings file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACP_AGENTS, acpAgentFor, isAcp } from "./acp.js";
import { AGY_MODELS, isAgy } from "./agy.js";
import { CLAUDE_CODE_MODELS } from "./claude-code.js";
import { AGY_URL, CLAUDE_CODE_URL, isClaudeCode } from "./endpoint.js";
import { PROVIDERS, isSelfHosted, providerName } from "./providers.js";

export type ModelGroup = "subscriptions" | "api-keys" | "local";

export const GROUP_NAMES: Record<ModelGroup, string> = {
  subscriptions: "Subscriptions",
  "api-keys": "API keys",
  local: "Local",
};

const GROUP_ORDER: ModelGroup[] = ["subscriptions", "api-keys", "local"];

/** One endpoint that answered, and what it offers. */
export type ModelSource = {
  group: ModelGroup;
  url: string;
  /** How the source is named in the picker: "Claude Code", "xai", "localhost:11434". */
  label: string;
  models: string[];
};

export type Listing = { ok: true; ids: string[] } | { ok: false; error: string };

export type DiscoveryDeps = {
  /** auth.json: provider name → key. */
  auth: Record<string, string>;
  /** config.json's endpoint: what /login and /model last settled on. */
  stored: { baseUrl?: string; model?: string };
  /** Servers the window has been pointed at (desktop-endpoints.json). */
  remembered: { url: string; lastModel?: string }[];
  /** The endpoint this process was started on (--url/--key/--model), when given. */
  current?: { url: string; key?: string; model?: string };
  /** `/models`, as /model asks it. */
  listModels: (url: string, key?: string) => Promise<Listing>;
  /** Whether a subscription backend can run here: installed, signed in, gated. */
  subscriptionUsable: (url: string) => Promise<boolean>;
  /** Per probe. A probe that has not answered by then is left out. */
  timeoutMs?: number;
  /** Diagnostics for a source left out. */
  log?: (line: string) => void;
};

export const DISCOVERY_TIMEOUT_MS = 20_000;

const norm = (url: string): string => url.trim().replace(/\/+$/, "");

export function encodeModelValue(url: string, model: string): string {
  return `${norm(url)}#${model}`;
}

/** The inverse of encodeModelValue, or null for a value it could not have produced. */
export function decodeModelValue(value: string): { url: string; model: string } | null {
  const i = value.indexOf("#");
  if (i <= 0 || i === value.length - 1) return null;
  return { url: value.slice(0, i), model: value.slice(i + 1) };
}

export function isSubscription(url: string): boolean {
  return isClaudeCode(url) || isAcp(url) || isAgy(url);
}

export function groupOf(url: string): ModelGroup {
  if (isSubscription(url)) return "subscriptions";
  return isSelfHosted(url) ? "local" : "api-keys";
}

export function labelOf(url: string): string {
  if (isClaudeCode(url)) return "Claude Code";
  if (isAgy(url)) return "Antigravity";
  const acp = acpAgentFor(url);
  if (acp) return acp.label;
  return providerName(url);
}

/** The subscription backends molt implements, with the models it knows for each. */
export function subscriptionBackends(): { url: string; models: string[] }[] {
  return [
    { url: CLAUDE_CODE_URL, models: [...CLAUDE_CODE_MODELS] },
    ...ACP_AGENTS.map((a) => ({ url: a.url, models: [...a.models] })),
    { url: AGY_URL, models: [...AGY_MODELS] },
  ];
}

function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

/**
 * Ask every candidate, in parallel, and keep the ones that can run.
 *
 * Candidates are the ones molt already knows about and no others: the
 * subscription CLIs it implements, the providers auth.json holds a key for,
 * the endpoint config.json names, the servers the window remembers, and
 * Ollama's default address (the one keyless preset). Nothing is scanned.
 */
export async function discoverModels(d: DiscoveryDeps): Promise<ModelSource[]> {
  const ms = d.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const say = (line: string) => d.log?.(line);

  const subs = subscriptionBackends().map(async (b): Promise<ModelSource | null> => {
    const ok = await within(d.subscriptionUsable(b.url), ms, false);
    if (!ok) {
      say(`${labelOf(b.url)}: not usable here, left out of the model picker`);
      return null;
    }
    return { group: "subscriptions", url: b.url, label: labelOf(b.url), models: b.models };
  });

  // HTTP endpoints, each once, keyed where a key is held.
  const endpoints = new Map<string, { key?: string; known: string[] }>();
  const add = (url: string | undefined, key?: string, known?: string) => {
    if (!url || isSubscription(url)) return;
    const u = norm(url);
    if (u.includes("#")) return;
    const e = endpoints.get(u) ?? { key: undefined, known: [] };
    e.key ??= key;
    if (known && !e.known.includes(known)) e.known.push(known);
    endpoints.set(u, e);
  };
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (p.needsKey && d.auth[name]) add(p.url, d.auth[name]);
  }
  add(PROVIDERS.ollama?.url);
  if (d.current) add(d.current.url, d.current.key ?? d.auth[providerName(d.current.url)], d.current.model);
  add(d.stored.baseUrl, d.stored.baseUrl ? d.auth[providerName(d.stored.baseUrl)] : undefined, d.stored.model);
  for (const r of d.remembered) add(r.url, d.auth[providerName(r.url)], r.lastModel);

  const http = [...endpoints.entries()].map(async ([url, e]): Promise<ModelSource | null> => {
    const r = await within(d.listModels(url, e.key), ms, { ok: false, error: "no answer in time" } as Listing);
    if (!r.ok) {
      say(`${labelOf(url)} (${url}): ${r.error} — left out of the model picker`);
      return null;
    }
    // A server that answers with an empty list still serves the model it was
    // last used with; one that lists models is believed over memory.
    const models = r.ids.length ? r.ids : e.known;
    if (!models.length) return null;
    return { group: groupOf(url), url, label: labelOf(url), models };
  });

  return (await Promise.all([...subs, ...http])).filter((s): s is ModelSource => s !== null);
}

export type SelectOption = { value: string; name: string; description?: string };
export type SelectGroup = { group: string; name: string; options: SelectOption[] };

/** ACP's SessionConfigOption, as molt sends it. */
export type ConfigOption = {
  id: string;
  name: string;
  description?: string;
  category?: "mode" | "model" | "model_config" | "thought_level";
  type: "select";
  currentValue: string;
  options: SelectOption[] | SelectGroup[];
};

/** The value shown when nothing is selected yet. It runs nothing. */
export const NO_MODEL = "none";

/**
 * The `model` option: every source that answered, grouped, plus whatever is
 * in use now — listed even if its endpoint did not answer, because an option
 * list that does not contain the current value cannot show it.
 */
export function modelOption(sources: ModelSource[], current: { url: string; model: string }): ConfigOption {
  const merged = sources.map((s) => ({ ...s, models: [...s.models] }));
  if (current.model) {
    const at = merged.find((s) => norm(s.url) === norm(current.url));
    if (at) {
      if (!at.models.includes(current.model)) at.models.unshift(current.model);
    } else {
      merged.push({ group: groupOf(current.url), url: norm(current.url), label: labelOf(current.url), models: [current.model] });
    }
  }
  const groups: SelectGroup[] = [];
  if (!current.model) {
    groups.push({
      group: "unset",
      name: "Not set",
      options: [{ value: NO_MODEL, name: "No model selected", description: "Pick one below before sending a prompt" }],
    });
  }
  for (const g of GROUP_ORDER) {
    const options = merged
      .filter((s) => s.group === g)
      .flatMap((s) =>
        s.models.map((m) => ({
          value: encodeModelValue(s.url, m),
          name: `${s.label} · ${m}`,
          description: s.group === "subscriptions" ? `${s.label} subscription` : s.url,
        })),
      );
    if (options.length) groups.push({ group: g, name: GROUP_NAMES[g], options });
  }
  return {
    id: "model",
    name: "Model",
    description: "What runs the turn: a subscription, an API key, or a server you run",
    category: "model",
    type: "select",
    currentValue: current.model ? encodeModelValue(current.url, current.model) : NO_MODEL,
    options: groups,
  };
}

/** Is `value` one of this option's values? */
export function optionHas(option: ConfigOption, value: string): boolean {
  return option.options.some((o) =>
    "options" in o ? o.options.some((x) => x.value === value) : o.value === value,
  );
}

/**
 * The servers the window remembers, read-only.
 *
 * electron/endpoints.ts owns this file and writes it; the CLI never did. It
 * is read here so an editor session offers the same local machines the window
 * does, and it is never written from here.
 */
export function readRememberedEndpoints(dir: string): { url: string; lastModel?: string }[] {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "desktop-endpoints.json"), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e): e is { url: string; lastModel?: string } => !!e && typeof (e as { url?: unknown }).url === "string")
      .map((e) => ({ url: norm(e.url), ...(typeof e.lastModel === "string" ? { lastModel: e.lastModel } : {}) }))
      .filter((e) => e.url.length > 0);
  } catch {
    return [];
  }
}
