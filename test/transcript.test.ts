import { describe, it, expect } from "vitest";
import {
  reduceEvent,
  appendCapped,
  TRANSCRIPT_MAX_LINES,
  type Line,
} from "../src/transcript.js";
import type { EngineEvent } from "../src/engine.js";
import { resolveCustomTheme, THEMES } from "../src/theme.js";
import { bannerFrame } from "../src/banner.js";

describe("reduceEvent", () => {
  it("maps engine events to lines", () => {
    let lines: Line[] = [];
    lines = reduceEvent(lines, { kind: "assistant_text", text: "hi" });
    lines = reduceEvent(lines, { kind: "tool", name: "bash", detail: "ls", note: "denied" });
    lines = reduceEvent(lines, { kind: "usage", promptTokens: 10, completionTokens: 5, sessionTokens: 15, costUsd: 0.01 });
    expect(lines).toEqual([
      { kind: "assistant", text: "hi" },
      { kind: "tool", name: "bash", detail: "ls", note: "denied" },
      { kind: "info", text: "✓ 10→5 tok · session 15 · $0.0100" },
    ]);
  });

  it("skips empty text and never throws on unknown kinds (fuzz)", () => {
    let lines: Line[] = [];
    lines = reduceEvent(lines, { kind: "assistant_text", text: "  " });
    expect(lines).toEqual([]);
    const hostile = [{ kind: "hologram" }, { kind: "usage" }, {}, { kind: "tool" }];
    for (const ev of hostile) {
      expect(() => {
        lines = reduceEvent(lines, ev as EngineEvent);
      }).not.toThrow();
    }
  });

  it("caps transcript under sustained load", () => {
    let lines: Line[] = [];
    for (let i = 0; i < 5000; i++) {
      lines = appendCapped(lines, { kind: "info", text: `l${i}` });
    }
    expect(lines.length).toBe(TRANSCRIPT_MAX_LINES);
  });
});

describe("resolveCustomTheme", () => {
  it("merges partials and rejects junk", () => {
    const base = THEMES.tidepool;
    expect(resolveCustomTheme({ accent: "#123456" }, base).accent).toBe("#123456");
    expect(resolveCustomTheme(null, base)).toEqual(base);
    expect(resolveCustomTheme({ accent: 42 }, base)).toEqual(base);
    expect(resolveCustomTheme({ accent: "x".repeat(64) }, base).accent).toBe(base.accent);
  });
});

describe("bannerFrame", () => {
  it("sheds husks into ripples", () => {
    expect(bannerFrame(0).segments.map(s => s.text).join("")).toBe("(m)(o)(l)(t)");
    expect(bannerFrame(2).segments.map(s => s.text).join("")).toBe("mo(l)(t) ))");
    expect(bannerFrame(4).segments.map(s => s.text).join("")).toBe("molt ))))");
  });
});
