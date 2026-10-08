/**
 * The harness pieces that move a terminal benchmark: the environment brief,
 * bash timeouts a model can raise, background jobs, runtime reporting, and
 * the plan tool.
 *
 * Every test here drives the real engine against a scripted provider — the
 * change these cover is what the *model* sees, so what the model sees is what
 * is asserted.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, afterEach } from "node:test";
import { buildBrief, makeTargets, packageScripts, shortVersion, topLevel } from "../src/brief.js";
import {
  listBackground,
  resetBackgroundRegistry,
  startBackground,
  stopAllBackground,
  stopBackground,
} from "../src/background.js";
import { Engine, MAX_BASH_TIMEOUT_MS, renderPlan, SLOW_COMMAND_MS } from "../src/engine.js";
import { gate, overwritesOnlyNew } from "../src/autonomy.js";
import { toolDetail } from "../src/transcript.js";
import { allowAll, drain, scriptedProvider, workspace, type ScriptedTurn } from "./helpers.js";

function engineFor(dir: string, turns: ScriptedTurn[], extra: Record<string, unknown> = {}) {
  const provider = scriptedProvider(turns);
  const engine = new Engine({
    baseUrl: "http://provider.test/v1",
    model: "m",
    cwd: dir,
    fetchFn: provider.fetchFn,
    bar: null,
    stream: false,
    autonomy: "high",
    ...extra,
  });
  return { engine, provider };
}

/** The tool result the model was sent for the first tool call. */
function firstToolResult(provider: ReturnType<typeof scriptedProvider>): string {
  for (const req of provider.requests() as { messages: { role: string; content: string }[] }[]) {
    const t = req.messages.find((m) => m.role === "tool");
    if (t) return String(t.content);
  }
  throw new Error("no tool result was sent back to the model");
}

describe("the environment brief", () => {
  it("names the system, manifests, git state, tools and top level, in that order", async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.dir, "package.json"),
        JSON.stringify({ scripts: { test: "node --test", build: "tsc -p ." } }),
      );
      writeFileSync(join(ws.dir, "Makefile"), "CC=gcc\nall: build\n\tmake build\nbuild:\n\t$(CC) x.c\n.PHONY: all\n");
      mkdirSync(join(ws.dir, "src"));
      const probe = async (cmd: string) => {
        if (cmd.startsWith("git rev-parse")) return "main";
        if (cmd.startsWith("git status")) return "2";
        if (cmd.startsWith("git log")) return "abc1234 first";
        if (cmd === "node --version") return "v22.1.0";
        if (cmd === "git --version") return "git version 2.44.0";
        if (cmd === "java -version") return 'openjdk version "21.0.2" 2024-01-16';
        return null;
      };
      const b = await buildBrief({
        cwd: ws.dir,
        probe,
        env: { SHELL: "/bin/zsh" },
        system: { platform: "linux", release: "6.8", arch: "x64" },
      });
      const lines = b.text.split("\n");
      assert.match(lines[0], /^Environment \(gathered once/);
      assert.equal(lines[1], "system: linux 6.8 x64 · shell /bin/zsh");
      assert.match(lines[2], /^project: package\.json \(node\), Makefile \(make\)/);
      assert.match(lines[3], /npm scripts: test: node --test · build: tsc -p \./);
      assert.match(lines[4], /make targets: all, build$/);
      assert.equal(lines[5], "git: branch main, 2 changed path(s), last commit abc1234 first");
      assert.equal(lines[6], "tools: git 2.44.0, node 22.1.0, java 21.0.2");
      assert.match(lines[7], /^top level: Makefile {2}package\.json {2}src\/$/);
      assert.equal(b.sections.length, 5);
    } finally {
      ws.cleanup();
    }
  });

  it("says plainly when there is no manifest and no repository", async () => {
    const ws = workspace();
    try {
      const b = await buildBrief({ cwd: ws.dir, probe: async () => null, env: {}, system: { platform: "p", release: "r", arch: "a" } });
      assert.match(b.text, /project: no manifest found/);
      assert.match(b.text, /git: not a repository/);
      assert.doesNotMatch(b.text, /tools:/);
    } finally {
      ws.cleanup();
    }
  });

  it("drops sections from the bottom when the budget runs out, never the system line", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "package.json"), "{}");
      const b = await buildBrief({
        cwd: ws.dir,
        probe: async () => null,
        env: {},
        system: { platform: "p", release: "r", arch: "a" },
        budgetTokens: 1,
      });
      assert.deepEqual(b.sections, ["system: p r a"]);
      assert.ok(b.tokens > 0);
    } finally {
      ws.cleanup();
    }
  });

  it("reads versions out of the noise each tool prints", () => {
    assert.equal(shortVersion("git version 2.44.0"), "2.44.0");
    assert.equal(shortVersion("v22.1.0"), "22.1.0");
    assert.equal(shortVersion("go version go1.22.3 darwin/arm64"), "1.22.3");
    assert.equal(shortVersion("Python 3.12.4"), "3.12.4");
    assert.equal(shortVersion("cargo 1.79.0-nightly (abc 2024-05-01)"), "1.79.0-nightly");
  });

  it("helpers read package scripts, make targets and the listing", () => {
    const ws = workspace();
    try {
      assert.deepEqual(packageScripts(ws.dir), []);
      assert.deepEqual(makeTargets(ws.dir), []);
      writeFileSync(join(ws.dir, "package.json"), JSON.stringify({ scripts: { a: "x" } }));
      writeFileSync(join(ws.dir, "Makefile"), "VAR:=1\nfoo: bar\nbar:\n%.o: %.c\n");
      mkdirSync(join(ws.dir, "node_modules"));
      mkdirSync(join(ws.dir, "lib"));
      assert.deepEqual(packageScripts(ws.dir), ["a: x"]);
      assert.deepEqual(makeTargets(ws.dir), ["foo", "bar"]);
      assert.deepEqual(topLevel(ws.dir), ["Makefile", "lib/", "package.json"]);
    } finally {
      ws.cleanup();
    }
  });

  it("sits in the system prompt, before the map, so it is inside the cached prefix", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [{ text: "hi" }], {
        brief: "Environment (gathered once at session start, not evidence):\nsystem: test",
        repoMap: "Repository map:\n- src/a.ts",
      });
      await drain(engine.run("hello", allowAll, { ask: true }));
      const sys = String((provider.requests()[0] as { messages: { content: string }[] }).messages[0].content);
      const brief = sys.indexOf("Environment (gathered once");
      const map = sys.indexOf("Repository map:");
      assert.ok(brief > 0 && map > brief, `brief at ${brief}, map at ${map}`);
      assert.equal(engine.brief.startsWith("Environment"), true);
      engine.setBrief("");
      assert.equal(engine.brief, "");
    } finally {
      ws.cleanup();
    }
  });
});

describe("background jobs", () => {
  afterEach(() => {
    stopAllBackground();
    resetBackgroundRegistry();
  });

  it("start at once, log to .maat/bg, and can be stopped by id", async () => {
    const ws = workspace();
    try {
      const p = startBackground("echo started; sleep 30", { cwd: ws.dir });
      assert.equal(p.id, 1);
      assert.ok(p.pid > 0);
      assert.equal(p.log, ".maat/bg/1.log");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(readFileSync(join(ws.dir, p.log), "utf8"), "started\n");
      assert.equal(p.exit, undefined, "still running");
      assert.equal(stopBackground(1), true);
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(p.exit, "stopped");
      assert.equal(stopBackground(99), false);
      assert.equal(listBackground().length, 1);
    } finally {
      ws.cleanup();
    }
  });

  it("through the bash tool: the model is told the job number and the log, and reads it later", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "bash", args: { command: "echo up; sleep 30", background: true } }] },
        { calls: [{ name: "read_file", args: { path: ".maat/bg/1.log" } }] },
        { calls: [{ name: "bash", args: { command: "", stop_job: 1 } }] },
        { text: "done" },
      ]);
      await drain(engine.run("start the server", allowAll, { ask: true }));
      const reqs = provider.requests() as { messages: { role: string; content: string }[] }[];
      const tools = reqs[reqs.length - 1].messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      assert.match(tools[0], /started in the background as job 1 \(pid \d+\)\. Output goes to \.maat\/bg\/1\.log/);
      assert.match(tools[1], /up/);
      assert.match(tools[2], /^stopping job 1 \(pid \d+, "echo up; sleep 30"\)/);
    } finally {
      ws.cleanup();
    }
  });

  it("a job that dies immediately is reported as dead, not as running", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "bash", args: { command: "exit 3", background: true } }] },
        { text: "done" },
      ]);
      await drain(engine.run("start", allowAll, { ask: true }));
      assert.match(firstToolResult(provider), /job 1 exited with exit 3 straight away/);
    } finally {
      ws.cleanup();
    }
  });

  it("stopping an unknown job lists the ones that exist", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "bash", args: { command: "", stop_job: 7 } }] },
        { text: "done" },
      ]);
      await drain(engine.run("stop", allowAll, { ask: true }));
      assert.match(firstToolResult(provider), /no background job 7 — jobs started this session: none/);
    } finally {
      ws.cleanup();
    }
  });

  it("is shown as such in the transcript", () => {
    assert.equal(toolDetail("bash", { command: "npm start", background: true }), "& npm start");
    assert.equal(toolDetail("bash", { command: "", stop_job: 2 }), "stop job 2");
    assert.equal(toolDetail("bash", { command: "ls" }), "ls");
  });
});

describe("bash timeouts and runtime", () => {
  it("a model may raise the timeout for one call, up to the ceiling", async () => {
    const ws = workspace();
    try {
      // The engine's default is set to 100ms so the first call is killed and
      // the second, with timeout_s, is not.
      const { engine, provider } = engineFor(
        ws.dir,
        [
          { calls: [{ name: "bash", args: { command: "sleep 0.4; echo slow" } }] },
          { calls: [{ name: "bash", args: { command: "sleep 0.4; echo slow", timeout_s: 5 } }] },
          { text: "done" },
        ],
        { bashTimeoutMs: 100 },
      );
      await drain(engine.run("run it", allowAll, { ask: true }));
      const reqs = provider.requests() as { messages: { role: string; content: string }[] }[];
      const tools = reqs[reqs.length - 1].messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      assert.match(tools[0], /^timeout after 0\.1s/);
      assert.match(tools[0], /call again with timeout_s \(up to 1800\)/);
      assert.match(tools[0], /start it with background=true instead/);
      assert.equal(tools[1].trim(), "slow");
    } finally {
      ws.cleanup();
    }
  });

  it("the ceiling is thirty minutes, whatever is asked for", () => {
    assert.equal(MAX_BASH_TIMEOUT_MS, 30 * 60_000);
  });

  it("a slow command reports how long it ran; a fast one does not", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "bash", args: { command: "echo fast" } }] },
        { calls: [{ name: "bash", args: { command: `sleep ${(SLOW_COMMAND_MS + 200) / 1000}; echo slow` } }] },
        { calls: [{ name: "bash", args: { command: `sleep ${(SLOW_COMMAND_MS + 200) / 1000}; exit 2` } }] },
        { text: "done" },
      ]);
      await drain(engine.run("time them", allowAll, { ask: true }));
      const reqs = provider.requests() as { messages: { role: string; content: string }[] }[];
      const tools = reqs[reqs.length - 1].messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      assert.equal(tools[0], "fast\n");
      assert.match(tools[1], /^slow\n\[molt: ran 2\.\ds\]$/);
      assert.match(tools[2], /^exit 2\n[\s\S]*\[molt: ran 2\.\ds\]$/);
    } finally {
      ws.cleanup();
    }
  });
});

describe("the plan tool", () => {
  it("renders done, current and pending steps with the next action last", () => {
    assert.equal(
      renderPlan(["read", "edit", "test"], 1),
      "[x] 1. read\n[>] 2. edit\n[ ] 3. test\n1/3 done · now: edit",
    );
    assert.equal(renderPlan(["a"], 0), "[>] 1. a\n0/1 done · now: a");
    assert.equal(renderPlan(["a", "b"], 2), "[x] 1. a\n[x] 2. b\nall steps done — verify, then answer");
    // Out of range and non-numbers clamp rather than crash.
    assert.equal(renderPlan(["a"], -4), "[>] 1. a\n0/1 done · now: a");
    assert.equal(renderPlan(["a"], Number.NaN), "[>] 1. a\n0/1 done · now: a");
  });

  it("runs nothing, writes nothing, and never asks", async () => {
    const ws = workspace();
    try {
      for (const level of ["low", "medium", "high"] as const) {
        assert.equal(gate(level, { name: "plan", args: { steps: ["x"] }, cwd: ws.dir }).ask, false, level);
      }
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "plan", args: { steps: ["look", "fix"], current: 0 } }] },
        { calls: [{ name: "plan", args: { steps: [] } }] },
        { text: "done" },
      ]);
      const events = await drain(engine.run("plan it", async () => false, { ask: true }));
      const reqs = provider.requests() as { messages: { role: string; content: string }[] }[];
      const tools = reqs[reqs.length - 1].messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      assert.equal(tools[0], "[>] 1. look\n[ ] 2. fix\n0/2 done · now: look");
      assert.equal(tools[1], "a plan needs at least one step");
      assert.equal(existsSync(join(ws.dir, ".maat", "bg")), false);
      const tool = events.find((e) => e.kind === "tool");
      assert.equal(tool && "detail" in tool ? tool.detail : "", "2 steps, on #1");
      assert.equal(engine.getLedger().length, 0, "no writes");
    } finally {
      ws.cleanup();
    }
  });
});

describe("redirects at high autonomy", () => {
  it("allow writing a file that does not exist, inside the project or the temp dir, and nothing else", () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "important.txt"), "keep\n");
      mkdirSync(join(ws.dir, "out"));
      const high = (command: string, created: string[] = []) =>
        gate("high", { name: "bash", args: { command }, cwd: ws.dir, created: new Set(created) }).ask;
      assert.equal(high("echo x > new.txt"), false, "a new file loses nothing");
      assert.equal(high("python3 cli.py sample.txt > out/result.txt"), false);
      assert.equal(high("ls 2>/dev/null > listing.txt"), false, "the discard is not a target");
      assert.equal(high(`echo x > ${join(tmpdir(), "molt-redirect-test-" + process.pid)}`), false, "temp dir is scratch");
      assert.equal(high("echo x > important.txt"), true, "an existing file would be replaced");
      assert.equal(high("echo x > important.txt", ["important.txt"]), false, "unless this session made it");
      assert.equal(high("echo x > /etc/motd"), true, "outside the project");
      assert.equal(high("rm important.txt > log.txt"), true, "the rm is still an rm");
      assert.equal(high("echo x > *.txt"), true, "a glob is not a path");
      assert.equal(high("cat a >> b"), false, "appending never asked");
      assert.equal(overwritesOnlyNew("echo x", new Set(), ws.dir), false, "no redirect, nothing to say");
    } finally {
      ws.cleanup();
    }
  });
});

describe("--sandbox: the machine is disposable", () => {
  it("lifts the project boundary at the gate and nowhere else", () => {
    const ws = workspace();
    try {
      const outside = join(tmpdir(), "molt-sandbox-outside-" + process.pid + ".txt");
      const g = (boundary: "project" | "machine", name: string, args: Record<string, unknown>) =>
        gate("high", { name, args, cwd: ws.dir, boundary });
      assert.equal(g("project", "write_file", { path: outside, content: "x" }).ask, true);
      assert.equal(g("machine", "write_file", { path: outside, content: "x" }).ask, false);
      assert.equal(g("machine", "read_file", { path: "/etc/hosts" }).ask, false);
      // What asks for any other reason still asks: the caller decides.
      assert.equal(g("machine", "bash", { command: "rm -rf /tmp/x" }).ask, true);
      assert.equal(g("machine", "bash", { command: "sudo apt-get install -y jq" }).ask, true);
      assert.equal(g("machine", "read_file", {}).ask, true, "a missing path is still malformed");
    } finally {
      ws.cleanup();
    }
  });

  it("lets the engine read and walk outside the project, and records the write like any other", async () => {
    const ws = workspace();
    const other = workspace();
    try {
      writeFileSync(join(other.dir, "note.txt"), "outside\n");
      const target = join(other.dir, "out.txt");
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "read_file", args: { path: join(other.dir, "note.txt") } }] },
        { calls: [{ name: "list_dir", args: { path: other.dir } }] },
        { calls: [{ name: "write_file", args: { path: target, content: "done\n" } }] },
        { text: "wrote it" },
      ], { sandbox: true });
      await drain(engine.run("do it", allowAll, { ask: true }));
      const reqs = provider.requests() as { messages: { role: string; content: string }[] }[];
      const tools = reqs[reqs.length - 1].messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      assert.match(tools[0], /outside/);
      assert.match(tools[1], /note\.txt/);
      assert.match(tools[2], /wrote|bytes/);
      assert.equal(readFileSync(target, "utf8"), "done\n");
      assert.equal(engine.getLedger().length, 1, "the outside write is ledgered");
    } finally {
      ws.cleanup();
      other.cleanup();
    }
  });

  it("without it, a walk outside the project is refused by the tool itself", async () => {
    const ws = workspace();
    const other = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "list_dir", args: { path: other.dir } }] },
        { text: "looked" },
      ]);
      await drain(engine.run("look", allowAll, { ask: true }));
      assert.match(firstToolResult(provider), /outside this project; Maat will not walk there/);
    } finally {
      ws.cleanup();
      other.cleanup();
    }
  });
});

describe("--reasoning", () => {
  it("is sent as OpenRouter's reasoning.effort on every request, and only when set", async () => {
    const ws = workspace();
    try {
      const a = engineFor(ws.dir, [{ text: "hi" }], { reasoningEffort: "low" });
      await drain(a.engine.run("hello", allowAll, { ask: true }));
      const body = a.provider.requests()[0] as Record<string, unknown>;
      assert.deepEqual(body.reasoning, { effort: "low" });
      const b = engineFor(ws.dir, [{ text: "hi" }]);
      await drain(b.engine.run("hello", allowAll, { ask: true }));
      assert.equal("reasoning" in (b.provider.requests()[0] as object), false, "never sent unasked");
    } finally {
      ws.cleanup();
    }
  });
});

describe("a project with no bar", () => {
  it("is told so in the system prompt, and a project with one is not", async () => {
    const ws = workspace();
    try {
      const a = engineFor(ws.dir, [{ text: "hi" }]);
      await drain(a.engine.run("hello", allowAll, { ask: true }));
      const sysA = String((a.provider.requests()[0] as { messages: { content: string }[] }).messages[0].content);
      assert.match(sysA, /has no \.maat\/done\.yml, so do not look for one/);
      const b = engineFor(ws.dir, [{ text: "hi" }], {
        bar: { version: 1, checks: [{ name: "t", kind: "command", run: "true", timeoutMs: 1000, expectExit: 0, tags: [] }] },
      });
      await drain(b.engine.run("hello", allowAll, { ask: true }));
      const sysB = String((b.provider.requests()[0] as { messages: { content: string }[] }).messages[0].content);
      assert.doesNotMatch(sysB, /has no \.maat\/done\.yml/);
    } finally {
      ws.cleanup();
    }
  });
});

describe("--steps", () => {
  it("replaces the 32-step loop guard, and 0 removes it", async () => {
    const ws = workspace();
    try {
      const busy = (): ScriptedTurn => ({ calls: [{ name: "list_dir", args: { path: "." } }] });
      const a = engineFor(ws.dir, [busy()], { maxSteps: 3 });
      const ea = await drain(a.engine.run("look forever", allowAll, { ask: true }));
      assert.equal(ea.filter((e) => e.kind === "step_summary").length, 3);
      assert.ok(ea.some((e) => e.kind === "error" && /stopped after 3 steps \(loop guard\)/.test(e.text)));
      const turns: ScriptedTurn[] = Array.from({ length: 40 }, busy);
      turns.push({ text: "done looking" });
      const b = engineFor(ws.dir, turns, { maxSteps: 0 });
      const eb = await drain(b.engine.run("look a lot", allowAll, { ask: true }));
      assert.equal(eb.filter((e) => e.kind === "step_summary").length, 41, "past 32 and to the answer");
      assert.ok(!eb.some((e) => e.kind === "error" && /loop guard/.test(e.text)));
    } finally {
      ws.cleanup();
    }
  });
});


describe("self-checked work", () => {
  it("is marked on job_end when every judging check was drafted by the model, and not otherwise", async () => {
    const ws = workspace();
    try {
      const hidden = { name: "own", kind: "command" as const, run: "grep -qx x x.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task", "value"], hidden: true, author: { kind: "judge" as const, model: "judge-j" } };
      const a = engineFor(ws.dir, [{ calls: [{ name: "write_file", args: { path: "x.txt", content: "x" } }] }, { text: "done" }]);
      const ea = await drain(a.engine.run("make x", allowAll, { taskChecks: [hidden] }));
      const ja = ea.find((e) => e.kind === "job_end");
      assert.ok(ja && ja.kind === "job_end" && ja.outcome === "verified" && ja.selfChecked === true);
      // Checks on y.txt, the file this turn makes: x.txt is left over from the
      // turn before, and a check that reads only it is not evidence of this one.
      const onY = { ...hidden, run: "grep -qx y y.txt" };
      const b = engineFor(ws.dir, [{ calls: [{ name: "write_file", args: { path: "y.txt", content: "y" } }] }, { text: "done" }]);
      const eb = await drain(b.engine.run("make y", allowAll, { taskChecks: [onY, { ...onY, name: "chosen", hidden: undefined, author: { kind: "person" as const } }] }));
      const jb = eb.find((e) => e.kind === "job_end");
      assert.ok(jb && jb.kind === "job_end" && jb.outcome === "verified" && jb.selfChecked === undefined, "a person's check makes it verification");
    } finally {
      ws.cleanup();
    }
  });

  it("an unattended run is told to clean up before it finishes, and not to re-audit every requirement", async () => {
    // The requirement-by-requirement re-read cost time on Terminal-Bench and
    // passed no extra task (run 2 vs run 1: 29 = 29, 17 timeouts vs 12); the
    // independent review (src/review.ts) reads the requirements instead.
    const { UNATTENDED_PROMPT } = await import("../src/engine.js");
    assert.doesNotMatch(UNATTENDED_PROMPT, /every requirement/);
    assert.match(UNATTENDED_PROMPT, /build outputs, test binaries, scratch files/);
  });
});

describe("the bash tool's description", () => {
  it("says commands start in the project and that files change through the file tools", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [{ text: "hi" }]);
      await drain(engine.run("hello", allowAll, { ask: true }));
      const tools = (provider.requests()[0] as { tools: { function: { name: string; description: string } }[] }).tools;
      const bash = tools.find((t) => t.function.name === "bash")!.function.description;
      assert.match(bash, /already starts in the project directory — never cd/);
      assert.match(bash, /Never change a file through the shell \(sed -i, perl -pi, cat >/);
      assert.match(bash, /use edit_file or write_file/);
      engine.setReasoningEffort("low");
      assert.equal(engine.reasoningEffort, "low");
      engine.setReasoningEffort("");
      assert.equal(engine.reasoningEffort, undefined);
    } finally {
      ws.cleanup();
    }
  });
});


describe("efficiency", () => {
  it("the prompt asks for batched calls and narrow tests", async () => {
    const { SYSTEM_PROMPT } = await import("../src/engine.js");
    assert.match(SYSTEM_PROMPT, /make all of those tool calls in the same reply/);
    assert.match(SYSTEM_PROMPT, /give bash a list of\ncommands rather than calling it once per command/);
    assert.match(SYSTEM_PROMPT, /One tool call per reply is\nthe slow way to work/);
    assert.match(SYSTEM_PROMPT, /run only the narrowest test that covers what you just changed/);
  });

  it("strips only a cd into this exact directory", async () => {
    const { stripCwdPrefix } = await import("../src/engine.js");
    const cwd = "/work/my proj";
    assert.equal(stripCwdPrefix(`cd "/work/my proj" && cargo test`, cwd), "cargo test");
    assert.equal(stripCwdPrefix(`cd '/work/my proj/' ; ls`, cwd), "ls");
    assert.equal(stripCwdPrefix(`cd /app && make`, "/app"), "make");
    assert.equal(stripCwdPrefix(`  cd /app&&make`, "/app"), "make");
    assert.equal(stripCwdPrefix(`cd /app/sub && make`, "/app"), "cd /app/sub && make", "a subdirectory is a real cd");
    assert.equal(stripCwdPrefix(`cd /apple && make`, "/app"), "cd /apple && make");
    assert.equal(stripCwdPrefix(`echo x && cd /app && make`, "/app"), "echo x && cd /app && make", "only a leading cd");
    assert.equal(stripCwdPrefix(`cd /app`, "/app"), "cd /app", "nothing after it: left alone");
    assert.equal(stripCwdPrefix(`cd /a.p && x`, "/a.p"), "x");
    assert.equal(stripCwdPrefix(`cd /aXp && x`, "/a.p"), "cd /aXp && x", "regex characters in the path are literal");
  });

  it("a stripped command is what runs, what the transcript shows, and what the approval sees", async () => {
    const ws = workspace();
    try {
      const seen: string[] = [];
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "bash", args: { command: `cd ${ws.dir} && echo hi` } }] },
        { text: "done" },
      ], { autonomy: "low" });
      const events = await drain(
        engine.run("say hi", async (_n, detail) => {
          seen.push(detail);
          return true;
        }, { ask: true }),
      );
      assert.match(seen[0] ?? "", /^echo hi/, "the approval text");
      const tool = events.find((e) => e.kind === "tool");
      assert.equal(tool && "detail" in tool ? tool.detail : "", "echo hi");
      assert.equal(firstToolResult(provider).trim(), "hi");
    } finally {
      ws.cleanup();
    }
  });
});

describe("bash with a list of commands", () => {
  it("folds into one script that stops at the first failure", async () => {
    const { foldCommands } = await import("../src/engine.js");
    const a: Record<string, unknown> = { commands: ["cd /app && ls", "make", "", 7] };
    foldCommands(a, "/app");
    assert.equal(a.command, "set -e\nls\nmake");
    assert.equal("commands" in a, false);
    const one: Record<string, unknown> = { commands: ["make test"] };
    foldCommands(one, "/app");
    assert.equal(one.command, "make test");
    const both: Record<string, unknown> = { command: "echo kept", commands: ["echo dropped"] };
    foldCommands(both, "/app");
    assert.equal(both.command, "echo kept", "an explicit command wins");
  });

  it("runs in order in one step, stops at a failure, and every line is still gated", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "bash", args: { commands: ["echo one", "false", "echo never"] } }] },
        { calls: [{ name: "bash", args: { commands: ["echo fine", "rm important.txt"] } }] },
        { calls: [{ name: "bash", args: {} }] },
        { text: "done" },
      ]);
      writeFileSync(join(ws.dir, "important.txt"), "keep");
      const asked: string[] = [];
      await drain(engine.run("go", async (_n, d) => { asked.push(d); return false; }, { ask: true }));
      const reqs = provider.requests() as { messages: { role: string; content: string }[] }[];
      const tools = reqs[reqs.length - 1].messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      assert.match(tools[0], /^exit 1\none\n/);
      assert.doesNotMatch(tools[0], /never/);
      assert.equal(asked.length, 1, "the list with rm in it asked");
      assert.match(asked[0], /rm important\.txt/);
      assert.match(tools[1], /User denied/);
      assert.match(tools[2], /bash needs a command, or commands/);
      assert.equal(existsSync(join(ws.dir, "important.txt")), true);
    } finally {
      ws.cleanup();
    }
  });
});

describe("the cached prefix", () => {
  it("the pinned task note does not change while the turn writes files, and catches up at the next turn", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "write_file", args: { path: "a.txt", content: "a" } }] },
        { calls: [{ name: "write_file", args: { path: "b.txt", content: "b" } }] },
        { text: "done" },
      ]);
      await drain(engine.run("write two files", allowAll, { ask: true }));
      const reqs = provider.requests() as { messages: { role: string; content: string }[] }[];
      // The pin travels in the one system message (transcript.wire), after the system prompt.
      const pins = reqs.map((r) => r.messages[0]!.content);
      assert.ok(pins.length >= 3);
      assert.ok(pins.every((p) => p === pins[0]), "byte-identical on every request of the turn");
      assert.match(pins[0]!, /Files changed so far: none/);
      await drain(engine.run("and now?", allowAll, { ask: true }));
      const later = provider.requests() as { messages: { role: string; content: string }[] }[];
      assert.match(later[later.length - 1]!.messages[0]!.content, /Files you have changed: a\.txt, b\.txt/);
    } finally {
      ws.cleanup();
    }
  });

  // Qwen's chat template on a local llama.cpp raised "System message must be
  // at the beginning" on the pinned task, a second system message: every
  // request failed with a 500.
  it("goes out as exactly one system message, first", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "write_file", args: { path: "a.txt", content: "a" } }] },
        { text: "done" },
      ]);
      await drain(engine.run("write a file", allowAll, { ask: true }));
      for (const r of provider.requests() as { messages: { role: string }[] }[]) {
        assert.equal(r.messages[0]!.role, "system");
        assert.equal(r.messages.filter((m) => m.role === "system").length, 1);
      }
    } finally {
      ws.cleanup();
    }
  });
});

describe("long tool output", () => {
  it("is trimmed in the conversation and kept whole in .maat/out, redacted, with the path given", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "bash", args: { command: "for i in $(seq 1 3000); do echo line-$i; done" } }] },
        { text: "done" },
      ]);
      await drain(engine.run("print a lot", allowAll, { ask: true }));
      const shown = firstToolResult(provider);
      const m = /the full output \((\d+) bytes\) is in (\.maat\/out\/[\w-]+\.txt)/.exec(shown);
      assert.ok(m, shown.slice(-300));
      const whole = readFileSync(join(ws.dir, m![2]!), "utf8");
      assert.match(whole, /^line-1\n/);
      assert.match(whole, /line-1500\n/, "the middle the preview cut is on disk");
      assert.match(whole, /line-3000\n$/);
      assert.equal(Buffer.byteLength(whole), Number(m![1]));
      assert.ok(Buffer.byteLength(shown) < 12_000, "the conversation carries the preview only");
    } finally {
      ws.cleanup();
    }
  });
});

describe("batch mode", () => {
  const act = (analysis: string, actions: { tool: string; args: Record<string, unknown> }[]): ScriptedTurn => ({
    calls: [{ name: "act", args: { analysis, plan: "p", actions } }],
  });

  it("expandAct turns an act into the ordinary calls it holds", async () => {
    const { expandAct } = await import("../src/engine.js");
    const e = expandAct({ id: "c1", function: { name: "act", arguments: JSON.stringify({ analysis: "a", plan: "b", actions: [{ tool: "bash", args: { command: "ls" } }, { tool: "read_file", args: { path: "x" } }, "junk"] }) } });
    assert.ok(e);
    assert.equal(e!.analysis, "a\n\nb");
    assert.deepEqual(e!.subs.map((x) => [x.id, x.name, x.rawArgs]), [["c1~0", "bash", '{"command":"ls"}'], ["c1~1", "read_file", '{"path":"x"}']]);
    assert.equal(expandAct({ id: "c", function: { name: "bash", arguments: "{}" } }), null);
    assert.equal(expandAct({ id: "c", function: { name: "act", arguments: "{not json" } }), null);
  });

  it("expandAct reads the shapes models drift into, and counts what it cannot read", async () => {
    const { expandAct } = await import("../src/engine.js");
    const one = (actions: unknown) => expandAct({ id: "c", function: { name: "act", arguments: JSON.stringify({ analysis: "a", actions }) } })!;
    const write = { path: "out.txt", content: "x" };
    // actions as a JSON string; name/arguments; arguments as a JSON string; function-call style; a lone object.
    assert.deepEqual(one(JSON.stringify([{ tool: "write_file", args: write }])).subs.map((x) => x.name), ["write_file"]);
    assert.deepEqual(one([{ name: "write_file", arguments: write }]).subs.map((x) => x.rawArgs), [JSON.stringify(write)]);
    assert.deepEqual(one([{ tool: "write_file", args: JSON.stringify(write) }]).subs.map((x) => x.rawArgs), [JSON.stringify(write)]);
    assert.deepEqual(one([{ type: "function", function: { name: "write_file", arguments: JSON.stringify(write) } }]).subs.map((x) => x.name), ["write_file"]);
    assert.deepEqual(one({ tool: "bash", args: { command: "ls" } }).subs.map((x) => x.name), ["bash"]);
    // Unreadable: nothing names a tool, or args that are not JSON.
    assert.deepEqual([one([{ write: write }]).subs.length, one([{ write: write }]).unusable], [0, 1]);
    assert.equal(one([{ tool: "write_file", args: "{not json" }]).unusable, 1);
    assert.equal(one([]).unusable, 0);
  });

  // Nemotron on local csv-clean: a long write arrived as an act Maat could not
  // read, nothing was read as an action, and the act was taken as "finished" —
  // a claim with no clean.csv, refused, and the turn stopped.
  it("an act whose actions cannot be read is answered with the expected shape, never taken as the answer", async () => {
    const ws = workspace();
    try {
      const { engine } = engineFor(ws.dir, [
        { calls: [{ name: "act", args: { analysis: "writing it", actions: [{ write: { path: "a.txt", content: "A\n" } }] } }] },
        act("now properly", [{ tool: "write_file", args: { path: "a.txt", content: "A\n" } }]),
        act("a.txt is written.", []),
      ], { batch: true, autonomy: "high" });
      const events = await drain(engine.run("write a.txt", allowAll));
      const results = events.filter((e) => e.kind === "tool").map((e) => JSON.stringify(e));
      assert.ok(results.some((r) => /nothing ran, because at least one of its actions could not be read/.test(r)), "the model was told what was wrong");
      const summaries = events.filter((e) => e.kind === "step_summary").map((e) => (e as { outcome: string }).outcome);
      assert.equal(summaries[0], "tools", "the unreadable act was not a claim");
      assert.ok(existsSync(join(ws.dir, "a.txt")));
    } finally {
      ws.cleanup();
    }
  });

  it("an act with one unreadable action among readable ones runs none of them", async () => {
    const ws = workspace();
    try {
      const { engine } = engineFor(ws.dir, [
        { calls: [{ name: "act", args: { analysis: "writing", actions: [{ tool: "write_file", args: { path: "a.txt", content: "A\n" } }, { write: "oops" }] } }] },
        act("now properly", [{ tool: "write_file", args: { path: "b.txt", content: "B\n" } }]),
        act("done.", []),
      ], { batch: true, autonomy: "high" });
      const events = await drain(engine.run("write a and b", allowAll));
      const results = events.filter((e) => e.kind === "tool").map((e) => JSON.stringify(e));
      assert.ok(results.some((r) => /nothing ran, because at least one of its actions could not be read/.test(r)), "the model was told");
      assert.equal(existsSync(join(ws.dir, "a.txt")), false, "the readable action was not run without its neighbour");
      assert.ok(existsSync(join(ws.dir, "b.txt")));
    } finally {
      ws.cleanup();
    }
  });

  it("offers only act, runs every action as a real call, folds the results, and an empty act is the answer", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [
        act("need two files", [
          { tool: "write_file", args: { path: "a.txt", content: "A\n" } },
          { tool: "write_file", args: { path: "b.txt", content: "B\n" } },
          { tool: "bash", args: { command: "cat a.txt b.txt" } },
        ]),
        act("Both files are written.", []),
      ], { batch: true });
      const events = await drain(engine.run("write a and b", allowAll, { ask: true }));
      const reqs = provider.requests() as { tools: { function: { name: string } }[]; messages: { role: string; content: string; tool_call_id?: string }[] }[];
      assert.deepEqual(reqs[0]!.tools.map((t) => t.function.name), ["act"]);
      assert.match(String(reqs[0]!.messages[0]!.content), /Batch mode: you have one tool, act/);
      const toolMsgs = reqs[1]!.messages.filter((m) => m.role === "tool");
      assert.equal(toolMsgs.length, 1, "one result for the one act call");
      assert.match(toolMsgs[0]!.content, /### 1\. write_file a\.txt[\s\S]*### 2\. write_file b\.txt[\s\S]*### 3\. bash cat a\.txt b\.txt\nA\nB/);
      assert.equal(readFileSync(join(ws.dir, "b.txt"), "utf8"), "B\n");
      assert.equal(engine.getLedger().length, 2, "each write is on the ledger");
      assert.equal(events.filter((e) => e.kind === "step_summary").length, 2, "three actions, one round trip");
      const answer = events.find((e) => e.kind === "assistant_text");
      assert.match(answer && "text" in answer ? answer.text : "", /Both files are written\./);
    } finally {
      ws.cleanup();
    }
  });

  it("each action still goes through the approval gate on its own", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "keep.txt"), "k");
      const { engine } = engineFor(ws.dir, [
        act("tidy", [{ tool: "bash", args: { command: "echo ok" } }, { tool: "bash", args: { command: "rm keep.txt" } }]),
        act("done", []),
      ], { batch: true, autonomy: "high" });
      const asked: string[] = [];
      await drain(engine.run("tidy up", async (_n, d) => { asked.push(d); return false; }, { ask: true }));
      assert.equal(asked.length, 1);
      assert.match(asked[0]!, /rm keep\.txt/);
      assert.equal(existsSync(join(ws.dir, "keep.txt")), true);
    } finally {
      ws.cleanup();
    }
  });
});

describe("effort after a refusal", () => {
  it("steps run at the base effort until the checks refuse a claim, then at the retry effort, and reset next turn", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [
        { text: "done" },
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "x" } }] },
        { text: "done now" },
        { text: "hello" },
      ], { reasoningEffort: "low", retryReasoningEffort: "high", maxProofAttempts: 3 });
      const check = { name: "made", kind: "command" as const, run: "test -f out.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task"] };
      const events = await drain(engine.run("make out.txt", allowAll, { taskChecks: [check] }));
      const efforts = (provider.requests() as { reasoning?: { effort: string } }[]).map((r) => r.reasoning?.effort);
      assert.deepEqual(efforts.slice(0, 3), ["low", "high", "high"]);
      assert.ok(events.some((e) => e.kind === "info" && /reasoning effort raised to high for the retry/.test(e.text)));
      await drain(engine.run("? say hello", allowAll, { ask: true }));
      const all = (provider.requests() as { reasoning?: { effort: string } }[]).map((r) => r.reasoning?.effort);
      assert.equal(all[all.length - 1], "low", "a new turn starts at the base effort");
    } finally {
      ws.cleanup();
    }
  });
});
