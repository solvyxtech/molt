/**
 * A request that has gone silent, and a turn whose time is up.
 *
 * molt put no clock on a model request. A connection the server accepted and
 * never answered — a wedged local server, a proxy holding the socket, a laptop
 * that slept through a handshake — held the turn open for ever: no error, no
 * retry, no salvage. `molt run` in CI never exited. And `--for` was only read
 * at the top of the step loop, so a turn given five minutes that sent its
 * request at minute four waited on it indefinitely.
 *
 * This is a watchdog on silence, not a budget on work. It is reset by every
 * byte that arrives — response headers and each chunk of a stream — so a long
 * answer that keeps talking is never cut off, however long it runs. What it
 * ends is a request that has said *nothing* for longer than any healthy one
 * would:
 *
 *  - before the first byte, the server may be reading the prompt. Prefill is
 *    slow on local hardware and scales with the prompt, so the first-byte
 *    allowance grows with it, at the slowest plausible prefill rate. A
 *    request that is not streamed sends nothing until the whole answer is
 *    written, so its allowance grows with the output ceiling as well.
 *  - after the first byte, a stream that goes quiet for the idle allowance
 *    has stopped.
 *
 * Firing is reported as `idle` and treated by the engine as a network failure
 * — retried with backoff, then the turn closes with a salvage — because that
 * is what it is. The deadline is separate: it fires once, at the turn's wall
 * clock limit, and ends the request so the turn can close the way every other
 * deadline closes. Neither exists unless its number is positive.
 */

/**
 * Silence, in ms, after which a request is taken to be hung.
 *
 * Five minutes. A hosted provider sends headers in well under a second and
 * streams tokens every few hundred milliseconds; five minutes of nothing is
 * not a slow answer. Overridden per engine (`requestIdleMs`) or by
 * `MOLT_REQUEST_IDLE_MS`; 0 turns the watchdog off.
 */
export const REQUEST_IDLE_MS = 5 * 60_000;

/**
 * The slowest prefill and generation rates the first-byte allowance assumes,
 * in ms per token: 50 tokens/s to read the prompt, 10 tokens/s to write the
 * answer. Both are below what a small laptop does on a large local model, so
 * a real server that is working is never mistaken for a hung one.
 */
export const PREFILL_MS_PER_TOKEN = 20;
export const GENERATE_MS_PER_TOKEN = 100;

/** How long to wait for the first byte of a request. */
export function firstByteMs(
  idleMs: number,
  req: { promptTokens: number; maxTokens: number; stream: boolean },
): number {
  if (!(idleMs > 0)) return 0;
  const prefill = Math.max(0, req.promptTokens) * PREFILL_MS_PER_TOKEN;
  const whole = req.stream ? 0 : Math.max(0, req.maxTokens) * GENERATE_MS_PER_TOKEN;
  return Math.max(idleMs, prefill + whole);
}

/** The idle allowance an engine runs with: its own setting, then the environment, then the default. */
export function requestIdleMs(configured?: number, env = process.env.MOLT_REQUEST_IDLE_MS): number {
  if (configured !== undefined) return Math.max(0, configured);
  if (env !== undefined && env.trim() !== "") {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return REQUEST_IDLE_MS;
}

export class Watchdog {
  private readonly own = new AbortController();
  /** Aborts on the parent (a cancel), on silence, or at the deadline. */
  readonly signal: AbortSignal;
  /** Why it fired, if it did. A cancel is the parent's, and is not recorded here. */
  reason: "idle" | "deadline" | undefined;
  /** The allowance that ran out, for the message. */
  waitedMs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    parent: AbortSignal,
    private readonly opts: { firstByteMs: number; idleMs: number; deadlineAt?: number },
  ) {
    this.signal = AbortSignal.any([parent, this.own.signal]);
    this.arm(opts.firstByteMs);
    if (opts.deadlineAt !== undefined && opts.deadlineAt > 0) {
      const left = opts.deadlineAt - Date.now();
      if (left <= 0) this.fire("deadline", 0);
      else {
        this.deadlineTimer = setTimeout(() => this.fire("deadline", left), left);
        this.deadlineTimer.unref?.();
      }
    }
  }

  /** Something arrived. Silence is measured from here. */
  touch(): void {
    if (!this.reason) this.arm(this.opts.idleMs);
  }

  /** Wrap a response body so every chunk that arrives counts as progress. */
  watch(res: Response): Response {
    this.touch();
    if (!res.ok || !res.body || res.status === 204 || typeof TransformStream === "undefined") return res;
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, out) => {
          this.touch();
          out.enqueue(chunk);
        },
      }),
    );
    // Not `new Response(body, …)`: that re-parses the headers, and a
    // response that is not a real `Response` — a proxy's, a test's — loses
    // its content type on the way through and stops being read as a stream.
    // Everything but the body is the original's own.
    const read = () => new Response(body).text();
    return Object.assign(Object.create(null) as Response, {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      url: res.url,
      body,
      text: read,
      json: async () => JSON.parse(await read()) as unknown,
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.timer = this.deadlineTimer = undefined;
  }

  private arm(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = ms > 0 ? setTimeout(() => this.fire("idle", ms), ms) : undefined;
    // Never what keeps a process alive. A live request holds its socket, and
    // that is what should; a watchdog left armed by a generator its consumer
    // abandoned must not hold `molt run` open for five minutes after the end.
    this.timer?.unref?.();
  }

  private fire(reason: "idle" | "deadline", waited: number): void {
    if (this.reason) return;
    this.reason = reason;
    this.waitedMs = waited;
    this.dispose();
    this.own.abort(new Error(reason === "idle" ? "request went silent" : "turn deadline reached"));
  }
}

/** "4m 0s", "12s", "800ms" — how long molt waited, for a person to read. */
export function waited(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * How long a probe — a `/models` listing, a price lookup — may take.
 *
 * Twenty seconds. A probe is not a model request: any healthy server answers
 * it at once, and nothing about it scales with a prompt. Without a bound, one
 * saved endpoint that accepts connections and never answers held `/model`'s
 * picker on "busy" for ever, because it asks every provider at once and waits
 * for all of them, and `molt doctor` — the command for finding out what is
 * wrong — hung on the very fault it exists to report.
 */
export const PROBE_TIMEOUT_MS = 20_000;

/** A signal that ends a probe after `ms`, or none when `ms` is 0. */
export function probeSignal(ms = PROBE_TIMEOUT_MS): AbortSignal | undefined {
  return ms > 0 ? AbortSignal.timeout(ms) : undefined;
}

/** What a failed probe says: its own timeout named as such, anything else as it came. */
export function probeError(e: unknown, url: string, ms = PROBE_TIMEOUT_MS): string {
  const name = (e as { name?: string } | null)?.name;
  return name === "TimeoutError" ? `no answer from ${url} in ${waited(ms)}` : String(e);
}

/**
 * How long a one-shot question to the model — a criteria draft, an interview
 * round — may wait for its answer.
 *
 * These are not streamed, so the whole answer is one silence: the allowance
 * is the first-byte one for a short prompt and this output ceiling. Before
 * this they had none, and an endpoint that accepted the connection and never
 * answered left the window's checks panel reading "asking the model…" for
 * ever.
 */
export function askTimeoutMs(maxTokens: number, override?: number): number {
  if (override !== undefined) return Math.max(0, override);
  return firstByteMs(requestIdleMs(), { promptTokens: 2_000, maxTokens, stream: false });
}

/** A failed one-shot question, with its own timeout named as such. */
export function askError(e: unknown, ms: number, fallback: (e: unknown) => string): string {
  const name = (e as { name?: string } | null)?.name;
  return name === "TimeoutError" ? `the model did not answer within ${waited(ms)}` : fallback(e);
}
