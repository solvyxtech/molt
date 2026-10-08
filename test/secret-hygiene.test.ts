/**
 * What a worker of Maat's own user can read back from the processes around
 * it: a hidden check's command text, and the provider keys.
 *
 * Checks ran as `sh -c "<command>"`, so the command sat in
 * /proc/<pid>/cmdline (or `ps` on macOS) for as long as it ran, and a check
 * that runs the worker's deliverable handed that deliverable its own parent's
 * argv. Keys were scrubbed from the worker's env by six names, and every key
 * stayed in Maat's own exec environment, which /proc/$PPID/environ returns.
 *
 * The Linux half of this file reads /proc directly; run it in a
 * node:22-bookworm container (docs/secrets.md). On macOS the same assertions
 * go through `ps -ww -E`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runCheck, type BarContext } from "../src/bar.js";
import { preflightCriteria } from "../src/criteria.js";
import { env } from "../src/env.js";
import { HIDDEN_WRAPPER, runCommand } from "../src/run.js";
import { copyRegular } from "../src/scratch.js";
import { _resetSecrets, captureSecrets, isSecretName, parseKeys, scrubEnv, secretValue, withSecrets } from "../src/secrets.js";
import type { Check } from "../src/types.js";
import { workspace } from "./helpers.js";

const linux = process.platform === "linux";
const posix = process.platform !== "win32";
const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});
function ws(): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}
const marker = () => `MAATMARK${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every process whose argv or environment this user can read and that contains `needle`. */
function processesHolding(needle: string): string[] {
  const hits: string[] = [];
  if (linux) {
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      for (const f of ["cmdline", "environ"]) {
        try {
          if (readFileSync(`/proc/${pid}/${f}`).includes(needle)) hits.push(`${pid}/${f}`);
        } catch {
          /* gone, or not ours */
        }
      }
    }
    return hits;
  }
  // -E appends each process's environment (own processes only).
  const ps = execFileSync("ps", ["-axww", "-E", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  for (const line of ps.split("\n")) if (line.includes(needle)) hits.push(line.trim().split(/\s+/)[0]!);
  return hits;
}

/**
 * A deliverable that reads what it can: its own environment, whether it
 * inherited fd 3, and every ancestor's argv and environment, into `$1`.
 * This is the worker's code as a value check (or the worker's bash) runs it.
 */
const PEEK = `#!/bin/sh
out="$1"
{
  echo "== own =="
  env
  echo "== ancestors =="
  (true <&3) 2>/dev/null && echo FD3-INHERITED
  p=$PPID
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    if [ -r /proc/$p/cmdline ]; then
      tr '\\0' ' ' < /proc/$p/cmdline; echo
      tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null
      p=$(sed 's/.*) //' /proc/$p/stat | cut -d' ' -f2)
    else
      ps -ww -E -o command= -p $p
      p=$(ps -o ppid= -p $p | tr -d ' ')
    fi
  done
} > "$out" 2>&1
`;

function peekProject(): { dir: string; out: string } {
  const dir = ws();
  writeFileSync(join(dir, "peek.sh"), PEEK);
  chmodSync(join(dir, "peek.sh"), 0o755);
  return { dir, out: join(ws(), "seen.txt") };
}

describe("a check's command text", { skip: !posix }, () => {
  it("is in no process's argv or environment while it runs (and the scan does see an unhidden one)", async () => {
    const dir = ws();
    const hidden = marker();
    const plain = marker();
    const running = [
      runCommand(`: ${hidden}; sleep 2; true`, { cwd: dir, hideCommand: true, timeoutMs: 20_000 }),
      runCommand(`: ${plain}; sleep 2; true`, { cwd: dir, timeoutMs: 20_000 }),
    ];
    await wait(700);
    const hiddenHits = processesHolding(hidden);
    const plainHits = processesHolding(plain);
    const done = await Promise.all(running);
    assert.deepEqual(done.map((r) => r.code), [0, 0]);
    // The control: run the old way, the scan finds it. Without this, an empty
    // scan would prove only that the scan is blind.
    assert.ok(plainHits.length > 0, "the scan should see a command passed as argv");
    assert.deepEqual(hiddenHits, [], `hidden command visible in: ${hiddenHits.join(", ")}`);
  });

  it("still runs as written: exit codes, $0, no leftover variable, parse errors, long commands", async () => {
    const dir = ws();
    const r = await runCommand(`echo "$0"; [ -n "$__maat_c" ] && echo LEAKED-VAR; exit 7`, { cwd: dir, hideCommand: true, shell: "/bin/sh" });
    assert.equal(r.code, 7);
    assert.match(r.stdout, /sh/);
    assert.doesNotMatch(r.stdout, /LEAKED-VAR/);
    const bad = await runCommand(`if then fi (`, { cwd: dir, hideCommand: true });
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /syntax error|unexpected/i);
    const big = "x".repeat(300_000);
    const long = await runCommand(`v='${big}'; echo \${#v}`, { cwd: dir, hideCommand: true });
    assert.equal(long.stdout.trim(), String(big.length));
  });

  it("cannot be read by a child of the check from its parent's cmdline or environment", async () => {
    const { dir, out } = peekProject();
    const m = marker();
    const r = await runCommand(`: ${m}; sh ./peek.sh '${out}'; true`, { cwd: dir, hideCommand: true });
    assert.equal(r.code, 0);
    const seen = readFileSync(out, "utf8");
    assert.ok(seen.includes("__maat_c"), "the child should have read its parent's (wrapper) argv");
    assert.ok(!seen.includes(m), "the child read the hidden command");
    assert.ok(!seen.includes("FD3-INHERITED"), "the child inherited the command descriptor");
    // Control: the old way, the same child does read it.
    const m2 = marker();
    await runCommand(`: ${m2}; sh ./peek.sh '${out}'; true`, { cwd: dir });
    assert.ok(readFileSync(out, "utf8").includes(m2));
  });

  it("does not reach a deliverable through the bar's hidden task check", async () => {
    const { dir, out } = peekProject();
    const m = marker();
    const check = {
      name: "value",
      kind: "command",
      run: `: ${m}; sh ./peek.sh '${out}' && test -s '${out}'`,
      expectExit: 0,
      timeoutMs: 20_000,
      tags: ["task", "value"],
      hidden: true,
    } as Check;
    const ctx = { cwd: dir, record: [], ledger: [], archivedBatches: 0 } as unknown as BarContext;
    const res = await runCheck(check, ctx);
    assert.equal(res.ok, true, res.output);
    const seen = readFileSync(out, "utf8");
    assert.ok(seen.includes("== own ==") && !seen.includes(m), "the deliverable read the hidden check");
    assert.ok(!seen.includes("FD3-INHERITED"));
  });

  it("does not reach a deliverable through a drafting trial run", async () => {
    const { dir, out } = peekProject();
    const m = marker();
    await preflightCriteria([{ name: "trial", run: `: ${m}; sh ./peek.sh '${out}'; true` }], { cwd: dir, timeoutMs: 20_000 });
    const seen = readFileSync(out, "utf8");
    assert.ok(seen.includes("== own ==") && !seen.includes(m));
  });

  it("goes through hideCommand at every check run site in the source", () => {
    // A new caller that runs check text the old way would reopen the leak
    // silently; this names it.
    const sites: [string, RegExp][] = [
      ["src/bar.ts", /runCommand\(/g],
      ["src/criteria.ts", /runCommand\(/g],
      ["src/mission.ts", /runCommand\(/g],
      ["src/reference.ts", /runCommand\(check\.run/g],
      ["src/post-audit.ts", /runCommand\(run,/g],
    ];
    for (const [file, re] of sites) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      let n = 0;
      for (const m of src.matchAll(re)) {
        const call = src.slice(m.index!, src.indexOf(");", m.index!) + 2);
        assert.match(call, /hideCommand: true/, `${file}: ${call.slice(0, 120)}`);
        n++;
      }
      assert.ok(n > 0, `${file}: no runCommand call found`);
    }
    assert.ok(!HIDDEN_WRAPPER.includes("export"));
  });
});

describe("the check copy", { skip: !posix }, () => {
  it("copies a regular file, and refuses a symlink or a FIFO at the moment of opening", async () => {
    const dir = ws();
    const secret = join(ws(), "root-only");
    writeFileSync(secret, "TOPSECRET");
    writeFileSync(join(dir, "real"), "hello");
    chmodSync(join(dir, "real"), 0o751);
    symlinkSync(secret, join(dir, "swapped"));
    execFileSync("mkfifo", [join(dir, "fifo")]);
    const dst = ws();
    assert.equal(await copyRegular(join(dir, "real"), join(dst, "real")), true);
    assert.equal(readFileSync(join(dst, "real"), "utf8"), "hello");
    const fd = openSync(join(dst, "real"), "r");
    assert.equal(fstatSync(fd).mode & 0o777, 0o751);
    closeSync(fd);
    // What a listing called a file and the worker then swapped for a link.
    assert.equal(await copyRegular(join(dir, "swapped"), join(dst, "swapped")), false);
    assert.equal(existsSync(join(dst, "swapped")), false);
    // A FIFO neither hangs the copy nor is copied.
    assert.equal(await copyRegular(join(dir, "fifo"), join(dst, "fifo")), false);
    assert.equal(existsSync(join(dst, "fifo")), false);
  });
});

describe("credentials", () => {
  it("are recognised by shape, not by a list of six names", () => {
    for (const k of ["OPENROUTER_API_KEY", "MAAT_JUDGE_KEY", "MAAT_API_KEY", "MOLT_API_KEY", "XAI_API_KEY", "XAI_BASE", "GROK_AUTH", "TOGETHER_API_KEY", "TOGETHER_X", "GITHUB_TOKEN", "HF_TOKEN", "AWS_SECRET_ACCESS_KEY", "SOME_SECRET", "DEEPSEEK_APIKEY", "DB_PASSWORD", "MAAT_KEYS_FD"]) {
      assert.ok(isSecretName(k), k);
    }
    for (const k of ["PATH", "HOME", "MAAT_JUDGE_MODEL", "MAAT_JUDGE_URL", "TOKENIZERS_PARALLELISM", "KEYBOARD", "LANG"]) assert.ok(!isSecretName(k), k);
    const scrubbed = scrubEnv({ PATH: "/bin", GITHUB_TOKEN: "t", XAI_API_KEY: "x", MAAT_KEEP_ENV: "GITHUB_TOKEN" });
    assert.deepEqual(Object.keys(scrubbed).sort(), ["GITHUB_TOKEN", "MAAT_KEEP_ENV", "PATH"]);
  });

  it("move out of the environment into memory, and are still found there", () => {
    _resetSecrets();
    const e: NodeJS.ProcessEnv = { PATH: "/bin", OPENROUTER_API_KEY: "sk-or-1234567890", MAAT_JUDGE_KEY: "judge-1234567890", HF_TOKEN: "hf", MAAT_KEEP_ENV: "HF_TOKEN" };
    const rep = captureSecrets(e);
    assert.deepEqual(rep.moved.sort(), ["MAAT_JUDGE_KEY", "OPENROUTER_API_KEY"]);
    assert.deepEqual(Object.keys(e).sort(), ["HF_TOKEN", "MAAT_KEEP_ENV", "PATH"]);
    assert.equal(secretValue("OPENROUTER_API_KEY"), "sk-or-1234567890");
    assert.equal(withSecrets({}).MAAT_JUDGE_KEY, "judge-1234567890");
    _resetSecrets();
  });

  it("load from MAAT_KEYS_FD (then closed) and from a 0600 MAAT_KEYS_FILE; a readable file is refused", { skip: !posix }, () => {
    _resetSecrets();
    const dir = ws();
    const f = join(dir, "keys");
    writeFileSync(f, "# keys\nexport MAAT_API_KEY='fromfile-123456789'\nOTHER=1\n");
    chmodSync(f, 0o644);
    const refused = captureSecrets({ MAAT_KEYS_FILE: f });
    assert.equal(refused.loaded.length, 0);
    assert.match(refused.problems.join(), /readable by others/);
    assert.ok(!refused.problems.join().includes("fromfile"), "a problem must never quote a value");
    chmodSync(f, 0o600);
    const e: NodeJS.ProcessEnv = { MAAT_KEYS_FILE: f };
    assert.deepEqual(captureSecrets(e).problems, []);
    assert.equal(e.MAAT_KEYS_FILE, undefined);
    assert.equal(secretValue("MAAT_API_KEY"), "fromfile-123456789");
    const j = join(dir, "keys.json");
    writeFileSync(j, JSON.stringify({ MOLT_API_KEY: "fromfd-123456789" }));
    const fd = openSync(j, "r");
    assert.deepEqual(captureSecrets({ MAAT_KEYS_FD: String(fd) }).problems, []);
    assert.equal(secretValue("MOLT_API_KEY"), "fromfd-123456789");
    assert.throws(() => fstatSync(fd), /EBADF/, "the keys descriptor must be closed after reading");
    assert.deepEqual([...parseKeys('A="b c"\nbad line\nC=d')], [["A", "b c"], ["C", "d"]]);
    _resetSecrets();
  });

  it("are reachable through env() after capture", () => {
    _resetSecrets();
    const saved = process.env.MAAT_API_KEY;
    process.env.MAAT_API_KEY = "envkey-123456789";
    try {
      captureSecrets(process.env);
      assert.equal(process.env.MAAT_API_KEY, undefined);
      assert.equal(env("API_KEY"), "envkey-123456789");
    } finally {
      _resetSecrets();
      if (saved !== undefined) process.env.MAAT_API_KEY = saved;
    }
  });
});

/**
 * End to end, through the real CLI: a provider that has the worker run one
 * bash command which dumps its own environment and every ancestor's argv and
 * environment, then says it is done.
 */
async function leakProvider(seenAuth: string[]): Promise<string> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ""));
    req.resume();
    req.on("end", () => {
      const first = n++ % 2 === 0;
      const message = first
        ? { role: "assistant", content: null, tool_calls: [{ id: `call_${n}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: 'sh ./peek.sh "$PWD/seen.txt"' }) } }] }
        : { role: "assistant", content: "Done." };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;
}

const CLI = join(process.cwd(), "dist-test", "src", "cli.js");

async function workerSees(how: "fd" | "file" | "env", key: string): Promise<{ seen: string; auth: string[] }> {
  const dir = ws();
  writeFileSync(join(dir, "peek.sh"), PEEK);
  const auth: string[] = [];
  const url = await leakProvider(auth);
  const cfg = join(ws(), "cfg");
  mkdirSync(cfg, { recursive: true });
  // A worker of Maat's own user is the subject: as root on Linux the default would separate it.
  const base: NodeJS.ProcessEnv = { ...scrubEnv(process.env), MOLT_CONFIG_DIR: cfg, MAAT_WORKER_USER: "none" };
  const payload = `MAAT_API_KEY=${key}\nOPENROUTER_API_KEY=${key}-or\nMAAT_JUDGE_KEY=${key}-judge\n`;
  let childEnv: NodeJS.ProcessEnv;
  if (how === "file") {
    const f = join(ws(), "keys");
    writeFileSync(f, payload, { mode: 0o600 });
    childEnv = { ...base, MAAT_KEYS_FILE: f };
  } else if (how === "fd") {
    childEnv = { ...base, MAAT_KEYS_FD: "3" };
  } else {
    childEnv = { ...base, MAAT_API_KEY: key, OPENROUTER_API_KEY: `${key}-or`, MAAT_JUDGE_KEY: `${key}-judge` };
  }
  const child = spawn(process.execPath, [CLI, "run", "look around", "--url", url, "--model", "m", "--cwd", dir, "--no-stream", "--sandbox"], {
    env: childEnv,
    stdio: how === "fd" ? ["ignore", "ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
  });
  if (how === "fd") {
    const feed = child.stdio[3] as import("node:stream").Duplex;
    feed.on("error", () => {}); // a CLI that died early is reported below, with its stderr
    feed.end(payload);
  }
  let err = "";
  child.stderr?.on("data", (d) => (err += d));
  const code = await new Promise<number>((r) => child.on("exit", (c) => r(c ?? -1)));
  const seenFile = join(dir, "seen.txt");
  assert.ok(existsSync(seenFile), `the worker's command did not run (exit ${code}): ${err.slice(0, 500)}`);
  return { seen: readFileSync(seenFile, "utf8"), auth };
}

describe("a worker of Maat's own user", { skip: !posix }, () => {
  for (const how of ["fd", "file"] as const) {
    it(`finds no key in its env or any ancestor's argv/environ when keys come by ${how === "fd" ? "MAAT_KEYS_FD" : "MAAT_KEYS_FILE"}`, async () => {
      const key = marker();
      const { seen, auth } = await workerSees(how, key);
      // Maat had the key: it sent it to the provider.
      assert.ok(auth.some((a) => a.includes(key)), "Maat never used the key it was given");
      assert.ok(seen.includes("PATH="), "the probe read nothing");
      assert.ok(!seen.includes(key), `a key reached the worker:\n${seen.split("\n").filter((l) => l.includes(key)).join("\n")}`);
    });
  }

  it("finds no key in its own env when keys come the old way, by environment", async () => {
    const key = marker();
    const { seen } = await workerSees("env", key);
    const [own = "", ancestors = ""] = seen.split("== ancestors ==");
    assert.ok(own.includes("PATH="), "the probe read nothing");
    assert.ok(!own.includes(key), "an env-delivered key reached the worker's own environment");
    // Maat's exec environment still holds it on Linux (the kernel keeps the
    // copy it was started with): exactly why MAAT_KEYS_FD exists.
    if (linux) assert.ok(ancestors.includes(key), "expected /proc/$PPID/environ to still hold an env-delivered key");
  });
});
