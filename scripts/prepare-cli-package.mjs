#!/usr/bin/env node
/**
 * Stage a publishable @solvyx/molt package without touching molt-desktop.
 *
 * Root package.json stays private for electron-builder. This script builds
 * dist/, then copies the CLI manifest + allowlisted files into out-cli/ so
 * `npm publish ./out-cli` ships the terminal binary (bin: molt) only.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "out-cli");

function fail(msg) {
  process.stderr.write(`prepare-cli-package: ${msg}\n`);
  process.exit(1);
}

const build = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
if (build.status !== 0) fail("build failed");

const cliJs = join(root, "dist", "cli.js");
if (!existsSync(cliJs)) fail("dist/cli.js missing after build");

// Ensure shebang survives tsc (src/cli.tsx starts with #!/usr/bin/env node).
const head = readFileSync(cliJs, "utf8").slice(0, 32);
if (!head.startsWith("#!/usr/bin/env node")) {
  writeFileSync(cliJs, "#!/usr/bin/env node\n" + readFileSync(cliJs, "utf8"));
}
chmodSync(cliJs, 0o755);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, "package.cli.json"), "utf8"));
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// Unified versioning: CLI --version and npm tag follow root package.json.
manifest.version = rootPkg.version;
writeFileSync(join(out, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

for (const name of ["dist", "examples", "README.md", "LICENSE", "NOTICE"]) {
  const src = join(root, name);
  if (!existsSync(src)) fail(`missing ${name}`);
  cpSync(src, join(out, name), { recursive: true });
}

// Sanity: never ship Electron artifacts.
for (const banned of ["out", "electron", "ui", "release"]) {
  if (existsSync(join(out, banned))) fail(`refusing to ship ${banned}/`);
}

process.stdout.write(
  `staged ${out}\n` +
    `  name: ${manifest.name}@${manifest.version}\n` +
    `  bin:  molt → dist/cli.js\n` +
    `next:  npm pack ./out-cli   # dry-run\n` +
    `       npm publish ./out-cli --access public   # COO only\n`,
);
