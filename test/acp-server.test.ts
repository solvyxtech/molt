/**
 * molt as an ACP agent, driven in-process by a minimal client.
 *
 * The client here is molt's own RpcPeer on the other end of an in-memory
 * pipe, answering permission questions and file requests the way an editor
 * would. The engine behind the server is a real Engine against the scripted
 * provider, with a real bar and real receipts — so what these pin is the
 * whole mapping: molt's turn, as an editor sees it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import {
  ACP_PROTOCOL_VERSION,
  AcpServer,
  alwaysKey,
  permissionOptions,
  planFromResult,
  promptText,
  stopReasonFor,
  toolFailed,
  toolKind,
  toolLocations,
  toolTitle,
  verdictText,
} from "../src/acp-server.js";
import { Archive } from "../src/archive.js";
import { parseBar } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, RpcError, RpcPeer } from "../src/jsonrpc.js";
import { Receipts } from "../src/receipts.js";
import type { BarResult, CheckResult, EngineEvent } from "../src/types.js";
import { scriptFetch, type Script } from "./acp-provider.js";
import { workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

const BAR = `version: 1
checks:
  - name: work-landed
    builtin: files-changed
  - name: out-exists
    run: "test -f out.txt"
`;

type Update = Record<string, unknown> & { sessionUpdate: string };
type Req = { method: string; params: Record<string, unknown> };

type HarnessOpts = {
  script: Script;
  bar?: string | null;
  fs?: { read?: boolean; write?: boolean };
  /** Answer to session/request_permission. Default: allow once. */
  permit?: (params: Record<string, unknown>) => Promise<unknown> | unknown;
  priced?: boolean;
  maxProofAttempts?: number;
  stream?: boolean;
};

async function harness(o: HarnessOpts) {
  const w = workspace();
  cleanups.push(w.cleanup);
  const dir = w.dir;
  if (o.bar !== null) {
    mkdirSync(join(dir, ".molt"), { recursive: true });
    writeFileSync(join(dir, ".molt", "done.yml"), o.bar ?? BAR);
  }
  const provider = scriptFetch(o.script);
  const updates: Update[] = [];
  const requests: Req[] = [];
  const logs: string[] = [];
  const engines: Engine[] = [];

  let server!: AcpServer;
  const client = new RpcPeer({
    write: (line) => queueMicrotask(() => server.feed(line)),
    onNotify: (method, params) => {
      if (method === "session/update") updates.push((params as { update: Update }).update);
    },
    onRequest: async (method, params) => {
      const p = params as Record<string, unknown>;
      requests.push({ method, params: p });
      if (method === "session/request_permission") {
        return o.permit ? await o.permit(p) : { outcome: { outcome: "selected", optionId: "allow_once" } };
      }
      if (method === "fs/read_text_file") return { content: readFileSync(String(p.path), "utf8") };
      if (method === "fs/write_text_file") {
        writeFileSync(String(p.path), String(p.content));
        return {};
      }
      throw new RpcError(METHOD_NOT_FOUND, method);
    },
  });
  server = new AcpServer({
    write: (line) => queueMicrotask(() => client.feed(line)),
    version: "test",
    log: (l) => logs.push(l),
    newEngine: async ({ cwd, files }) => {
      const bar = existsSync(join(cwd, ".molt", "done.yml"))
        ? parseBar(readFileSync(join(cwd, ".molt", "done.yml"), "utf8"))
        : null;
      const e = new Engine({
        baseUrl: "http://mock/v1",
        model: "m",
        cwd,
        fetchFn: provider.fetchFn,
        stream: o.stream ?? true,
        files,
        bar,
        archive: new Archive(cwd),
        receipts: new Receipts(cwd),
        retryBackoffMs: [0, 0, 0],
        maxProofAttempts: o.maxProofAttempts ?? 2,
        ...(o.priced ? { priceInPerMtok: 1, priceOutPerMtok: 2 } : {}),
      });
      engines.push(e);
      return e;
    },
  });

  const call = (method: string, params: unknown) => client.request(method, params);
  const init = (fs: HarnessOpts["fs"] = o.fs) =>
    call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: fs?.read === true, writeTextFile: fs?.write === true } },
      clientInfo: { name: "test-client", version: "0" },
    });
  const open = async () => {
    await init();
    const r = (await call("session/new", { cwd: dir, mcpServers: [] })) as { sessionId: string };
    return r.sessionId;
  };
  const prompt = (sessionId: string, text: string) =>
    call("session/prompt", { sessionId, prompt: [{ type: "text", text }] }) as Promise<{
      stopReason: string;
      usage?: Record<string, number>;
      _meta: { molt: Record<string, unknown> };
    }>;
  const of = (kind: string) => updates.filter((u) => u.sessionUpdate === kind);
  const said = () =>
    of("agent_message_chunk")
      .map((u) => (u.content as { text: string }).text)
      .join("");
  return { dir, provider, updates, requests, logs, engines, call, init, open, prompt, of, said, client, server };
}

/** Write out.txt, then claim done. */
const writeThenDone: Script = (r) =>
  r.toolsSinceUser === 0
    ? { thought: "the file needs writing", text: "Writing it.", calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] }
    : { text: "Done: wrote out.txt." };

describe("initialize", () => {
  it("advertises what molt does and nothing it does not", async () => {
    const h = await harness({ script: writeThenDone });
    const r = (await h.init()) as Record<string, any>;
    assert.equal(r.protocolVersion, ACP_PROTOCOL_VERSION);
    assert.equal(r.agentCapabilities.loadSession, false);
    assert.deepEqual(r.agentCapabilities.promptCapabilities, { image: false, audio: false, embeddedContext: true });
    assert.deepEqual(r.agentCapabilities.mcpCapabilities, { http: false, sse: false });
    assert.deepEqual(r.authMethods, []);
    assert.equal(r.agentInfo.name, "molt");
  });

  it("answers a newer protocol version with the one it speaks", async () => {
    const h = await harness({ script: writeThenDone });
    const r = (await h.call("initialize", { protocolVersion: 9, clientCapabilities: {} })) as { protocolVersion: number };
    assert.equal(r.protocolVersion, 1);
  });

  it("refuses authenticate: there is no method to authenticate with", async () => {
    const h = await harness({ script: writeThenDone });
    await h.init();
    await assert.rejects(h.call("authenticate", { methodId: "x" }), (e: RpcError) => e.code === INVALID_PARAMS);
  });

  it("answers an unknown method with METHOD_NOT_FOUND", async () => {
    const h = await harness({ script: writeThenDone });
    await h.init();
    await assert.rejects(h.call("session/load", { sessionId: "s" }), (e: RpcError) => e.code === METHOD_NOT_FOUND);
  });
});

describe("session/new", () => {
  it("refuses before initialize", async () => {
    const h = await harness({ script: writeThenDone });
    await assert.rejects(h.call("session/new", { cwd: h.dir, mcpServers: [] }), (e: RpcError) => e.code === INVALID_REQUEST);
  });

  it("refuses a relative cwd", async () => {
    const h = await harness({ script: writeThenDone });
    await h.init();
    await assert.rejects(h.call("session/new", { cwd: "rel/dir", mcpServers: [] }), (e: RpcError) => e.code === INVALID_PARAMS);
  });

  it("accepts MCP servers, ignores them, and says so on stderr", async () => {
    const h = await harness({ script: writeThenDone });
    await h.init();
    const r = (await h.call("session/new", {
      cwd: h.dir,
      mcpServers: [{ name: "github", command: "gh-mcp", args: [], env: [] }],
    })) as { sessionId: string };
    assert.ok(r.sessionId);
    assert.ok(h.logs.some((l) => /ignoring 1 MCP server\(s\) \(github\)/.test(l)));
  });

  it("offers molt's autonomy levels as the session's modes", async () => {
    const h = await harness({ script: writeThenDone });
    await h.init();
    const r = (await h.call("session/new", { cwd: h.dir, mcpServers: [] })) as Record<string, any>;
    assert.equal(r.modes.currentModeId, "low");
    assert.deepEqual(
      r.modes.availableModes.map((m: { id: string }) => m.id),
      ["low", "medium", "high"],
    );
  });

  it("reports an engine that cannot be built as an error, not a crash", async () => {
    const h = await harness({ script: writeThenDone, bar: "version: 1\nchecks: [ nope" });
    await h.init();
    await assert.rejects(h.call("session/new", { cwd: h.dir, mcpServers: [] }));
    // The server is still serving.
    const again = (await h.call("initialize", { protocolVersion: 1 })) as { protocolVersion: number };
    assert.equal(again.protocolVersion, 1);
  });
});

describe("a turn, as the editor sees it", () => {
  it("streams text, thought, the tool call with its diff, the plan, usage, and the verdict", async () => {
    const h = await harness({ script: writeThenDone, priced: true });
    const sid = await h.open();
    const r = await h.prompt(sid, "write out.txt");

    assert.equal(r.stopReason, "end_turn");
    assert.equal(readFileSync(join(h.dir, "out.txt"), "utf8"), "hello\n");

    // Text and reasoning, separately.
    assert.match(h.said(), /Writing it\./);
    assert.equal(h.said().split("Done: wrote out.txt.").length - 1, 1, "the streamed answer is not repeated");
    const thought = h.of("agent_thought_chunk").map((u) => (u.content as { text: string }).text).join("");
    assert.equal(thought, "the file needs writing");

    // The call: announced pending (it needs permission), then running, then done with a diff.
    const created = h.of("tool_call");
    assert.equal(created.length, 1);
    const tc = created[0]!;
    assert.equal(tc.kind, "edit");
    assert.equal(tc.status, "pending");
    assert.equal(tc.title, "Write out.txt");
    assert.deepEqual(tc.locations, [{ path: join(h.dir, "out.txt") }]);
    const id = tc.toolCallId;
    const updates = h.of("tool_call_update").filter((u) => u.toolCallId === id);
    assert.deepEqual(updates.map((u) => u.status), ["in_progress", "completed"]);
    assert.deepEqual((updates[1]!.content as unknown[])[0], {
      type: "diff",
      path: join(h.dir, "out.txt"),
      oldText: null,
      newText: "hello\n",
    });

    // The permission question was about that same call, and showed the diff.
    const perm = h.requests.filter((q) => q.method === "session/request_permission");
    assert.equal(perm.length, 1);
    const toolCall = perm[0]!.params.toolCall as Record<string, unknown>;
    assert.equal(toolCall.toolCallId, id);
    assert.equal((toolCall.content as { type: string }[])[0]!.type, "diff");
    assert.deepEqual(
      (perm[0]!.params.options as { kind: string }[]).map((x) => x.kind),
      ["allow_once", "allow_always", "reject_once", "reject_always"],
    );

    // The bar as the plan, ending all completed.
    const plans = h.of("plan");
    assert.ok(plans.length >= 2);
    const last = plans.at(-1)!.entries as { content: string; status: string }[];
    assert.deepEqual(last.map((e) => e.status), ["completed", "completed"]);
    assert.match(last[0]!.content, /^work-landed: pass/);

    // Usage after each step, with the session cost in USD.
    const usage = h.of("usage_update");
    assert.equal(usage.length, 2);
    assert.equal(usage[0]!.used, 120);
    assert.equal(typeof usage[0]!.size, "number");
    const cost = usage.at(-1)!.cost as { amount: number; currency: string };
    assert.equal(cost.currency, "USD");
    assert.ok(cost.amount > 0);
    assert.deepEqual(r.usage, { totalTokens: 240, inputTokens: 200, outputTokens: 40 });

    // The verdict: last thing said, and structured on the response.
    assert.match(h.said(), /\*\*molt · bar met\*\* — done is proven: 2 of 2 checks passed · receipt `\.molt\/receipts\/\d{4}-accepted\.md`/);
    assert.equal(r._meta.molt.verdict, "met");
    assert.equal(r._meta.molt.outcome, "verified");
    assert.match(String(r._meta.molt.receipt), /accepted\.md$/);
    assert.deepEqual(
      (r._meta.molt.checks as { name: string; ok: boolean }[]).map((c) => [c.name, c.ok]),
      [["work-landed", true], ["out-exists", true]],
    );
  });

  it("a rejected write is not run, fails its row, and the bar says not met", async () => {
    const h = await harness({
      script: writeThenDone,
      maxProofAttempts: 1,
      permit: () => ({ outcome: { outcome: "selected", optionId: "reject_once" } }),
    });
    const sid = await h.open();
    const r = await h.prompt(sid, "write out.txt");
    assert.equal(existsSync(join(h.dir, "out.txt")), false);
    const failed = h.of("tool_call_update").filter((u) => u.status === "failed");
    assert.equal(failed.length, 1);
    assert.equal(r.stopReason, "end_turn", "a refused completion is not ACP's refusal");
    assert.equal(r._meta.molt.verdict, "not met");
    assert.match(h.said(), /\*\*molt · bar NOT met\*\* — done is not proven after 1 attempt/);
    assert.match(h.said(), /✗ work-landed — FAILED/);
    const last = h.of("plan").at(-1)!.entries as { status: string }[];
    assert.ok(last.some((e) => e.status === "pending"), "an unmet check is still to do");
  });

  it("allow always: the second write in the session is not asked about", async () => {
    let n = 0;
    const script: Script = (r) =>
      r.toolsSinceUser === 0
        ? { calls: [{ name: "write_file", args: { path: `f${++n}.txt`, content: "x\n" } }] }
        : { text: "done" };
    const h = await harness({
      script,
      bar: null,
      permit: () => ({ outcome: { outcome: "selected", optionId: "allow_always" } }),
    });
    const sid = await h.open();
    await h.prompt(sid, "one");
    await h.prompt(sid, "two");
    assert.equal(h.requests.filter((q) => q.method === "session/request_permission").length, 1);
    assert.ok(existsSync(join(h.dir, "f1.txt")) && existsSync(join(h.dir, "f2.txt")));
  });

  it("reject always: the next write is refused without asking", async () => {
    let n = 0;
    const script: Script = (r) =>
      r.toolsSinceUser === 0
        ? { calls: [{ name: "write_file", args: { path: `g${++n}.txt`, content: "x\n" } }] }
        : { text: "done" };
    const h = await harness({
      script,
      bar: null,
      permit: () => ({ outcome: { outcome: "selected", optionId: "reject_always" } }),
    });
    const sid = await h.open();
    await h.prompt(sid, "one");
    await h.prompt(sid, "two");
    assert.equal(h.requests.filter((q) => q.method === "session/request_permission").length, 1);
    assert.equal(existsSync(join(h.dir, "g2.txt")), false);
  });

  it("set_mode moves the autonomy level: medium writes without asking", async () => {
    const h = await harness({ script: writeThenDone });
    const sid = await h.open();
    await h.call("session/set_mode", { sessionId: sid, modeId: "medium" });
    assert.equal(h.engines[0]!.autonomy, "medium");
    const r = await h.prompt(sid, "write out.txt");
    assert.equal(r.stopReason, "end_turn");
    assert.equal(h.requests.filter((q) => q.method === "session/request_permission").length, 0);
    // Never asked, so announced straight into in_progress.
    assert.equal(h.of("tool_call")[0]!.status, "in_progress");
    await assert.rejects(h.call("session/set_mode", { sessionId: sid, modeId: "yolo" }), (e: RpcError) => e.code === INVALID_PARAMS);
  });

  it("a project with no bar ends unverified, and says why", async () => {
    const h = await harness({ script: writeThenDone, bar: null });
    const sid = await h.open();
    const r = await h.prompt(sid, "write out.txt");
    assert.equal(r._meta.molt.verdict, "unverified");
    assert.match(h.said(), /no `\.molt\/done\.yml`, so nothing checked this answer/);
    assert.equal(h.of("plan").length, 0, "no bar, no plan");
  });

  it("a leading ? is a question: answered, not refused for writing nothing", async () => {
    const h = await harness({ script: () => ({ text: "It checks two things." }) });
    const sid = await h.open();
    const r = await h.prompt(sid, "? what does the bar check");
    assert.equal(r._meta.molt.verdict, "answered");
    assert.equal(h.provider.requests[0]!.users.some((u) => u.includes("what does the bar check")), true);
    assert.equal(h.provider.requests[0]!.users.some((u) => u.startsWith("?")), false);
  });

  it("a provider failure is a JSON-RPC error, not a quiet end_turn", async () => {
    const h = await harness({ script: writeThenDone, bar: null });
    const sid = await h.open();
    h.engines[0]!.cfg.fetchFn = (async () =>
      new Response("bad key", { status: 401, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    await assert.rejects(h.prompt(sid, "hello"), /401/);
  });

  it("a second prompt while a turn runs is refused", async () => {
    const h = await harness({ script: () => ({ hang: true }), bar: null });
    const sid = await h.open();
    const first = h.prompt(sid, "one");
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(h.prompt(sid, "two"), (e: RpcError) => e.code === INVALID_REQUEST);
    h.client.notify("session/cancel", { sessionId: sid });
    assert.equal((await first).stopReason, "cancelled");
  });

  it("the prompt carries linked and attached context", async () => {
    const h = await harness({ script: () => ({ text: "ok" }), bar: null });
    const sid = await h.open();
    writeFileSync(join(h.dir, "notes.md"), "on disk\n");
    await h.call("session/prompt", {
      sessionId: sid,
      prompt: [
        { type: "text", text: "compare " },
        { type: "resource_link", uri: pathToFileURL(join(h.dir, "notes.md")).href, name: "notes.md" },
        { type: "text", text: " with " },
        { type: "resource", resource: { uri: pathToFileURL(join(h.dir, "a.ts")).href, text: "const a = 1;\n" } },
      ],
    });
    const user = h.provider.requests[0]!.users.at(-1)!;
    assert.match(user, /compare `notes\.md` with `a\.ts`/);
    assert.match(user, /Attached by the editor — a\.ts:\n```+\nconst a = 1;\n```+/);
  });
});

describe("cancel", { timeout: 20_000 }, () => {
  it("during a permission question: stops the turn, runs nothing, answers cancelled", async () => {
    let sid = "";
    const h = await harness({
      script: writeThenDone,
      permit: () => {
        // The editor's user hits stop while the question is on screen, and
        // the editor never answers it — molt must not wait for ever.
        h.client.notify("session/cancel", { sessionId: sid });
        return new Promise(() => {});
      },
    });
    sid = await h.open();
    const r = await h.prompt(sid, "write out.txt");
    assert.equal(r.stopReason, "cancelled");
    assert.equal(existsSync(join(h.dir, "out.txt")), false);
    assert.match(h.said(), /\*\*molt · cancelled\*\* — nothing was written/);
    assert.equal(h.provider.requests.length, 1, "no request after the cancel");
  });

  it("during a request that never answers", async () => {
    const h = await harness({ script: () => ({ hang: true }), bar: null });
    const sid = await h.open();
    const pending = h.prompt(sid, "go");
    await new Promise((r) => setTimeout(r, 20));
    h.client.notify("session/cancel", { sessionId: sid });
    const r = await pending;
    assert.equal(r.stopReason, "cancelled");
    assert.equal(r._meta.molt.outcome, "cancelled");
  });

  it("names files already written when the cancel comes after them", async () => {
    let sid = "";
    let n = 0;
    const h = await harness({
      bar: null,
      script: (r) =>
        r.toolsSinceUser === 0
          ? { calls: [{ name: "write_file", args: { path: "kept.txt", content: "x\n" } }] }
          : { calls: [{ name: "bash", args: { command: "echo hi" } }] },
      permit: () => {
        if (++n === 1) return { outcome: { outcome: "selected", optionId: "allow_once" } };
        h.client.notify("session/cancel", { sessionId: sid });
        return { outcome: { outcome: "cancelled" } };
      },
    });
    sid = await h.open();
    const r = await h.prompt(sid, "go");
    assert.equal(r.stopReason, "cancelled");
    assert.match(h.said(), /already written and stay on disk: `kept\.txt`/);
  });
});

describe("the ceiling", { timeout: 60_000 }, () => {
  it("is asked about, and stopping there ends the turn as max_turn_requests", async () => {
    let n = 0;
    const h = await harness({
      bar: null,
      script: () => ({ calls: [{ name: "list_dir", args: { path: ".", depth: ++n } }] }),
      permit: (p) =>
        String((p.toolCall as { toolCallId: string }).toolCallId).startsWith("molt-ceiling-")
          ? { outcome: { outcome: "selected", optionId: "stop" } }
          : { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
    const sid = await h.open();
    const r = await h.prompt(sid, "loop");
    assert.equal(r.stopReason, "max_turn_requests");
    const ceiling = h.requests.filter(
      (q) => q.method === "session/request_permission" && String((q.params.toolCall as { toolCallId: string }).toolCallId).startsWith("molt-ceiling-"),
    );
    assert.equal(ceiling.length, 1);
    assert.match(String((ceiling[0]!.params.toolCall as { title: string }).title), /Keep going\?/);
  });
});

describe("file access through the editor", () => {
  it("writes and reads through fs/* when the client offers them", async () => {
    const script: Script = (r) =>
      r.toolsSinceUser === 0
        ? { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] }
        : r.toolsSinceUser === 1
          ? { calls: [{ name: "read_file", args: { path: "out.txt" } }] }
          : { text: "done" };
    const h = await harness({ script, fs: { read: true, write: true } });
    const sid = await h.open();
    await h.prompt(sid, "go");
    const writes = h.requests.filter((q) => q.method === "fs/write_text_file");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]!.params, { sessionId: sid, path: join(h.dir, "out.txt"), content: "hello\n" });
    assert.ok(h.requests.some((q) => q.method === "fs/read_text_file" && q.params.path === join(h.dir, "out.txt")));
  });

  it("uses disk when the client does not offer them", async () => {
    const h = await harness({ script: writeThenDone });
    const sid = await h.open();
    await h.prompt(sid, "go");
    assert.equal(h.requests.filter((q) => q.method.startsWith("fs/")).length, 0);
    assert.equal(readFileSync(join(h.dir, "out.txt"), "utf8"), "hello\n");
  });
});

describe("the mapping, piece by piece", () => {
  it("tool kinds and titles", () => {
    assert.equal(toolKind("read_file"), "read");
    assert.equal(toolKind("list_dir"), "read");
    assert.equal(toolKind("grep"), "search");
    assert.equal(toolKind("edit_file"), "edit");
    assert.equal(toolKind("write_file"), "edit");
    assert.equal(toolKind("bash"), "execute");
    assert.equal(toolKind("mystery"), "other");
    assert.equal(toolTitle("read_file", { path: "a.ts", offset: 40 }), "Read a.ts from line 41");
    assert.equal(toolTitle("bash", { command: "npm   test\n" }), "Run npm test");
    assert.equal(toolTitle("grep", { pattern: "TODO" }), "Search for TODO in .");
  });

  it("locations are absolute, with a line for a paged read", () => {
    assert.deepEqual(toolLocations("read_file", { path: "src/a.ts", offset: 9 }, "/p"), [{ path: "/p/src/a.ts", line: 10 }]);
    assert.deepEqual(toolLocations("bash", { command: "ls" }, "/p"), []);
  });

  it("always is never offered past the autonomy rules' hard edges", () => {
    assert.equal(alwaysKey("write_file", { path: "a.txt" }, "/p"), "write");
    assert.equal(alwaysKey("write_file", { path: "/etc/hosts" }, "/p"), null);
    assert.equal(alwaysKey("bash", { command: "npm test" }, "/p"), "bash:npm test");
    assert.equal(alwaysKey("bash", { command: "rm -rf build" }, "/p"), null);
    assert.deepEqual(permissionOptions(null).map((x) => x.kind), ["allow_once", "reject_once"]);
  });

  it("a failed call is failed: errors, denials, refusals, non-zero exits", () => {
    const t = (over: Partial<Extract<EngineEvent, { kind: "tool" }>>) =>
      toolFailed({ kind: "tool", name: "bash", detail: "", ...over });
    assert.equal(t({ note: "denied" }), true);
    assert.equal(t({ preview: "exit 1\nboom" }), true);
    assert.equal(t({ preview: "all good" }), false);
    assert.equal(t({ name: "edit_file", preview: "edit refused: old_text not found" }), true);
  });

  it("stop reasons", () => {
    assert.equal(stopReasonFor({ cancelled: true, truncated: false }), "cancelled");
    assert.equal(stopReasonFor({ cancelled: false, outcome: "error", ceiling: "steps", truncated: false }), "max_turn_requests");
    assert.equal(stopReasonFor({ cancelled: false, outcome: "error", ceiling: "budget", truncated: false }), "max_tokens");
    assert.equal(stopReasonFor({ cancelled: false, outcome: "error", truncated: true }), "max_tokens");
    assert.equal(stopReasonFor({ cancelled: false, outcome: "error", truncated: false }), null);
    assert.equal(stopReasonFor({ cancelled: false, outcome: "not proven", truncated: false }), "end_turn");
  });

  it("the plan marks an unmet check as still to do", () => {
    const r = (name: string, ok: boolean, extra: Partial<CheckResult> = {}): CheckResult => ({
      name, ok, kind: "command", detail: "", output: ok ? "" : "boom", durationMs: 1, ...extra,
    });
    const bar: BarResult = { ok: false, results: [r("a", true), r("b", false), r("c", true, { established: false })], durationMs: 1 };
    assert.deepEqual(planFromResult(bar), [
      { content: "a: pass", priority: "high", status: "completed" },
      { content: "b: FAILED", priority: "high", status: "pending" },
      { content: "c: pass (nothing to establish)", priority: "high", status: "completed" },
    ]);
    const text = verdictText({ outcome: "not proven", bar, attempts: 2, hasBar: true, why: "bar not met after 2 attempts." }, "/p");
    assert.match(text, /bar NOT met\*\* — done is not proven after 2 attempts: 2 of 3 checks passed/);
    assert.match(text, /✗ b — FAILED: boom/);
  });

  it("prompt text from blocks", () => {
    assert.equal(
      promptText([{ type: "text", text: "see " }, { type: "resource_link", uri: "https://x.dev/a", name: "a" }], "/p"),
      "see [a](https://x.dev/a)",
    );
    assert.match(promptText([{ type: "image", mimeType: "image/png", data: "" }], "/p"), /image attachment omitted/);
  });
});
