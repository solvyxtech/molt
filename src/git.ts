/**
 * Git, as the place a verified change goes — and as the place an unverified
 * one is taken back from.
 *
 * molt already decides whether a turn met the bar. Until now it did nothing
 * with the answer: a passing turn and a failing turn both left the same dirty
 * working tree, and telling them apart afterwards meant reading a receipt and
 * remembering which files it named. Karpathy's `autoresearch` closes exactly
 * this loop — run, read one immutable judge, `git commit` if it improved and
 * `git reset` if it did not — and its whole value comes from the loop being
 * closed rather than from the judge being clever.
 *
 * This is that loop's second half, with molt's bar as the judge:
 *
 *   - the bar is met  → the change is committed, with the receipt in the
 *     message and a `Molt-Verified` trailer naming the evidence;
 *   - the bar is not met → the files THIS TURN wrote are put back the way
 *     they were, and nothing else is touched.
 *
 * Three rules the implementation does not bend, because a tool that loses
 * someone's work has no second chance to be trusted:
 *
 *  1. **Only paths molt wrote.** Every add and every restore is an explicit
 *     path from the session ledger. There is no `git add -A` here and there
 *     never will be — another session's edits, or the user's own, are not
 *     molt's to stage or to revert.
 *  2. **Restore from the pre-turn snapshot, not from HEAD.** `git stash
 *     create` writes a commit object for the working tree without touching
 *     the tree, so a file the user had already edited before the turn comes
 *     back as the user had it, not as HEAD has it.
 *  3. **A file that was untracked before the turn is left alone.** It is not
 *     in the snapshot, so there is nothing to restore it *to*, and deleting
 *     it would destroy work git never had a copy of. It is reported as kept.
 */
import { runCommand } from "./run.js";

/**
 * The trailer that marks a commit as molt's.
 *
 * `/undo` refuses to touch a commit without it. An undo that could rewind a
 * human's commit because it happened to be last is not an undo, it is a
 * different and much worse tool.
 */
export const MOLT_TRAILER = "Molt-Verified";

const GIT_TIMEOUT_MS = 30_000;

export type GitRun = { ok: boolean; stdout: string; stderr: string };

/** Single-quote an argument for the shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function git(cwd: string, args: string[]): Promise<GitRun> {
  const r = await runCommand(`git ${args.map(shellQuote).join(" ")}`, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return { ok: r.code === 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

/** Is this directory inside a git work tree? */
export async function isRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout === "true";
}

/** The current commit, or null in a repository with no commits yet. */
export async function headSha(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "HEAD"]);
  return r.ok && r.stdout ? r.stdout : null;
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok && r.stdout ? r.stdout : null;
}

/**
 * A commit object holding the working tree as it is right now, without
 * changing the tree, the index, or the stash list.
 *
 * `git stash create` is the whole trick: it gives a ref that can be read from
 * later. On a clean tree it writes nothing and returns empty, in which case
 * HEAD already describes the tree and is returned instead.
 */
export async function snapshot(cwd: string): Promise<string | null> {
  const created = await git(cwd, ["stash", "create"]);
  if (created.ok && created.stdout) return created.stdout;
  return headSha(cwd);
}

/** Every path a ref holds, for deciding what can be restored from it. */
export async function pathsIn(cwd: string, ref: string): Promise<Set<string>> {
  const r = await git(cwd, ["ls-tree", "-r", "--name-only", ref]);
  if (!r.ok) return new Set();
  return new Set(r.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
}

export type LedgerLike = { path: string; before: string | null };

export type RevertPlan = {
  /** Existed before the turn and the snapshot has it: check it back out. */
  restore: string[];
  /** This turn created it: delete it. */
  remove: string[];
  /** Existed, but git never had a copy. Left exactly as it is. */
  keep: string[];
};

/**
 * What undoing a turn's writes would do, decided before anything is touched.
 *
 * Pure, and exported, because this is the part that can destroy work: the
 * question "was this file created by the turn, or did it exist and get
 * edited?" is answerable from the ledger alone (`before === null` means it
 * did not exist), and it must be answered the same way every time, not
 * inferred from whatever the disk looks like afterwards.
 *
 * A path written more than once resolves toward creation: if any write to it
 * found no file there, the turn is what put it on disk, whatever it did to it
 * afterwards.
 */
export function revertPlan(entries: LedgerLike[], inSnapshot: (path: string) => boolean): RevertPlan {
  const created = new Map<string, boolean>();
  for (const e of entries) {
    created.set(e.path, (created.get(e.path) ?? false) || e.before === null);
  }
  const plan: RevertPlan = { restore: [], remove: [], keep: [] };
  for (const [path, wasCreated] of [...created.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (wasCreated) plan.remove.push(path);
    else if (inSnapshot(path)) plan.restore.push(path);
    else plan.keep.push(path);
  }
  return plan;
}

export type RestoreResult = {
  restored: string[];
  removed: string[];
  kept: string[];
  failed: { path: string; reason: string }[];
};

/** Carry out a revert plan against a snapshot ref. */
export async function restore(cwd: string, ref: string, plan: RevertPlan): Promise<RestoreResult> {
  const out: RestoreResult = { restored: [], removed: [], kept: [...plan.keep], failed: [] };
  for (const path of plan.restore) {
    const r = await git(cwd, ["checkout", ref, "--", path]);
    if (r.ok) out.restored.push(path);
    else out.failed.push({ path, reason: r.stderr || "checkout failed" });
  }
  for (const path of plan.remove) {
    const r = await runCommand(`rm -f -- ${shellQuote(path)}`, { cwd, timeoutMs: GIT_TIMEOUT_MS });
    if (r.code === 0) out.removed.push(path);
    else out.failed.push({ path, reason: (r.stderr || "").trim() || "could not remove" });
  }
  return out;
}

export type CommitInput = {
  /** What was asked, used as the subject line. */
  task: string;
  /** The receipt this commit's evidence lives in. */
  receipt?: string;
  /** Checks the bar ran and passed. */
  checks?: string[];
  session?: string;
  attempts?: number;
};

/** How long a commit subject may run before it is cut. */
export const SUBJECT_MAX = 72;

/**
 * The commit message for a verified change.
 *
 * aider asks a model for a commit message. molt already has something better
 * and cheaper: the receipt. The subject is what was asked, and the body is
 * what was checked and where the evidence is — so `git log` carries the same
 * claim the receipt does, and the trailer makes the commit findable and
 * safely undoable.
 *
 * Subject only from the first line of the request, because a request can be
 * a page long, and a commit subject that runs to a paragraph is a commit
 * nobody can read in a log.
 */
export function commitMessage(input: CommitInput): string {
  const first = (input.task.split("\n").find((l) => l.trim()) ?? "change").trim();
  const subject = first.length > SUBJECT_MAX ? `${first.slice(0, SUBJECT_MAX - 1).trimEnd()}…` : first;
  const lines = [subject, ""];
  lines.push(
    input.checks?.length
      ? `Verified by ${input.checks.length} check(s): ${input.checks.join(", ")}.`
      : "Verified: the bar was met.",
  );
  if (input.attempts && input.attempts > 1) {
    lines.push(`Met on attempt ${input.attempts}.`);
  }
  lines.push("");
  lines.push(`${MOLT_TRAILER}: ${input.receipt ?? "(no receipt)"}`);
  if (input.session) lines.push(`Molt-Session: ${input.session}`);
  return lines.join("\n");
}

export type CommitResult =
  | { ok: true; sha: string; files: string[] }
  | { ok: false; reason: string };

/**
 * Stage exactly these paths and commit them.
 *
 * Explicit paths, never `-A`: this repository has had two sessions editing it
 * at once, and a commit that swept up the other one's half-finished work
 * would be a far worse failure than not committing at all.
 */
export async function commitPaths(
  cwd: string,
  paths: string[],
  message: string,
): Promise<CommitResult> {
  const unique = [...new Set(paths)].sort();
  if (!unique.length) return { ok: false, reason: "nothing to commit — no files were written" };
  const add = await git(cwd, ["add", "--", ...unique]);
  if (!add.ok) return { ok: false, reason: add.stderr || "git add failed" };
  // Staged-and-identical is not a failure worth a scary message: it is what
  // happens when a turn rewrites a file to what it already said.
  const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
  if (staged.ok && !staged.stdout) {
    return { ok: false, reason: "nothing to commit — the files are unchanged" };
  }
  const commit = await git(cwd, ["commit", "-m", message, "--only", "--", ...unique]);
  if (!commit.ok) return { ok: false, reason: commit.stderr || commit.stdout || "git commit failed" };
  const sha = await headSha(cwd);
  return { ok: true, sha: sha ?? "", files: unique };
}

export type LastCommit = { sha: string; subject: string; body: string; isMolt: boolean };

/** The most recent commit, and whether molt is the one that made it. */
export async function lastCommit(cwd: string): Promise<LastCommit | null> {
  const r = await git(cwd, ["log", "-1", "--format=%H%x1f%s%x1f%b"]);
  if (!r.ok || !r.stdout) return null;
  const [sha = "", subject = "", body = ""] = r.stdout.split("\x1f");
  return { sha, subject, body, isMolt: new RegExp(`^${MOLT_TRAILER}:`, "m").test(body) };
}

export type UndoResult =
  | { ok: true; sha: string; subject: string }
  | { ok: false; reason: string };

/**
 * Undo molt's last commit — the commit, not the work.
 *
 * aider's `/undo` runs `git reset --hard`, which throws the change away as
 * well as the commit. This uses `--mixed`: HEAD moves back, the files stay
 * exactly as they are, and the work is yours to keep, amend or discard. An
 * undo that silently deletes a change is the one operation in this whole
 * program that could destroy something the bar had already verified.
 *
 * Refuses a commit without the trailer. "The last commit" and "the last
 * commit molt made" are different things, and only the second is molt's to
 * rewind.
 */
export async function undoLast(cwd: string): Promise<UndoResult> {
  if (!(await isRepo(cwd))) return { ok: false, reason: "not a git repository" };
  const last = await lastCommit(cwd);
  if (!last) return { ok: false, reason: "no commits to undo" };
  if (!last.isMolt) {
    return {
      ok: false,
      reason: `the last commit is not molt's (${last.sha.slice(0, 8)} ${last.subject}) — refusing to rewind someone else's work`,
    };
  }
  const parent = await git(cwd, ["rev-parse", "--verify", "HEAD~1"]);
  const reset = parent.ok
    ? await git(cwd, ["reset", "--mixed", "HEAD~1"])
    : // The first commit in a repository has no parent to reset onto.
      await git(cwd, ["update-ref", "-d", "HEAD"]);
  if (!reset.ok) return { ok: false, reason: reset.stderr || "git reset failed" };
  return { ok: true, sha: last.sha, subject: last.subject };
}
