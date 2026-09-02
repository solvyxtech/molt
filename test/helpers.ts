import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sdk } from "../src/claude-code.js";
import type { Confirm, EngineEvent, Msg, ToolCall } from "../src/types.js";

/** A workspace that cleans itself up. */
export function workspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "molt-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export type ScriptedTurn =
  | { text: string }
  | { calls: { name: string; args: Record<string, unknown> }[] };

/**
 * A fetch stand-in that replays scripted assistant turns. The last turn
 * repeats forever, which is how we model a model that will not stop lying.
 */
export function scriptedProvider(turns: ScriptedTurn[]): {
  fetchFn: typeof fetch;
  calls: number;
  bodies: string[];
  requests: () => unknown[];
} {
  const state = { calls: 0, bodies: [] as string[] };
  let id = 0;

  const fetchFn = (async (_url: string, init?: RequestInit) => {
    state.bodies.push(String(init?.body ?? ""));
    const turn = turns[Math.min(state.calls, turns.length - 1)];
    state.calls += 1;

    let message: Msg;
    if ("text" in turn) {
      message = { role: "assistant", content: turn.text };
    } else {
      const tool_calls: ToolCall[] = turn.calls.map((c) => ({
        id: `call_${++id}`,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      }));
      message = { role: "assistant", content: null, tool_calls };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return {
    fetchFn,
    get calls() {
      return state.calls;
    },
    get bodies() {
      return state.bodies;
    },
    requests: () => state.bodies.map((b) => JSON.parse(b)),
  };
}

export const allowAll: Confirm = async () => true;
export const denyAll: Confirm = async () => false;

export async function drain(gen: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

export function kinds(events: EngineEvent[]): string[] {
  return events.map((e) => e.kind);
}

export function msg(role: Msg["role"], content: string, tool_calls?: ToolCall[]): Msg {
  return tool_calls ? { role, content, tool_calls } : { role, content };
}

export function toolCall(name: string, args: Record<string, unknown>, id = "c1"): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** One exchange with a scripted Claude Code: what it calls, then what it says. */
export type ScriptedCcTurn = {
  /** Tools it calls before answering, in order. */
  calls?: { name: string; args: Record<string, unknown> }[];
  /** What it says once the calls are done. Becomes the turn's claim. */
  text?: string;
  /** Fail the session instead of answering. */
  error?: string;
  usage?: { input?: number; output?: number; cached?: number };
};

/**
 * A Claude Code that does what the script says.
 *
 * The real backend spawns a `claude` process and spends a subscription's
 * quota; every test drives this instead, through the same `Sdk` interface the
 * engine loads at runtime. It answers one scripted turn per user message,
 * which is the invariant `claudeCodeStep` maintains: one step, one message,
 * one result.
 */
export function scriptedClaudeCode(turns: ScriptedCcTurn[]): {
  sdk: Sdk;
  /** Everything molt has said to it, in order. */
  sent: string[];
  /** Options the session was created with, for asserting the lockdown. */
  options: () => Record<string, unknown>;
} {
  const sent: string[] = [];
  let handlers: { name: string; handler: (a: Record<string, unknown>) => Promise<unknown> }[] = [];
  let options: Record<string, unknown> = {};
  const stub = (): { optional: () => unknown; describe: () => unknown } => {
    const t = { optional: () => t, describe: () => t };
    return t;
  };
  const sdk = {
    z: { string: stub, number: stub, boolean: stub, enum: stub, unknown: stub },
    tool: (name: string, _d: string, _s: unknown, handler: (a: Record<string, unknown>) => Promise<unknown>) =>
      ({ name, handler }),
    createSdkMcpServer: (opts: { tools: unknown[] }) => {
      handlers = opts.tools as typeof handlers;
      return { type: "sdk-fake" };
    },
    query: ({ prompt, options: opts }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      options = opts;
      return {
        async *[Symbol.asyncIterator]() {
          let n = 0;
          for await (const m of prompt) {
            sent.push(String((m as { message: { content: string } }).message.content));
            const turn = turns[n] ?? { text: "done" };
            n += 1;
            const calls = (turn.calls ?? []).map((c, i) => ({ ...c, id: `cc${n}_${i}` }));
            if (calls.length) {
              yield {
                type: "assistant",
                message: {
                  content: calls.map((c) => ({
                    type: "tool_use",
                    id: c.id,
                    name: `mcp__molt__${c.name}`,
                    input: c.args,
                  })),
                },
              };
              for (const c of calls) {
                const h = handlers.find((x) => x.name === c.name);
                if (!h) throw new Error(`scripted call to a tool that is not registered: ${c.name}`);
                await h.handler(c.args);
              }
            }
            const text = turn.text ?? "";
            if (text) {
              yield { type: "assistant", message: { content: [{ type: "text", text }] } };
            }
            yield {
              type: "result",
              subtype: turn.error ? "error_during_execution" : "success",
              is_error: Boolean(turn.error),
              result: turn.error ?? text,
              total_cost_usd: 0.01 * n,
              usage: {
                input_tokens: turn.usage?.input ?? 100,
                output_tokens: turn.usage?.output ?? 20,
                cache_read_input_tokens: turn.usage?.cached ?? 0,
              },
            };
          }
        },
      };
    },
  };
  return { sdk: sdk as unknown as Sdk, sent, options: () => options };
}
