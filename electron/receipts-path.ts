/**
 * Containment for a receipt the renderer asked to read.
 *
 * The page is untrusted — it displays model output — so a path it sends is
 * treated as a name, not as a location. This is the whole check; the handler
 * must not have a second opinion.
 *
 * `pathApi` is injectable so a test can ask what Windows would do without
 * running on Windows. The default is this process's path module.
 */
import { resolve, sep } from "node:path";

export type PathApi = {
  resolve: (...parts: string[]) => string;
  sep: string;
};

const native: PathApi = { resolve, sep };

/**
 * Resolve `file` inside `receiptsDir`, or null if it would leave.
 *
 * The historical check was `p.startsWith(dir + "/")`. On Windows `resolve()`
 * returns backslash paths, so a legitimate receipt never matched and every
 * read returned null — the Receipts tab was empty on the platform where a
 * path-escape is most worth stopping.
 */
export function resolveReceipt(
  receiptsDir: string,
  file: unknown,
  pathApi: PathApi = native,
): string | null {
  if (typeof file !== "string" || file.length === 0) return null;
  const dir = pathApi.resolve(receiptsDir);
  const p = pathApi.resolve(dir, file);
  // The platform's own separator. A hardcoded "/" never matched a Windows
  // path, so every legitimate receipt read returned null there — and the
  // separator is required, or a sibling directory sharing the prefix
  // (receipts-evil) would be accepted as if it were inside.
  if (p === dir || !p.startsWith(dir + pathApi.sep)) return null;
  return p;
}

/** The filename of a receipt path, whichever separator the engine used. */
export function receiptBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
