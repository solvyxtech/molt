/**
 * Requirement sign-out: before a claim is judged, each stated requirement is
 * put to the model next to the commands it ran that could have exercised it.
 *
 * The acceptance checks are hidden, so a model that finishes has never gone
 * down the task's list and run the deliverable against each line. Local runs
 * claimed "verified" on an access-log summary that said `4xx: 41` where the
 * log held 40, and on a redaction task — both errors that rerunning each
 * stated requirement catches. Telling the model to "re-read every
 * requirement" gained nothing; this lists them, with what it has and has not
 * run, and asks once.
 *
 * Only the task's own words and the model's own commands appear here. The
 * hidden check commands never do.
 */

export const REQUIREMENTS_MAX = 10;
export const REQUIREMENT_MAX_CHARS = 200;
const CALLS_PER_REQUIREMENT = 3;
const CALL_SHOWN_CHARS = 110;

const STOP = new Set(
  ("the and for with that this from into must should will have has not are was were all any each every only " +
    "than then them they its it's can could would use used using file files when where which what also but " +
    "per via out one two").split(" "),
);

/** Clean, dedupe and cap a list of requirement quotes. */
export function normalizeRequirements(raw: readonly unknown[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw ?? []) {
    if (typeof r !== "string") continue;
    const q = r.replace(/\s+/g, " ").trim().slice(0, REQUIREMENT_MAX_CHARS);
    const key = q.toLowerCase();
    if (q.length < 4 || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= REQUIREMENTS_MAX) break;
  }
  return out;
}

/** Path-like and distinctive words of a requirement, lowercased. */
function keywords(req: string): { paths: string[]; words: string[] } {
  const toks = req.toLowerCase().match(/[a-z0-9_][a-z0-9_./*-]*[a-z0-9_*]|[a-z0-9_]/g) ?? [];
  const paths = toks.filter((t) => /[./]/.test(t) && !/^\d+(\.\d+)?$/.test(t));
  const words = toks.filter((t) => !paths.includes(t) && (t.length >= 3 || /\d/.test(t)) && !STOP.has(t));
  return { paths, words: [...new Set(words)] };
}

/** Does this command plausibly exercise this requirement? */
export function exercises(req: string, command: string): boolean {
  const cmd = command.toLowerCase();
  const { paths, words } = keywords(req);
  if (paths.some((p) => cmd.includes(p))) return true;
  if (!words.length) return false;
  const hits = words.filter((w) => cmd.includes(w));
  // A figure or code (`4xx`, `365`) names the requirement on its own; plain
  // words ("report", "count") are everywhere, so two of them are needed.
  return hits.some((w) => /\d/.test(w)) || hits.length >= Math.min(words.length, 2);
}

export type SignOut = {
  requirements: string[];
  matched: { requirement: string; calls: string[] }[];
  unexercised: string[];
};

/**
 * Pair requirements with this turn's commands. `did` is the engine's record
 * of what the model ran, one line each (`bash <command>`); only commands that
 * were allowed to run count, since reading a file does not run anything.
 */
export function signOut(requirements: string[], did: readonly string[]): SignOut {
  const commands = did.filter((l) => l.startsWith("bash ")).map((l) => l.slice(5));
  const matched: SignOut["matched"] = [];
  const unexercised: string[] = [];
  for (const requirement of requirements) {
    const calls = commands.filter((c) => exercises(requirement, c));
    if (calls.length) matched.push({ requirement, calls });
    else unexercised.push(requirement);
  }
  return { requirements, matched, unexercised };
}

const shown = (c: string) => (c.length > CALL_SHOWN_CHARS ? `${c.slice(0, CALL_SHOWN_CHARS)}...` : c);

/** The one message that goes to the model. */
export function signOutMessage(s: SignOut): string {
  const by = new Map(s.matched.map((m) => [m.requirement, m.calls]));
  const lines = s.requirements.map((r, i) => {
    const calls = by.get(r);
    return calls
      ? `${i + 1}. "${r}" - you ran: ${calls.slice(-CALLS_PER_REQUIREMENT).map((c) => `\`${shown(c)}\``).join("; ")}`
      : `${i + 1}. "${r}" - not yet run`;
  });
  return (
    "[Maat: before this is checked, sign out each requirement the task states. Here is each one, with the " +
    "commands you ran this turn that touch it:\n" +
    lines.join("\n") +
    "\nFor every one marked not yet run, run the deliverable now and compare what it produces with the " +
    "requirement (or say in a line why it cannot be checked by running). For the others, recheck any figure " +
    "or output you reported against the real data. Fix anything that fails, then give your final answer again.]"
  );
}
