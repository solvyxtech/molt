/**
 * Newline-delimited JSON-RPC 2.0, in both directions, over any byte stream.
 *
 * ACP is symmetric: whichever side molt is on, the other side both answers
 * molt's requests and makes its own. When molt drives Grok Build, the
 * agent asks molt for permission; when an editor drives molt, molt asks the
 * editor. A peer that only reads replies hangs the first time it is asked
 * something, so correlation, dispatch and framing live here once and both
 * directions use this copy.
 *
 * Transport-agnostic on purpose: `feed` takes whatever arrived, `write` is
 * handed one complete line. A child process's pipes, this process's own
 * stdio, and an in-memory pair in a test are all the same thing to it.
 */

export type RpcId = number | string;

export type RpcMessage = {
  jsonrpc?: string;
  id?: RpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

/** JSON-RPC 2.0's reserved codes. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/**
 * An error that knows its JSON-RPC code.
 *
 * A handler throws one of these when the code matters to the other side — an
 * unknown method, a malformed parameter. Anything else a handler throws is
 * answered with the peer's default code, because an exception is not a
 * protocol decision and should not be dressed up as one.
 */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type NotifyHandler = (method: string, params: unknown) => void;

export type RpcPeerOptions = {
  /** One complete JSON line, newline included. */
  write: (line: string) => void;
  onRequest?: RequestHandler;
  onNotify?: NotifyHandler;
  /**
   * What a line that is not JSON means.
   *
   * `"ignore"` suits a peer reading a child that also chats on stdout — Grok
   * prints update notices there on first run, and killing a session over a
   * banner helps nobody. `"reply"` answers with PARSE_ERROR as the spec asks,
   * which is right when molt is the server and the garbage came from a client.
   */
  onGarbage?: "ignore" | "reply";
  /** Code for a handler failure that is not an RpcError. INTERNAL_ERROR unless set. */
  defaultErrorCode?: number;
  /** How a handler failure is worded on the wire. The error's own message unless set. */
  describeError?: (e: unknown) => string;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

export class RpcPeer {
  private buf = "";
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private closedWith: unknown = undefined;
  private isClosed = false;

  constructor(private opts: RpcPeerOptions) {}

  get closed(): boolean {
    return this.isClosed;
  }

  /** Bytes arrived. Anything short of a newline waits for the rest. */
  feed(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i < 0) break;
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        if (this.opts.onGarbage === "reply") {
          this.send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
        }
        continue;
      }
      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
        // Batches are legal JSON-RPC and no ACP peer sends them. Refused
        // plainly rather than half-handled.
        if (this.opts.onGarbage === "reply") {
          this.send({
            jsonrpc: "2.0",
            id: null,
            error: { code: INVALID_REQUEST, message: "Invalid Request" },
          });
        }
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: RpcMessage): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === "string" && !hasId) {
      try {
        this.opts.onNotify?.(msg.method, msg.params);
      } catch {
        /* a notification has nobody to report a failure to */
      }
      return;
    }
    if (typeof msg.method === "string") {
      void this.answer(msg.id as RpcId, msg.method, msg.params);
      return;
    }
    if (!hasId) return;
    const p = this.pending.get(msg.id as RpcId);
    if (!p) return;
    this.pending.delete(msg.id as RpcId);
    if (msg.error) {
      p.reject(new RpcError(msg.error.code ?? INTERNAL_ERROR, msg.error.message ?? "peer error", msg.error.data));
    } else {
      p.resolve(msg.result);
    }
  }

  private async answer(id: RpcId, method: string, params: unknown): Promise<void> {
    try {
      if (!this.opts.onRequest) throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
      const result = await this.opts.onRequest(method, params);
      // `undefined` is not JSON; a method with nothing to say answers null.
      this.send({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : (this.opts.defaultErrorCode ?? INTERNAL_ERROR);
      const data = e instanceof RpcError ? e.data : undefined;
      this.send({
        jsonrpc: "2.0",
        id,
        error: {
          code,
          message: (this.opts.describeError ?? errorMessage)(e),
          ...(data === undefined ? {} : { data }),
        },
      });
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.isClosed) return;
    this.opts.write(`${JSON.stringify(msg)}\n`);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.isClosed) return Promise.reject(this.closedWith ?? new Error("connection closed"));
    const id = this.nextId++;
    const done = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return done;
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Every pending call fails together; a dead pipe answers nothing. */
  fail(e: unknown): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closedWith = e;
    for (const { reject } of this.pending.values()) reject(e);
    this.pending.clear();
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
