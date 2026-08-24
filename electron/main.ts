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
import { loadBar, BarError } from "../src/bar.js";
import type { Bar, Check } from "../src/types.js";
import { getTheme, THEMES, DEFAULT_THEME } from "../src/theme.js";
import {
  readAuth,
  saveKey,
  saveEndpoint,
  storedEndpoint,
  providerName,
  isSelfHosted,
  PROVIDERS,
} from "../src/providers.js";
import type { EngineEvent } from "../src/types.js";

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
    archive: new Archive(cwd),
    receipts,
  });

  return { engine, cwd, model, baseUrl, provider, bar, barError, journal, receipts };
}

/** What the renderer needs to draw its chrome. */
function stateOf(s: Session | null) {
  const auth = readAuth();
  return {
    open: s !== null,
    cwd: s?.cwd ?? null,
    model: s?.model ?? null,
    baseUrl: s?.baseUrl ?? null,
    provider: s?.provider ?? null,
    selfHosted: s ? isSelfHosted(s.baseUrl) : false,
    checks:
      s?.bar?.checks.map((c: Check) => ({ name: c.name, kind: c.kind, tags: c.tags })) ?? [],
    barError: s?.barError ?? null,
    sessionId: s?.journal.sessionId ?? null,
    providers: Object.keys(PROVIDERS),
    keyed: Object.keys(auth),
    themes: Object.keys(THEMES),
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
      const opened = openSession(cwd, model, baseUrl, "stub-key");
      session = opened;
      const seen: string[] = [];
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
      // Give the renderer a tick to paint what it was sent, then ask it what
      // it actually put on screen. Counting events proves delivery; reading the
      // DOM proves rendering, and they fail independently.
      setTimeout(() => {
        void win!.webContents
          .executeJavaScript(
            `(document.querySelector('.tab[data-tab="session"]').click(), {
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
            const text = String(r.text);
            const ok = Number(r.rows) > 0 && text.includes(process.env.MOLT_E2E_EXPECT ?? "");
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
    win.webContents.once("did-finish-load", () => {
      void win!.webContents
        .executeJavaScript(
          `(() => {
             const need = ["tabs","panels","stream","wire","checks","receipt-list","log","composer","prompt","send","status"];
             const missing = need.filter((id) => !document.getElementById(id));
             const tabs = [...document.querySelectorAll(".tab")].map((t) => t.dataset.tab);
             const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
             return {
               bridge: typeof window.molt === "object" && typeof window.molt.run === "function",
               missing,
               tabs,
               accent,
               panels: [...document.querySelectorAll(".panel")].length,
             };
           })()`,
        )
        .then((r: Record<string, unknown>) => {
          const ok =
            r.bridge === true &&
            Array.isArray(r.missing) &&
            r.missing.length === 0 &&
            Array.isArray(r.tabs) &&
            r.tabs.length === 6;
          console.log(`[self-check] bridge      ${r.bridge ? "ok" : "MISSING"}`);
          console.log(`[self-check] elements    ${(r.missing as string[]).length === 0 ? "ok" : "missing " + (r.missing as string[]).join(", ")}`);
          console.log(`[self-check] tabs        ${(r.tabs as string[]).join(", ")}`);
          console.log(`[self-check] panels      ${r.panels}`);
          console.log(`[self-check] accent      ${r.accent}`);
          console.log(ok ? "[self-check] PASS" : "[self-check] FAIL");
          // A screenshot on demand, because "PASS" says the page assembled and
          // says nothing about whether it is legible. Support asks for one of
          // these on the first call every time.
          const shot = process.env.MOLT_SHOT;
          if (shot) {
            void win!.webContents.capturePage().then((img) => {
              writeFileSync(shot, img.toPNG());
              console.log(`[self-check] shot        ${shot}`);
              app.exit(ok ? 0 : 1);
            });
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
      return { ok: true, state: stateOf(session) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
);

ipcMain.handle("auth:save", (_e, provider: string, key: string) => saveKey(provider, key));
ipcMain.handle("auth:endpoint", (_e, baseUrl: string, model: string) =>
  saveEndpoint(baseUrl, model),
);
ipcMain.handle("auth:stored", () => storedEndpoint());

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
