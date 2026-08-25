/**
 * The numbers both surfaces print.
 *
 * Lifted out of `banner.tsx` for the reason `banner-frames.ts` was: the window
 * needs them and cannot import a module that pulls in Ink to get them. The
 * status bar was formatting cost as `toFixed(4)` on its own — four decimals of
 * dollars, always — while the terminal used the rules below, so the same
 * session read `$0.4182` in one surface and `$0.42` in the other.
 *
 * Pure, and re-exported from `banner.tsx` so nothing that already imported
 * them has to move.
 */

export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1e6) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  // Context windows reach 1M, so sessions do too. "2400k" is arithmetic the
  // reader has to finish; "2.4M" is a number.
  const m = n / 1e6;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/**
 * Cost, in one unit, forever.
 *
 * Two rules, learned the hard way, and in tension:
 *
 * 1. No long runs of zeros. "$0.000024" has to be counted digit by digit
 *    before it means anything, and counting is what a glanceable meter must
 *    never require.
 * 2. Never change unit. A session meter that reads "0.9¢" and then "$0.029"
 *    looks like it went DOWN. Switching units to save a character makes the
 *    one number people quote back at each other unreadable as a series, which
 *    is worse than the zeros — the reader cannot tell rising from falling
 *    without doing arithmetic in their head.
 *
 * So: always dollars, three decimals at the most, and "under" below that.
 * The widest form is "$0.003"; a step too cheap to render at that precision
 * says "<$0.001" rather than claiming a false zero. Precision is spent on
 * the running totals, which is where it is read.
 */
export function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd >= 0.1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.001) return `$${usd.toFixed(3)}`;
  return "<$0.001";
}

/**
 * Elapsed time, at one significant unit.
 *
 * Precision drops as the number grows because the reason for reading it
 * changes: under a second you are asking "did that do anything?", over a
 * minute you are asking "should I stop this?". Neither question is answered
 * better by more digits, and a field that changes width makes the line
 * jitter on every tick.
 */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}
