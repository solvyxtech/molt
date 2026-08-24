/**
 * Themes. Cyan by default and deliberately not any vendor's brand colour —
 * molt should never look like it is pretending to be someone else's tool.
 */
export type Theme = {
  accent: string;
  dim: string;
  ghost: string;
  warn: string;
  ok: string;
  fail: string;
  text: string;
  /**
   * The larger surfaces a window needs and a terminal does not.
   *
   * Optional, because the TUI paints on whatever background the terminal
   * already has and has never needed them. The desktop does: without these it
   * wrote tidepool's backgrounds as literals in the stylesheet, so choosing
   * another theme recoloured the text and left the window blue underneath.
   * A theme that omits them has them derived from `ghost`.
   */
  surfaces?: {
    bg: string;
    bgRaised: string;
    bgSunken: string;
    lineSoft: string;
  };
};

export const THEMES: Record<string, Theme> = {
  tidepool: {
    accent: "#6FE9F7",
    dim: "#17677A",
    ghost: "#0E3744",
    warn: "#D89A3F",
    ok: "#5FD3A0",
    fail: "#E06C68",
    text: "#BDD6DD",
    surfaces: {
      bg: "#05171D",
      bgRaised: "#08222B",
      bgSunken: "#041219",
      lineSoft: "#0A2A35",
    },
  },
  brackish: {
    accent: "#7FD4A8",
    dim: "#2F6B54",
    ghost: "#17392D",
    warn: "#D8B84F",
    ok: "#7FD4A8",
    fail: "#E08A78",
    text: "#C4DCCE",
  },
  slate: {
    accent: "#A8C4DE",
    dim: "#4A6076",
    ghost: "#26333F",
    warn: "#D2A56B",
    ok: "#93C7A4",
    fail: "#D98A8A",
    text: "#C6D3DD",
  },
  mono: {
    accent: "#FFFFFF",
    dim: "#8A8A8A",
    ghost: "#4A4A4A",
    warn: "#BDBDBD",
    ok: "#E0E0E0",
    fail: "#FFFFFF",
    text: "#D0D0D0",
  },
};

export const DEFAULT_THEME = "tidepool";

export function themeNames(): string[] {
  return Object.keys(THEMES);
}

export function getTheme(name: string): Theme {
  return THEMES[name] ?? THEMES[DEFAULT_THEME];
}

/** Cycle to the next theme — backs `/molt`. */
export function nextTheme(current: string): string {
  const names = themeNames();
  const i = names.indexOf(current);
  return names[(i + 1) % names.length];
}
