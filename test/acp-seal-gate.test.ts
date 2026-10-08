/**
 * The seal gate on a backend that makes its own tool calls.
 *
 * On the native loop the engine plans a step's calls and seals the drafted
 * checks before the first one that changes anything. A subprocess backend
 * (Grok Build or OpenCode over ACP) runs a whole step of calls inside one
 * request, so that check never saw them: on 29 of 29 Grok runs the agent had
 * already written its files when the seal wait began. The gate now runs per
 * call, before the tool does.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ACP_AGENTS } from "../src/acp.js";
import { Engine } from "../src/engine.js";
import type { Check } from "../src/types.js";
import { scriptedAcpAgent } from "./acp-agent.js";
import { allowAll, drain, workspace } from "./helpers.js";

const GROK = ACP_AGENTS.find((a) => a.name === "grok-build")!;

const mk = (name: string, run: string): Check => ({ name, kind: "command", run, timeoutMs: 5_000, expectExit: 0, tags: ["task", "value", "exact"], hidden: true });

describe("seal gate on a subprocess backend", () => {
  it("holds the first write until the checks are sealed, but lets reads through", async () => {
    const ws = workspace();
    try {
      const agent = scriptedAcpAgent([
        {
          calls: [
            { name: "list_dir", args: { path: "." } },
            { name: "write_file", args: { path: "out.txt", content: "hello\n" } },
          ],
          text: "Done.",
        },
      ]);
      const engine = new Engine({ baseUrl: GROK.url, model: "grok-4.6", provider: "grok-build", cwd: ws.dir, bar: null, acpSpawn: agent.spawnFn, autonomy: "high" });
      let fileWhenSealed: boolean | undefined;
      const pending = new Promise<{ taskChecks: Check[]; taskNotes: string[] }>((resolve) =>
        setTimeout(() => {
          fileWhenSealed = existsSync(join(ws.dir, "out.txt"));
          resolve({ taskChecks: [mk("greeting", "grep -qx hello out.txt")], taskNotes: [] });
        }, 600),
      );
      const ev = await drain(
        engine.run("write hello to out.txt", allowAll, {
          pendingCriteria: pending,
          criteriaSoFar: async () => ({ taskChecks: [], taskNotes: [] }),
        }),
      );
      assert.equal(fileWhenSealed, false, "the drafter finished before the file was written");
      const wait = ev.findIndex((e) => e.kind === "info" && /waiting for this task's checks to be sealed/.test(e.text));
      const write = ev.findIndex((e) => e.kind === "tool" && e.name === "write_file");
      const read = ev.findIndex((e) => e.kind === "tool" && e.name === "list_dir");
      assert.ok(wait >= 0, "the wait was announced");
      assert.ok(read >= 0 && read < wait, "a read ran before the wait");
      assert.ok(write > wait, "the write came after the wait");
      const proof = ev.find((e) => e.kind === "proof_result");
      assert.ok(proof && proof.kind === "proof_result" && proof.result.results.some((r) => r.name === "task:greeting"), "the sealed check judged the claim");
    } finally {
      ws.cleanup();
    }
  });
});
