/**
 * The environment brief: what is on this machine, before the model asks.
 *
 * The repository map answers "what is in this project". This answers the
 * other question a session spends its first steps on: what can I run here?
 * Watching a model open with `which python3`, `node --version`, `ls`, `git
 * status`, `cat package.json`, then `cat Makefile` — six steps, each resent on
 * every later request — is what makes the case. Every one of those facts is
 * knowable before the first request, for free, and it is the same few hundred
 * tokens on step thirty because it sits in the cached prefix.
 *
 * Bootstrapping each session with salient system information is a cheap
 * harness change, and this is it.
 *
 * Two rules, the same ones the map keeps:
 *
 *  - **A brief is never evidence.** Nothing here is shown to the bar, written
 *    to a receipt, or counted as work. It is context, and a stale brief is a
 *    wasted hint, not a false claim.
 *  - **The budget is real.** Sections are emitted until the token budget is
 *    spent, most useful first, and then it stops.
 *
 * Everything is gathered with short timeouts and in parallel. A tool that is
 * slow to answer `--version` is reported as present without a version rather
 * than delaying the session — the brief must never cost more than the
 * exploration it replaces.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { runCommand } from "./run.js";
import { estTokens } from "./types.js";

export const DEFAULT_BRIEF_TOKENS = 700;
/** How long any one probe may take. A version flag that takes longer is not worth waiting for. */
export const PROBE_TIMEOUT_MS = 2_500;

/**
 * Tools worth knowing about, and how each says its version.
 *
 * Ordered by how often a coding task needs them. The list is deliberately
 * short: a brief that names forty tools is a brief nobody reads, model or
 * person.
 */
const TOOLCHAIN: { name: string; version: string }[] = [
  { name: "git", version: "git --version" },
  { name: "node", version: "node --version" },
  { name: "npm", version: "npm --version" },
  { name: "pnpm", version: "pnpm --version" },
  { name: "yarn", version: "yarn --version" },
  { name: "bun", version: "bun --version" },
  { name: "python3", version: "python3 --version" },
  { name: "pip3", version: "pip3 --version" },
  { name: "uv", version: "uv --version" },
  { name: "go", version: "go version" },
  { name: "cargo", version: "cargo --version" },
  { name: "rustc", version: "rustc --version" },
  { name: "java", version: "java -version" },
  { name: "mvn", version: "mvn --version" },
  { name: "gradle", version: "gradle --version" },
  { name: "dotnet", version: "dotnet --version" },
  { name: "ruby", version: "ruby --version" },
  { name: "gcc", version: "gcc --version" },
  { name: "clang", version: "clang --version" },
  { name: "make", version: "make --version" },
  { name: "cmake", version: "cmake --version" },
  { name: "docker", version: "docker --version" },
  { name: "tmux", version: "tmux -V" },
  { name: "rg", version: "rg --version" },
  { name: "jq", version: "jq --version" },
  { name: "curl", version: "curl --version" },
];

/** Files whose presence says what kind of project this is, and what they mean. */
const MANIFESTS: { file: string; means: string }[] = [
  { file: "package.json", means: "node" },
  { file: "pyproject.toml", means: "python (pyproject)" },
  { file: "setup.py", means: "python (setup.py)" },
  { file: "requirements.txt", means: "python (requirements.txt)" },
  { file: "Pipfile", means: "python (pipenv)" },
  { file: "go.mod", means: "go" },
  { file: "Cargo.toml", means: "rust" },
  { file: "pom.xml", means: "java (maven)" },
  { file: "build.gradle", means: "java (gradle)" },
  { file: "build.gradle.kts", means: "kotlin (gradle)" },
  { file: "Gemfile", means: "ruby" },
  { file: "Makefile", means: "make" },
  { file: "CMakeLists.txt", means: "cmake" },
  { file: "Dockerfile", means: "docker" },
  { file: "docker-compose.yml", means: "docker compose" },
  { file: "compose.yaml", means: "docker compose" },
  { file: ".maat/done.yml", means: "Maat bar" },
  { file: ".molt/done.yml", means: "Maat bar" },
];

export type Probe = (command: string, timeoutMs: number) => Promise<string | null>;

/**
 * Run one probe and return its first line, or null if it did not run.
 *
 * `java -version` writes to stderr; several others do too. Both streams are
 * read, and the first non-empty line wins.
 */
export async function shellProbe(command: string, timeoutMs: number, cwd?: string): Promise<string | null> {
  try {
    // The worker's environment, as the worker sees it (src/privsep.ts): and
    // git here reads the worker's repository config, which must not run as Maat.
    const r = await runCommand(command, { cwd: cwd ?? process.cwd(), timeoutMs, maxBuffer: 16 * 1024, asWorker: true });
    if (r.timedOut) return null;
    if (r.code !== 0) return null;
    const line = `${r.stdout}\n${r.stderr}`
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return line ?? null;
  } catch {
    return null;
  }
}

/** A version string as it reads in a brief: `git version 2.44.0` → `2.44.0`. */
export function shortVersion(line: string): string {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+.][\w.]+)?)/.exec(line);
  return m ? m[1] : line.slice(0, 24);
}

export type BriefInput = {
  cwd: string;
  probe?: Probe;
  budgetTokens?: number;
  /** Environment to read from; tests pass their own. */
  env?: NodeJS.ProcessEnv;
  /** Platform facts; tests pass their own so a brief is stable across machines. */
  system?: { platform: string; release: string; arch: string };
};

export type Brief = { text: string; tokens: number; sections: string[] };

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The `scripts` of a package.json, as `name: command` lines, shortest first. */
export function packageScripts(cwd: string, max = 12): string[] {
  const pkg = readJson(join(cwd, "package.json"));
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== "object") return [];
  return Object.entries(scripts as Record<string, string>)
    .slice(0, max)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`);
}

/** Targets of a Makefile: lines like `name:` that are not variables or patterns. */
export function makeTargets(cwd: string, max = 12): string[] {
  const p = join(cwd, "Makefile");
  if (!existsSync(p)) return [];
  const out: string[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^([A-Za-z_][\w.-]*)\s*:(?!=)/.exec(line);
    if (m && !m[1].startsWith(".") && !out.includes(m[1])) out.push(m[1]);
    if (out.length >= max) break;
  }
  return out;
}

/** Top-level entries of the project, directories marked with a slash. */
export function topLevel(cwd: string, max = 24): string[] {
  let names: string[];
  try {
    names = readdirSync(cwd);
  } catch {
    return [];
  }
  const skip = new Set(["node_modules", ".git", ".DS_Store"]);
  return names
    .filter((n) => !skip.has(n))
    .sort()
    .slice(0, max)
    .map((n) => {
      try {
        return statSync(join(cwd, n)).isDirectory() ? `${n}/` : n;
      } catch {
        return n;
      }
    });
}

/**
 * Build the brief.
 *
 * Sections, in the order they are worth their tokens:
 *  1. system and shell
 *  2. project manifests and what they imply, with package scripts / make targets
 *  3. git state
 *  4. toolchain present, with versions
 *  5. top-level listing
 *
 * The section order is also the drop order: if the budget runs out, the
 * listing goes first and the system line never does.
 */
export async function buildBrief(input: BriefInput): Promise<Brief> {
  const cwd = input.cwd;
  const probe: Probe = input.probe ?? ((c, t) => shellProbe(c, t, cwd));
  const budget = input.budgetTokens ?? DEFAULT_BRIEF_TOKENS;
  const env = input.env ?? process.env;
  const sys = input.system ?? { platform: platform(), release: release(), arch: arch() };

  // Everything that runs a command runs at once. The brief's cost is the
  // slowest probe, not the sum of them.
  const [gitBranch, gitStatus, gitLast, ...versions] = await Promise.all([
    probe("git rev-parse --abbrev-ref HEAD", PROBE_TIMEOUT_MS),
    probe("git status --porcelain | wc -l", PROBE_TIMEOUT_MS),
    probe("git log -1 --format=%h%x20%s", PROBE_TIMEOUT_MS),
    ...TOOLCHAIN.map((t) => probe(t.version, PROBE_TIMEOUT_MS)),
  ]);

  const sections: string[] = [];

  const shell = env.SHELL ? ` · shell ${env.SHELL}` : "";
  sections.push(`system: ${sys.platform} ${sys.release} ${sys.arch}${shell}`);

  const manifests = MANIFESTS.filter((m) => existsSync(join(cwd, m.file)));
  if (manifests.length) {
    const lines = [`project: ${manifests.map((m) => `${m.file} (${m.means})`).join(", ")}`];
    const scripts = packageScripts(cwd);
    if (scripts.length) lines.push(`  npm scripts: ${scripts.join(" · ")}`);
    const targets = makeTargets(cwd);
    if (targets.length) lines.push(`  make targets: ${targets.join(", ")}`);
    sections.push(lines.join("\n"));
  } else {
    sections.push("project: no manifest found at the top level");
  }

  if (gitBranch) {
    const dirty = Number(gitStatus ?? "0") || 0;
    sections.push(
      `git: branch ${gitBranch}, ${dirty === 0 ? "clean" : `${dirty} changed path(s)`}` +
        (gitLast ? `, last commit ${gitLast}` : ""),
    );
  } else {
    sections.push("git: not a repository");
  }

  const present: string[] = [];
  TOOLCHAIN.forEach((t, i) => {
    const v = versions[i];
    if (v) present.push(`${t.name} ${shortVersion(v)}`);
  });
  if (present.length) sections.push(`tools: ${present.join(", ")}`);

  const top = topLevel(cwd);
  if (top.length) sections.push(`top level: ${top.join("  ")}`);

  // Spend the budget most-useful-first; stop at the first section that does
  // not fit, and say so.
  const kept: string[] = [];
  let tokens = estTokens("Environment (gathered once at session start, not evidence):\n");
  for (const s of sections) {
    const t = estTokens(s + "\n");
    if (tokens + t > budget && kept.length > 0) break;
    kept.push(s);
    tokens += t;
  }
  const text = kept.length
    ? `Environment (gathered once at session start, not evidence):\n${kept.join("\n")}`
    : "";
  return { text, tokens: text ? estTokens(text) : 0, sections: kept };
}
