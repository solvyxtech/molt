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
/** CR, which is what a terminal sends for a line ending. */
const CR = 0x0d;
/** LF, which is what everything above this file means by one. */
const LF = 0x0a;

/**
 * Rewrite one chunk of terminal input into the alphabet the editor reads.
 *
 * Two substitutions, both because a terminal does not speak quite the same
 * language as the program above it.
 *
 * **DEL becomes BS**, so the Backspace key stops arriving labelled as
 * forward-delete. See the note at the top of this file.
 *
 * **CR becomes LF, inside a paste only.** A terminal sends carriage return for
 * a line ending: pressing Return sends `\r`, and so does every newline inside
 * a pasted block. Nothing downstream expected that. The prompt splits on `\n`,
 * so a pasted block read as one enormous line and its summary never fired —
 * and worse, the raw `\r` characters reached the screen, where they mean
 * "return to column one", so each pasted line was drawn on top of the one
 * before it. That is the interleaved, half-missing text reported three times.
 * The input was never lost; it was overwritten in place.
 *
 * Only in chunks longer than one character. A chunk that *is* `\r` is the
 * Return key, and turning that into a newline would leave the prompt with no
 * way to be submitted at all.
 */
export function remapInput<T extends Buffer | string>(chunk: T): T {
  const paste = chunk.length > 1;
  if (typeof chunk === "string") {
    const swapped = chunk.replace(/\x7f/g, "\b");
    // `\r\n` collapses to a single newline; a bare `\r` becomes one.
    return (paste ? swapped.replace(/\r\n?/g, "\n") : swapped) as T;
  }
  if (!chunk.includes(DEL) && !(paste && chunk.includes(CR))) return chunk;
  // Byte by byte rather than through a string: a chunk can split a multi-byte
  // character down the middle, and decoding half of one turns pasted text into
  // replacement characters.
  const out = Buffer.alloc(chunk.length);
  let n = 0;
  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i]!;
    if (b === DEL) out[n++] = BS;
    else if (paste && b === CR) {
      out[n++] = LF;
      // Skip the LF of a CRLF pair, so one line ending stays one newline.
      if (chunk[i + 1] === LF) i++;
    } else out[n++] = b;
  }
  return out.subarray(0, n) as T;
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
    return chunk === null ? null : remapInput(chunk);
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
