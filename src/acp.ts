/**
 * Agent Client Protocol as a backend, so a Grok subscription can drive
 * molt's loop.
 *
 * ## Why a plan is not a key
 *
 * `providers.ts` says of every metered API: hold a key, pay per token. A
 * SuperGrok plan is not that. It is an entitlement to run *their CLI*, and a
 * client that lifts the OAuth token out of `~/.grok/auth.json` and posts it
 * to `cli-chat-proxy.grok.com` is repackaging one as the other.
 *
 * So molt does not hold the token, see it, or send it. It spawns the CLI you
 * installed and logged in — `grok agent stdio` —
 * and that process authenticates itself. molt is the client on the other end
 * of a documented protocol the vendor shipped for exactly this.
 *
 * Grok Build and OpenCode are the CLIs driven this way. The Claude Code, Antigravity
 * and Gemini CLI backends were removed over those vendors' terms on running
 * a third-party harness on a plan; see `docs/provider-terms.md`.
 *
 * ## Why the agent is a table row
 *
 * ACP is JSON-RPC over stdio with a fixed method set — `initialize`,
 * `session/new`, `session/prompt`, and `session/update` notifications coming
 * back. What differs between agents that speak it is a binary name, an argv,
 * and a model list. That is `ACP_AGENTS`, and another agent whose terms allow
 * it is a row in it rather than another 900-line backend.
 *
 * ## Keeping the ledger complete, which is the whole problem
 *
 * `tree-accounted` refuses a claim when the working tree holds a change no
 * ledger entry explains. So the agent must not write anything molt did not
 * run. ACP has no switch that says "bring no tools", so this file stacks
 * three levers, in decreasing order of trust:
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
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { privSep } from "./privsep.js";
import { promisify } from "node:util";

import { errorText } from "./format.js";
import { env as readEnv } from "./env.js";
import { PROBE_TIMEOUT_MS } from "./watchdog.js";
import { RpcPeer, type RpcMessage } from "./jsonrpc.js";
import type { BackendEvent, MoltTool, SendLimits, ToolRunner } from "./backend.js";
import { GROK_BUILD_URL, OPENCODE_URL } from "./endpoint.js";
import { OPENCODE_CONFIG, OPENCODE_DEFAULT_MODEL, opencodeChildEnv, opencodeModel, opencodeModelProblem } from "./opencode.js";
import { estTokens } from "./types.js";
import { groupSpawn, killTree, trackGroup } from "./proctree.js";

const exec = promisify(execFile);

/**
 * One CLI molt can drive, and everything that differs between them.
 *
 * `url` is a scheme rather than an address for the reason `GROK_BUILD_URL`
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
  /** Extra environment for the child, on top of the process's own. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The child's environment built from the process's own, when the agent
   * must not inherit all of it (OpenCode: other providers' credentials are
   * scrubbed). `env` is still applied on top.
   */
  readonly childEnv?: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /**
   * Why a model id may not run on this agent, or null. Checked before the
   * CLI is spawned and again against the model the session reports, so a
   * refused model never runs, as worker or judge.
   */
  readonly modelProblem?: (model: string) => string | null;
  /** The model asked for when none is named, for an agent with `modelProblem`. */
  readonly defaultModel?: string;
  /** Aliases the CLI resolves itself against whatever the account can reach. */
  readonly models: readonly string[];
  readonly installHint: string;
  readonly loginHint: string;
  /** Where the CLI keeps the credential, so health can say "logged out". */
  readonly credentialPath: string;
  /**
   * Environment variables that carry this agent's own login. Under privilege
   * separation (src/privsep.ts) the worker's environment loses every
   * credential-looking name; these, and only for this agent's process when it
   * is the worker, pass through. Anything else (another provider's key, a
   * token the worker's shell commands would see) stays out. An agent without
   * one must find its login in the worker user's HOME.
   */
  readonly workerCredentialEnv?: readonly string[];
  /**
   * How this agent can be handed Maat's tool server.
   *
   * Grok says `mcpCapabilities: { http: true }` at `initialize` and takes a
   * URL. Only HTTP is supported.
   */
  readonly mcpTransport: "http";
  /**
   * Per-agent `session/new` `_meta`, which is where vendors put the things
   * ACP itself has no field for. Returns {} for an agent with no extensions
   * rather than being optional, so the call site has no branch.
   */
  readonly sessionMeta: (o: { systemPrompt: string }) => Record<string, unknown>;
  /**
   * The session meta for a pre-turn question (acpAsk), where no MCP server is
   * offered. Defaults to `sessionMeta`; Grok needs its own, because its
   * session meta tells it every tool lives on an MCP server `molt` that a
   * question never has, and the model went looking for it instead of answering.
   */
  readonly askMeta?: (o: { systemPrompt: string }) => Record<string, unknown>;
};

/**
 * Grok's `agentProfile` accepts a JSON object with a `tools` list, which is
 * the documented way to say "these builtins and no others". Empty means none:
 * everything the model can do arrives over molt's MCP server.
 */
/**
 * Grok 1.0.46 does not list MCP tools to the model at all. Every MCP tool is
 * reached through two of its own meta-tools: `search_tool` (discovery, never
 * asks permission) and `use_tool` with `{tool_name: "molt__grep", tool_input}`.
 * Measured against the real CLI over ACP: the `tool_call` announcement is
 * titled `use_tool`, and the permission request carries
 * `rawInput: {variant: "UseTool", tool_name: "molt__grep", ...}` with
 * `_meta["x.ai/tool"].name === "use_tool"` and no `toolName`. Judging by the
 * title therefore saw "use_tool" for every Maat call and refused all of them,
 * so the model never got a single tool and the turn ended with nothing done.
 *
 * The real identity of such a call is the tool it targets. A `use_tool` whose
 * target is not a fully-qualified Maat tool (another MCP server, a target
 * hidden in an arguments file, a bare name that could belong to anyone) keeps
 * the name `use_tool` and is refused like any other builtin.
 */
export function useToolTarget(raw: unknown, title?: string, metaName?: string): string | undefined {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const wrapped = title === "use_tool" || metaName === "use_tool" || o.variant === "UseTool";
  if (!wrapped) return undefined;
  const target = o.tool_name;
  return typeof target === "string" && target ? target : "use_tool";
}

/** Grok's discovery meta-tool: lists tool names and schemas, changes nothing. */
const GROK_DISCOVERY_TOOL = "search_tool";

/**
 * Said to Grok because it cannot be inferred from its tool list: that list has
 * no Maat tools in it (see `useToolTarget`), so a model told only "use your
 * tools" reaches for `run_terminal_command`, is refused, and stops.
 */
export const GROK_TOOL_ROUTE = [
  "TOOL ROUTING (mandatory). Every tool you may use is served by the MCP server `molt`.",
  "They are not in your direct tool list. Call `search_tool` with query `molt` to list them with their schemas,",
  "then call each one through `use_tool` with `tool_name` set to the fully-qualified name `molt__<tool>`",
  "(for example `molt__grep`) and `tool_input` set to its arguments.",
  "Never call run_terminal_command, read_file, search_replace, write, list_dir, grep or any other built-in tool directly: they are refused.",
].join(" ");

/**
 * A pre-turn question has no tools at all. Without this Grok, still believing
 * the routing text above, spent 65 s "looking through the project" and answered
 * in prose, so the drafted checks never arrived (bench grok1, 29 of 29 runs).
 */
export const GROK_ASK_NO_TOOLS =
  "You have NO tools in this conversation: do not search for tools, do not read files, do not run anything. " +
  "Everything you need is in the message. Answer immediately, in text, in exactly the format the message asks for.";

const GROK_MOLT_PROFILE = { name: "molt", description: "Maat drives every tool", tools: "" };

export const ACP_AGENTS: readonly AcpAgentSpec[] = [
  {
    name: "grok-build",
    label: "Grok Build",
    url: GROK_BUILD_URL,
    bin: "grok",
    // No `--always-approve`. See the header: the permission request is how
    // molt refuses a builtin, and approving everything throws that away.
    args: ["agent", "stdio"],
    // What the picker offers before a session exists. The live list comes
    // from `session/new` and is what a session is checked against; this one
    // was a model behind (no grok-4.7, Grok's own default) by 2026-09-23.
    models: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"],
    installHint: "curl -fsSL https://x.ai/cli/install.sh | bash",
    loginHint: "grok login",
    credentialPath: ".grok/auth.json",
    mcpTransport: "http",
    sessionMeta: ({ systemPrompt }) => ({
      systemPromptOverride: `${systemPrompt}\n\n${GROK_TOOL_ROUTE}`,
      agentProfile: GROK_MOLT_PROFILE,
    }),
    askMeta: ({ systemPrompt }) => ({
      systemPromptOverride: `${systemPrompt}\n\n${GROK_ASK_NO_TOOLS}`,
      agentProfile: GROK_MOLT_PROFILE,
    }),
  },
  {
    name: "opencode",
    label: "OpenCode",
    url: OPENCODE_URL,
    bin: "opencode",
    args: ["acp"],
    // Every permission is "ask": a deny breaks the free tier (see opencode.ts), and an ask
    // reaches `session/request_permission`, where Maat refuses all but its own tools.
    // Only the Zen provider is enabled (OPENCODE_CONFIG), only Zen model ids are accepted,
    // and other providers' credentials never reach the child: OpenCode can sign in to
    // other vendors' consumer plans, and Maat does not route through them.
    env: { OPENCODE_CONFIG_CONTENT: OPENCODE_CONFIG },
    childEnv: opencodeChildEnv,
    modelProblem: opencodeModelProblem,
    defaultModel: OPENCODE_DEFAULT_MODEL,
    models: [OPENCODE_DEFAULT_MODEL],
    installHint: "npm install -g opencode-ai",
    loginHint: "opencode auth login",
    credentialPath: ".local/share/opencode/auth.json",
    // The Zen account's key, when it arrives through the environment rather than auth.json.
    workerCredentialEnv: ["OPENCODE_API_KEY"],
    mcpTransport: "http",
    sessionMeta: () => ({}),
  },
];

/** Is this endpoint one of the ACP CLIs rather than an HTTP API? */
export function isAcp(baseUrl: string | undefined): boolean {
  return acpAgentFor(baseUrl) !== undefined;
}

export function acpAgentFor(baseUrl: string | undefined): AcpAgentSpec | undefined {
  const url = (baseUrl ?? "").trim().toLowerCase();
  // By scheme: `opencode://zen` and the deprecated `opencode://subscription` are one agent.
  return ACP_AGENTS.find((a) => url.startsWith(a.url.slice(0, a.url.indexOf("://") + 3)));
}

/**
 * The model to ask this agent for, or why it may not run. An agent with a
 * `modelProblem` gets its `defaultModel` when none is named, so the CLI's own
 * default (which the user's config may point at another provider) is never
 * what runs.
 */
export function acpModelFor(spec: AcpAgentSpec, model: string | undefined): { model?: string; problem?: string } {
  const m = (model ?? "").trim();
  if (!spec.modelProblem) return m ? { model: m } : {};
  const problem = spec.modelProblem(m);
  if (problem) return { problem };
  if (!m) return spec.defaultModel ? { model: spec.defaultModel } : {};
  return { model: spec.name === "opencode" ? opencodeModel(m) : m };
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
 * Both halves separately: "not installed" and "installed but logged out" have
 * different fixes, and folding them into one boolean sends people to the wrong
 * one.
 *
 * Authentication is probed by asking the agent to open a session and watching
 * it refuse. That is a real answer rather than a guess about a credential file
 * format that is not Maat's to parse — and unlike reading the file, it stays
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
     * `grok --version` prints "grok 1.0.13 (5e9a58…) [stable]" — taking field
     * zero reported the version as "grok", which reached the endpoint picker
     * as "grok grok · signed in". A digit-looking token is the real answer.
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
      (disarmed ? ` · ⚠ permission_mode = "${disarmed}" — Maat cannot gate its tools` : ""),
    ...(authenticated
      ? disarmed
        ? {
            fix: `remove permission_mode = "${disarmed}" from ~/.grok/config.toml (Maat needs to be asked)`,
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Bounded like every other probe: an agent that takes the handshake and
    // never answers must not hold `doctor` or the picker for ever.
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${spec.label} did not answer within ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS);
      timer.unref?.();
    });
    const handshake = (async () => {
      await conn.start();
      await conn.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      await conn.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    })();
    handshake.catch(() => {});
    await Promise.race([handshake, expired]);
    return { authenticated: true };
  } catch (e) {
    const text = errorText(e);
    return { authenticated: false, detail: /auth/iu.test(text) ? "not signed in" : text };
  } finally {
    if (timer) clearTimeout(timer);
    await conn.close();
  }
}

// ---------------------------------------------------------------------------
// The JSON-RPC connection
// ---------------------------------------------------------------------------

/** A method the agent calls on molt, and what molt answers. */
export type ClientHandler = (method: string, params: unknown) => Promise<unknown>;

/** How long an agent told `session/cancel` gets to end its turn before it is killed. */
export const CANCEL_GRACE_MS = 500;

/**
 * Silence from an ACP agent, in ms, after which its provider is taken to have
 * stalled: `MAAT_BACKEND_STALL_MS`, default five minutes, 0 for never. Maat's
 * own tool calls do not count as the agent's silence.
 */
export const BACKEND_STALL_MS = 5 * 60_000;

export function backendStallMs(raw: string | undefined = readEnv("BACKEND_STALL_MS")): number {
  if (raw === undefined || raw.trim() === "") return BACKEND_STALL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : BACKEND_STALL_MS;
}

/**
 * Newline-delimited JSON-RPC over a child process's stdio.
 *
 * Both directions: the agent answers molt's requests and makes its own, and a
 * client that only reads replies would hang the first time the agent asked
 * permission for a tool — which, on this backend, is every tool.
 */
export class AcpConnection {
  private child?: ChildProcess;
  /** Framing and correlation, shared with molt's own ACP server (src/jsonrpc.ts). */
  private peer: RpcPeer;
  /** Whatever the agent wrote to stderr, for an error that would else be bare. */
  private stderr = "";

  constructor(
    private spec: AcpAgentSpec,
    private opts: {
      cwd?: string;
      spawnFn?: typeof spawn;
      onNotify?: (method: string, params: unknown) => void;
      onRequest?: ClientHandler;
      /** Anything at all arrived from the agent: the stall watchdog's clock. */
      onActivity?: () => void;
      /** The agent is the worker: under privilege separation it runs as the worker user (src/privsep.ts). */
      asWorker?: boolean;
    } = {},
  ) {
    const onRequest = opts.onRequest;
    this.peer = new RpcPeer({
      write: (line) => this.child?.stdin?.write(line),
      onNotify: opts.onNotify,
      // An unhandled method is refused rather than left hanging: an agent
      // waiting forever on a reply molt will never send looks identical to a
      // model that has stopped thinking.
      onRequest: (method, params) =>
        onRequest ? onRequest(method, params) : Promise.reject(new Error(`molt does not implement ${method}`)),
      // A non-JSON line is the agent's own chatter (Grok prints update notices
      // to stdout on first run). Ignoring it beats killing a session over a
      // banner.
      onGarbage: "ignore",
      defaultErrorCode: -32000,
      describeError: errorText,
    });
  }

  async start(): Promise<void> {
    const spawnFn = this.opts.spawnFn ?? spawn;
    const cwd = this.opts.cwd ?? process.cwd();
    // The subprocess environment REPLACES rather than merges, so the spread
    // is load-bearing: without it a Finder-launched molt hands the CLI an
    // empty PATH and it cannot find its own helpers.
    // `electron/login-path.ts` has already repaired process.env.PATH by the
    // time anything gets here.
    const env = {
      ...(this.spec.childEnv ? this.spec.childEnv(process.env) : process.env),
      ...this.spec.env,
      ...(this.spec.env ? { PWD: cwd } : {}),
    };
    // The worker's agent, and every tool it runs itself, as the worker user:
    // its own reads (Grok auto-approves read_file, grep, list_dir) never
    // reach Maat, so only the uid can bound them.
    const ps = this.opts.asWorker ? privSep() : undefined;
    const spec = ps?.execSpec(this.spec.bin, this.spec.args, cwd, env, this.spec.workerCredentialEnv);
    const child = spawnFn(spec?.file ?? this.spec.bin, spec?.args ?? [...this.spec.args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: spec?.env ?? env,
      ...(spec?.uid !== undefined ? { uid: spec.uid, gid: spec.gid } : {}),
      // Its own process group, so ending it ends what it started (src/proctree.ts).
      ...groupSpawn(),
    });
    this.child = child;
    trackGroup(child);
    // A write to a child that has died raises EPIPE as an 'error' event on its
    // stdin, and an 'error' event nobody listens for is thrown — in the window,
    // from Electron's main process. It is the same fact as the exit below.
    child.stdin?.on("error", (e) => this.fail(e));
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
    this.peer.fail(e);
  }

  private feed(chunk: string): void {
    this.opts.onActivity?.();
    this.peer.feed(chunk);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.peer.closed) throw new Error(`${this.spec.bin} is not running`);
    return this.peer.request(method, params);
  }

  notify(method: string, params: unknown): void {
    this.peer.notify(method, params);
  }

  async close(): Promise<void> {
    this.fail(new Error("session closed"));
    this.child?.stdin?.end();
    // The agent and everything it started: a helper left running holds the
    // job's directory and the machine's cores after the job has ended.
    killTree(this.child);
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
    // Before listening, not after: see the comment below. A listen that never
    // completes must not be the thing holding Node open either.
    server.unref();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // A close while this is pending shut the server before its listen
      // callback could fire, so this promise never settled — and the session
      // start-up awaiting it, and the turn awaiting that, hung for ever.
      this.abortListen = () => reject(new Error("tool server closed while starting"));
      // Port 0 lets the OS pick, and 127.0.0.1 rather than 0.0.0.0 keeps it
      // off the network entirely — a tool server bound to every interface is
      // a remote write primitive on a shared LAN.
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.abortListen = undefined;
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

  private abortListen?: () => void;

  async close(): Promise<void> {
    this.abortListen?.();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // An agent killed mid-call leaves its connection open; waiting for it
      // to drain is waiting on a process that no longer exists.
      this.server.closeAllConnections?.();
    });
  }
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/**
 * A one-writer, one-reader queue.
 *
 * The backend has two event sources that must interleave in real time — the
 * agent's notification stream, and molt's own tool handlers, which run
 * *inside* it over HTTP — and
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
 * Hand Maat's tool server to an ACP agent.
 *
 * Grok Build takes HTTP MCP; that is the only transport Maat uses.
 */
export function mcpEntry(
  _spec: AcpAgentSpec,
  endpoint: { url: string; headers: { name: string; value: string }[] },
): Record<string, unknown> {
  return { type: "http", name: "molt", url: endpoint.url, headers: endpoint.headers };
}

/** The `models` block ACP agents return from `session/new` (unstable in the spec). */
type AcpModelState = {
  currentModelId?: string;
  availableModels?: { modelId: string; name?: string }[];
};

export type AcpOptions<H> = {
  spec: AcpAgentSpec;
  model: string;
  cwd: string;
  systemPrompt: string;
  tools: readonly MoltTool[];
  runTool: ToolRunner<H>;
  /**
   * Stop whatever Maat tool call is running for the agent. Called when a
   * deadline or a stall ends the agent's turn: the agent is gone, and a
   * `bash` it asked for must not go on changing the tree being judged.
   */
  abortTools?: () => void;
  /** Injected in tests, which drive a scripted agent rather than a real one. */
  spawnFn?: typeof spawn;
  /** This agent is the worker (not a judge): run it as the worker user when privilege separation is on. */
  asWorker?: boolean;
};

/** How long an interrupted turn waits for its aborted tool calls to end. */
export const TOOL_ABORT_WAIT_MS = 5_000;

/**
 * An ACP session, alive for as long as molt's is.
 *
 * One session, not one per turn: the
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
    const { spec, cwd, systemPrompt, tools } = this.opts;
    // A model this agent may not run is refused before anything is spawned.
    const pick = acpModelFor(spec, this.opts.model);
    if (pick.problem) throw new Error(pick.problem);
    this.want = pick.model;
    // A tool Maat is running is Maat's time, not the agent's silence: a test
    // suite that takes ten minutes is not a stalled provider.
    const runTool: ToolRunner<H> = async (...a) => {
      // The agent was interrupted; nothing it asks for now may run.
      if (this.interrupted) return "[molt: the turn was stopped. No more tools.]";
      this.busy += 1;
      const run = this.opts.runTool(...a);
      const settled = run.then(() => {}, () => {});
      this.running.add(settled);
      try {
        return await run;
      } finally {
        this.running.delete(settled);
        this.busy -= 1;
        this.touch();
      }
    };
    const mcp = new McpToolServer<H>(tools, runTool, (event) =>
      this.events.push({ kind: "host", event }),
    );
    this.mcp = mcp;
    const endpoint = await mcp.listen();
    // Closed while the tool server was starting: spawning now would start an
    // agent nothing will ever stop. See `close`.
    if (this.closing) throw new Error("session closed");

    const conn = new AcpConnection(spec, {
      cwd,
      ...(this.opts.spawnFn ? { spawnFn: this.opts.spawnFn } : {}),
      ...(this.opts.asWorker ? { asWorker: true } : {}),
      onNotify: (method, params) => this.onNotify(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onActivity: () => this.touch(),
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
    })) as { sessionId?: string; models?: AcpModelState };
    this.sessionId = res?.sessionId;
    if (!this.sessionId) throw new Error(`${spec.bin} opened no session`);
    await this.chooseModel(conn, res.models);

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

  /**
   * The model that actually runs, as the agent confirmed it.
   *
   * molt never sent the model it was asked for. The agent ran its own
   * default — Grok's is grok-4.7 — while every receipt recorded the one the
   * person picked, grok-4.6: a record of evidence naming the wrong author.
   * ACP carries the choice as `session/set_model`, checked against the
   * `models` the agent returns from `session/new` (measured against grok
   * 1.0.41: an unknown id is refused, a listed one confirmed).
   *
   * Three outcomes, none of them silent: the requested model is switched to
   * and confirmed; it is not on offer, which refuses the session with the
   * list that is; or the agent says nothing about models at all, in which
   * case what ran is recorded as unconfirmed rather than asserted.
   */
  private ran?: string;

  /** What molt can truthfully record as the model: confirmed, or marked unconfirmed. */
  ranModel(): string | undefined {
    return this.ran;
  }

  /** The model to ask for: `opts.model`, or the agent's default (see `acpModelFor`). */
  private want?: string;

  private async chooseModel(conn: AcpConnection, state: AcpModelState | undefined): Promise<void> {
    // For an agent with `modelProblem`, `want` is always set and already allowed, so the
    // agent's own default (which its config may point at another provider) never runs.
    const want = this.want ?? this.opts.model;
    const offered = (state?.availableModels ?? []).map((m) => m.modelId).filter(Boolean);
    if (state?.currentModelId && (!want || want === state.currentModelId)) {
      this.ran = state.currentModelId;
      return;
    }
    if (!want) {
      this.ran = undefined;
      return;
    }
    if (offered.length && !offered.includes(want)) {
      throw new Error(
        `${this.opts.spec.label} does not offer "${want}" on this account; it offers ` +
          `${offered.join(", ")}. Pick one of those — Maat will not run a different model ` +
          `under the name you chose.`,
      );
    }
    try {
      await conn.request("session/set_model", { sessionId: this.sessionId, modelId: want });
      this.ran = want;
    } catch (e) {
      if (offered.length) {
        throw new Error(`${this.opts.spec.label} refused to switch to "${want}": ${String(e)}`);
      }
      // The agent names no models and cannot be told one. Recorded as what it
      // is, so a receipt never states a model nobody confirmed.
      this.ran = `${want} (unconfirmed: ${this.opts.spec.label} runs its own choice)`;
    }
  }

  /**
   * OpenCode names an MCP tool `<server>_<tool>` (`molt_write_file`) where the others say
   * `molt__write_file`. Its own builtins have no `molt_` prefix, so the rewrite cannot
   * promote one of them into a Maat tool.
   */
  private canon(name: string): string {
    return this.opts.spec.name === "opencode" ? name.replace(/^molt_(?=[a-z])/u, "molt__") : name;
  }

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
      const called = this.canon(useToolTarget(raw, name) ?? String((u as { toolName?: string }).toolName ?? name));
      this.toolCallNames.set(id, called);
      if (McpToolServer.isMoltTool(called)) {
        // The transcript records the call Maat is about to run — the handler
        // itself reports from inside `runTool` a moment later, over the MCP
        // connection.
        this.events.push({
          kind: "assistant",
          text: "",
          toolCalls: [{ id, name: McpToolServer.bareName(called), args: raw }],
        });
      } else if (called === GROK_DISCOVERY_TOOL) {
        // Discovery of Maat's own catalogue: nothing to account for.
        return;
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
          text: `${this.opts.spec.label} ran its own '${called}' without asking — not in Maat's ledger`,
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
      throw new Error(`maat does not implement ${method}`);
    }
    const p = (params ?? {}) as {
      toolCall?: {
        toolCallId?: string;
        title?: string;
        toolName?: string;
        rawInput?: unknown;
        _meta?: Record<string, { name?: string } | undefined>;
      };
      options?: { optionId?: string; kind?: string }[];
    };
    const called = this.canon(
      String(
        useToolTarget(p.toolCall?.rawInput, p.toolCall?.title, p.toolCall?._meta?.["x.ai/tool"]?.name) ??
          p.toolCall?.toolName ??
          this.toolCallNames.get(String(p.toolCall?.toolCallId ?? "")) ??
          p.toolCall?.title ??
          "",
      ),
    );
    const options = p.options ?? [];
    if (McpToolServer.isMoltTool(called) || called === GROK_DISCOVERY_TOOL) {
      const allow =
        options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once");
      if (allow?.optionId) return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
    const reject =
      options.find((o) => o.kind === "reject_always") ?? options.find((o) => o.kind === "reject_once");
    if (!McpToolServer.isMoltTool(called) && called !== GROK_DISCOVERY_TOOL) {
      for (const [id, name] of this.inFlight) if (name === called) this.inFlight.delete(id);
      if (!this.refused.has(called)) {
        this.refused.add(called);
        this.events.push({
          kind: "info",
          text: `refused ${this.opts.spec.label}'s own '${called}' — Maat's tools are the only way to the disk`,
        });
      }
    }
    return reject?.optionId
      ? { outcome: { outcome: "selected", optionId: reject.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  /** When the agent last said anything, or Maat last finished a tool for it. */
  private lastActivity = Date.now();
  /** Maat tool calls running for the agent right now. */
  private busy = 0;
  /** Those calls, settled or not, so an interrupt can wait for them to end. */
  private running = new Set<Promise<void>>();
  /** Set by an interrupt: no tool call starts after it. */
  private interrupted = false;

  private touch(): void {
    this.lastActivity = Date.now();
  }

  /**
   * Wait for `p`, but never past the deadline, and never through a stall.
   *
   * An ACP prompt turn has no clock of its own: a bench run given 540 s sat in
   * one `session/prompt` for an hour, because nothing bounded the wait for
   * its reply. Whatever the agent does, Maat keeps its own deadline here.
   */
  private async bounded<T>(
    p: Promise<T>,
    limits: SendLimits,
  ): Promise<{ ok: true; value: T } | { ok: false; stop: "deadline" | "stall"; silentMs: number }> {
    const settled = p.then((value) => ({ ok: true as const, value }));
    // Abandoned on a stop; a late rejection is nobody's to handle.
    settled.catch(() => {});
    const stallMs = limits.stallMs && limits.stallMs > 0 ? limits.stallMs : 0;
    if (limits.deadlineAt === undefined && !stallMs) return settled;
    for (;;) {
      const now = Date.now();
      if (limits.deadlineAt !== undefined && now >= limits.deadlineAt) {
        return { ok: false, stop: "deadline", silentMs: now - this.lastActivity };
      }
      // Silence while a tool runs is not a stall: Maat's own tools (busy), or
      // the agent's own builtins it announced and has not finished (inFlight;
      // GROK_OWN_TOOLS runs a test suite that way with no ACP traffic). The
      // deadline still bounds both.
      const working = this.busy > 0 || this.inFlight.size > 0;
      const stallAt = stallMs ? (working ? now + stallMs : this.lastActivity + stallMs) : Infinity;
      if (now >= stallAt) return { ok: false, stop: "stall", silentMs: now - this.lastActivity };
      const wake = Math.min(limits.deadlineAt ?? Infinity, stallAt) - now;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const woke = await Promise.race([
        settled,
        new Promise<null>((r) => {
          timer = setTimeout(() => r(null), Math.max(1, wake));
        }),
      ]);
      clearTimeout(timer);
      if (woke) return woke;
    }
  }

  /**
   * Stop the agent: `session/cancel` (the protocol's own way to end a prompt
   * turn), a moment for it to answer, then the whole process tree.
   *
   * The kill is not optional. An agent that ignores the cancel — or is hung
   * past hearing it — is exactly the one that must not outlive the job.
   */
  private async interrupt(answered?: Promise<unknown>): Promise<void> {
    this.interrupted = true;
    if (this.conn && this.sessionId) {
      try {
        this.conn.notify("session/cancel", { sessionId: this.sessionId });
      } catch {
        // A dead pipe; the kill below is what counts.
      }
      if (answered) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          answered.catch(() => {}),
          new Promise<void>((r) => {
            timer = setTimeout(r, CANCEL_GRACE_MS);
          }),
        ]);
        clearTimeout(timer);
      }
    }
    await this.close();
    // The agent is gone, but a Maat tool call it started (a build, a script
    // that rewrites files) would go on changing the tree the judge is about
    // to read. Stop it, and wait for it to end, within reason.
    if (this.running.size) {
      this.opts.abortTools?.();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.running]),
        new Promise<void>((r) => {
          timer = setTimeout(r, TOOL_ABORT_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
  }

  /** The `done` for a wait Maat cut short. The session is closed by then. */
  private stoppedEvent(stop: "deadline" | "stall", silentMs: number): BackendEvent<H> {
    const label = this.opts.spec.label;
    const error =
      stop === "deadline"
        ? `the time budget ran out while ${label} was still working — its turn was cancelled`
        : `${label} sent nothing for ${Math.round(silentMs / 1000)}s — provider stall, its turn was cancelled`;
    return { ...this.finish(error), stopped: stop, ...(stop === "stall" ? { silentMs } : {}) };
  }

  /**
   * Send messages and read back everything until the model stops.
   *
   * Returns at `session/prompt`'s reply, which is the same boundary molt's own
   * loop uses: the model has stopped calling tools and produced an answer, so
   * the bar can run. With `limits`, it also returns — with a `done` that says
   * `stopped` — when the deadline passes or the agent stalls; by then the agent
   * has been cancelled and its process tree ended.
   */
  async *send(messages: readonly string[], limits: SendLimits = {}): AsyncGenerator<BackendEvent<H>> {
    this.touch();
    if (!this.started) {
      const starting = this.start();
      starting.catch(() => {});
      let got;
      try {
        got = await this.bounded(starting, limits);
      } catch (e) {
        yield doneEvent("", errorText(e));
        return;
      }
      if (!got.ok) {
        await this.interrupt();
        yield { ...doneEvent<H>("", `${this.opts.spec.label} did not start before the ${got.stop === "deadline" ? "time budget ran out" : "stall allowance ran out"}`), stopped: got.stop };
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
        // session on either. So is `max_turn_requests`: the agent hit its own
        // limit on calls part-way through the work, and what it said last was
        // read as the turn's finished claim and sent to the bar. `cancelled`
        // is molt's own abort and says nothing.
        const bad = /refusal|max_tokens|max_turn_requests/iu.test(stop) ? stop : undefined;
        this.events.push(this.finish(bad));
      } catch (e) {
        this.events.push(this.finish(errorText(e)));
      }
    })();

    this.reader ??= this.events.drain();
    for (;;) {
      const got = await this.bounded(this.reader.next(), limits);
      if (!got.ok) {
        const ev = this.stoppedEvent(got.stop, got.silentMs);
        await this.interrupt(answered);
        yield ev;
        return;
      }
      const next = got.value;
      if (next.done) break;
      yield next.value;
      if (next.value.kind === "done") break;
    }
    await answered;
  }

  /** The step's `done`, with molt's own count of what went over the wire. */
  private finish(error?: string): Extract<BackendEvent<H>, { kind: "done" }> {
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
  /**
   * Set by `close`, read by `start` after each await.
   *
   * A cancel during start-up reached `close` while `start` was still awaiting
   * the tool server: there was no child yet, so nothing was killed, and `start`
   * then carried on and spawned one that nothing would ever stop.
   */
  private closing = false;

  async close(): Promise<void> {
    this.closing = true;
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
function doneEvent<H>(text: string, error?: string): Extract<BackendEvent<H>, { kind: "done" }> {
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
  /**
   * How long the whole question may take. It had no limit: an agent that
   * accepted the session and never answered held criteria drafting — which
   * the window runs before a turn — open for ever. 0 means no limit.
   */
  timeoutMs?: number;
};

/**
 * The pre-turn calls — `interviewTurn` and `draftCriteria` — on this backend.
 *
 * Both were written against `/chat/completions` and both are dead ends here:
 * `grok-build://subscription` is a name for "the subscription is doing the
 * work" and not a URL. There is still no endpoint; there is a subprocess, and
 * that is enough to ask a question.
 *
 * Deliberately not `AcpSession`: no MCP server at all, so the model answering
 * cannot read a file, cannot write one, and cannot touch the ledger the bar
 * reads. It is a text completion wearing a subprocess.
 */
export async function acpAsk(
  opts: AcpAskOptions,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  // A model this agent may not run is refused before anything is spawned.
  const pick = acpModelFor(opts.spec, opts.model);
  if (pick.problem) return { ok: false, error: pick.problem };
  opts = { ...opts, ...(pick.model !== undefined ? { model: pick.model } : {}) };
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
  const askMeta = opts.spec.askMeta ?? opts.spec.sessionMeta;
  const limit = opts.timeoutMs ?? 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired =
    limit > 0
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const e = new Error(`${opts.spec.label} did not answer within ${Math.round(limit / 1000)}s`);
            e.name = "TimeoutError";
            reject(e);
          }, limit);
          timer.unref?.();
        })
      : undefined;
  const exchange = async (): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
    await conn.start();
    await conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const res = (await conn.request("session/new", {
      cwd: opts.cwd ?? process.cwd(),
      mcpServers: [],
      _meta: askMeta({ systemPrompt: opts.systemPrompt }),
    })) as { sessionId?: string; models?: AcpModelState };
    if (!res?.sessionId) return { ok: false, error: `${opts.spec.bin} opened no session` };
    // The same choice the session makes, for the same reason: a draft written
    // by a model nobody chose is recorded as written by the one they did.
    const offered = (res.models?.availableModels ?? []).map((m) => m.modelId);
    if (opts.model && res.models?.currentModelId !== opts.model) {
      if (offered.length && !offered.includes(opts.model)) {
        return {
          ok: false,
          error: `${opts.spec.label} does not offer "${opts.model}" on this account; it offers ${offered.join(", ")}`,
        };
      }
      await conn.request("session/set_model", { sessionId: res.sessionId, modelId: opts.model }).catch((e) => {
        if (offered.length) throw e;
      });
    }
    const prompt = ("systemPromptOverride" in askMeta({ systemPrompt: opts.systemPrompt })
      ? opts.prompt
      : `${opts.systemPrompt}\n\n${opts.prompt}`);
    await conn.request("session/prompt", {
      sessionId: res.sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    const text = answer.trim();
    return text ? { ok: true, text } : { ok: false, error: `${opts.spec.label} returned nothing` };
  };
  try {
    return await (expired ? Promise.race([exchange(), expired]) : exchange());
  } catch (e) {
    return { ok: false, error: errorText(e) };
  } finally {
    if (timer) clearTimeout(timer);
    // The question is answered, whichever way it went — including by the
    // clock — and the subprocess should not outlive it.
    await conn.close();
  }
}
