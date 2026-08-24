/**
 * The surfaces the window paints, for whichever theme is chosen.
 *
 * `getTheme()` returns seven colours — accent, dim, ghost, warn, ok, fail,
 * text. The stylesheet needed more than that to draw a desktop: a page
 * background, a raised strip for the chrome, a sunken one for panels, and two
 * weights of rule. Those five were written as literals in tidepool's palette
 * and never moved again, so choosing `mono` or `slate` recoloured the accent
 * and the text and left the window tidepool-blue underneath.
 *
 * They live on the theme now. `desktopSurfaces` reads them, and derives them
 * for any theme that does not carry them, so a theme added later is never
 * silently half-applied.
 */
import type { Theme } from "../src/theme.js";

export type Surfaces = {
  bg: string;
  bgRaised: string;
  bgSunken: string;
  line: string;
  lineSoft: string;
};

/** Scale every channel of #rrggbb by `f`, clamped to a byte. */
function shade(hex: string, f: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.max(0, Math.min(255, Math.round(c * f))),
  );
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export function desktopSurfaces(theme: Theme): Surfaces {
  return {
    // The rules are the theme's own ghost, which is what they always were —
    // tidepool's #0E3744 was simply spelled out twice.
    line: theme.ghost,
    lineSoft: theme.surfaces?.lineSoft ?? shade(theme.ghost, 0.72),
    bg: theme.surfaces?.bg ?? shade(theme.ghost, 0.42),
    bgRaised: theme.surfaces?.bgRaised ?? shade(theme.ghost, 0.6),
    bgSunken: theme.surfaces?.bgSunken ?? shade(theme.ghost, 0.34),
  };
}
