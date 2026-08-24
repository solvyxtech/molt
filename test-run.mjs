/**
 * Run the suite in its own config directory.
 *
 * `npm test` used to write to the developer's real ~/.config/molt: a TUI test
 * mounts the app, the app refreshes pricing, and savePricing had nowhere else
 * to go. It rewrote the stored endpoint and left `priceModel: "test-model"`
 * behind on every run. A test that edits the machine it runs on cannot be
 * trusted twice, and this one had been doing it since before the desktop
 * existed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "molt-test-cfg-"));
const files = readdirSync("dist-test/test")
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => join("dist-test/test", f));

// Coverage on every run, so `diff-covered` always has something to read. It
// costs a little wall clock and it is the difference between "a file changed"
// and "the change is executed by anything".
mkdirSync("coverage", { recursive: true });
const r = spawnSync(
  "node",
  [
    "--test",
    "--experimental-test-coverage",
    "--test-reporter=lcov",
    "--test-reporter-destination=coverage/lcov.info",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    ...files,
  ],
  {
    stdio: "inherit",
    env: { ...process.env, MOLT_CONFIG_DIR: dir },
  },
);
rmSync(dir, { recursive: true, force: true });
process.exit(r.status ?? 1);
