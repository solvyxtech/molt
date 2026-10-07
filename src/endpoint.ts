/**
 * Whether a string is an endpoint molt can speak to.
 *
 * Its own file, and free of `node:` imports, because the window needs the same
 * answer as the terminal. Settings takes a base URL in a text box and used to
 * hand whatever was typed straight to the engine — so the one surface where a
 * URL is most likely to be mistyped was the one surface that never judged it.
 * `src/providers.ts` reads auth.json, which cannot be bundled into a renderer,
 * so this moved out from under it rather than being copied.
 */

/**
 * The schemes that used to mark subscription CLIs molt no longer drives.
 *
 * Claude Code, Antigravity, and Gemini CLI were removed (ToS / product scope).
 * Configs and flags that still name them must fail clearly — not fall through
 * to another backend or look like a network fault.
 */
const REMOVED_SUBSCRIPTION_SCHEMES = [
  "claude-code://",
  "antigravity://",
  "agy://",
  "gemini-cli://",
] as const;

const REMOVED_SHORTHANDS = [
  "claude-code",
  "claude",
  "antigravity",
  "agy",
  "gemini-cli",
] as const;

/** A subscription CLI molt still spawns: Grok Build over ACP. */
const GROK_BUILD_SCHEME = "grok-build://";
/** The OpenCode CLI (ACP), driven only for OpenCode Zen's own `opencode/...` models. */
const OPENCODE_SCHEME = "opencode://";

export const GROK_BUILD_URL = `${GROK_BUILD_SCHEME}subscription`;
export const OPENCODE_URL = `${OPENCODE_SCHEME}zen`;
/** The old name for `OPENCODE_URL`: accepted for one release, with a deprecation notice. */
export const OPENCODE_LEGACY_URL = `${OPENCODE_SCHEME}subscription`;

/** Is this endpoint the OpenCode CLI (either spelling)? */
export function isOpencodeUrl(baseUrl: string | undefined): boolean {
  return (baseUrl ?? "").trim().toLowerCase().startsWith(OPENCODE_SCHEME);
}

/**
 * Why `model` cannot run on the OpenCode backend, or null when it can.
 *
 * OpenCode can sign in to other vendors' consumer plans (Anthropic, GitHub
 * Copilot, Gemini, ...) and would route `anthropic/...` through them. Maat
 * drives it only for OpenCode Zen, OpenCode's own models: `opencode/<id>`, or
 * a bare `<id>` meaning the same. Everything else is refused, for the worker
 * and the judge alike. An empty model is the backend's default (Big Pickle).
 */
export function opencodeModelProblem(model: string | undefined): string | null {
  const m = (model ?? "").trim();
  if (!m) return null;
  if (/^(?:opencode\/)?[a-z0-9][a-z0-9._:-]*$/iu.test(m)) return null;
  return (
    `'${m}' is not an OpenCode Zen model. The OpenCode backend runs only OpenCode's own ` +
    `models ('opencode/<model>', e.g. opencode/big-pickle); Maat does not pass other ` +
    `providers or subscription plans through OpenCode. Use that provider's HTTP API with ` +
    `your own key instead.`
  );
}

/** A notice for an endpoint spelling that still works but is going away, or null. */
export function endpointDeprecation(raw: string | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === OPENCODE_LEGACY_URL) {
    return `'${OPENCODE_LEGACY_URL}' is deprecated and will stop working in the next release; use '${OPENCODE_URL}' (or just 'opencode').`;
  }
  return null;
}

/**
 * What someone types, and the sentinel it stands for.
 *
 * One table rather than a chain of comparisons in the flag parser, because
 * the flag parser is not the only caller — the window expands the same words,
 * and the two drifting apart is the bug this file was created to end.
 */
const SHORTHAND: Readonly<Record<string, string>> = {
  "grok-build": GROK_BUILD_URL,
  grok: GROK_BUILD_URL,
  opencode: OPENCODE_URL,
};

/** Why a removed subscription backend cannot be used. */
export function removedSubscriptionProblem(raw: string): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if ((REMOVED_SHORTHANDS as readonly string[]).includes(v)) {
    return removedBackendMessage(v);
  }
  for (const scheme of REMOVED_SUBSCRIPTION_SCHEMES) {
    if (v.startsWith(scheme)) return removedBackendMessage(scheme.replace(/:\/\/$/u, ""));
  }
  return null;
}

function removedBackendMessage(name: string): string {
  return (
    `The '${name}' subscription backend was removed from Maat ` +
    `(Claude Code, Antigravity/agy, and Gemini CLI are no longer supported). ` +
    `Use 'grok-build' / 'grok' for the Grok Build ACP path, or an HTTP API ` +
    `endpoint such as https://api.x.ai/v1 with your own key.`
  );
}

/**
 * `'grok-build'`, typed at a URL box, expanded to the sentinel it stands for.
 *
 * A string that already parses as `grok-build://…` is returned unchanged:
 * this only rewrites the short spelling, never the long one.
 */
export function expandEndpointShorthand(value: string): string {
  const v = (value ?? "").trim();
  // The old OpenCode spelling becomes the new one, so receipts and stored
  // configs only ever carry `opencode://zen` (see `endpointDeprecation`).
  if (v.toLowerCase() === OPENCODE_LEGACY_URL) return OPENCODE_URL;
  return SHORTHAND[v.toLowerCase()] ?? v;
}

/**
 * Why this endpoint cannot be used, or null when it can.
 *
 * Kept pure because four callers need the same answer: the flag parser, the
 * engine before it retries, the doctor, and the window's Settings panel.
 */
export function endpointProblem(baseUrl: string): string | null {
  const url = (baseUrl ?? "").trim();
  if (!url) {
    return (
      "no endpoint is set — give a base URL like https://api.openai.com/v1, " +
      "or pick a provider"
    );
  }
  const removed = removedSubscriptionProblem(url);
  if (removed) return removed;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return (
      `'${url}' is not an endpoint. Give a full base URL like ` +
      `https://api.openai.com/v1 or http://localhost:11434/v1, a provider name to ` +
      `/login, or 'grok-build' to run your own logged-in Grok Build CLI.`
    );
  }
  const allowed = ["http:", "https:", ...[GROK_BUILD_SCHEME, OPENCODE_SCHEME].map((s) => s.replace(/\/\/$/u, ""))];
  if (isOpencodeUrl(url) && ![OPENCODE_URL, OPENCODE_LEGACY_URL].includes(url.toLowerCase())) {
    return `'${url}' is not an OpenCode endpoint Maat knows; use '${OPENCODE_URL}' (or just 'opencode').`;
  }
  if (!allowed.includes(parsed.protocol)) {
    return (
      `'${url}' uses the scheme '${parsed.protocol.replace(":", "")}', which Maat cannot ` +
      `speak. Endpoints are http or https; ${Object.keys(SHORTHAND)
        .map((k) => `'${k}'`)
        .join(", ")} run a CLI instead.`
    );
  }
  return null;
}

/**
 * Why the text in an endpoint box cannot be used, or null when it can.
 *
 * An empty box is not a problem yet — nobody has said anything to be wrong
 * about — which is the one piece of behaviour the old inline `typed ? …` was
 * really carrying.
 */
export function typedEndpointProblem(raw: string): string | null {
  const typed = raw.trim();
  return typed ? endpointProblem(expandEndpointShorthand(typed)) : null;
}
