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
