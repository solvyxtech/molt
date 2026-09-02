/**
 * The desktop shell.
 *
 * molt's engine is the product; this process exists to own it and to keep it
 * out of the window. Everything that reads a file, spawns a process, or talks
 * to a provider runs here, in Node, exactly as it does under the CLI — the
 * renderer is given a stream of events and a way to answer questions, and
 * nothing else. `contextIsolation` is on and `nodeIntegration` is off, so a
 * page that somehow rendered hostile text still cannot reach the filesystem.
 *
 * The engine is imported unmodified from `src/`. That is the whole point: the
 * GUI is a second surface over the same core, not a reimplementation of it,
 * and a proof the terminal produced and a proof the window produced are the
 * same proof because they came from the same code.
 */
import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } from "electron";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { resolveReceipt } from "./receipts-path.js";
import { sessionOpenReject } from "./session-open.js";
import { keyFor } from "./endpoint-key.js";
import { draftCriteria, type Draft } from "./criteria.js";
import {
  applyBarAdds,
  interviewTurn,
  parseQuestions,
  projectScripts,
  sanitizeAnswers,
  INTERVIEW_MAX_ROUNDS,
  type InterviewAnswer,
  type InterviewQuestion,
} from "./interview.js";
import { runOptions, shouldRefreshPrice } from "./run-options.js";
import { desktopSurfaces } from "./theme-surfaces.js";
import { barInitText, parseJournal, mutatesSession } from "./limits.js";
import { resolvePath, PATH_PROBE, type PathFixReport } from "./login-path.js";
import { Engine, MAX_STEPS } from "../src/engine.js";
import { Archive } from "../src/archive.js";
import { Receipts } from "../src/receipts.js";
import { Journal } from "../src/journal.js";
import { Integrity } from "../src/integrity.js";
import { buildRepoMap } from "../src/repomap.js";
import { loadBar, BarError, writeDefaultBar, BAR_FILENAME } from "../src/bar.js";
import type { Bar, Check } from "../src/types.js";
import { AUTONOMY_LEVELS, AUTONOMY_SUMMARY, isAutonomy, type Autonomy } from "../src/autonomy.js";
import { getTheme, THEMES, DEFAULT_THEME } from "../src/theme.js";
import {
  readAuth,
  saveKey,
  saveEndpoint,
  storedEndpoint,
  providerName,
  isSelfHosted,
  modelSources,
  fetchPricing,
  savePricing,
  PROVIDERS,
} from "../src/providers.js";
import type { EngineEvent } from "../src/types.js";
import { COMMANDS } from "../src/commands.js";
import { runEngineCommand } from "./commands.js";
import {
  readEndpoints,
  rememberEndpoint,
  forgetEndpoint,
  normalizeUrl,
  configDir,
} from "./endpoints.js";

/**
 * Where this bundle sits on disk.
 *
 * `__dirname`, not `import.meta.url`: the main process ships as CommonJS
 * because that is what Electron's loader wants without ceremony, and
 * `import.meta` is *empty* there rather than an error. The preload path and
 * the page path are both built from this, so an empty value does not fail the
 * build — it produces a window with no bridge and a blank page, which is a
 * far worse way to find out.
 */
declare const __dirname: string;
const here = __dirname;

/** The window, once there is one. Single-window app by design. */
let win: BrowserWindow | null = null;

/**
 * Everything a turn needs, rebuilt whenever the workspace or model changes.
 *
 * Held as one object rather than several loose variables so that swapping
 * workspace can never leave a receipt writer pointed at the previous one —
 * a class of bug that costs you the evidence trail silently.
 */
type Session = {
  engine: Engine;
  cwd: string;
  model: string;
  baseUrl: string;
  provider: string;
  bar: Bar | null;
  barError: string | null;
  journal: Journal;
  receipts: Receipts;
};

let session: Session | null = null;
/**
 * Autonomy outlives a session.
 *
 * It is a decision about this machine, not about this workspace, and reopening
 * a project should not quietly hand the model more or less rope than you last
 * granted it.
 */
let autonomy: Autonomy = "medium";
/** Cancels the turn in flight. */
let running: AbortController | null = null;

/** Pending tool confirmations, keyed by the id the renderer answers with. */
const pendingConfirms = new Map<string, (ok: boolean) => void>();
let confirmSeq = 0;

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * Build a session for a workspace.
 *
 * A bar that fails to parse is reported rather than thrown: an unreadable
 * done.yml must not stop the window from opening, or a typo locks you out of
 * the tool you would fix it with. The session runs unverified and says so.
 */
function openSession(cwd: string, model: string, baseUrl: string, apiKey?: string): Session {
  let bar: Bar | null = null;
  let barError: string | null = null;
  try {
    bar = loadBar(cwd);
  } catch (e) {
    barError = e instanceof BarError ? e.message : String(e);
  }

  const journal = new Journal(cwd);
  const receipts = new Receipts(cwd);
  // The window ships a "verify evidence chain" button. Without this line the
  // engine behind it never writes a ledger, so the button answers "0 records"
  // for every session however long it ran — a check that verifies nothing
  // while being counted as one. The fourth engine option to exist on one
  // surface and not the other; see run-options.ts for the last three.
  const integrity = new Integrity(cwd);
  const provider = providerName(baseUrl);

  journal.append("session_start", {
    sessionId: journal.sessionId,
    surface: "desktop",
    provider,
    model,
    endpoint: baseUrl,
    cwd,
    bar: bar ? `${bar.checks.length} check(s)` : "none — completions unverified",
    checks: bar?.checks.map((c: Check) => c.name) ?? [],
  });

  // A rate only counts if it was recorded for the model about to run. Reusing
  // the last model's rate is how a Claude session came to be billed at grok's
  // $2/$6 and shown a total 40% under the truth — the exact failure the meter
  // exists to prevent — so a mismatch seeds nothing and waits for the fetch.
  const stored = storedEndpoint(configDir());
  const seeded = stored.priceModel === model;

  const engine = new Engine({
    journal,
    baseUrl,
    apiKey: keyFor(baseUrl, apiKey, readAuth(configDir())),
    priceInPerMtok: seeded ? stored.priceIn : undefined,
    priceOutPerMtok: seeded ? stored.priceOut : undefined,
    priceCachedInPerMtok: seeded ? stored.priceCachedIn : undefined,
    priceSource: seeded ? "stored" : undefined,
    model,
    provider,
    cwd,
    bar,
    autonomy,
    archive: new Archive(cwd),
    receipts,
    integrity,
  });

  return { engine, cwd, model, baseUrl, provider, bar, barError, journal, receipts };
}

/** What the renderer needs to draw its chrome. */
function stateOf(s: Session | null) {
  const auth = readAuth(configDir());
  return {
    open: s !== null,
    cwd: s?.cwd ?? null,
    model: s?.model ?? null,
    baseUrl: s?.baseUrl ?? null,
    provider: s?.provider ?? null,
    selfHosted: s ? isSelfHosted(s.baseUrl) : false,
    // The module-level level, not a literal. `stateOf(null)` used to answer
    // "medium" whatever you had just chosen, so with no workspace open every
    // click was accepted, echoed back as medium, and re-rendered as medium —
    // reported as "low, medium and high aren't actually selectable".
    autonomy: s?.engine.autonomy ?? autonomy,
    autonomyLevels: AUTONOMY_LEVELS.map((l) => ({ level: l, means: AUTONOMY_SUMMARY[l] })),
    checks:
      s?.bar?.checks.map((c: Check) => ({ name: c.name, kind: c.kind, tags: c.tags })) ?? [],
    barError: s?.barError ?? null,
    sessionId: s?.journal.sessionId ?? null,
    providers: Object.keys(PROVIDERS),
    keyed: Object.keys(auth),
    themes: Object.keys(THEMES),
    platform: process.platform,
    commands: COMMANDS,
  };
}

/**
 * The app's own art, for the surfaces the packager cannot reach.
 *
 * A packaged build takes its icon from the bundle — .icns on macOS, .ico in the
 * exe, a .desktop entry on Linux — but a dev run gets Electron's default atom,
 * and on Windows and Linux the window and taskbar read whatever `icon` the
 * BrowserWindow was given. The build copies `build/icon.png` to `out/icon.png`
 * beside this bundle so all three read the same file the dock does.
 *
 * Missing or unreadable returns undefined rather than throwing: `dock.setIcon`
 * rejects an empty image, and an app that refuses to start because it could not
 * decorate itself is worse than one that starts plain.
 */
function appIcon() {
  const file = join(here, "icon.png");
  if (!existsSync(file)) return undefined;
  const img = nativeImage.createFromPath(file);
  return img.isEmpty() ? undefined : img;
}

function createWindow(): void {
  win = new BrowserWindow({
    icon: appIcon(),
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    // The chrome is drawn by the page, so the frame stays out of the way —
    // but the traffic lights stay, because a window you cannot close by habit
    // is a window people distrust.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: getTheme(DEFAULT_THEME).ghost,
    show: false,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => {
    win?.show();
    console.log("[molt] window ready");
  });

  // A renderer error is silent by default: the page half-draws, nothing is
  // logged where anyone will look, and the app appears merely broken. These
  // three put it on the main process's stdout, which is where a crash report
  // or a terminal launch will actually show it.
  win.webContents.on("console-message", (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${source}:${line} ${message}`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[molt] page failed to load: ${desc} (${code}) ${url}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[molt] renderer gone: ${details.reason}`);
  });

  win.loadFile(join(here, "ui", "index.html"));

  // `--self-check` boots the real window, asks the page whether it wired
  // itself up, prints the answer and leaves. It exists because "it launches"
  // and "it works" are different claims on a machine you cannot see, and the
  // gap between them is where a support call lives. Shipping to three
  // operating systems, this is the cheapest honest answer to "is it broken?"
  // `--self-drive` goes one step further than --self-check: it opens a real
  // workspace against a real endpoint and runs one real turn, then reports what
  // reached the window. --self-check proves the page assembled; this proves the
  // chain behind it — renderer to IPC to engine to provider and back — which is
  // the part that a screenshot cannot tell you is broken.
  if (process.argv.includes("--self-drive")) {
    win.webContents.once("did-finish-load", async () => {
      const cwd = process.env.MOLT_E2E_CWD ?? "";
      const model = process.env.MOLT_E2E_MODEL ?? "stub";
      const baseUrl = process.env.MOLT_E2E_URL ?? "";
      const seen: string[] = [];

      if (process.env.MOLT_E2E_VIA_UI === "1") {
        // Drive the window the way a person does: fill Settings, open the
        // workspace, tick the box, type, click Run. Calling engine.run()
        // directly skips the preload bridge and both IPC hops — which is
        // exactly where "ask only ran the write checks anyway" would live, so
        // a test that skips them cannot see it.
        await win!.webContents.executeJavaScript(`(() => {
          document.getElementById("set-cwd").value = ${JSON.stringify(cwd)};
          document.getElementById("set-model").value = ${JSON.stringify(model)};
          document.getElementById("set-url").value = ${JSON.stringify(baseUrl)};
          document.getElementById("set-open").click();
          return 0;
        })()`);
        await new Promise((r) => setTimeout(r, 500));
        await win!.webContents.executeJavaScript(`(() => {
          // Record whether the window ever said it was working. Sampled from
          // inside the page because the turn can finish faster than a poll.
          window.__sawActivity = false;
          window.__turnDone = false;
          const obs = new MutationObserver(() => {
            if (document.querySelector("#stream .activity")) window.__sawActivity = true;
            // The end of a turn is a proof block or an error, not a button
            // changing class. Waiting on the button raced the render: the
            // stream had not painted its verdict yet, and the assertions read
            // an empty screen roughly one run in three.
            if (document.querySelector("#stream .proof, #stream .said.error"))
              window.__turnDone = true;
          });
          obs.observe(document.getElementById("stream"), { childList: true, subtree: true });
          return 0;
        })()`);
        // Criteria set through the real panel, so the path under test is the
        // one a person uses — not a shortcut into the IPC handler.
        if (process.env.MOLT_E2E_CRITERION && process.env.MOLT_E2E_AUTO !== "1") {
          await win!.webContents.executeJavaScript(`(() => {
            document.getElementById("criteria").classList.remove("hidden");
            document.getElementById("ck-add").click();
            const row = document.querySelector("#ck-rows .ck-row.check");
            const ins = row.querySelectorAll("input");
            ins[0].value = "task-gate";
            ins[0].dispatchEvent(new Event("input"));
            ins[1].value = ${JSON.stringify(process.env.MOLT_E2E_CRITERION)};
            ins[1].dispatchEvent(new Event("input"));
            return 0;
          })()`);
        }
        // A real provider runs commands, and at the default level the window
        // asks before each one — with nobody to answer. MOLT_E2E_AUTONOMY sets
        // the level through the control a person would use.
        if (process.env.MOLT_E2E_AUTONOMY) {
          await win!.webContents.executeJavaScript(`(() => {
            const want = ${JSON.stringify(process.env.MOLT_E2E_AUTONOMY)};
            const bars = [...document.querySelectorAll("#autonomy .au")];
            const idx = ["low", "medium", "high"].indexOf(want);
            if (idx >= 0 && bars[idx]) bars[idx].click();
            return 0;
          })()`);
          await new Promise((r) => setTimeout(r, 200));
        }
        await win!.webContents.executeJavaScript(`(() => {
          const task = ${JSON.stringify(process.env.MOLT_E2E_TASK ?? "say hello")};
          document.getElementById("prompt").value = ${
            process.env.MOLT_E2E_ASK === "1" ? '"? " + task' : "task"
          };
          document.getElementById("send").click();
          return 0;
        })()`);
        // Auto-draft holds for review. The first click filled the panel; a
        // second click is the person's approval and the one that starts work.
        if (process.env.MOLT_E2E_AUTO === "1") {
          let held = false;
          for (let i = 0; i < 100; i++) {
            held = await win!.webContents.executeJavaScript(
              `document.getElementById("send").classList.contains("hidden") === false && !document.getElementById("criteria").classList.contains("hidden")`,
            );
            if (held) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          if (!held) {
            console.error("[self-drive] auto-draft never held for review");
            app.exit(1);
            return;
          }
          // A held turn must not look like a refused one. The composer is
          // emptied and the message echoed, so the screen shows something
          // received and waiting rather than a Run that did nothing — and the
          // second click below therefore starts a turn from an empty box,
          // which is the path that used to need the text retyped.
          const task = process.env.MOLT_E2E_TASK ?? "say hello";
          const composer = await win!.webContents.executeJavaScript(
            `({ box: document.getElementById("prompt").value,
                echoed: document.getElementById("stream").textContent.includes(${JSON.stringify(
                  task,
                )}) })`,
          );
          const c = composer as { box: string; echoed: boolean };
          if (c.box.trim() !== "" || !c.echoed) {
            console.error(
              `[self-drive] hold left the composer as ${JSON.stringify(c.box)} (echoed=${c.echoed})`,
            );
            app.exit(1);
            return;
          }
          console.log("[self-drive] hold       composer cleared, task echoed");
          await win!.webContents.executeJavaScript(`document.getElementById("send").click()`);
        }
        // Wait for the turn to finish, seen from the page rather than guessed.
        // MOLT_E2E_WAIT_MS lengthens the wait for a real provider and a real
        // bar, which take minutes where the stub takes seconds.
        let done = false;
        const waitMs = Number(process.env.MOLT_E2E_WAIT_MS) || 30_000;
        for (let i = 0; i < waitMs / 100; i++) {
          done = await win!.webContents.executeJavaScript(
            `window.__turnDone === true && document.getElementById("send").classList.contains("hidden") === false`,
          );
          if (done) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!done) {
          console.error(`[self-drive] turn never produced a verdict within ${Math.round(waitMs / 1000)}s`);
          app.exit(1);
          return;
        }
      } else {
        const opened = openSession(cwd, model, baseUrl, "stub-key");
        session = opened;
        try {
          for await (const ev of opened.engine.run(
            process.env.MOLT_E2E_TASK ?? "say hello",
            async () => true,
            {},
          )) {
            seen.push(ev.kind);
            win!.webContents.send("engine:event", ev);
          }
        } catch (e) {
          console.error(`[self-drive] engine threw: ${String(e)}`);
          app.exit(1);
          return;
        }
      }
      // Give the renderer a tick to paint what it was sent, then ask it what
      // it actually put on screen. Counting events proves delivery; reading the
      // DOM proves rendering, and they fail independently.
      // Open the model picker before reading the DOM, so the assertions below
      // see what it listed. `/model` had no desktop equivalent at all until
      // this existed; an untested picker is how it stays that way.
      await win!.webContents.executeJavaScript(
        `(document.getElementById("crumb-model").click(), 0)`,
      );
      await new Promise((r) => setTimeout(r, 400));
      setTimeout(() => {
        void win!.webContents
          .executeJavaScript(
            `(document.querySelector('.tab[data-tab="session"]').click(), {
               sawActivity: window.__sawActivity === true,
               activityLeft: document.querySelectorAll("#stream .activity").length,
               sealedShown: document.querySelectorAll("#stream .sealed").length,
               checkNamesRun: [...document.querySelectorAll("#spine-list li[data-name]")].map((n) => n.dataset.name),
               checksRun: [...document.querySelectorAll("#spine-list li.pass, #spine-list li.fail")].length,
               checkNames: [...document.querySelectorAll("#spine-list li[data-name]")].map((n) => n.dataset.name),
               proofHead: (document.querySelector("#stream .proof h4")||{}).textContent||"",
               pickerRows: document.querySelectorAll("#picker-list button").length,
               pickerText: (document.getElementById("picker-list")||{}).textContent||"",
               pickerGroups: document.querySelectorAll("#picker-list .grp").length,
               activeTab: (document.querySelector(".tab.active")||{}).dataset?.tab,
               activePanel: (document.querySelector(".panel.active")||{}).id,
               rows: document.querySelectorAll("#stream .said").length,
               tools: document.querySelectorAll("#stream .tool").length,
               proofs: document.querySelectorAll("#stream .proof").length,
               wire: document.querySelectorAll("#wire .frame").length,
               // The wire view must show the request as the engine stated it —
               // a step number and a message count — not a placeholder.
               wireRequest: [...document.querySelectorAll("#wire .frame")].map((f) => f.textContent || "").find((t) => /messages/.test(t)) || "",
               text: (document.getElementById("stream")||{}).textContent||"",
             })`,
          )
          .then((r: Record<string, unknown>) => {
            console.log(`[self-drive] events     ${seen.join(", ")}`);
            console.log(`[self-drive] said rows  ${r.rows}`);
            console.log(`[self-drive] tool rows  ${r.tools}`);
            console.log(`[self-drive] proofs     ${r.proofs}`);
            console.log(`[self-drive] wire rows  ${r.wire} · request frame: ${String(r.wireRequest).slice(0, 60) || "MISSING"}`);
            console.log(`[self-drive] active     ${r.activeTab} / ${r.activePanel}`);
            console.log(`[self-drive] picker     ${r.pickerRows} model(s) in ${r.pickerGroups} group(s)`);
            console.log(
              `[self-drive] remembered ${
                String(r.pickerText).includes(process.env.MOLT_E2E_EXPECT_MODEL ?? "\u0000")
                  ? "second server listed"
                  : "MISSING"
              }`,
            );
            console.log(`[self-drive] activity   shown=${r.sawActivity} leftover=${r.activityLeft}`);
            console.log(`[self-drive] proof      ${r.proofHead}`);
            console.log(`[self-drive] sealed     ${r.sealedShown} block(s) · ran: ${(r.checkNamesRun as string[]).join(", ")}`);
            console.log(`[self-drive] checks     ${(r.checkNames as string[]).join(", ") || "(none)"}`);
            const text = String(r.text);
            const ok =
              Number(r.rows) > 0 &&
              text.includes(process.env.MOLT_E2E_EXPECT ?? "") &&
              /step \d+ · \d+ messages/.test(String(r.wireRequest)) &&
              Number(r.pickerRows) >= 2 &&
              // A server the app was never pointed at, only remembered, must
              // still be asked — that is the whole of the reported bug.
              (!process.env.MOLT_E2E_EXPECT_MODEL ||
                String(r.pickerText).includes(process.env.MOLT_E2E_EXPECT_MODEL)) &&
              // The window must say it is working while it works, and must
              // stop saying it afterwards. Both halves, or the indicator is
              // either invisible or permanent.
              (process.env.MOLT_E2E_VIA_UI !== "1" || r.sawActivity === true) &&
              Number(r.activityLeft) === 0 &&
              // The seal has to be visible where the work is, and the check has
              // to have actually run under its namespaced name.
              (!process.env.MOLT_E2E_CRITERION ||
                (Number(r.sealedShown) === 1 &&
                  (r.checkNamesRun as string[]).some((n) => n.startsWith("task:")))) &&
              (!process.env.MOLT_E2E_WANT_PROOF ||
                String(r.proofHead).includes(process.env.MOLT_E2E_WANT_PROOF));
            console.log(ok ? "[self-drive] PASS" : "[self-drive] FAIL");
            if (!ok) console.log(`[self-drive] screen was: ${text.slice(0, 400)}`);
            const shot = process.env.MOLT_SHOT;
            if (shot) {
              // capturePage reads the compositor, not the DOM. A tab switched
              // one statement ago has not been painted yet, and the capture
              // returns the previous frame — which is how a screenshot can
              // disagree with the assertions taken beside it.
              //
              // MOLT_SHOT_TAB picks the tab to photograph after the turn —
              // the assertions above always read the session tab, and the
              // README needs the others too.
              // The assertions above opened the model picker to read it;
              // a photograph of the work should not have a dialog over it.
              const tab = process.env.MOLT_SHOT_TAB;
              void win!.webContents.executeJavaScript(
                `(document.getElementById("picker-close")?.click(), ` +
                  `document.querySelector('.tab[data-tab=${JSON.stringify(tab || "session")}]')?.click(), 0)`,
              );
              setTimeout(
                () => {
                  void win!.webContents.capturePage().then((img) => {
                    writeFileSync(shot, img.toPNG());
                    console.log(`[self-drive] shot        ${shot}`);
                    app.exit(ok ? 0 : 1);
                  });
                },
                900,
              );
              return;
            }
            app.exit(ok ? 0 : 1);
          })
          .catch((e: unknown) => {
            console.error(`[self-drive] threw: ${String(e)}`);
            app.exit(1);
          });
      }, 300);
    });
  }

  if (process.argv.includes("--self-check")) {
    win.webContents.once("did-finish-load", async () => {
      // `did-finish-load` means the page parsed, not that the app booted.
      // boot() awaits several IPC round trips before it draws anything it
      // renders itself, so a check that reads the DOM here sees the static
      // HTML and none of the app — which looked exactly like "the autonomy
      // control renders zero bars". Wait for something JS-built to exist.
      let ready = false;
      for (let i = 0; i < 100; i++) {
        ready = await win!.webContents.executeJavaScript(
          `document.querySelectorAll("#autonomy .au").length > 0`,
        );
        if (ready) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!ready) {
        console.error("[self-check] the app never finished booting (5s)");
        console.log("[self-check] FAIL");
        app.exit(1);
        return;
      }
      void win!.webContents
        .executeJavaScript(
          `(async () => {
             const need = ["tabs","panels","stream","wire","receipt-list","log","composer","prompt","send","status","crumb-model","picker","picker-list","set-model-pick","set-model","set-url","autonomy","interview","criteria","ck-rows","ck-draft","ck-auto","spine","spine-list","jump","ctx","ctx-fill","ctx-line"];
             const missing = need.filter((id) => !document.getElementById(id));
             const tabs = [...document.querySelectorAll(".tab")].map((t) => t.dataset.tab);
             const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
             return {
               bridge: typeof window.molt === "object" && typeof window.molt.run === "function",
               missing,
               tabs,
               accent,
               panels: [...document.querySelectorAll(".panel")].length,
               // A check and a note must never be presented alike: one is
               // evidence and the other is intent, and the receipt's honesty
               // depends on a reader telling them apart at a glance.
               autoCriteriaDefault: document.getElementById("ck-auto").checked,
               criteriaRows: await (async () => {
                 document.getElementById("interview").click();
                 document.getElementById("ck-add").click();
                 document.getElementById("ck-add-note").click();
                 await new Promise((r) => setTimeout(r, 60));
                 const check = document.querySelector("#ck-rows .ck-row.check .ck-kind");
                 const note = document.querySelector("#ck-rows .ck-row.note .ck-kind");
                 const distinct =
                   !!check && !!note &&
                   getComputedStyle(check).color !== getComputedStyle(note).color &&
                   check.textContent !== note.textContent;
                 // Clicking the label converts the row.
                 check.click();
                 await new Promise((r) => setTimeout(r, 40));
                 const converted = document.querySelectorAll("#ck-rows .ck-row.note").length === 2;
                 document.querySelectorAll("#ck-rows .ck-del").forEach((b) => b.click());
                 document.getElementById("ck-hide").click();
                 return { distinct, converted };
               })(),
               autonomyButtons: document.querySelectorAll("#autonomy .au").length,
               autonomyOn: (document.getElementById("au-name")||{}).textContent||"",
               // Clicking a level must change the level. It did not: stateOf()
               // answered a hardcoded "medium" with no session open, so every
               // click was echoed back as medium and re-rendered as medium.
               autonomySticks: await (async () => {
                 const bars = document.querySelectorAll("#autonomy .au");
                 if (bars.length !== 3) return false;
                 bars[2].click();
                 await new Promise((r) => setTimeout(r, 150));
                 const name = (document.getElementById("au-name")||{}).textContent;
                 const lit = document.querySelectorAll("#autonomy .au.lit").length;
                 bars[1].click();
                 await new Promise((r) => setTimeout(r, 150));
                 return name === "high" && lit === 3;
               })(),
               paletteRows: await (async () => {
                 document.querySelector('.tab[data-tab="session"]').click();
                 const box = document.getElementById("prompt");
                 box.value = "/";
                 box.dispatchEvent(new Event("input"));
                 await new Promise((r) => setTimeout(r, 60));
                 const n = document.querySelectorAll("#palette-rows button").length;
                 // And it must close when the prompt is no longer showing one.
                 document.querySelector('.tab[data-tab="settings"]').click();
                 const leaked = document.getElementById("palette").classList.contains("hidden")
                   ? 0
                   : 1000;
                 box.value = "";
                 box.dispatchEvent(new Event("input"));
                 return n - leaked;
               })(),
               nulRoundTrip: (() => {
                 const o = new Option("x", "a/b" + String.fromCharCode(0) + "http://h:1/v1");
                 const p = o.value.split(String.fromCharCode(0));
                 return p.length === 2 && p[0] === "a/b" && p[1] === "http://h:1/v1";
               })(),
               // A meta tag that is present but not enforced is how this used
               // to pass: we read the header and assumed it meant something.
               // securitypolicyviolation fires only when the policy actually
               // refused the action — a network error is a different event.
               csp: await (async () => {
                 const seen = [];
                 const on = (e) => seen.push(e.violatedDirective);
                 document.addEventListener("securitypolicyviolation", on);
                 const s = document.createElement("script");
                 s.textContent = "void 0";
                 document.head.appendChild(s);
                 try { await fetch("https://example.com/"); } catch {}
                 await new Promise((r) => setTimeout(r, 80));
                 document.removeEventListener("securitypolicyviolation", on);
                 const dirs = seen.join(" ");
                 return {
                   script: /script-src/.test(dirs),
                   connect: /connect-src|default-src/.test(dirs),
                   dirs,
                 };
               })(),
             };
           })()`,
        )
        .then((r: Record<string, unknown>) => {
          const ok =
            r.bridge === true &&
            Array.isArray(r.missing) &&
            r.missing.length === 0 &&
            Array.isArray(r.tabs) &&
            r.tabs.length === 5 &&
            r.nulRoundTrip === true &&
            r.autonomyButtons === 3 &&
            String(r.autonomyOn).length > 0 &&
            r.autonomySticks === true &&
            r.autoCriteriaDefault === true &&
            (r.criteriaRows as { distinct: boolean; converted: boolean }).distinct === true &&
            (r.criteriaRows as { distinct: boolean; converted: boolean }).converted === true &&
            Number(r.paletteRows) >= 15 &&
            (r.csp as { script?: boolean; connect?: boolean } | undefined)?.script === true &&
            (r.csp as { script?: boolean; connect?: boolean } | undefined)?.connect === true;
          console.log(`[self-check] bridge      ${r.bridge ? "ok" : "MISSING"}`);
          console.log(`[self-check] elements    ${(r.missing as string[]).length === 0 ? "ok" : "missing " + (r.missing as string[]).join(", ")}`);
          console.log(`[self-check] tabs        ${(r.tabs as string[]).join(", ")}`);
          console.log(`[self-check] panels      ${r.panels}`);
          console.log(`[self-check] accent      ${r.accent}`);
          console.log(`[self-check] option key  ${r.nulRoundTrip ? "ok" : "NUL LOST"}`);
          console.log(
            `[self-check] autonomy    ${r.autonomyButtons} bars, at: ${r.autonomyOn || "NONE"}` +
              `, click sticks: ${r.autonomySticks}`,
          );
          console.log(`[self-check] palette     ${r.paletteRows} command(s) on "/"`);
          const ck = r.criteriaRows as { distinct: boolean; converted: boolean };
          console.log(
            `[self-check] criteria    check/note distinct: ${ck.distinct}, convertible: ${ck.converted}` +
              `, automatic: ${r.autoCriteriaDefault}`,
          );
          const csp = r.csp as { script?: boolean; connect?: boolean; dirs?: string } | undefined;
          console.log(
            `[self-check] csp         inline ${csp?.script ? "refused" : "RAN"} · fetch ${csp?.connect ? "refused" : "ALLOWED"}` +
              (csp?.dirs ? ` (${csp.dirs})` : ""),
          );
          console.log(ok ? "[self-check] PASS" : "[self-check] FAIL");
          // A screenshot on demand, because "PASS" says the page assembled and
          // says nothing about whether it is legible. Support asks for one of
          // these on the first call every time.
          const shot = process.env.MOLT_SHOT;
          if (shot) {
            if (process.env.MOLT_SHOT_PICKER === "1") {
              void win!.webContents.executeJavaScript(
                `(document.getElementById("crumb-model").click(), 0)`,
              );
            }
            if (process.env.MOLT_SHOT_PALETTE === "1") {
              void win!.webContents.executeJavaScript(
                `(() => { document.querySelector('.tab[data-tab="session"]').click();
                          const b = document.getElementById("prompt");
                          b.value = "/"; b.dispatchEvent(new Event("input")); return 0; })()`,
              );
            }
            setTimeout(
              () => {
                void win!.webContents.capturePage().then((img) => {
                  writeFileSync(shot, img.toPNG());
                  console.log(`[self-check] shot        ${shot}`);
                  app.exit(ok ? 0 : 1);
                });
              },
              process.env.MOLT_SHOT_PICKER === "1" ? 1200 : 120,
            );
            return;
          }
          app.exit(ok ? 0 : 1);
        })
        .catch((e: unknown) => {
          console.error(`[self-check] threw: ${String(e)}`);
          app.exit(1);
        });
    });
  }

  // A link in model output opens in the browser, never in the app frame —
  // navigating the shell away from the app is unrecoverable.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

/**
 * Ask the user's login shell for its PATH, once, at startup.
 *
 * `spawnSync` here and nowhere else. molt's rule against it exists because a
 * synchronous spawn stops the event loop for the life of the call, which froze
 * the TUI for the whole of every bash call. This runs before the window is
 * created and before any session exists, so there is no loop to starve and
 * nothing to render — and it must finish before the first check can spawn,
 * which is exactly what a synchronous call guarantees and an async one would
 * make a race.
 */
function fixPath(): PathFixReport {
  const report = resolvePath({
    current: process.env.PATH,
    // node, not npm: every bar check ultimately needs it, and a project whose
    // checks are cargo or make still needs the directory node came from.
    cmd: "node",
    platform: process.platform,
    home: process.env.HOME,
    probe: () => {
      if (process.platform === "win32") return null;
      const shell = process.env.SHELL || "/bin/sh";
      try {
        const r = spawnSync(shell, ["-ilc", PATH_PROBE], {
          encoding: "utf8",
          timeout: 3000,
          // An rc file that reads from stdin would otherwise hang until the
          // timeout on every launch.
          stdio: ["ignore", "pipe", "ignore"],
        });
        return r.stdout ?? null;
      } catch {
        return null;
      }
    },
  });
  if (report.outcome !== "already-usable" && report.path) process.env.PATH = report.path;
  return report;
}

const pathFix = fixPath();

app.whenReady().then(() => {
  if (pathFix.outcome === "already-usable") {
    console.log("[molt] PATH already resolves node");
  } else if (pathFix.added.length) {
    console.log(`[molt] PATH ${pathFix.outcome}: added ${pathFix.added.join(", ")}`);
  } else {
    console.error("[molt] PATH could not be repaired — bar checks may fail with exit 127");
  }
  // macOS reads the dock icon from the bundle, which an unpackaged run has not
  // got — so `npm run app` would otherwise show Electron's atom in the dock.
  if (process.platform === "darwin" && !app.isPackaged) {
    const icon = appIcon();
    if (icon) app.dock?.setIcon(icon);
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle("app:state", () => stateOf(session));

ipcMain.handle("app:theme", (_e, name: string) => {
  const t = getTheme(name);
  // The seven palette colours plus the five surfaces the window paints on.
  // Sent together so a theme can never be half-applied — which is what left
  // mono and slate wearing tidepool's backgrounds.
  return { ...t, ...desktopSurfaces(t) };
});

ipcMain.handle("workspace:pick", async () => {
  const r = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    message: "Choose the project molt will work in",
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle(
  "session:open",
  (_e, opts: { cwd: string; model: string; baseUrl: string; apiKey?: string }) => {
    const refuse = sessionOpenReject(opts, running !== null);
    if (refuse) return { ok: false, error: refuse };
    try {
      session = openSession(opts.cwd, opts.model, opts.baseUrl, opts.apiKey);
      rememberEndpoint(opts.baseUrl, opts.model);
      // The map of this workspace, so the first turn does not spend four
      // steps discovering what is here. Quietly, and off the open path.
      void primeRepoMap(session);
      // Quietly at open: the endpoint is already named in the title bar, and
      // an unprompted price line is not what you are looking at just then.
      void refreshPricing(session, false);
      return { ok: true, state: stateOf(session) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
);

/**
 * Build this workspace's repository map and give it to the engine.
 *
 * Off the open path because it walks the disk and the window must not wait
 * for it. Dropped rather than applied if a turn has already started: the
 * system message is the cached prefix, and rewriting it mid-turn throws away
 * the cache that turn is in the middle of using.
 */
async function primeRepoMap(target: Session): Promise<void> {
  // Same rule as the terminal: a model you are hosting yourself is, today, a
  // small one, and a repo map makes a small model browse rather than work.
  // Measured both ways — see defaultMapTokens in src/cli.tsx.
  if (isSelfHosted(target.baseUrl)) return;
  try {
    const map = await buildRepoMap(target.cwd);
    if (session === target && running === null && map.text) target.engine.setRepoMap(map.text);
  } catch {
    /* a map is a hint; the session is fine without one */
  }
}

/**
 * Ask the endpoint what it charges, and tell the engine.
 *
 * The window never did this. The CLI has asked since it grew a meter — prices
 * come from the endpoint that will do the billing rather than from a table
 * molt ships — but the desktop only ever *read* `engine.pricing()`, for the
 * `/price` command, and nothing ever wrote it. So `costUsd()` returned
 * undefined, the renderer's `if (s.costUsd !== null)` never fired, and the
 * status bar showed tokens and cached with no money beside them. Anthropic
 * hid it: its rates are carried in `providers.ts` because it publishes no
 * price API, so a session against Claude found a price anyway and a session
 * against grok — which does publish one, at /language-models — found none.
 *
 * Not awaited by its callers. It is a network round trip, and a workspace must
 * open whether or not a price list answers.
 */
/** The model a "publishes no price" line has already been shown for. */
let noPriceAnnouncedFor: string | null = null;

async function refreshPricing(s: Session, announce: boolean): Promise<void> {
  const model = s.model;
  if (!model) return;
  const p = await fetchPricing(s.baseUrl, model, s.engine.apiKey).catch(() => null);
  if (p) {
    s.engine.setPricing({ in: p.in, out: p.out, cached: p.cached, source: p.source });
    savePricing(model, p, configDir());
    if (announce)
      send("engine:event", {
        kind: "info",
        text:
          `pricing · $${p.in}/M in` +
          (p.cached === undefined ? "" : ` · $${p.cached}/M cached`) +
          ` · $${p.out}/M out · from ${p.source}`,
      });
    return;
  }
  // Nothing published for this model. Any rate still set was recorded for a
  // different one, so it is cleared rather than quietly applied to this.
  const stored = storedEndpoint(configDir());
  if (stored.priceModel !== model && s.engine.pricing().in !== undefined) {
    s.engine.setPricing({});
    savePricing(model, null, configDir());
    if (announce)
      send("engine:event", {
        kind: "info",
        text: `${s.provider} publishes no price for ${model} — the meter will show tokens only. The previous model's rate does not carry over.`,
      });
  } else if (announce) {
    send("engine:event", {
      kind: "info",
      text: `${s.provider} publishes no price for ${model} — the meter will show tokens only.`,
    });
  }
}

/**
 * An engine to ask an endpoint what it serves.
 *
 * The live session's engine when there is one, so a probe uses the same
 * transport the work will; a throwaway otherwise, because the model picker has
 * to work *before* a workspace is open — that is when you need it most.
 */
function prober(baseUrl: string, apiKey?: string): Engine {
  if (session && session.baseUrl === baseUrl) return session.engine;
  return new Engine({ baseUrl, apiKey, model: "probe", bar: null });
}

/**
 * Every model you could pick, from every endpoint you hold a key for.
 *
 * This is `/model` from the terminal. The desktop shipped without it: Settings
 * had a free-text model field seeded from the last endpoint, so the only model
 * you could reach was the one you used last, and the only way to change it was
 * to know an id by heart and type it. Reported as "no model select and no
 * models loaded".
 *
 * Endpoints are asked in parallel and failures are kept rather than dropped —
 * an endpoint that refuses is a thing you want to see in the list, with its
 * reason, not a provider that silently vanished.
 */
ipcMain.handle("models:list", async (_e, current?: { url: string; key?: string }) => {
  const auth = readAuth(configDir());
  const stored = storedEndpoint(configDir());
  const hereUrl = normalizeUrl(
    current?.url || session?.baseUrl || stored.baseUrl || "",
  );
  const sources = modelSources(auth, hereUrl ? { url: hereUrl, key: current?.key } : undefined);

  // Every server this window has been pointed at, not just the one it is
  // pointed at now. The CLI's config holds a single endpoint, which is right
  // for a terminal and wrong for a list: a second machine on the network was
  // simply never asked, so its models could not appear.
  const known = readEndpoints().map((e) => e.url);
  const seen = new Set(sources.map((s) => normalizeUrl(s.url)));
  const extra = known
    .filter((u) => !seen.has(u))
    .map((u) => ({ name: providerName(u), url: u, key: undefined as string | undefined }));

  return Promise.all(
    [...sources, ...extra].map(async (src) => {
      const key = src.key ?? (normalizeUrl(src.url) === hereUrl ? current?.key : undefined);
      const r = await prober(src.url, key).listModels(src.url, key);
      const local = isSelfHosted(src.url);
      return r.ok
        ? {
            name: src.name,
            url: src.url,
            ok: true as const,
            ids: r.ids,
            needsKey: false,
            local,
            remembered: !seen.has(normalizeUrl(src.url)),
          }
        : {
            name: src.name,
            url: src.url,
            ok: false as const,
            ids: [],
            // A local server that needs no key is not "no key stored"; it is
            // off, or listening somewhere else. Saying the wrong reason sends
            // you looking for a key you never needed.
            error: r.error,
            needsKey: !key && !local,
            local,
            remembered: !seen.has(normalizeUrl(src.url)),
          };
    }),
  );
});

ipcMain.handle("endpoints:list", () => readEndpoints());
ipcMain.handle("endpoints:add", (_e, url: string, model?: string) => rememberEndpoint(url, model));
ipcMain.handle("endpoints:forget", (_e, url: string) => forgetEndpoint(url));

/**
 * Change model mid-session, without closing the workspace.
 *
 * The terminal can do this with `/model` and keep the conversation; the
 * desktop could only do it by reopening, which throws the session away. The
 * engine already supports both halves — setModel and setBaseUrl — so this is
 * wiring, not new behaviour.
 */
ipcMain.handle(
  "session:model",
  (_e, opts: { model: string; baseUrl?: string; apiKey?: string }) => {
    if (!session) return { ok: false, error: "no workspace is open" };
    if (running) return { ok: false, error: "a turn is running — stop it before switching model" };
    if (opts.baseUrl && opts.baseUrl !== session.baseUrl) {
      session.baseUrl = opts.baseUrl;
      session.provider = providerName(opts.baseUrl);
      // Without the lookup this cleared the key: `setBaseUrl` assigns whatever
      // it is handed, so picking a model from the picker with the Settings key
      // box empty — the ordinary way to switch — unauthenticated the session.
      session.engine.setBaseUrl(
        opts.baseUrl,
        keyFor(opts.baseUrl, opts.apiKey, readAuth(configDir())),
        session.provider,
      );
    } else if (opts.apiKey) {
      session.engine.setApiKey(opts.apiKey);
    }
    session.model = opts.model;
    session.engine.setModel(opts.model);
    saveEndpoint(session.baseUrl, opts.model, configDir());
    // Out loud here: you just changed what the next turn costs, and a rate
    // that changed silently is one nobody remembers agreeing to.
    void refreshPricing(session, true);
    rememberEndpoint(session.baseUrl, opts.model);
    // `note`, not a new JournalKind: src/ is the CLI's engine unmodified, and
    // adding a kind here would fork the two copies over a line of bookkeeping.
    // Worth recording at all because a receipt names the model that produced
    // the work, and a session can now change it halfway through.
    session.journal.append("note", {
      text: `model changed to ${opts.model}`,
      model: opts.model,
      endpoint: session.baseUrl,
      provider: session.provider,
    });
    return { ok: true, state: stateOf(session) };
  },
);

/**
 * How much molt may do without asking.
 *
 * The terminal has had this since before the window did; the desktop shipped
 * with no control at all, so every session ran at the default and the only way
 * to change it was not to. Journalled by the engine, because it is the one
 * setting that changes what molt is allowed to do to a machine.
 */
ipcMain.handle("session:autonomy", (_e, level: string) => {
  if (!isAutonomy(level)) return { ok: false, error: `unknown autonomy level: ${level}` };
  autonomy = level;
  session?.engine.setAutonomy(level);
  return { ok: true, state: stateOf(session), means: AUTONOMY_SUMMARY[level] };
});

/**
 * A slash command that needs the engine.
 *
 * The window handles the ones that are only about itself — tabs, theme, the
 * model picker — and sends the rest here. `unhandled` comes back for anything
 * this side does not know, which is how the renderer tells a command it should
 * have handled from one it mistyped.
 */
ipcMain.handle("command:run", async (_e, name: string, arg: string) => {
  if (!session) return { kind: "error", text: "no workspace is open" };
  // Only the forms that actually change something — `/shed --explain` computes
  // a plan and returns it without touching the transcript.
  if (running && mutatesSession(name, arg)) {
    return { kind: "error", text: `${name} changes session state — stop the turn first` };
  }
  try {
    return await runEngineCommand(session.engine, name, arg);
  } catch (e) {
    return { kind: "error", text: String(e) };
  }
});

ipcMain.handle("session:reset", () => {
  if (!session) return { ok: false, error: "no workspace is open" };
  if (running) return { ok: false, error: "a turn is running — stop it first" };
  session.engine.reset();
  return { ok: true, state: stateOf(session) };
});

ipcMain.handle("bar:init", () => {
  if (!session) return { kind: "error" as const, text: "no workspace is open" };
  try {
    const wrote = writeDefaultBar(session.cwd);
    // Re-read it, or the session goes on believing it has no bar.
    session.bar = loadBar(session.cwd);
    session.engine.setBar(session.bar);
    return {
      kind: "info" as const,
      // wrote is `{ existed }`, not a boolean. Truthy either way, so the
      // old test always claimed it had just written the file.
      text: barInitText(wrote.existed, BAR_FILENAME, session.bar?.checks.length ?? 0),
      state: stateOf(session),
    };
  } catch (e) {
    return { kind: "error" as const, text: String(e) };
  }
});

/**
 * Ask the model what would prove this task was done.
 *
 * A proposal, never a decision. What comes back is editable and has to be
 * approved before it means anything — the engine seals what the person
 * approved, not what the model suggested.
 */
ipcMain.handle("criteria:draft", async (_e, task: string) => {
  if (!session) return { ok: false, error: "no workspace is open" };
  if (!task.trim()) return { ok: false, error: "nothing to draft from" };
  return draftCriteria({
    task,
    scripts: projectScripts(session.cwd),
    barChecks: session.bar?.checks.map((c: Check) => c.name) ?? [],
    baseUrl: session.baseUrl,
    apiKey: session.engine.apiKey,
    model: session.model,
  });
});

/**
 * One round of interview. Separate from the work transcript: the model asks,
 * a person answers, and what comes back is editable checks — never a write.
 */
ipcMain.handle(
  "interview:turn",
  async (
    _e,
    opts: {
      task?: unknown;
      round?: unknown;
      history?: unknown;
    },
  ) => {
    if (!session) return { kind: "error", error: "no workspace is open" };
    if (running) return { kind: "error", error: "a turn is running — stop it first" };
    const task = typeof opts?.task === "string" ? opts.task : "";
    const round = Math.max(1, Math.min(INTERVIEW_MAX_ROUNDS, Number(opts?.round) || 1));
    const history = Array.isArray(opts?.history)
      ? (opts.history as { questions?: unknown; answers?: unknown }[])
          .slice(0, INTERVIEW_MAX_ROUNDS)
          .map((h) => ({
            questions: parseQuestions(h.questions) as InterviewQuestion[],
            answers: sanitizeAnswers(h.answers) as InterviewAnswer[],
          }))
      : [];
    return interviewTurn({
      task,
      scripts: projectScripts(session.cwd),
      barChecks: session.bar?.checks.map((c: Check) => c.name) ?? [],
      history,
      round,
      baseUrl: session.baseUrl,
      apiKey: session.engine.apiKey,
      model: session.model,
    });
  },
);

/**
 * Write proposed command checks into `.molt/done.yml` after a person seals.
 * parseBar is the authority; a malformed proposal writes nothing.
 */
ipcMain.handle("bar:apply", (_e, adds: unknown) => {
  if (!session) return { ok: false, error: "no workspace is open" };
  if (running) return { ok: false, error: "a turn is running — stop it first" };
  const list = Array.isArray(adds) ? adds : [];
  const r = applyBarAdds(session.cwd, list, session.bar);
  if (!r.ok) return r;
  session.bar = r.bar;
  session.barError = null;
  session.engine.setBar(session.bar);
  return { ok: true, state: stateOf(session) };
});

ipcMain.handle("auth:save", (_e, provider: string, key: string) =>
  saveKey(provider, key, configDir()),
);
ipcMain.handle("auth:endpoint", (_e, baseUrl: string, model: string) =>
  saveEndpoint(baseUrl, model, configDir()),
);
ipcMain.handle("auth:stored", () => storedEndpoint(configDir()));

/** The renderer answering a tool confirmation. */
ipcMain.on("confirm:reply", (_e, id: string, ok: boolean) => {
  const resolve = pendingConfirms.get(id);
  if (!resolve) return;
  pendingConfirms.delete(id);
  resolve(ok);
});

ipcMain.on("session:cancel", () => {
  // The engine owns cancellation — it has to roll the transcript back and
  // abort the request in flight, neither of which an AbortSignal here could
  // do. The controller below only releases anything waiting on a confirm.
  session?.engine.cancel();
  running?.abort();
});

ipcMain.handle("session:run", async (_e, text: string, ask: boolean, criteria?: Draft) => {
  if (!session) return { ok: false, error: "no workspace is open" };
  if (running) return { ok: false, error: "a turn is already running" };

  running = new AbortController();
  const signal = running.signal;

  const confirm = (name: string, detail: string): Promise<boolean> =>
    new Promise((resolveConfirm) => {
      const id = `c${++confirmSeq}`;
      pendingConfirms.set(id, resolveConfirm);
      send("confirm:request", { id, name, detail });
      // A cancelled turn must not leave the window waiting on an answer
      // nobody will give.
      signal.addEventListener(
        "abort",
        () => {
          if (pendingConfirms.delete(id)) resolveConfirm(false);
        },
        { once: true },
      );
    });

  // A session whose price never resolved shows tokens and no money for as long
  // as it lasts. Retried here, where one request is invisible beside the turn
  // it precedes, rather than once at open where a single failure was final.
  {
    const { refresh, announce } = shouldRefreshPrice({
      priceIn: session.engine.pricing().in,
      model: session.model,
      announcedNoPriceFor: noPriceAnnouncedFor,
    });
    if (refresh) {
      await refreshPricing(session, announce);
      if (session.engine.pricing().in === undefined) noPriceAnnouncedFor = session.model;
    }
  }

  try {
    // Turned into real checks here, at the boundary, so the shape the engine
    // seals is one this process built rather than one the renderer sent.
    // taskChecksFrom is the whole of that claim: without it, a non-string
    // `run` or an uncapped shell string from a compromised page becomes
    // `shell: true` in the workspace.
    // runOptions carries that, and wires `onCeiling` — without it the window
    // stopped dead at the step guard while the TUI asked whether to carry on.
    for await (const ev of session.engine.run(
      text,
      confirm,
      runOptions({ ask, criteria, confirm, maxSteps: MAX_STEPS }),
    )) {
      send("engine:event", ev satisfies EngineEvent);
    }
    return { ok: true };
  } catch (e) {
    send("engine:event", { kind: "error", text: String(e) });
    return { ok: false, error: String(e) };
  } finally {
    running = null;
    for (const [, r] of pendingConfirms) r(false);
    pendingConfirms.clear();
    send("session:idle", {});
  }
});

// ── Reading the record ───────────────────────────────────────────────────────

ipcMain.handle("receipts:list", () => {
  if (!session) return [];
  const dir = join(session.cwd, ".molt", "receipts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .map((f) => {
      const p = join(dir, f);
      const m = /^(\d+)-(accepted|refused|exhausted)\.md$/.exec(f);
      return {
        file: f,
        n: m ? Number(m[1]) : 0,
        verdict: m?.[2] ?? "unknown",
        mtime: statSync(p).mtimeMs,
      };
    });
});

ipcMain.handle("receipts:read", (_e, file: string) => {
  if (!session) return null;
  // Never leaves the receipts directory, whatever the renderer asks for.
  const p = resolveReceipt(join(session.cwd, ".molt", "receipts"), file);
  if (p === null || !existsSync(p)) return null;
  return readFileSync(p, "utf8");
});

ipcMain.handle("journal:read", () => {
  if (!session) return [];
  const p = session.journal.path;
  if (!p || !existsSync(p)) return [];
  return parseJournal(readFileSync(p, "utf8"));
});

/**
 * Verify the whole evidence chain for the open workspace: the journals' own
 * chains plus the project-level integrity ledger that binds journals,
 * receipts and exuviae together. Returns the verdict, any drift, and the
 * root of trust the workspace could ship somewhere molt cannot write.
 */
ipcMain.handle("integrity:verify", () => {
  if (!session) return null;
  // The same verdict `molt verify` prints, from the same function. This ran
  // `Integrity.verify` alone and answered "intact" over a journal whose chain
  // the terminal reported broken at entry 16 — the sixth engine capability to
  // exist on one surface and not the other.
  const p = Integrity.verifyProject(session.cwd);
  const i = p.ledger;
  return {
    ok: p.ok,
    established: i.established,
    records: i.records,
    brokenAt: i.brokenAt ?? null,
    reason: i.reason ?? null,
    drift: i.drift,
    unbound: i.unbound,
    journals: p.journals.map((j) => ({ file: j.file, ok: j.ok, entries: j.entries, reason: j.reason ?? null })),
    root: p.root,
    generatedAt: new Date().toISOString(),
  };
});

ipcMain.handle("session:stats", () => {
  if (!session) return null;
  const e = session.engine;
  const b = e.bom();
  return {
    tokens: e.sessionTokens,
    cached: e.sessionCachedTokens,
    costUsd: e.costUsd() ?? null,
    costEstimated: b.costEstimated === true,
    shedBatches: e.shedBatches,
    hasBar: e.hasBar,
    // The next request, not the session total. Context fill is "how full
    // is the window right now", and billed tokens across a day are not that.
    requestEst: b.requestTotalEst,
    window: e.learnedWindow,
    budget: e.budgetTokens ?? null,
  };
});
