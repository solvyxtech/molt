/**
 * End-to-end: a real turn, through the real window.
 *
 * A stub provider stands in for the model so the test is deterministic and
 * free, but nothing else is stubbed — the engine, the bar, the receipts, the
 * IPC and the DOM are all the shipping ones. What it proves is the seam that
 * unit tests cannot reach: that an event the engine yields arrives in the page
 * and turns into something a person can read.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electron = require("electron");

// A workspace with a bar molt can actually satisfy.
const ws = mkdtempSync(join(tmpdir(), "molt-e2e-"));
mkdirSync(join(ws, ".molt"), { recursive: true });
writeFileSync(join(ws, "note.txt"), "before\n", "utf8");
writeFileSync(
  join(ws, ".molt", "done.yml"),
  "version: 1\nchecks:\n  - name: work-landed\n    builtin: files-changed\n",
  "utf8",
);

/** Two steps: write the file, then claim it is done. */
const script = [
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: {
          name: "write_file",
          arguments: JSON.stringify({ path: "note.txt", content: "after the change\n" }),
        },
      },
    ],
  },
  { role: "assistant", content: "I changed note.txt. The bar should confirm it." },
];
let step = 0;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const message = script[Math.min(step++, script.length - 1)];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 900, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 400 } },
      }),
    );
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/v1`;

const child = spawn(electron, ["out/main.cjs", "--self-drive"], {
  stdio: "inherit",
  env: {
    ...process.env,
    MOLT_E2E_CWD: ws,
    MOLT_E2E_URL: url,
    MOLT_E2E_MODEL: "stub-model",
    MOLT_E2E_TASK: "change note.txt",
    MOLT_E2E_EXPECT: "I changed note.txt",
  },
});

child.on("exit", (code) => {
  server.close();
  rmSync(ws, { recursive: true, force: true });
  console.log(code === 0 ? "\ne2e: PASS" : `\ne2e: FAIL (exit ${code})`);
  process.exit(code ?? 1);
});
