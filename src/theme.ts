/**
 * Theming is molt's core mechanic. A theme is one flat object; every color
 * in the UI resolves through it. Themes can be switched live with
 * `/molt <name>` or overridden entirely by ~/.config/molt/theme.json.
 */
export type Theme = {
  accent: string;
  user: string;
  assistant: string;
  tool: string;
  error: string;
  warn: string;
  dim: string;
};

export const THEMES: Record<string, Theme> = {
  /** Default: light blue / cyan. Deliberately not Anthropic-orange. */
  tidepool: {
    accent: "#7dd3fc",
    user: "#22d3ee",
    assistant: "white",
    tool: "#94a3b8",
    error: "#f87171",
    warn: "#fbbf24",
    dim: "gray",
  },
  ember: {
    accent: "#f97316",
    user: "#22d3ee",
    assistant: "white",
    tool: "#a3a3a3",
    error: "#ef4444",
    warn: "#eab308",
    dim: "gray",
  },
  mantis: {
    accent: "#4ade80",
    user: "#a3e635",
    assistant: "white",
    tool: "#9ca3af",
    error: "#f87171",
    warn: "#facc15",
    dim: "gray",
  },
  mono: {
    accent: "white",
    user: "white",
    assistant: "white",
    tool: "gray",
    error: "white",
    warn: "white",
    dim: "gray",
  },
};

export const DEFAULT_THEME = "tidepool";

/** Merge a partial user-supplied theme over a base; ignores junk keys. */
export function resolveCustomTheme(raw: unknown, base: Theme): Theme {
  if (!raw || typeof raw !== "object") return base;
  const out = { ...base };
  for (const k of Object.keys(base) as (keyof Theme)[]) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "string" && v.length > 0 && v.length < 32) out[k] = v;
  }
  return out;
}

export const TAGLINE = "same engine · shed the stock shell";
