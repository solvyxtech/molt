/**
 * Turning a callback-driven reader into something a generator can yield from.
 *
 * The engine reads a provider stream through a callback, and an async generator
 * cannot yield from inside one. The original answer was to buffer every
 * fragment and re-yield them once the read finished, with a comment saying a
 * few hundred milliseconds of earlier paint was not worth the complexity.
 *
 * It was not a few hundred milliseconds. On a local endpoint a step takes tens
 * of seconds, and buffering meant the window showed nothing at all until the
 * whole message had arrived — no text, no sign of a tool call, nothing. Three
 * runs in one session were cancelled during that silence, the last of them
 * three seconds before its first tool call would have fired. A person watching
 * an empty screen concludes the thing is broken, and they are not wrong to.
 *
 * So: a queue the callback pushes into and the generator drains.
 */

export class Fragments {
  private queue: string[] = [];
  private wake?: () => void;
  private done = false;

  push(text: string): void {
    if (text.length === 0) return;
    this.queue.push(text);
    this.wake?.();
    this.wake = undefined;
  }

  /** No more will arrive. Drains what is left, then ends. */
  finish(): void {
    this.done = true;
    this.wake?.();
    this.wake = undefined;
  }

  async *drain(): AsyncGenerator<string> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/**
 * How much text is held back before emitting, in characters.
 *
 * Redaction is the reason this exists. molt masks secrets on every path out,
 * and the buffered version could redact the whole message at once — but a live
 * stream arrives in fragments, and a key split across two of them matches
 * neither half. Holding a tail longer than any credential means the boundary is
 * always inside the buffer when the match is attempted.
 *
 * Longer than the longest key molt has seen by a wide margin. The cost is that
 * the last few hundred characters of a message appear when it ends rather than
 * as they arrive, which nobody can perceive; the cost of getting it wrong is a
 * key on screen.
 */
export const REDACT_TAIL = 512;

/**
 * Emit text as it arrives, without letting a secret through a chunk boundary.
 *
 * `redactFn` is applied to everything before it leaves. Call `flush()` when the
 * stream ends to release the held tail.
 */
export class SafeStream {
  private held = "";

  constructor(private readonly redactFn: (s: string) => string) {}

  /** What is safe to show now, or "" while everything is still in the tail. */
  take(fragment: string): string {
    this.held += fragment;
    if (this.held.length <= REDACT_TAIL) return "";
    const emit = this.held.slice(0, this.held.length - REDACT_TAIL);
    this.held = this.held.slice(this.held.length - REDACT_TAIL);
    return this.redactFn(emit);
  }

  /** The remainder, once nothing more can arrive. */
  flush(): string {
    const rest = this.held;
    this.held = "";
    return rest ? this.redactFn(rest) : "";
  }
}
