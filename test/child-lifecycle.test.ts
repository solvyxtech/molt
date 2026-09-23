/**
 * A subscription CLI is a child process, and two ways it outlived or outran molt.
 *
 *  - A cancel during start-up reached `close` while the session was still
 *    awaiting its tool server (or Antigravity's setup, which can run `agy mcp
 *    add`). There was no child yet, so nothing was killed — and start-up then
 *    carried on and spawned one that nothing would ever stop.
 *  - Writing to a child that has died raises EPIPE as an 'error' event on its
 *    stdin. Nobody listened, and an unheard 'error' event is thrown: in the
 *    window, from Electron's main process.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { ACP_AGENTS, AcpConnection, AcpSession } from "../src/acp.js";
import { AgySession } from "../src/agy.js";

const GROK = ACP_AGENTS.find((a) => a.name === "grok-build")!;

/** A child whose stdin can be made to fail, and a count of spawns. */
function fakeSpawn() {
  const spawned: (EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough })[] = [];
  const fn = ((): unknown => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    spawned.push(child);
    return child;
  }) as unknown as typeof spawn;
  return { fn, spawned };
}

describe("a cancel during start-up does not leave a CLI running", () => {
  it("Antigravity: closed during setup, never spawned", async () => {
    const { fn, spawned } = fakeSpawn();
    let release!: () => void;
    const setupDone = new Promise<void>((r) => (release = r));
    const session = new AgySession<unknown>({
      model: "m",
      cwd: process.cwd(),
      systemPrompt: "s",
      tools: [],
      runTool: async () => "",
      setup: () => setupDone,
      spawnFn: fn,
    });
    const turn = (async () => {
      for await (const _ of session.send(["hi"])) void _;
    })();
    await new Promise((r) => setTimeout(r, 20));
    await session.close();
    release();
    await turn;
    assert.equal(spawned.length, 0, "an agy started after close would run with nobody to stop it");
  });

  it("ACP: closed while the tool server starts, never spawned", async () => {
    const { fn, spawned } = fakeSpawn();
    const session = new AcpSession<unknown>({
      spec: GROK,
      model: "",
      cwd: process.cwd(),
      systemPrompt: "s",
      tools: [],
      runTool: async () => "",
      spawnFn: fn,
    });
    const turn = (async () => {
      for await (const _ of session.send(["hi"])) void _;
    })();
    await session.close();
    await turn;
    assert.equal(spawned.length, 0);
  });
});

describe("a dead child's stdin does not throw", () => {
  it("ACP: EPIPE fails the pending request instead of crashing the process", async () => {
    const { fn, spawned } = fakeSpawn();
    const conn = new AcpConnection(GROK, { cwd: process.cwd(), spawnFn: fn });
    await conn.start();
    const pending = conn.request("initialize", {});
    spawned[0]!.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await assert.rejects(pending, /EPIPE/);
  });

  it("Antigravity: EPIPE ends the turn with the error", async () => {
    const { fn, spawned } = fakeSpawn();
    const session = new AgySession<unknown>({
      model: "m",
      cwd: process.cwd(),
      systemPrompt: "s",
      tools: [],
      runTool: async () => "",
      setup: async () => {},
      spawnFn: fn,
    });
    const events: { kind: string; error?: string }[] = [];
    const turn = (async () => {
      for await (const e of session.send(["hi"])) events.push(e as { kind: string; error?: string });
    })();
    await new Promise((r) => setTimeout(r, 20));
    spawned[0]!.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await turn;
    await session.close();
    assert.match(events.find((e) => e.kind === "done")?.error ?? "", /EPIPE/);
  });
});
