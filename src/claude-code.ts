/**
 * Claude Code as a backend, so a Claude subscription can drive molt's loop.
 *
 * ## Why this is not the thing molt refuses to do
 *
 * `providers.ts` says, of Anthropic's API: "Console API key (metered) —
 * subscription logins are not permitted in third-party tools". That is still
 * true, and this file does not weaken it. A Pro/Max login is an entitlement to
 * run *Claude Code*, not a credential for `api.anthropic.com`; a client that
 * lifts the OAuth token out of the keychain and posts it to `/v1/messages` is
 * repackaging one as the other.
 *
 * So molt does not hold the token, see it, or send it. It runs the copy of
 * Claude Code you already installed and logged in — through Anthropic's own
 * Agent SDK, which spawns that binary — and the binary authenticates itself.
 * molt is the harness around it. The same arrangement any editor integration
 * makes, and the one bb makes for every provider CLI it drives.
 *
 * ## What molt keeps
 *
 * Everything that makes a molt receipt worth reading, because Claude Code is
 * given **no tools of its own**:
 *
 *     tools: []            every built-in — Read, Write, Edit, Bash — turned off
 *     mcpServers: { molt } molt's six tools, in-process, handled by molt
 *     strictMcpConfig      your own MCP servers stay out of the work
 *     settingSources: []   your CLAUDE.md and settings do not steer this run
 *
 * That is not tidiness. `tree-accounted` refuses a claim when the working tree
 * holds a change no ledger entry explains, so a turn where Claude Code used
 * its own `Write` could never pass the bar — it would look exactly like the
 * `sed` bypass the builtin was written to catch. Routing every write back
 * through `Session.runTool` is what keeps the ledger complete, and the ledger
 * is what the bar, the receipt and the integrity chain all read.
 *
 * ## What molt gives up, and says so
 *
 * Claude Code holds its own conversation and compacts it its own way, so
 * molt's shedding does not apply to this backend and the exuviae a shed would
 * have written do not exist. molt's transcript is still authoritative for what
 * was *said* — every user message molt records is forwarded verbatim, which is
 * how a bar failure gets back to the model — but the context actually in
 * flight is Claude Code's.
 *
 * Cost is an estimate the SDK reports, not a bill: a subscription run is not
 * metered, so `billed` is false and the receipt says the plan paid for it.
 *
 * ## The dependency is optional on purpose
 *
 * molt has three dependencies and this would be a fourth weighing more than
 * the other three together (the SDK ships a platform build of the CLI). It is
 * an `optionalDependency`, imported at runtime, and everything here degrades
 * to an error message that names the install command. `loadSdk` defeats the
 * bundler's static analysis deliberately — see the comment there.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * The endpoint molt stores for this backend.
 *
 * A URL rather than a flag because every seam molt already has — `config.json`,
 * `/endpoint`, `keyForUrl`, the receipt's `endpoint` field — is keyed by one,
 * and a second way to say "where does the model live" is a second thing to
 * keep in step. It is not fetchable, and nothing tries: `isClaudeCode` guards
 * every path that would.
 */
export const CLAUDE_CODE_URL = "claude-code://subscription";

/** Is this endpoint the Claude Code backend rather than an HTTP API? */
export function isClaudeCode(baseUrl: string | undefined): boolean {
  return (baseUrl ?? "").trim().toLowerCase().startsWith("claude-code://");
}

/**
 * Models this backend offers.
 *
 * Hard-coded, because there is nothing to ask: the CLI resolves aliases like
 * `sonnet` itself against whatever the account can reach, and a model list
 * fetched from an endpoint molt never contacts would be an invention. The
 * alias is what is stored, so an account that gains a newer model gets it
 * without molt shipping a release.
 */
export const CLAUDE_CODE_MODELS = ["opus", "sonnet", "haiku"] as const;

/** What `claude` reports about itself, and whether it can run at all. */
export type ClaudeCodeHealth = {
  ok: boolean;
  /** `claude` found on PATH, and its version. */
  installed: boolean;
  version?: string;
  /** A subscription or key the CLI can use. */
  authenticated: boolean;
  /** "Max 20x", "Pro", … — read from the credential, never sent anywhere. */
  plan?: string;
  account?: string;
  /** One line, suitable for `molt doctor` and the endpoint picker. */
  detail: string;
  /** What the user should run, when there is something to run. */
  fix?: string;
};

type StoredCredential = {
  subscriptionType?: string;
  rateLimitTier?: string;
  expiresAt?: number;
};

/**
 * The plan name, from the credential the CLI already stores.
 *
 * Read-only, and only ever rendered — molt shows "Max 20x" beside the endpoint
 * so you can see which account is about to do the work. The token sitting
 * beside it in the same JSON is never read into a variable, let alone sent.
 */
function planLabel(cred: StoredCredential): string | undefined {
  const max = /max_(\d+)x/u.exec(cred.rateLimitTier ?? "");
  if (max) return `Max ${max[1]}x`;
  const sub = cred.subscriptionType;
  if (!sub) return undefined;
  return sub.charAt(0).toUpperCase() + sub.slice(1);
}

/** macOS keeps it in the keychain; Linux in a file. Try both, quietly. */
async function readCredential(): Promise<StoredCredential | null> {
  const parse = (raw: string): StoredCredential | null => {
    try {
      const json = JSON.parse(raw) as { claudeAiOauth?: StoredCredential };
      return json.claudeAiOauth ?? null;
    } catch {
      return null;
    }
  };
  if (process.platform === "darwin") {
    try {
      const { stdout } = await exec("security", [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-w",
      ]);
      const cred = parse(stdout);
      if (cred) return cred;
    } catch {
      // No keychain entry is not an error here — fall through to the file.
    }
  }
  try {
    return parse(await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Can this machine run the backend, and as whom.
 *
 * Both halves are reported separately for the reason `doctor` already learned
 * once: "not installed" and "installed but logged out" have different fixes,
 * and folding them into one boolean sends people to the wrong one.
 */
export async function claudeCodeHealth(
  run: (cmd: string, args: string[]) => Promise<{ stdout: string }> = (c, a) => exec(c, a),
): Promise<ClaudeCodeHealth> {
  let version: string | undefined;
  try {
    const { stdout } = await run("claude", ["--version"]);
    version = stdout.trim().split(/\s+/u)[0];
  } catch {
    return {
      ok: false,
      installed: false,
      authenticated: false,
      detail: "Claude Code is not on PATH",
      fix: "npm install -g @anthropic-ai/claude-code",
    };
  }
  const cred = await readCredential();
  if (!cred) {
    // An API key in the environment is a perfectly good way to run the CLI,
    // and saying "not authenticated" at someone who has one would be wrong.
    if (process.env.ANTHROPIC_API_KEY) {
      return {
        ok: true,
        installed: true,
        version,
        authenticated: true,
        plan: "API key",
        detail: `claude ${version} · ANTHROPIC_API_KEY (metered)`,
      };
    }
    return {
      ok: false,
      installed: true,
      version,
      authenticated: false,
      detail: `claude ${version} · not logged in`,
      fix: "claude /login",
    };
  }
  const expired = cred.expiresAt !== undefined && Date.now() >= cred.expiresAt;
  const plan = planLabel(cred);
  return {
    ok: !expired,
    installed: true,
    version,
    authenticated: !expired,
    ...(plan ? { plan } : {}),
    detail:
      `claude ${version} · ${plan ?? "logged in"}` + (expired ? " · session expired" : ""),
    ...(expired ? { fix: "claude /login" } : {}),
  };
}

/**
 * A JSON Schema property, in the subset molt's tool definitions use.
 *
 * Deliberately narrow. The SDK wants zod, molt holds JSON Schema, and the one
 * thing worse than a converter is two tool definitions kept in step by hand —
 * this repo has shipped that bug on both surfaces six times. `TOOLS` in
 * engine.ts stays the single source and this translates it.
 */
type JsonProp = { type?: string; description?: string; enum?: readonly string[] };
type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonProp>;
  required?: readonly string[];
};

/** The zod surface this file uses. Structural, so molt never imports zod. */
type ZodLike = {
  string: () => ZodType;
  number: () => ZodType;
  boolean: () => ZodType;
  enum: (values: string[]) => ZodType;
  unknown: () => ZodType;
};
type ZodType = {
  optional: () => ZodType;
  describe: (text: string) => ZodType;
};

/**
 * A zod raw shape for one tool's parameters.
 *
 * Anything molt's schemas do not use maps to `unknown` rather than throwing:
 * a tool that arrives with a type this does not know should reach the model
 * slightly under-described, not take the backend down.
 */
export function zodShape(schema: JsonSchema, z: ZodLike): Record<string, ZodType> {
  const shape: Record<string, ZodType> = {};
  const required = new Set(schema.required ?? []);
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    let t: ZodType;
    if (prop.enum?.length) t = z.enum([...prop.enum]);
    else if (prop.type === "string") t = z.string();
    else if (prop.type === "number" || prop.type === "integer") t = z.number();
    else if (prop.type === "boolean") t = z.boolean();
    else t = z.unknown();
    if (prop.description) t = t.describe(prop.description);
    if (!required.has(name)) t = t.optional();
    shape[name] = t;
  }
  return shape;
}

/** An OpenAI-shaped tool definition, which is what molt holds internally. */
export type MoltTool = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
  };
};

/** What molt does when the model calls one of its tools. */
export type ToolRunner<H> = (
  name: string,
  args: Record<string, unknown>,
  callId: string,
  /** Report progress while the call runs; ordered with everything else. */
  emit: (event: H) => void,
) => Promise<string>;

/**
 * What the backend tells the engine.
 *
 * Deliberately not `EngineEvent`: this module knows nothing about journals,
 * receipts or the bar. It carries the engine's own events through as `host`
 * instead — a tool call reports from inside molt's handler, and routing it
 * through the same queue is what keeps "molt is running grep" on screen
 * before the grep rather than after it.
 */
export type ClaudeCodeEvent<H> =
  | { kind: "delta"; text: string }
  | {
      kind: "assistant";
      text: string;
      /** The calls this message made, with the ids the CLI gave them. */
      toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
    }
  | { kind: "host"; event: H }
  | { kind: "info"; text: string }
  | {
      kind: "done";
      text: string;
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      /** Cumulative for the session, per the SDK. The engine takes the delta. */
      cumulativeCostUsd: number;
      error?: string;
    };

export type ClaudeCodeOptions<H> = {
  model: string;
  cwd: string;
  systemPrompt: string;
  tools: readonly MoltTool[];
  runTool: ToolRunner<H>;
  /** Injected in tests. Real callers leave it out and get the SDK. */
  sdk?: Sdk;
};

/** The slice of the Agent SDK this file uses, typed structurally. */
export type Sdk = {
  query: (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>;
  tool: (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>,
  ) => unknown;
  createSdkMcpServer: (opts: { name: string; version?: string; tools: unknown[] }) => unknown;
  z: ZodLike;
};

type SdkMessage =
  | { type: "system"; subtype: string; [k: string]: unknown }
  | { type: "assistant"; message: { content: { type: string; text?: string; name?: string; input?: unknown; id?: string }[] } }
  | { type: "stream_event"; event?: { type?: string; delta?: { type?: string; text?: string } } }
  | {
      type: "result";
      subtype: string;
      result?: string;
      is_error?: boolean;
      total_cost_usd?: number;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    }
  | { type: string; [k: string]: unknown };

/**
 * A one-writer, one-reader queue.
 *
 * The backend has two event sources that must interleave in real time — the
 * SDK's message stream, and molt's own tool handlers, which run *inside* it —
 * and a generator that only pulls between SDK messages would hold a
 * `tool_start` until after the tool it announces had finished. Both push here
 * instead, and the engine drains one ordered stream.
 */
class Channel<T> {
  private queue: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;
  private failure: unknown;

  push(value: T): void {
    if (this.done) return;
    const w = this.waiting.shift();
    if (w) w({ value, done: false });
    else this.queue.push(value);
  }

  close(err?: unknown): void {
    if (this.done) return;
    this.done = true;
    this.failure = err;
    for (const w of this.waiting.splice(0)) w({ value: undefined as never, done: true });
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.done) break;
      /**
       * The resolver is withdrawn if this generator is abandoned mid-wait —
       * a cancelled turn does exactly that. A waiter left behind would be
       * handed the next push, and the event would vanish into a generator
       * nobody is reading any more.
       */
      let mine: ((r: IteratorResult<T>) => void) | undefined;
      try {
        const next = await new Promise<IteratorResult<T>>((r) => {
          mine = r;
          this.waiting.push(r);
        });
        if (next.done) break;
        yield next.value;
      } finally {
        const at = mine ? this.waiting.indexOf(mine) : -1;
        if (at >= 0) this.waiting.splice(at, 1);
      }
    }
    if (this.failure !== undefined) throw this.failure;
  }
}

/**
 * Load the SDK without letting a bundler try to resolve it.
 *
 * `esbuild` inlines every `import()` whose specifier it can read, and molt's
 * main bundle is built with the SDK absent — it is optional, and most installs
 * will never have it. A specifier assembled at runtime is one esbuild leaves
 * as a real dynamic import, which is exactly what an optional dependency
 * needs. The peers are resolved the same way and for the same reason.
 */
async function loadSdk(): Promise<Sdk> {
  const sdkName = ["@anthropic-ai", "claude-agent-sdk"].join("/");
  const zodName = "z" + "od";
  let mod: Record<string, unknown>;
  let zod: Record<string, unknown>;
  try {
    mod = (await import(sdkName)) as Record<string, unknown>;
    zod = (await import(zodName)) as Record<string, unknown>;
  } catch (first) {
    /**
     * The packaged app has no `node_modules` to resolve from.
     *
     * Everything molt ships is bundled by esbuild, which is why the specifier
     * above is assembled rather than written — but that also means a packaged
     * molt cannot find a package it did not bundle, and bundling this one
     * would be pointless: the SDK exists to spawn a binary that has to be on
     * disk anyway. So a global install counts, which is how anyone who
     * already runs Claude Code will have installed things.
     */
    try {
      const { stdout } = await exec("npm", ["root", "-g"]);
      const root = stdout.trim();
      const url = (name: string) => pathToFileURL(join(root, name, "")).href;
      mod = (await import(url(sdkName))) as Record<string, unknown>;
      zod = (await import(url(zodName))) as Record<string, unknown>;
    } catch {
      throw new Error(
        `the Claude Code backend needs Anthropic's Agent SDK, which molt does not bundle: ` +
          `npm install -g @anthropic-ai/claude-agent-sdk zod (${String(first)})`,
      );
    }
  }
  const sdk = {
    query: mod.query,
    tool: mod.tool,
    createSdkMcpServer: mod.createSdkMcpServer,
    z: (zod.z ?? zod) as ZodLike,
  };
  for (const name of ["query", "tool", "createSdkMcpServer"] as const) {
    if (typeof sdk[name] !== "function") {
      throw new Error(
        `@anthropic-ai/claude-agent-sdk does not export ${name}() — molt needs a version ` +
          `that does (0.3 or later)`,
      );
    }
  }
  return sdk as Sdk;
}

/**
 * A Claude Code session, alive for as long as molt's is.
 *
 * One session, not one per turn, because the alternative pays to re-establish
 * the same context every turn: the second message in a streaming session read
 * 2,200 cached tokens where the first wrote 958 fresh ones. Every user message
 * molt records — the ask, sealed criteria, a nudge, a bar failure — is
 * forwarded through `send`, so the model sees exactly what molt's transcript
 * says it was told, in the order it was told.
 */
export class ClaudeCodeSession<H> {
  private input = new Channel<unknown>();
  private events = new Channel<ClaudeCodeEvent<H>>();
  private started = false;
  private pump?: Promise<void>;
  private opts: ClaudeCodeOptions<H>;
  /** The SDK reports cost for the whole session; a step wants its own share. */
  private lastCumulativeCost = 0;
  /**
   * Cancellation reaches the CLI subprocess, not just molt's reader.
   *
   * Without it ctrl+C would stop molt printing and leave a `claude` process
   * spending the plan's quota on a turn nobody is waiting for. Aborting ends
   * the whole session — there is no way to unask the question — so the engine
   * drops this object afterwards and the next turn starts a new one.
   */
  private controller = new AbortController();
  /** Tool-use ids seen in an assistant message, waiting for their handler. */
  private pendingIds = new Map<string, string[]>();

  constructor(opts: ClaudeCodeOptions<H>) {
    this.opts = opts;
  }

  /** The id the CLI gave this call, or a stand-in if the two ever diverge. */
  private claimId(name: string): string {
    const id = this.pendingIds.get(name)?.shift();
    return id || `cc_${name}_${Date.now().toString(36)}`;
  }

  /** Tokens and dollars this backend has seen, for the engine's meters. */
  costSoFarUsd(): number {
    return this.lastCumulativeCost;
  }

  private async start(): Promise<void> {
    const sdk = this.opts.sdk ?? (await loadSdk());
    const names: string[] = [];
    const tools = this.opts.tools.map((t) => {
      const name = t.function.name;
      names.push(`mcp__molt__${name}`);
      return sdk.tool(
        name,
        t.function.description ?? "",
        zodShape((t.function.parameters ?? {}) as JsonSchema, sdk.z) as Record<string, unknown>,
        async (args: Record<string, unknown>) => {
          let text: string;
          try {
            text = await this.opts.runTool(name, args, this.claimId(name), (event) =>
              this.events.push({ kind: "host", event }),
            );
          } catch (e) {
            // A handler that throws would otherwise fail the MCP call and take
            // the session with it. molt's own tools report their errors as
            // results, and this keeps a bug in one from ending the turn.
            text = `tool error: ${String(e)}`;
          }
          return { content: [{ type: "text" as const, text }] };
        },
      );
    });

    const server = sdk.createSdkMcpServer({ name: "molt", version: "1.0.0", tools });
    const stream = sdk.query({
      prompt: this.input.drain(),
      options: {
        model: this.opts.model,
        cwd: this.opts.cwd,
        systemPrompt: this.opts.systemPrompt,
        // Claude Code brings no tools of its own. Anything it wrote with one
        // would land on disk with no ledger entry behind it, which is the
        // shape `tree-accounted` exists to refuse.
        tools: [],
        mcpServers: { molt: server },
        allowedTools: names,
        // Your MCP servers and your CLAUDE.md are not part of this run. The
        // work is judged against `.molt/done.yml`, and a second set of
        // instructions molt cannot see is a second definition of done.
        strictMcpConfig: true,
        settingSources: [],
        includePartialMessages: true,
        abortController: this.controller,
        // The subprocess environment REPLACES rather than merges, so the
        // spread is load-bearing: without it a Finder-launched molt hands
        // `claude` an empty PATH. `electron/login-path.ts` has already
        // repaired process.env.PATH by the time anything gets here.
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "molt/0.1.0" },
      },
    });

    this.pump = (async () => {
      try {
        for await (const m of stream) this.translate(m);
      } catch (e) {
        this.events.push({
          kind: "done",
          text: "",
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          cumulativeCostUsd: this.lastCumulativeCost,
          error: String(e),
        });
      }
    })();
    this.started = true;
  }

  private translate(m: SdkMessage): void {
    if (m.type === "stream_event") {
      const ev = (m as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        this.events.push({ kind: "delta", text: ev.delta.text });
      }
      return;
    }
    if (m.type === "system") {
      const sub = (m as { subtype?: string }).subtype;
      // Compaction is the one system event worth surfacing: it is the moment
      // molt's transcript and Claude Code's context stop being the same
      // conversation, and a receipt that did not say so would be misleading.
      if (sub === "compact_boundary") {
        this.events.push({
          kind: "info",
          text: "Claude Code compacted its own context — molt's transcript is unchanged",
        });
      }
      return;
    }
    if (m.type === "assistant") {
      const content = (m as {
        message: { content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[] };
      }).message.content;
      const text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      const toolCalls = content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id ?? "",
          // The model calls it `mcp__molt__grep`; molt only knows `grep`.
          name: (b.name ?? "").replace(/^mcp__molt__/u, ""),
          args: (b.input ?? {}) as Record<string, unknown>,
        }));
      /**
       * The ids arrive here and are needed in the handler, which the MCP
       * transport calls without them. Queued per tool name and claimed in
       * order — the only way two could be confused is the same tool called
       * twice in one message, where either id names a call that did happen.
       */
      for (const c of toolCalls) {
        const q = this.pendingIds.get(c.name) ?? [];
        q.push(c.id);
        this.pendingIds.set(c.name, q);
      }
      if (text.trim() || toolCalls.length) {
        this.events.push({ kind: "assistant", text, toolCalls });
      }
      return;
    }
    if (m.type === "result") {
      const r = m as {
        result?: string;
        is_error?: boolean;
        subtype?: string;
        total_cost_usd?: number;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
      const u = r.usage ?? {};
      const cached = u.cache_read_input_tokens ?? 0;
      this.lastCumulativeCost = r.total_cost_usd ?? this.lastCumulativeCost;
      this.events.push({
        kind: "done",
        text: r.result ?? "",
        // The SDK reports fresh input separately from what it read out of the
        // cache. molt's meters want the whole prompt, so they are added back
        // together here and `cachedTokens` says how much of it was cheap.
        promptTokens: (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0),
        completionTokens: u.output_tokens ?? 0,
        cachedTokens: cached,
        cumulativeCostUsd: this.lastCumulativeCost,
        ...(r.is_error || (r.subtype && r.subtype !== "success")
          ? { error: r.result || r.subtype || "the Claude Code session failed" }
          : {}),
      });
    }
  }

  /**
   * Send messages and read back everything until the model stops.
   *
   * Returns at the SDK's `result`, which is the same boundary molt's own loop
   * uses: the model has stopped calling tools and produced an answer, so the
   * bar can run. Its `done` event is yielded last and carries the step's cost.
   */
  async *send(messages: readonly string[]): AsyncGenerator<ClaudeCodeEvent<H>> {
    if (!this.started) await this.start();
    for (const text of messages) {
      this.input.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: "",
      });
    }
    for await (const ev of this.events.drain()) {
      yield ev;
      if (ev.kind === "done") return;
    }
  }

  /** End the session. The SDK's subprocess goes with it. */
  async close(): Promise<void> {
    this.controller.abort();
    this.input.close();
    this.events.close();
    try {
      await this.pump;
    } catch {
      // A session being torn down has nothing left to report.
    }
  }
}
