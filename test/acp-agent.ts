/**
 * A Grok or Gemini that does what the script says.
 *
 * The stub is a real ACP agent, not a mock of one: it frames newline-delimited
 * JSON-RPC over a pipe, answers `initialize` and `session/new`, streams
 * `session/update` notifications, and — the part that matters — reaches molt's
 * tools the way the real CLIs do, by POSTing MCP calls to the loopback server
 * whose URL it was handed in `session/new`. A test that stubbed that last hop
 * would pass with the tool server unplugged, which is the one piece of this
 * backend nobody else has exercised.
 *
 * No subprocess is spawned. A test that started a real `grok` would spend the
 * quota of whoever ran it, so `acpSpawn` is supplied everywhere.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";

export type ScriptedAcpTurn = {
  /** Tools it calls before answering, in order. */
  calls?: { name: string; args: Record<string, unknown> }[];
  /**
   * How the agent spells a Maat tool on the wire, before the tool name. Default `mcp__molt__`;
   * OpenCode says `molt_` and calls the MCP server by the bare name.
   */
  wirePrefix?: string;
  /** Builtins it asks about, which molt is supposed to refuse. */
  builtins?: string[];
  /**
   * Builtins it runs without asking — Grok auto-approves its read-only tools,
   * so these never reach molt's refusal and are the gap the header names.
   */
  autoTools?: string[];
  /**
   * Maat tools called the way grok 1.0.46 really does it: the model only sees
   * `search_tool` and `use_tool`, so each call is announced as `use_tool` and
   * the permission request names the target in `rawInput.tool_name` (qualified
   * `molt__<name>`), with no `toolName` and the real tool in `_meta`.
   */
  viaUseTool?: { name: string; args: Record<string, unknown> }[];
  /** `use_tool` calls aimed at something that is not Maat's (raw `tool_name`). */
  viaUseToolOther?: string[];
  /** Runs `search_tool` first (announced and completed, never asks). */
  search?: boolean;
  /** What it says once the calls are done. Becomes the turn's claim. */
  text?: string;
  /** Stop the turn this way instead of answering. */
  stopReason?: string;
  /** Refuse the session outright, the way a signed-out CLI does. */
  authError?: boolean;
  /** Accept the prompt and never answer it. */
  hang?: boolean;
  /**
   * Run one of its own builtins for this long first: announced, silent while
   * it runs (as GROK_OWN_TOOLS runs a test suite), then completed.
   */
  ownToolMs?: number;
};

export type ScriptedAgent = {
  spawnFn: typeof spawn;
  /** Every prompt molt sent, in order. */
  sent: string[];
  /** The `session/new` params, for asserting what the agent was told. */
  sessionParams: () => Record<string, unknown>;
  /** Permission outcomes molt returned, keyed by the tool asked about. */
  permissions: { tool: string; outcome: string }[];
  /** Whether the agent was ever handed molt's tool list. */
  toolsSeen: () => string[];
  /** The model ids molt asked to switch to, in order. */
  modelsSet: string[];
};

/** POST one MCP call to molt's in-process server and return its result. */
async function mcpCall(
  endpoint: { url: string; headers: { name: string; value: string }[] },
  method: string,
  params: unknown,
  id: number,
): Promise<Record<string, unknown>> {
  const res = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(endpoint.headers.map((h) => [h.name, h.value])),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (res.status === 202) return {};
  return (await res.json()) as Record<string, unknown>;
}

/**
 * How the agent answers about models, shaped on grok 1.0.41: `session/new`
 * returns `models`, and `session/set_model` refuses an id it does not list.
 * `setModel: "unsupported"` answers method-not-found, as an agent without the
 * (unstable) method would.
 */
export type AgentModels = {
  current?: string;
  available?: string[];
  setModel?: "strict" | "unsupported";
};

export function scriptedAcpAgent(turns: ScriptedAcpTurn[], models: AgentModels = {}): ScriptedAgent {
  const sent: string[] = [];
  const permissions: { tool: string; outcome: string }[] = [];
  let sessionParams: Record<string, unknown> = {};
  const modelsSet: string[] = [];
  let tools: string[] = [];
  let turn = 0;

  const spawnFn = ((): typeof spawn => {
    const fake = (): unknown => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => void;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (): void => {};

      let endpoint: { url: string; headers: { name: string; value: string }[] } | undefined;
      let mcpId = 100;
      const write = (o: unknown): void => {
        child.stdout.write(`${JSON.stringify(o)}\n`);
      };
      /** Ask molt for permission and wait for its answer. */
      const pending = new Map<number, (v: unknown) => void>();
      let reqId = 1000;
      const ask = async (toolName: string): Promise<string> => {
        const id = reqId++;
        const done = new Promise<unknown>((resolve) => pending.set(id, resolve));
        write({
          jsonrpc: "2.0",
          id,
          method: "session/request_permission",
          params: {
            sessionId: "s1",
            toolCall: { toolCallId: `tc_${id}`, title: toolName, toolName },
            options: [
              { optionId: "yes", kind: "allow_once", name: "Allow" },
              { optionId: "no", kind: "reject_once", name: "Reject" },
            ],
          },
        });
        const res = (await done) as { outcome?: { outcome?: string; optionId?: string } };
        const outcome = res?.outcome?.optionId ?? res?.outcome?.outcome ?? "cancelled";
        permissions.push({ tool: toolName, outcome });
        return outcome;
      };

      let buf = "";
      child.stdin.on("data", (d: Buffer) => {
        buf += d.toString();
        for (;;) {
          const i = buf.indexOf("\n");
          if (i < 0) break;
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) void handle(JSON.parse(line) as Record<string, unknown>);
        }
      });

      async function handle(msg: Record<string, unknown>): Promise<void> {
        const id = msg.id as number | undefined;
        const method = msg.method as string | undefined;
        if (method === undefined && id !== undefined) {
          pending.get(id)?.(msg.result);
          pending.delete(id);
          return;
        }
        if (method === "initialize") {
          write({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { mcpCapabilities: { http: true, sse: true } },
              authMethods: [{ id: "grok.com", name: "Grok" }],
            },
          });
          return;
        }
        if (method === "session/new") {
          sessionParams = (msg.params ?? {}) as Record<string, unknown>;
          const servers = (sessionParams.mcpServers ?? []) as {
            url?: string;
            headers?: { name: string; value: string }[];
          }[];
          const first = servers[0];
          if (first?.url) endpoint = { url: first.url, headers: first.headers ?? [] };
          if (turns[0]?.authError) {
            write({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required" } });
            return;
          }
          if (endpoint) {
            const listed = (await mcpCall(endpoint, "tools/list", {}, mcpId++)) as {
              result?: { tools?: { name: string }[] };
            };
            tools = (listed.result?.tools ?? []).map((t) => t.name);
          }
          write({
            jsonrpc: "2.0",
            id,
            result: {
              sessionId: "s1",
              ...(models.current
                ? {
                    models: {
                      currentModelId: models.current,
                      availableModels: (models.available ?? [models.current]).map((m) => ({ modelId: m, name: m })),
                    },
                  }
                : {}),
            },
          });
          return;
        }
        if (method === "session/set_model") {
          const want = String((msg.params as { modelId?: string })?.modelId ?? "");
          if (models.setModel === "unsupported") {
            write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
            return;
          }
          if (models.available && !models.available.includes(want)) {
            write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params", data: "unknown model id" } });
            return;
          }
          modelsSet.push(want);
          write({ jsonrpc: "2.0", id, result: { _meta: { model: { Ok: want } } } });
          return;
        }
        if (method === "session/prompt") {
          const p = (msg.params ?? {}) as { prompt?: { text?: string }[] };
          sent.push((p.prompt ?? []).map((b) => b.text ?? "").join(""));
          const script = turns[turn] ?? { text: "done" };
          turn += 1;
          if (script.hang) return;

          if (script.ownToolMs) {
            const upd = (update: Record<string, unknown>) =>
              write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update } });
            upd({ sessionUpdate: "tool_call", toolCallId: "own_1", title: "run_terminal_cmd", toolName: "run_terminal_cmd" });
            await new Promise((r) => setTimeout(r, script.ownToolMs));
            upd({ sessionUpdate: "tool_call_update", toolCallId: "own_1", status: "completed" });
          }

          for (const b of script.autoTools ?? []) {
            // Announced, then completed, with no permission request in
            // between. molt cannot stop this one; it can only say so.
            write({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s1",
                update: { sessionUpdate: "tool_call", toolCallId: `a_${b}`, title: b, toolName: b },
              },
            });
            write({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s1",
                update: { sessionUpdate: "tool_call_update", toolCallId: `a_${b}`, status: "completed" },
              },
            });
          }

          for (const b of script.builtins ?? []) {
            // A builtin announces itself and then asks. molt refuses, and the
            // agent does not run it — which is the whole contract.
            write({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s1",
                update: { sessionUpdate: "tool_call", toolCallId: `b_${b}`, title: b, toolName: b },
              },
            });
            await ask(b);
          }

          if (script.search) {
            write({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s1",
                update: { sessionUpdate: "tool_call", toolCallId: "s_search", title: "search_tool", rawInput: { query: "molt" } },
              },
            });
            write({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: "s1", update: { sessionUpdate: "tool_call_update", toolCallId: "s_search", status: "completed" } },
            });
          }

          const viaUse = [
            ...(script.viaUseTool ?? []).map((c) => ({ target: `molt__${c.name}`, bare: c.name, args: c.args })),
            ...(script.viaUseToolOther ?? []).map((t) => ({ target: t, bare: undefined, args: {} })),
          ];
          for (const c of viaUse) {
            const id = reqId++;
            write({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s1",
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: `u_${id}`,
                  title: "use_tool",
                  rawInput: { tool_name: c.target, tool_input: c.args },
                },
              },
            });
            const done = new Promise<unknown>((resolve) => pending.set(id, resolve));
            write({
              jsonrpc: "2.0",
              id,
              method: "session/request_permission",
              params: {
                sessionId: "s1",
                toolCall: {
                  toolCallId: `u_${id}`,
                  kind: "other",
                  title: c.target,
                  rawInput: { variant: "UseTool", tool_name: c.target, tool_input: c.args },
                  _meta: { "x.ai/tool": { version: 1, name: "use_tool", kind: "use_tool" } },
                },
                options: [
                  { optionId: "yes", kind: "allow_once", name: "Allow" },
                  { optionId: "no", kind: "reject_once", name: "Reject" },
                ],
              },
            });
            const res = (await done) as { outcome?: { outcome?: string; optionId?: string } };
            const outcome = res?.outcome?.optionId ?? res?.outcome?.outcome ?? "cancelled";
            permissions.push({ tool: c.target, outcome });
            if (outcome === "yes" && endpoint && c.bare) {
              // Grok unqualifies the name on the way to the MCP server.
              await mcpCall(endpoint, "tools/call", { name: c.bare, arguments: c.args }, mcpId++);
            }
          }

          for (const c of script.calls ?? []) {
            const wire = `${script.wirePrefix ?? "mcp__molt__"}${c.name}`;
            write({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s1",
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: `t_${c.name}`,
                  title: wire,
                  toolName: wire,
                  rawInput: c.args,
                },
              },
            });
            if ((await ask(wire)) !== "yes") continue;
            if (endpoint) {
              // An agent whose tool server went away (an interrupted turn) gets an error back, not a crash.
              await mcpCall(endpoint, "tools/call", { name: script.wirePrefix ? c.name : wire, arguments: c.args }, mcpId++).catch(() => ({}));
            }
          }

          const text = script.text ?? "";
          if (text) {
            write({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "s1",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
              },
            });
          }
          write({
            jsonrpc: "2.0",
            id,
            result: { stopReason: script.stopReason ?? "end_turn" },
          });
          return;
        }
        if (id !== undefined) write({ jsonrpc: "2.0", id, result: {} });
      }

      return child;
    };
    return fake as unknown as typeof spawn;
  })();

  return {
    spawnFn,
    sent,
    sessionParams: () => sessionParams,
    permissions,
    toolsSeen: () => tools,
    modelsSet,
  };
}
