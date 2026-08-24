/**
 * Install the app, or refresh one already installed.
 *
 * `npm run app` rebuilds from source and launches — that is a development
 * loop, and having to run it to open a program is the thing it is not for. A
 * packaged app is double-clicked like any other; the only reason this project
 * needed a build step was that nobody had installed it yet.
 *
 *   node install.mjs          copy the packaged app into /Applications
 *   node install.mjs --push   refresh the installed app's code in place
 *
 * `--push` exists because a full repackage is 115MB and about two minutes,
 * while the part that actually changes — three bundled files and a stylesheet —
 * is under a megabyte. With `asar: false` those sit as plain files inside the
 * bundle, so a refresh is a copy.
 */
import { cpSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SRC = "release/mac-arm64/molt.app";
const DEST = "/Applications/molt.app";
const push = process.argv.includes("--push");

if (push) {
  const into = join(DEST, "Contents/Resources/app/out");
  if (!existsSync(DEST)) {
    console.error(`molt is not installed at ${DEST} — run \`npm run app:install\` first.`);
    process.exit(1);
  }
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  cpSync("out", into, { recursive: true });
  console.log(`refreshed ${DEST} — reopen it to pick up the change`);
} else {
  if (!existsSync(SRC)) {
    console.error(`no packaged app at ${SRC} — run \`npm run pack\` first.`);
    process.exit(1);
  }
  rmSync(DEST, { recursive: true, force: true });
  cpSync(SRC, DEST, { recursive: true, dereference: false, verbatimSymlinks: true });
  console.log(`installed to ${DEST}`);
  console.log("Unsigned, so the first open needs: right-click the app → Open → Open.");
}
