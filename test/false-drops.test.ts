/**
 * Drafted checks Maat dropped before sealing that it should have kept.
 *
 * bench/local/drop_audit.py read every drop line of the 2026-10-07 lanes and
 * ran each dropped command on the task's pristine tree and on the finished
 * tree. The classes it found wrong, each tested here with the commands the
 * judges really drafted, next to the true drops of the same rule:
 *  - the absolute-path rule read a sed program's `/g` and a value glued onto
 *    `sys.argv[1] +` as paths (all 4 of its drops);
 *  - the trial called `./rotate.sh` before rotate.sh existed "not found",
 *    though a missing deliverable is what a check is meant to find (6);
 *  - the mutation rule read `touch -d DATE file`'s DATE as a file it creates,
 *    and lost track of `f="$d/…"` and `> "$(mktemp -d)/x"` (14);
 *  - the cannot-fail rule read `… || exit 1; done; exit 0` and
 *    `… && exit 1 || exit 0` as checks that exit 0 whatever happened (3);
 *  - a check tried before the work that named the project by its absolute
 *    path read the live folder, not the copy it was supposed to be tried on;
 *  - and checks that pass before the work (P1) are kept as refuse-only
 *    guards instead of thrown away.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cannotFail } from "../src/checklint.js";
import { checkMutates } from "../src/checkwrites.js";
import {
  CRITERIA_MAX_CHECKS,
  draftCriteriaCritiqued,
  guardsFrom,
  missingDeliverable,
  pinsCurrentValue,
  preflightCriteria,
  sanitizeCriteria,
  strayPath,
  taskChecksFrom,
  type LintDrop,
} from "../src/criteria.js";
import { swallowsExit } from "../src/evidence.js";
import { absolutePathArgs, parseShell } from "../src/shellwords.js";
import { runCheck, type BarContext } from "../src/bar.js";
import { replaceCommandPaths, replacePathPrefix } from "../src/scratch.js";
import { Engine } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import { Receipts } from "../src/receipts.js";
import { tierOf } from "../src/tiers.js";
import type { Check, CheckAuthor } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace, type ScriptedTurn } from "./helpers.js";

const JUDGE: CheckAuthor = { kind: "judge", model: "judge-j" };

describe("the absolute-path rule reads what programs open, not the raw text", () => {
  const stray = (run: string, task = "") => strayPath(run, { cwd: "/work/proj", task });

  it("keeps the 2026-10-07 differential checks it dropped", () => {
    // wc-tool, three times: `/g` is sed's flag inside its program.
    const wc = [
      String.raw`d=$(mktemp -d); printf 'a b\nc d e\n' > $d/a; printf 'h\xc3\xa9llo  world\nx' > $d/b; python3 wc.py $d/a $d/b > $d/out && wc $d/a $d/b | sed 's/^ *//; s/  */ /g' | diff - $d/out`,
      String.raw`d=$(mktemp -d); printf 'one two\nthree\n' > $d/a; python3 wc.py $d/a > $d/out && wc $d/a | sed 's/^ *//; s/  */ /g' | diff - $d/out`,
      String.raw`d=$(mktemp -d); printf 'a b\nc\n\n' | python3 wc.py > $d/out && printf 'a b\nc\n\n' | wc | sed 's/^ *//; s/  */ /g' | diff - $d/out`,
    ];
    for (const run of wc) assert.equal(stray(run), null, run);
    // refactor-pricing: a Python file built with printf; "/old.py" is glued onto sys.argv[1].
    const pricing =
      `d=$(mktemp -d) && git show HEAD:pricing.py > $d/old.py && printf '%s\\n' 'import sys,importlib.util as u' 'sys.path.insert(0,".")' 'import pricing as n' ` +
      `'s=u.spec_from_file_location("o",sys.argv[1]+"/old.py");o=u.module_from_spec(s);s.loader.exec_module(o)' > $d/t.py && python3 $d/t.py $d`;
    assert.equal(stray(pricing), null);
  });

  it("still finds the invented paths it was written for", () => {
    assert.equal(stray("python3 /wc.py words.txt"), "/wc.py");
    assert.equal(stray("cat /home/user/data.csv | wc -l"), "/home/user/data.csv");
    assert.equal(stray("python3 /app/server.py & sleep 1; curl -s localhost:8000/"), "/app/server.py");
    assert.equal(stray(`python3 -c "import csv; rows = list(csv.reader(open('/home/user/data.csv')))"`), "/home/user/data.csv");
    assert.equal(stray("python3 - <<'EOF'\nprint(open('/data/in.txt').read())\nEOF"), "/data/in.txt");
    assert.equal(stray("python3 wc.py words.txt > /home/user/out.txt"), "/home/user/out.txt");
    assert.equal(stray("OUT=/srv/report.txt python3 report.py"), "/srv/report.txt");
    assert.equal(stray("python3 report.py --out=/srv/report.txt"), "/srv/report.txt");
    assert.equal(stray("diff <(python3 wc.py /home/u/a) expected.txt"), "/home/u/a");
    assert.equal(stray("bash -c 'cat /home/u/a'"), "/home/u/a");
    assert.equal(stray("sed -n 1p /home/u/a.txt"), "/home/u/a.txt", "sed's file operand is a path; its program is not");
    assert.equal(stray("awk -f /home/u/prog.awk data.txt"), "/home/u/prog.awk");
    assert.equal(stray("grep -q x /home/u/log"), "/home/u/log");
    assert.equal(stray("test -s /home/u/out.txt"), "/home/u/out.txt");
  });

  it("does not read programs, patterns and data as paths", () => {
    const fine = [
      "awk -F/ '/^\\/usr/ {print $2}' paths.txt",
      "grep -E '^/api/v1' routes.txt",
      "grep -e /etc/passwd -q notes.txt",
      "jq -e '.path == \"/srv/x\"' out.json",
      "echo /home/user/x | python3 norm.py",
      "printf '/a/b\\n/c/d\\n' | python3 dedupe.py",
      "find . -path '/proc/*' -prune -o -name '*.py' -print",
      `[ "$(python3 norm.py a//b)" = "/a/b" ]`,
      "tr '/' '_' < in.txt",
      `python3 -c "import os; print(os.path.join('a', 'b') + '/c')"`,
      "cut -d/ -f2 paths.txt",
      "cat <<EOF > in.txt\n/home/user/x\nEOF\npython3 norm.py in.txt",
    ];
    for (const run of fine) assert.equal(stray(run), null, run);
  });

  it("parses words, quotes, substitutions and redirects", () => {
    const [c] = parseShell(`x="$(mktemp -d)/a b" 2>/dev/null >> 'o u t' cmd 'it''s' "q\\"x"`);
    assert.deepEqual(c!.words.map((w) => w.value), ["x=\u0001/a b", "cmd", "its", 'q"x']);
    assert.deepEqual(c!.redirects.map((r) => [r.op, r.target.value]), [[">", "/dev/null"], [">>", "o u t"]]);
    assert.deepEqual(c!.words[0]!.substs, ["mktemp -d"]);
    assert.deepEqual(parseShell("a && b || c; d | e & f\ng").map((x) => x.words[0]!.value), ["a", "b", "c", "d", "e", "f", "g"]);
    assert.deepEqual(absolutePathArgs("cat /a/b 2>&1 >&2 | sed 's/x/y/g' /c/d"), ["/a/b", "/c/d"]);
  });
});

describe("a check of a script the work creates is not 'not found'", () => {
  it("the trial reads a missing project script as the deliverable missing", async () => {
    const ws = workspace();
    try {
      mkdirSync(join(ws.dir, "data"));
      // bash-backup, 2026-10-07: dropped as "the command was not found".
      const run = "BACKUP_NOW=20230101-120000 ./backup.sh data backup_dest 2 && test -f backup_dest/backup-20230101-120000.tar.gz";
      const failed: string[] = [];
      const broken = await preflightCriteria([{ name: "backup-script-works", kind: "command", run, expectExit: 0 }], { cwd: ws.dir, failed, stray: { task: "Write backup.sh" } });
      assert.deepEqual(broken, []);
      assert.deepEqual(failed, ["backup-script-works"]);
      // A tool the machine does not have is still broken.
      const tool = await preflightCriteria([{ name: "t", kind: "command", run: "no-such-tool-xyz data", expectExit: 0 }], { cwd: ws.dir });
      assert.deepEqual(tool.map((b) => b.why), ["the command was not found, so nothing ran and nothing was established"]);
      // So is a script the project has but cannot run.
      writeFileSync(join(ws.dir, "present.sh"), "exit 0\n");
      assert.equal(missingDeliverable("bash: line 1: ./present.sh: No such file or directory\n", ws.dir), null);
    } finally {
      ws.cleanup();
    }
  });
});

describe("the mutation rule", () => {
  it("keeps checks that only write into their mktemp directory", () => {
    const fine = [
      // bash-rotate, 2026-10-07: touch -d's DATE read as a file the check creates.
      `d=$(mktemp -d); for i in 1 2 3 4 5 6 7; do touch -d "2020-01-0$i" "$d/f$i.log"; done; ./rotate.sh "$d" >/dev/null && test $(ls "$d" | wc -l) -eq 5`,
      `d=$(mktemp -d); for i in 1 2 3 4 5 6 7; do touch -d "@$((1000000000+i*100))" "$d/f $i.log"; done; touch -d @1 "$d/x.txt"; out=$(./rotate.sh "$d") && [ "$out" = "$(printf 'f 1.log\\nf 2.log')" ]`,
      `d=$(mktemp -d); o=$(mktemp); touch -d '2020-01-01' "$d/old one.log"; ./rotate.sh "$d" > "$o"`,
      `dir=$(mktemp -d) && for f in $(seq 1 8); do touch -d "-$f days" "$dir/$f.log"; done && ./rotate.sh -n 5 "$dir"`,
      "d=$(mktemp -d); touch -t 202001010000 \"$d/a.log\"; touch -r \"$d/a.log\" \"$d/b.log\"; mkdir -m 700 \"$d/sub\"",
      // A variable built on the mktemp directory.
      `d=$(mktemp -d); for i in 1 2 3 4 5 6 7; do f="$d/f $i.log"; echo x > "$f"; touch -d "@$((1000+i))" "$f"; done; ./rotate.sh "$d"`,
      `bash -c 'd=$(mktemp -d); for i in 1 2 3 4; do f="$d/a$i.log"; echo x>"$f"; done; ./rotate.sh -n 2 "$d"'`,
      // node-summarize: a redirect straight into a mktemp directory.
      `node summarize.js transactions.json > "$(mktemp -d)/out.json" && node summarize.js transactions.json | jq -e 'keys | length > 0'`,
    ];
    for (const run of fine) assert.equal(checkMutates(run), null, run);
  });

  it("still refuses the checks that change the work", () => {
    const writes: [string, RegExp][] = [
      ["git checkout master && git merge --no-ff -m 'Merge about page changes' about.md", /git checkout/],
      ["mkdir -p test_src && echo 'test content' > test_src/file.txt && ./backup.sh test_src test_dest 1", /creates test_src/],
      ["make && touch src/x.md && make | grep -q 'out/x.txt'", /creates src\/x\.md/],
      ["echo 'not json' > bad.json && node summarize.js bad.json 2>&1 | grep -q 'Error'", /bad\.json/],
      ["test -f wc.py && chmod +x wc.py", /permissions on wc\.py/],
      ["./rotate.sh -n 3 2>err.txt && exit 1 || test $? -eq 2", /err\.txt/],
      ["touch -d 2020-01-01 old.log && ./rotate.sh .", /creates old\.log/],
      ["f=out.txt; echo x > \"$f\"", /writes to \$f/],
      ["cp items.json /tmp/items.bak && python3 server.py 8080 & sleep 1; cp /tmp/items.bak items.json", /writes items\.json/],
    ];
    for (const [run, why] of writes) assert.match(checkMutates(run) ?? "", why, run);
  });
});

describe("the cannot-fail rule", () => {
  it("keeps a check whose earlier `exit 1` can still fail it", () => {
    const fine = [
      // config-migrate, 2026-10-07.
      `for f in configs/*.json; do git show HEAD:"$f" 2>/dev/null | jq -e '.version==2' >/dev/null 2>&1 && { git diff --quiet HEAD -- "$f" || exit 1; }; done; exit 0`,
      `for f in configs/*.json; do jq -e '.version==1' "$f" >/dev/null 2>&1 && { jq -e '.database.port==5432' "$f" >/dev/null || exit 1; }; done; exit 0`,
      // redact-secrets: `cond && exit 1 || exit 0` is `! cond`.
      String.raw`find . -type f -not -path './.maat/*' -exec grep -l 'AKIA\|ghp_' {} \; | xargs -I {} sh -c 'grep -q "\[REDACTED\]" {} && echo "OK" || echo "FAIL"' | grep -q "FAIL" && exit 1 || exit 0`,
    ];
    for (const run of fine) {
      assert.equal(swallowsExit(run), null, run);
      assert.equal(cannotFail(run), null, run);
    }
  });

  it("still drops the checks that cannot fail", () => {
    const never = [
      "git log --oneline -n 1 | grep -q 'master' && ./check.sh || true",
      "python3 ledger.py journal.txt 2>&1 | grep -q 'line 10:' || echo 'PASS'",
      String.raw`find configs/ -name '*.json' -exec sh -c 'jq -e ".version == 2" {} 2>/dev/null || exit 1' \;`,
      "grep -q x out.txt; exit 0",
      "grep -q x out.txt && false || true",
      "(grep -q x a || exit 1); grep -q y b; exit 0",
      "sh -c 'grep -q x a || exit 1'; exit 0",
      `python3 -c "import csv; h = next(csv.reader(open('clean.csv'))); print('PASS' if len(h) == 5 else 'FAIL')"`,
    ];
    for (const run of never) assert.ok(cannotFail(run), run);
  });
});

describe("a check names the project by its absolute path", () => {
  it("is tried on the copy before the work, not on the live folder", async () => {
    const live = workspace();
    const pre = workspace();
    try {
      // The worker has already written out.txt in the live folder; the pre-work copy has not.
      writeFileSync(join(live.dir, "out.txt"), "3\n");
      const run = `cd ${live.dir} && grep -qx 3 out.txt`;
      const passed: string[] = [];
      const failed: string[] = [];
      await preflightCriteria([{ name: "counts", kind: "command", run, expectExit: 0 }], { cwd: pre.dir, root: live.dir, passed, failed });
      assert.deepEqual([passed, failed], [[], ["counts"]]);
    } finally {
      live.cleanup();
      pre.cleanup();
    }
  });

  it("only paths the shell opens are pointed at the copy, never the project path inside data", () => {
    assert.equal(replaceCommandPaths("cd /app && grep -q 'root /app/public;' nginx.conf", "/app", "/tmp/c"), "cd /tmp/c && grep -q 'root /app/public;' nginx.conf");
    assert.equal(replaceCommandPaths(`jq -e '.out_dir == "/app/out"' /app/config.json`, "/app", "/tmp/c"), `jq -e '.out_dir == "/app/out"' /tmp/c/config.json`);
    assert.equal(replaceCommandPaths("grep -q 'WORKDIR /app' Dockerfile", "/app", "/tmp/c"), "grep -q 'WORKDIR /app' Dockerfile");
    assert.equal(replaceCommandPaths("cat /app/a.txt > /app/b.txt", "/app", "/tmp/c"), "cat /tmp/c/a.txt > /tmp/c/b.txt");
  });

  it("a check whose data quotes the project path passes before the work when the data is already there (P1, not discriminating)", async () => {
    const live = workspace();
    const pre = workspace();
    try {
      writeFileSync(join(pre.dir, "nginx.conf"), `root ${live.dir}/public;\n`);
      const passed: string[] = [];
      const failed: string[] = [];
      await preflightCriteria([{ name: "root-kept", kind: "command", run: `grep -q 'root ${live.dir}/public;' nginx.conf`, expectExit: 0 }], { cwd: pre.dir, root: live.dir, passed, failed });
      assert.deepEqual([passed, failed], [["root-kept"], []]);
    } finally {
      live.cleanup();
      pre.cleanup();
    }
  });

  it("runs in the bar's copy, so it cannot write the work", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "a.txt"), "a\n");
      const ctx = { cwd: ws.dir, record: [], ledger: [], archivedBatches: 0 } as unknown as BarContext;
      const r = await runCheck(
        { name: "task:abs", kind: "command", run: `cd ${ws.dir} && touch made-by-check && grep -q a ${ws.dir}/a.txt`, timeoutMs: 5_000, expectExit: 0, tags: ["task"], hidden: true },
        ctx,
      );
      assert.equal(r.ok, true, r.output);
      assert.equal(existsSync(join(ws.dir, "made-by-check")), false);
    } finally {
      ws.cleanup();
    }
  });

  it("only a whole path is rewritten", () => {
    assert.equal(replacePathPrefix("cd /w/p && cat /w/p/a /w/p2/b /x/w/p", "/w/p", "/tmp/c"), "cd /tmp/c && cat /tmp/c/a /w/p2/b /x/w/p");
  });
});

describe("checks that pass before the work are kept as refuse-only guards", () => {
  const drop = (name: string, run: string, rule = "P1-passes-before-work"): LintDrop => ({ name, run, rule, why: "", redraft: false });

  it("keeps fix-git's invariants and leaves out the checks that pin today's output", () => {
    // Dropped by P1 on 2026-10-07 (mmsj-1 fix-git): each must still hold after a correct merge.
    const invariants = [
      drop("no-unmerged-branches", `test -z "$(git branch --no-merged master | tr -d ' *')"`),
      drop("on-master-clean-tree", `test "$(git rev-parse --abbrev-ref HEAD)" = master && test -z "$(git status --porcelain -- . ':!.maat')"`),
      drop("no-conflict-markers", "! grep -qE '^(<<<<<<<|>>>>>>>)' about.md index.md"),
    ];
    // Dropped by P1 the same day, and failed on a finished tree the grader accepted.
    const pins = [
      drop("script-works", `node summarize.js transactions.json | jq -e '.zoe == "-3.50" and .amy == "0.00" and .max == "12.50"'`),
      drop("schema-version-1", "sqlite3 app.db 'PRAGMA user_version;' | grep -q '^1$'"),
      drop("cache-module-exists", "test -f cache.py && echo 'cache.py exists'"),
      drop("basic", `node csv2json.js < sample.csv | jq -e '[.[] | keys | sort] | unique | length == 1 and .[0] == ["id", "name", "comment"]'`),
    ];
    for (const p of pins) assert.ok(pinsCurrentValue(p.run), p.run);
    for (const p of invariants) assert.equal(pinsCurrentValue(p.run), false, p.run);
    // Invariants that compare with nothing or zero, and inputs the check makes itself, are not pins.
    assert.equal(pinsCurrentValue("python3 slugify.py < titles.txt | sort | uniq -d | wc -l | grep -q '^0$'"), false);
    assert.equal(pinsCurrentValue(`echo -e 'id,name\\n1,foo' | node csv2json.js | jq -e '.[0].id == "1"'`), false);
    const kept = guardsFrom([...invariants, ...pins, drop("lint", "git checkout master", "L15-mutates")], [{ name: "merged", run: "git merge-base --is-ancestor feature master" }]);
    assert.deepEqual(kept.map((g) => [g.name, g.guard]), invariants.map((d) => [d.name, true]));
    // A duplicate of a sealed check, or of another guard, is not kept twice; a name clash is renamed.
    const again = guardsFrom([invariants[0]!, invariants[0]!, drop("merged", "test -z \"$(git status --porcelain)\"")], [{ name: "merged", run: "true" }]);
    assert.deepEqual(again.map((g) => g.name), ["no-unmerged-branches", "merged-2"]);
  });

  it("are sealed with the guard tag, beside the checks and outside their cap", () => {
    const checks = Array.from({ length: CRITERIA_MAX_CHECKS }, (_, i) => ({ name: `c${i}`, run: `grep -q ${i} out.txt` }));
    const d = sanitizeCriteria({ checks: [...checks, { name: "g", run: "! grep -q '<<<<<<<' a.md", guard: true }], notes: [] });
    assert.equal(d.checks.length, CRITERIA_MAX_CHECKS + 1);
    const sealed = taskChecksFrom(d, { hidden: true, author: JUDGE });
    assert.deepEqual(sealed.taskChecks.at(-1)!.tags, ["task", "guard"]);
    assert.ok(!sealed.taskChecks[0]!.tags.includes("guard"));
  });

  it("never count toward verified", () => {
    const value = (name: string, tags = ["task", "value"]) => ({ name, ok: true, kind: "command" as const, hidden: true, tags });
    const authors = new Map([["task:g", JUDGE], ["task:v", JUDGE]]);
    const guardOnly = tierOf({ results: [value("task:g", ["task", "value", "guard"])], worker: "w", authors });
    assert.notEqual(guardOnly.tier, "verified");
    assert.equal(tierOf({ results: [value("task:g", ["task", "value", "guard"]), value("task:v")], worker: "w", authors }).tier, "verified");
  });

  it("come out of the draft when the pre-work screen drops a check", async () => {
    const ws = workspace();
    const pre = workspace();
    try {
      for (const d of [ws.dir, pre.dir]) writeFileSync(join(d, "about.md"), "about\n");
      const draft = (...cs: [string, string][]) => JSON.stringify({ checks: cs.map(([name, run]) => ({ name, run })), notes: [] });
      const fetchFn = (async (_u: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
        const critic = body.messages[0]!.content.startsWith("You review acceptance checks");
        const redraft = body.messages.some((m) => m.content.includes("was dropped:"));
        const content = critic
          ? JSON.stringify({ checks: [], uncovered: [], requirements: [] })
          : redraft
            ? draft(["merged", "grep -q merged about.md"])
            : draft(["merged", "grep -q merged about.md"], ["no-markers", "! grep -q '^<<<<<<<' about.md"]);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }), text: async () => "" } as unknown as Response;
      }) as unknown as typeof fetch;
      const r = await draftCriteriaCritiqued({ scripts: [], barChecks: [], baseUrl: "http://p.test/v1", model: "m", task: "Merge the about page", cwd: ws.dir, preWorkDir: pre.dir, fetchFn });
      assert.ok(r.ok);
      assert.deepEqual(r.draft.checks.map((c) => [c.name, c.guard ?? false]), [["merged", false], ["no-markers", true]]);
      assert.ok(r.critique.some((l) => /refuse-only guards.*no-markers/.test(l)));
    } finally {
      ws.cleanup();
      pre.cleanup();
    }
  });

  describe("at the bar", () => {
    const work: ScriptedTurn[] = [{ calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] }, { text: "Done." }];
    const check = (name: string, run: string, guard = false): Check =>
      ({ name, kind: "command", run, timeoutMs: 5_000, expectExit: 0, tags: ["task", "value", ...(guard ? ["guard"] : [])], hidden: true, author: JUDGE }) as Check;

    async function turn(checks: Check[]) {
      const ws = workspace();
      try {
        writeFileSync(join(ws.dir, "keep.txt"), "keep\n");
        const provider = scriptedProvider([...work, ...work, ...work]);
        const journal = new Journal(ws.dir, "guard");
        const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, receipts: new Receipts(ws.dir), stream: false, autonomy: "high", journal });
        const events = await drain(engine.run("Write out.txt containing hello.", allowAll, { taskChecks: checks, taskNotes: [] }));
        const end = events.find((e) => e.kind === "job_end");
        assert.ok(end && end.kind === "job_end");
        const dir = join(ws.dir, ".maat", "receipts");
        const receipt = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
        return { end, receipt };
      } finally {
        ws.cleanup();
      }
    }

    it("a guard that holds says so and verifies nothing on its own", async () => {
      const { end, receipt } = await turn([check("hello", "grep -qx hello out.txt"), check("kept", "grep -qx keep keep.txt", true)]);
      assert.equal(end.outcome, "verified");
      assert.match(receipt, /role: refuse-only guard/);
      assert.match(receipt, /`kept: [^`]*` — written by .* · refuse-only guard/);
      assert.doesNotMatch(receipt, /`hello: [^`]*` — written by [^\n]*refuse-only/);
      const alone = await turn([check("kept", "grep -qx keep keep.txt", true)]);
      assert.notEqual(alone.end.outcome, "verified");
    });

    it("a guard that fails refuses the claim", async () => {
      const { end } = await turn([check("hello", "grep -qx hello out.txt"), check("untouched", "test ! -e out.txt", true)]);
      assert.notEqual(end.outcome, "verified");
    });
  });
});
