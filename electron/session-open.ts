/**
 * Whether a workspace may be opened right now.
 *
 * Split out of the handler so it can be asked without an Electron window, and
 * so the two reasons it can refuse are stated once.
 *
 * The first is a race: `session:run` reads the module-level session once and
 * streams from it, while `session:open` could replace it mid-flight. Receipts
 * and journal entries for the running turn would then be written against a
 * workspace it never touched — evidence filed under the wrong project, which
 * is worse than no evidence.
 *
 * The second is ordinary input handling. The renderer displays untrusted model
 * output; a path it sends is a claim, not a fact.
 */
import { statSync } from "node:fs";

export type OpenRequest = { cwd: string; model: string; baseUrl: string; apiKey?: string };

/** The reason to refuse, or null to go ahead. */
export function sessionOpenReject(opts: unknown, running: boolean): string | null {
  if (running) {
    return "a turn is running — stop it before opening another workspace";
  }
  if (!opts || typeof opts !== "object") return "no such directory: ";
  const cwd = (opts as OpenRequest).cwd;
  if (typeof cwd !== "string" || cwd.length === 0) return "no such directory: ";
  let st;
  try {
    st = statSync(cwd);
  } catch {
    return `no such directory: ${cwd}`;
  }
  // A file is a real path that is not a workspace. Saying "no such directory"
  // for one sends you looking for a typo that is not there.
  if (!st.isDirectory()) return `not a directory: ${cwd}`;
  return null;
}
