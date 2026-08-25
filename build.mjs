/**
 * The build.
 *
 * Three bundles, because they run in three different worlds: the main process
 * is Node with Electron's APIs, the preload is a sandboxed bridge, and the
 * renderer is a browser page with neither. esbuild does the ESM→CJS conversion
 * the Electron loader wants, and inlines molt's engine into the main bundle so
 * the shipped app has no node_modules to carry.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const dev = process.argv.includes("--dev");
const common = {
  bundle: true,
  sourcemap: dev,
  minify: !dev,
  logLevel: "info",
};

rmSync("out", { recursive: true, force: true });
mkdirSync("out/ui", { recursive: true });

await build({
  ...common,
  entryPoints: ["electron/main.ts"],
  outfile: "out/main.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  // Electron supplies its own; bundling it would ship a second copy that
  // cannot reach the running app's APIs.
  external: ["electron"],
});

await build({
  ...common,
  entryPoints: ["electron/preload.ts"],
  outfile: "out/preload.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
});

await build({
  ...common,
  entryPoints: ["ui/app.ts"],
  outfile: "out/ui/app.js",
  platform: "browser",
  format: "esm",
  target: "chrome120",
});

cpSync("ui/index.html", "out/ui/index.html");
cpSync("ui/styles.css", "out/ui/styles.css");
// The mark the page draws, and the same art for the window and dock. Both are
// copied rather than inlined: a 120KB base64 blob in the stylesheet would hide
// the one file in this app anyone can check by opening it.
cpSync("ui/logo.png", "out/ui/logo.png");
cpSync("build/icon.png", "out/icon.png");
console.log("built → out/");
