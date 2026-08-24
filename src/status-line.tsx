/**
 * The live meter.
 *
 * The banner is a splash — it scrolls away as soon as the transcript
 * grows, so it can only ever show cold-start facts. Anything that
 * changes during a session belongs here instead: a single persistent
 * row pinned below the transcript, above the prompt.
 *
 * Formatting is shared with the banner via statusSegments(), so the
 * settle line and the footer can never drift apart.
 */
 
import { Box, Text } from "ink";
import { statusSegments, type SessionStatus, type Tone } from "./banner.js";
import type { Theme } from "./theme.js";

/** Fraction of budget at which the meter starts warning. */
const PRESSURE_AT = 0.8;

export type StatusLineProps = {
  theme: Theme;
  status: SessionStatus;
  /** True while a request is in flight — drives the pending estimate. */
  busy?: boolean;
};

export function StatusLine({ theme, status, busy = false }: StatusLineProps) {
  const color: Record<Tone, string> = {
    accent: theme.accent,
    mid: theme.accent,
    dim: theme.dim,
    ghost: theme.ghost,
  };

  const segs = statusSegments({
    ...status,
    pendingEst: busy ? status.pendingEst : undefined,
  });

  // Budget pressure is the one thing allowed to shout. Everything else
  // on this row stays quiet so it can be ignored until it matters.
  const pressure =
    status.budgetTokens !== undefined &&
    status.sessionTokens / status.budgetTokens >= PRESSURE_AT;

  return (
    <Box>
      <Text color={color.ghost}>{busy ? "\u00b7 " : "  "}</Text>
      {segs.map((s, i) => (
        <Text
          key={i}
          color={pressure && s.tone === "dim" ? theme.warn : color[s.tone]}
          dimColor={s.tone === "ghost"}
        >
          {s.text}
        </Text>
      ))}
    </Box>
  );
}
