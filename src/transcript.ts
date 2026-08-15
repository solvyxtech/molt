/**
 * Pure transcript logic: engine events → renderable lines.
 * No React, no I/O — fully unit-testable.
 */
import type { EngineEvent } from "./engine.js";

export type Line =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; detail: string; note?: string }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export const TRANSCRIPT_MAX_LINES = 500;

export function appendCapped(lines: Line[], next: Line): Line[] {
  const out = [...lines, next];
  return out.length > TRANSCRIPT_MAX_LINES
    ? out.slice(out.length - TRANSCRIPT_MAX_LINES)
    : out;
}

export function reduceEvent(lines: Line[], ev: EngineEvent): Line[] {
  switch (ev.kind) {
    case "assistant_text":
      return ev.text.trim()
        ? appendCapped(lines, { kind: "assistant", text: ev.text })
        : lines;
    case "tool":
      return appendCapped(lines, {
        kind: "tool",
        name: ev.name,
        detail: ev.detail,
        note: ev.note,
      });
    case "usage": {
      const cost =
        ev.costUsd !== undefined ? ` · $${ev.costUsd.toFixed(4)}` : "";
      return appendCapped(lines, {
        kind: "info",
        text: `✓ ${ev.promptTokens}→${ev.completionTokens} tok · session ${ev.sessionTokens}${cost}`,
      });
    }
    case "info":
      return appendCapped(lines, { kind: "info", text: ev.text });
    case "error":
      return appendCapped(lines, { kind: "error", text: ev.text });
    default:
      return lines; // future event kinds must never crash the UI
  }
}
