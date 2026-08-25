/**
 * The splash, as a grid of characters.
 *
 * Split out of `banner.tsx` so it can be drawn by something that is not a
 * terminal. That file's own note said frame construction was pure and exported
 * "so it can be tested without mounting Ink" — the desktop window wants the
 * same thing for the same reason, and it cannot import a module that pulls in
 * Ink and React to get at it.
 *
 * Nothing here knows what it is drawn with. It returns rows of coloured runs;
 * the terminal paints them with Ink and the window paints them with spans, and
 * because both read these frames the two splashes are the same animation
 * rather than two drawings of one idea.
 */

export const WORD = "molt";

export const FRAME_MS = 135;
export const TOTAL_FRAMES = 26; // 26 × 135ms ≈ 3.5s
export const SETTLED_FRAME = TOTAL_FRAMES - 1;

/** Below this width the splash is replaced by a one-line wordmark. */
export const MIN_COLUMNS = 70;

export const COLS = 60;
export const ROWS = 7;
export const MID = 3; // the waterline row the word sits on

/** Each letter owns a 3-cell husk plus one cell of gutter. Must stay >= 4. */
export const SLOT = 4;
export const FIELD = WORD.length * SLOT;
export const ORIGIN = FIELD + 2; // husks are cast off just past the word
export const TRAVEL = 3; // columns a wavefront moves per frame
export const SHED_AT = [2, 6, 10, 14]; // frame each husk splits
export const RIPPLE_LIFETIME = 10; // frames before a wavefront dissipates

/** Settle rows appear only after every wavefront has cleared their columns. */
export const VERSION_AT = 21;

export type Tone = "accent" | "mid" | "dim" | "ghost";
export type Segment = { text: string; tone: Tone };

type Cell = { t: string; c: Tone };

export type FrameOptions = {
  version?: string;
};

/**
 * Build one frame as rows of colour-runs. Pure: same input, same output,
 * no clock and no terminal. Trailing whitespace is trimmed so we never
 * emit padding a terminal has to repaint.
 */
export function buildFrame(frame: number, opts: FrameOptions = {}): Segment[][] {
  const grid: Cell[][] = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => ({ t: " ", c: "ghost" as Tone })),
  );

  const put = (r: number, c: number, text: string, tone: Tone) => {
    if (r < 0 || r >= ROWS) return;
    for (let i = 0; i < text.length; i++) {
      const x = c + i;
      if (x < 0 || x >= COLS) continue;
      grid[r]![x] = { t: text[i]!, c: tone };
    }
  };

  // --- the word: letters pinned, husks dissolve around them ---
  for (let i = 0; i < WORD.length; i++) {
    const x = i * SLOT;
    if (frame >= SHED_AT[i]!) {
      put(MID, x + 1, WORD[i]!, "accent");
    } else {
      // the husk tenses for one frame before it splits
      const tense = frame === SHED_AT[i]! - 1;
      put(MID, x, "(", tense ? "mid" : "dim");
      put(MID, x + 1, WORD[i]!, tense ? "accent" : "mid");
      put(MID, x + 2, ")", tense ? "mid" : "dim");
    }
  }

  // --- wavefronts: one per cast husk, fading as they spread ---
  for (let k = 0; k < WORD.length; k++) {
    const age = frame - SHED_AT[k]!;
    if (age < 0 || age >= RIPPLE_LIFETIME) continue;

    const x0 = ORIGIN + age * TRAVEL;
    const half = Math.min(3, Math.floor(age * 0.75));
    const tone: Tone = age < 2 ? "mid" : age < 5 ? "dim" : "ghost";

    for (let dy = -half; dy <= half; dy++) {
      const x = x0 - Math.round(dy * dy * 0.7); // curvature: an arc, not a bar
      if (x < ORIGIN - 1 || x >= COLS) continue;
      put(MID + dy, x, ")", tone);
    }
  }

  // --- settle ---
  if (opts.version && frame >= VERSION_AT) put(MID + 2, 0, opts.version, "ghost");

  // --- compress each row to colour-runs, trimming the tail ---
  return grid.map((row) => {
    let last = -1;
    for (let i = row.length - 1; i >= 0; i--) {
      if (row[i]!.t !== " ") {
        last = i;
        break;
      }
    }
    if (last < 0) return [];

    const segs: Segment[] = [];
    for (let i = 0; i <= last; i++) {
      const prev = segs[segs.length - 1];
      if (prev && row[i]!.c === prev.tone) prev.text += row[i]!.t;
      else segs.push({ text: row[i]!.t, tone: row[i]!.c });
    }
    return segs;
  });
}

/** One-line wordmark for narrow panes, non-TTY output, and `--no-splash`. */
export function compactFrame(): Segment[] {
  return [{ text: WORD, tone: "accent" }];
}
