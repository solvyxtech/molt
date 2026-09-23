/**
 * What `molt run` tells CI, in one number.
 *
 * With no `.molt/done.yml`, a run exited 0: the one case where nothing was
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

function project(bar?: string): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  if (bar !== undefined) {
    mkdirSync(join(w.dir, ".molt"), { recursive: true });
    writeFileSync(join(w.dir, ".molt", "done.yml"), bar);
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

  it("is 3 when required checks were left out, not 1 as though something failed", async () => {
    assert.equal(await run(project(BAR), "--skip", "slow"), 3);
  });
});
