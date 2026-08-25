/**
 * Which key reaches which endpoint.
 *
 * Settings offers "API key — blank keeps the stored one". The window took that
 * literally and sent nothing: with the field empty the renderer passes
 * `undefined`, the engine calls `authHeaders(base, undefined)`, and that
 * returns `{}` — no Authorization header on the request at all. x.ai answers a
 * request carrying no credentials with
 * `401 {"code":"unauthenticated:no-credentials"}`, so every turn against grok
 * failed while the model picker — which does read auth.json — went on listing
 * grok's models perfectly, making it look like a model problem.
 *
 * The key was never missing. `providerName("https://api.x.ai/v1")` returns
 * "xai" and auth.json is keyed "xai"; nothing on the path from Settings to the
 * wire ever looked it up.
 *
 * Resolved per endpoint, never carried across one. `Engine.setBaseUrl` assigns
 * whatever key it is handed, including `undefined`, and that is correct —
 * moving to another vendor must not hand that vendor the last one's key. So
 * the answer is for the caller to look the new endpoint's key up rather than
 * for the engine to hold on to the old one.
 *
 * Pure, and separated from `main.ts` for the same reason the other small
 * modules beside it are: this decides whether a session can talk at all, and
 * that deserves a test rather than a source-text assertion.
 */
import { providerName } from "../src/providers.js";

export function keyFor(
  baseUrl: string,
  typed: string | undefined,
  auth: Record<string, string>,
): string | undefined {
  // A key typed into the box outranks the stored one — that is what typing it
  // is for, and it is how a key gets replaced when it is rotated.
  if (typed) return typed;
  return auth[providerName(baseUrl)];
}
