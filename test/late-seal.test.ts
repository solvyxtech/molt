/**
 * `maat run --criteria auto --for …` when the time budget seals the checks
 * before the drafter has finished.
 *
 * The engine seals what was reviewed so far and the work begins; the drafter
 * kept going, and when it finished the CLI sealed its draft a second time.
 * That second seal ran the preflight in the folder the model was working in,
 * and the preflight's cleanup removes every file that appeared while it ran —
 * the model's included. Seen first as the drafted criteria printed twice.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

const reply = (message: Record<string, unknown>) =>
  JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

describe("criteria sealed early by the time budget", () => {
  it("are not sealed a second time when the drafter finishes after the work began", async () => {
    let turn = 0;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const j = JSON.parse(body) as { tools?: unknown[]; messages: { content: string }[] };
        res.writeHead(200, { "content-type": "application/json" });
        if (!j.tools) {
          // The drafter (and its critic): slow, long after the turn has ended.
          const drafting = /draft acceptance criteria/.test(j.messages[0]!.content);
          const text = drafting
            ? JSON.stringify({ checks: [{ name: "late-check", run: "test -f out.txt" }], notes: [] })
            : JSON.stringify({ checks: [{ name: "late-check", verdict: "runs", quote: "" }], uncovered: [] });
          setTimeout(() => res.end(reply({ role: "assistant", content: text })), drafting ? 1_500 : 0);
          return;
        }
        turn += 1;
        // The work is still going (a slow second step) when the draft lands.
        if (turn === 1) {
          res.end(reply({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "hi\n" }) } }] }));
        } else {
          setTimeout(() => res.end(reply({ role: "assistant", content: "Done: out.txt written." })), 3_000);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => server.close());
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const w = workspace();
    cleanups.push(w.cleanup);

    const out = await new Promise<string>((done, fail) => {
      const p = spawn(
        process.execPath,
        [resolve("dist/cli.js"), "run", "write out.txt", "--url", url, "--model", "m", "--yes", "--criteria", "auto", "--for", "5m", "--no-stream", "--no-brief"],
        // The mock is on 127.0.0.1, which Maat serves one request at a time (src/localgate.ts);
        // this is about a provider that serves them side by side, so say it has the slots.
        { cwd: w.dir, env: { ...process.env, NO_COLOR: "1", MAAT_CRITERIA_WAIT_MS: "100", MAAT_LOCAL_SLOTS: "8" } },
      );
      let text = "";
      p.stdout.on("data", (d) => (text += String(d)));
      p.stderr.on("data", (d) => (text += String(d)));
      const kill = setTimeout(() => {
        p.kill();
        fail(new Error(`timed out:\n${text}`));
      }, 30_000);
      p.on("close", () => {
        clearTimeout(kill);
        done(text);
      });
    });
    const sealedEarly = out.indexOf("checks were still being drafted");
    assert.ok(sealedEarly !== -1, `the budget sealed early:\n${out}`);
    // Nothing was ready at the cut, so the draft joins at the claim rather than
    // sealing an empty set — once, and untried in the live folder: the preflight
    // and its cleanup would have removed the model's own out.txt.
    assert.equal(out.match(/criterion late-check/g)?.length, 1, `the late draft joined exactly once:\n${out}`);
    assert.match(out, /joined this turn's checks/, out);
    assert.ok(existsSync(join(w.dir, "out.txt")), `the model's file survived the late seal:\n${out}`);
    assert.doesNotMatch(out, /dropped drafted criterion/, out);
  });
});
