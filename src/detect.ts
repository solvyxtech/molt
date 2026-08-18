/**
 * Reading a project well enough to propose a bar for it.
 *
 * `molt init` wrote three builtins and a block of commented-out examples, and
 * left the important half to you. That is the wrong default for the one file
 * the whole product turns on: a bar containing only builtins proves a file
 * changed and the record is intact — both true, neither the thing you care
 * about. Everyone who skipped uncommenting got a gate that could not fail for
 * a reason worth knowing.
 *
 * So molt looks. Package manifests state their own commands; a Makefile lists
 * its targets; a lockfile says which runner is really in use. All of that is
 * mechanical, checkable, and already on disk.
 *
 * Two rules keep this honest:
 *
 *  1. **Only propose what is there.** A check is written when the manifest
 *     declares the script, not when the ecosystem usually has one. `npm test`
 *     goes in the bar because `package.json` says `scripts.test` exists.
 *  2. **Say where every line came from.** The generated file names the source
 *     of each check, because a bar you did not write and cannot explain is a
 *     bar you will delete the first time it fails.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Detected = {
  name: string;
  run: string;
  /** Why molt believes this command exists. Written into the bar as a comment. */
  because: string;
  tags?: string[];
};

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Which package manager a JavaScript project is actually using. */
function jsRunner(cwd: string): string {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

/**
 * Checks worth running in this project, in the order they should run: fast
 * and cheap first, so a failing typecheck is not paid for with a full suite.
 */
export function detectChecks(cwd: string): Detected[] {
  const found: Detected[] = [];

  // ---- JavaScript and TypeScript ----
  const pkg = readJson(join(cwd, "package.json"));
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const run = jsRunner(cwd);
    const has = (name: string) => typeof scripts[name] === "string" && scripts[name]!.trim() !== "";
    const invoke = (name: string) =>
      name === "test" && run === "npm" ? "npm test" : `${run} run ${name}`;

    // Type errors are the cheapest real failure to find, so they go first.
    for (const name of ["typecheck", "type-check", "types", "tsc"]) {
      if (has(name)) {
        found.push({ name: "types", run: invoke(name), because: `package.json scripts.${name}`, tags: ["fast"] });
        break;
      }
    }
    for (const name of ["lint", "eslint"]) {
      if (has(name)) {
        // Lint is advisory by default: a style opinion is information, and a
        // bar that refuses over it teaches people to delete the check.
        found.push({ name: "lint", run: invoke(name), because: `package.json scripts.${name}`, tags: ["fast"] });
        break;
      }
    }
    if (has("test")) {
      found.push({ name: "tests", run: invoke("test"), because: "package.json scripts.test", tags: ["slow"] });
    }
    if (!has("test") && !has("typecheck") && existsSync(join(cwd, "tsconfig.json"))) {
      found.push({
        name: "types",
        run: "npx tsc --noEmit",
        because: "tsconfig.json, with no typecheck script to call",
        tags: ["fast"],
      });
    }
  }

  // ---- Rust ----
  if (existsSync(join(cwd, "Cargo.toml"))) {
    found.push({ name: "build", run: "cargo check", because: "Cargo.toml", tags: ["fast"] });
    found.push({ name: "tests", run: "cargo test", because: "Cargo.toml", tags: ["slow"] });
  }

  // ---- Go ----
  if (existsSync(join(cwd, "go.mod"))) {
    found.push({ name: "build", run: "go build ./...", because: "go.mod", tags: ["fast"] });
    found.push({ name: "tests", run: "go test ./...", because: "go.mod", tags: ["slow"] });
  }

  // ---- Python ----
  const pyproject = readText(join(cwd, "pyproject.toml"));
  if (pyproject || existsSync(join(cwd, "setup.cfg")) || existsSync(join(cwd, "requirements.txt"))) {
    if (pyproject?.includes("[tool.ruff") ) {
      found.push({ name: "lint", run: "ruff check .", because: "pyproject.toml [tool.ruff]", tags: ["fast"] });
    }
    if (pyproject?.includes("[tool.mypy")) {
      found.push({ name: "types", run: "mypy .", because: "pyproject.toml [tool.mypy]", tags: ["fast"] });
    }
    if (pyproject?.includes("[tool.pytest") || existsSync(join(cwd, "tests")) || existsSync(join(cwd, "test"))) {
      found.push({ name: "tests", run: "pytest -q", because: "a tests directory or pytest configuration", tags: ["slow"] });
    }
  }

  // ---- Make, last: a Makefile target is a fallback, not a preference ----
  const makefile = readText(join(cwd, "Makefile")) ?? readText(join(cwd, "makefile"));
  if (makefile && found.length === 0) {
    for (const target of ["test", "check", "ci"]) {
      if (new RegExp(`^${target}:`, "m").test(makefile)) {
        found.push({ name: target, run: `make ${target}`, because: `Makefile target "${target}"`, tags: ["slow"] });
        break;
      }
    }
  }

  // Two checks named "types" or "tests" would be a malformed bar. First wins.
  const seen = new Set<string>();
  return found.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

/**
 * A `done.yml` for this project, with its own commands in it.
 *
 * Advisory where a failure is an opinion (lint), blocking where it is a fact
 * (types, tests). Builtins last, tagged `session`, because they are meaningful
 * inside a session and not from a standalone `molt prove`.
 */
export function proposeBar(cwd: string): { yaml: string; detected: Detected[] } {
  const detected = detectChecks(cwd);

  const head = [
    '# What "done" means in this project.',
    "#",
    "# molt will not emit a final answer while any check below fails. Checks are",
    "# ordinary shell commands, so anything your CI can run, your agent must pass.",
    "#",
    detected.length
      ? "# The commands below were read out of this project — each says where from."
      : "# molt found no build or test commands here, so this bar only proves that",
    detected.length
      ? "# Edit freely: it is your file, and molt only wrote a first draft."
      : "# work landed. Add your own commands; that is where a bar gets its value.",
    "",
    "version: 1",
    "",
    "checks:",
  ];

  const body: string[] = [];
  for (const c of detected) {
    body.push(`  # ${c.because}`);
    body.push(`  - name: ${c.name}`);
    body.push(`    run: ${c.run}`);
    if (c.name === "lint") {
      body.push("    # An opinion, not a contract: reported, never blocking.");
      body.push("    advisory: true");
    }
    if (c.tags?.length) body.push(`    tags: [${c.tags.join(", ")}]`);
    body.push("");
  }

  const tail = [
    "  # molt runs these itself, against the session record. They are meaningful",
    "  # inside a session, so `molt prove` on its own skips them with --skip session.",
    "  - name: work-landed",
    "    builtin: files-changed",
    "    tags: [session]",
    "",
    "  - name: record-intact",
    "    builtin: record-intact",
    "    tags: [session]",
    "",
    "  - name: claims-grounded",
    "    builtin: claims-grounded",
    "    tags: [session]",
    "",
  ];

  return { yaml: [...head, ...body, ...tail].join("\n"), detected };
}
