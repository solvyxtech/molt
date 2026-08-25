/**
 * The options `session:run` hands the engine.
 *
 * Built here rather than inline in the handler so that "the window offers to
 * carry on past the ceiling" is a claim a test can check. It was not true
 * before: `onCeiling` was wired in the TUI only, and the comment there said it
 * is offered "where a person is watching" — which the desktop window plainly
 * is. The window had simply been missed.
 *
 * What that cost, from a real session: the model was eight steps into
 * diagnosing a genuine bug when it hit step 32, and the turn ended with a
 * salvage. Every token spent reaching that point bought nothing, and the
 * person watching was never asked whether to continue. Stopping dead at a
 * ceiling is the most expensive outcome there is — the money is already spent,
 * and ending there turns it into nothing.
 */
import { taskChecksFrom } from "./criteria.js";

export type Confirm = (name: string, detail: string) => Promise<boolean>;

/**
 * What the window asks when the engine reaches a ceiling.
 *
 * The numbers come from the engine and are shown unedited: this is a spending
 * decision, and a prompt that hides the amount is asking for a signature on a
 * blank cheque.
 */
export function ceilingAsk(spent: string, maxSteps: number): { name: string; detail: string } {
  return {
    name: "keep going past the ceiling?",
    detail:
      `${spent}. Stopping keeps everything done so far and writes the receipt. ` +
      `Continuing allows another ${maxSteps} steps before molt asks again.`,
  };
}

export function runOptions(opts: {
  ask: boolean;
  criteria: unknown;
  confirm: Confirm;
  maxSteps: number;
}): {
  ask: boolean;
  taskChecks: ReturnType<typeof taskChecksFrom>["taskChecks"];
  taskNotes: string[];
  onCeiling: (spent: string) => Promise<boolean>;
} {
  const { taskChecks, taskNotes } = taskChecksFrom(opts.criteria);
  return {
    ask: opts.ask,
    taskChecks,
    taskNotes,
    onCeiling: (spent: string) => {
      const { name, detail } = ceilingAsk(spent, opts.maxSteps);
      return opts.confirm(name, detail);
    },
  };
}

/**
 * Whether to ask the endpoint what it charges, before starting a turn.
 *
 * Pricing was resolved exactly once, at session open, and not awaited. When
 * that single request failed the session ran to completion with no meter:
 * 4.8M tokens against a provider that does publish rates, every step logged
 * `costUsd: null`, and nothing ever said the money column was missing rather
 * than zero. A blip at open should not cost a whole session's accounting.
 *
 * One request per turn is nothing beside the turn, so the cheap fix is to keep
 * asking while the answer is unknown. What must not repeat is the *message*:
 * an endpoint that genuinely publishes no prices — anything self-hosted —
 * would otherwise say so before every turn.
 */
export function shouldRefreshPrice(opts: {
  /** The rate the engine currently holds, if any. */
  priceIn: number | undefined;
  model: string;
  /** The model a "no price published" message has already been shown for. */
  announcedNoPriceFor: string | null;
}): { refresh: boolean; announce: boolean } {
  if (opts.priceIn !== undefined) return { refresh: false, announce: false };
  return { refresh: true, announce: opts.announcedNoPriceFor !== opts.model };
}
