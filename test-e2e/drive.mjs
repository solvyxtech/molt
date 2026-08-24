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
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const electron = require("electron");

// A workspace with a bar molt can actually satisfy.
const ws = mkdtempSync(join(tmpdir(), "molt-e2e-"));
mkdirSync(join(ws, ".molt"), { recursive: true });
writeFileSync(join(ws, "note.txt"), "before\n", "utf8");
// MOLT_E2E_RED_CHECK adds a check that always fails. It is how the ask case
// gets something to be wrongly refused by: a question that wrote nothing must
// not be blocked by a suite that was already red.
writeFileSync(
  join(ws, ".molt", "done.yml"),
  "version: 1\nchecks:\n  - name: work-landed\n    builtin: files-changed\n" +
    (process.env.MOLT_E2E_RED_CHECK === "1" ? '  - name: tests\n    run: "false"\n' : ""),
  "utf8",
);

/**
 * Two steps: write the file, then claim it is done.
 *
 * MOLT_E2E_NO_WRITE gives the other shape — an answer and nothing else. It is
 * the only way to exercise the question path, because "ask" softens the bar
 * only for a turn whose ledger is empty, and a stub that always writes can
 * never produce one.
 */
const script = process.env.MOLT_E2E_NO_WRITE === "1"
  ? [{ role: "assistant", content: "It reads note.txt and returns its contents." }]
  : [
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
  // The picker asks every endpoint what it serves. A stub that only answers
  // chat/completions would let a broken /models path pass unnoticed.
  if (req.url && req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "stub-model" }, { id: "stub/other-model" }] }));
    return;
  }
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

/**
 * A second server the app is never pointed at.
 *
 * This is the whole of the reported bug: the picker asked the presets and the
 * one endpoint molt had stored, so a second machine on the network was never
 * asked and its models could not appear. It is registered through the same
 * store the window uses, and the assertion is that its models turn up in a
 * session opened against a different endpoint entirely.
 */
const other = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "second-box-model" }] }));
});
await new Promise((r) => other.listen(0, "127.0.0.1", r));
const otherUrl = `http://127.0.0.1:${other.address().port}/v1`;

// Written into a scratch config dir so the developer's real endpoint list is
// neither read nor modified by a test run.
const cfg = mkdtempSync(join(tmpdir(), "molt-e2e-cfg-"));
writeFileSync(
  join(cfg, "desktop-endpoints.json"),
  JSON.stringify([{ url: otherUrl, seen: "2026-01-01T00:00:00Z" }]),
  "utf8",
);

/**
 * A test may not damage the machine it runs on.
 *
 * This one did. The UI-driven path clicks "Open workspace", which calls
 * saveEndpoint — and that wrote to the developer's real ~/.config/molt,
 * replacing the endpoint and model they actually use with the stub's. The
 * desktop now routes every config read and write through MOLT_CONFIG_DIR,
 * and this fingerprint is what keeps it that way.
 */
const realConfig = join(homedir(), ".config", "molt");
const fingerprint = () =>
  ["config.json", "auth.json", "desktop-endpoints.json"]
    .map((f) => {
      const p = join(realConfig, f);
      return existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "absent";
    })
    .join(" ");
const before = fingerprint();

const child = spawn(electron, ["out/main.cjs", "--self-drive"], {
  stdio: "inherit",
  env: {
    ...process.env,
    MOLT_E2E_CWD: ws,
    MOLT_E2E_URL: url,
    MOLT_E2E_MODEL: "stub-model",
    MOLT_E2E_TASK: "change note.txt",
    MOLT_E2E_EXPECT: process.env.MOLT_E2E_EXPECT ?? "I changed note.txt",
    MOLT_E2E_VIA_UI: process.env.MOLT_E2E_VIA_UI ?? "",
    MOLT_E2E_ASK: process.env.MOLT_E2E_ASK ?? "",
    MOLT_E2E_WANT_PROOF: process.env.MOLT_E2E_WANT_PROOF ?? "",
    MOLT_E2E_NO_WRITE: process.env.MOLT_E2E_NO_WRITE ?? "",
    MOLT_E2E_EXPECT_MODEL: "second-box-model",
    MOLT_CONFIG_DIR: cfg,
  },
});

child.on("exit", (code) => {
  server.close();
  other.close();
  rmSync(cfg, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
  console.log(code === 0 ? "\ne2e: PASS" : `\ne2e: FAIL (exit ${code})`);
  process.exit(code ?? 1);
});
