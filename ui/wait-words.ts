/**
 * Something to read while the model thinks.
 *
 * The clock is the honest signal — it says a request is in flight and how long
 * it has been. This is the other half: a minute of a motionless panel reads as
 * a broken one however accurate the seconds are.
 *
 * All of them describe *asking*, never concluding. A waiting label that said
 * "verifying" or "proving" would be the one kind of joke this tool cannot
 * make: nothing has been established while a question is still out.
 */
const IV_WORDS = [
  "picking nits",
  "looking for loopholes",
  "demanding receipts",
  "drafting hard questions",
  "rehearsing objections",
  "auditing the ask",
  "cross-examining",
  "hunting for wiggle room",
  "reading the small print",
  "shedding assumptions",
  "deciding what would count",
  "refusing to guess",
  "consulting the ledger",
  "weighing what proof looks like",
  "sharpening the bar",
  "being difficult on purpose",
] as const;

/** A different one from the one showing, so the label never appears stuck. */
export function nextWaitWord(current: string, pick = Math.random): string {
  const others = IV_WORDS.filter((w) => w !== current);
  return others[Math.floor(pick() * others.length)] ?? IV_WORDS[0];
}
