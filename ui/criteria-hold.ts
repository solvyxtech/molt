/**
 * Auto-draft must not start the turn.
 *
 * A drafted `run` is a process, not a stricter boolean. The first Run fills
 * the panel; the second Run seals what is still there. Ask-only and a panel
 * the person already filled skip the hold — there is nothing new to review.
 */
export function holdAfterAutoDraft(opts: {
  auto: boolean;
  hadRows: boolean;
  ask: boolean;
  drafted: boolean;
}): boolean {
  return opts.auto && !opts.hadRows && !opts.ask && opts.drafted;
}
