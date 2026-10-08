/**
 * The judge's meter: every out-of-loop ask, counted and priced.
 *
 * The worker's own requests have always been metered step by step. The asks
 * made around the work were not: drafting the hidden checks, the critic that
 * reads the draft, the reference check, the independent review, the post-work
 * audit and the dispute arbiter. With a separate judge model (MAAT_JUDGE_MODEL)
 * those asks go to a different model, often on a different provider, and a
 * bench run could only estimate what they cost; the exact figure was visible
 * only in the provider's console. Every token spent should be visible here.
 *
 * Each ask that returns records what the provider reported (input, output,
 * cache read and cache write tokens, and a billed dollar figure when the
 * provider sends one). It is priced with the same table as the worker
 * (providers.ts), keyed on the judge's own model id. A model with no known
 * price reports its tokens and "$ unknown", never $0: an unpriced judge
 * looking free is the confidently wrong meter the worker's pricing already
 * refuses to be. A subscription backend (Grok Build, OpenCode) is paid by its
 * plan and gets no dollar figure, as on the worker side.
 *
 * Kept apart from the worker's meter on purpose. The worker's tokens are what
 * the lean-budget suite measures and what the step lines report; the judge's
 * are a separate line on every surface, and both count toward a budget.
 */
import { anthropicPricing, planFor, type Pricing } from "./providers.js";

/** What one ask used, as the ask path read it from the reply. */
export type AskUsage = {
  baseUrl: string;
  model: string;
  /** What was being asked ("drafting criteria", "reviewing the claim"). */
  what?: string;
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's cache, when it itemises them. */
  cacheReadTokens?: number;
  /** Prompt tokens written to the provider's cache, when it reports them. */
  cacheWriteTokens?: number;
  /** USD, when the provider reported the figure itself (OpenRouter's `usage.cost`). */
  billedUsd?: number;
  /** True when the provider reported no usage and the counts are Maat's estimate. */
  estimated: boolean;
};

/** Anything an ask can report its usage to. */
export interface AskMeter {
  record(u: AskUsage): void;
}

/** The judge's spend over some span of calls. */
export type JudgeSpend = {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * USD, or undefined when it is not known: some call's model has no price.
   * Never 0 for unknown. Calls paid by a subscription plan add nothing.
   */
  costUsd?: number;
  /** Calls whose model had no price and no billed figure. */
  unpricedCalls: number;
  /** The models those calls went to. */
  unpricedModels?: string[];
  /** Calls paid for by a subscription plan, by the plan's name. */
  plan?: string;
  /** True when any call's counts are Maat's estimate. */
  estimated: boolean;
  /** True when every priced call's dollar figure came from the provider. */
  billed: boolean;
  /** The models asked, in the order first seen. */
  models: string[];
};

/** The worker's pricing, for a judge that is the worker's own model. */
export type WorkerPricing = { baseUrl: string; model: string; pricing: Pricing | null; plan?: string };

/** A call as recorded, with what it cost when it was recorded. */
export type JudgeCall = AskUsage & { costUsd?: number; plan?: string };

function key(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/+$/, "")} ${model}`;
}

function anthropicHost(baseUrl: string): boolean {
  try {
    return /anthropic\.com$/.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** USD for these tokens at this price; cached tokens are inside `prompt`. */
export function priceTokens(p: Pricing, u: Pick<AskUsage, "promptTokens" | "completionTokens" | "cacheReadTokens">): number {
  // As the worker's meter: cached prompt tokens at the cache rate when one is
  // published, the rest of the prompt (cache writes included) at the base rate.
  const cached = p.cached === undefined ? 0 : Math.min(u.cacheReadTokens ?? 0, u.promptTokens);
  const fresh = u.promptTokens - cached;
  return (fresh / 1e6) * p.in + (cached / 1e6) * (p.cached ?? p.in) + (u.completionTokens / 1e6) * p.out;
}

export class JudgeMeter implements AskMeter {
  private readonly calls: JudgeCall[] = [];
  private readonly prices = new Map<string, Pricing | null>();
  private readonly listeners: ((c: JudgeCall) => void)[] = [];

  /**
   * @param worker The worker's endpoint, model and prices, read when needed: a
   * judge that is the worker's own model is priced exactly as the worker is,
   * hand-set prices included.
   */
  constructor(private readonly worker?: () => WorkerPricing) {}

  /** Set the price of a judge model, as resolved from its provider (or null: none published). */
  setPricing(baseUrl: string, model: string, p: Pricing | null): void {
    this.prices.set(key(baseUrl, model), p);
  }

  /** Has a price lookup already been made for this model? */
  hasPricing(baseUrl: string, model: string): boolean {
    return this.prices.has(key(baseUrl, model));
  }

  /**
   * The price of one judge model, or null when none is known.
   *
   * A price set for this endpoint and model wins. Then the worker's own prices,
   * when the judge is the worker's model on the worker's endpoint. Then the
   * published Anthropic rates, on Anthropic's API (the table fetchPricing reads
   * there). Nothing else is guessed.
   */
  pricingFor(baseUrl: string, model: string): Pricing | null {
    const set = this.prices.get(key(baseUrl, model));
    if (set !== undefined) return set;
    const w = this.worker?.();
    if (w && key(w.baseUrl, w.model) === key(baseUrl, model)) return w.pricing;
    if (anthropicHost(baseUrl)) return anthropicPricing(model);
    return null;
  }

  /** The subscription plan that pays for asks on this endpoint, if any. */
  private planOf(baseUrl: string): string | undefined {
    return planFor(baseUrl);
  }

  /** Called with every call as it is recorded (the journal's `judge_usage`). */
  onRecord(fn: (c: JudgeCall) => void): void {
    this.listeners.push(fn);
  }

  record(u: AskUsage): void {
    const c = this.priced(u);
    this.calls.push(c);
    for (const fn of this.listeners) {
      try {
        fn(c);
      } catch {
        /* a listener that throws must not lose the record */
      }
    }
  }

  private priced(u: AskUsage): JudgeCall {
    const plan = this.planOf(u.baseUrl);
    if (plan) return { ...u, plan };
    if (typeof u.billedUsd === "number") return { ...u, costUsd: u.billedUsd };
    const p = this.pricingFor(u.baseUrl, u.model);
    return p ? { ...u, costUsd: priceTokens(p, u) } : { ...u };
  }

  /** How many calls have been recorded: a mark to take `since` from. */
  mark(): number {
    return this.calls.length;
  }

  /** Every call recorded, in order. */
  all(): readonly JudgeCall[] {
    return this.calls;
  }

  /** The whole session's judge spend. */
  total(): JudgeSpend {
    return this.since(0);
  }

  /**
   * The judge's spend since a mark. Priced now, not when recorded, so a price
   * that arrived after the first ask (a lookup still in flight, a /price) is
   * applied to every call, as the worker's meter does.
   */
  since(mark: number): JudgeSpend {
    const span = this.calls.slice(mark).map((c) => this.priced(c));
    const models: string[] = [];
    let cost = 0;
    let unpriced = 0;
    const unpricedModels: string[] = [];
    let billedAll = true;
    let pricedAny = false;
    let plan: string | undefined;
    for (const c of span) {
      if (!models.includes(c.model)) models.push(c.model);
      if (c.plan) {
        plan = c.plan;
        continue;
      }
      if (c.costUsd === undefined) {
        unpriced += 1;
        if (!unpricedModels.includes(c.model)) unpricedModels.push(c.model);
        continue;
      }
      pricedAny = true;
      cost += c.costUsd;
      if (typeof c.billedUsd !== "number") billedAll = false;
    }
    return {
      calls: span.length,
      promptTokens: span.reduce((n, c) => n + c.promptTokens, 0),
      completionTokens: span.reduce((n, c) => n + c.completionTokens, 0),
      cacheReadTokens: span.reduce((n, c) => n + (c.cacheReadTokens ?? 0), 0),
      cacheWriteTokens: span.reduce((n, c) => n + (c.cacheWriteTokens ?? 0), 0),
      // Unknown if any call is unknown: a partial sum would read as the whole.
      // Plan-paid calls cost no money, so a span of only those has no figure.
      ...(unpriced === 0 && pricedAny ? { costUsd: cost } : {}),
      unpricedCalls: unpriced,
      ...(unpricedModels.length ? { unpricedModels } : {}),
      ...(plan ? { plan } : {}),
      estimated: span.some((c) => c.estimated),
      billed: pricedAny && billedAll,
      models,
    };
  }
}

/** Tokens a judge spend counts toward a budget: everything sent and received. */
export function judgeTokens(s: JudgeSpend | undefined): number {
  return s ? s.promptTokens + s.completionTokens : 0;
}

/** Said in one line by format.ts, which the renderer can import. */
export { judgeSpendLine } from "./format.js";
