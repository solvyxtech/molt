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
import { env as readEnv } from "./env.js";

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

/** Assumed rates for a request's first-byte allowance, in ms per token. */
export type Speed = { prefillMsPerToken: number; generateMsPerToken: number };

/**
 * The rates for a self-hosted server: `MAAT_LOCAL_PREFILL_TPS` (default 10)
 * and `MAAT_LOCAL_GENERATE_TPS` (default 5), in tokens per second.
 *
 * The defaults above are a laptop's. The NUC's integrated GPU reads a prompt
 * at about 39 tokens/s; Maat's first request of a task (system prompt, tools,
 * brief) is long enough that the first byte came after more than five
 * minutes, the request was called hung and sent again three times, and the
 * criteria draft timed out the same way, so a correct fix-git ended with no
 * checks at all. A server that is slow is not one that is hung: once bytes
 * flow, the idle allowance still catches a real stall.
 */
export function localSpeed(env: (name: string) => string | undefined = readEnv): Speed {
  const tps = (name: string, fallback: number) => {
    const n = Number(env(name));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return { prefillMsPerToken: 1000 / tps("LOCAL_PREFILL_TPS", 10), generateMsPerToken: 1000 / tps("LOCAL_GENERATE_TPS", 5) };
}

/** How long to wait for the first byte of a request. */
export function firstByteMs(
  idleMs: number,
  req: { promptTokens: number; maxTokens: number; stream: boolean },
  speed: Speed = { prefillMsPerToken: PREFILL_MS_PER_TOKEN, generateMsPerToken: GENERATE_MS_PER_TOKEN },
): number {
  if (!(idleMs > 0)) return 0;
  const prefill = Math.max(0, req.promptTokens) * speed.prefillMsPerToken;
  const whole = req.stream ? 0 : Math.max(0, req.maxTokens) * speed.generateMsPerToken;
  return Math.max(idleMs, prefill + whole);
}

/**
 * A fixed first-byte allowance from the environment, or undefined.
 *
 * The computed allowance assumes local hardware: 50 tokens/s to read the
 * prompt and, for a request that is not streamed, 10 tokens/s to write the
 * whole answer. Against a hosted model that is fifty minutes of silence
 * before a request counts as hung. On Terminal-Bench, Space Bunny Alpha
 * stalled a request now and then, and molt waited on it until the task's
 * fifteen-minute clock killed the run — five tasks lost that way. A caller
 * that knows its endpoint answers in seconds says so here.
 */
export function envFirstByteMs(env = readEnv("REQUEST_FIRST_BYTE_MS")): number | undefined {
  if (env === undefined || env.trim() === "") return undefined;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The idle allowance an engine runs with: its own setting, then the environment, then the default. */
export function requestIdleMs(configured?: number, env = readEnv("REQUEST_IDLE_MS")): number {
  if (configured !== undefined) return Math.max(0, configured);
  if (env !== undefined && env.trim() !== "") {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return REQUEST_IDLE_MS;
}

/** Whether a body chunk holds only SSE comment lines and blank lines. */
export function keepAliveOnly(chunk: Uint8Array): boolean {
  const text = new TextDecoder().decode(chunk);
  return text.split(/\r?\n/).every((line) => line.trim() === "" || line.startsWith(":"));
}

/**
 * How long this session's provider normally takes, learned from requests that
 * completed: time to first progress and the longest silence inside an answer.
 *
 * The fixed allowances are sized for slow local hardware — five minutes of
 * silence before a request counts as hung. Mercury 2.5 answers a step in about
 * a second, yet on the local suite it stalled now and then, OpenRouter gave up
 * after 120 s with "504 Upstream idle timeout", and one task spent 370 of its
 * 540 s inside three such stalls. With three or more completed requests seen,
 * the allowance becomes eight times the slow end (90th percentile) of what
 * this provider has done, never under 45 s, never over the fixed allowance.
 */
export class LatencyLearner {
  static readonly MIN_SAMPLES = 3;
  static readonly FACTOR = 8;
  static readonly FLOOR_MS = 45_000;
  private first: number[] = [];
  private gaps: number[] = [];

  record(w: { firstProgressMs: number | undefined; maxGapMs: number }): void {
    if (w.firstProgressMs === undefined) return;
    this.first = [...this.first, w.firstProgressMs].slice(-20);
    this.gaps = [...this.gaps, w.maxGapMs].slice(-20);
  }

  /** The first-byte allowance, tightened to what this provider has shown. */
  firstByte(fixed: number): number {
    return this.tighten(fixed, this.first);
  }

  /** The first-byte allowance this provider has earned, or undefined before enough requests completed. */
  learnedFirstByte(): number | undefined {
    const fixed = Number.POSITIVE_INFINITY;
    const n = this.tighten(fixed, this.first);
    return n === fixed ? undefined : n;
  }

  /** The silence allowance once bytes flow, tightened the same way. */
  idle(fixed: number): number {
    return this.tighten(fixed, this.gaps);
  }

  private tighten(fixed: number, xs: number[]): number {
    if (!(fixed > 0) || xs.length < LatencyLearner.MIN_SAMPLES) return fixed;
    const sorted = [...xs].sort((a, b) => a - b);
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
    return Math.min(fixed, Math.max(LatencyLearner.FLOOR_MS, p90 * LatencyLearner.FACTOR));
  }
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
  private readonly startedAt = Date.now();
  private lastProgress: number | undefined;
  /** Time to the first real progress, and the longest silence between progress since. */
  firstProgressMs: number | undefined;
  maxGapMs = 0;

  constructor(
    parent: AbortSignal,
    private readonly opts: { firstByteMs: number; idleMs: number; deadlineAt?: number },
    learned?: LatencyLearner,
  ) {
    if (learned) this.opts = { ...opts, firstByteMs: learned.firstByte(opts.firstByteMs), idleMs: learned.idle(opts.idleMs) };
    this.signal = AbortSignal.any([parent, this.own.signal]);
    this.arm(this.opts.firstByteMs);
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
    if (this.reason) return;
    const now = Date.now();
    if (this.lastProgress === undefined) this.firstProgressMs = now - this.startedAt;
    else this.maxGapMs = Math.max(this.maxGapMs, now - this.lastProgress);
    this.lastProgress = now;
    this.arm(this.opts.idleMs);
  }

  /** Wrap a response body so every chunk that arrives counts as progress. */
  watch(res: Response): Response {
    this.touch();
    if (!res.ok || !res.body || res.status === 204 || typeof TransformStream === "undefined") return res;
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, out) => {
          // A chunk of SSE comments and blank lines only (OpenRouter's
          // ": OPENROUTER PROCESSING") keeps the connection open; it says
          // nothing about the answer, and a stalled upstream sends it too.
          if (!keepAliveOnly(chunk)) this.touch();
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
export function askTimeoutMs(maxTokens: number, override?: number, opts: { promptTokens?: number; speed?: Speed } = {}): number {
  if (override !== undefined) return Math.max(0, override);
  return firstByteMs(requestIdleMs(), { promptTokens: opts.promptTokens ?? 2_000, maxTokens, stream: false }, opts.speed);
}

/** A failed one-shot question, with its own timeout named as such. */
export function askError(e: unknown, ms: number, fallback: (e: unknown) => string): string {
  const name = (e as { name?: string } | null)?.name;
  return name === "TimeoutError" ? `the model did not answer within ${waited(ms)}` : fallback(e);
}
