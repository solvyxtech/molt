/**
 * Every server you have pointed molt at.
 *
 * The CLI's config remembers exactly one endpoint — the last one `/login` or
 * `/model` settled on — because a terminal session points at one thing at a
 * time and re-pointing it is a sentence you type. A window is not like that.
 * You have a box under the desk, maybe a second one on the network, and the
 * hosted providers, and you expect to see all of them in one list.
 *
 * Reported as "the custom models just say other; I need the local models to
 * also show up". They could not: whichever local server was not the stored one
 * was never asked, and a source that answered nothing was dropped from the
 * list rather than shown with its reason. So the only group left was the
 * literal "other".
 *
 * Kept beside molt's own config rather than inside it, so nothing here changes
 * what the CLI reads or writes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir } from "../src/providers.js";

/** Where the endpoint list lives. `MOLT_CONFIG_DIR` moves it, as it moves
 *  everything else molt stores — see defaultConfigDir. */
export function configDir(): string {
  return defaultConfigDir();
}

export type Endpoint = { url: string; lastModel?: string; seen: string };

const FILE = "desktop-endpoints.json";
/** Enough for a laptop, a desk machine, a server and a few experiments. */
const MAX = 12;

/** Trailing slashes are not a difference between two servers. */
export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function path(dir: string): string {
  return join(dir, FILE);
}

export function readEndpoints(dir = configDir()): Endpoint[] {
  try {
    const raw = JSON.parse(readFileSync(path(dir), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e): e is Endpoint => !!e && typeof (e as Endpoint).url === "string")
      .map((e) => ({ ...e, url: normalizeUrl(e.url) }))
      .filter((e) => e.url.length > 0);
  } catch {
    // No file, unreadable file, or malformed JSON. None of those is worth
    // failing a window over — the list is a convenience, not a record.
    return [];
  }
}

/**
 * Remember an endpoint, newest first.
 *
 * Idempotent by URL, so opening the same workspace twice does not grow the
 * list, and re-selecting an old server promotes it rather than duplicating it.
 */
export function rememberEndpoint(
  url: string,
  lastModel?: string,
  dir = configDir(),
  now = new Date().toISOString(),
): Endpoint[] {
  const clean = normalizeUrl(url);
  if (!clean) return readEndpoints(dir);
  const rest = readEndpoints(dir).filter((e) => e.url !== clean);
  const next = [{ url: clean, lastModel, seen: now }, ...rest].slice(0, MAX);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path(dir), JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    /* an unwritable config dir must not stop the app opening */
  }
  return next;
}

export function forgetEndpoint(url: string, dir = configDir()): Endpoint[] {
  const clean = normalizeUrl(url);
  const next = readEndpoints(dir).filter((e) => e.url !== clean);
  try {
    if (existsSync(path(dir))) writeFileSync(path(dir), JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    /* as above */
  }
  return next;
}
