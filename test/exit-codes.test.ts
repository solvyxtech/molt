/**
 * What `molt run` tells CI, in one number.
 *
 * With no `.maat/done.yml`, a run exited 0: the one case where nothing was
 * checked read to CI exactly like the case where everything was — under a
 * comment saying "an unverified answer is not a success". And a bar that was
 * only partly run exited 1, as though the work had failed something it was
 * never asked. Three answers get three codes: 0 verified, 1 not met, 3
 * finished without a verdict.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { workspace } from "./helpers.js";

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});

/** A provider that writes one file, then says it is done. */
async function provider(): Promise<string> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const message =
        n++ % 2 === 0
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_${n}`,
                  type: "function",
                  function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "a\n" }) },
                },
              ],
            }
          : { role: "assistant", content: "Done: wrote a.txt." };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;
}

/**
 * Like `provider`, but it also answers molt's own pre-turn questions: the
 * criteria drafter gets one check that the work satisfies, and the critic
 * judges it a real run of the deliverable.
 */
async function draftingProvider(check = "[ \"$(cat a.txt)\" = \"a\" ]"): Promise<string> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reply = (content: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: content, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      };
      if (body.includes("You draft acceptance criteria")) {
        return reply({ role: "assistant", content: JSON.stringify({ checks: [{ name: "made", run: check }], notes: [] }) });
      }
      if (body.includes("You review acceptance checks")) {
        return reply({ role: "assistant", content: JSON.stringify({ checks: [{ name: "made", verdict: "runs", quote: "" }] }) });
      }
      reply(
        n++ % 2 === 0
          ? { role: "assistant", content: null, tool_calls: [{ id: `call_${n}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "a\n" }) } }] }
          : { role: "assistant", content: "Done: wrote a.txt." },
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;
}

function project(bar?: string): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  if (bar !== undefined) {
    mkdirSync(join(w.dir, ".maat"), { recursive: true });
    writeFileSync(join(w.dir, ".maat", "done.yml"), bar);
  }
  return w.dir;
}

/**
 * Run the real binary in a child. Not `main()` in-process: the test runner
 * reports through this process's stdout, and silencing molt's output there
 * silenced the runner's too. Async, because the provider is served from here.
 */
// The copy compiled with this suite, not `dist/`, which may predate it.
const CLI = join(process.cwd(), "dist-test", "src", "cli.js");
function molt(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      stdio: "ignore",
      env: { ...process.env, MOLT_CONFIG_DIR: project() },
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

const run = async (dir: string, ...extra: string[]) =>
  molt(["run", "write a.txt", "--url", await provider(), "--model", "m", "--key", "k",
    "--cwd", dir, "--no-stream", "--yes", ...extra]);

const BAR = `version: 1
checks:
  - name: fast
    run: "true"
    tags: [fast]
  - name: slow
    run: "true"
    tags: [slow]
`;

describe("molt run's exit code", () => {
  it("is 0 only when the bar was met", async () => {
    assert.equal(await run(project(BAR)), 0);
  });

  it("is 1 when the bar was not met", async () => {
    assert.equal(await run(project(BAR.replace('run: "true"\n    tags: [slow]', 'run: "false"\n    tags: [slow]')), "--attempts", "1"), 1);
  });

  it("is 3 when there was no bar to meet — not the same answer as verified", async () => {
    assert.equal(await run(project()), 3);
  });

  it("is 0 with no bar when sealed task criteria were met: those are a verdict", async () => {
    // A benchmark trial read exit 3 on a turn molt had verified against the
    // criteria it drafted, because the check above did not look at them.
    assert.equal(await run(project(), "--criterion", "made=test -f a.txt"), 0);
    assert.equal(await run(project(), "--criterion", "made=test -f b.txt", "--attempts", "1"), 1);
  });

  it("is 0 when checks drafted while the model read were met (--criteria auto)", async () => {
    // Drafted criteria arrive while the model reads, so none are passed in up
    // front. The exit code read that as "no criteria" and a verified turn
    // exited 3. It is decided by the turn's own outcome now. Drafted by a
    // separate judge: checks the worker drafts for itself never verify.
    const url = await draftingProvider();
    const code = await molt(["run", "write a.txt", "--url", url, "--model", "m", "--key", "k",
      "--cwd", project(), "--no-stream", "--yes", "--criteria", "auto", "--judge", "j"]);
    assert.equal(code, 0);
  });

  it("is 3 when the only checks met were drafted by the worker itself (passed own checks)", async () => {
    const url = await draftingProvider();
    const code = await molt(["run", "write a.txt", "--url", url, "--model", "m", "--key", "k",
      "--cwd", project(), "--no-stream", "--yes", "--criteria", "auto"]);
    assert.equal(code, 3);
    // A judge that is the worker under a provider's spelling is the worker.
    const same = await molt(["run", "write a.txt", "--url", url, "--model", "m", "--key", "k",
      "--cwd", project(), "--no-stream", "--yes", "--criteria", "auto", "--judge", "openrouter/m:free"]);
    assert.equal(same, 3);
  });

  it("is 3 when the only independent check met also passed before the work (it did not test this work)", async () => {
    const url = await draftingProvider("[ \"$(echo a)\" = \"a\" ]");
    const code = await molt(["run", "write a.txt", "--url", url, "--model", "m", "--key", "k",
      "--cwd", project(), "--no-stream", "--yes", "--criteria", "auto", "--judge", "j"]);
    assert.equal(code, 3);
  });

  it("is 3 when required checks were left out, not 1 as though something failed", async () => {
    assert.equal(await run(project(BAR), "--skip", "slow"), 3);
  });
});
