/**
 * `molt run` when a streamed reply is abandoned part-way and replayed.
 *
 * The engine says so with `stream_reset`, and `src/types.ts` is plain that a
 * surface rendering `delta` must handle it. `molt run` did not: the abandoned
 * text stayed on stdout and the replay followed it, so a CI log held the
 * answer twice — the first copy cut off mid-word — with nothing to say which
 * one the model finished. The TUI's half of this is in tui.test.ts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

const sse = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;

describe("molt run, when a stream is replayed", () => {
  it("says the text above was abandoned instead of printing the answer twice unmarked", async () => {
    let n = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        n += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (n === 1) {
          res.write(sse("an abandoned line\nthe first attem"));
          // Cut the connection after the words are out.
          setTimeout(() => res.socket?.destroy(), 80);
          return;
        }
        res.end(
          sse("the answer") +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
            "data: [DONE]\n\n",
        );
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
        [resolve("dist/cli.js"), "run", "answer me", "--url", url, "--model", "m", "--yes"],
        { cwd: w.dir, env: { ...process.env, NO_COLOR: "1" } },
      );
      let text = "";
      p.stdout.on("data", (d) => (text += String(d)));
      p.stderr.on("data", (d) => (text += String(d)));
      const kill = setTimeout(() => {
        p.kill();
        fail(new Error(`molt run did not finish:\n${text}`));
      }, 20_000);
      p.on("close", () => {
        clearTimeout(kill);
        done(text);
      });
    });

    assert.equal(n, 2, `expected one retry, the server saw ${n} request(s):\n${out}`);
    assert.match(out, /an abandoned line/);
    assert.match(out, /The reply above was abandoned; it starts again below/);
    // The marker sits between the abandoned copy and the replay.
    assert.ok(
      out.indexOf("abandoned; it starts again") > out.indexOf("the first attem") &&
        out.indexOf("abandoned; it starts again") < out.lastIndexOf("the answer"),
      out,
    );
  });
});
