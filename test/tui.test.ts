/**
 * The transparency view, mounted for real.
 *
 * molt's pitch is that nothing it says has to be taken on trust, and the
 * TUI was the one place that fell short of it: a spinner said the model was
 * working, and nothing said what it was working on, what came back, or what
 * the step cost. A capability with no surface is not a feature — so these
 * mount the actual component, press the actual keys, and read the frames.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { describe, it } from "node:test";
import { render } from "ink";
import { App, renderApp } from "../src/app.js";
import { Engine } from "../src/engine.js";
import type { Msg } from "../src/types.js";
import { workspace } from "./helpers.js";

/** What a terminal sends for ctrl+V and ctrl+A. */
const CTRL_V = String.fromCharCode(22);
const CTRL_A = String.fromCharCode(1);
const CTRL_C = String.fromCharCode(3);

/**
 * A terminal's input side. Ink reads keys by listening for "readable" and
 * draining read(), so a fake that only emits "data" is never heard from.
 */
class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  /** Deliver a keypress the way a terminal would. */
  press(data: string): void {
    this.queue.push(data);
    this.emit("readable");
  }
}

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 40;
  isTTY = true;
  frames: string[] = [];
  write(frame: string): boolean {
    this.frames.push(frame);
    return true;
  }
  get lastFrame(): string {
    return this.frames.at(-1) ?? "";
  }
  /** Everything drawn so far. */
  get text(): string {
    return this.frames.join("\n");
  }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** A provider that reads a file, then claims done. */
function provider(): typeof fetch {
  const turns: Msg[] = [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"seed.txt"}' },
        },
      ],
    },
    { role: "assistant", content: "read it" },
  ];
  let n = 0;
  return (async () => {
    const message = turns[Math.min(n, turns.length - 1)]!;
    n += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        choices: [{ message, finish_reason: "stop" }],
        usage: { prompt_tokens: 1200, completion_tokens: 30 },
      }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** The same provider, answering slowly enough to press a key mid-turn. */
function slowProvider(ms: number): typeof fetch {
  const inner = provider();
  return (async (...args: Parameters<typeof fetch>) => {
    await tick(ms);
    return inner(...args);
  }) as unknown as typeof fetch;
}

async function mount(over: Record<string, unknown> = {}, columns?: number) {
  const ws = workspace();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  // Set before render: Ink reads the width when it lays out, not after.
  if (columns) stdout.columns = columns;
  const engine = new Engine({
    baseUrl: "http://provider.test/v1",
    model: "test-model",
    provider: "test",
    cwd: ws.dir,
    bar: null,
    fetchFn: provider(),
    stream: false,
    priceInPerMtok: 2,
    priceOutPerMtok: 6,
    ...over,
  });
  // renderApp, not a bare render: the mount options are behaviour, not
  // preference. ctrl+C and the delete-key remap both live there, and a helper
  // that mounts its own way tests something the real program never runs — which
  // is exactly how the ctrl+C bug survived a whole suite.
  const app = renderApp(
    { engine, version: "vtest" },
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
    },
  );
  await tick();
  return {
    stdin,
    stdout,
    engine,
    cleanup: () => {
      app.unmount();
      ws.cleanup();
    },
  };
}

/** Type a line and submit it. */
async function submit(stdin: FakeStdin, text: string): Promise<void> {
  for (const ch of text) stdin.press(ch);
  await tick();
  stdin.press("\r");
  await tick(300);
}

describe("the transparency view", () => {
  it("offers the key while it is working, where the answer is needed", async () => {
    const t = await mount({ fetchFn: slowProvider(150) });
    try {
      void submit(t.stdin, "read the seed");
      await tick(120);
      assert.match(t.stdout.text, /shift\+V to watch/, "never told anyone the view exists");
      await tick(600);
    } finally {
      t.cleanup();
    }
  });

  it("keeps detail out of the way until it is asked for", async () => {
    const t = await mount();
    try {
      await submit(t.stdin, "read the seed");
      const quiet = t.stdout.lastFrame;
      assert.match(quiet, /read_file/, "hid the call itself, not just its detail");
      assert.ok(!/args \{/.test(quiet), `showed raw arguments unasked: ${quiet}`);

      // ctrl+V: the binding that works whether or not a turn is running.
      t.stdin.press(CTRL_V);
      await tick(80);
      const loud = t.stdout.lastFrame;
      assert.match(loud, /args \{"path":"seed\.txt"\}/, "the view revealed nothing");
      assert.match(loud, /bytes/);
      assert.match(loud, /what the model is doing/);
    } finally {
      t.cleanup();
    }
  });

  it("shows every line of a streamed answer, while it streams", async () => {
    // The live region was capped at eight rows with a "↑ N more line(s)"
    // marker — bounded, which the terminal needs, and truncated, which nobody
    // asked for. Completed lines go to the transcript as they arrive, so the
    // repaint is one line and the answer is all of it.
    const LINES = 24;
    const answer = Array.from({ length: LINES }, (_, i) => `answer line ${i + 1}`).join("\n");
    const ws = workspace();
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const engine = new Engine({
      baseUrl: "http://provider.test/v1",
      model: "m",
      cwd: ws.dir,
      bar: null,
      stream: true,
      fetchFn: (async () => {
        const enc = new TextEncoder();
        const chunks = (answer.match(/[\s\S]{1,24}/g) ?? []).map((c) =>
          `data: ${JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: null }] })}\n\n`,
        );
        chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        chunks.push("data: [DONE]\n\n");
        return {
          ok: true,
          status: 200,
          headers: { get: () => "text/event-stream" },
          body: new ReadableStream<Uint8Array>({
            start(c) {
              for (const f of chunks) c.enqueue(enc.encode(f));
              c.close();
            },
          }),
          text: async () => "",
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const app = render(createElement(App, { engine, version: "vtest" }), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await tick();
      await submit(stdin, "say something long");
      await tick(500);
      const text = stdout.text;
      for (const n of [1, 7, 15, 24]) {
        assert.match(text, new RegExp(`answer line ${n}\\b`), `line ${n} never reached the screen`);
      }
      assert.ok(!text.includes("more line(s)"), "still truncating with a marker");
      // Visible while it streams, not only once it finishes: a frame from
      // partway through carries more than the eight rows the old cap allowed.
      const partway = stdout.frames[Math.floor(stdout.frames.length * 0.6)] ?? "";
      const midCount = Array.from({ length: LINES }, (_, i) => i + 1).filter((n) =>
        partway.includes(`answer line ${n}`),
      ).length;
      assert.ok(midCount > 8, `only ${midCount} lines visible mid-stream`);
    } finally {
      app.unmount();
      ws.cleanup();
    }
  });

  it("shows the whole result, not a sample of it", async () => {
    // "I want to see everything happening — the whole point is transparency."
    // A view that shows five lines of a forty-line result is asking you to
    // trust the other thirty-five.
    const ws = workspace();
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const engine = new Engine({
      baseUrl: "http://provider.test/v1",
      model: "test-model",
      provider: "test",
      cwd: ws.dir,
      bar: null,
      stream: false,
      fetchFn: (async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command: "printf 'LINE-%s\\n' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20",
                      }),
                    },
                  },
                ],
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
        text: async () => "",
      })) as unknown as typeof fetch,
      autonomy: "high",
    });
    const app = render(createElement(App, { engine, version: "vtest", verbose: true }), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await tick();
      await submit(stdin, "run it");
      await tick(400);
      const text = stdout.text;
      // Every one of the twenty lines reached the screen, not the first five.
      for (const n of [1, 5, 12, 19, 20]) {
        assert.match(text, new RegExp(`LINE-${n}\\b`), `line ${n} was truncated away`);
      }
    } finally {
      app.unmount();
      ws.cleanup();
    }
  });

  it("reveals what happened before the key was pressed, not only after", async () => {
    // Detail is recorded whether or not anyone is watching. A view that only
    // starts recording when you open it cannot answer "what did it just do?".
    const t = await mount();
    try {
      await submit(t.stdin, "read the seed");
      t.stdin.press(CTRL_V);
      await tick(80);
      assert.match(t.stdout.lastFrame, /step 1/);
      assert.match(t.stdout.lastFrame, /session .*tokens/);
    } finally {
      t.cleanup();
    }
  });

  it("closes every step with what it did and what it cost, unprompted", async () => {
    const t = await mount();
    try {
      await submit(t.stdin, "read the seed");
      const frame = t.stdout.lastFrame;
      assert.match(frame, /step 1 · read_file/);
      assert.match(frame, /1\.2k in/);
      assert.match(frame, /step 2 · claims done/);
      // Priced in the same unit the session meter uses, so a step and a
      // total can be read against each other: 1200 in at $2/M plus 30 out at
      // $6/M is $0.0026.
      assert.match(frame, /\$0\.003/);
    } finally {
      t.cleanup();
    }
  });

  it("takes shift+V while the turn is running, which is when it is asked", async () => {
    // The prompt takes no typing mid-turn, so a letter is free there — and
    // free is what a key has to be to earn the shortest binding.
    const t = await mount({ fetchFn: slowProvider(150) });
    try {
      void submit(t.stdin, "read the seed");
      await tick(80);
      t.stdin.press("V");
      await tick(600);
      assert.match(t.stdout.lastFrame, /what the model is doing/, "shift+V showed nothing");
    } finally {
      t.cleanup();
    }
  });

  it("wraps a prompt longer than the window instead of clipping it", async () => {
    // Reported from use: "when the chat goes into a second line the cursor
    // doesn't follow". There was no second line — the prompt row was a Box of
    // sibling Texts, which lay out as flex children and are cut at the edge of
    // the terminal rather than reflowed, so the tail vanished and the caret sat
    // at the cut. Text nested inside Text is one inline run, and wraps.
    const t = await mount({}, 60);
    try {
      const long = "fix the authentication bug in src/auth.ts and also update the docs";
      for (const ch of long) t.stdin.press(ch);
      await tick(400);
      const frame = t.stdout.lastFrame.replace(/\u001b\[[0-9;]*m/g, "");
      // Wrapped, so the tail sits on a later line — the test cannot look for
      // the whole prompt as one contiguous string, which is the point of the
      // fix. What matters is that the tail is on screen at all.
      assert.match(frame, /the docs/, "the end of the prompt was clipped away");
      assert.match(frame, /also update/, "the middle of the prompt went missing");
      assert.ok(frame.split("\n").some((l) => l.includes("› fix the")), "prompt marker lost");
      assert.ok(
        frame.split("\n").every((l) => l.replace(/\u001b\[[0-9;]*m/g, "").length <= 60),
        "a line ran past the width of the terminal",
      );
    } finally {
      t.cleanup();
    }
  });

  it("does not eat a letter typed into a message", async () => {
    const t = await mount();
    try {
      for (const ch of "Verify this") t.stdin.press(ch);
      await tick(60);
      assert.match(t.stdout.lastFrame, /Verify this/, "swallowed a letter someone was typing");
      assert.ok(
        !/what the model is doing/.test(t.stdout.lastFrame),
        "opened the view mid-word",
      );
      assert.ok(!/autonomy:/.test(t.stdout.lastFrame), "moved the autonomy ceiling mid-word");
    } finally {
      t.cleanup();
    }
  });

  it("shows the autonomy level beside the model, and moves it with a key", async () => {
    // A ceiling that is not visible while it is in force is not a control.
    const t = await mount();
    try {
      assert.match(t.stdout.lastFrame, /auto low/);
      t.stdin.press(CTRL_A);
      await tick(60);
      assert.match(t.stdout.lastFrame, /auto medium/);
      assert.match(t.stdout.lastFrame, /autonomy: medium/, "moved the ceiling silently");
      assert.equal(t.engine.autonomy, "medium");
      t.stdin.press(CTRL_A);
      await tick(60);
      assert.equal(t.engine.autonomy, "high");
      // Wraps, so one key can also put it back.
      t.stdin.press(CTRL_A);
      await tick(60);
      assert.equal(t.engine.autonomy, "low");
    } finally {
      t.cleanup();
    }
  });

  it("opens the level picker from an idle prompt, changing nothing until enter", async () => {
    // The reported problem: shift+A did nothing at the prompt, because a
    // terminal cannot tell it from the "A" that starts a sentence.
    const t = await mount();
    try {
      t.stdin.press("A");
      await tick(60);
      assert.match(t.stdout.lastFrame, /how much molt does without asking/);
      assert.match(t.stdout.lastFrame, /← now/, "never said which level is in force");
      assert.equal(t.engine.autonomy, "low", "moved the ceiling before it was confirmed");

      t.stdin.press("\u001B[B"); // down
      await tick(40);
      t.stdin.press("\r");
      await tick(60);
      assert.equal(t.engine.autonomy, "medium");
      assert.match(t.stdout.lastFrame, /auto medium/);
    } finally {
      t.cleanup();
    }
  });

  it("gives the letter back when the picker was opened by accident", async () => {
    // Someone typing "Add a test" must not lose the A, and must not have
    // their permission ceiling moved by a typo.
    const t = await mount();
    try {
      t.stdin.press("A");
      await tick(40);
      t.stdin.press("\u001B"); // esc
      await tick(40);
      for (const ch of "dd a test") t.stdin.press(ch);
      await tick(60);
      assert.match(t.stdout.lastFrame, /Add a test/, "swallowed the letter");
      assert.equal(t.engine.autonomy, "low", "a cancelled picker changed the level");
    } finally {
      t.cleanup();
    }
  });

  it("lets a typo be fixed where it is, not by retyping the line", async () => {
    // Reported from use: with no caret, the only way back to a mistake was to
    // delete everything after it.
    const t = await mount();
    try {
      for (const ch of "fix the bg") t.stdin.press(ch);
      await tick(40);
      t.stdin.press("\u001B[D"); // left, to before the "g"
      await tick(20);
      t.stdin.press("u");
      await tick(60);
      assert.match(t.stdout.lastFrame, /fix the bug/, "the fix did not land in place");
    } finally {
      t.cleanup();
    }
  });

  it("moves by words with alt+arrow", async () => {
    const t = await mount();
    try {
      for (const ch of "read src/app.tsx") t.stdin.press(ch);
      await tick(40);
      t.stdin.press("\u001B[1;3D"); // alt+left
      await tick(30);
      for (const ch of "the ") t.stdin.press(ch);
      await tick(60);
      assert.match(t.stdout.lastFrame, /read the src\/app\.tsx/, "alt+left did not skip a word");
    } finally {
      t.cleanup();
    }
  });

  it("leaves a mid-sentence capital alone", async () => {
    const t = await mount();
    try {
      for (const ch of "fix the Auth bug") t.stdin.press(ch);
      await tick(60);
      assert.match(t.stdout.lastFrame, /fix the Auth bug/);
      assert.ok(!/without asking/.test(t.stdout.lastFrame), "opened the picker mid-sentence");
    } finally {
      t.cleanup();
    }
  });

  it("lets you type while it works, and runs it when the turn ends", async () => {
    // Reported from use: "you also can't type when the model is thinking".
    // Correct, and there was no reason for it — a thought that arrives mid-turn
    // had to be held in your head until molt finished.
    const t = await mount({ fetchFn: slowProvider(200) });
    try {
      void submit(t.stdin, "read the seed");
      await tick(80);
      for (const ch of "and then summarise it") t.stdin.press(ch);
      await tick(60);
      assert.match(t.stdout.lastFrame, /and then summarise it/, "typing was swallowed mid-turn");

      t.stdin.press("\r");
      await tick(60);
      assert.match(t.stdout.lastFrame, /queued/, "enter mid-turn said nothing");
      await tick(900);
    } finally {
      t.cleanup();
    }
  });

  it("does not let its own status line crowd out what you are typing", async () => {
    // These were flex siblings on one row, and a row is CLIPPED at the window
    // edge rather than reflowed. Giving the status line more to say about what
    // it was waiting for pushed the typed message off the right edge, and it
    // read as typing having stopped working. Narrow window, long message: the
    // case where the two actually compete.
    const t = await mount({ fetchFn: slowProvider(400) }, 60);
    try {
      void submit(t.stdin, "read the seed");
      await tick(120);
      const typed = "and then summarise what it says about the proof gate";
      for (const ch of typed) t.stdin.press(ch);
      await tick(120);
      assert.match(t.stdout.lastFrame, /summarise what it says about the proof gate/,
        "the status line clipped the user's own message off the screen");
      await tick(600);
    } finally {
      t.cleanup();
    }
  });

  it("keeps shift+V and shift+A on an empty line only", async () => {
    // A letter is a command when there is nothing to type it into, and a
    // letter otherwise — the same rule at an idle prompt and mid-turn.
    const t = await mount({ fetchFn: slowProvider(200) });
    try {
      void submit(t.stdin, "read the seed");
      await tick(80);
      t.stdin.press("V");
      await tick(60);
      assert.match(t.stdout.lastFrame, /what the model is doing/, "shift+V stopped working");

      // With something already typed, the same key is just a letter.
      for (const ch of "then ") t.stdin.press(ch);
      await tick(40);
      for (const ch of "Verify") t.stdin.press(ch);
      await tick(60);
      assert.match(t.stdout.lastFrame, /then Verify/, "a capital was eaten mid-sentence");
      await tick(900);
    } finally {
      t.cleanup();
    }
  });

  it("takes shift+A while the turn is running", async () => {
    const t = await mount({ fetchFn: slowProvider(150) });
    try {
      void submit(t.stdin, "read the seed");
      await tick(80);
      t.stdin.press("A"); // empty line, so it is the autonomy key
      await tick(600);
      assert.equal(t.engine.autonomy, "medium");
    } finally {
      t.cleanup();
    }
  });

  it("keeps the session meter climbing across jobs", async () => {
    // The meter is the running total for the session and must only ever
    // grow. Per-job figures live in the view; they are a lens on the meter,
    // never a reset of it.
    const t = await mount();
    try {
      await submit(t.stdin, "job one");
      const first = t.stdout.lastFrame.match(/· ([\d.]+k?) tokens/)?.[1];
      await submit(t.stdin, "job two");
      const second = t.stdout.lastFrame.match(/· ([\d.]+k?) tokens/)?.[1];
      const n = (v?: string) => Number(String(v).replace("k", "")) * (String(v).endsWith("k") ? 1000 : 1);
      assert.ok(n(second) > n(first), `meter did not climb: ${first} → ${second}`);
      // Two jobs, three requests between them, every token still counted.
      assert.equal(t.engine.sessionTokens, 3690);
    } finally {
      t.cleanup();
    }
  });

  it("shows each job with its own tokens and price", async () => {
    const t = await mount();
    try {
      await submit(t.stdin, "job one");
      await submit(t.stdin, "job two");
      t.stdin.press(CTRL_V);
      await tick(80);
      const frame = t.stdout.lastFrame;
      // Each job priced on its own, in the same unit as the session meter:
      // job one made two requests (2.4k in, 60 out), job two made one.
      assert.match(frame, /job 1 unverified · 2 step\(s\) · 2\.4k in · 60 out · \$0\.005/);
      assert.match(frame, /job 2 unverified · 1 step\(s\) · 1\.2k in · 30 out · \$0\.003/);
    } finally {
      t.cleanup();
    }
  });
});

describe("narration across steps", () => {
  /**
   * A model that talks before each tool call, the way every real one does:
   * a sentence of narration, then the call. The content never ends in a
   * newline, because prose does not.
   */
  function narratingProvider(turns: { text: string; call?: string }[]): typeof fetch {
    let n = 0;
    return (async () => {
      const turn = turns[Math.min(n, turns.length - 1)]!;
      n += 1;
      const enc = new TextEncoder();
      const frames: string[] = [];
      for (const piece of turn.text.match(/[\s\S]{1,17}/g) ?? []) {
        frames.push(
          `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
        );
      }
      if (turn.call) {
        frames.push(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `c${n}`,
                      type: "function",
                      function: { name: "read_file", arguments: JSON.stringify({ path: turn.call }) },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
      }
      frames.push(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: turn.call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`,
      );
      frames.push("data: [DONE]\n\n");
      return {
        ok: true,
        status: 200,
        headers: { get: () => "text/event-stream" },
        body: new ReadableStream<Uint8Array>({
          start(c) {
            for (const f of frames) c.enqueue(enc.encode(f));
            c.close();
          },
        }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("never runs one step's last sentence into the next step's first", async () => {
    const ws = workspace();
    writeFileSync(join(ws.dir, "a.txt"), "alpha\n");
    writeFileSync(join(ws.dir, "b.txt"), "beta\n");
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const engine = new Engine({
      baseUrl: "http://provider.test/v1",
      model: "m",
      cwd: ws.dir,
      bar: null,
      stream: true,
      autonomy: "high",
      fetchFn: narratingProvider([
        { text: "Mapping the repo and hunting for real bugs and product defects.", call: "a.txt" },
        { text: "The workspace is the home directory, not molt itself.", call: "b.txt" },
        { text: "Source lives under the installed package." },
      ]),
    });
    const app = render(createElement(App, { engine, version: "vtest" }), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await tick();
      await submit(stdin, "review the repo");
      await tick(600);
      const text = stdout.text;
      assert.ok(
        !/defects\.\s*The workspace/.test(text.replace(/\n/g, "")),
        "step 1's narration ran straight into step 2's",
      );
      assert.ok(
        !/itself\.\s*Source lives/.test(text.replace(/\n/g, "")),
        "step 2's narration ran straight into step 3's",
      );
    } finally {
      app.unmount();
      ws.cleanup();
    }
  });
});

describe("ctrl+C", () => {
  /**
   * Ink exits on ctrl+C by itself unless told not to, beside whatever the app
   * does with the key. These mount with the flag left at its default — the
   * production setting — because passing exitOnCtrlC:false in the harness is
   * exactly what hid this: the app's own handling was tested, and the key that
   * reached it in the real program was not.
   */
  async function mountReal(over: Record<string, unknown> = {}) {
    const ws = workspace();
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const engine = new Engine({
      baseUrl: "http://provider.test/v1",
      model: "test-model",
      provider: "test",
      cwd: ws.dir,
      bar: null,
      fetchFn: provider(),
      stream: false,
      ...over,
    });
    // Mounted exactly the way `molt` mounts it. The point of the helper is
    // that the ctrl+C option is not a knob a caller can get wrong.
    const app = renderApp(
      { engine, version: "vtest" },
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        debug: true,
        patchConsole: false,
      },
    );
    let exited = false;
    void app.waitUntilExit().then(() => {
      exited = true;
    });
    await tick();
    return { stdin, stdout, engine, exited: () => exited, cleanup: () => { app.unmount(); ws.cleanup(); } };
  }

  it("takes the line back instead of killing the session", async () => {
    const t = await mountReal();
    try {
      for (const ch of "a half-written thought") t.stdin.press(ch);
      await tick(60);
      t.stdin.press(CTRL_C);
      await tick(80);
      assert.equal(t.exited(), false, "one ctrl+C ended the whole session");
      assert.ok(
        !t.stdout.lastFrame.includes("half-written"),
        "kept the line it was asked to clear",
      );
    } finally {
      t.cleanup();
    }
  });

  it("exits on the second press, not the first", async () => {
    const t = await mountReal();
    try {
      t.stdin.press(CTRL_C);
      await tick(80);
      assert.equal(t.exited(), false, "quit on the first press of an empty line");
      assert.match(t.stdout.lastFrame, /ctrl\+C again to exit/, "offered nothing, just sat there");
      t.stdin.press(CTRL_C);
      await tick(120);
      assert.equal(t.exited(), true, "would not exit even on the second press");
    } finally {
      t.cleanup();
    }
  });

  it("forgets the offer as soon as you carry on typing", async () => {
    const t = await mountReal();
    try {
      t.stdin.press(CTRL_C);
      await tick(60);
      t.stdin.press("h");
      await tick(60);
      assert.ok(
        !t.stdout.lastFrame.includes("ctrl+C again"),
        "still armed after a keystroke that meant carry on",
      );
      t.stdin.press(CTRL_C);
      await tick(100);
      assert.equal(t.exited(), false, "a stale offer exited on a fresh first press");
    } finally {
      t.cleanup();
    }
  });

  it("stops the turn without stopping molt", async () => {
    // Hangs until the signal fires, so the cancellation is the only thing that
    // can end the request — a provider that just returns slowly would finish on
    // its own and prove nothing.
    const hangingProvider = (async (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as unknown as typeof fetch;
    const t = await mountReal({ fetchFn: hangingProvider });
    try {
      for (const ch of "read the seed") t.stdin.press(ch);
      await tick(40);
      t.stdin.press("\r");
      await tick(120);
      t.stdin.press(CTRL_C);
      await tick(300);
      assert.equal(t.exited(), false, "cancelling a turn took the session down with it");
      assert.match(t.stdout.text, /cancelled/, "the turn was never actually cancelled");
    } finally {
      t.cleanup();
    }
  });
});

describe("what the transcript keeps", () => {
  /** Streams `text`, then optionally a tool call, then stops. */
  function sayingProvider(turns: { text: string; call?: string }[], stream = true): typeof fetch {
    let n = 0;
    return (async () => {
      const t = turns[Math.min(n, turns.length - 1)]!;
      n += 1;
      const calls = t.call
        ? [
            {
              id: `c${n}`,
              type: "function" as const,
              function: { name: "read_file", arguments: JSON.stringify({ path: t.call }) },
            },
          ]
        : undefined;
      if (!stream) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({
            choices: [
              { message: { role: "assistant", content: t.text, ...(calls ? { tool_calls: calls } : {}) } },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
          text: async () => "",
        } as unknown as Response;
      }
      const enc = new TextEncoder();
      const frames = (t.text.match(/[\s\S]{1,9}/g) ?? []).map(
        (p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`,
      );
      if (calls) {
        frames.push(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls.map((c, i) => ({ index: i, ...c })) } }] })}\n\n`,
        );
      }
      frames.push(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`,
      );
      frames.push("data: [DONE]\n\n");
      return {
        ok: true,
        status: 200,
        headers: { get: () => "text/event-stream" },
        body: new ReadableStream<Uint8Array>({
          start(c) {
            for (const f of frames) c.enqueue(enc.encode(f));
            c.close();
          },
        }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  async function transcriptOf(fetchFn: typeof fetch): Promise<string[]> {
    const ws = workspace();
    writeFileSync(join(ws.dir, "a.txt"), "alpha\n");
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const engine = new Engine({
      baseUrl: "http://p.test/v1",
      model: "m",
      cwd: ws.dir,
      bar: null,
      autonomy: "high",
      fetchFn,
      stream: true,
    });
    const app = renderApp(
      { engine, version: "vtest" },
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        debug: true,
        patchConsole: false,
      },
    );
    try {
      await tick(80);
      await submit(stdin, "go");
      await tick(500);
      return (stdout.frames.at(-1) ?? "").split("\n");
    } finally {
      app.unmount();
      ws.cleanup();
    }
  }

  it("keeps the blank line the model put between its paragraphs", async () => {
    // Ink drops a whitespace-only `<Static>` item when items arrive one at a
    // time, which is exactly how streamed output arrives — so every paragraph
    // break the model wrote was deleted and its prose arrived as one block.
    const lines = await transcriptOf(
      sayingProvider([{ text: "First thought.\n\nSecond thought." }]),
    );
    const first = lines.findIndex((l) => l.includes("First thought."));
    const second = lines.findIndex((l) => l.includes("Second thought."));
    assert.ok(first !== -1 && second !== -1, "the prose never reached the screen");
    assert.equal(second, first + 2, "the paragraph break was swallowed");
    assert.equal(lines[first + 1]!.trim(), "", "expected a blank line between the paragraphs");
  });

  it("does not turn a run of blank lines into a run of blank rows", async () => {
    // A model that leaves four blank lines did not mean four.
    const lines = await transcriptOf(sayingProvider([{ text: "One.\n\n\n\n\nTwo." }]));
    const one = lines.findIndex((l) => l.includes("One."));
    const two = lines.findIndex((l) => l.includes("Two."));
    assert.equal(two, one + 2, `expected one blank line between them, got ${two - one - 1}`);
  });

  it("shows what the model said before a tool call, streaming or not", async () => {
    for (const streaming of [true, false]) {
      const lines = await transcriptOf(
        sayingProvider([{ text: "Reading the file first.", call: "a.txt" }, { text: "Done." }], streaming),
      );
      assert.ok(
        lines.some((l) => l.includes("Reading the file first.")),
        `${streaming ? "streamed" : "non-streamed"}: the model's reason for the call was dropped`,
      );
      const said = lines.findIndex((l) => l.includes("Reading the file first."));
      const call = lines.findIndex((l) => l.includes("read_file"));
      assert.ok(said < call, "the narration landed below the call it was introducing");
    }
  });
});

describe("getting out", () => {
  it("escapes a salvage that will not finish", async () => {
    // The reported bug: hitting the budget runs a salvage, the salvage's
    // request was the one request molt never made cancellable, and ctrl+C
    // reached a controller that had already been cleared. molt sat there
    // busy and unquittable at exactly the moment you wanted out.
    const ws = workspace();
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    let hung = 0;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      // The first request answers; the salvage that follows never does.
      if (hung++ === 0) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({
            choices: [{ message: { role: "assistant", content: "spending" } }],
            usage: { prompt_tokens: 900, completion_tokens: 40 },
          }),
          text: async () => "",
        } as unknown as Response;
      }
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    }) as unknown as typeof fetch;
    const engine = new Engine({
      baseUrl: "http://p.test/v1",
      model: "m",
      cwd: ws.dir,
      bar: null,
      stream: false,
      fetchFn,
    });
    engine.setBudget(500);
    const app = renderApp(
      { engine, version: "vtest" },
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        debug: true,
        patchConsole: false,
      },
    );
    let exited = false;
    void app.waitUntilExit().then(() => {
      exited = true;
    });
    try {
      await tick(80);
      await submit(stdin, "spend it");
      // Second turn: over budget, so it errors and salvages — into the hang.
      void submit(stdin, "again");
      await tick(400);
      assert.match(stdout.lastFrame, /thinking|working|responding/, "the turn was not actually running");

      stdin.press(CTRL_C);
      await tick(400);
      // One press is enough now that the salvage can be aborted: the turn ends
      // and the prompt comes back.
      assert.equal(exited, false, "the first press took the whole session down");
      assert.ok(
        !/shift\+V to watch/.test(stdout.lastFrame),
        "still busy after ctrl+C — the hung request was never cancelled",
      );
      // And molt is usable again rather than wedged: it can still be quit.
      stdin.press(CTRL_C);
      await tick(120);
      stdin.press(CTRL_C);
      await tick(300);
      assert.equal(exited, true, "molt was left in a state it could not be quit from");
    } finally {
      app.unmount();
      ws.cleanup();
    }
  });
  it("leaves even when the request ignores being cancelled", async () => {
    // The backstop. Aborting the salvage fixed the hang that was reported, but
    // "you can always get out" should not rest on having fixed every possible
    // hang — so a second press leaves regardless of what the turn is doing.
    const ws = workspace();
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    // Never resolves, and pays no attention to the signal.
    const fetchFn = (async () => new Promise(() => {})) as unknown as typeof fetch;
    const engine = new Engine({
      baseUrl: "http://p.test/v1",
      model: "m",
      cwd: ws.dir,
      bar: null,
      stream: false,
      fetchFn,
    });
    const app = renderApp(
      { engine, version: "vtest" },
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        debug: true,
        patchConsole: false,
      },
    );
    let exited = false;
    void app.waitUntilExit().then(() => {
      exited = true;
    });
    try {
      await tick(80);
      void submit(stdin, "hang");
      await tick(300);
      stdin.press(CTRL_C);
      await tick(200);
      assert.equal(exited, false, "one press should ask, not quit");
      assert.match(stdout.lastFrame, /ctrl\+C again to exit/, "never offered the way out");
      stdin.press(CTRL_C);
      await tick(300);
      assert.equal(exited, true, "molt held the terminal hostage");
    } finally {
      app.unmount();
      ws.cleanup();
    }
  });
});

describe("the delete keys", () => {
  /** What a terminal really sends for each of them. */
  const BACKSPACE = "\x7f";
  const FORWARD_DELETE = "\x1b[3~";
  const ALT_BACKSPACE = "\x1b\x7f";
  const LEFT = "\x1b[D";

  /** Type `text`, move the caret left `back` times, then press `key`. */
  async function afterPressing(text: string, back: number, key: string): Promise<string> {
    const t = await mount();
    try {
      for (const ch of text) t.stdin.press(ch);
      await tick(60);
      for (let i = 0; i < back; i++) t.stdin.press(LEFT);
      await tick(60);
      t.stdin.press(key);
      await tick(80);
      // The prompt line, with molt's caret glyphs and marker stripped out.
      const line = t.stdout.lastFrame
        .split("\n")
        .find((l) => l.includes("›") && !l.includes("step"))
        ?.replace(/[›▌]/g, "")
        .trim();
      return line ?? "";
    } finally {
      t.cleanup();
    }
  }

  it("deletes backwards when you press Backspace mid-line", async () => {
    // Reported from use: "the delete key deletes forward for some reason".
    // Ink labels the Backspace key `delete` — its own source has a TODO about
    // it — and molt guessed between the two from the caret position, so at the
    // end of a line it did the right thing and everywhere else it ate the
    // character in front instead of the one behind.
    const after = await afterPressing("abcdef", 2, BACKSPACE);
    assert.equal(after, "abcef", `Backspace mid-line produced "${after}"`);
  });

  it("still deletes backwards at the end of a line", async () => {
    const after = await afterPressing("abcdef", 0, BACKSPACE);
    assert.equal(after, "abcde", `Backspace at the end produced "${after}"`);
  });

  it("deletes forwards when you press the forward-delete key", async () => {
    // The other half: these two arrive from Ink indistinguishable, so fixing
    // one by guessing would always have broken the other.
    const after = await afterPressing("abcdef", 2, FORWARD_DELETE);
    assert.equal(after, "abcdf", `forward Delete produced "${after}"`);
  });

  it("keeps alt+Backspace deleting the word behind the caret", async () => {
    const after = await afterPressing("src/app.tsx and more", 0, ALT_BACKSPACE);
    assert.equal(after, "src/app.tsx and", `alt+Backspace produced "${after}"`);
  });
});

describe("pasting more than one line", () => {
  /**
   * How many rows the prompt occupies, which is the thing that tears.
   *
   * Measured on the prompt itself rather than on the frame height: the frame
   * includes the transcript above, which legitimately grows as molt prints
   * things, and a test that watched the total passed for reasons that had
   * nothing to do with the prompt.
   */
  function promptRows(frame: string, columns: number): number {
    const lines = frame.split("\n");
    let start = -1;
    lines.forEach((l, i) => {
      if (l.includes("›")) start = i;
    });
    if (start === -1) return 0;
    // Down to the status row, which always sits directly under the prompt.
    // Counting only the line carrying the caret misses the rows a block spills
    // onto, which is the entire failure being tested.
    //
    // Zero when there is no status row yet: early frames are still drawing the
    // splash, and running to the end of the frame there measures the banner
    // rather than the prompt. Callers drop the zeros.
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
      if (/auto (low|medium|high)/.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    if (end === -1) return 0;
    const drawn = lines.slice(start, end);
    // Plus whatever the terminal itself wraps.
    return drawn.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / columns)), 0);
  }

  it("keeps the prompt one row tall however much is pasted", async () => {
    // A paste arrives in several reads, and the prompt is a live region: an
    // eight-line block re-rendered it at eight different heights on the way in,
    // and the terminal — which repaints by erasing a line count — interleaved
    // the result. Reported from use as lines overwritten, fragments in the
    // wrong order, and whole lines missing.
    const t = await mount();
    try {
      const paste = Array.from({ length: 8 }, (_, i) => `line ${i + 1} of the pasted block`).join("\n");
      for (const chunk of paste.match(/[\s\S]{1,30}/g) ?? []) {
        t.stdin.press(chunk);
        await tick(25);
      }
      await tick(60);
      const rows = t.stdout.frames.slice(-6).map((f) => promptRows(f, 100)).filter((n) => n > 0);
      assert.ok(rows.length >= 3, `only ${rows.length} frames were measurable`);
      assert.deepEqual(
        [...new Set(rows)],
        [1],
        `the prompt changed height while the paste arrived: ${rows.join(" -> ")} rows`,
      );
    } finally {
      t.cleanup();
    }
  });

  it("says up front how much it is holding", async () => {
    // Showing the opening words with a trailing "+2 more lines" read as
    // truncation — reported as "it only pastes some of the text" — when every
    // character had in fact been kept. The count goes first now, before the
    // eye reaches anything that looks cut off.
    const t = await mount();
    try {
      const paste = "first line\nsecond line\nthird line";
      t.stdin.press(paste);
      await tick(80);
      const frame = t.stdout.lastFrame;
      const prompt = frame.split("\n").find((l) => l.includes("›")) ?? "";
      assert.match(prompt, /\[3 lines, 33 chars\]/, "did not say what it was holding");
      assert.ok(prompt.indexOf("[3 lines") < prompt.indexOf("first line"), "the count came after the preview");
      assert.ok(!frame.includes("third line"), "still drawing the whole block");
    } finally {
      t.cleanup();
    }
  });

  it("fits the prompt in the window even when the first line is long", async () => {
    // A long first line wraps to two rows on its own, which puts the height
    // back where it started: changing while the paste arrives.
    const t = await mount({}, 60);
    try {
      const paste = `${"x".repeat(400)}\nsecond line\nthird line`;
      for (const chunk of paste.match(/[\s\S]{1,25}/g) ?? []) {
        t.stdin.press(chunk);
        await tick(15);
      }
      await tick(60);
      const rows = t.stdout.frames.slice(-6).map((f) => promptRows(f, 60)).filter((n) => n > 0);
      assert.ok(rows.length >= 3, `only ${rows.length} frames were measurable`);
      assert.deepEqual(
        [...new Set(rows)],
        [1],
        `a 400-character first line wrapped the prompt to ${rows.join("/")} rows`,
      );
    } finally {
      t.cleanup();
    }
  });

  it("sends every character that was pasted", async () => {
    // Bounding the display must not bound the message.
    const t = await mount();
    try {
      const paste = "explain this trace:\n  at foo (a.ts:1)\n  at bar (b.ts:2)";
      t.stdin.press(paste);
      await tick(60);
      t.stdin.press("\r");
      await tick(300);
      const text = t.stdout.text;
      for (const fragment of ["explain this trace:", "at foo (a.ts:1)", "at bar (b.ts:2)"]) {
        assert.ok(text.includes(fragment), `"${fragment}" never reached the transcript`);
      }
    } finally {
      t.cleanup();
    }
  });
});
