/**
 * The bar: what "done" means, as a file.
 *
 * `.molt/done.yml` is a committed, versioned artifact listing the checks a
 * task must satisfy before molt is allowed to emit a final answer. It is
 * ordinary shell commands plus a small number of builtins that only molt
 * can run, because only molt still has the full session record.
 *
 * Nothing here asks a model anything. A bar result is an exit code.
 */
import { runCommand } from "./run.js";
import { parseLcov, coverageFor, unprovenIn, type Unproven } from "./coverage.js";
import { planMutations, applyMutation, type Mutation } from "./mutate.js";
import { proposeBar, type Detected } from "./detect.js";
import { assertionsIn, fingerprint, isTestPath, treeChanges, type TreeSnapshot } from "./files.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ArchiveLike } from "./archive.js";
import type {
  Bar,
  BarResult,
  BuiltinCheck,
  Check,
  CheckResult,
  LedgerEntry,
  Msg,
} from "./types.js";

export const BAR_FILENAME = "done.yml";
export const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * How much of a failing command's output the model is given.
 *
 * 2000 was not enough to hold a node:test failure summary once the head is
 * kept as well, and this is the one string in the program whose whole job is
 * to tell a model what to fix.
 */
const OUTPUT_MAX = 4000;

export const BUILTINS: BuiltinCheck[] = [
  "files-changed",
  "record-intact",
  "claims-grounded",
  "spec-intact",
  "tree-accounted",
  "diff-covered",
  "mutation",
];

/**
 * Conventional tags. Not enforced — a bar may use any label — but these are
 * the ones molt's own flags understand, and the ones worth standardising on
 * if other harnesses ever read this file.
 */
export const CONVENTIONAL_TAGS = ["fast", "slow", "ci", "local", "manual"] as const;

export class BarError extends Error {}

export type BarContext = {
  cwd: string;
  /** Kills the running check when it aborts, so ctrl+C can stop a long suite. */
  signal?: AbortSignal;
  /** Full session record, including everything shed. */
  record: Msg[];
  /** Every path the model read this session. Reading grounds a reference. */
  read?: string[];
  /** Reuses a check result while the files it watches have not moved. */
  cache?: CheckCache;
  /**
   * Every write this project can still prove: live memory plus everything
   * recovered from the archive. After a shed, entries for early work exist
   * ONLY in the archive, so this is the merged view checks must use.
   */
  ledger: LedgerEntry[];
  /** Only what is still in memory. Used to detect evidence lost with a shed. */
  liveLedger?: LedgerEntry[];
  /**
   * The subset of `ledger` this TURN wrote.
   *
   * The session ledger is the right thing to judge — a write shed three
   * turns ago is still this session's work — and the wrong thing to be
   * satisfied by on its own. Turn one wrote a file; turn two wrote nothing,
   * claimed a refactor, and `files-changed` found turn one's file still on
   * disk and passed it: a receipt headed "What the model changed" listing a
   * file that turn never opened. Absent when the caller has no notion of a
   * turn (`molt prove`), in which case the session ledger stands alone.
   */
  turnLedger?: LedgerEntry[];
  /**
   * The working tree as it stood when the turn began. `tree-accounted` and
   * `spec-intact` compare the disk against it, so a change made by any route
   * — not only through the tools — is seen and can be judged.
   */
  treeBefore?: TreeSnapshot;
  archive?: ArchiveLike;
  /** How many batches the transcript believes it has archived. */
  archivedBatches: number;
  /**
   * How many write records this session handed to the archive, counted in
   * memory. Compared against what the archive actually yields — an
   * expectation the archive cannot itself supply, which is what makes the
   * comparison meaningful rather than circular.
   */
  expectedArchivedWrites?: number;
  /**
   * Exuvia indices the running session shed.
   *
   * Without it the archive answers with every batch in the directory, which
   * is the whole project's history rather than this turn's evidence.
   */
  sessionArchives?: ReadonlySet<number>;
  /**
   * Archive files this project's session logs say exist. Survives process
   * restart, so a deleted exuvia is caught tomorrow as well as today.
   */
  expectedArchiveFiles?: string[];
  /** The completion claim being judged, when there is one. */
  claim?: string;
  /**
   * Checks already run in this bar attempt, in order.
   *
   * Only the mutation builtin reads this, and only to avoid paying twice for
   * the same command: its baseline run asks exactly the question the `tests`
   * check answered moments earlier on the same unmutated tree. A check that
   * consults this must be able to state why an earlier result is as good as
   * running it again — "it is slow" is not that reason.
   */
  earlier?: { check: Check; result: CheckResult }[];
  /**
   * Files one check writes and another reads — the bar's declared `lcov`
   * reports. A check that reruns a build has to put these back, or it corrupts
   * the evidence a later check is judged on.
   */
  protect?: string[];
};

export function barPath(cwd: string): string {
  return join(cwd, ".molt", BAR_FILENAME);
}

export function hasBar(cwd: string): boolean {
  return existsSync(barPath(cwd));
}

/**
 * Parse and validate a bar. Throws BarError with a message a human can act
 * on — a malformed bar must never silently degrade into "no checks", since
 * that would turn the product's central promise off by accident.
 */
export function parseBar(source: string): Bar {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (e) {
    throw new BarError(`done.yml is not valid YAML: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== "object") {
    throw new BarError("done.yml must be a mapping with `version` and `checks`.");
  }

  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new BarError(`done.yml: unsupported version ${JSON.stringify(obj.version)} (expected 1).`);
  }
  if (!Array.isArray(obj.checks) || obj.checks.length === 0) {
    throw new BarError("done.yml: `checks` must be a non-empty list.");
  }

  const seen = new Set<string>();
  const checks: Check[] = obj.checks.map((entry, i) => {
    if (entry === null || typeof entry !== "object") {
      throw new BarError(`done.yml: check ${i} must be a mapping.`);
    }
    const c = entry as Record<string, unknown>;
    const name = typeof c.name === "string" ? c.name.trim() : "";
    if (!name) throw new BarError(`done.yml: check ${i} is missing a name.`);
    if (seen.has(name)) throw new BarError(`done.yml: duplicate check name "${name}".`);
    seen.add(name);

    // YAML coerces bare scalars, so `run: true` arrives as a boolean even
    // though /usr/bin/true is a perfectly good check. Accept any scalar and
    // stringify it; reject only shapes that cannot be a command.
    const runRaw = c.run;
    const runIsScalar =
      typeof runRaw === "string" || typeof runRaw === "number" || typeof runRaw === "boolean";
    if (runRaw !== undefined && runRaw !== null && !runIsScalar) {
      throw new BarError(`done.yml: check "${name}" has a \`run\` that is not a shell command.`);
    }
    const runStr = runIsScalar ? String(runRaw).trim() : "";
    if (runIsScalar && runStr.length === 0) {
      throw new BarError(`done.yml: check "${name}" has an empty \`run\`.`);
    }

    const hasRun = runStr.length > 0;
    const hasBuiltin = typeof c.builtin === "string";
    // Every builtin but one runs against the session record alone, so a `run`
    // beside it is a mistake worth refusing. The mutation builtin is the
    // exception and needs both: molt chooses the lines and breaks them, but
    // only the project knows which command is supposed to go red. Without this
    // exemption the mutation builtin cannot be configured at all — both shapes
    // throw, and the validator below that asks for a `run` is unreachable.
    const builtinTakesRun = c.builtin === "mutation";
    if (hasRun === hasBuiltin && !builtinTakesRun) {
      throw new BarError(`done.yml: check "${name}" needs exactly one of \`run\` or \`builtin\`.`);
    }

    let tags: string[] = [];
    if (c.tags !== undefined) {
      if (!Array.isArray(c.tags) || c.tags.some((t) => typeof t !== "string")) {
        throw new BarError(`done.yml: check "${name}" has tags that are not a list of strings.`);
      }
      tags = (c.tags as string[]).map((t) => t.trim()).filter(Boolean);
    }

    // `watch:` declares what a check reads, so molt can tell when re-running
    // it could not possibly say anything new.
    let watch: string[] | undefined;
    if (c.watch !== undefined) {
      if (!Array.isArray(c.watch) || c.watch.some((w) => typeof w !== "string")) {
        throw new BarError(`done.yml: check "${name}" has a \`watch\` that is not a list of strings.`);
      }
      watch = (c.watch as string[]).map((w) => w.trim()).filter(Boolean);
      if (watch.length === 0) watch = undefined;
    }

    // `advisory: true` makes a failure information rather than a refusal.
    if (c.advisory !== undefined && typeof c.advisory !== "boolean") {
      throw new BarError(`done.yml: check "${name}" has a non-boolean \`advisory\`.`);
    }
    const advisory = c.advisory === true ? { advisory: true as const } : {};

    if (hasBuiltin) {
      const builtin = String(c.builtin) as BuiltinCheck;
      if (!BUILTINS.includes(builtin)) {
        throw new BarError(
          `done.yml: check "${name}" uses unknown builtin "${builtin}". Known: ${BUILTINS.join(", ")}.`,
        );
      }
      // Only meaningful on files-changed; rejected elsewhere so a typo on the
      // wrong check is an error rather than a setting that silently does
      // nothing. A gate people believe is on and is not is worse than no gate.
      if (c["comment-only"] !== undefined) {
        if (c["comment-only"] !== "allow" && c["comment-only"] !== "refuse") {
          throw new BarError(
            `done.yml: check "${name}" has \`comment-only: ${JSON.stringify(c["comment-only"])}\` ` +
              "(expected `allow` or `refuse`).",
          );
        }
        if (builtin !== "files-changed") {
          throw new BarError(
            `done.yml: check "${name}" sets \`comment-only\`, which only applies to the ` +
              "files-changed builtin.",
          );
        }
      }
      const commentOnly = c["comment-only"] === "allow" ? { commentOnly: "allow" as const } : {};
      if (c["removals"] !== undefined) {
        if (c["removals"] !== "allow" && c["removals"] !== "refuse") {
          throw new BarError(
            `done.yml: check "${name}" has \`removals: ${JSON.stringify(c["removals"])}\` ` +
              `— it takes "allow" or "refuse".`,
          );
        }
        if (c.builtin !== "spec-intact") {
          throw new BarError(
            `done.yml: check "${name}" sets \`removals\`, which only applies to the ` +
              `spec-intact builtin.`,
          );
        }
      }
      const removals = c["removals"] === "allow" ? { removals: "allow" as const } : {};
      if (c["outside"] !== undefined) {
        if (c["outside"] !== "allow" && c["outside"] !== "refuse") {
          throw new BarError(
            `done.yml: check "${name}" has \`outside: ${JSON.stringify(c["outside"])}\` ` +
              `— it takes "allow" or "refuse".`,
          );
        }
        if (c.builtin !== "tree-accounted") {
          throw new BarError(
            `done.yml: check "${name}" sets \`outside\`, which only applies to the ` +
              `tree-accounted builtin.`,
          );
        }
      }
      const outside = c["outside"] === "allow" ? { outside: "allow" as const } : {};

      // diff-covered cannot work without being told where the report is, and
      // a check that cannot work must say so at parse time rather than fail
      // mysteriously on the first turn that changes a file.
      if (builtin === "diff-covered" && typeof c.lcov !== "string") {
        throw new BarError(
          `done.yml: check "${name}" uses the diff-covered builtin and needs an \`lcov\` ` +
            "path — the file your test command writes coverage to.",
        );
      }
      if (c.lcov !== undefined && typeof c.lcov !== "string") {
        throw new BarError(`done.yml: check "${name}" has a non-string \`lcov\`.`);
      }
      // `hasRun`/`runStr` rather than `typeof c.run`, so a mutation check reads
      // a `run` the same way every other check does — YAML coerces bare scalars,
      // and a command this parser accepts everywhere else must not be reported
      // as missing here.
      if (builtin === "mutation" && !hasRun) {
        throw new BarError(
          `done.yml: check "${name}" uses the mutation builtin and needs a \`run\` — the ` +
            "command that should fail when the code is broken.",
        );
      }
      const mut =
        builtin === "mutation"
          ? {
              run: runStr,
              sample: Number.isFinite(Number(c.sample)) ? Math.max(1, Number(c.sample)) : 4,
              timeoutMs: Number.isFinite(Number(c.timeout)) ? Number(c.timeout) * 1000 : 600_000,
            }
          : {};
      const lcov = typeof c.lcov === "string" ? { lcov: c.lcov.trim() } : {};
      return {
        name,
        kind: "builtin",
        builtin,
        tags,
        ...advisory,
        ...commentOnly,
        ...removals,
        ...outside,
        ...lcov,
        ...mut,
      };
    }

    const timeout = c.timeout === undefined ? undefined : Number(c.timeout);
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
      throw new BarError(`done.yml: check "${name}" has an invalid timeout.`);
    }
    const expectExit = c.expect_exit === undefined ? 0 : Number(c.expect_exit);
    if (!Number.isInteger(expectExit)) {
      throw new BarError(`done.yml: check "${name}" has a non-integer expect_exit.`);
    }
    return {
      name,
      kind: "command",
      run: runStr,
      timeoutMs: timeout === undefined ? DEFAULT_TIMEOUT_MS : timeout * 1000,
      expectExit,
      tags,
      ...(watch ? { watch } : {}),
      ...advisory,
    };
  });

  return { version: 1, checks };
}

/**
 * Fingerprint of the bar file as it sits on disk. The agent is told not to
 * edit .molt/done.yml — but an instruction is a hope, not a control. molt
 * compares this before every run, so lowering the bar mid-task is itself a
 * failing check.
 */
export function barFingerprint(cwd: string): string | null {
  const p = barPath(cwd);
  if (!existsSync(p)) return null;
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

export type Selection = { only?: string[]; skip?: string[] };

/**
 * Narrow a bar by tag. Every check runs on every completion attempt, so a
 * five-minute suite across four attempts is twenty minutes of inner loop.
 * Tags let a project keep slow checks in the file for CI while the local
 * loop runs the fast ones.
 *
 * An untagged check is always included — omitting a tag must never quietly
 * remove a condition from the bar.
 */
export function selectChecks(bar: Bar, sel: Selection = {}): Bar {
  const { only, skip } = sel;
  if (!only?.length && !skip?.length) return bar;
  const checks = bar.checks.filter((c) => {
    if (skip?.length && c.tags.some((t) => skip.includes(t))) return false;
    if (only?.length) return c.tags.length === 0 || c.tags.some((t) => only.includes(t));
    return true;
  });
  return { version: 1, checks };
}

export function loadBar(cwd: string): Bar | null {
  const p = barPath(cwd);
  if (!existsSync(p)) return null;
  return parseBar(readFileSync(p, "utf8"));
}

/** Written on first run so the bar exists before anyone needs it. */
/**
 * The bar molt writes when it can find nothing to run.
 *
 * `proposeBar()` is the real source now — it reads the project and writes the
 * project's own commands. This is what remains when there is nothing to read,
 * and it exists as a named export because a fallback nobody can point at is a
 * fallback nobody can review.
 */
export const FALLBACK_BAR = proposeBar("/nonexistent-so-nothing-is-detected").yaml;

/**
 * Write a starter bar, with this project's own commands in it.
 *
 * Returns what it detected so the caller can say so out loud — a generated
 * file nobody can explain is a file people delete the first time it fails.
 */
export function writeDefaultBar(cwd: string): { path: string; detected: Detected[]; existed: boolean } {
  const dir = join(cwd, ".molt");
  mkdirSync(dir, { recursive: true });
  const p = barPath(cwd);
  if (existsSync(p)) return { path: p, detected: [], existed: true };
  const { yaml, detected } = proposeBar(cwd);
  writeFileSync(p, yaml, "utf8");
  return { path: p, detected, existed: false };
}

/**
 * Cut the middle out of an output, never the end.
 *
 * This kept the first N bytes and threw the rest away, which is the wrong end
 * of a test run. `npm test` on this project emits ninety kilobytes of `✔`
 * before it says what failed, so a model told "your suite is red" was handed
 * two thousand bytes of passing tests and `[molt: truncated 90318 bytes]`, and
 * the assertion it had actually broken was in the part that was discarded. A
 * local 30B spent two full attempts guessing at a failure molt had hidden from
 * it, and the run was scored as the model's failure.
 *
 * Every test runner, compiler and linter in common use reports its verdict at
 * the END. So the head is kept for context — which command ran, how it started
 * — and the tail is kept because that is the part with the answer in it.
 *
 * Cut on line boundaries: a byte-sliced UTF-8 string can end mid-character,
 * and a failure message with a replacement character in it is a failure
 * message somebody has to squint at.
 */
export function clipEnds(s: string, n: number): string {
  if (Buffer.byteLength(s, "utf8") <= n) return s;
  const lines = s.split("\n");
  const headBudget = Math.floor(n * 0.3);
  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost > headBudget) break;
    head.push(line);
    used += cost;
  }
  const tail: string[] = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const cost = Buffer.byteLength(lines[i]!, "utf8") + 1;
    if (used + cost > n - headBudget) break;
    tail.unshift(lines[i]!);
    used += cost;
  }
  const cut = lines.length - head.length - tail.length;
  if (cut <= 0) return s;
  return [
    ...head,
    `[molt: ${cut} line(s) cut from the middle. The end is kept: that is where failures are reported.]`,
    ...tail,
  ].join("\n");
}

function truncate(s: string, n = OUTPUT_MAX): string {
  return clipEnds(s, n);
}

/** sha256 of a file, or "" if it cannot be read. Used to verify a restore. */
function sha256Of(abs: string): string {
  try {
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return "";
  }
}

function sha256File(p: string): string | null {
  if (!existsSync(p)) return null;
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/**
 * English that looks like a filename and is not one.
 *
 * "e.g." parses as a stem and a one-letter extension, and molt refused a
 * correct document over it — then sent the model back to strip abbreviations
 * out of its own prose. A check that makes work worse to satisfy it is not a
 * check, so the bias here is heavily toward silence: a missed fabrication
 * costs one unnoticed sentence, a false positive costs the whole turn.
 */
/**
 * Suffixes that make a token a filename.
 *
 * An allowlist, not a pattern, and that direction is deliberate. "Anything
 * after a dot" also describes `Date.now`, `r.ok`, `String.replace` and
 * `Journal.protect` — and this check REFUSES WORK when it is wrong, so its
 * errors have to fall on the side of saying nothing. A file whose extension is
 * missing here goes unchecked, which costs one unnoticed fabrication. The
 * reverse cost a real session its completion for writing the word `Date.now()`
 * in a sentence.
 */
const FILE_EXTENSIONS = new Set([
  // code
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "pl", "lua", "r",
  "scala", "clj", "ex", "exs", "erl", "hs", "ml", "vue", "svelte", "dart", "zig",
  // shells and config
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "json", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "properties",
  "lock", "gradle", "mk", "cmake", "dockerfile", "gitignore", "editorconfig",
  // markup, docs, data
  "md", "mdx", "rst", "txt", "adoc", "tex", "html", "htm", "xml", "svg",
  "css", "scss", "sass", "less", "styl",
  "csv", "tsv", "sql", "jsonl", "ndjson", "proto", "graphql", "gql",
  // assets that show up in a claim about work
  "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "woff", "woff2", "ttf",
]);

const NOT_FILENAMES = new Set([
  "e.g", "i.e", "etc", "vs", "cf", "al", "viz", "ibid", "approx", "no", "fig",
  "eq", "ref", "dept", "est", "min", "max", "avg", "sec", "ch", "pp", "vol",
  "ed", "jr", "sr", "mr", "mrs", "ms", "dr", "st", "ave", "inc", "ltd", "co",
  "corp", "u.s", "u.k", "a.m", "p.m", "p.s", "n.b",
]);

/**
 * File paths a completion claim refers to. Deliberately conservative: a
 * token must look like a path with an extension, or be backtick-quoted.
 * Over-matching would fail correct work, which is worse than missing a
 * fabricated reference.
 */
export function mentionedPaths(claim: string): string[] {
  const found = new Set<string>();

  // URLs contain host names and paths that look exactly like file paths.
  // Remove them wholesale rather than trying to reject them token by token.
  const text = claim
    .replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    // A scheme-relative URL is still a URL, and "//example.com" was being
    // reported as a missing file.
    .replace(/\/\/[\w.-]+\.[a-z]{2,}\S*/gi, " ");

  const add = (raw: string) => {
    const cleaned = raw.replace(/^[`'"(\[]+|[`'".,;:)\]]+$/g, "").trim();
    if (!cleaned || cleaned.length > 200) return;
    if (!/^[\w./@-]+$/.test(cleaned)) return;
    if (!/\.[A-Za-z][\w]{0,9}$/.test(cleaned)) return; // needs a file extension
    if (/^\d+\.\d+$/.test(cleaned)) return; // version numbers
    if (cleaned.startsWith("http")) return;
    if (NOT_FILENAMES.has(cleaned.toLowerCase())) return;
    // A path is a path whatever it ends in; a bare token has to end in
    // something that is actually a file extension.
    const ext = cleaned.slice(cleaned.lastIndexOf(".") + 1).toLowerCase();
    if (!cleaned.includes("/") && !FILE_EXTENSIONS.has(ext)) return;
    // An earlier version also skipped any short stem with a short extension,
    // which killed "e.g." and "a.ts" alike — so a claim about a real file
    // stopped being checked at all. The named list above is enough; guessing
    // by shape cost more than it caught.
    found.add(cleaned.replace(/^\.\//, ""));
  };

  for (const m of text.matchAll(/`([^`]+)`/g)) add(m[1]);
  for (const m of text.matchAll(/[\w./@-]*[\w-]\.[A-Za-z][\w]{0,9}\b/g)) add(m[0]);

  return [...found];
}

/**
 * Which of `mentioned` file paths a claim asserts were CREATED or ADDED this
 * turn — as opposed to merely referenced or changed.
 *
 * Creation is the strongest claim a completion can make about a file, and it
 * is the one a fabrication is most likely to lean on ("I created src/auth.ts"
 * while the file pre-existed or was never touched). A change to an existing
 * file is grounded by the ledger once; a creation is a claim of a WRITE, and
 * can only be grounded by the ledger showing that write.
 *
 * Deliberately narrow: a file is only flagged when a creation/implementation
 * verb appears immediately before or after it, so "added coverage for f" is
 * caught but "the fix touches f and g" is not. Over-matching here would fail
 * correct work — asserting a change is not the same as asserting a creation,
 * and the two must never be conflated.
 */
export function claimedCreated(claim: string, mentioned: string[]): string[] {
  const out: string[] = [];
  for (const path of mentioned) {
    // The path as it might appear verbatim in the claim, minus the leading ./.
    const bare = path.replace(/^\.\//, "");
    // A creation/implementation verb inside a short window on either side of
    // the path. A path in backticks ("created `src/x.ts`") is the most common
    // shape and the one a parser must not miss.
    const inBackticks = new RegExp(
      `\\b(?:created?|added?|introduced?|implemented|built|wrote|writes)\\b[^\\n.]{0,40}\`${escapeRe(bare)}\``,
      "i",
    );
    const backtickFirst = new RegExp(
      `\`${escapeRe(bare)}\`[^\\n.]{0,40}\\b(?:created?|added?|introduced?|implemented|built|wrote|writes)\\b`,
      "i",
    );
    const prose = new RegExp(
      `\\b(?:created?|added?|introduced?|implemented|built|wrote|writes)\\b[^\\n.]{0,60}${escapeRe(bare)}\\b` +
        `|` +
        `\\b${escapeRe(bare)}\\b[^\\n.]{0,60}(?:created?|added?|introduced?|implemented|built|wrote|writes)\\b`,
      "i",
    );
    if (inBackticks.test(claim) || backtickFirst.test(claim) || prose.test(claim)) {
      if (!out.includes(bare)) out.push(bare);
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every path the model asked to change, across the entire session record.
 *
 * Both write tools count. When `edit_file` arrived this still looked only for
 * `write_file`, so a session whose edits all failed reported "no file was
 * modified" instead of naming the edits that did not land — a correct refusal
 * with a misleading reason, which is its own kind of wrong.
 *
 * **Unique paths, not calls.** The ledger this is compared against is keyed by
 * path — one entry per file, merging the first `before` with the last `after`
 * — so counting calls here compares two different units. A turn that edited
 * four files nine times between them reported "5 further write(s) in the
 * record did not land" into a receipt, and nothing had failed to land: the
 * model had simply edited the same files more than once. A receipt is the
 * document handed to someone who does not trust you, and that sentence was
 * false in it.
 */
export function claimedWrites(record: Msg[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const m of record) {
    for (const c of m.tool_calls ?? []) {
      if (c.function.name !== "write_file" && c.function.name !== "edit_file") continue;
      try {
        const args = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
        if (typeof args.path !== "string" || seen.has(args.path)) continue;
        seen.add(args.path);
        paths.push(args.path);
      } catch {
        /* malformed args are visible in the record; not this check's job */
      }
    }
  }
  return paths;
}

/**
 * Break each new line and confirm something notices.
 *
 * `diff-covered` proves a line runs. It cannot prove anything *checks* what
 * the line does: a test that executes code while asserting nothing satisfies
 * coverage completely, and reports the line as fine. Breaking the line is the
 * only mechanical way to tell those apart.
 *
 * Expensive, and honest about it — one full run of the command per mutation,
 * so the sample is small and the report says what was left unexamined. A bound
 * nobody is told about reads as completeness.
 *
 * The dangerous part is not the mutating, it is the restoring. Every file is
 * hashed before it is touched and verified after; a failed restore is reported
 * as a failure of this check no matter what the mutations found, because a
 * verification tool that leaves your source altered has done something far
 * worse than miss a bug.
 */
/**
 * A plain check earlier in this same bar attempt that ran exactly this command.
 *
 * Deliberately strict, because the answer is used in place of running the
 * command again:
 *
 *  - identical command text, so a different suite cannot stand in for this one;
 *  - `expectExit === 0`, since a check built to expect a failure passes by
 *    failing, and "passed" there is not the green baseline this needs;
 *  - not a cached result. A cache hit says the watched files have not moved,
 *    which is a claim about the filesystem rather than a run that happened.
 *    The baseline is the one thing here that must have actually executed.
 */
function priorRunOf(
  ctx: BarContext,
  run: string,
): { check: Check; result: CheckResult } | null {
  for (const e of ctx.earlier ?? []) {
    if (e.check.kind !== "command") continue;
    if (e.check.run !== run || e.check.expectExit !== 0) continue;
    if (e.result.cached) continue;
    return e;
  }
  return null;
}

async function mutationCheck(
  ctx: BarContext,
  run: string,
  sample: number,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  const files = ctx.ledger
    .filter((e) => e.changedLines && e.changedLines.length > 0)
    .map((e) => {
      const abs = resolve(ctx.cwd, e.path);
      let text = "";
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        return null;
      }
      return { path: e.path, abs, text, sha: sha256Of(abs), changedLines: e.changedLines! };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  if (files.length === 0) return { ok: true, output: "No changed lines to mutate." };

  const plan = planMutations(files, sample) as (Mutation & { path: string })[];
  if (plan.length === 0) {
    return {
      ok: true,
      output:
        `${files.length} changed file(s), no line with an operator to flip. ` +
        "Nothing was mutated, so nothing is claimed.",
    };
  }

  // Snapshot before anything runs, the baseline included — it runs the same
  // command and writes the same side effects. Taking this after it would
  // preserve output the check itself produced rather than the turn's.
  //
  // Whatever the command writes as a side effect, it is about to write it
  // again from deliberately broken source. `coverage/lcov.info` is the case
  // that bites: `diff-covered` reads it, builtins are never cached, so the
  // next bar attempt would judge this turn's coverage using a report generated
  // from mutated code — and a mutated run that fails its suite writes a
  // materially shorter report. A green turn would fail a check for a reason
  // that no longer exists on disk. Anything another check declares it reads is
  // put back exactly as it was found.
  const artifacts = (ctx.protect ?? [])
    .map((rel) => ({ rel, abs: resolve(ctx.cwd, rel) }))
    .filter((a) => existsSync(a.abs))
    .map((a) => ({ ...a, body: readFileSync(a.abs) }));

  // The command has to pass on the unmutated code before any of this means
  // anything. A suite that is already red counts every mutation as "killed" —
  // the command failed, after all — and the check reports "N mutations broke a
  // test, as they should" having tested precisely nothing. That is the exact
  // shape of false confidence this tool exists to refuse, and it passed a
  // hand-written probe before being caught.
  //
  // It does not have to be *this* check that runs it. A plain check earlier in
  // the same bar attempt, running the identical command against the identical
  // unmutated tree, has already answered the question — and on this project
  // that command is the suite, which is the single most expensive thing molt
  // runs. Reusing it is worth one full run of every bar attempt.
  const prior = priorRunOf(ctx, run);
  if (prior && !prior.result.ok) {
    // Already known red, and knowing it cost nothing. Running it again to
    // rediscover that would be the most expensive way to learn nothing.
    return {
      ok: false,
      output:
        `\`${run}\` already failed this bar run as check "${prior.check.name}", so breaking a ` +
        `line proves nothing — every mutation would look killed by a failure that was ` +
        `already there. Fix that check first; this one did not run.`,
    };
  }
  if (!prior) {
    const baseline = await runCommand(run, { cwd: ctx.cwd, timeoutMs, signal: ctx.signal });
    if (baseline.code !== 0) {
      return {
        ok: false,
        output:
          `\`${run}\` fails on the unmutated code (exit ${baseline.code}), so breaking a line ` +
          `proves nothing — every mutation would look killed by a failure that was already ` +
          `there. Fix the suite first.\n\n` +
          (baseline.stdout || baseline.stderr || "").slice(0, 600),
      };
    }
  }

  const survived: string[] = [];
  const killed: string[] = [];
  const restoreFailures: string[] = [];

  for (const m of plan) {
    const file = files.find((f) => f.path === m.path)!;
    const mutated = applyMutation(file.text, m);
    if (mutated === null || mutated === file.text) {
      // The line moved or the swap was a no-op. Reporting a green run here
      // would be reporting a mutation that never happened, which is exactly
      // how this discipline has been fooled by hand.
      continue;
    }
    try {
      writeFileSync(file.abs, mutated, "utf8");
      const r = await runCommand(run, {
        cwd: ctx.cwd,
        timeoutMs,
        signal: ctx.signal,
      });
      // A mutation the command still passes is a line nothing checks.
      if (r.code === 0) survived.push(`${m.path}:${m.line} (${m.operator}) — ${m.before.trim()}`);
      else killed.push(`${m.path}:${m.line} (${m.operator})`);
    } finally {
      writeFileSync(file.abs, file.text, "utf8");
      if (sha256Of(file.abs) !== file.sha) restoreFailures.push(file.path);
    }
  }

  // Put back what the runs above overwrote, before any result is reported. A
  // later check reading a stale artifact is a failure this check caused, and
  // it would be attributed to the turn's work rather than to the tool.
  for (const a of artifacts) {
    try {
      writeFileSync(a.abs, a.body);
    } catch {
      restoreFailures.push(a.rel);
    }
  }

  if (restoreFailures.length) {
    return {
      ok: false,
      output:
        `RESTORE FAILED for ${restoreFailures.join(", ")}. The file on disk is not what it ` +
        `was before this check ran. Fix that before anything else — nothing this check ` +
        `found matters next to it.`,
    };
  }

  const total = files.reduce((n, f) => n + f.changedLines.length, 0);
  return mutationVerdict({ killed, survived, planned: plan.length, total, sample });
}

/**
 * What the counts mean, separated from the running that produced them.
 *
 * Extracted so every outcome can be proven. The `examined === 0` case below is
 * unreachable through `mutationCheck` today — the planner only emits swaps
 * against the same in-memory text `applyMutation` re-checks, so an applied
 * count of zero cannot happen — and a branch no test can reach is exactly what
 * the mutation check exists to refuse. Being a pure function makes it reachable
 * by a test rather than by an argument that it cannot go wrong.
 */
export function mutationVerdict(r: {
  killed: string[];
  survived: string[];
  planned: number;
  total: number;
  sample: number;
}): { ok: boolean; output: string } {
  const { killed, survived, planned, total, sample } = r;
  const examined = killed.length + survived.length;
  const unexamined = total - examined;
  const note =
    unexamined > 0
      ? ` · ${unexamined} changed line(s) not mutated (sample is ${sample}; raise it or accept the bound)`
      : "";

  // Nothing was applied, so nothing was tested. The loop above already refuses
  // to trust that a planned mutation applied, and this must refuse it too.
  // Falling through would report "0 mutation(s) broke a test, as they should"
  // after a single baseline run: a green pass claiming a suite killed
  // everything when the code was never once broken. Same phrasing as the
  // empty-plan case, because it is the same claim — that none is being made.
  if (examined === 0) {
    return {
      ok: true,
      output:
        `${planned} mutation(s) planned, none applied (every line had moved, or the swap ` +
        "left the file unchanged). Nothing was mutated, so nothing is claimed.",
    };
  }

  if (survived.length === 0) {
    return {
      ok: true,
      output: `${killed.length} mutation(s) broke a test, as they should${note}`,
    };
  }
  return {
    ok: false,
    output:
      `${survived.length} of ${examined} mutation(s) changed the code and nothing failed:\n` +
      survived.map((s) => `  ${s}`).join("\n") +
      `\n\nThose lines run but nothing checks what they do. A test that executes code ` +
      `without asserting on it leaves the code exactly as unproven as no test at all.${note}`,
  };
}

/**
 * Every line this turn added, executed by the tests that just ran.
 *
 * The failure this closes, from a real session: a turn added a constant
 * referenced nowhere and a guard whose branch no test ever trips, and passed
 * six checks — types, tests, two app checks, record-intact and work-landed. It
 * was caught by a person reading the diff. That does not scale, and reading
 * diffs by hand is the job molt exists to replace.
 *
 * A missing report fails rather than passes. A check that quietly verifies
 * nothing when its input is absent is worse than no check, because it is
 * counted as one.
 */
function diffCovered(ctx: BarContext, lcovPath?: string): { ok: boolean; output: string } {
  const judged = ctx.ledger.filter((e) => e.changedLines && e.changedLines.length > 0);
  if (judged.length === 0) {
    // Nothing was written that could be executed. files-changed is the check
    // that has an opinion about that; this one has nothing to measure.
    return { ok: true, output: "No changed lines to cover." };
  }
  if (!lcovPath) {
    return { ok: false, output: "diff-covered needs an `lcov` path in done.yml." };
  }
  const abs = resolve(ctx.cwd, lcovPath);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return {
      ok: false,
      output:
        `No coverage report at ${lcovPath}. This check cannot establish anything without ` +
        `one, and passing it would be a claim molt has not earned. Make the test command ` +
        `write lcov there, or drop this check.`,
    };
  }

  const cov = parseLcov(text);
  const problems: Unproven[] = [];
  let unmatched = 0;
  for (const entry of judged) {
    const found = coverageFor(cov, entry.path);
    if (!found) {
      unmatched++;
      continue;
    }
    const bad = unprovenIn(cov, entry.path, entry.changedLines!);
    if (bad) problems.push(bad);
  }

  if (problems.length === 0) {
    const covered = judged.length - unmatched;
    return {
      ok: true,
      output:
        `${covered} changed file(s) executed by the tests` +
        (unmatched > 0
          ? ` · ${unmatched} not in the coverage report (not instrumented — nothing is claimed about them)`
          : ""),
    };
  }

  const lines = problems.map((p) => {
    const bits: string[] = [];
    if (p.deadLines.length) bits.push(`never executed: ${p.deadLines.join(", ")}`);
    if (p.deadBranches.length) bits.push(`branch never taken: ${p.deadBranches.join(", ")}`);
    return `  ${p.path} — ${bits.join(" · ")}`;
  });
  return {
    ok: false,
    output:
      "Lines this turn added that nothing executes:\n" +
      lines.join("\n") +
      "\n\nCode no test reaches has not been shown to do anything. Either exercise it or " +
      "do not add it — a constant nothing references and a branch nothing trips are how a " +
      "diff gets made without work being done.",
  };
}

/**
 * Every file that changed on disk this turn was written through a tool.
 *
 * The check the ledger builtins were missing underneath them. `files-changed`
 * proves the tools' writes landed; `spec-intact` reads the assertions the
 * tools removed; neither could see a file rewritten by `node fix.cjs`, by
 * `sed -i`, or by `cp /dev/null` — and at `--yes` none of those asks. A real
 * run deleted an assertion by exactly that route and was accepted with
 * "no test file was changed". Commandment 7, "do not route around a refusal
 * with another tool", was a sentence in the refusal text; this is the check.
 *
 * Fails closed. A tree that could not be snapshotted in full proves nothing
 * about the part that was not read, and "nothing is claimed" here has to be a
 * refusal rather than a pass, because the whole point is what the ledger
 * cannot see.
 */
function treeAccounted(ctx: BarContext, allowOutside: boolean): { ok: boolean; output: string } {
  if (!ctx.treeBefore) {
    return {
      ok: false,
      output:
        "tree-accounted needs a snapshot of the working tree taken when the turn began, and " +
        "this run has none — `molt prove` has no turn. Nothing can be established here; " +
        "`--skip session` runs the command checks on their own.",
    };
  }
  const bounded = (snap: { truncated: boolean; examined?: number }) =>
    snap.truncated
      ? {
          ok: false,
          output:
            `The working tree could not be snapshotted in full (${snap.examined ?? "?"} entries ` +
            "examined before the bound), so a change made outside the tools cannot be told from " +
            "one made through them. Nothing is claimed. Narrow the project, or set `outside: allow` " +
            "on this check.",
        }
      : null;
  const early = bounded(ctx.treeBefore);
  if (early) return early;
  const diff = treeChanges(ctx.cwd, ctx.treeBefore);
  const late = bounded(diff);
  if (late) return late;

  // What this turn wrote through the tools. A path the ledger holds is
  // accounted for whatever the disk did to it afterwards — `files-changed`
  // is the check that notices a ledgered file drifting.
  const accounted = new Set((ctx.turnLedger ?? ctx.ledger).map((e) => e.path));
  const outside = [
    ...diff.changed.filter((p) => !accounted.has(p)).map((p) => `${p} (changed)`),
    ...diff.created.filter((p) => !accounted.has(p)).map((p) => `${p} (created)`),
    ...diff.deleted.filter((p) => !accounted.has(p)).map((p) => `${p} (deleted)`),
  ];
  const total = diff.changed.length + diff.created.length + diff.deleted.length;
  if (outside.length === 0) {
    return {
      ok: true,
      output:
        total === 0
          ? "the working tree did not change this turn"
          : `${total} file(s) changed on disk this turn, every one written through a tool and in the ledger`,
    };
  }
  const shown = outside.slice(0, 12);
  const more = outside.length > shown.length ? `\n  … and ${outside.length - shown.length} more` : "";
  if (allowOutside) {
    return {
      ok: true,
      output: `${outside.length} file(s) changed outside the tools, allowed by \`outside: allow\`: ${outside.join(", ")}`,
    };
  }
  return {
    ok: false,
    output:
      `${outside.length} file(s) changed on disk this turn that no tool call wrote:\n` +
      shown.map((s) => `  ${s}`).join("\n") +
      more +
      "\n\nA change made through bash — a script, sed, cp, a generator — has no entry in the " +
      "write ledger, so nothing here can prove what it did or judge it. Make changes with " +
      "write_file and edit_file. If a command was meant to change these (an install, a build " +
      "step), say which command and why, and stop: that is a decision for a person, or " +
      "`outside: allow` on this check in .molt/done.yml.",
  };
}

function runBuiltin(
  builtin: BuiltinCheck,
  ctx: BarContext,
  allowCommentOnly = false,
  lcovPath?: string,
  allowRemovals = false,
  allowOutside = false,
): { ok: boolean; output: string } {
  if (builtin === "diff-covered") return diffCovered(ctx, lcovPath);
  if (builtin === "tree-accounted") return treeAccounted(ctx, allowOutside);
  if (builtin === "files-changed") {
    const attempted = claimedWrites(ctx.record);
    if (ctx.ledger.length === 0) {
      return {
        ok: false,
        output:
          attempted.length === 0
            ? // This sentence is read by a model that has just been refused,
              // and it was read as an instruction: write something, anything.
              // One did exactly that — a comment restating a function's
              // signature — and said so in its receipt. A gate that names the
              // cheapest way past itself has told the model how to cheat, so
              // this one names the honest exit instead.
              "No file was modified in this session. Nothing was done that can be shown.\n" +
              "If the task does require a change, make it. If it genuinely does not — a " +
              "question, a review, a file you were only asked to read — then say that " +
              "plainly and stop. molt records an unfinished turn honestly; it cannot " +
              "record an invented one. Editing a file for no reason other than this " +
              "check is the worst of the three outcomes and will be refused."
            : `${attempted.length} write(s) appear in the record but none landed on disk ` +
              `(denied, errored, or never executed): ${attempted.join(", ")}`,
      };
    }
    if (ctx.turnLedger !== undefined && ctx.turnLedger.length === 0) {
      return {
        ok: false,
        output:
          `No file was modified in this turn. ${ctx.ledger.length} file(s) written earlier in this ` +
          `session are still on disk (${ctx.ledger.map((e) => e.path).join(", ")}), but a ` +
          `completion claim is judged on what the turn did, and this turn did nothing that can ` +
          `be shown. If the task required a change, make it. If it did not — a question, a ` +
          `review — say that plainly and stop, or ask it with /ask, which drops this check.`,
      };
    }
    const problems: string[] = [];
    /**
     * Created by this turn and gone again: a scratch file.
     *
     * A model that writes a helper script, runs it, and cleans up after
     * itself has done nothing wrong — it has done the thing a careful person
     * does. The first version of this check failed the whole turn for it,
     * because the path it had ledgered was no longer on disk, and a local
     * 30B lost a run that way: it wrote `test-duration.js` to verify its own
     * change, `mv`'d it to `.cjs` so node would run it under an ESM package,
     * and was told its work had not landed. It then spent its last attempt
     * fighting that message instead of the real failure sitting beside it.
     *
     * A path that did not exist before the turn and does not exist after it
     * contributed nothing to the tree. It cannot be evidence of work, and it
     * is not evidence of a false claim either — `claims-grounded` is the
     * check that catches "I created X" when X is absent. So it is named in
     * the output and never fatal.
     *
     * A file that DID exist and is now gone is still a problem: that is work
     * being destroyed, not a scratch file being tidied.
     */
    const scratch: string[] = [];
    const landed: typeof ctx.ledger = [];
    // A path the claim itself names is not scratch, whatever became of it.
    // "I added src/fix.ts" over a file that is not there is the reverted-work
    // case, and it must keep failing here rather than relying on the project
    // having wired up `claims-grounded` as well.
    const named = new Set(mentionedPaths(ctx.claim ?? ""));
    for (const entry of ctx.ledger) {
      const abs = resolve(ctx.cwd, entry.path);
      const now = sha256File(abs);
      if (now === null) {
        if (entry.before === null && !named.has(entry.path)) {
          scratch.push(entry.path);
          continue;
        }
        problems.push(`${entry.path}: written during this session but no longer on disk`);
        continue;
      }
      if (now !== entry.after) {
        problems.push(`${entry.path}: contents changed since molt wrote it`);
        continue;
      }
      if (entry.before === entry.after) {
        problems.push(`${entry.path}: rewritten with identical contents — no actual change`);
        continue;
      }
      landed.push(entry);
    }
    if (problems.length) return { ok: false, output: problems.join("\n") };

    // Every write was a scratch file. Nothing survives, so nothing was done —
    // said plainly, because "you cleaned up after yourself" and "you did the
    // task" must never read the same.
    if (!landed.length) {
      return {
        ok: false,
        output:
          `Nothing this turn wrote is still on disk. ${scratch.length} file(s) were created and ` +
          `then removed or renamed (${scratch.join(", ")}), and nothing else changed. A scratch ` +
          `file that has been tidied away is not the task being done.`,
      };
    }

    // A file changed, and the change was only comments or blanks.
    //
    // This is the hole receipt 0025 went through. `work-landed` had asked only
    // whether a file changed; the model added a comment restating a function's
    // signature, said in its own claim that it was "to satisfy the work-landed
    // check", and molt issued a receipt certifying the task complete. The gate
    // was the reason the change existed, which is the one thing a gate must
    // never be.
    //
    // Judged per file, not as a sum. Receipt 0037's remaining hole: one real
    // line made `total === 1` and six comment-only word swaps rode along
    // inside the same accepted turn. A file whose every changed line is a
    // comment is still not work, even when a sibling file is.
    //
    // `substance` is absent on entries restored from an older archive. Unknown
    // is not zero: an entry that cannot be judged is left alone rather than
    // held against the model.
    if (!allowCommentOnly) {
      const empty = landed.filter((e) => e.substance === 0);
      if (empty.length) {
        const allEmpty = empty.length === ctx.ledger.length;
        return {
          ok: false,
          output:
            (allEmpty
              ? `Every changed line is a comment or blank: ${empty.map((e) => e.path).join(", ")}.\n`
              : `Comment-only change(s) riding along with real work: ${empty.map((e) => e.path).join(", ")}.\n`) +
            "A comment added so this check would pass is not the task being done, and " +
            "writing one is a worse outcome than saying the work is unfinished.\n" +
            "If the task genuinely was documentation, set `comment-only: allow` under " +
            "work-landed in .molt/done.yml. If it needed no file change at all, say so " +
            "plainly and stop — molt reports that as an answer, not a failure.",
        };
      }
    }
    return {
      ok: true,
      output:
        `${landed.length} file(s) modified and verified byte-for-byte on disk` +
        (attempted.length > ctx.ledger.length
          ? ` (${attempted.length - ctx.ledger.length} further write(s) in the record did not land)`
          : "") +
        // Named, not hidden: the turn touched these and they are gone, and a
        // reader of the receipt should be able to see that for themselves.
        (scratch.length ? ` · ${scratch.length} scratch file(s) created and tidied away: ${scratch.join(", ")}` : ""),
    };
  }

  if (builtin === "spec-intact") {
    // Adding tests is free. Deleting an assertion is a change to what the
    // project promises, and the reason this check exists is that a model asked
    // to prove a defect inverted the assertion that pinned the old behaviour
    // instead of writing a new test — making the specification agree with its
    // change rather than the change answer to the specification.
    const rewritten: { path: string; removed: string[]; route: "tool" | "disk" }[] = ctx.ledger
      .filter((e) => e.specRemoved?.length)
      .map((e) => ({ path: e.path, removed: e.specRemoved ?? [], route: "tool" as const }));
    // Any route. The ledger sees what the tools removed; a test file rewritten
    // by a script the model ran, or by `sed -i`, has no entry — and one real
    // run deleted an assertion exactly that way and was told "no test file was
    // changed". The tree snapshot taken when the turn began holds every test
    // file's assertions, so the disk can be asked as well as the ledger.
    const ledgered = new Set(ctx.ledger.map((e) => e.path));
    if (ctx.treeBefore && !ctx.treeBefore.truncated) {
      for (const [path, before] of ctx.treeBefore.assertions) {
        if (ledgered.has(path)) continue;
        let now: string[] = [];
        try {
          now = assertionsIn(readFileSync(resolve(ctx.cwd, path), "utf8"));
        } catch {
          now = []; // deleted or unreadable: every assertion it held is gone
        }
        const kept = new Set(now);
        const removed = before.filter((a) => !kept.has(a));
        if (removed.length) rewritten.push({ path, removed, route: "disk" });
      }
    }
    if (!rewritten.length) {
      const tests = ctx.ledger.filter((e) => isTestPath(e.path)).length;
      return {
        ok: true,
        output: tests
          ? `${tests} test file(s) changed, no assertion removed`
          : "no test file was changed",
      };
    }
    if (allowRemovals) {
      return {
        ok: true,
        output:
          `${rewritten.length} test file(s) lost assertion(s), allowed by \`removals: allow\`: ` +
          rewritten.map((e) => e.path).join(", "),
      };
    }
    const lines = rewritten.flatMap((e) =>
      e.removed.map(
        (a) => `  ${e.path}: ${a}${e.route === "disk" ? "  (changed on disk, not through a tool)" : ""}`,
      ),
    );
    return {
      ok: false,
      output:
        `This turn deleted ${lines.length} assertion(s) from ${rewritten.length} test file(s):\n` +
        `${lines.join("\n")}\n` +
        `A test that contradicts your change is not an obstacle to remove. Either the code ` +
        `is wrong and you fix the code, or the test is wrong — and a test being wrong is a ` +
        `decision for a person, so say which assertion you believe is wrong and why, and ` +
        `stop. If it really is obsolete, set \`removals: allow\` on this check.`,
    };
  }

  if (builtin === "claims-grounded") {
    // The model's own words, checked against what actually happened.
    // Fabricated file references are a documented failure mode: an agent
    // names a file it never created and reports success.
    const claim = ctx.claim ?? "";
    if (!claim.trim()) {
      return { ok: true, output: "No textual claim was made; nothing to ground." };
    }

    const mentioned = mentionedPaths(claim);
    if (mentioned.length === 0) {
      return { ok: true, output: "The claim references no files." };
    }

    const written = new Set(ctx.ledger.map((e) => e.path));
    // A file the model READ is grounded too. It refused a correct assessment
    // of molt's own source because the source lives outside the project
    // directory: the model had read engine.ts, quoted it accurately, and was
    // told it had invented the name. Reading something is evidence it exists —
    // it is the same evidence a write is, one step earlier.
    const read = new Set<string>();
    for (const p of ctx.read ?? []) {
      read.add(p);
      read.add(p.split("/").pop() ?? p);
    }
    const ungrounded: string[] = [];
    for (const p of mentioned) {
      if (written.has(p)) continue;
      if (read.has(p) || read.has(p.split("/").pop() ?? p)) continue;
      if (existsSync(resolve(ctx.cwd, p))) continue;
      ungrounded.push(p);
    }

    if (ungrounded.length > 0) {
      return {
        ok: false,
        output:
          `The completion claim names ${ungrounded.length} file(s) that do not exist and ` +
          `were never written in this project: ${ungrounded.join(", ")}. ` +
          `Either create them or stop referring to them.`,
      };
    }

    // The second layer: does the claim ASSERT work on a file the ledger
    // contradicts? A referenced file that simply exists on disk is grounded
    // — but a claim that says it *created*, *added*, or *implemented* a file
    // is a claim of a WRITE, and a write is only grounded by the ledger, not
    // by the file existing. "Created src/auth.ts" over a pre-existing file is
    // exactly the confident fabrication this builtin exists to catch, and the
    // exists-on-disk test above cannot see it.
    const assertedCreated = claimedCreated(claim, mentioned);
    if (assertedCreated.length) {
      const created = assertedCreated.filter((p) => !written.has(p));
      if (created.length) {
        return {
          ok: false,
          output:
            `The completion claim says ${created.length} file(s) were ${created.length > 1 ? "created or added" : "created or added"} but ` +
            `none appear in this session's write ledger: ${created.join(", ")}. ` +
            `A file that existed before the turn is not work this turn did — say ` +
            `you changed it, not that you created it.`,
        };
      }
    }

    const notes: string[] = [];
    if (assertedCreated.length) {
      notes.push(`${assertedCreated.length} asserted as created`);
    }
    return {
      ok: true,
      output:
        `${mentioned.length} file reference(s) in the claim all resolve: ${mentioned.join(", ")}` +
        (notes.length ? ` — ${notes.join("; ")}` : ""),
    };
  }

  if (builtin === "record-intact") {
    if (!ctx.archive) {
      return ctx.archivedBatches === 0 && (ctx.expectedArchiveFiles ?? []).length === 0
        ? { ok: true, output: "No context has been shed; nothing to audit." }
        : { ok: false, output: "Context was shed but no archive is configured." };
    }
    const entries = ctx.archive.list();
    // The archive is per PROJECT, not per session: reopening a project that
    // has shed before is normal and must not fail. What must never happen is
    // the archive holding LESS than this session put there.
    if (entries.length < ctx.archivedBatches) {
      return {
        ok: false,
        output:
          `This session archived ${ctx.archivedBatches} batch(es) but only ${entries.length} ` +
          `remain. The evidence chain is incomplete.`,
      };
    }
    for (const e of entries) {
      if (e.messages === 0) {
        return { ok: false, output: `Exuvia ${e.file} contains no readable messages.` };
      }
    }

    // The load-bearing part. Shedding moves write evidence out of memory and
    // into the archive. This session counted what it handed over; the archive
    // must still yield that much. The expectation comes from memory, not from
    // the archive, so a deleted or corrupted exuvia cannot hide itself by
    // also removing the thing it would be compared against.
    // Cross-session expectation: the journal recorded which exuviae were
    // written. Those files must still be there, whatever process is asking.
    const expectedFiles = ctx.expectedArchiveFiles ?? [];
    if (expectedFiles.length > 0) {
      const present = new Set(entries.map((e) => e.file));
      const missing = expectedFiles.filter((f) => !present.has(f));
      if (missing.length > 0) {
        return {
          ok: false,
          output:
            `The session log records ${expectedFiles.length} archived batch(es), but ` +
            `${missing.length} is missing from the archive: ${missing.join(", ")}. ` +
            `Earlier work in this project can no longer be proven.`,
        };
      }
    }

    // An evidence block that is there and cannot be read. Within the session
    // that shed it, the count below catches this; in every later session the
    // count it is compared against is zero, so a corrupted block was absent
    // evidence nobody reported — sixteen write records in this project's own
    // archive could be made unreadable and the check went on saying "archived
    // and readable". Project-wide, like the missing-file check above: an
    // archive holding less than was put there is never normal.
    const damaged = ctx.archive.damaged?.() ?? [];
    if (damaged.length > 0) {
      return {
        ok: false,
        output:
          `${damaged.length} archived batch(es) hold a write-evidence block that cannot be ` +
          `read: ${damaged.join(", ")}. The work recorded there can no longer be proven.`,
      };
    }

    const fromArchive = ctx.archive.ledger?.(ctx.sessionArchives) ?? [];
    const expected = ctx.expectedArchivedWrites ?? 0;
    if (fromArchive.length < expected) {
      return {
        ok: false,
        output:
          `This session archived ${expected} write record(s) but only ${fromArchive.length} ` +
          `remain recoverable. An exuvia was deleted or corrupted, so earlier work can no ` +
          `longer be proven.`,
      };
    }

    return {
      ok: true,
      output:
        entries.length === 0
          ? "No context has been shed; nothing to audit."
          : `${entries.length} shed batch(es) archived and readable · ` +
            `${fromArchive.length} write(s) still provable from the archive.`,
    };
  }

  return { ok: false, output: `unknown builtin: ${builtin}` };
}

export async function runCheck(check: Check, ctx: BarContext): Promise<CheckResult> {
  const t0 = Date.now();
  if (check.kind === "builtin") {
    // The only builtin that runs a command, so the only one that can await.
    const { ok, output } =
      check.builtin === "mutation"
        ? await mutationCheck(ctx, check.run ?? "", check.sample ?? 4, check.timeoutMs ?? 600_000)
        : runBuiltin(
            check.builtin,
            ctx,
            check.commentOnly === "allow",
            check.lcov,
            check.removals === "allow",
            check.outside === "allow",
          );
    return {
      name: check.name,
      ...(check.advisory ? { advisory: true } : {}),
      tags: check.tags,
      kind: "builtin",
      detail: check.builtin,
      ok,
      output: truncate(output),
      durationMs: Date.now() - t0,
    };
  }

  let exitCode = 0;
  let output = "";
  try {
    // Not execSync: a bar check is the longest thing molt runs (`npm test`,
    // two minutes by default) and running it synchronously froze the terminal
    // for its whole duration — including the ctrl+C that would have stopped it.
    const r = await runCommand(check.run, {
      cwd: ctx.cwd,
      timeoutMs: check.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      signal: ctx.signal,
    });
    output = `${r.stdout}${r.stderr}`;
    exitCode = r.code ?? 1;
    if (r.timedOut) {
      output = `timed out after ${check.timeoutMs}ms\n` + output;
      exitCode = 124;
    }
  } catch (e) {
    exitCode = 1;
    output = String(e);
  }
  const passed = exitCode === check.expectExit;
  return {
    name: check.name,
    ...(check.advisory ? { advisory: true } : {}),
    tags: check.tags,
    kind: "command",
    detail: check.run,
    ok: passed,
    exitCode,
    // A passing command's own stdout is usually noise — "ok", a dot per test —
    // so the evidence line says what molt actually established instead: this
    // command, this exit code, this long. A failure keeps its real output,
    // which is the whole point of a failure.
    output: passed
      ? `\`${check.run}\` exited ${exitCode} in ${Date.now() - t0}ms`
      : truncate(output),
    durationMs: Date.now() - t0,
  };
}

/** Run every check. All of them run, always — a partial bar is not a bar. */
/**
 * Results kept for as long as the files behind them have not moved.
 *
 * Four rules, and each one exists because breaking it would turn a cache into
 * a false verification:
 *
 *  1. **Memory only.** Never written to disk, never shared between processes.
 *     A cache that outlives the session outlives the environment it was true
 *     in — a dependency install, a toolchain change, a different branch.
 *  2. **Commands only.** Builtins are keyed on the session record, not the
 *     filesystem, so a fingerprint over watched files cannot say whether one
 *     is still true — the ledger moves under them while every watched file
 *     stands still. That is the reason, and it is not cost: the mutation
 *     builtin is the most expensive check molt runs. It buys its time back by
 *     reusing an earlier check's run of the same command (`priorRunOf`), which
 *     is sound for the opposite reason a cache would not be — it reuses a run
 *     that happened during this attempt rather than a claim that nothing moved
 *     since the last one.
 *  3. **The check itself is part of the key.** Editing a command invalidates
 *     it, so a bar that changed cannot reuse a result from the bar before it.
 *  4. **Said out loud.** A reused result is marked in the transcript, in the
 *     receipt, and in the log. A cached pass that looks like a fresh pass is
 *     the exact claim molt exists to refuse.
 */
export class CheckCache {
  private entries = new Map<string, { fingerprint: string; result: CheckResult }>();

  private static key(check: Check): string {
    return check.kind === "command"
      ? `${check.name}\u0000${check.run}\u0000${check.expectExit}\u0000${(check.watch ?? []).join(",")}`
      : `${check.name}\u0000builtin`;
  }

  get(check: Check, cwd: string): CheckResult | null {
    if (check.kind !== "command") return null;
    const entry = this.entries.get(CheckCache.key(check));
    if (!entry) return null;
    if (entry.fingerprint !== fingerprint(cwd, check.watch)) return null;
    return { ...entry.result, cached: true };
  }

  put(check: Check, cwd: string, result: CheckResult): void {
    if (check.kind !== "command") return;
    this.entries.set(CheckCache.key(check), {
      fingerprint: fingerprint(cwd, check.watch),
      result,
    });
  }
}

export async function runBar(bar: Bar, ctx: BarContext): Promise<BarResult> {
  const t0 = Date.now();
  // In order, one at a time. Checks share a working directory and routinely
  // build into it; running them concurrently would have them tripping over
  // each other's output, and a bar that fails depending on scheduling is worse
  // than a slow one.
  const results: CheckResult[] = [];
  const earlier: { check: Check; result: CheckResult }[] = [];
  // Declared once, from the bar itself, so a project that adds a coverage
  // check gets it protected without having to know it needed protecting.
  const protect = bar.checks
    .map((c) => (c.kind === "builtin" ? c.lcov : undefined))
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  // A cancelled bar is not a failed one. A check killed by ctrl+C exits
  // non-zero, and that read as the suite being red — refused receipt, failure
  // sent to the model, another request billed, and the killed result cached
  // as a failure until a watched file moved. Nothing a signal ended is a
  // verdict on the work, so it is neither cached nor allowed to stand as one.
  const aborted = () => ctx.signal?.aborted === true;
  for (const c of bar.checks) {
    if (aborted()) {
      results.push({
        name: c.name,
        ...(c.advisory ? { advisory: true } : {}),
        tags: c.tags,
        kind: c.kind,
        detail: c.kind === "command" ? c.run : c.builtin,
        ok: false,
        output: "not run — the bar was cancelled before this check",
        durationMs: 0,
      });
      continue;
    }
    const reused = ctx.cache?.get(c, ctx.cwd) ?? null;
    if (reused) {
      results.push(reused);
      earlier.push({ check: c, result: reused });
      continue;
    }
    const fresh = await runCheck(c, { ...ctx, earlier, protect });
    if (aborted()) {
      results.push({ ...fresh, ok: false, output: "cancelled while running\n" + fresh.output });
      continue;
    }
    ctx.cache?.put(c, ctx.cwd, fresh);
    results.push(fresh);
    earlier.push({ check: c, result: fresh });
  }
  const warnings = results.filter((r) => !r.ok && r.advisory);
  return {
    // An advisory failure is not a failed contract. It is still reported, and
    // still goes to the model — it just does not refuse the completion.
    ok: !aborted() && results.every((r) => r.ok || r.advisory),
    ...(aborted() ? { cancelled: true } : {}),
    ...(warnings.length ? { warnings } : {}),
    results,
    durationMs: Date.now() - t0,
  };
}

/**
 * The message the model sees when it tried to finish and could not. Only
 * failures are included, with their real output — telling the model "a
 * check failed" without the error is how you get a second wrong guess.
 */
export function formatBarFailure(result: BarResult, attempt: number, maxAttempts: number): string {
  // Ordered, not just listed.
  //
  // The failures arrived flat, and a model with one attempt left picks the
  // one it reads first. A local 30B read "a file you wrote is no longer on
  // disk" before "your test suite is red", spent its last attempt on the
  // scratch file it could not delete, and never touched the assertion it had
  // broken — the one failure it could actually have fixed.
  //
  // A command check carries the project's own output: a compiler error, a
  // failing test, a line number. A builtin reports molt's bookkeeping about
  // the session. When both fail, the first is the one to act on, so it goes
  // first and says so.
  const all = result.results.filter((r) => !r.ok && !r.advisory);
  const commands = all.filter((r) => r.kind === "command");
  const builtins = all.filter((r) => r.kind !== "command");
  const failed = [...commands, ...builtins];
  const lines = [
    `[molt] You indicated the task is complete, but ${failed.length} of ${result.results.length} ` +
      `checks in .molt/done.yml did not pass. This is attempt ${attempt} of ${maxAttempts}.`,
    "",
    "Do not claim completion again until these pass. Fix the underlying problem;",
    "do not modify .molt/done.yml to make the checks pass.",
    "",
  ];
  if (commands.length && builtins.length) {
    lines.push(
      `Start with ${commands.map((r) => `\`${r.name}\``).join(", ")} — that is your project's own ` +
        `output. The rest is molt's bookkeeping about this session and is usually downstream of it.`,
      "",
    );
  }
  for (const r of failed) {
    lines.push(`--- FAILED: ${r.name} (${r.detail})`);
    if (r.exitCode !== undefined) lines.push(`exit code: ${r.exitCode}`);
    lines.push(r.output.trim() || "(no output)");
    lines.push("");
  }
  return lines.join("\n");
}
