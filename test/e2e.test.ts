/**
 * Integration stress tests: the REAL engine over REAL HTTP against an
 * adversarial mock provider. No mocked fetch anywhere in this file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type EngineEvent } from "../src/engine.js";

let server: ChildProcess;
let baseUrl = "";

const allow = async () => true;
async function collect(gen: AsyncGenerator<EngineEvent>) {
  const out: EngineEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

beforeAll(async () => {
  server = spawn("node", ["rnd/mock-server.mjs"], { cwd: process.cwd() });
  const port = await new Promise<string>((res) => {
    server.stdout!.once("data", (d) => res(String(d).trim()));
  });
  baseUrl = `http://127.0.0.1:${port}/v1`;
});
afterAll(() => server.kill());

describe("engine vs adversarial provider (real HTTP)", () => {
  it("completes a real 3-step coding task: read → write → run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "molt-e2e-"));
    writeFileSync(join(dir, "fib.py"), "def fib(n): return fib(n-1)+fib(n-2)\n");
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await fetch(baseUrl.replace("/v1", "/reset-task"), { method: "POST", body: "{}" });
      const e = new Engine({ baseUrl, model: "echo-task" });
      const evs = await collect(e.run("fix fib.py and prove it runs", allow));
      const tools = evs.filter((x) => x.kind === "tool").map((x) => (x as { name: string }).name);
      expect(tools).toEqual(["read_file", "write_file", "bash"]);
      expect(readFileSync(join(dir, "fib.py"), "utf8")).toContain("a, b = b, a + b");
      const final = evs.find((x) => x.kind === "assistant_text") as { text: string };
      expect(final.text).toContain("Fixed fib.py");
      const usage = evs.find((x) => x.kind === "usage") as { sessionTokens: number };
      expect(usage.sessionTokens).toBeGreaterThan(0);
    } finally {
      process.chdir(prevCwd);
    }
  }, 15000);

  it("200KB CJK+emoji response: rendered, counted, no crash", async () => {
    const e = new Engine({ baseUrl, model: "huge" });
    const evs = await collect(e.run("go", allow));
    const t = evs.find((x) => x.kind === "assistant_text") as { text: string };
    expect(t.text.length).toBeGreaterThan(90_000);
    expect(evs.find((x) => x.kind === "usage")).toBeTruthy();
  });

  it("missing usage field: falls back to estimates, still bills the session", async () => {
    const e = new Engine({ baseUrl, model: "nousage" });
    const evs = await collect(e.run("hello there", allow));
    const u = evs.find((x) => x.kind === "usage") as { sessionTokens: number };
    expect(u.sessionTokens).toBeGreaterThan(0);
  });

  it("non-JSON 200, HTTP 500, HTTP 429: clean errors, no throw", async () => {
    for (const model of ["badjson", "http500", "http429"]) {
      const e = new Engine({ baseUrl, model });
      const evs = await collect(e.run("x", allow));
      expect(evs[0].kind, model).toBe("error");
    }
  });

  it("socket destroyed mid-response: network error event, no throw", async () => {
    const e = new Engine({ baseUrl, model: "reset" });
    const evs = await collect(e.run("x", allow));
    expect(evs[0].kind).toBe("error");
  });

  it("tool-spam model hits the loop guard, session tokens still accounted", async () => {
    const e = new Engine({ baseUrl, model: "toolspam" });
    const evs = await collect(e.run("loop", allow));
    expect((evs.at(-1) as { text: string }).text).toContain("loop guard");
    expect(e.bom().sessionPromptTokens).toBeGreaterThan(0);
  }, 30000);

  it("slow provider: just slow, not broken", async () => {
    const e = new Engine({ baseUrl, model: "slow" });
    const evs = await collect(e.run("x", allow));
    expect(evs[0]).toMatchObject({ kind: "assistant_text", text: "slow but fine" });
  });
});

describe("doctor (real HTTP)", () => {
  it("reports reachable + model availability, and warns on missing model", async () => {
    const good = new Engine({ baseUrl, model: "echo-task" });
    expect(await good.doctor()).toMatchObject({ ok: true, detail: expect.stringContaining("'echo-task' available") });
    const missing = new Engine({ baseUrl, model: "not-a-model" });
    expect((await missing.doctor()).detail).toContain("NOT in list");
    const dead = new Engine({ baseUrl: "http://127.0.0.1:1/v1", model: "x" });
    expect((await dead.doctor()).ok).toBe(false);
  });
});

describe("hardening (from red-team pass)", () => {
  it("bash child env is scrubbed of provider keys", async () => {
    process.env.MOLT_API_KEY = "sk-super-secret";
    const e = new Engine({
      baseUrl, model: "scripted",
    });
    await fetch(baseUrl.replace("/v1", "/script"), {
      method: "POST",
      body: JSON.stringify([
        JSON.stringify({ choices: [{ message: { role: "assistant", content: null,
          tool_calls: [{ id: "t1", function: { name: "bash",
            arguments: JSON.stringify({ command: "env | grep -c MOLT_API_KEY || true" }) } }] } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      ]),
    });
    await collect(e.run("check env", allow));
    // The tool result fed back to the model must show zero matches.
    const wire = JSON.parse(e.lastRequestBody!);
    const toolMsg = wire.messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMsg.content.trim()).toBe("0");
    delete process.env.MOLT_API_KEY;
  });

  it("bash timeout kills runaway commands and reports it", async () => {
    await fetch(baseUrl.replace("/v1", "/script"), {
      method: "POST",
      body: JSON.stringify([
        JSON.stringify({ choices: [{ message: { role: "assistant", content: null,
          tool_calls: [{ id: "t2", function: { name: "bash",
            arguments: JSON.stringify({ command: "sleep 30" }) } }] } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      ]),
    });
    const e = new Engine({ baseUrl, model: "scripted", bashTimeoutMs: 500 });
    const t0 = Date.now();
    await collect(e.run("hang", allow));
    expect(Date.now() - t0).toBeLessThan(5000);
    const wire = JSON.parse(e.lastRequestBody!);
    const toolMsg = wire.messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMsg.content).toContain("timeout");
  });

  it("reading outside cwd requires the gate; inside cwd does not", async () => {
    const gated: string[] = [];
    const confirm = async (name: string, detail: string) => {
      gated.push(`${name} ${detail}`);
      return false;
    };
    await fetch(baseUrl.replace("/v1", "/script"), {
      method: "POST",
      body: JSON.stringify([
        JSON.stringify({ choices: [{ message: { role: "assistant", content: null,
          tool_calls: [
            { id: "a", function: { name: "read_file", arguments: JSON.stringify({ path: "/etc/hostname" }) } },
            { id: "b", function: { name: "read_file", arguments: JSON.stringify({ path: "package.json" }) } },
          ] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      ]),
    });
    const e = new Engine({ baseUrl, model: "scripted" });
    const evs = await collect(e.run("read stuff", confirm));
    expect(gated).toEqual(["read_file /etc/hostname"]); // only the outside read
    const toolEvs = evs.filter((x) => x.kind === "tool") as { detail: string; note?: string }[];
    expect(toolEvs.find((t) => t.detail === "/etc/hostname")?.note).toBe("denied");
    expect(toolEvs.find((t) => t.detail === "package.json")?.note).toBeUndefined();
  });
});
