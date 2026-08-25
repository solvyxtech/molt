/**
 * Caps for records the renderer asked to read whole.
 *
 * `journal:read` used to parse every line of the session's JSONL and send the
 * array across IPC. That is cheap at a hundred entries and the thing that
 * freezes the window at a few thousand — which is where a long desktop
 * session actually lands, not in the session stream.
 */
export const JOURNAL_IPC_CAP = 2000;

/** The newest `cap` non-empty lines. */
export function tailLines(text: string, cap: number): string[] {
  const lines = text.split("\n").filter(Boolean);
  return lines.length <= cap ? lines : lines.slice(-cap);
}

/**
 * What `journal:read` actually sends.
 *
 * Parsing lives here so a test that overflows the cap is a test of the
 * handler, not of a helper the handler forgot to call.
 */
export function parseJournal(text: string, cap = JOURNAL_IPC_CAP): unknown[] {
  return tailLines(text, cap).map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return { kind: "unparsed", line };
    }
  });
}

/**
 * What `/init` should say.
 *
 * `writeDefaultBar` returns an object either way. Treating that object as a
 * boolean made every call report that it had just written the file, including
 * the call that left an existing bar alone.
 */
export function barInitText(existed: boolean, file: string, checks: number): string {
  return existed
    ? `${file} already exists — left alone`
    : `wrote ${file} — ${checks} check(s). Edit it to match this project.`;
}

/**
 * May this command run while a turn is in flight?
 *
 * Three commands change session state and must wait for the turn to end. The
 * guard matched on the bare name, which also caught `/shed --explain` — the
 * read-only form that computes a shed plan and returns it without touching the
 * transcript, and the one question most worth asking *while* something is
 * running and the context is growing under you.
 */
export function mutatesSession(name: string, arg: string): boolean {
  if (name === "/regrow" || name === "/prove") return true;
  if (name !== "/shed") return false;
  return !/^(--explain|explain)$/.test(arg.trim());
}
