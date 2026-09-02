/**
 * Spec-first must not start the turn.
 *
 * The first Run writes a spec (interview + criteria) and holds. The second
 * Run seals what is still in the panel and starts work. Ask-only, a panel
 * the person already filled, and a resume after that hold skip it — there
 * is nothing new to review, or they already reviewed it.
 */
export function holdAfterAutoDraft(opts: {
  auto: boolean;
  hadRows: boolean;
  ask: boolean;
  drafted?: boolean;
  resuming?: boolean;
}): boolean {
  return opts.auto && !opts.hadRows && !opts.ask && !opts.resuming;
}

/**
 * Which text a Run acts on.
 *
 * The hold made the first Run of every turn look like a failed one: the
 * composer still held what you typed, because the clear happened after the
 * early return. Keeping the text was not wrong — the second Run needs it —
 * but keeping it *in the box* says "not sent" about a message that was
 * received and acted on.
 *
 * So the box is cleared and the text is held here instead. Anything typed
 * since wins: a person who edits the composer during the review has changed
 * their mind, and the words in front of them must be the words that run.
 */
export function taskForRun(
  typed: string,
  pending: string | null,
): { text: string; resuming: boolean } {
  const t = typed.trim();
  if (t.length > 0) return { text: t, resuming: false };
  if (pending && pending.trim().length > 0) return { text: pending.trim(), resuming: true };
  return { text: "", resuming: false };
}
