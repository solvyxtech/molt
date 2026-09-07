/**
 * Agent Client Protocol as a backend, so a Grok or Gemini subscription can
 * drive molt's loop the way a Claude one already does.
 *
 * ## Why this is the same argument claude-code.ts makes
 *
 * `providers.ts` says of every metered API: hold a key, pay per token. A
 * SuperGrok or Google AI Pro plan is not that. It is an entitlement to run
 * *their CLI*, and a client that lifts the OAuth token out of `~/.grok/auth.json`
 * and posts it to `cli-chat-proxy.grok.com` is repackaging one as the other.
 *
 * So molt does not hold the token, see it, or send it. It spawns the CLI you
 * installed and logged in — `grok agent stdio`, `gemini --experimental-acp` —
 * and that process authenticates itself. molt is the client on the other end
 * of a documented protocol. Same arrangement as claude-code.ts, one layer
 * lower: there the vendor shipped an SDK, here the vendor shipped a protocol.
 *
 * ## Why one file covers both
 *
 * ACP is JSON-RPC over stdio with a fixed method set — `initialize`,
 * `session/new`, `session/prompt`, and `session/update` notifications coming
 * back. Grok Build and Gemini CLI both speak it, so the difference between
 * them is a binary name, an argv, and a model list. That is `ACP_AGENTS`, and
 * adding a third agent is a row in it rather than another 900-line backend.
 *
 * ## Keeping the ledger complete, which is the whole problem
 *
 * `tree-accounted` refuses a claim when the working tree holds a change no
 * ledger entry explains. So the agent must not write anything molt did not
 * run. claude-code.ts gets this for free — the SDK takes `tools: []`. ACP has
 * no such switch, so this file stacks three, in decreasing order of trust:
 *
 *   1. **molt's tools arrive as an MCP server** it hosts in-process, on
 *      loopback, behind a per-session bearer token. That is the only tool
 *      surface the agent is *given*.
 *   2. **The agent's own builtins are stripped** through whatever lever it
 *      documents — Grok takes an `agentProfile` on `session/new`.
 *   3. **Every permission request that is not one of molt's tools is denied**,
 *      by molt, at `session/request_permission`. Deliberately no
 *      `--always-approve`: the prompt *is* the enforcement point, and molt is
 *      the one answering it.
 *
 * Layer 3 was meant to be the one that matters, because it is the only one
 * molt could verify rather than request. **It has never been observed to
 * fire.** Two real turns against a live Grok on 2026-09-07 used its own
 * `search_replace` to edit a file and molt was never asked — zero
 * `session/request_permission` requests arrived in either run, with
 * `permission_mode` left at its default. Layers 1 and 2 did not stop it
 * either: `agentProfile.tools: ""` is evidently not how that CLI is told to
 * bring no tools.
 *
 * So on this backend the ledger is **not** guaranteed complete, and the honest
 * backstop is the one molt already had: `tree-accounted` refuses a claim when
 * the tree holds a change no tool call explains, and it did — the turn was
 * refused rather than passed. Safe, but a bar that fails on a correct edit is
 * not a usable backend, and it should not be described as one.
 *
 * What is still unexplored: Grok's own docs say `deny` rules and hooks apply
 * even under always-approve, which is a lever this file does not pull yet.
 *
 * ### What this still does not catch, said out loud
 *
 * Grok auto-approves its read-only tools (`read_file`, `list_dir`, `grep`)
 * without ever raising a permission request, so those never reach layer 3.
 * Reads do not change the tree, so `tree-accounted` is unharmed and the bar
 * still means what it says — but molt's ledger is not a complete record of
 * what the model *looked at* on this backend, only of what it changed.
 * `unaccountedTools()` reports anything that got through, and the session
 * surfaces it as an `info` event rather than discovering it in a receipt.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { errorText } from "./format.js";
import type { BackendEvent, MoltTool, ToolRunner } from "./claude-code.js";
import { GEMINI_CLI_URL, GROK_BUILD_URL } from "./endpoint.js";
import { estTokens } from "./types.js";

const exec = promisify(execFile);

/**
 * One CLI molt can drive, and everything that differs between them.
 *
 * `url` is a scheme rather than an address for the reason `CLAUDE_CODE_URL`
 * is: every seam molt has — `config.json`, `/endpoint`, `keyForUrl`, the
 * receipt's `endpoint` field — is keyed by a URL, and a second way to say
 * "where does the model live" is a second thing to keep in step. Nothing
 * fetches it; `isAcp` guards every path that would.
 */
export type AcpAgentSpec = {
  readonly name: string;
  readonly label: string;
  readonly url: string;
  readonly bin: string;
  readonly args: readonly string[];
  /** Aliases the CLI resolves itself against whatever the account can reach. */
  readonly models: readonly string[];
  readonly installHint: string;
  readonly loginHint: string;
  /** Where the CLI keeps the credential, so health can say "logged out". */
  readonly credentialPath: string;
  /**
   * How this agent can be handed molt's tool server.
   *
   * Grok says `mcpCapabilities: { http: true }` at `initialize` and takes a
   * URL. Gemini advertises no MCP capabilities and has a standing bug against
   * servers passed to `session/new`, and an ignored entry does not fail — it
   * produces an agent with no tools at all. stdio is the transport every MCP
   * client supports, so that one gets a bridge; see mcp-bridge.ts.
   */
  readonly mcpTransport: "http" | "stdio";
  /**
   * Per-agent `session/new` `_meta`, which is where both of these vendors put
   * the things ACP itself has no field for. Returns {} for an agent with no
   * extensions rather than being optional, so the call site has no branch.
   */
  readonly sessionMeta: (o: { systemPrompt: string }) => Record<string, unknown>;
};

/**
 * Grok's `agentProfile` accepts a JSON object with a `tools` list, which is
 * the documented way to say "these builtins and no others". Empty means none:
 * everything the model can do arrives over molt's MCP server.
 */
const GROK_MOLT_PROFILE = { name: "molt", description: "molt drives every tool", tools: "" };

export const ACP_AGENTS: readonly AcpAgentSpec[] = [
  {
    name: "grok-build",
    label: "Grok Build",
    url: GROK_BUILD_URL,
    bin: "grok",
    // No `--always-approve`. See the header: the permission request is how
    // molt refuses a builtin, and approving everything throws that away.
    args: ["agent", "stdio"],
    models: ["grok-4.6", "grok-4.5"],
    installHint: "curl -fsSL https://x.ai/cli/install.sh | bash",
    loginHint: "grok login",
    credentialPath: ".grok/auth.json",
    mcpTransport: "http",
    sessionMeta: ({ systemPrompt }) => ({
      systemPromptOverride: systemPrompt,
      agentProfile: GROK_MOLT_PROFILE,
    }),
  },
  {
    name: "gemini-cli",
    label: "Gemini CLI",
    url: GEMINI_CLI_URL,
    bin: "gemini",
    // `--experimental-acp` was renamed to `--acp` during 2026. Both are
    // passed: the older builds ignore an unknown long flag rather than
    // refusing to start, and a molt that only knew one name would be broken
    // for whichever half of the world had the other.
    args: ["--acp"],
    models: ["gemini-3-pro", "gemini-3-flash"],
    installHint: "npm install -g @google/gemini-cli",
    loginHint: "gemini  (then choose 'Login with Google')",
    credentialPath: ".gemini/oauth_creds.json",
    mcpTransport: "stdio",
    // Gemini exposes no documented per-session system-prompt override, so
    // molt's prompt goes in as the first user message instead — see
    // `AcpSession.start`. Saying so here beats a silently dropped prompt.
    sessionMeta: () => ({}),
  },
];

/** Is this endpoint one of the ACP CLIs rather than an HTTP API? */
export function isAcp(baseUrl: string | undefined): boolean {
  return acpAgentFor(baseUrl) !== undefined;
}

export function acpAgentFor(baseUrl: string | undefined): AcpAgentSpec | undefined {
  const url = (baseUrl ?? "").trim().toLowerCase();
  return ACP_AGENTS.find((a) => url.startsWith(a.url.replace(/subscription$/u, "")));
}

/** Every model any ACP backend offers, for a picker that has not chosen yet. */
export function acpModels(baseUrl: string | undefined): string[] {
  return [...(acpAgentFor(baseUrl)?.models ?? [])];
}

/**
 * Does this agent's own config disarm the gate molt relies on?
 *
 * Layer 3 of the lockdown in this file's header — refuse every permission
 * request that is not one of molt's tools — is the only layer molt can verify.
 * It is also the only one that a line in *your* config can switch off:
 * `permission_mode = "always-approve"` in `~/.grok/config.toml` short-circuits
 * the permission pipeline, so `session/request_permission` is never sent and
 * molt never gets to say no.
 *
 * This is not hypothetical. The first real turn this backend ever ran did
 * exactly that: Grok used its own `search_replace` to edit a file, molt was
 * never asked, and the write landed with no ledger entry behind it. `tree-
 * accounted` would have refused the claim — the bar is the backstop and it
 * held — but a backend that fails every bar is not a working backend, and
 * discovering why in a receipt is far too late.
 *
 * Read, never written. What to change is yours to decide; molt's job is to say
 * so before the turn rather than after it.
 */
export function permissionsDisarmed(home = homedir()): string | null {
  let text: string;
  try {
    text = readFileSync(join(home, ".grok", "config.toml"), "utf8");
  } catch {
    // No config is the default, and the default asks.
    return null;
  }
  const mode = /^\s*permission_mode\s*=\s*"([^"]+)"/mu.exec(text)?.[1];
  if (!mode || mode === "default" || mode === "ask") return null;
  return mode;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type AcpHealth = {
  ok: boolean;
  installed: boolean;
  version?: string;
  authenticated: boolean;
  detail: string;
  fix?: string;
};

/**
 * Can this machine run the agent, and as whom.
 *
 * Both halves separately, for the reason `claudeCodeHealth` already learned:
 * "not installed" and "installed but logged out" have different fixes, and
 * folding them into one boolean sends people to the wrong one.
 *
 * Authentication is probed by asking the agent to open a session and watching
 * it refuse. That is a real answer rather than a guess about a credential file
 * format that is not molt's to parse — and unlike reading the file, it stays
 * true when the token is present but expired, which is exactly the state a
 * lapsed subscription leaves behind.
 */
export async function acpHealth(
  spec: AcpAgentSpec,
  deps: {
    run?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
    probe?: (spec: AcpAgentSpec) => Promise<{ authenticated: boolean; detail?: string }>;
    /** Injected in tests; real callers read the CLI's own config. */
    disarmed?: string | null;
  } = {},
): Promise<AcpHealth> {
  const run = deps.run ?? ((c: string, a: string[]) => exec(c, a));
  let version: string | undefined;
  try {
    const { stdout } = await run(spec.bin, ["--version"]);
    /**
     * The first thing that looks like a version, not the first word.
     *
     * `claude --version` prints "2.1.263 (Claude Code)" and taking field zero
     * works; `grok --version` prints "grok 1.0.13 (5e9a58…) [stable]" and the
     * same rule reported the version as "grok", which reached the endpoint
     * picker as "grok grok · signed in".
     */
    version =
      /\b(\d+\.\d+(?:\.\d+)?)\b/u.exec(stdout)?.[1] ?? stdout.trim().split(/\s+/u)[0];
  } catch {
    return {
      ok: false,
      installed: false,
      authenticated: false,
      detail: `${spec.label} is not on PATH`,
      fix: spec.installHint,
    };
  }
  const probe = deps.probe ?? probeAuth;
  const { authenticated, detail } = await probe(spec);
  /**
   * `??` is wrong here and was: `null` is the *answer* "the gate is armed",
   * not the absence of one, so `deps.disarmed ?? permissionsDisarmed()` fell
   * through to the real config every time a test pinned it to null — and the
   * test then failed or passed depending on whose `~/.grok/config.toml` it ran
   * on. Presence of the key is the question.
   */
  const disarmed =
    spec.name === "grok-build"
      ? "disarmed" in deps
        ? deps.disarmed
        : permissionsDisarmed()
      : null;
  return {
    // Signed in but ungated is not "ok": every write would land outside the
    // ledger and every bar would refuse the claim that followed.
    ok: authenticated && !disarmed,
    installed: true,
    version,
    authenticated,
    detail:
      `${spec.bin} ${version} · ` +
      (authenticated ? "signed in" : (detail ?? "not signed in")) +
      (disarmed ? ` · ⚠ permission_mode = "${disarmed}" — molt cannot gate its tools` : ""),
    ...(authenticated
      ? disarmed
        ? {
            fix: `remove permission_mode = "${disarmed}" from ~/.grok/config.toml (molt needs to be asked)`,
          }
        : {}
      : { fix: spec.loginHint }),
  };
}

/**
 * Open a session and see whether the agent refuses.
 *
 * Costs nothing — `session/new` sends no prompt, so no quota is spent and no
 * model runs. The handshake alone is not enough: Grok answers `initialize`
 * happily while signed out and only fails at `session/new`, which is precisely
 * the state that would otherwise be reported as healthy right up until the
 * first turn.
 */
async function probeAuth(spec: AcpAgentSpec): Promise<{ authenticated: boolean; detail?: string }> {
  const conn = new AcpConnection(spec);
  try {
    await conn.start();
    await conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    await conn.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    return { authenticated: true };
  } catch (e) {
    const text = errorText(e);
    return { authenticated: false, detail: /auth/iu.test(text) ? "not signed in" : text };
  } finally {
    await conn.close();
  }
}

// ---------------------------------------------------------------------------
// The JSON-RPC connection
// ---------------------------------------------------------------------------

type RpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

/** A method the agent calls on molt, and what molt answers. */
export type ClientHandler = (method: string, params: unknown) => Promise<unknown>;

/**
 * Newline-delimited JSON-RPC over a child process's stdio.
 *
 * Both directions: the agent answers molt's requests and makes its own, and a
 * client that only reads replies would hang the first time the agent asked
 * permission for a tool — which, on this backend, is every tool.
 */
export class AcpConnection {
  private child?: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private onNotify?: (method: string, params: unknown) => void;
  private onRequest?: ClientHandler;
  private closed = false;
  /** Whatever the agent wrote to stderr, for an error that would else be bare. */
  private stderr = "";

  constructor(
    private spec: AcpAgentSpec,
    private opts: {
      cwd?: string;
      spawnFn?: typeof spawn;
      onNotify?: (method: string, params: unknown) => void;
      onRequest?: ClientHandler;
    } = {},
  ) {
    this.onNotify = opts.onNotify;
    this.onRequest = opts.onRequest;
  }

  async start(): Promise<void> {
    const spawnFn = this.opts.spawnFn ?? spawn;
    const child = spawnFn(this.spec.bin, [...this.spec.args], {
      cwd: this.opts.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      // The subprocess environment REPLACES rather than merges, so the spread
      // is load-bearing: without it a Finder-launched molt hands the CLI an
      // empty PATH and it cannot find its own helpers. Same trap as
      // claude-code.ts; `electron/login-path.ts` has already repaired
      // process.env.PATH by the time anything gets here.
      env: { ...process.env },
    });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => this.feed(d));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      // Bounded: a chatty agent must not grow molt's heap for the whole
      // session, and only the tail is ever quoted in an error.
      this.stderr = (this.stderr + d).slice(-4000);
    });
    child.on("error", (e) => this.fail(e));
    child.on("exit", (code) =>
      this.fail(
        new Error(
          `${this.spec.bin} exited (${code ?? "signal"})` +
            (this.stderr.trim() ? `: ${this.stderr.trim().split("\n").slice(-3).join(" ")}` : ""),
        ),
      ),
    );
  }

  /** Every pending call fails together; a dead pipe answers nothing. */
  private fail(e: unknown): void {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(e);
    this.pending.clear();
  }

  private feed(chunk: string): void {
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
        // A non-JSON line is the agent's own chatter (Grok prints update
        // notices to stdout on first run). Ignoring it beats killing a
        // session over a banner.
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: RpcMessage): void {
    if (msg.method !== undefined && msg.id === undefined) {
      this.onNotify?.(msg.method, msg.params);
      return;
    }
    if (msg.method !== undefined) {
      void this.answer(msg);
      return;
    }
    if (msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? "agent error"));
    else p.resolve(msg.result);
  }

  /** Answer a request the agent made of molt. */
  private async answer(msg: RpcMessage): Promise<void> {
    const id = msg.id!;
    try {
      const result = this.onRequest
        ? await this.onRequest(msg.method!, msg.params)
        : // An unhandled method is refused rather than left hanging: an agent
          // waiting forever on a reply molt will never send looks identical to
          // a model that has stopped thinking.
          Promise.reject(new Error(`molt does not implement ${msg.method}`));
      this.write({ jsonrpc: "2.0", id, result });
    } catch (e) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: errorText(e) } });
    }
  }

  private write(msg: Record<string, unknown>): void {
    if (this.closed) return;
    this.child?.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error(`${this.spec.bin} is not running`);
    const id = this.nextId++;
    const done = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return done;
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    this.fail(new Error("session closed"));
    this.child?.stdin?.end();
    this.child?.kill();
  }
}

// ---------------------------------------------------------------------------
// molt's tools, served over MCP on loopback
// ---------------------------------------------------------------------------

/**
 * molt's six tools, offered to the agent as an MCP server it can reach.
 *
 * In-process and on loopback, with a per-session bearer token and a port the
 * OS picks. This is the direct analogue of the SDK's `createSdkMcpServer`: the
 * agent believes it is calling a tool server, and the handler it reaches is
 * `Session.runTool` inside molt, with the same autonomy gate, the same ledger
 * entry and the same events on screen.
 *
 * HTTP rather than a stdio subprocess because Grok advertises
 * `mcpCapabilities: { http: true }` in its `initialize` result and a
 * subprocess would need a second copy of molt's tool table to bridge to. One
 * server, one table, no bridge to keep in step.
 *
 * The token is not decoration. Loopback is reachable by every process on the
 * machine, and molt's tools write files — an unauthenticated port here would
 * be a local write primitive for anything that guessed it.
 */
export class McpToolServer<H> {
  private server?: Server;
  private token = randomBytes(24).toString("hex");
  private port = 0;
  /** Tool names the agent asked for that molt does not serve. */
  readonly refused: string[] = [];

  constructor(
    private tools: readonly MoltTool[],
    private runTool: ToolRunner<H>,
    private emit: (event: H) => void,
  ) {}

  /** `mcp__molt__grep` on the wire; molt only ever knows `grep`. */
  static readonly PREFIX = "mcp__molt__";

  /** Does this tool name belong to molt, however the agent spelled it? */
  static isMoltTool(name: string): boolean {
    return name.startsWith(McpToolServer.PREFIX) || name.startsWith("molt__");
  }

  static bareName(name: string): string {
    return name.replace(/^mcp__molt__/u, "").replace(/^molt__/u, "");
  }

  async listen(): Promise<{ url: string; headers: { name: string; value: string }[] }> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Port 0 lets the OS pick, and 127.0.0.1 rather than 0.0.0.0 keeps it
      // off the network entirely — a tool server bound to every interface is
      // a remote write primitive on a shared LAN.
      server.listen(0, "127.0.0.1", () => resolve());
    });
    /**
     * An open listener is a reason for Node not to exit.
     *
     * molt's own process has a window holding it open, so this never mattered
     * there — but the test runner has nothing else pending once a suite ends,
     * and a tool server still bound kept it alive until the harness timed the
     * whole run out. Unref'd, the socket serves every request it is given and
     * stops being a vote for staying alive.
     */
    server.unref();
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    return {
      url: `http://127.0.0.1:${this.port}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${this.token}` }],
    };
  }

  private async handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${this.token}`) {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let msg: RpcMessage;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RpcMessage;
    } catch {
      res.writeHead(400).end();
      return;
    }
    const reply = await this.respond(msg);
    if (!reply) {
      // A notification (`notifications/initialized`) has no reply, and MCP
      // wants 202 for it rather than an empty 200 body the client would try
      // to parse.
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  }

  private async respond(msg: RpcMessage): Promise<Record<string, unknown> | null> {
    const id = msg.id;
    if (id === undefined) return null;
    const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id, result });
    if (msg.method === "initialize") {
      return ok({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "molt", version: "1.0.0" },
      });
    }
    if (msg.method === "tools/list") {
      return ok({
        tools: this.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description ?? "",
          inputSchema: t.function.parameters ?? { type: "object", properties: {} },
        })),
      });
    }
    if (msg.method === "tools/call") {
      const p = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = McpToolServer.bareName(p.name ?? "");
      if (!this.tools.some((t) => t.function.name === name)) {
        this.refused.push(name);
        return ok({ content: [{ type: "text", text: `[molt: no such tool ${name}]` }], isError: true });
      }
      let text: string;
      try {
        text = await this.runTool(name, p.arguments ?? {}, `acp_${name}_${Date.now().toString(36)}`, this.emit);
      } catch (e) {
        // A handler that throws would otherwise fail the call and take the
        // session with it. molt's own tools report their errors as results,
        // and this keeps a bug in one from ending the turn.
        text = `tool error: ${errorText(e)}`;
      }
      return ok({ content: [{ type: "text", text }] });
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${msg.method}` } };
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/**
 * A one-writer, one-reader queue.
 *
 * Same shape and same reason as the one in claude-code.ts: the backend has two
 * event sources that must interleave in real time — the agent's notification
 * stream, and molt's own tool handlers, which run *inside* it over HTTP — and
 * a generator that only pulled between notifications would hold a `tool_start`
 * until after the tool it announces had finished.
 */
export class Channel<T> {
  private queue: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(value: T): void {
    if (this.done) return;
    const w = this.waiting.shift();
    if (w) w({ value, done: false });
    else this.queue.push(value);
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    for (const w of this.waiting.splice(0)) w({ value: undefined as never, done: true });
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.done) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

/**
 * How this agent is told where molt's tools are.
 *
 * The stdio form spawns `mcp-bridge.ts` under the same runtime molt is already
 * running — `ELECTRON_RUN_AS_NODE` because in the packaged app `execPath` is
 * Electron, and without it the bridge would start a second window instead of a
 * script.
 */
/**
 * Where `mcp-bridge.js` actually is, on each of the three layouts molt ships.
 *
 * `import.meta.url` looks like the obvious answer and is a trap: esbuild
 * replaces `import.meta` with an empty object when it bundles for CommonJS, so
 * in the packaged app the expression evaluates to `new URL("./mcp-bridge.js",
 * undefined)` and throws — after the tool server is already listening, on the
 * one backend that has no other way to be given tools. The bundle sets
 * `MOLT_MCP_BRIDGE` from its own `__dirname` instead, which is the only thing
 * in scope there that knows.
 *
 * Verified rather than assumed. A path handed to an agent that does not
 * resolve produces a spawn failure the agent reports as "no tools" and molt
 * never sees — the exact silence this file exists to avoid, so it is caught
 * here where it can still name itself.
 */
export function shippedScript(name: string): string {
  /**
   * `MOLT_MCP_BRIDGE` names the *directory* the scripts sit in when it points
   * at one; it was a file path first, and both are honoured so the packaged
   * app's existing setting keeps working.
   */
  const override = process.env.MOLT_MCP_BRIDGE?.trim();
  const candidates: string[] = [];
  if (override) {
    candidates.push(override.endsWith(".js") ? join(dirname(override), name) : join(override, name));
  }
  const here = (import.meta as { url?: string }).url;
  if (typeof here === "string") candidates.push(fileURLToPath(new URL(`./${name}`, here)));
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      `molt cannot find ${name}` +
        (candidates.length ? ` (looked in ${candidates.join(", ")})` : "") +
        " — set MOLT_MCP_BRIDGE to the directory holding it",
    );
  }
  return found;
}

export function bridgePath(): string {
  return shippedScript("mcp-bridge.js");
}

export function mcpEntry(
  spec: AcpAgentSpec,
  endpoint: { url: string; headers: { name: string; value: string }[] },
): Record<string, unknown> {
  if (spec.mcpTransport === "http") {
    return { type: "http", name: "molt", url: endpoint.url, headers: endpoint.headers };
  }
  const token = (endpoint.headers.find((h) => /^authorization$/iu.test(h.name))?.value ?? "").replace(
    /^Bearer /u,
    "",
  );
  return {
    type: "stdio",
    name: "molt",
    command: process.execPath,
    args: [bridgePath()],
    env: [
      { name: "MOLT_MCP_URL", value: endpoint.url },
      { name: "MOLT_MCP_TOKEN", value: token },
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
    ],
  };
}

export type AcpOptions<H> = {
  spec: AcpAgentSpec;
  model: string;
  cwd: string;
  systemPrompt: string;
  tools: readonly MoltTool[];
  runTool: ToolRunner<H>;
  /** Injected in tests, which drive a scripted agent rather than a real one. */
  spawnFn?: typeof spawn;
};

/**
 * An ACP session, alive for as long as molt's is.
 *
 * One session, not one per turn, for the reason claude-code.ts gives: the
 * alternative pays to re-establish the same context every turn. Every user
 * message molt records is forwarded through `send`, so the model sees exactly
 * what molt's transcript says it was told, in the order it was told.
 */
export class AcpSession<H> {
  private conn?: AcpConnection;
  private mcp?: McpToolServer<H>;
  private sessionId?: string;
  private events = new Channel<BackendEvent<H>>();
  /**
   * One reader for the life of the session, not one per `send`.
   *
   * `Channel.push` hands a value to the first registered waiter, and a waiter
   * is registered by whichever `drain()` generator is currently suspended
   * awaiting one. A second `drain()` over the same channel is therefore a
   * second claimant on every event, and which of them gets a given `done` is
   * a matter of ordering rather than intent. Stepping one stored iterator
   * with `next()` means there is never a second reader to lose an event to.
   *
   * Written defensively rather than after a diagnosis: the hang this backend
   * did have was the un-`unref`'d tool server (see `McpToolServer.listen`),
   * which is a different fault with the same symptom. This one has not been
   * observed — it is closed because a lost `done` would present as a session
   * that stops answering, which is the hardest thing here to tell from a model
   * that has stopped thinking.
   */
  private reader?: AsyncGenerator<BackendEvent<H>>;
  private started = false;
  /** Text of the reply being streamed, so `done` can carry the whole claim. */
  private reply = "";
  /**
   * Everything said in this session so far, for a token count nobody reports.
   *
   * ACP carries no usage, and zero is not "unknown" — it is a measurement, and
   * a false one. It also disables the only ceiling that still means anything
   * here: a subscription has no dollars for `/budget` to bound, so the token
   * ceiling is the whole safety rail, and a backend reporting zero tokens runs
   * forever by construction. That was not a theory — the salvage test found
   * it, because a budget the backend can never trip never salvages.
   *
   * So molt counts what it can see. `estTokens` is the same four-chars-a-token
   * approximation molt already uses for endpoints that report none, and it
   * grows with the conversation the way a resent context does, so a ceiling
   * set for an HTTP backend means roughly the same thing here.
   */
  private conversation = "";
  /**
   * Builtins that ran to completion without ever asking molt. Reported, not
   * hidden — these are the ones that are genuinely missing from the ledger.
   */
  private unaccounted = new Set<string>();
  /** Builtins molt was asked about and refused. These did not run. */
  private refused = new Set<string>();
  /** Builtins announced but not yet resolved, by the id the agent gave them. */
  private inFlight = new Map<string, string>();
  private toolCallNames = new Map<string, string>();

  constructor(private opts: AcpOptions<H>) {}

  /**
   * A subscription turn is not metered, so there is no bill to report.
   *
   * Zero rather than an estimate, deliberately: the receipt's `billed` flag is
   * what says the plan paid for this, and a confident dollar figure beside it
   * would be a number nobody can reconcile against a statement.
   */
  costSoFarUsd(): number {
    return 0;
  }

  /** Builtins that ran without reaching molt's ledger. Empty is the good case. */
  unaccountedTools(): string[] {
    return [...this.unaccounted];
  }

  private async start(): Promise<void> {
    const { spec, cwd, systemPrompt, tools, runTool } = this.opts;
    const mcp = new McpToolServer<H>(tools, runTool, (event) =>
      this.events.push({ kind: "host", event }),
    );
    this.mcp = mcp;
    const endpoint = await mcp.listen();

    const conn = new AcpConnection(spec, {
      cwd,
      ...(this.opts.spawnFn ? { spawnFn: this.opts.spawnFn } : {}),
      onNotify: (method, params) => this.onNotify(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
    });
    this.conn = conn;
    await conn.start();

    /**
     * molt hosts no filesystem and no terminal for this agent.
     *
     * ACP lets a client offer `fs/read_text_file` and friends, and an editor
     * says yes because it holds unsaved buffers. molt would be saying "route
     * your writes through me" for the writes it already refuses — every
     * mutation is supposed to arrive as an MCP tool call that lands a ledger
     * entry, and a second, quieter path to the same disk is exactly the hole
     * `tree-accounted` exists to catch.
     */
    await conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });

    const res = (await conn.request("session/new", {
      cwd,
      mcpServers: [mcpEntry(spec, endpoint)],
      _meta: spec.sessionMeta({ systemPrompt }),
    })) as { sessionId?: string };
    this.sessionId = res?.sessionId;
    if (!this.sessionId) throw new Error(`${spec.bin} opened no session`);

    /**
     * An agent with no system-prompt override is told the same thing as a
     * first message instead.
     *
     * Not equivalent and not pretended to be — a user message can be compacted
     * away where a system prompt cannot — but the alternative is running
     * molt's loop against a model that was never told the rules, which fails
     * in a way that reads as the model being bad at the job.
     */
    if (!("systemPromptOverride" in spec.sessionMeta({ systemPrompt }))) {
      this.preface = systemPrompt;
    }
    this.started = true;
  }

  private preface?: string;

  /** Notifications: the streamed reply, thoughts, tool calls, plans. */
  private onNotify(method: string, params: unknown): void {
    if (method !== "session/update" && method !== "x.ai/session/update") return;
    const p = (params ?? {}) as { update?: Record<string, unknown> };
    const u = p.update ?? {};
    const kind = u.sessionUpdate as string | undefined;
    if (kind === "agent_message_chunk") {
      const text = ((u.content ?? {}) as { text?: string }).text ?? "";
      if (text) {
        this.reply += text;
        this.events.push({ kind: "delta", text });
      }
      return;
    }
    if (kind === "tool_call") {
      const name = String(u.title ?? (u as { toolCallId?: string }).toolCallId ?? "");
      const raw = (u.rawInput ?? {}) as Record<string, unknown>;
      const id = String((u as { toolCallId?: string }).toolCallId ?? `acp_${Date.now().toString(36)}`);
      const called = String((u as { toolName?: string }).toolName ?? name);
      this.toolCallNames.set(id, called);
      if (McpToolServer.isMoltTool(called)) {
        // The transcript records the call molt is about to run, exactly as the
        // Claude Code path does — the handler itself reports from inside
        // `runTool` a moment later, over the MCP connection.
        this.events.push({
          kind: "assistant",
          text: "",
          toolCalls: [{ id, name: McpToolServer.bareName(called), args: raw }],
        });
      } else {
        /**
         * A builtin, announced. Nothing is concluded yet.
         *
         * The announcement arrives *before* the permission request, so a
         * verdict written here would report a tool as having run at the very
         * moment molt is about to refuse it — which is how the first draft of
         * this said "Grok ran its own bash" about a bash that never ran.
         * Whether it ran is decided by what arrives next.
         */
        this.inFlight.set(id, called);
      }
      return;
    }
    if (kind === "tool_call_update") {
      const id = String((u as { toolCallId?: string }).toolCallId ?? "");
      const called = this.inFlight.get(id);
      const status = String((u as { status?: string }).status ?? "");
      if (!called || !/completed|failed/u.test(status)) return;
      this.inFlight.delete(id);
      /**
       * A builtin that finished without ever asking. That is the gap named in
       * this file's header: Grok auto-approves its read-only tools, so those
       * never reach molt's refusal. Said once per tool, on screen, rather than
       * discovered later in a ledger that is quietly short.
       */
      if (!this.refused.has(called) && !this.unaccounted.has(called)) {
        this.unaccounted.add(called);
        this.events.push({
          kind: "info",
          text: `${this.opts.spec.label} ran its own '${called}' without asking — not in molt's ledger`,
        });
      }
    }
  }

  /**
   * Requests the agent makes of molt. The only one that matters is permission.
   *
   * molt allows its own tools and refuses everything else. This is the layer
   * that does not depend on the CLI honouring a profile: whatever the agent
   * believes it is allowed to do, a tool it cannot get approved is a tool it
   * cannot run.
   */
  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") {
      throw new Error(`molt does not implement ${method}`);
    }
    const p = (params ?? {}) as {
      toolCall?: { toolCallId?: string; title?: string; toolName?: string };
      options?: { optionId?: string; kind?: string }[];
    };
    const called = String(
      p.toolCall?.toolName ??
        this.toolCallNames.get(String(p.toolCall?.toolCallId ?? "")) ??
        p.toolCall?.title ??
        "",
    );
    const options = p.options ?? [];
    if (McpToolServer.isMoltTool(called)) {
      const allow =
        options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once");
      if (allow?.optionId) return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
    const reject =
      options.find((o) => o.kind === "reject_always") ?? options.find((o) => o.kind === "reject_once");
    if (!McpToolServer.isMoltTool(called)) {
      for (const [id, name] of this.inFlight) if (name === called) this.inFlight.delete(id);
      if (!this.refused.has(called)) {
        this.refused.add(called);
        this.events.push({
          kind: "info",
          text: `refused ${this.opts.spec.label}'s own '${called}' — molt's tools are the only way to the disk`,
        });
      }
    }
    return reject?.optionId
      ? { outcome: { outcome: "selected", optionId: reject.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  /**
   * Send messages and read back everything until the model stops.
   *
   * Returns at `session/prompt`'s reply, which is the same boundary molt's own
   * loop uses: the model has stopped calling tools and produced an answer, so
   * the bar can run.
   */
  async *send(messages: readonly string[]): AsyncGenerator<BackendEvent<H>> {
    if (!this.started) {
      try {
        await this.start();
      } catch (e) {
        yield doneEvent("", errorText(e));
        return;
      }
    }
    const text = [this.preface, ...messages].filter(Boolean).join("\n\n");
    this.preface = undefined;
    this.reply = "";
    this.conversation += text;

    const answered = (async () => {
      try {
        const res = (await this.conn!.request("session/prompt", {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text }],
        })) as { stopReason?: string };
        const stop = res?.stopReason ?? "completed";
        // `refusal` and `max_tokens` are the model declining or running out —
        // both are failures of the step, not of molt, and the engine drops the
        // session on either. `cancelled` is molt's own abort and says nothing.
        const bad = /refusal|max_tokens/iu.test(stop) ? stop : undefined;
        this.events.push(this.finish(bad));
      } catch (e) {
        this.events.push(this.finish(errorText(e)));
      }
    })();

    this.reader ??= this.events.drain();
    for (;;) {
      const next = await this.reader.next();
      if (next.done) break;
      yield next.value;
      if (next.value.kind === "done") break;
    }
    await answered;
  }

  /** The step's `done`, with molt's own count of what went over the wire. */
  private finish(error?: string): BackendEvent<H> {
    const prompt = estTokens(this.conversation);
    this.conversation += this.reply;
    return {
      kind: "done",
      text: this.reply,
      promptTokens: prompt,
      completionTokens: estTokens(this.reply),
      // Nothing here reports a cache read. Claiming one would make the meter
      // say the context was cheap on the one backend that cannot know.
      cachedTokens: 0,
      cumulativeCostUsd: 0,
      ...(error ? { error } : {}),
    };
  }

  /** End the session. The CLI subprocess and the tool server go with it. */
  async close(): Promise<void> {
    this.events.close();
    await this.conn?.close();
    await this.mcp?.close();
  }
}

/**
 * A step that failed before the agent was ever started.
 *
 * Zero tokens is the truth here and only here: nothing was sent, so there is
 * nothing to have counted. Once a session exists, `finish` estimates instead.
 */
function doneEvent<H>(text: string, error?: string): BackendEvent<H> {
  return {
    kind: "done",
    text,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cumulativeCostUsd: 0,
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// One question, one answer
// ---------------------------------------------------------------------------

export type AcpAskOptions = {
  spec: AcpAgentSpec;
  model: string;
  systemPrompt: string;
  prompt: string;
  cwd?: string;
  spawnFn?: typeof spawn;
};

/**
 * The pre-turn calls — `interviewTurn` and `draftCriteria` — on this backend.
 *
 * Both were written against `/chat/completions` and both are dead ends here,
 * for the same reason they were on Claude Code: `grok-build://subscription` is
 * a name for "the subscription is doing the work" and not a URL. There is
 * still no endpoint; there is a subprocess, and that is enough to ask a
 * question.
 *
 * Deliberately not `AcpSession`: no MCP server at all, so the model answering
 * cannot read a file, cannot write one, and cannot touch the ledger the bar
 * reads. It is a text completion wearing a subprocess.
 */
export async function acpAsk(
  opts: AcpAskOptions,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const conn = new AcpConnection(opts.spec, {
    cwd: opts.cwd ?? process.cwd(),
    ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    onNotify: (method, params) => {
      if (method !== "session/update" && method !== "x.ai/session/update") return;
      const u = ((params ?? {}) as { update?: Record<string, unknown> }).update ?? {};
      if (u.sessionUpdate === "agent_message_chunk") {
        answer += ((u.content ?? {}) as { text?: string }).text ?? "";
      }
    },
    // Nothing to approve: with no tools offered, a permission request can only
    // be for a builtin, and this path grants none.
    onRequest: async () => ({ outcome: { outcome: "cancelled" } }),
  });
  let answer = "";
  try {
    await conn.start();
    await conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const res = (await conn.request("session/new", {
      cwd: opts.cwd ?? process.cwd(),
      mcpServers: [],
      _meta: opts.spec.sessionMeta({ systemPrompt: opts.systemPrompt }),
    })) as { sessionId?: string };
    if (!res?.sessionId) return { ok: false, error: `${opts.spec.bin} opened no session` };
    const prompt = ("systemPromptOverride" in opts.spec.sessionMeta({ systemPrompt: opts.systemPrompt })
      ? opts.prompt
      : `${opts.systemPrompt}\n\n${opts.prompt}`);
    await conn.request("session/prompt", {
      sessionId: res.sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    const text = answer.trim();
    return text ? { ok: true, text } : { ok: false, error: `${opts.spec.label} returned nothing` };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  } finally {
    // The question is answered, whichever way it went; the subprocess should
    // not outlive it.
    await conn.close();
  }
}
