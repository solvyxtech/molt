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
import { fmtTokens, fmtCost } from "./format.js";
export { fmtTokens, fmtCost, fmtDuration } from "./format.js";
import {
  buildFrame,
  compactFrame,
  COLS,
  FRAME_MS,
  MIN_COLUMNS,
  SETTLED_FRAME,
  type Segment,
  type Tone,
} from "./banner-frames.js";

// The frame grid lives in `banner-frames.ts` so the desktop window can draw the
// same splash without importing Ink. Re-exported here because this file was the
// public face of all of it, and moving a file is not a reason to make every
// caller learn a new path.
export {
  buildFrame,
  compactFrame,
  FRAME_MS,
  MIN_COLUMNS,
  SETTLED_FRAME,
  TOTAL_FRAMES,
  WORD,
} from "./banner-frames.js";
export type { Tone, Segment, FrameOptions } from "./banner-frames.js";

const SEP = " \u00b7 "; // middle dot, present in every modern terminal font

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
  /**
   * How much molt is doing without asking.
   *
   * Sits beside the model because the two together are the answer to "what
   * is about to happen on my machine, and who said it could": a level is
   * only a control if it is visible while it is in force.
   */
  autonomy?: "low" | "medium" | "high";
  /**
   * What to do next when no model is selected. `/login` is right on a cold
   * start and wrong the moment a key exists — telling someone who just
   * authenticated to authenticate is the kind of small lie that makes a
   * status line stop being read.
   */
  hint?: string;
};

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
      { text: s.hint ?? "/login", tone: "dim" },
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
  const auto = s.autonomy ? `auto ${s.autonomy}`.length + SEP.length : 0;
  const seps = tail ? SEP.length * 2 : SEP.length;
  const room = Math.max(8, maxWidth - s.provider.length - seps - auto - tail.length);
  const model =
    s.model.length > room ? s.model.slice(0, room - 2) + ".." : s.model;

  const segs: Segment[] = [
    { text: s.provider, tone: "dim" },
    { text: SEP, tone: "ghost" },
    { text: model, tone: "mid" },
  ];
  if (s.autonomy) {
    segs.push({ text: SEP, tone: "ghost" });
    // High autonomy is the one state on this row worth catching your eye.
    segs.push({ text: `auto ${s.autonomy}`, tone: s.autonomy === "high" ? "accent" : "dim" });
  }
  if (tail) {
    segs.push({ text: SEP, tone: "ghost" });
    segs.push({ text: tail, tone: "dim" });
  }
  return segs;
}

export function Banner({
  theme,
  themeName,
  animate = false,
  version,
  onSettle,
}: {
  theme: Theme;
  themeName: string;
  animate?: boolean;
  version?: string;
  /**
   * Fired once the splash has stopped moving — by finishing, by a keypress,
   * or by never having animated at all. The caller needs it because a
   * transcript that never redraws cannot be printed above a picture that is
   * still changing.
   */
  onSettle?: () => void;
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

  useEffect(() => {
    if (frame >= SETTLED_FRAME) onSettle?.();
  }, [frame, onSettle]);

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
