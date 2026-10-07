/**
 * The judge: the model that drafts the hidden checks and reviews the claim.
 * By default it is the worker's own model. MAAT_JUDGE_MODEL (with optional
 * MAAT_JUDGE_URL / MAAT_JUDGE_KEY) moves it to a different model, so the
 * checks are not written with the same blind spots as the work they judge.
 */
import { expandEndpointShorthand } from "./endpoint.js";

export type Target = { baseUrl: string; apiKey?: string; model: string };

export function judgeTarget<T extends Target>(worker: T, env: NodeJS.ProcessEnv = process.env): T {
  const model = env.MAAT_JUDGE_MODEL?.trim();
  if (!model) return worker;
  const baseUrl = (env.MAAT_JUDGE_URL?.trim() && expandEndpointShorthand(env.MAAT_JUDGE_URL)) || worker.baseUrl;
  const apiKey =
    env.MAAT_JUDGE_KEY?.trim() ||
    (baseUrl === worker.baseUrl ? worker.apiKey : undefined) ||
    // A subscription worker (Grok Build, OpenCode) judged on OpenRouter uses the OpenRouter key.
    (/^https:\/\/openrouter\.ai\//.test(baseUrl) ? env.OPENROUTER_API_KEY?.trim() || undefined : undefined);
  const { apiKey: _workerKey, ...rest } = worker;
  return { ...rest, baseUrl, model, ...(apiKey !== undefined ? { apiKey } : {}) } as T;
}

/**
 * The judge's reasoning effort: MAAT_JUDGE_REASONING (none, minimal, low, ...) overrides the
 * effort the checks would otherwise be asked at. A reasoning judge bills its hidden thinking
 * as output; capped, a cheap judge stays cheap.
 */
export function judgeEffort(effort: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.MAAT_JUDGE_REASONING?.trim() || effort;
}
