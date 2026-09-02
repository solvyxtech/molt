/**
 * The commands that touch git, the clock, the map and the pins — written
 * once, for both surfaces.
 *
 * Every other command in this program exists twice: once in the terminal's
 * dispatcher and once in the window's. That duplication has produced the same
 * bug four times — an option wired into one surface and not the other, most
 * recently a "verify evidence chain" button over an engine that had no
 * ledger. These are the newest commands, so these are the ones that get to
 * start in one place: the terminal and the window both call these functions
 * and print what comes back.
 *
 * The reply shape is deliberately the smaller of the two surfaces' outcome
 * types, so neither has to translate.
 */
import type { Engine } from "./engine.js";
import { buildRepoMap, DEFAULT_MAP_TOKENS } from "./repomap.js";
import { isRepo, lastCommit, undoLast } from "./git.js";

export type CommandReply = { kind: "info" | "error"; text: string };

const ok = (text: string): CommandReply => ({ kind: "info", text });
const bad = (text: string): CommandReply => ({ kind: "error", text });

/**
 * A duration a person would type: `5m`, `90s`, `1h`, or a bare number of
 * seconds. Returns milliseconds, or null for "no limit".
 *
 * A bare number is seconds rather than milliseconds because nobody sets a
 * turn ceiling of 300ms, and reading `300` as milliseconds would silently
 * stop every turn instantly — a wrong unit that looks like a broken program.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s || s === "off" || s === "none" || s === "0") return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (m[2]) {
    case "ms":
      return Math.round(n);
    case "h":
    case "hr":
    case "hrs":
      return Math.round(n * 3_600_000);
    case "m":
    case "min":
    case "mins":
      return Math.round(n * 60_000);
    default:
      return Math.round(n * 1000);
  }
}

/**
 * A duration as it reads back to the person who set it.
 *
 * Sub-second budgets are only ever set by a test or a typo, but rounding one
 * to "0s" produces "time budget reached (0s of 0s)", which reads as a broken
 * program rather than as a very small limit doing exactly what it was told.
 */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms >= 3_600_000) {
    const h = ms / 3_600_000;
    return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
  }
  if (ms >= 60_000) {
    const m = ms / 60_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
  }
  return `${Math.round(ms / 1000)}s`;
}

/** `on`, `off`, or neither. */
export function parseToggle(arg: string): boolean | null {
  const s = arg.trim().toLowerCase();
  if (["on", "yes", "true", "1"].includes(s)) return true;
  if (["off", "no", "false", "0"].includes(s)) return false;
  return null;
}

/** `/for 5m` — a wall-clock ceiling for one turn. */
export function cmdFor(engine: Engine, arg: string): CommandReply {
  if (!arg.trim()) {
    const ms = engine.turnDeadlineMs;
    return ok(
      ms > 0
        ? `time budget ${fmtDuration(ms)} per turn — /for off removes it`
        : "no time budget. /for 5m gives each turn five minutes, then the bar judges whatever is there.",
    );
  }
  const ms = parseDuration(arg);
  if (ms === null && !["off", "none", "0"].includes(arg.trim().toLowerCase())) {
    return bad(`not a duration: ${arg} — try 30s, 5m, 1h, or off`);
  }
  engine.setTurnDeadline(ms ?? undefined);
  return ok(
    ms
      ? `time budget ${fmtDuration(ms)} per turn — when it is up the turn stops calling tools and the bar runs on what exists`
      : "time budget off",
  );
}

/** `/commit on` — keep what the bar verified. */
export function cmdCommit(engine: Engine, arg: string): CommandReply {
  const t = parseToggle(arg);
  if (t === null) {
    return ok(
      `commit on pass: ${engine.gitPolicy.commitOnPass ? "on" : "off"} — /commit on makes a ` +
        `verified change a commit, with the receipt named in the message`,
    );
  }
  engine.setGitPolicy({ commitOnPass: t });
  return ok(
    t
      ? "commit on pass: on — when the bar is met, the files this turn wrote are committed"
      : "commit on pass: off — nothing is committed for you",
  );
}

/** `/revert on` — discard what the bar refused. */
export function cmdRevert(engine: Engine, arg: string): CommandReply {
  const t = parseToggle(arg);
  if (t === null) {
    return ok(
      `revert on fail: ${engine.gitPolicy.restoreOnFail ? "on" : "off"} — /revert on puts the ` +
        `files back when the bar is not met`,
    );
  }
  engine.setGitPolicy({ restoreOnFail: t });
  return ok(
    t
      ? "revert on fail: on — a turn that does not meet the bar leaves the tree as it found it. The receipt still records what happened."
      : "revert on fail: off — a failed turn's files are left on disk",
  );
}

/** `/undo` — take back molt's last commit and keep the work. */
export async function cmdUndo(engine: Engine): Promise<CommandReply> {
  if (!(await isRepo(engine.cwd))) return bad("not a git repository — nothing to undo");
  const last = await lastCommit(engine.cwd);
  if (!last) return bad("no commits to undo");
  const r = await undoLast(engine.cwd);
  if (!r.ok) return bad(r.reason);
  return ok(
    `undid ${r.sha.slice(0, 8)} "${r.subject}" — the commit is gone, the changes are still in ` +
      `your working tree. Commit them yourself, or ask for another turn.`,
  );
}

/** `/read src/spec.md` — a file the model may read but never write. */
export function cmdRead(engine: Engine, arg: string): CommandReply {
  const s = arg.trim();
  if (!s) {
    const pinned = engine.readOnly;
    return ok(
      pinned.length
        ? `read-only (${pinned.length}): ${pinned.join(", ")} — /read clear releases them`
        : "no read-only files. /read <path> pins one: the model may read it, and any write to it is refused.",
    );
  }
  if (s === "clear" || s === "--clear" || s === "off") {
    const n = engine.clearReadOnly();
    return ok(n ? `released ${n} read-only file(s)` : "nothing was pinned");
  }
  const added = engine.addReadOnly(s.split(/[\s,]+/).filter(Boolean));
  return ok(
    added.length
      ? `read-only: ${added.join(", ")} — readable, and a write to any of them is refused`
      : "already read-only",
  );
}

/** `/map` — what the model was told about this repository. */
export async function cmdMap(engine: Engine, arg: string): Promise<CommandReply> {
  const s = arg.trim().toLowerCase();
  if (s === "off" || s === "none") {
    engine.setRepoMap("");
    return ok("repository map off — the next request drops it from the system prompt");
  }
  if (!s) {
    const map = engine.repoMap;
    return ok(
      map ? map : "no repository map. /map refresh builds one; /map 2000 builds a bigger one.",
    );
  }
  const budget = s === "refresh" || s === "rebuild" ? DEFAULT_MAP_TOKENS : Number(s);
  if (!Number.isFinite(budget) || budget <= 0) {
    return bad(`not a token budget: ${arg} — try /map refresh, /map 2000, or /map off`);
  }
  const built = await buildRepoMap(engine.cwd, { budgetTokens: budget });
  engine.setRepoMap(built.text);
  if (!built.shown) return ok("nothing to map here — no source files this map knows how to read");
  return ok(
    `mapped ${built.shown} file(s)${built.omitted ? `, ${built.omitted} not listed` : ""} · ` +
      `~${built.tokens} tokens · rebuilding the map resets the cached prompt prefix, so the ` +
      `next request pays for the prompt again`,
  );
}

/**
 * `/attempts 2` — completion attempts before a turn reports failure.
 *
 * `--attempts` existed for the terminal and nothing existed for the window:
 * a desktop session ran at the default with no way to change it. Written
 * once, here, for both.
 */
export function cmdAttempts(engine: Engine, arg: string): CommandReply {
  const s = arg.trim();
  if (!s) {
    return ok(
      `${engine.maxProofAttempts} completion attempt(s) per turn — /attempts <n> changes it; each ` +
        `refused attempt runs the whole bar again`,
    );
  }
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) return bad(`not an attempt count: ${arg} — a whole number of 1 or more`);
  engine.setMaxProofAttempts(n);
  return ok(`${n} completion attempt(s) per turn`);
}

/** `/autoshed 30000` — shed once working history exceeds that many tokens; `off` disables. */
export function cmdAutoShed(engine: Engine, arg: string): CommandReply {
  const s = arg.trim().toLowerCase();
  if (!s) {
    const at = engine.autoShedAtTokens;
    return ok(
      at > 0
        ? `auto-shed above ${at} tokens of history — /autoshed <tokens> moves it, /autoshed off disables it`
        : "auto-shed off — history is never compacted unless you /shed",
    );
  }
  if (s === "off" || s === "0" || s === "none") {
    engine.setAutoShed(0);
    return ok("auto-shed off");
  }
  const n = Number(s.replace(/[_,]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return bad(`not a token count: ${arg} — try /autoshed 30000 or /autoshed off`);
  engine.setAutoShed(n);
  return ok(`auto-shed above ${Math.floor(n)} tokens of history — the full record is archived, never summarized`);
}
