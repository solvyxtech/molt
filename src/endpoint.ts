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
/** OpenCode's own subscription (ACP), the other subscription CLI molt spawns. */
const OPENCODE_SCHEME = "opencode://";

export const GROK_BUILD_URL = `${GROK_BUILD_SCHEME}subscription`;
export const OPENCODE_URL = `${OPENCODE_SCHEME}subscription`;

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
