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
