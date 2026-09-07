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
 * The scheme that marks an endpoint as the Claude Code backend rather than an
 * HTTP address.
 *
 * Used to exist three times: the literal in `CLAUDE_CODE_URL` below, the
 * literal `isClaudeCode` in `claude-code.ts` compared every base URL against,
 * and the literal in `endpointProblem`'s allow-list a few lines down. Three
 * spellings of the same fact is three chances for one of them to be edited
 * and the other two forgotten, so this is the one place it is written down.
 */
const CLAUDE_CODE_SCHEME = "claude-code://";

/**
 * The endpoint molt stores for the Claude Code backend.
 *
 * Lives here, not in `claude-code.ts`, for the same reason `endpointProblem`
 * does: it is a plain string, and `claude-code.ts` opens with six `node:`
 * imports that make it unusable from the window. `claude-code.ts` re-exports
 * this rather than holding a second copy, so the sentinel spelled `'claude-code'`
 * by a person and the one compared against by `isClaudeCode` cannot drift
 * apart from each other.
 */
export const CLAUDE_CODE_URL = `${CLAUDE_CODE_SCHEME}subscription`;

/** Is this endpoint the Claude Code backend rather than an HTTP API? */
export function isClaudeCode(baseUrl: string | undefined): boolean {
  return (baseUrl ?? "").trim().toLowerCase().startsWith(CLAUDE_CODE_SCHEME);
}

/**
 * `'claude-code'`, typed at a URL box, expanded to the sentinel it stands for.
 *
 * `--url claude-code` only ever worked in `src/cli.tsx`, which held the one
 * line that translated the word someone types into the address
 * `isClaudeCode` actually checks for. Every other caller of a base URL — the
 * engine, and the window's Settings panel — read whatever was typed as a
 * literal address, so `'claude-code'` there became a request to
 * `claude-code/chat/completions`: not a URL, not the sentinel, and reported as
 * the network being down. Moved beside `endpointProblem` so every caller
 * expands the same word into the same address, rather than the flag parser
 * being the one surface that had this and no other surface learning it.
 *
 * A string that already parses as `claude-code://…` is returned unchanged:
 * this only rewrites the short spelling, never the long one.
 */
export function expandEndpointShorthand(value: string): string {
  const v = (value ?? "").trim();
  return v === "claude-code" ? CLAUDE_CODE_URL : v;
}

/**
 * Why this endpoint cannot be used, or null when it can.
 *
 * `fetch` is the only thing that ever judged this, and it judges late and
 * badly: `--url claude-code` (the shorthand, typed at a build that did not
 * have it) produced `TypeError: Failed to parse URL from
 * claude-code/chat/completions`, which molt classified as a network fault and
 * retried four times over seven seconds before giving up. A string that is not
 * an address does not become one on the second attempt.
 *
 * Kept pure because four callers need the same answer: the flag parser, the
 * engine before it retries, the doctor, and the window's Settings panel.
 *
 * The wording is deliberately surface-neutral. The empty case used to say
 * "pass --url", which is advice you cannot take in a window — the message is
 * shown beside a text box that is the very thing it is telling you to pass.
 */
export function endpointProblem(baseUrl: string): string | null {
  const url = (baseUrl ?? "").trim();
  if (!url) {
    return (
      "no endpoint is set — give a base URL like https://api.openai.com/v1, " +
      "or pick a provider"
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return (
      `'${url}' is not an endpoint. Give a full base URL like ` +
      `https://api.openai.com/v1 or http://localhost:11434/v1, a provider name to ` +
      `/login, or 'claude-code' to run your own logged-in Claude Code.`
    );
  }
  const allowed = ["http:", "https:", CLAUDE_CODE_SCHEME.replace(/\/\/$/, "")];
  if (!allowed.includes(parsed.protocol)) {
    return (
      `'${url}' uses the scheme '${parsed.protocol.replace(":", "")}', which molt cannot ` +
      `speak. Endpoints are http or https; 'claude-code' runs the CLI instead.`
    );
  }
  return null;
}

/**
 * Why the text in an endpoint box cannot be used, or null when it can.
 *
 * The window had this inline, reading the DOM, so it could only ever be
 * asserted by matching the source text of the line that implemented it — and
 * a test that matches
 *
 *     /return typed \? endpointProblem\(endpointFieldValue\(\)\) : null;/
 *
 * still passes if `endpointFieldValue` quietly stops expanding the shorthand.
 * It pins a call site while reading like it pins behaviour, and `mutation`
 * cannot catch it, because the assertion runs against a string read off disk
 * rather than against executed code.
 *
 * So the decision moved here, where it can be run. Same pattern as
 * `ui/wait-words.ts` and `ui/markdown.ts`: the pure part is importable, and
 * what stays in `app.ts` is one line of wiring that a source assertion is the
 * honest tool for.
 *
 * An empty box is not a problem yet — nobody has said anything to be wrong
 * about — which is the one piece of behaviour the old inline `typed ? …` was
 * really carrying.
 */
export function typedEndpointProblem(raw: string): string | null {
  const typed = raw.trim();
  return typed ? endpointProblem(expandEndpointShorthand(typed)) : null;
}
