/**
 * A time budget is Maat's own, whatever the backend does.
 *
 * Measured 2026-10-07: a bench run given `--for 540s` on Grok Build logged a
 * job_end of 3,569,961 ms. One ACP prompt turn hung for an hour and nothing
 * bounded the wait for its reply. These pin the fix: every wait on a backend
 * is cut at the deadline, the agent is told `session/cancel` and its whole
 * process tree is ended, the journal says why, and a backend that goes silent
 * is a provider stall — not a failure of the task.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ACP_AGENTS, backendStallMs, BACKEND_STALL_MS } from "../src/acp.js";
import { askModel } from "../src/ask.js";
import { deadlineGraceMs, Engine } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import type { EngineEvent } from "../src/types.js";
import { scriptedAcpAgent } from "./acp-agent.js";
import { allowAll, drain, workspace } from "./helpers.js";

const GROK = ACP_AGENTS.find((a) => a.name === "grok-build")!;
const CLI = join(process.cwd(), "dist-test", "src", "cli.js");

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws(): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

function jobEnd(events: EngineEvent[]) {
  const e = events.find((x) => x.kind === "job_end");
  assert.ok(e && e.kind === "job_end");
  return e;
}

/**
 * A `grok` that takes the prompt and never answers — the hang as measured.
 * Worst case on purpose: it ignores SIGTERM, and it has a child of its own
 * (`sleep 300`) that a kill of one pid would leave behind.
 */
const HUNG_AGENT = `#!/usr/bin/env node
const fs = require("fs");
const { spawn } = require("child_process");
const log = process.env.FAKE_ACP_LOG;
const note = (s) => { if (log) fs.appendFileSync(log, s + "\\n"); };
note("pid " + process.pid);
const kid = spawn("sleep", ["300"], { stdio: "ignore" });
note("pid " + kid.pid);
process.on("SIGTERM", () => note("sigterm ignored"));
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\n")) >= 0; ) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
    else if (m.method === "session/cancel") note("cancel");
    else if (m.method === "session/prompt") note("prompt");
    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function allGone(pids: number[], withinMs: number): Promise<number[]> {
  const until = Date.now() + withinMs;
  for (;;) {
    const left = pids.filter(alive);
    if (!left.length || Date.now() > until) return left;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("an ACP agent that never answers, under --for 5s", { skip: process.platform === "win32" }, () => {
  it("ends the job on time, cancels and kills the agent's process tree, and journals why", async () => {
    const root = ws();
    const bin = join(root, "bin");
    const dir = join(root, "project");
    mkdirSync(bin);
    mkdirSync(dir);
    writeFileSync(join(bin, "grok"), HUNG_AGENT);
    chmodSync(join(bin, "grok"), 0o755);
    const agentLog = join(root, "agent.log");

    const t0 = Date.now();
    const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [CLI, "run", "write a.txt", "--url", "grok-build", "--model", "grok-4.6", "--for", "5s", "--json", "--yes", "--cwd", dir],
        {
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_ACP_LOG: agentLog, MOLT_CONFIG_DIR: join(root, "cfg") },
        },
      );
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.on("exit", (c) => resolve({ code: c ?? -1, stdout: out }));
    });
    const took = Date.now() - t0;

    // 5 s of budget, the cancel grace, and a closing summary bounded by its
    // 1 s grace — not the hour the hung prompt would have held it.
    assert.ok(took < 11_000, `the job took ${took}ms on a 5s budget`);
    const end = stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as { kind: string; durationMs?: number; deadline?: boolean; endedBy?: string; outcome?: string })
      .find((e) => e.kind === "job_end");
    assert.ok(end, `no job_end in:\n${stdout}`);
    assert.equal(end.deadline, true);
    assert.equal(end.endedBy, "deadline");
    assert.notEqual(end.outcome, "verified");
    assert.ok((end.durationMs ?? Infinity) < 9_000, `job_end durationMs ${end.durationMs}`);
    assert.notEqual(code, 0);

    // The agent was asked to cancel, and then it and its child were ended —
    // SIGTERM ignored or not.
    const said = readFileSync(agentLog, "utf8");
    assert.match(said, /^prompt$/m);
    assert.match(said, /^cancel$/m);
    const pids = [...said.matchAll(/^pid (\d+)$/gm)].map((m) => Number(m[1]));
    assert.ok(pids.length >= 2, said);
    assert.deepEqual(await allGone(pids, 3_000), [], "agent processes outlived the job");

    // The journal says the clock ended it, and how.
    const logs = join(dir, ".maat", "log");
    const file = readdirSync(logs).find((f) => f.endsWith(".jsonl"));
    assert.ok(file);
    const rows = Journal.read(join(logs, file));
    assert.equal(rows.filter((r) => r.kind === "deadline").length, 1);
    assert.ok(
      rows.some((r) => r.kind === "note" && /session\/cancel sent, agent process tree ended/.test(String(r.data.text))),
      "the journal does not say the agent was cancelled and killed",
    );
  });
});

describe("the deadline inside the engine, on a subprocess backend", () => {
  it("cuts a hung prompt turn at the budget and judges the turn as a deadline", async () => {
    const dir = ws();
    const agent = scriptedAcpAgent([{ hang: true }, { hang: true }]);
    const journal = new Journal(dir, "acp-deadline");
    const engine = new Engine({
      baseUrl: GROK.url, model: "grok-4.6", provider: "grok-build", cwd: dir, bar: null,
      acpSpawn: agent.spawnFn, autonomy: "high", turnDeadlineMs: 400, journal,
    });
    const t0 = Date.now();
    const events = await drain(engine.run("write a.txt", allowAll));
    assert.ok(Date.now() - t0 < 4_000, `took ${Date.now() - t0}ms on a 400ms budget`);
    const e = jobEnd(events);
    assert.equal(e.deadline, true);
    assert.equal(e.endedBy, "deadline");
    assert.notEqual(e.outcome, "verified");
    assert.ok(!e.providerStall);
    const rows = Journal.read(journal.path);
    assert.equal(rows.filter((r) => r.kind === "deadline").length, 1);
    assert.ok(!rows.some((r) => r.kind === "error"), "running out of time is not an error");
  });
});

describe("a backend that goes silent", () => {
  it("is a provider stall: cancelled, journalled as a provider issue, not a task failure", async () => {
    const dir = ws();
    const agent = scriptedAcpAgent([{ hang: true }]);
    const journal = new Journal(dir, "acp-stall");
    const engine = new Engine({
      baseUrl: GROK.url, model: "grok-4.6", provider: "grok-build", cwd: dir, bar: null,
      acpSpawn: agent.spawnFn, autonomy: "high", backendStallMs: 300, journal,
    });
    const t0 = Date.now();
    const events = await drain(engine.run("write a.txt", allowAll));
    assert.ok(Date.now() - t0 < 4_000);
    const e = jobEnd(events);
    assert.equal(e.providerStall, true);
    assert.equal(e.endedBy, "provider");
    assert.ok(!e.deadline);
    assert.ok(events.some((x) => x.kind === "error" && /provider stall/.test(x.text) && /not the task/.test(x.text)));
    const stall = Journal.read(journal.path).find((r) => r.kind === "error" && r.data.providerStall === true);
    assert.ok(stall, "no provider-stall row in the journal");
    assert.equal(stall.data.providerIssue, true);
  });

  it("does not count Maat's own tool time as the agent's silence", async () => {
    const dir = ws();
    const agent = scriptedAcpAgent([
      { calls: [{ name: "bash", args: { command: "sleep 0.8" } }], text: "Slept." },
    ]);
    const engine = new Engine({
      baseUrl: GROK.url, model: "grok-4.6", provider: "grok-build", cwd: dir, bar: null,
      acpSpawn: agent.spawnFn, autonomy: "high", backendStallMs: 300,
    });
    const events = await drain(engine.run("sleep a bit", allowAll));
    const e = jobEnd(events);
    assert.ok(!e.providerStall, "a tool that ran longer than the stall allowance was called a stall");
    assert.ok(events.some((x) => x.kind === "assistant_text" && /Slept/.test(x.text)));
  });

  it("reads MAAT_BACKEND_STALL_MS, five minutes by default, 0 for never", () => {
    assert.equal(BACKEND_STALL_MS, 300_000);
    assert.equal(backendStallMs(undefined), 300_000);
    assert.equal(backendStallMs("1500"), 1500);
    assert.equal(backendStallMs("0"), 0);
    assert.equal(backendStallMs("soon"), 300_000);
  });
});

/** A fetch that answers nothing until it is aborted. */
const hangingFetch = (async (_url: string, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
  })) as unknown as typeof fetch;

describe("the other waits on a provider, under a time budget", () => {
  it("an ask (draft, critic, review) is cut at the deadline, not at its own allowance", async () => {
    const t0 = Date.now();
    const r = await askModel({
      baseUrl: "http://provider.test/v1", model: "m", system: "s", prompt: "p",
      fetchFn: hangingFetch, timeoutMs: 60_000, deadlineAt: Date.now() + 300,
    });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - t0 < 3_000, `the ask waited ${Date.now() - t0}ms past a 300ms budget`);
  });

  it("an ask with the budget already spent is not made at all", async () => {
    let asked = 0;
    const r = await askModel({
      baseUrl: "http://provider.test/v1", model: "m", system: "s", prompt: "p", what: "reviewing the claim",
      fetchFn: (async () => {
        asked += 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
      deadlineAt: Date.now() - 1,
    });
    assert.deepEqual(r, { ok: false, error: "the time budget ran out before reviewing the claim" });
    assert.equal(asked, 0);
  });

  it("the closing summary after the deadline is bounded by a short grace, on HTTP too", async () => {
    const dir = ws();
    // The watchdog is off, so only the clock can end either request.
    const engine = new Engine({
      baseUrl: "http://provider.test/v1", model: "m", cwd: dir, bar: null, fetchFn: hangingFetch,
      stream: false, autonomy: "high", turnDeadlineMs: 300, requestIdleMs: 0,
    });
    const t0 = Date.now();
    const events = await drain(engine.run("hi", allowAll));
    const took = Date.now() - t0;
    assert.ok(took < 300 + deadlineGraceMs(300) + 2_000, `took ${took}ms`);
    assert.equal(jobEnd(events).deadline, true);
    assert.equal(deadlineGraceMs(300), 1_000);
    assert.equal(deadlineGraceMs(540_000), 30_000);
    assert.equal(deadlineGraceMs(60_000), 6_000);
  });
});
