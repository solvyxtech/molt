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
import { createElement } from "react";
import { describe, it } from "node:test";
import { render } from "ink";
import { App } from "../src/app.js";
import { Engine } from "../src/engine.js";
import type { Msg } from "../src/types.js";
import { workspace } from "./helpers.js";

/** What a terminal sends for ctrl+V and ctrl+A. */
const CTRL_V = String.fromCharCode(22);
const CTRL_A = String.fromCharCode(1);

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
  const app = render(createElement(App, { engine, version: "vtest" }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
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
