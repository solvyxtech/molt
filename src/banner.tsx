/**
 * molt's visual identity — deliberately anti-figlet.
 *
 * No block capitals. The word sits in a tidepool as four husked letters:
 *
 *     (m) (o) (l) (t)
 *
 * One husk splits every four frames. The letter never moves — only the
 * shell around it dissolves — and the cast husk leaves as a wavefront
 * that widens into an arc as it travels out and dissipates. When the
 * water settles, nothing is left but the word and the state of the
 * session:
 *
 *      m   o   l   t
 *      ollama · qwen2.5-coder-32b · 0 tok
 *      v0.5.0
 *
 * The settle line is live state, not marketing. It answers "am I pointed
 * at the right endpoint?" before you type — a question worth re-reading
 * every launch, which a tagline is not.
 *
 * 26 frames at 135 ms ≈ 3.5 s. Everything here is a character grid — no
 * capability a terminal lacks. Frame construction is pure and exported,
 * so it can be tested without mounting Ink.
 */
import { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin, useStdout } from "ink";
import type { Theme } from "./theme.js";

const WORD = "molt";

export const FRAME_MS = 135;
export const TOTAL_FRAMES = 26; // 26 × 135ms ≈ 3.5s
export const SETTLED_FRAME = TOTAL_FRAMES - 1;

/** Below this width the splash is replaced by a one-line wordmark. */
export const MIN_COLUMNS = 70;

const COLS = 60;
const ROWS = 7;
const MID = 3; // the waterline row the word sits on

/** Each letter owns a 3-cell husk plus one cell of gutter. Must stay >= 4. */
const SLOT = 4;
const FIELD = WORD.length * SLOT;
const ORIGIN = FIELD + 2; // husks are cast off just past the word
const TRAVEL = 3; // columns a wavefront moves per frame
const SHED_AT = [2, 6, 10, 14]; // frame each husk splits
const RIPPLE_LIFETIME = 10; // frames before a wavefront dissipates

/** Settle rows appear only after every wavefront has cleared their columns. */
const VERSION_AT = 21;

const SEP = " \u00b7 "; // middle dot, present in every modern terminal font

export type Tone = "accent" | "mid" | "dim" | "ghost";
export type Segment = { text: string; tone: Tone };

type Cell = { t: string; c: Tone };

export type SessionStatus = {
  /** Short endpoint name: "ollama", "openrouter", "groq", "local". */
  provider: string;
  model: string;
  sessionTokens: number;
  /** Undefined when no pricing is configured — omitted rather than faked. */
  costUsd?: number;
  /**
   * True when the cost rests on molt's own token estimate rather than the
   * provider's count. Rendered as a leading "~": a guess and a bill must
   * not look alike in the one field people quote back at each other.
   */
  costEstimated?: boolean;
  budgetTokens?: number;
  /** Model context window, when the endpoint reports one. */
  contextTokens?: number;
  /** Estimated outbound size of an in-flight request. */
  pendingEst?: number;
};

export type FrameOptions = {
  version?: string;
};

function fmtTokens(n: number): string {
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
 * Cost, in the unit that keeps it a number you can read at a glance.
 *
 * Small sums change unit rather than growing a run of zeros. "$0.000024"
 * has to be counted digit by digit before it means anything, and counting
 * is exactly what a glanceable meter must not require — so anything under a
 * cent is quoted in cents, where the same figure reads "0.0024¢" and the
 * common case reads "0.24¢".
 *
 * Two decimals in each unit is the whole precision budget. More digits
 * describe a number molt does not know that precisely anyway: the token
 * counts behind it are the provider's, but the rate is a published list
 * price that ignores per-account discounts.
 */
export function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3).replace(/0$/, "")}`;
  const cents = usd * 100;
  if (cents >= 0.01) return `${Number(cents.toFixed(2))}¢`;
  // Below a hundredth of a cent there is no honest short form. Say "under"
  // rather than round a real charge down to nothing.
  return "<0.01¢";
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

/**
 * Build the settle line. The model name carries the accent because it is
 * the field most worth scanning; everything else stays quiet so the word
 * remains the only bright thing on screen.
 *
 * The usage field is self-suppressing. A cold session has spent nothing,
 * and "0 tok" is dead weight that trains the eye to skip the whole line —
 * so it appears only once it says something:
 *
 *   in flight        ->  ~4.2k out
 *   budget set       ->  0/50k tok      (a ceiling is news at zero)
 *   context known    ->  32k ctx        (capacity, not consumption)
 *   tokens spent     ->  18.4k tok · $0.07
 *   nothing known    ->  omitted entirely
 */
export function statusSegments(s: SessionStatus, maxWidth = COLS): Segment[] {
  // No model selected yet: say so and point at the fix. Usage and cost are
  // withheld too — they describe a session that has not started, and a meter
  // reading 0 tokens against no model implies a connection molt has not made.
  // Same rule as costUsd: omitted rather than faked.
  if (!s.model) {
    return [
      { text: "no model", tone: "ghost" },
      { text: SEP, tone: "ghost" },
      { text: "/login", tone: "dim" },
    ];
  }

  const usage = (): string | null => {
    if (s.pendingEst) return `~${fmtTokens(s.pendingEst)} out`;
    if (s.budgetTokens)
      return `${fmtTokens(s.sessionTokens)}/${fmtTokens(s.budgetTokens)} tokens`;
    if (s.sessionTokens > 0) return `${fmtTokens(s.sessionTokens)} tokens`;
    if (s.contextTokens) return `${fmtTokens(s.contextTokens)} ctx`;
    return null;
  };

  const cost =
    s.costUsd === undefined || s.sessionTokens === 0
      ? null
      : `${s.costEstimated ? "~" : ""}${fmtCost(s.costUsd)}`;

  const tail = [usage(), cost].filter(Boolean).join(SEP);

  // Model names run long (qwen2.5-coder-32b-instruct-q4_K_M). The model
  // yields first, since provider and cost are short and non-negotiable.
  const seps = tail ? SEP.length * 2 : SEP.length;
  const room = Math.max(8, maxWidth - s.provider.length - seps - tail.length);
  const model =
    s.model.length > room ? s.model.slice(0, room - 2) + ".." : s.model;

  const segs: Segment[] = [
    { text: s.provider, tone: "dim" },
    { text: SEP, tone: "ghost" },
    { text: model, tone: "mid" },
  ];
  if (tail) {
    segs.push({ text: SEP, tone: "ghost" });
    segs.push({ text: tail, tone: "dim" });
  }
  return segs;
}

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
      grid[r][x] = { t: text[i], c: tone };
    }
  };

  // --- the word: letters pinned, husks dissolve around them ---
  for (let i = 0; i < WORD.length; i++) {
    const x = i * SLOT;
    if (frame >= SHED_AT[i]) {
      put(MID, x + 1, WORD[i], "accent");
    } else {
      // the husk tenses for one frame before it splits
      const tense = frame === SHED_AT[i] - 1;
      put(MID, x, "(", tense ? "mid" : "dim");
      put(MID, x + 1, WORD[i], tense ? "accent" : "mid");
      put(MID, x + 2, ")", tense ? "mid" : "dim");
    }
  }

  // --- wavefronts: one per cast husk, fading as they spread ---
  for (let k = 0; k < WORD.length; k++) {
    const age = frame - SHED_AT[k];
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
      if (row[i].t !== " ") {
        last = i;
        break;
      }
    }
    if (last < 0) return [];

    const segs: Segment[] = [];
    for (let i = 0; i <= last; i++) {
      const prev = segs[segs.length - 1];
      if (prev && row[i].c === prev.tone) prev.text += row[i].t;
      else segs.push({ text: row[i].t, tone: row[i].c });
    }
    return segs;
  });
}

/** One-line wordmark for narrow panes, non-TTY output, and `--no-splash`. */
export function compactFrame(): Segment[] {
  return [{ text: WORD, tone: "accent" }];
}

export function Banner({
  theme,
  themeName,
  animate = false,
  version,
}: {
  theme: Theme;
  themeName: string;
  animate?: boolean;
  version?: string;
}) {
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();

  const columns = stdout?.columns ?? 80;
  const isTTY = Boolean(stdout?.isTTY);
  const canAnimate = animate && isTTY && columns >= MIN_COLUMNS;

  const [frame, setFrame] = useState(canAnimate ? 0 : SETTLED_FRAME);
  const running = canAnimate && frame < SETTLED_FRAME;

  // Re-molt on launch and whenever the theme changes.
  useEffect(() => {
    if (!canAnimate) {
      setFrame(SETTLED_FRAME);
      return;
    }
    setFrame(0);
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      setFrame(n);
      if (n >= SETTLED_FRAME) clearInterval(id);
    }, FRAME_MS);
    return () => clearInterval(id);
  }, [canAnimate, themeName]);

  // Any key skips to the settled frame. Ceremony should never be a toll booth.
  useInput(() => setFrame(SETTLED_FRAME), {
    isActive: running && isRawModeSupported,
  });

  const color: Record<Tone, string> = {
    accent: theme.accent,
    mid: theme.accent,
    dim: theme.dim,
    ghost: theme.ghost,
  };

  if (columns < MIN_COLUMNS || !isTTY) {
    return (
      <Box>
        {compactFrame().map((s, i) => (
          <Text key={i} bold color={color[s.tone]}>
            {s.text}
          </Text>
        ))}
      </Box>
    );
  }

  const rows = buildFrame(frame, {
    version,
  });

  return (
    <Box flexDirection="column">
      {rows.map((segs, r) => (
        <Box key={r}>
          {segs.length === 0 ? (
            <Text> </Text>
          ) : (
            segs.map((s, i) => (
              <Text
                key={i}
                bold={s.tone === "accent"}
                dimColor={s.tone === "ghost"}
                color={color[s.tone]}
              >
                {s.text}
              </Text>
            ))
          )}
        </Box>
      ))}
    </Box>
  );
}
