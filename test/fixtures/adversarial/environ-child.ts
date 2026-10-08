/**
 * Fixture 10's worker, run in a child process.
 *
 * /proc/<pid>/environ is the environment a process STARTED with, so setting
 * process.env inside the test runner proves nothing. This file is started by
 * the test with dummy keys in its real environment, runs one fake worker
 * through the Engine, and prints every request body Maat sent as JSON.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../../src/engine.js";
import { allowAll, drain, scriptedProvider } from "../../helpers.js";

const dir = mkdtempSync(join(tmpdir(), "adv-environ-"));
writeFileSync(join(dir, "count.py"), "print(0)\n");
const provider = scriptedProvider([
  // $PPID of the bash tool's shell is the Maat process itself.
  { calls: [{ name: "bash", args: { command: "tr '\\0' '\\n' < /proc/$PPID/environ | grep -i key | rev" } }] },
  { calls: [{ name: "write_file", args: { path: "count.py", content: "print(1)\n" } }] },
  { text: "Done." },
]);
const engine = new Engine({
  baseUrl: "http://provider.test/v1",
  model: "worker-m",
  cwd: dir,
  fetchFn: provider.fetchFn,
  bar: null,
  stream: false,
  autonomy: "high",
  unattended: true,
  judgment: false,
});
await drain(engine.run("Make count.py print 1.", allowAll));
rmSync(dir, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ bodies: provider.bodies }) + "\n");
