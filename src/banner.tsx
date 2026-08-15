/**
 * molt's visual identity — deliberately anti-figlet.
 *
 * No block capitals. The banner is the lowercase word husked in dim
 * parentheses: (m)(o)(l)(t). On launch — and on every /molt — the husks
 * shed one letter at a time and drift right, ending as ripples:
 *
 *     molt ))))
 *
 * The discarded shells ARE the tidepool ripples. Name, theme, and
 * mechanic in nine characters.
 */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { Theme } from "./theme.js";

const WORD = "molt";
export const FRAME_MS = 120;
/** Total frames: one per letter shed, plus the settled state. */
export const TOTAL_FRAMES = WORD.length + 1;

export function bannerFrame(shedCount: number): {
  segments: { text: string; role: "letter" | "husk" | "ripple" }[];
} {
  const segs: { text: string; role: "letter" | "husk" | "ripple" }[] = [];
  for (let i = 0; i < WORD.length; i++) {
    if (i < shedCount) {
      segs.push({ text: WORD[i], role: "letter" });
    } else {
      segs.push({ text: `(${WORD[i]})`, role: "husk" });
    }
  }
  if (shedCount > 0) {
    segs.push({ text: " " + ")".repeat(shedCount), role: "ripple" });
  }
  return { segments: segs };
}

export function Banner({
  theme,
  themeName,
  animate = false,
}: {
  theme: Theme;
  themeName: string;
  animate?: boolean;
}) {
  const [shed, setShed] = useState(animate ? 0 : WORD.length);

  // Re-molt whenever the theme changes.
  useEffect(() => {
    if (!animate) {
      setShed(WORD.length);
      return;
    }
    setShed(0);
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      setShed(n);
      if (n >= WORD.length) clearInterval(t);
    }, FRAME_MS);
    return () => clearInterval(t);
  }, [animate, themeName]);

  const { segments } = bannerFrame(shed);
  return (
    <Box>
      {segments.map((s, i) => (
        <Text
          key={i}
          bold={s.role === "letter"}
          color={s.role === "letter" ? theme.accent : theme.dim}
        >
          {s.text}
        </Text>
      ))}
    </Box>
  );
}
