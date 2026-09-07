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

/**
 * Anthropic's Agent SDK, bundled into `out/` like everything else.
 *
 * The Claude Code backend needs it, and the packaging rule here is that
 * nothing under node_modules ships — what you audit in `out/` is what runs. A
 * sidecar keeps both: it is one auditable file beside the others, and molt
 * loads it only if someone asks for that backend.
 *
 * The SDK's own platform build of the CLI is deliberately NOT bundled — it is
 * ~240MB, and molt points the SDK at the `claude` you already installed and
 * logged in, which is the copy that should be doing the work anyway.
 *
 * Optional, so a checkout without the SDK still builds a working app; the
 * backend then says what to install.
 */
try {
  await build({
    ...common,
    stdin: {
      contents: [
        'export { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";',
        'export { z } from "zod";',
      ].join("\n"),
      resolveDir: process.cwd(),
      sourcefile: "claude-sdk-entry.mjs",
    },
    outfile: "out/claude-sdk.mjs",
    platform: "node",
    format: "esm",
    target: "node20",
  });
} catch {
  console.log(
    "[build] no @anthropic-ai/claude-agent-sdk — skipping out/claude-sdk.mjs; " +
      "the Claude Code backend will say how to install it",
  );
}

cpSync("ui/index.html", "out/ui/index.html");
cpSync("ui/styles.css", "out/ui/styles.css");
// The mark the page draws, and the same art for the window and dock. Both are
// copied rather than inlined: a 120KB base64 blob in the stylesheet would hide
// the one file in this app anyone can check by opening it.
cpSync("ui/logo.png", "out/ui/logo.png");
cpSync("build/icon.png", "out/icon.png");
console.log("built → out/");
