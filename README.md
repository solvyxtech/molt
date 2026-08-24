# molt desktop

**A coding agent that can't say "done" without proving it — now with a window.**

Private. Not published, not pushed, not packaged for anyone yet.

---

## What this is

molt's engine, unchanged, with a desktop shell around it. The proof gate, the
receipts, the hash-chained journal, the shed archive and the provider handling
are all the same code that runs in the terminal — imported from `src/`, not
reimplemented. A proof produced in this window and a proof produced by `molt
run` are the same proof, because they came from the same function.

What the window adds is room. The terminal had one screen and everything
competed for it: reading the wire pushed the model's narration out of view,
the journal was a separate command, and a receipt was a file path you had to
go and open. Here each of those is a tab, and looking at one costs you nothing.

| Tab | What it holds |
|---|---|
| **Session** | The work. Narration, tool calls, proof results, receipt links. |
| **View** | Every byte to and from the model, in order. Kept out of the session on purpose. |
| **Checks** | The bar — what's defined, what ran, what each check established. |
| **Receipts** | The evidence trail, rendered. |
| **Log** | The journal for this session, filterable. |
| **Settings** | Workspace, model, endpoint, keys, theme. |

## Running it

```sh
npm install
npm run app          # build and launch
npm run dev          # same, with sourcemaps
```

## Packaging

```sh
npm run dist:mac     # .dmg          (arm64 + x64)
npm run dist:win     # .exe + .zip   (x64)
npm run dist:linux   # .AppImage + .tar.gz (x64)
```

All three build from macOS. Output lands in `release/`.

The macOS build is **unsigned** — signing needs a Developer ID, and an unsigned
build you can reproduce is better than a signed one you can't. Gatekeeper will
warn on first open until that changes.

## Checking it works

```sh
npm run self-check   # boots the window, asks the page if it wired up, exits
npm run e2e          # runs a real turn against a stub provider, end to end
npm test             # the engine's own 805 tests
```

`--self-check` is also on the shipped binary, which is the point of it: on a
machine you cannot see, "it launches" and "it works" are different claims.

```sh
/Applications/molt.app/Contents/MacOS/molt --self-check
```

## Layout

```
src/          the molt engine — shared with the CLI, unmodified
electron/     main process (owns the engine) and the preload bridge
ui/           the window: one HTML file, one stylesheet, one renderer
build.mjs     three esbuild bundles, one per world
test-e2e/     end-to-end drive against a stub provider
```

## Security posture

`contextIsolation` is on, `nodeIntegration` is off, and the renderer's entire
capability is the named list in `electron/preload.ts`. The page never touches
the filesystem or the network directly.

Everything on screen is set with `textContent`, never `innerHTML` — including
receipts, which quote the model verbatim. Model output is untrusted text that
gets rendered in a window with a bridge to a shell; the distance between
"renders a string" and "runs a command" should be a wall, not a habit.

Provider keys live in `~/.config/molt/auth.json` at 0600, outside this repo,
exactly as the CLI stores them.
