/**
 * `molt verify` on a project whose session logs are gone.
 *
 * It returned "no session logs to verify", exit 0, before reading the
 * integrity chain — so deleting every log, the one tampering the chain is
 * there to name, verified clean. The chain still binds those logs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { Integrity } from "../src/integrity.js";
import { Journal } from "../src/journal.js";
import { workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

function verify(cwd: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [resolve("dist/cli.js"), "verify"], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("molt verify with no session logs", () => {
  it("fails when the logs the integrity chain binds have been deleted", () => {
    const w = workspace();
    cleanups.push(w.cleanup);
    const journal = new Journal(w.dir, "s1");
    journal.append("note", { text: "work happened" });
    new Integrity(w.dir).append({ kind: "session_start", session: "s1", journalRoot: journal.chainRoot() });
    assert.equal(verify(w.dir).code, 0, "intact before anything is removed");

    rmSync(join(w.dir, ".molt", "log"), { recursive: true, force: true });
    const r = verify(w.dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /journal s1\.jsonl no longer matches its bound hash \(\(missing\)\)/);
    assert.match(r.out, /integrity chain\s+BROKEN/);
  });

  it("still passes a project that has never recorded anything, and says so", () => {
    const w = workspace();
    cleanups.push(w.cleanup);
    const r = verify(w.dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no session logs on disk/);
    assert.match(r.out, /integrity chain\s+none/);
  });
});
