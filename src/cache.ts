/**
 * Prompt caching, for whichever provider is on the other end.
 *
 * Re-sending the conversation every step is what an agent loop *is*, and it is
 * where nearly all the money goes: one measured session spent 939,000 prompt
 * tokens against 7,900 completion tokens — 99.2% of the input bill was reading
 * back what had already been sent. Caching is therefore not an optimisation
 * here, it is the difference between a tool you can leave running and one you
 * cannot afford to.
 *
 * Providers do this in two different ways, and molt has to serve both:
 *
 *  - **Automatic.** OpenAI, xAI, Groq and most OpenAI-compatible hosts match
 *    on the prefix with no opt-in. Nothing to send; the only thing that
 *    matters is that the prefix does not move. molt already gets 64% hit rates
 *    on xAI this way.
 *  - **Explicit.** Anthropic-family models cache only up to a `cache_control`
 *    breakpoint you place yourself. Without markers the hit rate is exactly
 *    zero and the same session costs about 2.2× more.
 *
 * The rule this module keeps: **a marker may never change what the model
 * reads.** Caching is a billing concern, and a billing concern that alters the
 * conversation would be trading correctness for money — which is the one trade
 * this tool exists to refuse. Everything below either adds a `cache_control`
 * field or does nothing at all; no text is rewritten, reordered, or dropped.
 */
import type { Msg } from "./types.js";

/** Anthropic's per-request maximum. Spending more is an error, not a bonus. */
export const MAX_BREAKPOINTS = 4;

/**
 * How far a breakpoint looks back for an existing entry, in content blocks.
 *
 * Anthropic walks back at most 20. An agent step can append an assistant
 * message plus one result per tool call, so a single busy step can push the
 * previous request's marker out of range — and the miss is silent: no error,
 * just a full-price request that looks exactly like a cheap one. Markers are
 * spaced to stay inside this window rather than all landing at the tip.
 */
export const LOOKBACK_BLOCKS = 20;

/** Spacing between rolling markers, comfortably inside the lookback window. */
const STRIDE = 12;

export type CacheStyle = "explicit" | "automatic";

/**
 * Which caching a given endpoint and model use.
 *
 * Decided on the model name as well as the host, because an Anthropic model
 * reached through OpenRouter needs the same markers as one reached directly —
 * the route changes, the model's caching does not.
 */
export function cacheStyle(baseUrl: string, model: string): CacheStyle {
  const m = model.toLowerCase();
  if (m.includes("claude") || m.startsWith("anthropic/")) return "explicit";
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    /* a malformed URL gets the common case and fails on its own terms */
  }
  return host.endsWith("anthropic.com") ? "explicit" : "automatic";
}

/**
 * A message with a cache breakpoint on it.
 *
 * The OpenAI-compatible way to carry `cache_control` is to promote the string
 * body to a one-element content array. This is the same text: providers that
 * understand the array read the identical characters out of it, and providers
 * that do not are never sent one — `plan` only marks messages when the style
 * is explicit.
 */
function marked(msg: Omit<Msg, "molt">): Omit<Msg, "molt"> {
  if (typeof msg.content !== "string") return msg;
  return {
    ...msg,
    content: [
      { type: "text", text: msg.content, cache_control: { type: "ephemeral" } },
    ] as unknown as string,
  };
}

/**
 * Whether a message can carry a marker without changing its meaning.
 *
 * Assistant turns carrying `tool_calls` are left alone. Their `content` is
 * often null and the shape providers accept around tool calls varies more than
 * it does for plain text — and there is nothing to gain: a breakpoint one
 * message later caches the assistant turn anyway, since caching is a prefix
 * match. Cheap to skip, and skipping removes a whole class of wire risk.
 */
function markable(msg: Omit<Msg, "molt">): boolean {
  if (typeof msg.content !== "string" || msg.content === "") return false;
  if (msg.role === "assistant" && msg.tool_calls?.length) return false;
  return true;
}

/**
 * Where the breakpoints go, as indices into `messages`.
 *
 * One on the system prompt, which sits behind the tools and so caches both,
 * and the rest rolling along the tail of the conversation. The tail is where
 * the tokens are: the static prefix is about a thousand tokens and a working
 * conversation reaches tens of thousands.
 *
 * Returned as indices rather than applied here so the placement can be
 * asserted directly in a test, without reading it back out of a wire body.
 */
export function breakpoints(messages: Omit<Msg, "molt">[]): number[] {
  const marks: number[] = [];
  const first = messages.findIndex((m) => m.role === "system");
  if (first !== -1 && markable(messages[first]!)) marks.push(first);

  // Walk back from the newest message, marking a markable one every STRIDE,
  // until the budget is spent. Newest first: the tip is the marker the next
  // request will read from, and it is the one that must exist.
  const room = MAX_BREAKPOINTS - marks.length;
  const rolling: number[] = [];
  let since = STRIDE;
  for (let i = messages.length - 1; i > (first === -1 ? -1 : first) && rolling.length < room; i--) {
    since += 1;
    if (since < STRIDE || !markable(messages[i]!)) continue;
    rolling.push(i);
    since = 0;
  }
  return [...marks, ...rolling.reverse()];
}

/**
 * The messages to send, with breakpoints applied where they are understood.
 *
 * On automatic providers this returns the input untouched — there is nothing
 * to send, and sending an unread field would only be a way to be wrong later.
 */
export function withCaching(
  messages: Omit<Msg, "molt">[],
  style: CacheStyle,
  enabled = true,
): Omit<Msg, "molt">[] {
  if (!enabled || style !== "explicit") return messages;
  const at = new Set(breakpoints(messages));
  if (at.size === 0) return messages;
  return messages.map((m, i) => (at.has(i) ? marked(m) : m));
}

/**
 * Does this error read as the provider refusing the markers themselves?
 *
 * Used to tell "this endpoint does not take `cache_control`" apart from "this
 * request was wrong", so molt can drop the markers for the session and carry
 * on rather than failing a turn over a billing optimisation. Deliberately
 * narrow: a 400 that says nothing about caching is a real 400.
 */
export function refusedCaching(body: string): boolean {
  return /cache_control|cache-control|caching is not supported/i.test(body);
}
