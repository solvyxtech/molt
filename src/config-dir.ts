/**
 * Where molt keeps its own configuration.
 *
 * Its own module because both `providers.ts` and `agy.ts` need it, and having
 * `agy.ts` reach into `providers.ts` for it made a cycle: providers imports
 * the Antigravity URL to list it as a preset, agy imported providers for this
 * one function, and the pair deadlocked at load with "Cannot access 'AGY_URL'
 * before initialization" — a failure that reads as a bug in the backend and is
 * really one in the import graph. `providers.ts` re-exports it, so every
 * existing caller is unchanged.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultConfigDir(): string {
  // `MOLT_CONFIG_DIR` relocates the whole of molt's config: keys, endpoint,
  // prices. It exists because without it the test suite writes to the real
  // one — a TUI test that mounts the app triggers a pricing refresh, and
  // `savePricing` had nowhere else to go, so running `npm test` rewrote the
  // developer's stored endpoint and left `priceModel: "test-model"` behind.
  // A test that edits the machine it runs on is not a test you can trust
  // twice, and this was doing it on every run.
  const override = process.env.MOLT_CONFIG_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".config", "molt");
}

