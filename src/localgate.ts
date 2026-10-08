/**
 * One request at a time to a self-hosted model server.
 *
 * A llama.cpp server on a small machine has one slot: requests queue behind
 * each other. Maat sends several at once — the turn's step, the drafter and
 * its critic, the reference writers — which on a cloud API saves minutes and
 * on one slot only makes each of them wait for the others. On the NUC's
 * Qwen3.8-27B the turn's first request sat behind a drafter that thought for
 * 5,700 tokens at 10 tokens/s, got no byte for five minutes, was declared
 * hung, cancelled and sent again to the back of the queue; four times, then
 * the task failed with zero steps. Every local task did.
 *
 * So requests to a self-hosted endpoint take turns here, in order, and the
 * caller starts its hang watchdog only once it holds the turn: waiting in
 * Maat's own queue is not the server being hung.
 */
import { env } from "./env.js";
import { isSelfHosted } from "./providers.js";

type Waiter = { go: () => void };

const queues = new Map<string, { busy: number; waiting: Waiter[] }>();

/**
 * How many requests the self-hosted server serves at once: `MAAT_LOCAL_SLOTS`
 * (llama.cpp's `--parallel`), else 1.
 */
function slots(): number {
  const n = Number(env("LOCAL_SLOTS"));
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function keyOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return baseUrl;
  }
}

/**
 * Wait for this endpoint's turn. Returns the release function (safe to call
 * more than once). For an endpoint that is not self-hosted it returns at once:
 * a cloud API serves requests side by side.
 */
export async function takeTurn(baseUrl: string, signal?: AbortSignal): Promise<() => void> {
  if (!isSelfHosted(baseUrl)) return () => {};
  // Already cancelled: no turn to wait for, and an abort event that already
  // fired would never wake the waiter below.
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  const key = keyOf(baseUrl);
  let q = queues.get(key);
  if (!q) queues.set(key, (q = { busy: 0, waiting: [] }));
  const queue = q;
  if (queue.busy >= slots()) {
    // A released slot is handed straight to the next waiter (see below), so
    // a newcomer can never slip in between and put two on one slot.
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = { go: resolve };
      queue.waiting.push(w);
      signal?.addEventListener(
        "abort",
        () => {
          const i = queue.waiting.indexOf(w);
          if (i !== -1) {
            queue.waiting.splice(i, 1);
            reject(signal.reason ?? new Error("aborted"));
          }
        },
        { once: true },
      );
    });
  } else {
    queue.busy += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = queue.waiting.shift();
    if (next) next.go();
    else queue.busy -= 1;
  };
}

/** How many callers are waiting for this endpoint now. Tests only. */
export function waitingFor(baseUrl: string): number {
  return queues.get(keyOf(baseUrl))?.waiting.length ?? 0;
}
