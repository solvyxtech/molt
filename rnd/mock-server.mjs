/**
 * A real HTTP OpenAI-compatible server with scriptable + adversarial
 * behaviors, for integration/stress testing molt's engine over actual
 * sockets (not mocked fetch).
 *
 * Behavior is selected by model name:
 *   scripted:*  — pops responses from a queue set via POST /script
 *   huge        — 200KB of CJK + emoji in one message
 *   nousage     — valid response, usage field missing
 *   badjson     — 200 OK, body "not json {"
 *   http500 / http429 — error statuses
 *   slow        — 1.5s delay then valid response
 *   reset       — destroys the socket mid-response
 *   toolspam    — always returns a read_file tool call (runaway loop)
 *   echo-task   — plays a 3-step real coding task (read, write, bash)
 */
import http from "node:http";

const queue = [];
let echoStep = 0;

const text = (t, usage = { prompt_tokens: 120, completion_tokens: 40 }) =>
  JSON.stringify({ choices: [{ message: { role: "assistant", content: t } }], usage });

const tool = (name, args) =>
  JSON.stringify({
    choices: [{ message: { role: "assistant", content: null,
      tool_calls: [{ id: "t" + Math.random().toString(36).slice(2, 8),
        function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 150, completion_tokens: 30 },
  });

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/script") {
      queue.push(...JSON.parse(body));
      res.writeHead(200).end("ok");
      return;
    }
    if (req.url === "/reset-task") { echoStep = 0; res.writeHead(200).end("ok"); return; }
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "echo-task" }, { id: "scripted" }, { id: "huge" }] }));
      return;
    }
    if (!req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }

    const { model } = JSON.parse(body);
    const send = (code, payload) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(payload);
    };

    if (model.startsWith("scripted")) return send(200, queue.shift() ?? text("queue empty"));
    if (model === "huge") return send(200, text("长".repeat(80_000) + "🔋".repeat(20_000)));
    if (model === "nousage") {
      return send(200, JSON.stringify({ choices: [{ message: { role: "assistant", content: "no usage here" } }] }));
    }
    if (model === "badjson") return send(200, 'not json {');
    if (model === "http500") return send(500, "internal fire");
    if (model === "http429") return send(429, JSON.stringify({ error: { message: "rate limited" } }));
    if (model === "slow") return setTimeout(() => send(200, text("slow but fine")), 1500);
    if (model === "reset") { res.write('{"choices":[{'); res.destroy(); return; }
    if (model === "toolspam") return send(200, tool("read_file", { path: "package.json" }));
    if (model === "echo-task") {
      echoStep++;
      if (echoStep === 1) return send(200, tool("read_file", { path: "fib.py" }));
      if (echoStep === 2) return send(200, tool("write_file", { path: "fib.py",
        content: "def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\nassert fib(10) == 55\nprint('ok')\n" }));
      if (echoStep === 3) return send(200, tool("bash", { command: "python3 fib.py" }));
      return send(200, text("Fixed fib.py: replaced the recursive version with an iterative one; python3 fib.py prints ok."));
    }
    send(200, text("unknown model behavior"));
  });
});

server.listen(0, "127.0.0.1", () => {
  console.log(String(server.address().port));
});
