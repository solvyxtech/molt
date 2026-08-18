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

/** What a terminal sends for ctrl+V. */
const CTRL_V = String.fromCharCode(22);

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

async function mount(over: Record<string, unknown> = {}) {
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
      assert.match(t.stdout.text, /v to watch/, "never told anyone the view exists");
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
      assert.match(frame, /\$0\.0026/);
    } finally {
      t.cleanup();
    }
  });

  it("takes a bare v while the turn is running, which is when it is asked", async () => {
    // The prompt takes no typing mid-turn, so a letter is free there — and
    // free is what a key has to be to earn the shortest binding.
    const t = await mount({ fetchFn: slowProvider(150) });
    try {
      void submit(t.stdin, "read the seed");
      await tick(80);
      t.stdin.press("v");
      await tick(600);
      assert.match(t.stdout.lastFrame, /what the model is doing/, "v showed nothing");
    } finally {
      t.cleanup();
    }
  });

  it("does not eat a v typed into a message", async () => {
    const t = await mount();
    try {
      for (const ch of "verify this") t.stdin.press(ch);
      await tick(60);
      assert.match(t.stdout.lastFrame, /verify this/, "swallowed a letter someone was typing");
      assert.ok(
        !/what the model is doing/.test(t.stdout.lastFrame),
        "opened the view mid-word",
      );
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
      assert.match(frame, /job 1 unverified · 2 step\(s\) · 2\.4k in · 60 out · \$0\.0052/);
      assert.match(frame, /job 2 unverified · 1 step\(s\) · 1\.2k in · 30 out · \$0\.0026/);
    } finally {
      t.cleanup();
    }
  });
});
