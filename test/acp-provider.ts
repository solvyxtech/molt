/**
 * An OpenAI-shaped provider that answers from a script, streamed or not.
 *
 * `scriptedProvider` in helpers.ts replays a fixed list, which is right for a
 * single turn and wrong for an editor session: the editor sends several
 * prompts, each of which wants its own answers, and a cancelled turn leaves
 * the list out of step with the conversation. So the script here is a
 * function of the request — which prompt it answers, how many tool results
 * have come back since — and the same script serves in-process (`scriptFetch`)
 * or over a real socket (`scriptServer`) for a child process to reach.
 *
 * Streams SSE whenever the request asks for it, reasoning included, because
 * that is the path molt takes by default and the one `agent_thought_chunk`
 * rides on.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Reply = {
  /** Streamed as `reasoning_content`, ahead of everything else. */
  thought?: string;
  text?: string;
  calls?: { name: string; args: Record<string, unknown> }[];
  /** Never answer. The request stays open until the client gives up. */
  hang?: boolean;
};

type WireMsg = { role: string; content?: unknown; tool_calls?: unknown[] };

export type ScriptRequest = {
  messages: WireMsg[];
  /** Every user message's text, oldest first. */
  users: string[];
  /** Tool results since the most recent user message. */
  toolsSinceUser: number;
  stream: boolean;
};

export type Script = (req: ScriptRequest) => Reply;

let callSeq = 0;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "object" && p && "text" in p ? String(p.text) : "")).join("");
  }
  return "";
}

export function describe(body: string): ScriptRequest {
  const parsed = JSON.parse(body) as { messages?: WireMsg[]; stream?: boolean };
  const messages = parsed.messages ?? [];
  const users = messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  const toolsSinceUser = messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
  return { messages, users, toolsSinceUser, stream: parsed.stream === true };
}

function toolCalls(reply: Reply) {
  return (reply.calls ?? []).map((c, index) => ({
    index,
    id: `call_${++callSeq}`,
    type: "function" as const,
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  }));
}

const USAGE = { prompt_tokens: 100, completion_tokens: 20 };

export function sseBody(reply: Reply): string {
  const frames: unknown[] = [];
  if (reply.thought) {
    // Two fragments, so a consumer that keeps only the last one is caught.
    const half = Math.ceil(reply.thought.length / 2);
    frames.push({ choices: [{ delta: { reasoning_content: reply.thought.slice(0, half) } }] });
    frames.push({ choices: [{ delta: { reasoning_content: reply.thought.slice(half) } }] });
  }
  if (reply.text) frames.push({ choices: [{ delta: { content: reply.text } }] });
  const calls = toolCalls(reply);
  if (calls.length) frames.push({ choices: [{ delta: { tool_calls: calls } }] });
  frames.push({
    choices: [{ delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: USAGE,
  });
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
}

export function jsonBody(reply: Reply): string {
  const calls = toolCalls(reply).map(({ index: _i, ...c }) => c);
  const message = calls.length
    ? { role: "assistant", content: reply.text ?? null, tool_calls: calls }
    : { role: "assistant", content: reply.text ?? "" };
  return JSON.stringify({
    choices: [{ message, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: USAGE,
  });
}

/** In-process: a fetch that answers from the script. */
export function scriptFetch(script: Script): { fetchFn: typeof fetch; requests: ScriptRequest[] } {
  const requests: ScriptRequest[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const req = describe(String(init?.body ?? "{}"));
    requests.push(req);
    const reply = script(req);
    if (reply.hang) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return req.stream
      ? new Response(sseBody(reply), { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(jsonBody(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

/** Over a socket, for a molt running in a child process. */
export async function scriptServer(
  script: Script,
): Promise<{ url: string; requests: ScriptRequest[]; close: () => Promise<void> }> {
  const requests: ScriptRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      // Pricing and model listings are not part of any script.
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const r = describe(Buffer.concat(chunks).toString("utf8"));
      requests.push(r);
      const reply = script(r);
      if (reply.hang) return; // held open until the client disconnects
      if (r.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseBody(reply));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(jsonBody(reply));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
