import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
