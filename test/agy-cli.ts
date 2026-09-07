/**
 * An Antigravity CLI that does what the script says.
 *
 * Frames the same newline-delimited stream the real `agy` emits — the shapes
 * here were copied off a live account, not invented — and reaches molt's tools
 * the way the real one does, by POSTing to the loopback MCP server whose URL
 * it was handed at registration. A stub that faked that last hop would pass
 * with the tool server unplugged.
 *
 * No subprocess is spawned. A test that started a real `agy` would spend the
 * quota of whoever ran it.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";

export type ScriptedAgyTurn = {
  /** molt tools it calls, in order, over the MCP server. */
  calls?: { name: string; args: Record<string, unknown> }[];
  /** Its own tools that ran to completion — the auto-approved ones. */
  ranBuiltins?: string[];
  /** Its own tools that were refused — the permission system working. */
  refusedBuiltins?: string[];
  text?: string;
  status?: string;
  error?: string;
  usage?: { input?: number; output?: number; cached?: number };
};

export type ScriptedAgy = {
  spawnFn: typeof spawn;
  setup: (e: { url: string; headers: { name: string; value: string }[] }) => Promise<void>;
  /** Every prompt molt sent, in order. */
  sent: string[];
  /** Argv the CLI was started with, for asserting the flags. */
  argv: () => string[];
};

async function mcpCall(
  ep: { url: string; headers: { name: string; value: string }[] },
  method: string,
  params: unknown,
  id: number,
): Promise<void> {
  await fetch(ep.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(ep.headers.map((h) => [h.name, h.value])),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

export function scriptedAgy(turns: ScriptedAgyTurn[]): ScriptedAgy {
  const sent: string[] = [];
  let endpoint: { url: string; headers: { name: string; value: string }[] } | undefined;
  let argv: string[] = [];
  let turn = 0;

  const fake = (_cmd: string, args: string[]): unknown => {
    argv = args;
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
    const write = (o: unknown): void => {
      child.stdout.write(`${JSON.stringify(o)}\n`);
    };
    const step = (u: Record<string, unknown>): void => write({ event: "step_update", step_update: u });
    let mcpId = 100;

    write({
      event: "init",
      init: { model: "gemini-3.1-pro-low", tools: ["write_to_file", "run_command", "call_mcp_tool"], permission_mode: "request-review" },
    });

    let buf = "";
    child.stdin.on("data", (d: Buffer) => {
      buf += d.toString();
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) void handle(JSON.parse(line) as { message?: { content?: string } });
      }
    });

    async function handle(msg: { message?: { content?: string } }): Promise<void> {
      sent.push(msg.message?.content ?? "");
      const s = turns[turn] ?? { text: "done" };
      turn += 1;
      step({ step_type: "user_input", state: "DONE" });

      for (const b of s.refusedBuiltins ?? []) {
        // Announced, then refused by agy's own permission engine. Nothing ran.
        step({ step_type: "tool", state: "ACTIVE", tool_name: b });
        step({
          step_type: "tool",
          state: "ERROR",
          tool_name: b,
          tool_info: { error: { message: `user denied permission for ${b}` } },
        });
      }
      for (const b of s.ranBuiltins ?? []) {
        step({ step_type: "tool", state: "ACTIVE", tool_name: b });
        step({ step_type: "tool", state: "DONE", tool_name: b });
      }
      for (const c of s.calls ?? []) {
        step({
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "call_mcp_tool",
          tool_info: { parameters: { ServerName: "molt", ToolName: c.name, Arguments: c.args } },
        });
        if (endpoint) {
          await mcpCall(endpoint, "tools/call", { name: `mcp__molt__${c.name}`, arguments: c.args }, mcpId++);
        }
        step({ step_type: "tool", state: "DONE", tool_name: "call_mcp_tool" });
      }
      const text = s.text ?? "";
      if (text) step({ step_type: "agent_response", state: "ACTIVE", text_delta: text });
      const u = s.usage ?? { input: 14000, output: 200, cached: 8000 };
      write({
        event: "result",
        result: {
          status: s.status ?? "SUCCESS",
          response: text,
          ...(s.error ? { error: s.error } : {}),
          usage: {
            input_tokens: u.input ?? 0,
            output_tokens: u.output ?? 0,
            cache_read_tokens: u.cached ?? 0,
          },
        },
      });
    }
    return child;
  };

  return {
    spawnFn: fake as unknown as typeof spawn,
    setup: async (e) => {
      endpoint = e;
    },
    sent,
    argv: () => argv,
  };
}
