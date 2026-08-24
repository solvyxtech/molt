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
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Engine } from "../src/engine.js";
import { Archive } from "../src/archive.js";
import { Receipts } from "../src/receipts.js";
import { Journal } from "../src/journal.js";
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

  const engine = new Engine({
    journal,
    baseUrl,
    apiKey,
    model,
    provider,
    cwd,
    bar,
    autonomy,
    archive: new Archive(cwd),
    receipts,
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
    commands: COMMANDS,
  };
}

function createWindow(): void {
  win = new BrowserWindow({
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
        await win!.webContents.executeJavaScript(`(() => {
          document.getElementById("ask").checked = ${process.env.MOLT_E2E_ASK === "1"};
          document.getElementById("prompt").value = ${JSON.stringify(
            process.env.MOLT_E2E_TASK ?? "say hello",
          )};
          document.getElementById("send").click();
          return 0;
        })()`);
        // Wait for the turn to finish, seen from the page rather than guessed.
        let done = false;
        for (let i = 0; i < 300; i++) {
          done = await win!.webContents.executeJavaScript(
            `window.__turnDone === true && document.getElementById("send").classList.contains("hidden") === false`,
          );
          if (done) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!done) {
          console.error("[self-drive] turn never produced a verdict within 30s");
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
               checksRun: [...document.querySelectorAll("#stream .proof .check .est")].length,
               checkNames: [...document.querySelectorAll("#checks .check-card .nm")].map((n) => n.textContent),
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
               text: (document.getElementById("stream")||{}).textContent||"",
             })`,
          )
          .then((r: Record<string, unknown>) => {
            console.log(`[self-drive] events     ${seen.join(", ")}`);
            console.log(`[self-drive] said rows  ${r.rows}`);
            console.log(`[self-drive] tool rows  ${r.tools}`);
            console.log(`[self-drive] proofs     ${r.proofs}`);
            console.log(`[self-drive] wire rows  ${r.wire}`);
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
            console.log(`[self-drive] checks     ${(r.checkNames as string[]).join(", ") || "(none)"}`);
            const text = String(r.text);
            const ok =
              Number(r.rows) > 0 &&
              text.includes(process.env.MOLT_E2E_EXPECT ?? "") &&
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
              setTimeout(() => {
                void win!.webContents.capturePage().then((img) => {
                  writeFileSync(shot, img.toPNG());
                  console.log(`[self-drive] shot        ${shot}`);
                  app.exit(ok ? 0 : 1);
                });
              }, 250);
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
             const need = ["tabs","panels","stream","wire","checks","receipt-list","log","composer","prompt","send","status","crumb-model","picker","picker-list","set-model-pick","set-model","set-url","autonomy","ask"];
             const missing = need.filter((id) => !document.getElementById(id));
             const tabs = [...document.querySelectorAll(".tab")].map((t) => t.dataset.tab);
             const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
             return {
               bridge: typeof window.molt === "object" && typeof window.molt.run === "function",
               missing,
               tabs,
               accent,
               panels: [...document.querySelectorAll(".panel")].length,
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
             };
           })()`,
        )
        .then((r: Record<string, unknown>) => {
          const ok =
            r.bridge === true &&
            Array.isArray(r.missing) &&
            r.missing.length === 0 &&
            Array.isArray(r.tabs) &&
            r.tabs.length === 6 &&
            r.nulRoundTrip === true &&
            r.autonomyButtons === 3 &&
            String(r.autonomyOn).length > 0 &&
            r.autonomySticks === true &&
            Number(r.paletteRows) >= 15;
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

app.whenReady().then(() => {
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

ipcMain.handle("app:theme", (_e, name: string) => getTheme(name));

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
    if (!existsSync(opts.cwd)) return { ok: false, error: `no such directory: ${opts.cwd}` };
    try {
      session = openSession(opts.cwd, opts.model, opts.baseUrl, opts.apiKey);
      rememberEndpoint(opts.baseUrl, opts.model);
      return { ok: true, state: stateOf(session) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
);

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
      session.engine.setBaseUrl(opts.baseUrl, opts.apiKey, session.provider);
    } else if (opts.apiKey) {
      session.engine.setApiKey(opts.apiKey);
    }
    session.model = opts.model;
    session.engine.setModel(opts.model);
    saveEndpoint(session.baseUrl, opts.model, configDir());
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
  if (running && (name === "/shed" || name === "/regrow" || name === "/prove")) {
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
      text: wrote
        ? `wrote ${BAR_FILENAME} — ${session.bar?.checks.length ?? 0} check(s). Edit it to match this project.`
        : `${BAR_FILENAME} already exists — left alone`,
      state: stateOf(session),
    };
  } catch (e) {
    return { kind: "error" as const, text: String(e) };
  }
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

ipcMain.handle("session:run", async (_e, text: string, ask: boolean) => {
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

  try {
    for await (const ev of session.engine.run(text, confirm, { ask })) {
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
  const dir = resolve(join(session.cwd, ".molt", "receipts"));
  const p = resolve(join(dir, file));
  if (!p.startsWith(dir + "/") || !existsSync(p)) return null;
  return readFileSync(p, "utf8");
});

ipcMain.handle("journal:read", () => {
  if (!session) return [];
  const p = session.journal.path;
  if (!p || !existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return { kind: "unparsed", line };
      }
    });
});

ipcMain.handle("session:stats", () => {
  if (!session) return null;
  const e = session.engine;
  return {
    tokens: e.sessionTokens,
    cached: e.sessionCachedTokens,
    costUsd: e.costUsd() ?? null,
    shedBatches: e.shedBatches,
    hasBar: e.hasBar,
  };
});
