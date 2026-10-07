/**
 * The drafter and its critic see the project the worker sees, and a drafted
 * check that reaches outside the project is dropped before it is sealed.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { draftCriteria, draftCriteriaCritiqued, preflightCriteria, projectView, strayPath } from "../src/criteria.js";
import { workspace } from "./helpers.js";

function capturing(texts: string[]): { fetchFn: typeof fetch; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const fetchFn = (async (_u: string, init?: RequestInit) => {
    const msgs = (JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }).messages;
    prompts.push(msgs.filter((m) => m.role !== "system").map((m) => m.content).join("\n"));
    const content = texts[Math.min(i++, texts.length - 1)]!;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }), text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, prompts };
}

const base = { scripts: [], barChecks: [], baseUrl: "http://p.test/v1", model: "m" };

function project() {
  const ws = workspace();
  writeFileSync(join(ws.dir, "words.txt"), "alpha beta\ngamma\n");
  writeFileSync(join(ws.dir, "README.md"), "# demo\n");
  mkdirSync(join(ws.dir, "src"));
  return ws;
}

describe("the drafter's view of the project", () => {
  it("names the working directory, lists the project and profiles the input the task names", async () => {
    const ws = project();
    try {
      const { fetchFn, prompts } = capturing(['{"checks":[],"notes":[]}']);
      await draftCriteria({ ...base, task: "Write a tool that counts the words in words.txt", cwd: ws.dir, fetchFn });
      assert.ok(prompts[0]!.includes(`Working directory: ${ws.dir}`));
      assert.match(prompts[0]!, /Project files \(top level\): .*README\.md.*src\/.*words\.txt/);
      assert.match(prompts[0]!, /words\.txt: \d+ bytes/);
      assert.match(prompts[0]!, /first line: alpha beta/);
    } finally {
      ws.cleanup();
    }
  });

  it("is shown to the critic too", async () => {
    const ws = project();
    try {
      const draft = '{"checks":[{"name":"counts","run":"python3 wc.py words.txt | grep -q 3"}],"notes":[]}';
      const critique = '{"checks":[{"name":"counts","verdict":"runs","quote":""}],"uncovered":[],"requirements":[]}';
      const { fetchFn, prompts } = capturing([draft, critique]);
      const r = await draftCriteriaCritiqued({ ...base, task: "Write wc.py that counts the words in words.txt", cwd: ws.dir, fetchFn });
      assert.ok(r.ok);
      const criticPrompt = prompts.find((p) => p.startsWith("TASK TEXT:"))!;
      assert.ok(criticPrompt, "the critic was asked");
      assert.ok(criticPrompt.includes(`Working directory: ${ws.dir}`));
      assert.match(criticPrompt, /Project files \(top level\):.*words\.txt/);
      assert.match(criticPrompt, /first line: alpha beta/);
    } finally {
      ws.cleanup();
    }
  });

  it("states the relative-path rule in the instructions", async () => {
    const ws = project();
    try {
      let system = "";
      const fetchFn = (async (_u: string, init?: RequestInit) => {
        system = (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages[0]!.content;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"checks":[],"notes":[]}' }, finish_reason: "stop" }] }), text: async () => "" } as unknown as Response;
      }) as unknown as typeof fetch;
      await draftCriteria({ ...base, task: "t", cwd: ws.dir, fetchFn });
      assert.match(system, /Every path is relative to the working directory/);
    } finally {
      ws.cleanup();
    }
  });

  it("stays bounded however large the project is", () => {
    const ws = workspace();
    try {
      for (let i = 0; i < 200; i++) writeFileSync(join(ws.dir, `file-with-a-rather-long-name-${i}.csv`), `${"x".repeat(500)}\n`);
      const names = Array.from({ length: 30 }, (_, i) => `file-with-a-rather-long-name-${i}.csv`).join(" ");
      const view = projectView(`Read ${names}`, ws.dir);
      assert.ok(view.length < 4_200, `view is ${view.length} characters`);
      assert.ok(view.split("\n")[1]!.split(" ").length <= 40 + 5, "at most 40 listed entries");
      // Without a directory there is nothing to add.
      assert.equal(projectView("t", undefined), "");
    } finally {
      ws.cleanup();
    }
  });
});

describe("absolute paths in drafted checks", () => {
  it("strayPath finds paths outside the project and allows the legitimate ones", () => {
    const cwd = "/work/proj";
    const stray = (run: string, task = "") => strayPath(run, { cwd, task });
    assert.equal(stray("python3 /wc.py words.txt"), "/wc.py");
    assert.equal(stray("cat /home/user/data.csv | wc -l"), "/home/user/data.csv");
    assert.equal(stray("test -f '/Users/x/out.txt'"), "/Users/x/out.txt");
    // Allowed: devices, system tools, temp dirs, the project, relative paths.
    assert.equal(stray("python3 wc.py < words.txt > /dev/null 2>&1"), null);
    assert.equal(stray("/usr/bin/env python3 wc.py"), null);
    assert.equal(stray("/opt/homebrew/bin/jq . data.json"), null);
    assert.equal(stray('d=$(mktemp -d) && cp words.txt "$d/" && python3 wc.py "$d/words.txt"'), null);
    assert.equal(stray("echo hi > /tmp/out.txt"), null);
    assert.equal(stray("test -f /work/proj/out.txt"), null);
    assert.equal(stray("python3 ./wc.py src/a.py"), null);
    assert.equal(stray("python3 -c \"print(10 / 2, '/'.join(['a','b']))\""), null);
    assert.equal(stray("sed 's/a/b/' words.txt | awk '/gamma/ {print}'"), null);
    assert.equal(stray("curl -s http://localhost:8000/health"), null);
    assert.equal(stray("echo '<h1>x</h1>' > a.html && python3 n.py '*/15 9-17 * * *'"), null);
    assert.equal(stray("node summarize.js /nonexistent/file.json; test $? -eq 1"), null);
    // A path the task itself states is the person's, not an invention.
    assert.equal(stray("test -f /srv/out.txt", "Write the report to /srv/out.txt"), null);
  });

  it("preflight reports a stray path as broken only when asked to (drafted checks), without running it", async () => {
    const ws = project();
    try {
      const checks = [
        { name: "invented", kind: "command", run: "python3 /wc.py words.txt", expectExit: 0 },
        { name: "devnull", kind: "command", run: "test -f words.txt > /dev/null", expectExit: 0 },
        { name: "env", kind: "command", run: "/usr/bin/env true", expectExit: 0 },
        { name: "temp", kind: "command", run: 'd=$(mktemp -d); test -d "$d"', expectExit: 0 },
        { name: "relative", kind: "command", run: "test -f words.txt", expectExit: 0 },
      ];
      const broken = await preflightCriteria(checks, { cwd: ws.dir, stray: { task: "count the words in words.txt" } });
      assert.deepEqual(broken.map((b) => b.name), ["invented"]);
      assert.match(broken[0]!.why, /\/wc\.py.*outside the project/);
      // A person's own sealed check is not second-guessed.
      const own = await preflightCriteria([checks[0]!], { cwd: ws.dir });
      assert.ok(!own.some((b) => /outside the project/.test(b.why)));
    } finally {
      ws.cleanup();
    }
  });
});
