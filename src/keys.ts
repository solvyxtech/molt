/**
 * Making the delete keys mean what they say.
 *
 * Reported from use: "the delete key deletes forward for some reason". It did,
 * and only sometimes, which is the worst version of the bug.
 *
 * Terminals send DEL (0x7f) for the key labelled Backspace — the big one above
 * Return on a Mac keyboard — and the escape sequence `ESC [ 3 ~` for the
 * separate forward-delete (fn+Backspace, or Del on a full keyboard). Ink parses
 * those into `key.backspace` and `key.delete`, and gets them the wrong way
 * round: it maps 0x08 (ctrl+H) to `backspace` and **0x7f to `delete`**. Its own
 * source carries a TODO admitting the split was a mistake kept for
 * compatibility.
 *
 * The consequence is that the key you press a hundred times an hour arrives
 * labelled as the one you press once a week — and because `ESC [ 3 ~` *also*
 * arrives as `delete`, with an empty `input` string in both cases, nothing in
 * Ink's public API can tell them apart. Measured:
 *
 *     macOS Backspace (0x7f)   -> input=""  key=delete
 *     forward Delete (ESC[3~)  -> input=""  key=delete      <- identical
 *     ctrl+H (0x08)            -> input=""  key=backspace
 *     alt+Backspace (ESC 0x7f) -> input=""  key=delete+meta
 *
 * molt had been guessing between them from the caret position: delete forward
 * if there is anything ahead of the caret, otherwise delete backwards. That is
 * why it looked erratic rather than simply wrong — at the end of a line it did
 * the right thing, and mid-line it ate the wrong character.
 *
 * A guess cannot be fixed by guessing better, so the distinction is restored
 * where it still exists: in the bytes, before Ink sees them. 0x7f becomes 0x08
 * on the way in, so Backspace arrives as `key.backspace` and `key.delete` is
 * left meaning only the key that actually deletes forward. `ESC 0x7f`
 * (alt+Backspace) becomes `ESC 0x08`, which keeps delete-word-backwards intact.
 *
 * Nothing else uses 0x7f: it is a control code with no place in typed text, so
 * rewriting every occurrence is safe even inside a pasted chunk or a run of
 * repeats from a held key.
 */
import { EventEmitter } from "node:events";

/** DEL, which every terminal sends for the Backspace key. */
const DEL = 0x7f;
/** BS, which is what Ink is willing to call a backspace. */
const BS = 0x08;

/** Rewrite DEL to BS in one chunk of terminal input, Buffer or string alike. */
export function remapDelete<T extends Buffer | string>(chunk: T): T {
  if (typeof chunk === "string") {
    return chunk.replace(/\x7f/g, "\b") as T;
  }
  if (!chunk.includes(DEL)) return chunk;
  const out = Buffer.from(chunk);
  for (let i = 0; i < out.length; i++) if (out[i] === DEL) out[i] = BS;
  return out as T;
}

/**
 * A stdin that hands Ink the same keystrokes with the delete keys untangled.
 *
 * A proxy rather than a transform stream because of how Ink reads: it listens
 * for `readable` and drains `read()` itself, so what it needs is an object with
 * that shape — and one that still forwards `setRawMode`, `ref` and `unref` to
 * the real terminal, since those are what put it in raw mode in the first
 * place.
 */
export class RemappedStdin extends EventEmitter {
  constructor(private readonly real: NodeJS.ReadStream) {
    super();
    // `readable` is the signal Ink waits on; the bytes are fetched by its own
    // call to read() below, which is where the rewrite happens.
    this.real.on("readable", () => this.emit("readable"));
    this.real.on("end", () => this.emit("end"));
    this.real.on("close", () => this.emit("close"));
    this.real.on("error", (e) => this.emit("error", e));
  }

  get isTTY(): boolean {
    return Boolean(this.real.isTTY);
  }

  read(): Buffer | string | null {
    const chunk = this.real.read() as Buffer | string | null;
    return chunk === null ? null : remapDelete(chunk);
  }

  setRawMode(mode: boolean): this {
    this.real.setRawMode?.(mode);
    return this;
  }

  setEncoding(encoding: BufferEncoding): this {
    this.real.setEncoding?.(encoding);
    return this;
  }

  resume(): this {
    this.real.resume?.();
    return this;
  }

  pause(): this {
    this.real.pause?.();
    return this;
  }

  ref(): void {
    this.real.ref?.();
  }

  unref(): void {
    this.real.unref?.();
  }
}
