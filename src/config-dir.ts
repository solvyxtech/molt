/**
 * Where molt keeps its own configuration.
 *
 * Its own module so `providers.ts` can re-export `defaultConfigDir` without
 * other modules reaching into providers just for the path. That used to matter
 * when a second backend also needed the directory and importing providers for
 * it created a load-time cycle; keeping the path here avoids that class of
 * deadlock even after those backends are gone.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "./env.js";

export function defaultConfigDir(): string {
  // `MOLT_CONFIG_DIR` relocates the whole of molt's config: keys, endpoint,
  // prices. It exists because without it the test suite writes to the real
  // one — a TUI test that mounts the app triggers a pricing refresh, and
  // `savePricing` had nowhere else to go, so running `npm test` rewrote the
  // developer's stored endpoint and left `priceModel: "test-model"` behind.
  // A test that edits the machine it runs on is not a test you can trust
  // twice, and this was doing it on every run.
  const override = env("CONFIG_DIR")?.trim();
  if (override) return override;
  // Maat Agent keeps its config in ~/.config/maat. Someone who set molt up
  // before the rename keeps theirs where it is — keys, endpoint and prices
  // are not moved under them.
  const maat = join(homedir(), ".config", "maat");
  const molt = join(homedir(), ".config", "molt");
  return !existsSync(maat) && existsSync(molt) ? molt : maat;
}

