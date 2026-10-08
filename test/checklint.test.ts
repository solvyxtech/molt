/**
 * Seal-time lint for drafted checks (src/checklint.ts): each rule fires on the
 * shape the check-quality replay found and stays quiet on the sound neighbour;
 * a failing check is sent back once and dropped if the redraft fails too; and
 * drafted checks run under bash.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { countArgs, lintAll, pythonDefs, readTree, type LintCtx } from "../src/checklint.js";
import { draftCriteriaCritiqued } from "../src/criteria.js";

// The seal-time lint is opt-in (MAAT_CHECK_LINT=1); these tests exercise it.
process.env.MAAT_CHECK_LINT = "1";
import { bashPath, draftedShell, runCommand } from "../src/run.js";
import { workspace } from "./helpers.js";

// A machine like the bench image: no pytest, no `python`, mawk without {n}.
const IMAGE = new Set(["python3", "git", "sh", "bash", "awk", "grep", "curl", "kill", "pkill", "sleep", "perl"]);
const probes = { hasCommand: (n: string) => IMAGE.has(n), hasPyModule: () => false, awkIntervals: () => false };

function project(files: Record<string, string>, git = false): { dir: string; cleanup: () => void } {
  const ws = workspace();
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(ws.dir, name, ".."), { recursive: true });
    writeFileSync(join(ws.dir, name), body);
  }
  if (git) mkdirSync(join(ws.dir, ".git"));
  return ws;
}

const ctx = (over: Partial<LintCtx> = {}): LintCtx => ({ task: "Write wc.py that counts words in words.txt", shell: "sh", probes, ...over });
const rules = (run: string, c: LintCtx = ctx()): string[] => lintAll(run, c).map((h) => h.rule.split(":")[0]!);

describe("check lint: shell and tool bugs", () => {
  it("L3 job control under sh, fine under bash; pkill -f matching itself", () => {
    const run = "python3 server.py & sleep 1 && curl -s localhost:8000 | grep -q ok; kill %1";
    assert.deepEqual(rules(run), ["L3-jobcontrol"]);
    assert.deepEqual(rules(run, ctx({ shell: "bash" })), []);
    assert.deepEqual(rules("fg"), ["L3-jobcontrol"]);
    assert.deepEqual(rules("pkill -f 'python3 server.py'; python3 server.py & sleep 1; pkill -f 'python3 server.py'"), ["L3-pkill-self"]);
    assert.deepEqual(rules("pkill -f 'server.py'"), [], "the pattern is not in the rest of the command");
  });

  it("L1 a tool or module that is not installed", () => {
    assert.deepEqual(rules("python3 -m pytest -q test_x.py"), ["L1-pytest"]);
    assert.deepEqual(rules("python3 -m pytest -q", ctx({ probes: { ...probes, hasPyModule: (m) => m === "pytest" } })), []);
    assert.deepEqual(rules("python -c 'print(1)'"), ["L1-python"]);
    assert.deepEqual(rules("python3 -c 'import yaml; yaml.safe_load(open(\"a.yml\"))'"), ["L1-module"]);
    assert.deepEqual(rules("python3 -m unittest -q"), []);
  });

  it("L2 git where there is no repository", () => {
    const ws = project({ "a.txt": "x" });
    const repo = project({ "a.txt": "x" }, true);
    try {
      assert.deepEqual(rules("git diff --quiet HEAD", ctx({ cwd: ws.dir })), ["L2-git-norepo"]);
      assert.deepEqual(rules("git diff --quiet HEAD", ctx({ cwd: repo.dir })), []);
      assert.deepEqual(rules("git diff --quiet HEAD", ctx({ cwd: ws.dir, task: "Commit the change with git" })), []);
    } finally {
      ws.cleanup();
      repo.cleanup();
    }
  });

  it("L4 single-quoted substitution, L5 unquoted grep words, L6 test on a literal", () => {
    assert.deepEqual(rules("git log | grep -q '^$(git rev-parse HEAD)'"), ["L4-quoted-subst"]);
    assert.deepEqual(rules('grep -q "$(cat want.txt)" out.txt'), []);
    assert.deepEqual(rules("make | grep -q nothing to be done"), ["L5-grep-unquoted"]);
    assert.deepEqual(rules("make | grep -q 'nothing to be done'"), []);
    assert.deepEqual(rules('test -z "git status --porcelain"'), ["L6-test-literal"]);
    assert.deepEqual(rules('test -z "$(git status --porcelain)"'), []);
  });

  it("L7 regex dialects: \\d, {n} under mawk, + in a basic regex", () => {
    assert.deepEqual(rules("grep -qE '\\d+' out.txt"), ["L7-backslash-d"]);
    assert.deepEqual(rules("grep -qE '[0-9]+' out.txt"), []);
    assert.deepEqual(rules("echo 1.00 | awk '/\\.[0-9]{2}$/'"), ["L7-mawk-interval"]);
    assert.deepEqual(rules("echo 1.00 | awk '/\\.[0-9]{2}$/'", ctx({ probes: { ...probes, awkIntervals: () => true } })), []);
    assert.deepEqual(rules("grep -q 'a+b' out.txt"), ["L7-bre-plus"]);
    assert.deepEqual(rules("grep -qE 'a+b' out.txt"), []);
  });

  it("L8 bashisms under sh only", () => {
    assert.deepEqual(rules("[[ -f out.txt ]] && echo ok"), ["L8-bashism"]);
    assert.deepEqual(rules("[[ -f out.txt ]] && echo ok", ctx({ shell: "bash" })), []);
    assert.deepEqual(rules("[ -f out.txt ] && echo ok"), []);
  });

  it("L9 the shapes the bar itself refuses when they pass", () => {
    assert.deepEqual(rules("grep -q x out.txt || exit 0"), ["L9-swallows-exit"]);
    assert.deepEqual(rules("python3 check.py || true"), ["L9-swallows-exit"]);
    assert.deepEqual(rules("rm -f /tmp/x || true; grep -q x out.txt"), []);
    assert.deepEqual(rules("python3 -m unittest discover | grep -q OK"), ["L9-pipe-no-pipefail"]);
    assert.deepEqual(rules("set -o pipefail; python3 -m unittest discover | grep -q OK"), []);
  });

  it("L11 an absolute path outside the project", () => {
    assert.deepEqual(rules("python3 /app/server.py"), ["L11-abs"]);
    assert.deepEqual(rules("python3 /app/server.py", ctx({ task: "run /app/server.py" })), []);
    assert.deepEqual(rules("test -f /tmp/x && /usr/bin/env true"), []);
  });

  it("L15 a check that performs the work", () => {
    assert.deepEqual(rules("git checkout -q main && grep -q x a.txt", ctx({ task: "fix the page" })), ["L15-mutates"]);
    // No wording in the task excuses it: "merge the branch" is what the work must do.
    assert.deepEqual(rules("git checkout -q main", ctx({ task: "merge the branch" })), ["L15-mutates"]);
    assert.deepEqual(rules("git log --oneline | grep -q merge", ctx({ task: "merge the branch" })), []);
  });
});

describe("check lint: invented interfaces, read off the untouched project", () => {
  const files = {
    "pairs.py": "def find_pairs(nums, target):\n    return []\n\ndef parse(s, base=10, *, strict=False):\n    return s\n\nclass A:\n    def m(self, x):\n        return x\n",
    "words.txt": "alpha beta\n",
  };

  it("parses python signatures", () => {
    const d = pythonDefs(files["pairs.py"], "pairs.py");
    assert.deepEqual([d.get("find_pairs")![0]!.req, d.get("find_pairs")![0]!.max], [2, 2]);
    assert.deepEqual([d.get("parse")![0]!.req, d.get("parse")![0]!.max], [1, 3]);
    assert.equal(d.has("m"), false, "methods are skipped");
    assert.equal(countArgs("[1,(2,3)], 'a,b', f(x))"), 3);
    assert.equal(countArgs(")"), 0);
  });

  it("L12 call arity against the pristine def, with the signature in the reason", () => {
    const ws = project(files);
    try {
      const c = ctx({ cwd: ws.dir, tree: readTree(ws.dir) });
      const hit = lintAll("python3 -c 'from pairs import find_pairs; print(find_pairs([1,2,3]))'", c);
      assert.equal(hit[0]!.rule, "L12-arity:find_pairs(1)");
      assert.match(hit[0]!.why, /calls find_pairs with 1 argument; pairs\.py defines find_pairs\(nums, target\)/);
      assert.deepEqual(rules("python3 -c 'from pairs import find_pairs; print(find_pairs([1,2,3], 4))'", c), []);
      assert.deepEqual(rules("python3 -c 'from pairs import parse; parse(\"1\", strict=True)'", c), [], "keyword-only parameters are counted");
    } finally {
      ws.cleanup();
    }
  });

  it("L13 a string literal handed to a project function that is nowhere in the task or tree", () => {
    const ws = project({ ...files, "price.py": "def price(item):\n    return {'apple': 1}[item]\n" });
    try {
      const c = ctx({ cwd: ws.dir, tree: readTree(ws.dir) });
      assert.equal(rules("python3 -c \"from price import price; print(price('item1'))\"", c)[0], "L13-input");
      assert.deepEqual(rules("python3 -c \"from price import price; print(price('apple'))\"", c), []);
      assert.deepEqual(rules("python3 -c \"from price import price; price('item1')\" 2>&1 | grep -q Error", c), [], "a check that expects an error is left alone");
    } finally {
      ws.cleanup();
    }
  });
});

describe("check lint in drafting: sent back once, then dropped", () => {
  type Msgs = { messages: { role: string; content: string }[] };
  function drafter(script: { first: string; redraft: string; critic?: string }) {
    const asked: string[] = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Msgs;
      const system = body.messages[0]!.content;
      const prompt = body.messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n");
      const kind = system.startsWith("You review acceptance checks") ? "critic" : prompt.includes("was dropped:") ? "redraft" : "first";
      asked.push(kind);
      const content =
        kind === "critic"
          ? (script.critic ?? JSON.stringify({ checks: [], uncovered: [], requirements: [] }))
          : kind === "redraft"
            ? script.redraft
            : script.first;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchFn, asked };
  }
  const base = { scripts: [], barChecks: [], baseUrl: "http://p.test/v1", model: "m", task: "Write wc.py that counts the words in words.txt" };
  const draft = (...checks: [string, string][]) => JSON.stringify({ checks: checks.map(([name, run]) => ({ name, run })), notes: [] });
  const GOOD = ["counts", "python3 wc.py words.txt | grep -qx '3 words'"] as [string, string];
  const BAD = ["server-up", "python3 server.py & sleep 1; curl -s localhost:9 | grep -q ok || exit 0"] as [string, string];

  it("a failing check is redrafted once with the reason, and the replacement is sealed", async () => {
    const ws = project({ "words.txt": "a b c\n" });
    try {
      const { fetchFn, asked } = drafter({ first: draft(GOOD, BAD), redraft: draft(["server-up", "python3 server.py & sleep 1; set -o pipefail; curl -s localhost:9 | grep -q ok"]) });
      const progress: string[][] = [];
      const r = await draftCriteriaCritiqued({ ...base, cwd: ws.dir, fetchFn, onProgress: (d) => progress.push(d.checks.map((c) => c.name)) });
      assert.ok(r.ok);
      assert.deepEqual(asked.filter((k) => k !== "critic"), ["first", "redraft"], "one redraft, no more");
      assert.deepEqual(r.draft.checks.map((c) => c.name), ["counts", "server-up"]);
      assert.ok(!r.draft.checks.some((c) => c.run.includes("|| exit 0")));
      assert.equal(r.lint?.length, 1);
      assert.equal(r.lint![0]!.rule, "L9-swallows-exit");
      assert.deepEqual(progress[0], ["counts"], "what passed the lint is ready while the redraft is asked");
      assert.ok(r.critique.some((l) => /dropped server-up .* before sealing/.test(l)));
      assert.ok(r.critique.some((l) => /redrafted for the dropped checks: server-up/.test(l)));
    } finally {
      ws.cleanup();
    }
  });

  it("a redraft that fails the lint too is dropped and never sealed; the journal gets it via `lint`", async () => {
    const ws = project({ "words.txt": "a b c\n" });
    try {
      const { fetchFn, asked } = drafter({ first: draft(GOOD, BAD), redraft: draft(["again", "python3 wc.py words.txt || true"]) });
      const r = await draftCriteriaCritiqued({ ...base, cwd: ws.dir, fetchFn });
      assert.ok(r.ok);
      assert.deepEqual(asked.filter((k) => k === "redraft").length, 1);
      assert.deepEqual(r.draft.checks.map((c) => c.name), ["counts"]);
      assert.deepEqual(r.lint!.map((l) => [l.name, l.redraft]), [["server-up", false], ["again", true]]);
    } finally {
      ws.cleanup();
    }
  });

  it("when every check fails, nothing is sealed (and the redraft prompt carries the reasons)", async () => {
    const ws = project({ "words.txt": "a b c\n" });
    try {
      const prompts: string[] = [];
      const inner = drafter({ first: draft(BAD), redraft: draft(BAD) });
      const fetchFn = (async (u: string, init?: RequestInit) => {
        prompts.push(String(init?.body));
        return inner.fetchFn(u, init);
      }) as unknown as typeof fetch;
      const r = await draftCriteriaCritiqued({ ...base, cwd: ws.dir, fetchFn });
      assert.ok(r.ok);
      assert.deepEqual(r.draft.checks, []);
      assert.match(prompts.find((p) => p.includes("was dropped:"))!, /exits 0 whatever happened/);
    } finally {
      ws.cleanup();
    }
  });

  it("clean drafts cost no extra request", async () => {
    const ws = project({ "words.txt": "a b c\n" });
    try {
      const { fetchFn, asked } = drafter({ first: draft(GOOD), redraft: "{}", critic: JSON.stringify({ checks: [{ name: "counts", verdict: "runs", quote: "" }], uncovered: [], requirements: [] }) });
      const r = await draftCriteriaCritiqued({ ...base, cwd: ws.dir, fetchFn });
      assert.ok(r.ok);
      assert.deepEqual(asked, ["first", "critic"]);
      assert.equal(r.lint, undefined);
      assert.deepEqual(r.draft.checks.map((c) => c.name), ["counts"]);
    } finally {
      ws.cleanup();
    }
  });
});

describe("drafted checks run under bash", { skip: bashPath() === null }, () => {
  it("only hidden, task-tagged checks get bash; a person's check keeps sh", () => {
    assert.equal(draftedShell({ hidden: true, tags: ["task"] }), bashPath());
    assert.equal(draftedShell({ hidden: true, tags: ["mission"] }), true);
    assert.equal(draftedShell({ tags: ["task"] }), true);
  });

  it("job control works there: `kill %1` after a background job", async () => {
    const ws = workspace();
    try {
      const run = "sleep 30 & kill %1 && echo killed";
      const r = await runCommand(run, { cwd: ws.dir, timeoutMs: 10_000, shell: bashPath()! });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /killed/);
    } finally {
      ws.cleanup();
    }
  });
});
