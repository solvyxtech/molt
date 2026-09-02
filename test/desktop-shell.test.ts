/**
 * The desktop shell's own checks.
 *
 * `npm test` is the engine's suite. These cover the window's IPC and chrome —
 * the parts that have never been run on two of the three platforms they ship
 * to, and that a green engine suite cannot see.
 */
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
import { providerName } from "../src/providers.js";
import {
  INTERVIEW_MAX_ROUNDS,
  applyBarAdds,
  parseInterviewReply,
  parseQuestions,
} from "../electron/interview.js";
import { parseBar } from "../src/bar.js";

/** The nearest ancestor holding a package.json. */
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
    const open = src.slice(src.indexOf('"session:open"'));
    assert.match(open.slice(0, 900), /refreshPricing\(/, "no price lookup when a workspace opens");
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
