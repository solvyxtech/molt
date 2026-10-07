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
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import { Receipts } from "../src/receipts.js";
import { Integrity } from "../src/integrity.js";
import { runCommand } from "../src/run.js";
import { stateDir } from "../src/statedir.js";
import { disablePrivSep, enablePrivSep, gitSync, privSep, safeRel, type PrivSep } from "../src/privsep.js";
import { listBackground, resetBackgroundRegistry, startBackground, type BackgroundProcess } from "../src/background.js";
import { ACP_AGENTS } from "../src/acp.js";
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

/** A root-owned folder of root-owned files, outside every project: what an attack aims at. */
function victim(files = 20): string {
  mkdirSync("/var/tmp", { recursive: true });
  const v = mkdtempSync("/var/tmp/maat-victim-");
  chmodSync(v, 0o755);
  for (let i = 0; i < files; i++) writeFileSync(join(v, `f${i}`), "precious\n", { mode: 0o644 });
  return v;
}

/** Every entry under `dir` (and `dir` itself) still root's, with the original content. */
function assertUntouched(v: string): void {
  assert.equal(statSync(v).uid, 0, `${v} was chowned`);
  for (const n of readdirSync(v)) {
    const st = lstatSync(join(v, n));
    assert.equal(st.uid, 0, `${join(v, n)} was chowned to ${st.uid}`);
    if (st.isFile()) assert.equal(readFileSync(join(v, n), "utf8"), "precious\n", `${join(v, n)} was written`);
  }
}

/** Every path under `root` that is a symlink. */
function symlinksUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.push(p);
      else if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

async function waitExit(p: BackgroundProcess, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!p.exit && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  assert.ok(p.exit, `job ${p.id} did not exit`);
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
  const roots: string[] = [];
  /** Privilege separation on for the main project (a test before may have turned it off). */
  const active = (): PrivSep => {
    if (privSep() !== ps || !privSep()) {
      ps = enablePrivSep({ user: WORKER, project: dir, helper: HELPER });
      roots.push(ps.stateRoot);
    }
    return ps;
  };

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
    for (const r of [ps.stateRoot, ...roots]) rmSync(r, { recursive: true, force: true });
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

  it("a symlinked .maat/bg/<id>.log does not make root write the target", async () => {
    const v = victim(1);
    const target = join(v, "f0");
    const v2 = victim(0);
    active();
    resetBackgroundRegistry();
    try {
      // The worker plants the next job's log as a link to a root-owned file.
      const bg = join(dir, ".maat", "bg");
      const r = asWorker(`mkdir -p '${bg}' && ln -sf '${target}' '${bg}/1.log' && echo ok`);
      assert.equal(r.status, 0, r.out);
      const j1 = startBackground("echo pwned", { cwd: dir, asWorker: true });
      await waitExit(j1);
      assert.equal(readFileSync(target, "utf8"), "precious\n", "root truncated or wrote the link's target");
      assert.equal(statSync(target).uid, 0);
      assert.notEqual(j1.exit?.code, 0, "the worker's own shell should have been refused the root-owned target");

      // A normal job: its log is made by the worker and holds the output.
      const j2 = startBackground("echo hello-bg", { cwd: dir, asWorker: true });
      await waitExit(j2);
      assert.equal(readFileSync(join(dir, j2.log), "utf8"), "hello-bg\n");
      assert.equal(statSync(join(dir, j2.log)).uid, uid, "the log is not the worker's");

      // The whole bg folder swapped for a link into a root-owned folder.
      rmSync(bg, { recursive: true, force: true });
      assert.equal(asWorker(`ln -s '${v2}' '${bg}' && echo ok`).status, 0);
      const j3 = startBackground("echo pwned", { cwd: dir, asWorker: true });
      await waitExit(j3);
      assert.deepEqual(readdirSync(v2), [], "a log was created inside the root-owned folder");
      assert.ok(listBackground().length >= 3);
    } finally {
      resetBackgroundRegistry();
      rmSync(join(dir, ".maat", "bg"), { recursive: true, force: true });
      rmSync(v, { recursive: true, force: true });
      rmSync(v2, { recursive: true, force: true });
    }
  });

  it("handBack: a folder swapped for a symlink mid-walk never gets root to chown outside", async () => {
    const v = victim(40);
    active();
    const swap = join(dir, "swap");
    mkdirSync(swap);
    for (let i = 0; i < 40; i++) writeFileSync(join(swap, `g${i}`), "x\n");
    chownSync(swap, uid, uid);
    // Root-made files inside, so the walk has something to hand back each time.
    const refill = () => {
      for (let i = 0; i < 40; i++) {
        try {
          chownSync(join(swap, `g${i}`), 0, 0);
        } catch {
          /* swapped out right now */
        }
      }
    };
    // The worker flips `swap` between its real folder and a link to the victim, as fast as it can.
    assert.equal(asWorker(`ln -s '${v}' '${join(dir, "lnk")}' && echo ok`).status, 0);
    const stop = join("/tmp", `maat-flip-stop-${process.pid}`);
    rmSync(stop, { force: true });
    const flipper = spawn(
      "runuser",
      [
        "-u",
        WORKER,
        "--",
        process.execPath,
        "-e",
        `const fs=require("fs");process.chdir(${JSON.stringify(dir)});const end=Date.now()+15000;let i=0;` +
          `while(Date.now()<end&&!(++i%64===0&&fs.existsSync(${JSON.stringify(stop)}))){try{fs.renameSync("swap","real");fs.renameSync("lnk","swap");fs.renameSync("swap","lnk");fs.renameSync("real","swap");}catch{}}`,
      ],
      { stdio: "ignore" },
    );
    const flipped = new Promise((r) => flipper.once("exit", r));
    const stopFlipper = async () => {
      writeFileSync(stop, "");
      await flipped;
    };
    try {
      // A static link as well, the case without any race.
      assert.equal(asWorker(`ln -sfn '${v}' '${join(dir, "static-link")}' && echo ok`).status, 0);
      const t0 = Date.now();
      let runs = 0;
      while (Date.now() - t0 < 4_000) {
        refill();
        ps.handBack(dir);
        runs += 1;
        await new Promise((r) => setImmediate(r));
      }
      assert.ok(runs > 10, `only ${runs} hand-backs ran`);
      assertUntouched(v);
      // The state dir is Maat's and stays so.
      assert.equal(statSync(ps.stateRoot).uid, 0);
      // And hand-back still does its job on the real tree.
      await stopFlipper();
      const real = existsSync(join(dir, "real")) ? join(dir, "real") : swap;
      writeFileSync(join(real, "made-by-root.txt"), "x\n");
      ps.handBack(dir);
      assert.equal(statSync(join(real, "made-by-root.txt")).uid, uid, "hand-back did not give back a root-made file");
    } finally {
      await stopFlipper();
      rmSync(stop, { force: true });
      for (const n of ["swap", "real", "lnk", "static-link"]) rmSync(join(dir, n), { recursive: true, force: true });
      rmSync(v, { recursive: true, force: true });
    }
  });

  it("handBack leaves a hard link to a root-owned file alone", () => {
    // Root-made, with a second link elsewhere in the tree: nlink 2 is refused.
    active();
    const a = join(dir, "hl-a.txt");
    writeFileSync(a, "x\n");
    execFileSync("ln", [a, join(dir, "hl-b.txt")]);
    try {
      ps.handBack(dir);
      assert.equal(statSync(a).uid, 0, "a multiply-linked root file was chowned");
    } finally {
      rmSync(a, { force: true });
      rmSync(join(dir, "hl-b.txt"), { force: true });
    }
  });

  it("seed refuses symlinks: nothing from the project becomes a link in the state dir", () => {
    const ws = project(uid);
    const v = victim(1);
    const secret = "/root/maat-seed-secret.txt";
    writeFileSync(secret, "root-only-secret-81\n", { mode: 0o600 });
    // The worker leaves links where Maat's records go, and one real record.
    const r = asWorker(
      `mkdir -p '${ws}/.maat/integrity' '${ws}/.maat/mission' && echo kept > '${ws}/.maat/integrity/chain' && ` +
        `ln -s '${v}' '${ws}/.maat/receipts' && ln -s '${secret}' '${ws}/.maat/secret.txt' && ` +
        `ln -s '${v}' '${ws}/.maat/integrity/sub' && ln -s '${secret}' '${ws}/.maat/mission/contract.yml' && echo ok`,
    );
    assert.equal(r.status, 0, r.out);
    disablePrivSep();
    const ps2 = enablePrivSep({ user: WORKER, project: ws, helper: HELPER });
    try {
      assert.deepEqual(symlinksUnder(ps2.stateRoot), [], "a symlink was carried into the state dir");
      assert.equal(readFileSync(join(ps2.stateRoot, "integrity", "chain"), "utf8"), "kept\n", "a real record was not seeded");
      assert.ok(!existsSync(join(ps2.stateRoot, "secret.txt")), "a link to a root file was read into the state dir");
      for (const s of ["receipts", "secret.txt", "integrity/sub", "mission/contract.yml"]) {
        assert.ok(ps2.skippedOnSeed.includes(s), `${s} was not reported as skipped: ${ps2.skippedOnSeed.join(", ")}`);
      }
      // Maat now writes its receipts into its own folder, not through the link.
      mkdirSync(stateDir(ws, "receipts"), { recursive: true });
      writeFileSync(stateDir(ws, "receipts", "0001.md"), "receipt\n");
      assert.ok(stateDir(ws, "receipts").startsWith(ps2.stateRoot));
      assertUntouched(v);

      // Publishing goes back as the worker: the link at .maat/receipts gets the
      // worker's write, which the root-owned target refuses. Nothing of root's is
      // written, and the secret never reaches the project.
      assert.throws(() => ps2.publish(), /could not be written/);
      assertUntouched(v);
      assert.equal(readFileSync(secret, "utf8"), "root-only-secret-81\n");
      assert.notEqual(asWorker(`grep -r root-only-secret-81 '${ws}'`).status, 0, "the root-only secret reached the project");
    } finally {
      disablePrivSep();
      rmSync(ws, { recursive: true, force: true });
      rmSync(ps2.stateRoot, { recursive: true, force: true });
      rmSync(v, { recursive: true, force: true });
      rmSync(secret, { force: true });
    }
  });

  it("runs Maat's git as the worker: repository config never runs as root", () => {
    active();
    const repo = join(dir, "gitrepo");
    const mark = join(dir, "git-marker");
    const r = asWorker(
      `mkdir -p '${repo}' && cd '${repo}' && git init -q && git config core.fsmonitor 'touch ${mark}; false' && echo ok`,
    );
    assert.equal(r.status, 0, r.out);
    try {
      assert.ok(!Object.values(process.env).includes("safe.directory"), "safe.directory is still set for Maat");
      gitSync(["status", "--porcelain"], repo);
      if (existsSync(mark)) assert.equal(statSync(mark).uid, uid, "the repository's configured command ran as root");
      // And Maat's own (root) git, without safe.directory, refuses the worker's repository.
      const own = spawnSync("git", ["status"], { cwd: repo, encoding: "utf8" });
      assert.notEqual(own.status, 0, "root git accepted a repository the worker owns");
      assert.ok(!existsSync(mark) || statSync(mark).uid === uid);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(mark, { force: true });
    }
  });

  it("passes the worker agent's own credential through, and only that", () => {
    const base = { OPENCODE_API_KEY: "zen-key", OPENAI_API_KEY: "other", GITHUB_TOKEN: "gh", PATH: "/usr/bin" };
    active();
    const oc = ACP_AGENTS.find((a) => a.name === "opencode")!;
    const spec = ps.execSpec("opencode", ["acp"], dir, base, oc.workerCredentialEnv);
    assert.equal(spec.env.OPENCODE_API_KEY, "zen-key");
    assert.equal(spec.env.OPENAI_API_KEY, undefined);
    assert.equal(spec.env.GITHUB_TOKEN, undefined);
    // A plain worker command never gets it.
    assert.equal(ps.commandSpec("env", true, dir, base).env.OPENCODE_API_KEY, undefined);
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

  it("accepts only plain relative paths back from the file helper", () => {
    assert.equal(safeRel("receipts/0001.md"), join("receipts", "0001.md"));
    for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a//b", "./a", "a/\0b"]) assert.equal(safeRel(bad), null, bad);
  });

  it("names the OpenCode worker's own credential, and no agent names another's", () => {
    const oc = ACP_AGENTS.find((a) => a.name === "opencode");
    assert.deepEqual(oc?.workerCredentialEnv, ["OPENCODE_API_KEY"]);
    for (const a of ACP_AGENTS) for (const k of a.workerCredentialEnv ?? []) assert.match(k, new RegExp(`^${a.name}_`, "i"));
  });

  it("refuses a worker user that cannot be switched to", () => {
    if (process.platform === "win32") return;
    assert.throws(() => enablePrivSep({ user: "maat-no-such-user-xyz", project: tmpdir(), helper: HELPER }), /no such user/);
    assert.equal(privSep(), undefined);
  });
});
