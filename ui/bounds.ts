/**
 * Caps for surfaces that otherwise grow with the session.
 *
 * The wire view already drops frames past 600. The session stream and the
 * journal tab did not, so a long session paid for every earlier turn on every
 * paint and every filter keystroke.
 */
export const STREAM_CAP = 400;
export const JOURNAL_RENDER_CAP = 400;

/** Drop oldest children until `parent` holds at most `cap`. */
export function trimOldest(
  parent: {
    childElementCount: number;
    firstChild: unknown;
    removeChild: (n: never) => void;
  },
  cap: number,
): void {
  while (parent.childElementCount > cap && parent.firstChild) {
    parent.removeChild(parent.firstChild as never);
  }
}

/** The newest `cap` items. A long record is still on disk; this is the screen. */
export function newest<T>(rows: T[], cap: number): T[] {
  return rows.length <= cap ? rows : rows.slice(-cap);
}

/**
 * What the context meter fills against.
 *
 * The window the server named, if it has. A /budget the user set, if they
 * have. Zero otherwise — a percentage of a number we invented is how this
 * would lie, and OpenCode's "54% used" is only honest when the denominator
 * is real.
 */
export function contextCap(window: number, budget: number | null | undefined): number {
  if (window > 0) return window;
  if (budget && budget > 0) return budget;
  return 0;
}

/** 0..1, never NaN. */
export function contextFill(used: number, cap: number): number {
  if (!(used > 0) || !(cap > 0)) return 0;
  return Math.min(1, used / cap);
}
