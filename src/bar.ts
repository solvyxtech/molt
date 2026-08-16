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

export const BUILTINS: BuiltinCheck[] = ["files-changed", "record-intact"];

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
  /** Every write molt actually performed, with before/after hashes. */
  ledger: LedgerEntry[];
  archive?: ArchiveLike;
  /** How many batches the transcript believes it has archived. */
  archivedBatches: number;
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

    if (hasBuiltin) {
      const builtin = String(c.builtin) as BuiltinCheck;
      if (!BUILTINS.includes(builtin)) {
        throw new BarError(
          `done.yml: check "${name}" uses unknown builtin "${builtin}". Known: ${BUILTINS.join(", ")}.`,
        );
      }
      return { name, kind: "builtin", builtin, tags };
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
  #   files-changed   at least one file was actually modified, and every
  #                   write molt performed is still on disk, byte for byte
  #   record-intact   the shed archive is complete and readable, so the
  #                   evidence behind these results can be audited later
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
`;

export function writeDefaultBar(cwd: string): string {
  const dir = join(cwd, ".molt");
  mkdirSync(dir, { recursive: true });
  const p = barPath(cwd);
  if (!existsSync(p)) writeFileSync(p, DEFAULT_BAR, "utf8");
  return p;
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

/** Every path the model asked to write, across the entire session record. */
export function claimedWrites(record: Msg[]): string[] {
  const paths: string[] = [];
  for (const m of record) {
    for (const c of m.tool_calls ?? []) {
      if (c.function.name !== "write_file") continue;
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

  if (builtin === "record-intact") {
    if (!ctx.archive) {
      return ctx.archivedBatches === 0
        ? { ok: true, output: "No context has been shed; nothing to audit." }
        : { ok: false, output: "Context was shed but no archive is configured." };
    }
    const entries = ctx.archive.list();
    if (entries.length !== ctx.archivedBatches) {
      return {
        ok: false,
        output:
          `Archive holds ${entries.length} batch(es) but the session shed ${ctx.archivedBatches}. ` +
          `The evidence chain is incomplete.`,
      };
    }
    for (const e of entries) {
      if (e.messages === 0) {
        return { ok: false, output: `Exuvia ${e.file} contains no readable messages.` };
      }
    }
    return {
      ok: true,
      output:
        entries.length === 0
          ? "No context has been shed; nothing to audit."
          : `${entries.length} shed batch(es) archived and readable.`,
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
  return {
    name: check.name,
    tags: check.tags,
    kind: "command",
    detail: check.run,
    ok: exitCode === check.expectExit,
    exitCode,
    output: truncate(output),
    durationMs: Date.now() - t0,
  };
}

/** Run every check. All of them run, always — a partial bar is not a bar. */
export function runBar(bar: Bar, ctx: BarContext): BarResult {
  const t0 = Date.now();
  const results = bar.checks.map((c) => runCheck(c, ctx));
  return { ok: results.every((r) => r.ok), results, durationMs: Date.now() - t0 };
}

/**
 * The message the model sees when it tried to finish and could not. Only
 * failures are included, with their real output — telling the model "a
 * check failed" without the error is how you get a second wrong guess.
 */
export function formatBarFailure(result: BarResult, attempt: number, maxAttempts: number): string {
  const failed = result.results.filter((r) => !r.ok);
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
