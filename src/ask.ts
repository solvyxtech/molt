/**
 * One short question to the model, with no tools, on whatever backend is
 * configured.
 *
 * Three things in molt need this — drafting criteria, the interview, and
 * planning a mission — and each had grown its own copy of the same four
 * branches: HTTP endpoint, Claude Code, an ACP agent, Antigravity. Four
 * copies of a transport is four places for the next backend to be missed,
 * which is the both-surfaces bug in a different coat. This is the one place.
 *
 * Deliberately not a turn. No tools, a small token ceiling, temperature
 * zero, and one reply. What is asked for here is a structured answer a
 * person or a gate will read, never work.
 */
import { acpAgentFor, acpAsk } from "./acp.js";
import { agyAsk, isAgy } from "./agy.js";
import { claudeCodeAsk, isClaudeCode, type Sdk } from "./claude-code.js";
import { errorText } from "./format.js";
import { authHeaders } from "./providers.js";
import { askError, askTimeoutMs, probeSignal } from "./watchdog.js";

export type AskOptions = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  system: string;
  prompt: string;
  /** Output ceiling. Small: this is one structured answer. */
  maxTokens?: number;
  /** See EngineConfig.reasoningEffort. Sent only when set. */
  reasoningEffort?: string;
  /** Where the question is asked from. The subprocess transports read it. */
  cwd?: string;
  /** What is being asked, for the error message: "drafting criteria". */
  what?: string;
  fetchFn?: typeof fetch;
  claudeCodeSdk?: Sdk;
  acpSpawn?: typeof import("node:child_process").spawn;
  agyRun?: (cmd: string, args: string[], opts: object) => Promise<{ stdout: string }>;
  timeoutMs?: number;
};

export type Asked = { ok: true; text: string; cutOff: boolean } | { ok: false; error: string };

/**
 * The output ceiling for one ask, unless the caller says otherwise.
 *
 * It was 500, sized for the JSON the drafter wants. A reasoning model spends
 * the ceiling before it writes a word: Mercury 2.5, asked for three criteria,
 * used 491 tokens thinking and returned an empty reply with `finish_reason:
 * length`, and every headless run drafted nothing. Hidden reasoning is billed
 * against the same ceiling as the answer, so the ceiling has to hold both.
 */
export const ASK_MAX_TOKENS = 2_000;

/** How much larger the retry is when a reply came back empty at the ceiling. */
export const ASK_RETRY_FACTOR = 4;

export async function askModel(opts: AskOptions): Promise<Asked> {
  const first = await askOnce(opts, opts.maxTokens ?? ASK_MAX_TOKENS);
  // Empty AND cut off means the model spent the whole ceiling reasoning and
  // never started the answer. Once, with room: a model that empties a four
  // times larger ceiling the same way is not going to answer, and the second
  // failure says exactly that instead of "the reply was empty".
  if (first.ok && first.cutOff && first.text.trim() === "") {
    const bigger = (opts.maxTokens ?? ASK_MAX_TOKENS) * ASK_RETRY_FACTOR;
    const second = await askOnce(opts, bigger);
    if (second.ok && second.cutOff && second.text.trim() === "") {
      return {
        ok: false,
        error:
          `the model spent its whole ${bigger}-token ceiling reasoning and wrote nothing, twice` +
          (opts.what ? ` while ${opts.what}` : "") +
          " — pick a model that answers, or raise --max-tokens",
      };
    }
    return second;
  }
  return first;
}

async function askOnce(opts: AskOptions, maxTokens: number): Promise<Asked> {
  const limitMs = askTimeoutMs(maxTokens, opts.timeoutMs);

  if (isAgy(opts.baseUrl)) {
    const asked = await agyAsk({
      model: opts.model,
      systemPrompt: opts.system,
      prompt: opts.prompt,
      ...(opts.agyRun ? { run: opts.agyRun } : {}),
    });
    return asked.ok ? { ok: true, text: asked.text, cutOff: false } : asked;
  }

  const acp = acpAgentFor(opts.baseUrl);
  if (acp) {
    const asked = await acpAsk({
      timeoutMs: limitMs,
      spec: acp,
      model: opts.model,
      systemPrompt: opts.system,
      prompt: opts.prompt,
      cwd: opts.cwd,
      ...(opts.acpSpawn ? { spawnFn: opts.acpSpawn } : {}),
    });
    return asked.ok ? { ok: true, text: asked.text, cutOff: false } : asked;
  }

  if (isClaudeCode(opts.baseUrl)) {
    const asked = await claudeCodeAsk({
      timeoutMs: limitMs,
      model: opts.model,
      systemPrompt: opts.system,
      prompt: opts.prompt,
      cwd: opts.cwd,
      sdk: opts.claudeCodeSdk,
    });
    return asked.ok ? { ok: true, text: asked.text, cutOff: false } : asked;
  }

  const f = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  try {
    const res = await f(`${base}/chat/completions`, {
      method: "POST",
      signal: probeSignal(limitMs),
      headers: { "content-type": "application/json", ...authHeaders(base, opts.apiKey) },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.prompt },
        ],
        max_tokens: maxTokens,
        temperature: 0,
        ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
      }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}${opts.what ? ` ${opts.what}` : ""}` };
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
    };
    return {
      ok: true,
      text: json.choices?.[0]?.message?.content ?? "",
      cutOff: json.choices?.[0]?.finish_reason === "length",
    };
  } catch (e) {
    return { ok: false, error: askError(e, limitMs, errorText) };
  }
}

/**
 * The JSON object in a reply, or null.
 *
 * Models fence their JSON whatever the instructions say, and sometimes
 * preface it. Anything before the first `{` and after the last `}` is
 * discarded; what is between them must parse.
 */
export function jsonIn(text: string): Record<string, unknown> | null {
  const body = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const raw: unknown = JSON.parse(body.slice(start, end + 1));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Why a reply could not be used, said the way the drafter always said it. */
export function notJson(text: string, cutOff: boolean, noun = "draft"): string {
  const said = text.trim().replace(/\s+/g, " ");
  return (
    `the ${noun} reply was not JSON, so nothing was proposed` +
    (cutOff ? " — it was cut off at the token limit" : "") +
    (said ? `: "${said.slice(0, 80)}${said.length > 80 ? "…" : ""}"` : ": the reply was empty")
  );
}
