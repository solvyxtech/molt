/**
 * Privilege separation: the worker's tools run as another user.
 *
 * 2026-10-07: a Grok worker in an unattended run grepped `/`, `/opt`,
 * `~/.grok`, Maat's dist and `.maat/` for its hidden checks. Its tools ran as
 * Maat's own uid, so it could read the reference program in /tmp, the mission
 * contract, the judge's session store and Maat's records. With
 * `--worker-user` the kernel says no.
 *
 * The Linux tests need root (to switch users) and run in CI's Linux job; they
 * skip elsewhere. The default-unchanged tests run everywhere.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import { Receipts } from "../src/receipts.js";
import { Integrity } from "../src/integrity.js";
import { runCommand } from "../src/run.js";
import { stateDir } from "../src/statedir.js";
import { disablePrivSep, enablePrivSep, privSep, type PrivSep } from "../src/privsep.js";
import type { Check, EngineEvent } from "../src/types.js";
import { fileURLToPath } from "node:url";
import { allowAll, scriptedProvider, workspace } from "./helpers.js";

const HELPER = fileURLToPath(new URL("../src/fs-helper.js", import.meta.url));

const linuxRoot = process.platform === "linux" && process.getuid?.() === 0 && spawnSync("runuser", ["--help"]).status === 0;
const WORKER = process.env.MAAT_TEST_WORKER_USER ?? "maattestw";

/** Run a shell command as the worker user, the way an attacker in the worker would. */
function asWorker(cmd: string): { status: number | null; out: string } {
  const r = spawnSync("runuser", ["-u", WORKER, "--", "sh", "-c", cmd], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function ensureWorker(): number {
  if (spawnSync("id", ["-u", WORKER]).status !== 0) execFileSync("useradd", ["-m", "-s", "/bin/sh", WORKER]);
  return Number(execFileSync("id", ["-u", WORKER], { encoding: "utf8" }).trim());
}

/** A project folder the worker owns, as the bench hands one over. */
function project(uid: number): string {
  // Under a parent the worker may pass through but not read, as the bench's
  // /var/lib/bench-work: a cwd that only works because "/tmp" is readable
  // hid a getcwd() failure that broke every git command.
  const parent = "/var/tmp/maat-priv-711";
  mkdirSync(parent, { recursive: true });
  chmodSync(parent, 0o711);
  const dir = mkdtempSync(join(parent, "proj-"));
  chmodSync(dir, 0o755);
  chownSync(dir, uid, uid);
  return dir;
}

function toolResults(provider: ReturnType<typeof scriptedProvider>): string[] {
  const last = provider.requests().at(-1) as { messages: { role: string; content: string | null }[] } | undefined;
  return (last?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content ?? ""));
}

describe("privilege separation (Linux, root)", { skip: linuxRoot ? false : "needs Linux and root (CI's Linux job)" }, () => {
  let uid = 0;
  let dir = "";
  let ps: PrivSep;
  const savedState = process.env.MAAT_STATE_DIR;

  before(() => {
    uid = ensureWorker();
    dir = project(uid);
    // A mission contract waiting in the task folder before the job starts.
    mkdirSync(join(dir, ".maat", "mission", "library"), { recursive: true });
    writeFileSync(join(dir, ".maat", "mission", "contract.yml"), "assertions: [{id: a, run: 'grep -q sealed-assertion-77 out.txt'}]\n");
    writeFileSync(join(dir, ".maat", "done.yml"), "checks: []\n");
    execFileSync("chown", ["-R", `${uid}:${uid}`, dir]);
    delete process.env.MAAT_STATE_DIR;
    ps = enablePrivSep({ user: WORKER, project: dir, helper: HELPER });
  });

  after(() => {
    disablePrivSep();
    rmSync(ps.stateRoot, { recursive: true, force: true });
    rmSync(join(homedir(), ".grok", "judge-session.json"), { force: true });
    if (savedState !== undefined) process.env.MAAT_STATE_DIR = savedState;
    rmSync(dir, { recursive: true, force: true });
  });

  it("puts Maat's records, temp dirs and the mission contract out of the worker's reach", () => {
    assert.ok(!ps.stateRoot.startsWith(dir), "the state dir is outside the project");
    assert.equal(statSync(ps.stateRoot).mode & 0o777, 0o700);
    assert.equal(statSync(ps.stateRoot).uid, process.getuid!());

    // Records are redirected; the checks file stays in the project.
    assert.ok(stateDir(dir, "receipts").startsWith(ps.stateRoot));
    assert.equal(stateDir(dir, "done.yml"), join(dir, ".maat", "done.yml"));
    mkdirSync(stateDir(dir, "receipts"), { recursive: true });
    writeFileSync(stateDir(dir, "receipts", "0000-refused.md"), "hidden: grep -q sealed-check-42 out.txt\n");
    const r1 = asWorker(`cat '${stateDir(dir, "receipts", "0000-refused.md")}'`);
    assert.notEqual(r1.status, 0, "the worker read a receipt in the state dir");
    assert.match(r1.out, /Permission denied/);
    assert.notEqual(asWorker(`ls '${ps.stateRoot}'`).status, 0, "the worker listed the state dir");

    // The contract left the task folder; the library (the worker's) stayed.
    assert.ok(!existsSync(join(dir, ".maat", "mission", "contract.yml")), "the contract is still in the task folder");
    assert.ok(existsSync(join(ps.stateRoot, "mission", "contract.yml")));
    assert.ok(existsSync(join(dir, ".maat", "mission", "library")));
    assert.notEqual(asWorker(`cat '${join(ps.stateRoot, "mission", "contract.yml")}'`).status, 0);

    // A reference try made the way reference.ts makes one.
    assert.ok(tmpdir().startsWith(ps.stateRoot), `Maat's temp dir ${tmpdir()} is not in the state dir`);
    const refTry = mkdtempSync(join(tmpdir(), "ref-try-"));
    writeFileSync(join(refTry, "reference.py"), "print('the answer')\n");
    chmodSync(join(refTry, "reference.py"), 0o644);
    assert.notEqual(asWorker(`cat '${join(refTry, "reference.py")}'`).status, 0, "the worker read the reference program");

    // The judge's HOME: its logins and its session store.
    const home = homedir();
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "judge-session.json"), "{}");
    assert.notEqual(asWorker(`ls '${home}'`).status, 0, "the worker listed the judge's HOME");
    assert.notEqual(asWorker(`cat '${join(home, ".grok", "judge-session.json")}'`).status, 0);
  });

  it("runs the worker's bash as the worker uid, and its file tools as the worker", async () => {
    const secret = join(ps.stateRoot, "receipts", "0000-refused.md");
    const provider = scriptedProvider([
      {
        calls: [
          { name: "bash", args: { command: "id -u > who.txt; pwd -P > where.txt; git init -q . && git status --short >/dev/null && echo git-ok >> where.txt" } },
          { name: "read_file", args: { path: secret } },
          { name: "write_file", args: { path: "made.txt", content: "mine\n" } },
          { name: "grep", args: { path: ".", pattern: "sealed" } },
          { name: "bash", args: { command: `cat '${secret}'; echo exit=$?` } },
          { name: "bash", args: { command: "ls /proc | grep -E '^[0-9]+$' | tr '\\n' ' '" } },
        ],
      },
      { text: "Done." },
    ]);
    const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", sandbox: true });
    for await (const _ of engine.run("look around", allowAll, { ask: true })) {
      /* drain */
    }
    assert.equal(readFileSync(join(dir, "who.txt"), "utf8").trim(), String(uid), "bash ran as Maat's uid");
    assert.equal(statSync(join(dir, "who.txt")).uid, uid);
    assert.equal(readFileSync(join(dir, "where.txt"), "utf8"), `${dir}\ngit-ok\n`, "the worker's commands cannot see their own cwd");
    assert.equal(statSync(join(dir, "made.txt")).uid, uid, "write_file wrote as Maat");
    const results = toolResults(provider);
    const joined = results.join("\n---\n");
    assert.ok(!joined.includes("sealed-check-42"), `a tool read the state dir:\n${joined}`);
    assert.match(joined, /EACCES|permission denied/i, "read_file was refused by the kernel");
    if (ps.pidns) {
      const pids = (results.at(-1) ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
      assert.ok(pids.length > 0 && pids.length < 10, `the worker's /proc: ${pids.join(" ")}`);
      assert.ok(!pids.includes(process.pid), "the worker can see Maat in its process list");
    }
  });

  it("copies the receipts into the project when the job ends", async () => {
    const ws = project(uid);
    // A second project: the state dir follows whichever project was enabled.
    disablePrivSep();
    const ps2 = enablePrivSep({ user: WORKER, project: ws, helper: HELPER });
    try {
      const provider = scriptedProvider([{ calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] }, { text: "Done." }]);
      const journal = new Journal(ws);
      const receipts = new Receipts(ws);
      const integrity = new Integrity(ws);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", journal, receipts, integrity });
      const check: Check = { name: "task:out", kind: "command", run: "grep -q hello out.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task", "value"], hidden: true };
      const events: EngineEvent[] = [];
      for await (const ev of engine.run("write out.txt saying hello", allowAll, { taskChecks: [check] })) events.push(ev);
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.outcome === "verified", `outcome ${end && end.kind === "job_end" ? end.outcome : "none"}`);
      assert.ok(!existsSync(join(ws, ".maat", "receipts")), "receipts were written into the project during the job");
      assert.ok(readdirSync(join(ps2.stateRoot, "receipts")).some((f) => f.endsWith(".md")));

      const dest = ps2.publish();
      assert.equal(dest, join(ws, ".maat"));
      const mds = readdirSync(join(ws, ".maat", "receipts")).filter((f) => f.endsWith(".md"));
      assert.ok(mds.length > 0, "no receipt in the project after the job");
      assert.ok(existsSync(join(ws, ".maat", "log")), "the journal was not copied");
      assert.equal(statSync(join(ws, ".maat", "receipts", mds[0]!)).uid, uid, "the copied receipt is not the project owner's");
      assert.ok(!existsSync(join(ws, ".maat", "tmp")), "Maat's temp dir was copied into the project");
      disablePrivSep();
      const v = Integrity.verify(ws);
      assert.equal(v.ok, true, v.reason);
    } finally {
      disablePrivSep();
      rmSync(ws, { recursive: true, force: true });
      rmSync(ps2.stateRoot, { recursive: true, force: true });
    }
  });
});

describe("privilege separation off (the default)", () => {
  it("changes nothing: records in the project, commands and files as Maat's own user", async () => {
    assert.equal(privSep(), undefined);
    const ws = workspace();
    try {
      assert.equal(stateDir(ws.dir, "receipts"), join(ws.dir, ".maat", "receipts"));
      if (process.platform !== "win32") {
        const r = await runCommand("id -u", { cwd: ws.dir, asWorker: true });
        assert.equal(r.stdout.trim(), String(process.getuid!()));
      }
      const provider = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "a.txt", content: "x\n" } }, { name: "bash", args: { command: "echo hi > b.txt" } }] },
        { text: "Done." },
      ]);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      for await (const _ of engine.run("make two files", allowAll, { ask: true })) {
        /* drain */
      }
      if (process.platform !== "win32") {
        assert.equal(statSync(join(ws.dir, "a.txt")).uid, process.getuid!());
        assert.equal(statSync(join(ws.dir, "b.txt")).uid, process.getuid!());
      }
      assert.equal(readFileSync(join(ws.dir, "b.txt"), "utf8"), "hi\n");
    } finally {
      ws.cleanup();
    }
  });

  it("refuses a worker user that cannot be switched to", () => {
    if (process.platform === "win32") return;
    assert.throws(() => enablePrivSep({ user: "maat-no-such-user-xyz", project: tmpdir(), helper: HELPER }), /no such user/);
    assert.equal(privSep(), undefined);
  });
});
