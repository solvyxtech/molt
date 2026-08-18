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
import { execSync } from "node:child_process";
import { proposeBar, type Detected } from "./detect.js";
import { fingerprint } from "./files.js";
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
const OUTPUT_MAX = 2000;

export const BUILTINS: BuiltinCheck[] = ["files-changed", "record-intact", "claims-grounded"];

/**
 * Conventional tags. Not enforced — a bar may use any label — but these are
 * the ones molt's own flags understand, and the ones worth standardising on
 * if other harnesses ever read this file.
 */
export const CONVENTIONAL_TAGS = ["fast", "slow", "ci", "local", "manual"] as const;

export class BarError extends Error {}

export type BarContext = {
  cwd: string;
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
   * Archive files this project's session logs say exist. Survives process
   * restart, so a deleted exuvia is caught tomorrow as well as today.
   */
  expectedArchiveFiles?: string[];
  /** The completion claim being judged, when there is one. */
  claim?: string;
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
    if (hasRun === hasBuiltin) {
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
      return { name, kind: "builtin", builtin, tags, ...advisory };
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
export const DEFAULT_BAR = `# What "done" means in this project.
#
# molt will not emit a final answer while any check below fails. Checks are
# ordinary shell commands, so anything your CI can run, your agent must pass.
#
# Delete what does not apply. An empty or missing file disables the proof
# loop entirely, which molt will warn you about on every launch.

version: 1

checks:
  # - name: types
  #   run: npm run typecheck
  #
  # - name: tests
  #   run: npm test
  #   timeout: 300

  # Builtins molt runs itself, against the full session record —
  # including context that has already been shed.
  #
  #   files-changed    at least one file was actually modified, and every
  #                    write molt performed is still on disk, byte for byte
  #   record-intact    write evidence for this session is still recoverable
  #                    from the archive, so results stay auditable later
  #   claims-grounded  every file the model names in its final answer either
  #                    exists or was written here — no invented files
  #
  # Tags are optional selection labels. molt understands --only and --skip,
  # so slow checks can live in the file for CI without paying for them on
  # every completion attempt locally. An untagged check always runs.
  - name: work-landed
    builtin: files-changed
    tags: [fast]

  - name: record-intact
    builtin: record-intact
    tags: [fast]

  - name: claims-grounded
    builtin: claims-grounded
    tags: [fast]
`;

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

function truncate(s: string, n = OUTPUT_MAX): string {
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= n) return s;
  return Buffer.from(s, "utf8").subarray(0, n).toString("utf8") + `\n[molt: truncated ${bytes - n} bytes]`;
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
  const text = claim.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, " ").replace(/\bwww\.\S+/gi, " ");

  const add = (raw: string) => {
    const cleaned = raw.replace(/^[`'"(\[]+|[`'".,;:)\]]+$/g, "").trim();
    if (!cleaned || cleaned.length > 200) return;
    if (!/^[\w./@-]+$/.test(cleaned)) return;
    if (!/\.[A-Za-z][\w]{0,9}$/.test(cleaned)) return; // needs a file extension
    if (/^\d+\.\d+$/.test(cleaned)) return; // version numbers
    if (cleaned.startsWith("http")) return;
    if (NOT_FILENAMES.has(cleaned.toLowerCase())) return;
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
 * Every path the model asked to change, across the entire session record.
 *
 * Both write tools count. When `edit_file` arrived this still looked only for
 * `write_file`, so a session whose edits all failed reported "no file was
 * modified" instead of naming the edits that did not land — a correct refusal
 * with a misleading reason, which is its own kind of wrong.
 */
export function claimedWrites(record: Msg[]): string[] {
  const paths: string[] = [];
  for (const m of record) {
    for (const c of m.tool_calls ?? []) {
      if (c.function.name !== "write_file" && c.function.name !== "edit_file") continue;
      try {
        const args = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
        if (typeof args.path === "string") paths.push(args.path);
      } catch {
        /* malformed args are visible in the record; not this check's job */
      }
    }
  }
  return paths;
}

function runBuiltin(builtin: BuiltinCheck, ctx: BarContext): { ok: boolean; output: string } {
  if (builtin === "files-changed") {
    const attempted = claimedWrites(ctx.record);
    if (ctx.ledger.length === 0) {
      return {
        ok: false,
        output:
          attempted.length === 0
            ? "No file was modified in this session. Nothing was done that can be shown."
            : `${attempted.length} write(s) appear in the record but none landed on disk ` +
              `(denied, errored, or never executed): ${attempted.join(", ")}`,
      };
    }
    const problems: string[] = [];
    for (const entry of ctx.ledger) {
      const abs = resolve(ctx.cwd, entry.path);
      const now = sha256File(abs);
      if (now === null) {
        problems.push(`${entry.path}: written during this session but no longer on disk`);
        continue;
      }
      if (now !== entry.after) {
        problems.push(`${entry.path}: contents changed since molt wrote it`);
        continue;
      }
      if (entry.before === entry.after) {
        problems.push(`${entry.path}: rewritten with identical contents — no actual change`);
      }
    }
    if (problems.length) return { ok: false, output: problems.join("\n") };
    return {
      ok: true,
      output:
        `${ctx.ledger.length} file(s) modified and verified byte-for-byte on disk` +
        (attempted.length > ctx.ledger.length
          ? ` (${attempted.length - ctx.ledger.length} further write(s) in the record did not land)`
          : ""),
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
    return {
      ok: true,
      output: `${mentioned.length} file reference(s) in the claim all resolve: ${mentioned.join(", ")}`,
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

    const fromArchive = ctx.archive.ledger?.() ?? [];
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

export function runCheck(check: Check, ctx: BarContext): CheckResult {
  const t0 = Date.now();
  if (check.kind === "builtin") {
    const { ok, output } = runBuiltin(check.builtin, ctx);
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
    output = execSync(check.run, {
      cwd: ctx.cwd,
      timeout: check.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number | null; signal?: string };
    exitCode = typeof err.status === "number" ? err.status : 1;
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (err.signal === "SIGTERM") {
      output = `timed out after ${check.timeoutMs}ms\n` + output;
      exitCode = 124;
    }
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
 *  2. **Commands only.** Builtins read the session record rather than the
 *     filesystem, and they are cheap. Nothing to save and everything to get
 *     wrong.
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

export function runBar(bar: Bar, ctx: BarContext): BarResult {
  const t0 = Date.now();
  const results = bar.checks.map((c) => {
    const reused = ctx.cache?.get(c, ctx.cwd) ?? null;
    if (reused) return reused;
    const fresh = runCheck(c, ctx);
    ctx.cache?.put(c, ctx.cwd, fresh);
    return fresh;
  });
  const warnings = results.filter((r) => !r.ok && r.advisory);
  return {
    // An advisory failure is not a failed contract. It is still reported, and
    // still goes to the model — it just does not refuse the completion.
    ok: results.every((r) => r.ok || r.advisory),
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
  const failed = result.results.filter((r) => !r.ok && !r.advisory);
  const lines = [
    `[molt] You indicated the task is complete, but ${failed.length} of ${result.results.length} ` +
      `checks in .molt/done.yml did not pass. This is attempt ${attempt} of ${maxAttempts}.`,
    "",
    "Do not claim completion again until these pass. Fix the underlying problem;",
    "do not modify .molt/done.yml to make the checks pass.",
    "",
  ];
  for (const r of failed) {
    lines.push(`--- FAILED: ${r.name} (${r.detail})`);
    if (r.exitCode !== undefined) lines.push(`exit code: ${r.exitCode}`);
    lines.push(r.output.trim() || "(no output)");
    lines.push("");
  }
  return lines.join("\n");
}
