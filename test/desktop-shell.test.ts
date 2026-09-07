/**
 * The desktop shell's own checks.
 *
 * `npm test` is the engine's suite. These cover the window's IPC and chrome —
 * the parts that have never been run on two of the three platforms they ship
 * to, and that a green engine suite cannot see.
 */
import { nextWaitWord } from "../ui/wait-words.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { receiptBasename, resolveReceipt } from "../electron/receipts-path.js";
import { desktopSurfaces } from "../electron/theme-surfaces.js";
import { getTheme } from "../src/theme.js";
import { sessionOpenReject } from "../electron/session-open.js";
import { JOURNAL_IPC_CAP, barInitText, parseJournal, tailLines } from "../electron/limits.js";
import { taskChecksFrom } from "../electron/criteria.js";
import { runOptions, ceilingAsk, shouldRefreshPrice } from "../electron/run-options.js";
import {
  resolvePath,
  parseLoginPath,
  mergePath,
  pathCanFind,
  PATH_BEGIN,
  PATH_END,
} from "../electron/login-path.js";
import { holdAfterAutoDraft, taskForRun } from "../ui/criteria-hold.js";
import { JOURNAL_RENDER_CAP, STREAM_CAP, contextCap, contextFill, newest, trimOldest } from "../ui/bounds.js";
import { renderMarkdown } from "../ui/markdown.js";
import { buildFrame } from "../src/banner-frames.js";
import { keyFor } from "../electron/endpoint-key.js";
import { mutatesSession } from "../electron/limits.js";
import { fmtCost } from "../src/format.js";
import { COMMANDS, matchCommands } from "../src/commands.js";
import { providerName, endpointProblem as fromProviders } from "../src/providers.js";
import { CLAUDE_CODE_URL, endpointProblem, expandEndpointShorthand, typedEndpointProblem } from "../src/endpoint.js";
import {
  INTERVIEW_MAX_ROUNDS,
  applyBarAdds,
  parseInterviewReply,
  parseQuestions,
} from "../electron/interview.js";
import { parseBar } from "../src/bar.js";

/** The nearest ancestor holding a package.json. */
/**
 * The body of one IPC handler, bounded by the next one.
 *
 * Tests used to take the first 900 characters after the handler's name and
 * assert against that, which measures how much prose sits between the name and
 * the code as much as it measures the code: adding a doc comment to
 * `session:open` failed two unrelated assertions that were still perfectly
 * true. Bound it by the next handler instead — that boundary is real.
 */
function handlerBody(src: string, name: string): string {
  const at = src.indexOf(`"${name}"`);
  if (at < 0) return "";
  const next = src.indexOf("ipcMain.handle(", at + 1);
  return src.slice(at, next < 0 ? undefined : next);
}

function repoRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("could not find the project root from " + import.meta.url);
}

describe("receipts:read containment", () => {
  it("accepts a receipt on POSIX", () => {
    const dir = path.posix.resolve("/proj/.molt/receipts");
    const p = resolveReceipt(dir, "0001-accepted.md", path.posix);
    assert.equal(p, "/proj/.molt/receipts/0001-accepted.md");
  });

  it("accepts a receipt on Windows", () => {
    // The bug: startsWith(dir + "/") against a backslash path never matches,
    // so every legitimate read returns null and the Receipts tab is empty.
    const dir = path.win32.resolve("C:\\proj\\.molt\\receipts");
    const p = resolveReceipt(dir, "0001-accepted.md", path.win32);
    assert.equal(
      p,
      "C:\\proj\\.molt\\receipts\\0001-accepted.md",
      "a Windows receipt must resolve, not vanish behind a POSIX slash",
    );
  });

  it("refuses a climb on both platforms", () => {
    assert.equal(
      resolveReceipt("/proj/.molt/receipts", "../secret.md", path.posix),
      null,
    );
    assert.equal(
      resolveReceipt("C:\\proj\\.molt\\receipts", "..\\secret.md", path.win32),
      null,
    );
    assert.equal(
      resolveReceipt("C:\\proj\\.molt\\receipts", "C:\\Windows\\win.ini", path.win32),
      null,
    );
  });

  it("refuses a sibling that only shares a prefix", () => {
    // startsWith(dir) without a separator would let receipts-evil through.
    assert.equal(
      resolveReceipt("/proj/.molt/receipts", "../receipts-evil/x.md", path.posix),
      null,
    );
    assert.equal(
      resolveReceipt("C:\\proj\\.molt\\receipts", "..\\receipts-evil\\x.md", path.win32),
      null,
    );
  });

  it("refuses the empty string, a non-string, and the directory itself", () => {
    const dir = "/proj/.molt/receipts";
    assert.equal(resolveReceipt(dir, "", path.posix), null);
    assert.equal(resolveReceipt(dir, 1, path.posix), null);
    assert.equal(resolveReceipt(dir, undefined, path.posix), null);
    assert.equal(resolveReceipt(dir, ".", path.posix), null);
  });

  it("takes only the basename off a Windows receipt path", () => {
    assert.equal(receiptBasename("C:\\proj\\.molt\\receipts\\0001-accepted.md"), "0001-accepted.md");
    assert.equal(receiptBasename("/proj/.molt/receipts/0001-accepted.md"), "0001-accepted.md");
  });
});

describe("session:open input", () => {
  it("refuses a second workspace while a turn is running", () => {
    const d = mkdtempSync(path.join(tmpdir(), "molt-open-"));
    try {
      const err = sessionOpenReject({ cwd: d, model: "x", baseUrl: "http://h/v1" }, true);
      assert.match(err ?? "", /turn is running/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("refuses a cwd that is a file, missing, empty, or not a string", () => {
    const d = mkdtempSync(path.join(tmpdir(), "molt-open-"));
    const file = path.join(d, "note.txt");
    writeFileSync(file, "x\n");
    try {
      assert.match(sessionOpenReject({ cwd: file, model: "x", baseUrl: "http://h" }, false) ?? "", /not a directory/);
      assert.match(sessionOpenReject({ cwd: path.join(d, "nope"), model: "x", baseUrl: "http://h" }, false) ?? "", /no such directory/);
      assert.match(sessionOpenReject({ cwd: "", model: "x", baseUrl: "http://h" }, false) ?? "", /no such directory/);
      assert.match(sessionOpenReject(undefined, false) ?? "", /no such directory/);
      assert.match(sessionOpenReject("not-an-object", false) ?? "", /no such directory/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("accepts a real directory when nothing is running", () => {
    const d = mkdtempSync(path.join(tmpdir(), "molt-open-"));
    try {
      assert.equal(sessionOpenReject({ cwd: d, model: "x", baseUrl: "http://h" }, false), null);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("desktop theme surfaces", () => {
  it("keeps tidepool's backgrounds when the theme is tidepool", () => {
    const s = desktopSurfaces(getTheme("tidepool"));
    assert.equal(s.bg.toLowerCase(), "#05171d");
    assert.equal(s.line.toLowerCase(), "#0e3744");
  });

  it("does not leave tidepool backgrounds on mono or slate", () => {
    // getTheme() returns seven colours. The stylesheet invented five more
    // and never updated them, so switching theme recoloured the accent and
    // left the window tidepool-coloured. Surfaces must move with the theme.
    const mono = desktopSurfaces(getTheme("mono"));
    const slate = desktopSurfaces(getTheme("slate"));
    assert.notEqual(mono.bg.toLowerCase(), "#05171d");
    assert.notEqual(slate.bg.toLowerCase(), "#05171d");
    assert.notEqual(mono.line.toLowerCase(), "#0e3744");
    assert.equal(mono.line.toLowerCase(), getTheme("mono").ghost.toLowerCase());
    assert.equal(slate.line.toLowerCase(), getTheme("slate").ghost.toLowerCase());
  });
});

describe("the interview says it is working", () => {
  /**
   * Reported after a real run: "when you draft answer the questions and click
   * to send there needs to be a loading or something because it looks frozen
   * then populates after a minute or so."
   *
   * A round is a real request to a real provider. The panel used to swap one
   * line of text and leave its buttons live, so a minute of waiting was
   * indistinguishable from a hung window — and a second click sent a second
   * round.
   */
  it("shows a spinner and an elapsed clock while a round is in flight", () => {
    const html = readFileSync(path.join(repoRoot(), "ui", "index.html"), "utf8");
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const css = readFileSync(path.join(repoRoot(), "ui", "styles.css"), "utf8");

    assert.match(html, /id="iv-wait"/, "the wait indicator must exist");
    assert.match(html, /id="iv-clock"/, "…and say how long it has been");
    assert.match(css, /\.iv-wait \.spin/, "…and animate");
    assert.match(ui, /function ivWaiting/, "…driven by one place");
  });

  it("disables the buttons while it waits, so a second click cannot double-send", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    assert.match(ui, /if \(ivBusy\) return;/, "a round in flight refuses another");
    assert.match(ui, /\("iv-next"\) as HTMLButtonElement\)\.disabled/);
    assert.match(ui, /\("iv-skip"\) as HTMLButtonElement\)\.disabled/);
  });

  /**
   * The indicator has to come down on failure too, or a failed round leaves a
   * panel that spins for ever — a worse lie than the frozen one it replaced.
   */
  it("clears the indicator even when the round throws", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const round = ui.slice(ui.indexOf("async function interviewRound"));
    assert.match(round.slice(0, 900), /finally \{\s*ivWaiting\(false\);/);
  });
});

describe("the window says when it is waiting on the model", () => {
  /**
   * Reported from a long turn: after the spending-ceiling warning "the model
   * keeps working, it looks dead after this and you can't tell if the model is
   * done or still going".
   *
   * The ceiling notice was incidental. The waiting row was started once per
   * turn, on `job_start`, and removed on the first token — right, because
   * streaming text is its own proof of life. Nothing started it again, so
   * every silence after the first one showed nothing: a model thinking between
   * steps looked identical to a finished turn.
   */
  it("starts the waiting row on every request, not just the first", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const at = ui.indexOf('case "request":');
    assert.ok(at > 0, "the request event must be handled");
    const block = ui.slice(at, ui.indexOf("break;", at));
    assert.match(block, /setPhase\(/, "a request out means the model is being waited on");
    assert.match(block, /bumpActivity\(/, "…and the row belongs below what just arrived");
  });

  /**
   * The counterpart, and the reason the bug was invisible in the code: the
   * only thing that removes the row mid-turn is the first token, which is
   * correct. It just has to be put back.
   */
  it("still clears the row the moment tokens arrive", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const at = ui.indexOf('case "delta":');
    const block = ui.slice(at, ui.indexOf("break;", at));
    assert.match(block, /stopActivity\(\)/);
  });

  it("keeps a notice from stranding the spinner above it", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    // `say` bumps the row to the bottom, which is what makes an info line
    // arriving mid-wait leave the spinner where it can still be seen.
    const sayFn = ui.slice(ui.indexOf("function say("), ui.indexOf("function say(") + 400);
    assert.match(sayFn, /bumpActivity\(\)/);
  });
});

describe("what the interview says while it waits", () => {
  /**
   * Asked for after watching a real round: the clock is honest but a minute of
   * a motionless panel is dull, and dull reads as broken.
   */
  it("rotates rather than sitting on one word", () => {
    let n = 0;
    const cycle = [0, 0.3, 0.6, 0.9];
    const seen = new Set<string>();
    let word = "";
    for (let i = 0; i < 8; i++) {
      const next = nextWaitWord(word, () => cycle[n++ % cycle.length]!);
      assert.notEqual(next, word, "the label must never repeat itself in place");
      seen.add(next);
      word = next;
    }
    assert.ok(seen.size > 2, `expected variety, saw ${[...seen].join(", ")}`);
  });

  /**
   * The one joke this tool cannot make. A label reading "verifying" or
   * "proving" while a question is still out would claim exactly the thing molt
   * refuses to claim without evidence — and it would say it in the calmest
   * possible voice, which is worse.
   */
  it("never claims to have established anything", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "wait-words.ts"), "utf8");
    const list = ui.slice(ui.indexOf("const IV_WORDS"), ui.indexOf("] as const;"));
    assert.ok(list.length > 0, "the word list must exist");
    for (const claim of ["verif", "proven", "proving", "confirmed", "validated", "done"]) {
      assert.doesNotMatch(
        list,
        new RegExp(claim, "i"),
        `a waiting label must not say "${claim}" — nothing is established yet`,
      );
    }
  });

  it("keeps the clock beside it, since that is the honest part", () => {
    const html = readFileSync(path.join(repoRoot(), "ui", "index.html"), "utf8");
    assert.match(html, /id="iv-word"/);
    assert.match(html, /id="iv-clock"/);
  });
});

describe("starting the work after the interview", () => {
  /**
   * Reported as "clicking run after the interview feels weird". The press
   * stays deliberate — sealing what a person approved is the whole of
   * spec-first, and a panel that ran itself would be a bar the model wrote —
   * but the action now sits where the spec is, instead of back in the composer
   * behind a button that had just appeared to do nothing.
   */
  it("offers the action beside the spec it starts", () => {
    const html = readFileSync(path.join(repoRoot(), "ui", "index.html"), "utf8");
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    assert.match(html, /id="ck-start"/);
    assert.match(ui, /\$\("ck-start"\)\.classList\.remove\("hidden"\)/, "shown when a proposal lands");
    // One path begins a turn. A second implementation is how two buttons come
    // to mean different things.
    assert.match(ui, /\$\("ck-start"\)\.addEventListener[\s\S]{0,200}\$\("send"\)\.click\(\)/);
  });

  it("never leaves the action over a panel that has been cleared", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const hidePanel = '$("criteria").classList.add("hidden");';
    const parts = ui.split(hidePanel);
    assert.ok(parts.length > 1, "the panel is hidden somewhere");
    // Paired, not merely present: the button is hidden immediately after every
    // hide of the panel it belongs to. Counting the two separately would pass
    // on a file that hid the button four times in one branch and never in the
    // others.
    for (const after of parts.slice(1)) {
      assert.match(
        after.slice(0, 120),
        /\$\("ck-start"\)\.classList\.add\("hidden"\);/,
        "a hidden criteria panel must take its Start work button with it",
      );
    }
  });
});

describe("logging in to Claude Code from the window", () => {
  /**
   * Reported as "in the desktop app it is not possible to login to claude
   * code". The TUI grew a `/login` row for the backend and the window did
   * not — the seventh capability to exist on one surface and not the other.
   *
   * Settings' only credential control is an API key box, which is the wrong
   * question here: there is no key, and what the backend needs is a CLI
   * logged in somewhere else. So this pins the door, the wire behind it, and
   * the fact that it never asks for a key.
   */
  it("has a control, a bridge and a handler, all three", () => {
    const html = readFileSync(path.join(repoRoot(), "ui", "index.html"), "utf8");
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const preload = readFileSync(path.join(repoRoot(), "electron", "preload.ts"), "utf8");
    const main = readFileSync(path.join(repoRoot(), "electron", "main.ts"), "utf8");

    assert.match(html, /id="set-claude-code"/, "Settings needs a way in");
    assert.match(ui, /\$\("set-claude-code"\)\.addEventListener/, "the button must be wired");
    assert.match(preload, /claudeCodeHealth/, "the renderer cannot reach main without a bridge");
    assert.match(main, /ipcMain\.handle\("claudeCode:health"/, "and main must answer it");
  });

  /**
   * A button that reports "ok" without looking is worse than no button: the
   * failure then arrives mid-turn, dressed as the model's fault.
   */
  it("reports the fix rather than assuming it worked", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    assert.match(ui, /if \(!h\.ok\)/, "the unhealthy case must be handled");
    assert.match(ui, /h\.fix/, "and it must say what to run");
  });
});

describe("title bar padding", () => {
  it("does not reserve 86px for traffic lights on every platform", () => {
    // Walked up to, not guessed at: this file runs from dist-test/test/ once
    // compiled, so a path relative to it lands in the build output rather than
    // the source it means to read.
    const css = readFileSync(path.join(repoRoot(), "ui", "styles.css"), "utf8");
    // The 86px inset is a macOS traffic-light compensation. On Windows and
    // Linux the frame is drawn by the OS, and the same padding is a hole.
    assert.match(css, /\[data-platform=["']darwin["']\][^{]*\.titlebar/);
    const unguarded = /^\s*padding:\s*0\s+var\(--pad\)\s+0\s+86px/m.test(css);
    assert.equal(unguarded, false, "86px must not be the default padding");
  });
});

describe("the bar stays on screen while the work happens", () => {
  it("ships a context meter, not a copied todo list", () => {
    const html = readFileSync(path.join(repoRoot(), "ui", "index.html"), "utf8");
    assert.match(html, /id="ctx"/);
    assert.match(html, /id="ctx-fill"/);
    assert.match(html, /id="spine-list"/);
    // The checklist under the meter is the bar. A second Todo heading
    // would be OpenCode's list, not molt's.
    assert.doesNotMatch(html, />Todo</);
  });

  it("fills against a named window, never an invented one", () => {
    assert.equal(contextCap(16384, 40000), 16384);
    assert.equal(contextCap(0, 40000), 40000);
    assert.equal(contextCap(0, null), 0);
    assert.equal(contextFill(8192, 16384), 0.5);
    assert.equal(contextFill(200, 0), 0, "no denominator, no percentage");
    assert.equal(contextFill(0, 16384), 0);
  });

  it("ships a spine, a live jump, and a stage the settings form can hide", () => {
    const html = readFileSync(path.join(repoRoot(), "ui", "index.html"), "utf8");
    const css = readFileSync(path.join(repoRoot(), "ui", "styles.css"), "utf8");
    // The unique surface: the bar is a column you watch, not a tab you
    // remember. Every other wrapper is a chat column with a drawer.
    assert.match(html, /id="spine"/);
    assert.match(html, /id="spine-list"/);
    assert.match(html, /id="jump"/);
    assert.match(html, /id="stage"/);
    assert.match(css, /\.stage\.no-spine \.spine/);
    assert.match(css, /\.spine-list li\.pass/);
    assert.match(css, /\.jump \{/);
  });

  it("hides the spine completely, with no leftover strip", () => {
    const css = readFileSync(path.join(repoRoot(), "ui", "styles.css"), "utf8");
    assert.match(css, /\.stage\.no-spine \.spine \{\s*display:\s*none/);
  });

  it("ships five tabs and no copy of the bar", () => {
    const html = readFileSync(path.join(repoRoot(), "ui", "index.html"), "utf8");
    const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(tabs, ["session", "view", "receipts", "log", "settings"]);
    assert.doesNotMatch(html, /id="checks"/);
    assert.doesNotMatch(html, /tab-checks/);
    assert.doesNotMatch(html, /st-usage/);
    assert.doesNotMatch(html, /st-bar/);
    assert.doesNotMatch(html, /id="ask"/);
    assert.doesNotMatch(html, /ck-open/);
    assert.doesNotMatch(html, />Todo</);
  });

  it("registers /interview without stealing /ask", () => {
    const interview = COMMANDS.find((c) => c.name === "/interview");
    const ask = COMMANDS.find((c) => c.name === "/ask");
    assert.ok(interview, "/interview must be on the palette");
    assert.ok(interview!.aliases?.includes("spec"));
    assert.ok(ask, "/ask stays a question, not a spec interview");
    assert.equal(ask!.name, "/ask");
  });
});

describe("/init reports whether it wrote", () => {
  it("does not claim a write when the bar already existed", () => {
    // writeDefaultBar returns `{ existed }`. That object is always truthy, so
    // `wrote ? "wrote…" : "already exists"` always took the first branch —
    // /init on a project that already had a bar said it had just created one.
    assert.match(barInitText(true, "done.yml", 4), /already exists/);
    assert.match(barInitText(false, "done.yml", 4), /wrote done\.yml — 4 check/);
    assert.doesNotMatch(barInitText(true, "done.yml", 4), /wrote /);
  });
});

describe("long-session caps", () => {
  it("keeps only the newest journal lines on the wire", () => {
    const text = Array.from({ length: JOURNAL_IPC_CAP + 50 }, (_, i) => `{"seq":${i}}`).join("\n");
    const kept = tailLines(text, JOURNAL_IPC_CAP);
    assert.equal(kept.length, JOURNAL_IPC_CAP);
    assert.equal(kept[0], `{"seq":50}`);
    assert.equal(kept[kept.length - 1], `{"seq":${JOURNAL_IPC_CAP + 49}}`);
  });

  it("parseJournal is what journal:read sends, capped and tolerant of junk", () => {
    const text = Array.from({ length: JOURNAL_IPC_CAP + 50 }, (_, i) => `{"seq":${i}}`).join("\n") + "\nnot json\n";
    const kept = parseJournal(text);
    assert.equal(kept.length, JOURNAL_IPC_CAP);
    assert.deepEqual(kept[0], { seq: 51 });
    assert.deepEqual(kept[kept.length - 1], { kind: "unparsed", line: "not json" });
  });
});

describe("session:run sanitizes renderer-supplied criteria", () => {
  it("drops non-string run, empty run, and anything past the cap", () => {
    const { taskChecks, taskNotes } = taskChecksFrom({
      checks: [
        { name: "ok", run: "true" },
        { name: "num", run: 1 },
        { name: "blank", run: "   " },
        { name: "x".repeat(80), run: "echo " + "a".repeat(400) },
        { name: "fifth", run: "true" },
        { name: "sixth", run: "true" },
        { name: "seventh", run: "true" },
      ],
      notes: ["keep", 12, "", "b".repeat(250), "third", "fourth"],
    });
    assert.equal(taskChecks.length, 4);
    assert.equal(taskChecks[0]!.name, "ok");
    assert.equal(taskChecks[0]!.run, "true");
    assert.equal(taskChecks[0]!.kind, "command");
    assert.equal(taskChecks[1]!.name.length, 40);
    assert.equal(taskChecks[1]!.run.length, 300);
    assert.equal(taskChecks[2]!.name, "fifth");
    assert.equal(taskChecks[3]!.name, "sixth");
    assert.equal(taskNotes.length, 3);
    assert.equal(taskNotes[0], "keep");
    assert.equal(taskNotes[1]!.length, 200);
    assert.equal(taskNotes[2], "third");
  });

  it("treats garbage as no extra checks, not as a throw", () => {
    assert.deepEqual(taskChecksFrom(null), { taskChecks: [], taskNotes: [] });
    assert.deepEqual(taskChecksFrom("rm -rf /"), { taskChecks: [], taskNotes: [] });
    assert.deepEqual(taskChecksFrom({ checks: "echo pwned" }), { taskChecks: [], taskNotes: [] });
  });
});

describe("spec-first holds until a second Run", () => {
  it("holds the first Run of a real turn, even before the spec lands", () => {
    assert.equal(holdAfterAutoDraft({ auto: true, hadRows: false, ask: false }), true);
    assert.equal(holdAfterAutoDraft({ auto: true, hadRows: false, ask: false, drafted: false }), true);
    assert.equal(holdAfterAutoDraft({ auto: true, hadRows: true, ask: false }), false);
    assert.equal(holdAfterAutoDraft({ auto: true, hadRows: false, ask: true }), false);
    assert.equal(holdAfterAutoDraft({ auto: false, hadRows: false, ask: false }), false);
    assert.equal(holdAfterAutoDraft({ auto: true, hadRows: false, ask: false, resuming: true }), false);
  });
});

describe("stream and journal render caps", () => {
  it("drops the oldest stream rows past the cap", () => {
    const kids: { id: number }[] = [];
    const parent = {
      get childElementCount() {
        return kids.length;
      },
      get firstChild() {
        return kids[0] ?? null;
      },
      removeChild(n: { id: number }) {
        const i = kids.indexOf(n);
        if (i >= 0) kids.splice(i, 1);
      },
    };
    for (let i = 0; i < STREAM_CAP + 25; i++) kids.push({ id: i });
    trimOldest(parent, STREAM_CAP);
    assert.equal(kids.length, STREAM_CAP);
    assert.equal(kids[0]!.id, 25, "the oldest 25 must be the ones that left");
  });

  it("renders the newest journal rows, not the first ones", () => {
    const rows = Array.from({ length: JOURNAL_RENDER_CAP + 10 }, (_, i) => i);
    const shown = newest(rows, JOURNAL_RENDER_CAP);
    assert.equal(shown.length, JOURNAL_RENDER_CAP);
    assert.equal(shown[0], 10);
    assert.equal(shown[shown.length - 1], JOURNAL_RENDER_CAP + 9);
  });
});

describe("the confirm dialog dies with the turn", () => {
  it("hides on idle, not only when a button is clicked", () => {
    const src = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    // The buttons hide it. session:idle used not to, so Stop left a modal
    // that answered nothing.
    assert.match(src, /molt\.onIdle/);
    const idle = src.slice(src.indexOf("molt.onIdle"));
    // Either route counts, because what matters is that the turn ending takes
    // the dialog with it. It hid the modal inline until the dialogs grew a
    // shared open/close that also puts focus back where it came from; pinning
    // the inline form would have made that refactor look like a regression.
    assert.match(
      idle.slice(0, 600),
      /closeModal\("confirm"\)|\$\("confirm"\)\.classList\.add\("hidden"\)/,
    );
    // …and whichever route it takes has to actually hide it.
    const close = src.slice(src.indexOf("function closeModal"));
    assert.match(close.slice(0, 300), /classList\.add\("hidden"\)/);
  });
});

describe("what you can still do while a turn is running", () => {
  it("lets the read-only shed plan through, and stops the mutating one", () => {
    // `/shed --explain` is the question you ask precisely because a turn is
    // running and the context is growing under you.
    assert.equal(mutatesSession("/shed", "--explain"), false);
    assert.equal(mutatesSession("/shed", "explain"), false);
    assert.equal(mutatesSession("/shed", " --explain "), false);
    assert.equal(mutatesSession("/shed", ""), true);
    assert.equal(mutatesSession("/shed", "3"), true);
    assert.equal(mutatesSession("/regrow", "--explain"), true);
    assert.equal(mutatesSession("/prove", ""), true);
    assert.equal(mutatesSession("/stats", ""), false);
    assert.equal(mutatesSession("/wire", ""), false);
  });

  it("dispatches a command before it checks whether a turn is running", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const body = ui.slice(ui.indexOf("async function send()"));
    const cmd = body.indexOf('text.startsWith("/")');
    const gate = body.indexOf("if (busy) {");
    assert.ok(cmd > 0 && gate > 0, "send() lost either the command branch or the busy gate");
    // The blanket `if (!text || busy) return` at the top took the whole palette
    // away mid-turn — /wire, /stats and /shed --explain along with it.
    assert.ok(cmd < gate, "commands are still blocked while a turn runs");
    assert.doesNotMatch(body.slice(0, 200), /if \(!text \|\| busy\) return/);
  });

  it("says why a prompt was refused instead of doing nothing", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    assert.match(ui, /a turn is running — press Stop/);
    assert.match(ui, /hintedBusy = false/, "the hint never resets, so it shows once a session");
  });
});

describe("the meter shows money, not just tokens", () => {
  it("asks the endpoint what it charges, on open and on a model change", () => {
    const src = readFileSync(path.join(repoRoot(), "electron", "main.ts"), "utf8");
    // The window only ever *read* engine.pricing(), for /price. Nothing wrote
    // it, so costUsd() was undefined and the status bar showed tokens with no
    // money beside them. Anthropic hid it: its rates ship in providers.ts, so
    // Claude found a price and grok — which publishes one — found none.
    assert.match(src, /fetchPricing\(/, "the desktop never asks for a price");
    assert.match(
      handlerBody(src, "session:open"),
      /refreshPricing\(/,
      "no price lookup when a workspace opens",
    );
    const model = src.slice(src.indexOf('"session:model"'));
    assert.match(model.slice(0, 1200), /refreshPricing\(/, "no price lookup when the model changes");
  });

  it("never carries one model's rate onto another", () => {
    const src = readFileSync(path.join(repoRoot(), "electron", "main.ts"), "utf8");
    // This rule exists because a Claude session was once billed at grok's
    // $2/$6 and shown a total 40% under the truth.
    assert.match(src, /stored\.priceModel === model/);
    assert.match(src, /stored\.priceModel !== model/);
  });

  it("prints cost by the terminal's rules rather than a second set", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    assert.match(ui, /from "\.\.\/src\/format\.js"/);
    assert.doesNotMatch(ui, /costUsd\.toFixed/, "the status bar is formatting cost on its own again");
  });

  it("never prints a real cost as a zero", () => {
    // `toFixed(4)` rendered four hundredths of a cent as "$0.0000", which is a
    // false zero on the one number people quote back at each other.
    assert.equal(fmtCost(0.00004), "<$0.001");
    assert.notEqual(fmtCost(0.00004), "$0.0000");
  });

  it("keeps the unit fixed so a running total can be read as a series", () => {
    // A meter that reads "0.9¢" then "$0.029" looks like it went DOWN.
    for (const v of [0.0004, 0.004, 0.04, 0.4, 4, 40]) {
      assert.ok(fmtCost(v).startsWith("$") || fmtCost(v).startsWith("<$"), fmtCost(v));
    }
    assert.equal(fmtCost(0.1923), "$0.19");
  });
});

describe("one palette, two surfaces", () => {
  it("matches commands with src/commands.ts rather than a copy of its rules", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    // The renderer's own comment said the rules were "imported rather than
    // reimplemented" while a 37-line mirror of them sat directly beneath it.
    assert.match(ui, /from "\.\.\/src\/commands\.js"/);
    assert.doesNotMatch(ui, /function matchCommands/, "the renderer has its own matcher again");
    assert.doesNotMatch(ui, /function isSubsequence/);
  });

  it("stops treating the palette as a menu once an argument is being typed", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    // Enter on "/model grok-4.6" must send the line, not complete "/model "
    // over the argument. The old private matcher returned nothing here, so the
    // question never arose; the shared one returns the settled command.
    assert.match(ui, /function paletteChoosing\(\)/);
    assert.match(ui, /if \(paletteChoosing\(\)\) \{/);
  });

  it("still ranks the way the terminal does", () => {
    const cmds = [
      { name: "/model", args: "[id]", summary: "choose the model" },
      { name: "/molt", summary: "cycle the theme" },
      { name: "/receipts", summary: "open the receipts tab" },
    ];
    // exact name first, then prefix, ties toward the shorter name
    assert.equal(matchCommands("/molt", cmds)[0]!.name, "/molt");
    assert.equal(matchCommands("/mo", cmds)[0]!.name, "/molt");
    assert.equal(matchCommands("/", cmds).length, 3);
    // Settled, not hidden: the row stays as a reminder of which command you are
    // inside. The renderer must therefore stop treating it as a menu — see the
    // Enter guard below, without which completing it wiped the argument.
    assert.deepEqual(matchCommands("/model x", cmds).map((c) => c.name), ["/model"]);
  });
});

describe("the key that reaches the endpoint", () => {
  const auth = { xai: "xai-stored", anthropic: "sk-ant-stored" };

  it("uses the stored key when the box is blank, which is what Settings promises", () => {
    // The bug this pins: blank box -> undefined -> authHeaders returns {} ->
    // x.ai replies 401 unauthenticated:no-credentials on every turn, while the
    // model picker (which does read auth.json) keeps listing grok's models.
    assert.equal(keyFor("https://api.x.ai/v1", undefined, auth), "xai-stored");
    assert.equal(keyFor("https://api.anthropic.com/v1", "", auth), "sk-ant-stored");
  });

  it("lets a typed key outrank the stored one, so a rotated key can be used", () => {
    assert.equal(keyFor("https://api.x.ai/v1", "xai-fresh", auth), "xai-fresh");
  });

  it("looks the key up per endpoint rather than carrying the last one across", () => {
    // Switching vendors must never hand the new vendor the old vendor's key.
    assert.equal(keyFor("https://api.anthropic.com/v1", undefined, auth), "sk-ant-stored");
    assert.equal(keyFor("https://api.openai.com/v1", undefined, auth), undefined);
  });

  it("sends nothing to a machine you run, which wants no key", () => {
    assert.equal(keyFor("http://192.168.0.218:8080/v1", undefined, auth), undefined);
  });

  it("names x.ai the way auth.json does", () => {
    // providerName parses to a preset name, not a subdomain: "api.x.ai" would
    // otherwise resolve to "api" and never match the stored entry.
    assert.equal(providerName("https://api.x.ai/v1"), "xai");
  });
});

describe("one splash, two surfaces", () => {
  it("draws the window's splash from the terminal's own frames", () => {
    const src = readFileSync(path.join(repoRoot(), "ui", "splash.ts"), "utf8");
    // The whole point of splitting `banner-frames.ts` out of `banner.tsx` was
    // that the window could read it without dragging Ink into a browser
    // bundle. If this import ever goes, the two surfaces have quietly become
    // two animations, and they will drift the first time either is tuned.
    assert.match(src, /from "\.\.\/src\/banner-frames\.js"/);
    assert.match(src, /buildFrame\(/);
    // And it must not have grown its own copy of the grid on the way.
    assert.doesNotMatch(src, /SHED_AT\s*=\s*\[/);
    assert.doesNotMatch(src, /const WORD\s*=/);
  });

  it("keeps banner.tsx's exports working for everything that imported them", () => {
    const src = readFileSync(path.join(repoRoot(), "src", "banner.tsx"), "utf8");
    // src/app.tsx, src/cli.tsx, src/status-line.tsx and the tests all reach
    // for these through banner.js. Moving a file is not a reason to make four
    // callers learn a new path.
    for (const name of ["buildFrame", "compactFrame", "FRAME_MS", "SETTLED_FRAME", "MIN_COLUMNS"])
      assert.match(src, new RegExp(`\\b${name}\\b`), `banner.tsx no longer offers ${name}`);
    assert.match(src, /export type \{[^}]*\bTone\b/);
  });

  it("sheds each husk on the frame it always did", () => {
    const row = (f: number): string =>
      buildFrame(f)[3]!
        .map((s) => s.text)
        .join("");
    // Husked at the start, one letter freed per SHED_AT entry, bare by 14.
    assert.ok(row(0).startsWith("(m) (o) (l) (t)"), row(0));
    assert.ok(row(2).startsWith(" m  (o) (l) (t)"), row(2));
    assert.ok(row(6).startsWith(" m   o  (l) (t)"), row(6));
    assert.ok(row(14).startsWith(" m   o   l   t"), row(14));
  });

  it("casts a wavefront off past the word, never through it", () => {
    // The husk leaves as an arc travelling right from ORIGIN. A ripple drawn
    // over the letters would read as the word breaking up rather than shedding.
    const cells = buildFrame(5).flatMap((segs, r) =>
      segs
        .map((s) => s.text)
        .join("")
        .split("")
        .map((ch, c) => ({ ch, r, c })),
    );
    const ripples = cells.filter((x) => x.ch === ")" && x.r !== 3);
    assert.ok(ripples.length > 0, "no wavefront off the waterline by frame 5");
    for (const x of ripples) assert.ok(x.c >= 17, `ripple at column ${x.c} is over the word`);
  });
});

describe("receipt markdown is text, never HTML", () => {
  function stub(): HTMLElement {
    const kids: HTMLElement[] = [];
    const node = {
      childNodes: kids,
      children: kids,
      style: {} as CSSStyleDeclaration,
      className: "",
      _text: "",
      get textContent() {
        return this._text || kids.map((c) => c.textContent).join("");
      },
      set textContent(v: string) {
        this._text = v;
        kids.length = 0;
      },
      appendChild(c: HTMLElement) {
        kids.push(c);
        return c;
      },
    };
    return node as unknown as HTMLElement;
  }

  const orig = globalThis.document;
  const created: { tag: string; node: HTMLElement }[] = [];

  function install(): void {
    created.length = 0;
    (globalThis as unknown as { document: unknown }).document = {
      createElement(tag: string) {
        const n = stub();
        (n as unknown as { tagName: string }).tagName = tag.toUpperCase();
        created.push({ tag, node: n });
        return n;
      },
      createTextNode(text: string) {
        const n = stub();
        n.textContent = text;
        return n;
      },
    };
  }

  function restore(): void {
    (globalThis as unknown as { document: unknown }).document = orig;
  }

  it("does not create a script element for a script tag in the claim", () => {
    install();
    try {
      const into = stub();
      renderMarkdown('claim: <script>alert(1)</script>\n\n> <script src="x"></script>', into);
      assert.equal(
        created.some((c) => c.tag.toLowerCase() === "script"),
        false,
        "a receipt must never become a script node",
      );
      assert.match(into.textContent ?? "", /<script>alert\(1\)<\/script>/);
    } finally {
      restore();
    }
  });

  it("keeps a script tag literal inside a table cell and a blockquote", () => {
    install();
    try {
      const into = stub();
      renderMarkdown(
        [
          "| a | b |",
          "|---|---|",
          "| <script>x</script> | ok |",
          "",
          "> **bold** and <script>y</script>",
        ].join("\n"),
        into,
      );
      assert.equal(created.some((c) => c.tag.toLowerCase() === "script"), false);
      assert.match(into.textContent ?? "", /<script>x<\/script>/);
      assert.match(into.textContent ?? "", /<script>y<\/script>/);
      assert.equal(created.some((c) => c.tag === "table"), true);
      assert.equal(created.some((c) => c.tag === "blockquote"), true);
    } finally {
      restore();
    }
  });

  /**
   * A node sink that accepts exactly the blocks the document is made of.
   *
   * The failure being reproduced is a hang, not a wrong string, and a test
   * that reproduces a hang by hanging stops the suite instead of reporting.
   * So the sink turns "not making progress" into an ordinary thrown failure
   * on the very first block too many.
   *
   * `expected` is the exact block count, not slack: every test below also
   * asserts that count, so the ceiling is pinned from both sides. One too low
   * and the legitimate last block throws; one too high and the block-count
   * assertion catches it.
   */
  function sink(expected: number): HTMLElement {
    const n = stub();
    const push = n.appendChild.bind(n);
    let count = 0;
    (n as unknown as { appendChild: (c: HTMLElement) => HTMLElement }).appendChild = (c) => {
      count += 1;
      if (count > expected) {
        throw new Error(`renderMarkdown appended block ${count}; the document holds ${expected}`);
      }
      return push(c);
    };
    return n;
  }

  it("advances past a heading deeper than the header rule matches", () => {
    install();
    try {
      const into = sink(1);
      renderMarkdown("##### five hashes", into);
      assert.equal(into.children.length, 1);
      assert.equal(created.filter((c) => c.tag === "p").length, 1);
      assert.match(into.textContent ?? "", /five hashes/);
      assert.equal(into.textContent, "##### five hashes");
    } finally {
      restore();
    }
  });

  it("advances past a hash with no space after it", () => {
    install();
    try {
      const into = sink(2);
      renderMarkdown("#hashtag\n\ndone", into);
      assert.equal(into.children.length, 2);
      assert.match(into.textContent ?? "", /#hashtag/);
      assert.match(into.textContent ?? "", /done/);
      assert.equal(into.textContent, "#hashtagdone");
    } finally {
      restore();
    }
  });

  it("advances past a pipe row with no separator beneath it", () => {
    install();
    try {
      const into = sink(3);
      renderMarkdown("| a | b |\n| no separator |\n\nafter", into);
      assert.equal(created.some((c) => c.tag === "table"), false, "that was not a table");
      assert.equal(into.children.length, 3);
      assert.match(into.textContent ?? "", /after/);
      assert.equal(into.textContent, "| a | b || no separator |after");
    } finally {
      restore();
    }
  });

  it("still joins the continuation lines of an ordinary paragraph", () => {
    install();
    try {
      const into = sink(1);
      renderMarkdown("one two\nthree four", into);
      assert.equal(into.children.length, 1);
      assert.equal(created.filter((c) => c.tag === "p").length, 1);
      assert.match(into.textContent ?? "", /one two three four/);
      assert.equal(into.textContent, "one two three four");
    } finally {
      restore();
    }
  });

  it("closes an unterminated fence at the end of the document", () => {
    install();
    try {
      const into = stub();
      renderMarkdown("```\nnot closed", into);
      assert.equal(created.some((c) => c.tag === "pre"), true);
      assert.match(into.textContent ?? "", /not closed/);
    } finally {
      restore();
    }
  });
});

/**
 * The PATH a GUI launch does not inherit.
 *
 * This is the failure that wasted a 4.8M-token session: every command check
 * exited 127 with `npm: command not found` because launchd gives a Finder-
 * launched app `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. The model's
 * work was correct and molt refused it three times.
 */
describe("PATH repair for a GUI launch", () => {
  // The real launchd PATH, which is the whole problem.
  const LAUNCHD = "/usr/bin:/bin:/usr/sbin:/sbin";
  const BREW = "/opt/homebrew/bin";
  const has = (...dirs: string[]) => (p: string) => dirs.some((d) => p === `${d}/node` || p === d);

  it("leaves a terminal launch alone without asking the shell", () => {
    let probed = false;
    const r = resolvePath({
      current: `${BREW}:${LAUNCHD}`,
      cmd: "node",
      platform: "darwin",
      home: "/Users/x",
      probe: () => {
        probed = true;
        return null;
      },
      exists: has(BREW),
    });
    assert.equal(r.outcome, "already-usable");
    assert.equal(probed, false, "spawned a login shell when PATH already worked");
    assert.deepEqual(r.added, []);
  });

  it("recovers the login shell's PATH when the app was launched from Finder", () => {
    const r = resolvePath({
      current: LAUNCHD,
      cmd: "node",
      platform: "darwin",
      home: "/Users/x",
      // An rc file that prints a banner, which is why the markers exist.
      probe: () =>
        `Welcome to zsh!\n${PATH_BEGIN}${BREW}:${LAUNCHD}${PATH_END}\n`,
      exists: has(BREW),
    });
    assert.equal(r.outcome, "from-login-shell");
    assert.ok(r.path.split(":").includes(BREW), "never found the directory node is in");
    assert.deepEqual(r.added, [BREW]);
    assert.ok(pathCanFind(r.path, "node", has(BREW)), "repaired a PATH that still cannot run node");
  });

  it("keeps the inherited PATH ahead of the shell's", () => {
    // A toolchain pinned by whatever launched molt must not be silently
    // swapped for the one a login shell happens to prefer.
    const PINNED = "/pinned/bin";
    const r = resolvePath({
      current: `${PINNED}:${LAUNCHD}`,
      cmd: "node",
      platform: "darwin",
      home: "/Users/x",
      probe: () => `${PATH_BEGIN}${BREW}:${PINNED}${PATH_END}`,
      exists: has(BREW),
    });
    assert.equal(r.path.split(":")[0], PINNED, "a login shell reordered the inherited PATH");
  });

  it("falls back to known locations when the shell cannot be asked", () => {
    const r = resolvePath({
      current: LAUNCHD,
      cmd: "node",
      platform: "darwin",
      home: "/Users/x",
      probe: () => null, // shell missing, hung, or exited non-zero
      exists: has(BREW),
    });
    assert.equal(r.outcome, "from-fallback");
    assert.ok(r.path.split(":").includes(BREW));
  });

  it("does not claim success when nothing could be added", () => {
    // Reporting a repair that did not happen would send someone hunting for a
    // bug in their project instead of their PATH.
    const r = resolvePath({
      current: LAUNCHD,
      cmd: "node",
      platform: "darwin",
      home: undefined,
      probe: () => null,
      exists: () => false,
    });
    assert.equal(r.outcome, "unchanged");
    assert.deepEqual(r.added, []);
  });

  it("ignores a shell that answers without the markers", () => {
    // stdout with no markers is rc noise, not a PATH. Taking it would set
    // PATH to a motd.
    assert.equal(parseLoginPath("some banner text\n"), null);
    assert.equal(parseLoginPath(`${PATH_BEGIN}${PATH_END}`), null, "took an empty PATH");
    assert.equal(parseLoginPath(`${PATH_BEGIN}/a:/b${PATH_END}`), "/a:/b");
  });

  it("never duplicates or drops entries when merging", () => {
    assert.equal(mergePath("/a:/b", "/b:/c"), "/a:/b:/c");
    assert.equal(mergePath(undefined, "/a"), "/a");
    assert.equal(mergePath("/a", undefined), "/a");
    assert.equal(mergePath("/a::/a:/b", ""), "/a:/b", "kept a blank or duplicate entry");
  });
});

/**
 * The window asks before it gives up.
 *
 * `onCeiling` existed and was wired in the TUI only. In the window a turn
 * stopped dead at step 32 — in a real session, eight steps into diagnosing a
 * genuine bug, with every token spent getting there turned into nothing and
 * nobody asked.
 */
describe("the ceiling, in the window", () => {
  it("offers to carry on, through the same dialog tool calls use", async () => {
    const asked: { name: string; detail: string }[] = [];
    const opts = runOptions({
      ask: false,
      criteria: { checks: [], notes: [] },
      confirm: async (name, detail) => {
        asked.push({ name, detail });
        return true;
      },
      maxSteps: 32,
    });
    assert.equal(typeof opts.onCeiling, "function", "the window would stop dead at the guard");
    assert.equal(await opts.onCeiling("40 steps · 4.8M tokens"), true);
    assert.equal(asked.length, 1, "reached the ceiling without asking anyone");
    // The amount must survive into the prompt: this is a spending decision.
    assert.match(asked[0]!.detail, /40 steps · 4\.8M tokens/);
    assert.match(asked[0]!.detail, /another 32 steps/);
  });

  it("stops when the answer is no", async () => {
    const opts = runOptions({
      ask: false,
      criteria: {},
      confirm: async () => false,
      maxSteps: 32,
    });
    assert.equal(await opts.onCeiling("32 steps"), false, "carried on after being told to stop");
  });

  it("still sanitizes criteria on the way through", async () => {
    // The boundary check must not be lost by moving the option building.
    const opts = runOptions({
      ask: false,
      criteria: { checks: [{ name: "x", run: 42 }, { name: "ok", run: "echo hi" }] },
      confirm: async () => false,
      maxSteps: 32,
    });
    assert.equal(opts.taskChecks.length, 1, "a non-string run reached the engine");
    assert.equal(opts.taskChecks[0]!.run, "echo hi");
  });

  it("says what stopping and continuing each do", () => {
    const { name, detail } = ceilingAsk("10 steps · $1.20", 32);
    assert.match(name, /keep going/i);
    assert.match(detail, /Stopping keeps everything done so far/);
    assert.match(detail, /\$1\.20/, "hid the amount being decided about");
  });
});

/**
 * The meter that stayed off for a whole session.
 *
 * Pricing was fetched once, at session open, and not awaited. One failed
 * request meant 4.8M tokens ran with `costUsd: null` on every step against a
 * provider that does publish rates — and nothing said the money column was
 * missing rather than zero.
 */
describe("resolving a price that failed at open", () => {
  it("asks again when the rate is still unknown", () => {
    const r = shouldRefreshPrice({ priceIn: undefined, model: "grok-4.6", announcedNoPriceFor: null });
    assert.equal(r.refresh, true, "a session with no rate would never ask again");
    assert.equal(r.announce, true);
  });

  it("does not ask once a rate is known", () => {
    // One request per turn is cheap; one per turn forever is not, and a known
    // rate is the answer this exists to get.
    const r = shouldRefreshPrice({ priceIn: 2, model: "grok-4.6", announcedNoPriceFor: null });
    assert.equal(r.refresh, false);
    assert.equal(r.announce, false);
  });

  it("keeps retrying quietly for an endpoint that publishes nothing", () => {
    // A self-hosted endpoint has no price list. Retrying costs nothing worth
    // counting; saying so before every turn is noise.
    const r = shouldRefreshPrice({
      priceIn: undefined,
      model: "qwen3-coder",
      announcedNoPriceFor: "qwen3-coder",
    });
    assert.equal(r.refresh, true, "stopped trying, so a later fix would never be picked up");
    assert.equal(r.announce, false, "repeated the no-price message every turn");
  });

  it("announces again when the model changes", () => {
    const r = shouldRefreshPrice({
      priceIn: undefined,
      model: "grok-4.6",
      announcedNoPriceFor: "qwen3-coder",
    });
    assert.equal(r.announce, true, "stayed silent about a different model's missing rate");
  });
});

/**
 * A held turn must not look like a refused one.
 *
 * The first Run of every turn drafts criteria and holds — auto is on by
 * default and `rows` resets each turn, so this is the common path, not an
 * edge. The clear happened after the early return, so the composer still held
 * what you typed and the send read as having done nothing.
 */
describe("the task a Run acts on", () => {
  it("uses what was typed", () => {
    assert.deepEqual(taskForRun("fix the parser", null), {
      text: "fix the parser",
      resuming: false,
    });
  });

  it("resumes the held task when the composer was cleared", () => {
    // The whole point: the box is empty because the hold emptied it, and the
    // second Run must still know what it is starting.
    assert.deepEqual(taskForRun("", "fix the parser"), {
      text: "fix the parser",
      resuming: true,
    });
  });

  it("lets anything typed since replace the held task", () => {
    // Someone who edits the composer during the review has changed their
    // mind. Running the older text would run words they are not looking at.
    assert.deepEqual(taskForRun("actually, fix the lexer", "fix the parser"), {
      text: "actually, fix the lexer",
      resuming: false,
    });
  });

  it("treats whitespace as empty on both sides", () => {
    assert.deepEqual(taskForRun("   ", "fix the parser"), {
      text: "fix the parser",
      resuming: true,
    });
    assert.deepEqual(taskForRun("   ", "   "), { text: "", resuming: false });
    assert.deepEqual(taskForRun("  padded  ", null), { text: "padded", resuming: false });
  });

  it("does nothing when there is nothing to run", () => {
    assert.deepEqual(taskForRun("", null), { text: "", resuming: false });
  });
});

describe("the evidence chain is wired on both surfaces", () => {
  it("gives the window's engine a ledger, not just a button that reads one", () => {
    const src = readFileSync(path.join(repoRoot(), "electron", "main.ts"), "utf8");
    // Shipped state before this: `integrity:verify`, a preload binding and a
    // "verify evidence chain" button — over an engine that was never given a
    // ledger to write. The button could only ever answer "0 records", and it
    // would have answered it in the confident green of a passing check.
    assert.match(src, /new Integrity\(cwd\)/, "the window never builds a ledger");
    const engine = src.slice(src.indexOf("new Engine({"));
    assert.match(
      engine.slice(0, 900),
      /\n\s+integrity,/,
      "the window's engine is built without the ledger, so nothing is ever bound",
    );
  });

  it("reports an unestablished chain as unestablished, not as intact", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    assert.match(ui, /if \(!ev\.established\)/, "an empty chain takes the intact path");
    assert.match(ui, /if \(ev\.root\)/, "a null root of trust would print as \"null\"");
  });
});

describe("interview replies become checks a person can run", () => {
  it("accepts fenced JSON", () => {
    const t = parseInterviewReply(
      "```json\n" +
        JSON.stringify({
          questions: [{ id: "q1", prompt: "Which failure mode?", options: ["a", "b"] }],
        }) +
        "\n```",
      1,
    );
    assert.equal(t.kind, "ask");
    if (t.kind === "ask") {
      assert.equal(t.questions[0]?.id, "q1");
      assert.deepEqual(t.questions[0]?.options, ["a", "b"]);
    }
  });

  it("proposes on the last round even if the model kept asking", () => {
    const t = parseInterviewReply(
      JSON.stringify({
        questions: [{ id: "q1", prompt: "One more?", options: ["yes", "no"] }],
        proposal: {
          checks: [{ name: "lint", run: "npm test" }],
          notes: ["the picker lists the second server"],
        },
      }),
      INTERVIEW_MAX_ROUNDS,
    );
    assert.equal(t.kind, "propose");
    if (t.kind === "propose") {
      assert.equal(t.proposal.checks[0]?.name, "lint");
      assert.equal(t.proposal.notes[0], "the picker lists the second server");
    }
  });

  it("drops a question with fewer than two options", () => {
    assert.deepEqual(parseQuestions([{ id: "q1", prompt: "Only one?", options: ["a"] }]), []);
    assert.equal(
      parseQuestions([{ id: "q1", prompt: "A real choice?", options: ["a", "b"] }]).length,
      1,
    );
  });

  it("writes only new command checks and leaves builtins and existing names alone", () => {
    const d = mkdtempSync(path.join(tmpdir(), "molt-iv-"));
    try {
      const current = parseBar(
        [
          "version: 1",
          "checks:",
          "  - name: files-changed",
          "    builtin: files-changed",
          "  - name: lint",
          "    run: npm run lint",
        ].join("\n"),
      );
      const r = applyBarAdds(
        d,
        [
          { name: "lint", run: "false" },
          { name: "typecheck", run: "npx tsc --noEmit" },
        ],
        current,
      );
      assert.equal(r.ok, true, r.ok ? "" : r.error);
      if (!r.ok) return;
      const lint = r.bar.checks.find((c) => c.name === "lint");
      const files = r.bar.checks.find((c) => c.name === "files-changed");
      const added = r.bar.checks.find((c) => c.name === "typecheck");
      assert.equal(lint?.kind, "command");
      if (lint?.kind === "command") assert.equal(lint.run, "npm run lint");
      assert.equal(files?.kind, "builtin");
      if (files?.kind === "builtin") assert.equal(files.builtin, "files-changed");
      assert.equal(added?.kind, "command");
      if (added?.kind === "command") assert.equal(added.run, "npx tsc --noEmit");
      const yaml = readFileSync(path.join(d, ".molt", "done.yml"), "utf8");
      assert.match(yaml, /name: typecheck/);
      assert.match(yaml, /run: npm run lint/);
      assert.doesNotMatch(yaml, /run: false/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("writes nothing when parseBar would reject the result", () => {
    const d = mkdtempSync(path.join(tmpdir(), "molt-iv-bad-"));
    try {
      const current = {
        version: 1 as const,
        checks: [
          {
            name: "broken",
            kind: "command" as const,
            run: "",
            timeoutMs: 120_000,
            expectExit: 0,
            tags: [],
          },
        ],
      };
      const r = applyBarAdds(d, [{ name: "ok", run: "true" }], current);
      assert.equal(r.ok, false);
      assert.equal(existsSync(path.join(d, ".molt", "done.yml")), false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("the stream still names each check", () => {
  it("renders compact per-check rows under the proof headline", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const fn = ui.slice(ui.indexOf("function proofBlock"));
    const body = fn.slice(0, fn.indexOf("\nfunction "));
    assert.match(body, /for \(const c of rows\)/, "the headline is all that remains");
    assert.match(body, /cname/, "a row of PASS with no name");
    assert.match(body, /c\.output \|\| c\.detail/, "hid what the check said");
    assert.match(body, /c\.durationMs/, "hid how long it took");
    const css = readFileSync(path.join(repoRoot(), "ui", "styles.css"), "utf8");
    assert.match(css, /\.proof \.check \{/, "rows with no stylesheet");
  });
});

describe("Escape closes the innermost surface first", () => {
  it("orders confirm, then picker, then interview, then criteria", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const handler = ui.slice(ui.indexOf('if (e.key !== "Escape") return;'));
    const confirm = handler.indexOf('$("confirm")');
    const picker = handler.indexOf('$("picker")');
    const interview = handler.indexOf('$("interview-panel")');
    const criteria = handler.indexOf('$("criteria")');
    assert.ok(confirm >= 0 && picker > confirm, "picker closed before the permission prompt");
    assert.ok(interview > picker, "interview closed before the picker");
    assert.ok(criteria > interview, "criteria closed before the interview");
  });
});

describe("/clear drops a held spec, not just the stream", () => {
  it("forgets the pending task, the panel, and the interview", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const clear = ui.slice(ui.indexOf('case "/clear"'));
    const body = clear.slice(0, clear.indexOf("case \"/init\""));
    assert.match(body, /pendingTask = null/, "a held spec-first task would survive a reset");
    assert.match(body, /pendingBarAdds = \[\]/, "Seal into bar stayed armed");
    assert.match(body, /rows = \[\]/, "drafted checks would apply to the next Run");
    assert.match(body, /closeInterview\(\)/, "the interview panel stayed on screen");
    assert.match(body, /lastProof = undefined/, "the spine would keep lighting yesterday's bar");
  });
});

/**
 * The window judges an endpoint by the same rule the terminal does.
 *
 * `endpointProblem()` guarded the `--url` flag and the engine's retry loop
 * from the day it was written, and Settings — the one surface where a base URL
 * is typed by hand, with no shell history to copy it from — called neither.
 * `localhost:11434/v1` with the scheme left off was accepted, stored by
 * `saveEndpoint`, and then failed four retries deep looking like a dead
 * network. The judgement now lives in `src/endpoint.ts`, free of `node:fs`, so
 * the renderer imports the rule rather than growing a second one.
 */
describe("a bad endpoint is refused where it is typed", () => {
  /**
   * Everything before `needle`, which has to be there.
   *
   * Ordering was written here as `a > 0 && a < b` over `indexOf` results, and
   * the mutation check found the hole: the only values those expressions can
   * take are -1 and a real offset, so `>` and `>=` are indistinguishable and
   * the comparison proved nothing. Asked as a substring question instead,
   * which is both mutable and stricter — what must follow the guard may not
   * appear before it at all, rather than merely later than its first mention.
   */
  function textBefore(hay: string, needle: string, why: string): string {
    assert.ok(hay.includes(needle), why);
    return hay.slice(0, hay.indexOf(needle));
  }

  it("asks the shared rule instead of reimplementing it", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    // The intent, not the spelling: the window asks the shared module. Naming
    // the exact import list made this fail the moment the shared module grew a
    // better entry point — a test breaking on a rename it should not care
    // about, which is the same fault as pinning the body of a function.
    assert.match(
      ui,
      /from "\.\.\/src\/endpoint\.js"/,
      "the window must import the rule the CLI and engine use",
    );
    assert.doesNotMatch(
      ui,
      /function (endpointProblem|expandEndpointShorthand)\b/,
      "…and must not grow its own copy of it",
    );
    assert.match(ui, /function endpointFieldProblem\(\)/, "one place reads the box");
  });

  it("refuses on save, before the session opens or the address is stored", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const open = ui.slice(ui.indexOf('$("set-open").addEventListener'));
    const body = open.slice(0, open.indexOf('$("set-theme")'));
    const untilGuard = textBefore(body, "endpointFieldProblem()", "the save path never asks");
    assert.doesNotMatch(untilGuard, /molt\.openSession\(/, "a bad endpoint reached openSession");
    assert.doesNotMatch(
      untilGuard,
      /molt\.saveEndpoint\(/,
      "a bad endpoint was written to the config for the next launch to inherit",
    );
    // …and both still happen, after it. A guard that passes by having removed
    // the work is not a guard.
    assert.match(body, /molt\.openSession\(/, "the save path stopped opening a session");
    assert.match(body, /molt\.saveEndpoint\(/, "the save path stopped storing the endpoint");
    // The message shown is the rule's own words, not a second phrasing that
    // drifts from the one the terminal prints for the same string.
    assert.match(body, /\$\("set-status"\)\.textContent = wrong;/);
  });

  it("leaves the typed text alone so it can be corrected", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const open = ui.slice(ui.indexOf('$("set-open").addEventListener'));
    const body = open.slice(0, open.indexOf('$("set-theme")'));
    assert.doesNotMatch(
      body,
      /\$\("set-url"\) as HTMLInputElement\)\.value = /,
      "the refusal cleared or rewrote the field the person must edit",
    );
    // Judged on save, never on keystrokes: every URL is invalid halfway
    // through being typed.
    assert.doesNotMatch(
      ui,
      /\$\("set-url"\)\.addEventListener\(\s*"input"/,
      "typing in the endpoint box must stay free of judgement",
    );
  });

  it("surfaces a stored endpoint it would refuse as soon as the window opens", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const boot = ui.slice(ui.indexOf("async function boot()"));
    const untilCheck = textBefore(
      boot,
      "endpointFieldProblem()",
      "a config full of nonsense looks fine until you click",
    );
    assert.match(
      untilCheck,
      /molt\.storedEndpoint\(\)/,
      "the stored endpoint is judged before it has been read",
    );
    assert.match(boot, /if \(storedWrong\) \$\("set-status"\)\.textContent = storedWrong;/);
  });

  it("says the same thing about the same string, wherever it is said", () => {
    // The empty case used to end "pass --url", which is advice you cannot take
    // in a window: it is printed beside the very box it is telling you to pass.
    const empty = endpointProblem("") ?? "";
    assert.doesNotMatch(empty, /--url/, "a flag name leaked into a message the window shows");
    assert.doesNotMatch(empty, /\/login/, "a slash command leaked into it too");
    assert.match(empty, /no endpoint is set/);
    // Still one function, still the same verdicts.
    // The mistake people actually make: the scheme left off. `new URL` parses
    // it — as the scheme "localhost" — so it is the scheme branch that catches
    // it, and that is the sentence the window shows.
    assert.match(endpointProblem("localhost:11434/v1") ?? "", /scheme 'localhost'/);
    assert.match(endpointProblem("just some words") ?? "", /is not an endpoint/);
    assert.match(endpointProblem("ftp://example.com/v1") ?? "", /scheme 'ftp'/);
    assert.equal(endpointProblem("http://localhost:11434/v1"), null);
    assert.equal(endpointProblem("  https://api.openai.com/v1  "), null);
  });

  it("is still reachable through providers.ts, which the engine and CLI ask", () => {
    assert.equal(fromProviders, endpointProblem, "the re-export drifted into a copy");
  });

  /**
   * `storedEndpoint()` answers `{}` when nothing has been saved, so the window
   * asks about `stored.baseUrl` — which is `undefined`, not "". The guard that
   * absorbs it is the reason a first launch says "no endpoint is set" instead
   * of throwing on `.trim()` of undefined.
   */
  it("treats a missing endpoint as an empty one rather than throwing", () => {
    const missing = (undefined as unknown as string);
    assert.match(endpointProblem(missing) ?? "", /no endpoint is set/);
    assert.match(endpointProblem(null as unknown as string) ?? "", /no endpoint is set/);
  });

  /**
   * `--url claude-code` expanded to the sentinel at the flag since the
   * shorthand was written. Nowhere else that took a base URL knew the word,
   * so typing it into Settings was refused as "not an endpoint" — the exact
   * complaint this test would have caught before it shipped.
   */
  it("expands the 'claude-code' shorthand the same way everywhere", () => {
    assert.equal(expandEndpointShorthand("claude-code"), CLAUDE_CODE_URL);
    assert.equal(expandEndpointShorthand("  claude-code  "), CLAUDE_CODE_URL);
    // Only the short spelling is rewritten; the long one and anything else
    // pass through untouched.
    assert.equal(expandEndpointShorthand(CLAUDE_CODE_URL), CLAUDE_CODE_URL);
    assert.equal(expandEndpointShorthand("https://api.openai.com/v1"), "https://api.openai.com/v1");
    assert.equal(expandEndpointShorthand(""), "");
    // The bug: typed and handed to `endpointProblem` unexpanded, "claude-code"
    // is not a URL at all.
    assert.match(endpointProblem("claude-code") ?? "", /is not an endpoint/);
    // Expanded first, as every caller must, it is accepted.
    assert.equal(endpointProblem(expandEndpointShorthand("claude-code")), null);
  });

  it("expands the shorthand in the window before it is judged or used", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    assert.match(
      ui,
      /return expandEndpointShorthand\(/,
      "the window stopped expanding 'claude-code' before using the box",
    );
    /**
     * Judged by running it, not by matching the line that implements it.
     *
     * This used to assert the source text of the guard. That assertion still
     * passes if `endpointFieldValue` quietly stops expanding — the line it
     * matches never changes — so it pinned a call site while reading like it
     * pinned behaviour, and `mutation` could not catch it, because it ran
     * against a string read off disk rather than executed code.
     */
    assert.equal(typedEndpointProblem("claude-code"), null, "the shorthand must be accepted");
    assert.equal(typedEndpointProblem("  claude-code  "), null, "however it is spaced");
    assert.equal(typedEndpointProblem("https://api.openai.com/v1"), null);
    assert.equal(typedEndpointProblem(""), null, "an empty box is not a problem yet");
    assert.match(
      typedEndpointProblem("just some words") ?? "",
      /is not an endpoint/,
      "and text that is not an endpoint is still refused",
    );
    // …and opened through it: a session must not be handed the bare word.
    const open = ui.slice(ui.indexOf('$("set-open").addEventListener'));
    const body = open.slice(0, open.indexOf('$("set-theme")'));
    assert.match(
      body,
      /const baseUrl = endpointFieldValue\(\);/,
      "typing 'claude-code' and opening would send the literal word to the engine",
    );
  });

  it("refuses before it spends a round trip on an address it cannot speak to", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const refresh = ui.slice(ui.indexOf('$("set-refresh").addEventListener'));
    const body = refresh.slice(0, 600);
    const untilGuard = textBefore(body, "endpointFieldProblem()", "the refresh path never asks");
    assert.doesNotMatch(
      untilGuard,
      /fillModelSelect\(true\)/,
      '"Models refreshed." over an endpoint molt refuses',
    );
    assert.match(body, /fillModelSelect\(true\)/, "refresh stopped asking the endpoints at all");
  });

  /**
   * The renderer is not executed by `npm test` — it is a browser bundle, and
   * this suite is Node. So the lines the window's refusal is made of are
   * pinned as the source that ships. Without this, inverting the ternary or
   * dropping the `!` changes real behaviour and every check stays green.
   */
  it("pins the lines the refusal is actually made of", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    // Wiring is the one thing only the source can answer: does the window ask
    // at all, and does it hand over what the person typed?
    assert.match(
      ui,
      /return typedEndpointProblem\(\(\$\("set-url"\) as HTMLInputElement\)\.value\)/,
      "the guard stopped reading the endpoint box",
    );
    // Whether the answer is right is a question for the function itself.
    assert.match(typedEndpointProblem("not a url") ?? "", /is not an endpoint/);
    assert.equal(typedEndpointProblem("http://localhost:11434/v1"), null);
    assert.match(
      ui,
      /if \(!endpointFieldProblem\(\)\) \{/,
      "a failed model lookup clobbers the endpoint message again",
    );
  });

  /**
   * The window's half of this is driven by `--self-drive`, which `npm test`
   * cannot execute — so the conditions that decide whether the refusal was
   * correct are pinned as source. Without this, `&&` becomes `||` in the
   * harness and every one of the three requirements below is satisfied by any
   * one of them: a window that refused nothing but stayed on the Settings tab
   * would pass.
   */
  it("makes the e2e verdict require all three things it claims to check", () => {
    const main = readFileSync(path.join(repoRoot(), "electron", "main.ts"), "utf8");
    const verdict = main.slice(main.indexOf("const refusedOk ="));
    const expr = verdict.slice(0, verdict.indexOf(";") + 1);
    assert.match(expr, /uses the scheme 'localhost'/, "the message is not checked");
    assert.match(expr, /refused\.left === badUrl/, "the typed text is not checked");
    assert.match(expr, /refused\.tab === "settings"/, "the session opening is not checked");
    assert.equal((expr.match(/&&/g) ?? []).length, 3, "the conjuncts must all be required");
    assert.doesNotMatch(expr, /\|\|/, "any one of them would satisfy the whole verdict");
    // And the harness must act on it, rather than printing a verdict it ignores.
    assert.match(verdict.slice(0, 900), /if \(!refusedOk\)[\s\S]{0,300}app\.exit\(1\)/);
  });
});

/**
 * The spine is hidden only when it was explicitly put away.
 *
 * Flagged by the mutation check on a line nothing asserted: flipping `!==` to
 * `===` starts every window with the one surface that is unique to molt
 * collapsed, and no test noticed. `npm test` cannot execute the renderer, so
 * the default is pinned where the window's other renderer rules are — as the
 * source it ships.
 */
describe("the spine's default state", () => {
  it("opens unless localStorage says off", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    assert.match(
      ui,
      /setSpineOpen\(localStorage\.getItem\("molt\.spine"\) !== "off"\)/,
      "a missing or unknown value must open the spine, not hide it",
    );
    // The other half of the round trip: what the toggle stores is what this
    // reads back, so "off" is the only string that can ever suppress it.
    assert.match(ui, /localStorage\.setItem\("molt\.spine", open \? "on" : "off"\)/);
  });
});

describe("a backend molt knows is dead is refused at the door", () => {
  /**
   * Reported as "in settings when using use my google plan it links to google
   * cli". Two faults met there.
   *
   * `usePlan` reported a failure and returned, leaving `set-url` exactly as it
   * was — often a different vendor's address — so the screen implied a switch
   * that had not happened and "Open workspace" then used whatever was in the
   * box.
   *
   * And the door never asked. molt has a health check for every CLI backend
   * and did not consult it before opening, so a workspace could open on
   * `gemini-cli`, where molt's own health reports Google's withdrawal of the
   * product, and the person found out a turn later from an error that reads
   * like the model's rather than the address's.
   */
  it("says which endpoint is still selected when a plan is refused", () => {
    const ui = readFileSync(path.join(repoRoot(), "ui", "app.ts"), "utf8");
    const plan = ui.slice(ui.indexOf("async function usePlan"));
    const refused = plan.slice(0, plan.indexOf("($(\"set-url\") as HTMLInputElement).value = h.url"));
    assert.match(refused, /The endpoint is unchanged/, "a refusal must not imply a switch");
    assert.match(refused, /No endpoint is selected/, "…including when the box is empty");
  });

  it("consults the same health the buttons do before opening a session", () => {
    const main = readFileSync(path.join(repoRoot(), "electron", "main.ts"), "utf8");
    assert.match(main, /async function backendRefusal/, "the door needs an opinion");
    assert.match(
      handlerBody(main, "session:open"),
      /await backendRefusal\(opts\.baseUrl\)/,
      "session:open must ask before it opens",
    );
    // The three CLI backends, so door and button can never disagree.
    const fn = main.slice(main.indexOf("async function backendRefusal"));
    for (const probe of ["claudeCodeHealth", "agyHealth", "acpHealth"]) {
      assert.match(fn.slice(0, 900), new RegExp(probe), `${probe} is not consulted`);
    }
  });

  /** A health check that cannot run is not a reason to refuse a workspace. */
  it("does not refuse when the health check itself fails", () => {
    const main = readFileSync(path.join(repoRoot(), "electron", "main.ts"), "utf8");
    const fn = main.slice(main.indexOf("async function backendRefusal"));
    assert.match(fn.slice(0, 1200), /catch\s*\{/, "a thrown probe must not close the door");
  });
});
