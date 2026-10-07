/**
 * `molt --acp` end to end: the built binary, a real pipe, molt's own ACP
 * client on the other end, and a provider on a real socket.
 *
 * This is the configuration an editor runs. It pins the four things an editor
 * depends on and a unit test cannot see: that the process speaks the protocol
 * at all once built, that a permission question makes the round trip through
 * a real pipe, that session/cancel stops a command already running, and that
 * stdout carries JSON-RPC frames and not one byte of anything else.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AcpConnection, type AcpAgentSpec } from "../src/acp.js";
import { scriptServer, type Script } from "./acp-provider.js";

// The shipped build, which `npm test` rebuilds before the suite runs.
const CLI = join(process.cwd(), "dist", "cli.js");

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

const BAR = `version: 1
checks:
  - name: work-landed
    builtin: files-changed
  - name: hello-exists
    run: "test -f hello.txt"
`;

/** "write" prompts write hello.txt; "sleep" prompts start a long command. */
const script: Script = (r) => {
  const asked = r.users.at(-1) ?? "";
  if (/sleep/.test(asked)) {
    return r.toolsSinceUser === 0 ? { calls: [{ name: "bash", args: { command: "sleep 30" } }] } : { text: "slept" };
  }
  return r.toolsSinceUser === 0
    ? {
        thought: "hello.txt does not exist yet",
        text: "Creating hello.txt.",
        calls: [{ name: "write_file", args: { path: "hello.txt", content: "hello, editor\n" } }],
      }
    : { text: "Done: hello.txt holds the greeting." };
};

type Update = Record<string, unknown> & { sessionUpdate: string };

async function start() {
  const provider = await scriptServer(script);
  cleanups.push(provider.close);
  const project = mkdtempSync(join(tmpdir(), "molt-acp-e2e-"));
  const config = mkdtempSync(join(tmpdir(), "molt-acp-cfg-"));
  cleanups.push(() => rmSync(project, { recursive: true, force: true }));
  cleanups.push(() => rmSync(config, { recursive: true, force: true }));
  mkdirSync(join(project, ".molt"), { recursive: true });
  writeFileSync(join(project, ".molt", "done.yml"), BAR);

  const spec = {
    name: "molt",
    label: "molt",
    url: "molt://acp",
    bin: process.execPath,
    args: [
      CLI,
      "--acp",
      "--url", provider.url,
      "--model", "stub-model",
      "--key", "stub-key",
      "--price-in", "1",
      "--price-out", "2",
    ],
    models: [],
    installHint: "",
    loginHint: "",
    credentialPath: "",
    mcpTransport: "http",
    sessionMeta: () => ({}),
  } as AcpAgentSpec;

  let stdout = "";
  let stderr = "";
  let child: ChildProcess | undefined;
  const updates: Update[] = [];
  const asked: Record<string, unknown>[] = [];
  const fsCalls: string[] = [];
  let onUpdate: (u: Update) => void = () => {};

  const conn = new AcpConnection(spec, {
    cwd: project,
    // The raw bytes are tapped here, beside the connection's own reader, so
    // the test sees exactly what an editor would have to parse.
    spawnFn: ((bin: string, args: string[], opts: Record<string, unknown>) => {
      child = spawn(bin, args, {
        ...opts,
        // No subscription CLI is probed: which ones are signed in is a fact
        // about the laptop, not about molt.
        env: { ...process.env, MOLT_CONFIG_DIR: config, MOLT_ACP_SUBSCRIPTIONS: "" },
      });
      child.stdout!.on("data", (d: Buffer | string) => (stdout += String(d)));
      child.stderr!.on("data", (d: Buffer | string) => (stderr += String(d)));
      return child;
    }) as unknown as typeof spawn,
    onNotify: (method, params) => {
      if (method !== "session/update") return;
      const u = (params as { update: Update }).update;
      updates.push(u);
      onUpdate(u);
    },
    onRequest: async (method, params) => {
      const p = params as Record<string, unknown>;
      if (method === "session/request_permission") {
        asked.push(p);
        return { outcome: { outcome: "selected", optionId: "allow_once" } };
      }
      if (method === "fs/read_text_file") {
        fsCalls.push(`read ${String(p.path)}`);
        return { content: readFileSync(String(p.path), "utf8") };
      }
      if (method === "fs/write_text_file") {
        fsCalls.push(`write ${String(p.path)}`);
        writeFileSync(String(p.path), String(p.content));
        return {};
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  await conn.start();
  cleanups.push(() => conn.close());
  return {
    conn,
    project,
    updates,
    asked,
    fsCalls,
    onUpdate: (f: (u: Update) => void) => (onUpdate = f),
    stdout: () => stdout,
    stderr: () => stderr,
    child: () => child!,
  };
}

describe("molt --acp, spawned", { timeout: 90_000 }, () => {
  it("runs a turn, asks, cancels, and writes nothing to stdout but JSON-RPC", async () => {
    const m = await start();
    const init = (await m.conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: "e2e", version: "0" },
    })) as { protocolVersion: number; agentInfo: { name: string } };
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentInfo.name, "molt");

    const { sessionId } = (await m.conn.request("session/new", {
      cwd: m.project,
      mcpServers: [],
    })) as { sessionId: string };
    assert.ok(sessionId);

    // --- a real turn: stream, ask, write, prove -----------------------------
    const done = (await m.conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "write hello.txt" }],
    })) as { stopReason: string; _meta: { molt: { verdict: string; receipt: string } } };

    assert.equal(done.stopReason, "end_turn", m.stderr());
    assert.equal(done._meta.molt.verdict, "met");
    assert.equal(readFileSync(join(m.project, "hello.txt"), "utf8"), "hello, editor\n");

    const text = m.updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.content as { text: string }).text)
      .join("");
    assert.match(text, /Creating hello\.txt\./);
    assert.match(text, /Done: hello\.txt holds the greeting\./);
    assert.match(text, /molt · bar met/);
    assert.ok(m.updates.some((u) => u.sessionUpdate === "agent_thought_chunk"));

    const call = m.updates.find((u) => u.sessionUpdate === "tool_call" && u.kind === "edit");
    assert.ok(call, "an edit tool_call was announced");
    const finished = m.updates.find(
      (u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === call.toolCallId && u.status === "completed",
    );
    assert.ok(finished, "and completed");
    assert.deepEqual((finished.content as unknown[])[0], {
      type: "diff",
      path: join(m.project, "hello.txt"),
      oldText: null,
      newText: "hello, editor\n",
    });

    // The permission question made the round trip, about that call.
    assert.equal(m.asked.length, 1);
    assert.equal((m.asked[0]!.toolCall as { toolCallId: string }).toolCallId, call.toolCallId);
    // And the write went through the editor.
    assert.ok(m.fsCalls.includes(`write ${join(m.project, "hello.txt")}`), m.fsCalls.join(", "));

    const usage = m.updates.filter((u) => u.sessionUpdate === "usage_update");
    assert.ok(usage.length >= 2);
    assert.equal((usage.at(-1)!.cost as { currency: string }).currency, "USD");
    assert.ok(m.updates.some((u) => u.sessionUpdate === "plan"));

    // --- cancel stops a command that is already running ---------------------
    m.onUpdate((u) => {
      if (u.sessionUpdate === "tool_call_update" && u.status === "in_progress") {
        m.conn.notify("session/cancel", { sessionId });
      }
    });
    const t0 = Date.now();
    const cancelled = (await m.conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "sleep for a while" }],
    })) as { stopReason: string };
    const took = Date.now() - t0;
    assert.equal(cancelled.stopReason, "cancelled");
    assert.ok(took < 20_000, `cancel took ${took}ms — the sleep was not killed`);
    assert.equal(m.asked.length, 2, "the command was asked about before it ran");

    // --- stdout: frames, and nothing else -----------------------------------
    await m.conn.close();
    await new Promise<void>((r) => (m.child().exitCode !== null ? r() : m.child().once("exit", () => r())));
    const out = m.stdout();
    assert.ok(out.length > 0);
    assert.ok(out.endsWith("\n"), "every frame is newline-terminated");
    const lines = out.split("\n").slice(0, -1);
    for (const line of lines) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        assert.fail(`stdout carried a non-JSON line: ${JSON.stringify(line.slice(0, 200))}`);
      }
      assert.equal(msg.jsonrpc, "2.0", line.slice(0, 200));
      const isResponse = "id" in msg && ("result" in msg || "error" in msg) && !("method" in msg);
      const isCall = typeof msg.method === "string";
      assert.ok(isResponse || isCall, `not a JSON-RPC message: ${line.slice(0, 200)}`);
    }
    // Diagnostics went to stderr, where they belong.
    assert.match(m.stderr(), /molt acp: session /);
    assert.ok(existsSync(join(m.project, ".molt", "receipts")));
  });

  it("an unknown flag still fails before any frame is written", async () => {
    const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const c = spawn(process.execPath, [CLI, "--acp", "--nope"], { env: { ...process.env } });
      let out = "";
      c.stdout.on("data", (d) => (out += String(d)));
      c.on("exit", (code) => resolve({ code, out }));
      c.stdin.end();
    });
    assert.equal(r.code, 2);
    assert.equal(r.out, "");
  });
});
