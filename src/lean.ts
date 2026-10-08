/**
 * Lean-sessions prototypes: env flags only, every one off by default.
 *
 * These are measured in test/lean-sessions.test.ts and written up in
 * reports/lean-sessions-study.md. None of them changes a default; each is a
 * candidate for one, kept switchable so the suite and the bench can compare
 * a session with and without it.
 *
 *   MAAT_LEAN_SHED_AT=<tokens>     auto-shed threshold when none is configured
 *                                  (default 60,000)
 *   MAAT_LEAN_SHED_MINFREE=<0..1>  a shed cut on user turns must free this
 *                                  share of the history, or it cuts on recent
 *                                  messages instead
 *   MAAT_LEAN_AGE=1 | k=v,...      age older tool results (see AgingOpts):
 *                                  keep, min, batch, head, tail, argmin, at
 *   MAAT_LEAN_AGE_ARGS=1           with MAAT_LEAN_AGE, age long tool-call
 *                                  arguments too
 *   MAAT_LEAN_SUPERSEDE=1          elide per call (not per step), and treat a
 *                                  bash rerun with new output, or a plain
 *                                  `cat`/`sed -n` of a file written since, as
 *                                  superseded
 */
import { env } from "./env.js";
import type { AgingOpts } from "./transcript.js";

const on = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

export function leanShedAt(): number | undefined {
  const n = Number(env("LEAN_SHED_AT"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function leanShedMinFree(): number {
  const n = Number(env("LEAN_SHED_MINFREE"));
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 0;
}

export function leanSupersede(): boolean {
  return on(env("LEAN_SUPERSEDE"));
}

export const AGING_DEFAULTS: AgingOpts = {
  keep: 6,
  minChars: 1_500,
  batchChars: 24_000,
  head: 600,
  tail: 300,
  args: false,
  argMinChars: 1_000,
  atTokens: 0,
};

export function leanAging(): AgingOpts | null {
  const raw = env("LEAN_AGE");
  if (!on(raw)) return null;
  const o: AgingOpts = { ...AGING_DEFAULTS, args: on(env("LEAN_AGE_ARGS")) };
  const keys: Record<string, keyof AgingOpts> = { keep: "keep", min: "minChars", batch: "batchChars", head: "head", tail: "tail", argmin: "argMinChars", at: "atTokens" };
  for (const part of raw!.split(",")) {
    const [k, v] = part.split("=");
    const key = keys[(k ?? "").trim()];
    const n = Number(v);
    if (key && Number.isFinite(n) && n >= 0) (o as Record<string, number | boolean>)[key] = Math.floor(n);
  }
  return o;
}
