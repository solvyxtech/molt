/**
 * Antigravity CLI as a backend, so a Google AI Pro plan can drive molt's loop.
 *
 * ## Why this is not the ACP backend
 *
 * `acp.ts` speaks a protocol two vendors agreed on. Antigravity does not speak
 * it — there is an open request for `--acp` and nothing shipped — so this file
 * speaks `agy`'s own newline-delimited stream instead. The shape is close
 * enough to Claude Code's that the engine cannot tell any of the three apart:
 * a message goes in, deltas and tool calls come out, a result closes the step.
 *
 * Every fact below was read off the binary on a live account, not off a doc
 * page, because the docs are thin here and one guess already cost an
 * afternoon. See `docs/agy-protocol.md`.
 *
 *     stdin   {"event":"user","message":{"role":"user","content":"…"}}
 *     stdout  {"event":"init","init":{tools,permission_mode,cwd}}
 *             {"event":"step_update","step_update":{step_type,state,…}}
 *             {"event":"result","result":{status,response,usage}}
 *
 * One process holds the whole conversation: the second turn read 28,419 tokens
 * out of cache where the first read 8,122, so a process per turn would pay for
 * the context again every step.
 *
 * ## Why the ledger is safe here
 *
 * Antigravity's headless mode **denies by default**. A tool that needs
 * permission and has no matching rule cannot prompt anybody, so it is refused
 * — verified on a live account: `write_to_file` refused, `run_command touch …`
 * refused with the file never created, `call_mcp_tool` refused until a rule
 * allowed it, and `read_file` refused too.
 *
 * So molt does not have to take anything away. It adds an allow-rule per molt
 * tool, `mcp(molt/<name>)`, which is the rule string the CLI itself prints
 * when it refuses one. Everything molt has not named stays refused.
 *
 * That alone is safe but not usable: **a denied tool ends the turn**, so the
 * first step went to Antigravity trying its own `read_file`, being refused,
 * and stopping with nothing said. `agy-hook.ts` is what fixes it — a
 * `PreToolUse` gate whose `reason` reaches the model, so it is told mid-turn
 * to use molt's tools instead. Two steps became one, and a bar of
 * `files-changed` + `tree-accounted` now passes on the first attempt.
 *
 * ## Why it edits the config you already have
 *
 * The rules live in `~/.gemini/antigravity-cli/settings.json`, which is global.
 * There is no project scope and no per-run flag — a `.gemini/settings.json` in
 * the workspace is not read, and neither is the outer `~/.gemini/settings.json`;
 * both were tested. Claude Code and Grok both avoid this problem by taking
 * their per-run configuration as arguments. `agy` offers no such surface.
 *
 * The first version answered that with a private `HOME` and paid for it with a
 * second sign-in, which is a strange thing to ask of someone already signed in.
 * This one adds to the file you have, strictly: every key it did not write is
 * read back and written out untouched, rules are appended, a rule already there
 * is not written twice, and it never writes a `deny` or touches
 * `trustedWorkspaces`.
 *
 * The part that changes every session — the port and token of molt's tool
 * server — travels in the **environment** instead, because an MCP child that
 * `agy` spawns inherits the environment `agy` was started with. That was
 * measured, not assumed, and it is the fact the whole arrangement rests on: the
 * registered command line never changes, so nothing has to be rewritten per
 * session and two molt sessions cannot race over one file.
 *
 * What it adds is inert without molt. `mcp(molt/read_file)` permits a call to a
 * server that only answers while a session is holding its port and token, and
 * when you run `agy` yourself the bridge finds no session and serves an empty
 * tool list rather than failing.
 *
 * The one thing given up against a private home is `strictMcpConfig`: the MCP
 * servers your Antigravity IDE registers are in scope for a molt run.
 * Deny-by-default covers it — they are unusable without allow-rules of their
 * own, which molt does not write.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir, tmpdir as _tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { promisify } from "node:util";

import { bridgePath, Channel, McpToolServer, shippedScript } from "./acp.js";
import type { BackendEvent, MoltTool, ToolRunner } from "./claude-code.js";
import { errorText } from "./format.js";

const exec = promisify(execFile);

/**
 * The endpoint molt stores. A name for "the plan is doing the work".
 *
 * Defined in `endpoint.ts` and re-exported here, exactly as `claude-code.ts`
 * does: `endpointProblem` has to know the scheme, the window cannot import a
 * module full of `node:` imports, and a second copy of the literal is how
 * `--url antigravity` ends up refused by the one function that never heard of
 * it.
 */
export { AGY_URL } from "./endpoint.js";

export function isAgy(baseUrl: string | undefined): boolean {
  return (baseUrl ?? "").trim().toLowerCase().startsWith("antigravity://");
}

/**
 * The models the picker offers without asking anybody.
 *
 * `agy models` returns the live list for the signed-in account, which is
 * better — and calling it from `listModels` was a mistake with teeth: the
 * picker asks every provider it knows for its models, so merely *having*
 * Antigravity as a preset made molt spawn `agy` and hit the network whenever
 * anyone opened `/model`, including from the test suite, which then talked to
 * the developer's own Google account and went slow enough to fail three
 * unrelated timing tests.
 *
 * So the cheap constant is what a picker gets, exactly as `CLAUDE_CODE_MODELS`
 * is. The live list is still used where it is worth a subprocess and where the
 * endpoint is the one actually selected: `preflight` and `agyHealth`.
 */
export const AGY_MODELS = [
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
] as const;

/**
 * Ask the account what it can actually reach.
 *
 * Costs a subprocess and a round trip, so it is called where that is worth it
 * rather than from anything a keystroke can reach.
 */
export async function agyModels(
  run: (cmd: string, args: string[], opts: object) => Promise<{ stdout: string }> = (c, a, o) =>
    exec(c, a, o),
): Promise<string[]> {
  try {
    const { stdout } = await run("agy", ["models"], {});
    /**
     * A model row is `id<TAB>Label`. The tab is the whole test.
     *
     * Splitting on it and keeping the first field looks equivalent and is not:
     * a signed-out account answers "Error: Please sign in to view available
     * models.", which has no tab, and taking its first field yielded a
     * one-item list — so `agyHealth` reported an account that cannot run
     * anything as signed in, with the sign-in sentence as its only model.
     */
    return stdout
      .split("\n")
      .filter((l) => l.includes("\t"))
      .map((l) => l.split("\t")[0]?.trim() ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The name molt's tool server is registered under, and the rules that allow it. */
export const AGY_SERVER = "molt";

/** `~/.gemini/antigravity-cli/settings.json` — the only file agy reads rules from. */
export function agySettingsPath(home = homedir()): string {
  return join(home, ".gemini", "antigravity-cli", "settings.json");
}

/**
 * The environment an `agy` session runs in.
 *
 * The whole trick of this backend is in these two variables. Molt's tool
 * server is registered once as a stdio MCP command with no arguments that
 * change; the port and token that *do* change every session travel in the
 * environment instead — and an MCP child spawned by `agy` inherits the
 * environment `agy` was started with, which was measured rather than assumed.
 *
 * That is what makes a per-session config rewrite unnecessary, and with it the
 * whole reason this backend once needed its own HOME and its own login.
 */
export function agyEnv(endpoint?: {
  url: string;
  headers: { name: string; value: string }[];
}): NodeJS.ProcessEnv {
  if (!endpoint) return { ...process.env };
  const token = (
    endpoint.headers.find((h) => /^authorization$/iu.test(h.name))?.value ?? ""
  ).replace(/^Bearer /u, "");
  return { ...process.env, MOLT_MCP_URL: endpoint.url, MOLT_MCP_TOKEN: token };
}

/** One allow-rule per molt tool, in the form the CLI prints when it refuses one. */
export function agyAllowRules(tools: readonly MoltTool[]): string[] {
  // Named individually rather than with a wildcard: `mcp(molt/*)` would widen
  // the moment molt gained a tool, and this list is meant to be the complete
  // set of things the agent may do.
  return tools.map((t) => `mcp(${AGY_SERVER}/${t.function.name})`);
}

type AgySettings = { permissions?: { allow?: string[]; deny?: string[] } };

function readAgySettings(path: string): AgySettings & Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as AgySettings & Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** What setup is still missing, without changing anything. */
export function agySetupState(
  tools: readonly MoltTool[],
  path = agySettingsPath(),
): { missingRules: string[]; settingsPath: string } {
  const have = new Set(readAgySettings(path).permissions?.allow ?? []);
  return {
    missingRules: agyAllowRules(tools).filter((r) => !have.has(r)),
    settingsPath: path,
  };
}

/**
 * Add molt's rules to the config you already use, and nothing else.
 *
 * ## Why this edits your settings rather than keeping its own
 *
 * The first version of this backend gave itself a private `HOME` so it would
 * never touch your Antigravity config. That worked and cost a second sign-in,
 * which is a strange thing to ask of someone who is already signed in — and
 * Claude Code and Grok both manage without one, because both take their
 * per-run configuration as arguments. `agy` has no such surface: rules live in
 * one global file and nowhere else. A project-scoped `.gemini/settings.json`
 * is not read, and neither is the outer `~/.gemini/settings.json`; both were
 * tested.
 *
 * So molt adds to the file you have. Strictly adds: every key it did not write
 * is read back and written out untouched, the rules are appended to whatever
 * `allow` already held, and a rule already present is not written twice. It
 * never removes a rule, never writes a `deny`, and never touches
 * `trustedWorkspaces` — which it does not need to, because a trusted workspace
 * turns out not to bypass the permission check at all (measured: a write into
 * a trusted directory was refused exactly like one outside it).
 *
 * What it adds is inert without molt. `mcp(molt/read_file)` permits a call to
 * a server that only answers while a molt session is holding the port and the
 * token for it.
 *
 * Returns what it actually changed, so the session can say so once rather than
 * leaving you to find it.
 */
export function ensureAgyRules(
  tools: readonly MoltTool[],
  path = agySettingsPath(),
): string[] {
  const state = agySetupState(tools, path);
  if (!state.missingRules.length) return [];
  const current = readAgySettings(path);
  const permissions = { ...(current.permissions ?? {}) };
  permissions.allow = [...(permissions.allow ?? []), ...state.missingRules];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...current, permissions }, null, 2), "utf8");
  return state.missingRules;
}

/** `~/.gemini/config/hooks.json` — global customisations, all sessions. */
export function agyHooksPath(home = homedir()): string {
  return join(home, ".gemini", "config", "hooks.json");
}

/** The hook entry molt installs, so a test can assert it without a filesystem. */
export function moltHookEntry(script: string, exe = process.execPath): Record<string, unknown> {
  return {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            // `ELECTRON_RUN_AS_NODE` because in the packaged app `execPath` is
            // Electron, and without it this starts a second window instead of
            // a script. The hook runs through `sh -c`, so the assignment works.
            command: `ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(exe)} ${JSON.stringify(script)}`,
            timeout: 15,
          },
        ],
      },
    ],
  };
}

/**
 * Install the `PreToolUse` gate, once, beside whatever hooks you already have.
 *
 * Merged by name: molt writes exactly the `molt-tool-gate` key and leaves every
 * other hook in the file untouched. Rewritten when the command changes — the
 * path to the script moves when the app is reinstalled, and a hook pointing at
 * a file that is gone is a hook that fails on every tool call.
 *
 * Safe to have installed permanently: the gate has no opinion unless
 * `MOLT_MCP_URL` is in its environment. See `agy-hook.ts`.
 */
export function ensureAgyHook(path = agyHooksPath(), script?: string): boolean {
  const entry = moltHookEntry(script ?? shippedScript("agy-hook.js"));
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    /* no hooks yet, or not ours to read */
  }
  if (JSON.stringify(current["molt-tool-gate"]) === JSON.stringify(entry)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...current, "molt-tool-gate": entry }, null, 2), "utf8");
  return true;
}

/**
 * Register molt's tool server, once, with a command line that never changes.
 *
 * No port and no token here — those would be stale by the next session. They
 * arrive in the environment; see `agyEnv`.
 */
export async function ensureAgyServer(
  bridge: string,
  run: (cmd: string, args: string[], opts: object) => Promise<{ stdout: string }> = (c, a, o) =>
    exec(c, a, o),
): Promise<void> {
  const { stdout } = await run("agy", ["mcp", "list"], {});
  if (new RegExp(`^${AGY_SERVER}\\s`, "mu").test(stdout)) return;
  await run("agy", ["mcp", "add", AGY_SERVER, process.execPath, bridge], {});
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type AgyHealth = {
  ok: boolean;
  installed: boolean;
  version?: string;
  authenticated: boolean;
  detail: string;
  fix?: string;
};

/**
 * Can this machine run the backend, and as whom.
 *
 * Authentication is probed with `agy models`, which is the cheapest question
 * that requires a live account: it fetches a list and runs no model, so it
 * spends no quota. A signed-out home answers "Please sign in", which is the
 * state a molt config home is in before its one-time login.
 */
export async function agyHealth(
  deps: {
    run?: (cmd: string, args: string[], opts: object) => Promise<{ stdout: string }>;
    tools?: readonly MoltTool[];
    settingsPath?: string;
  } = {},
): Promise<AgyHealth> {
  const run = deps.run ?? ((c: string, a: string[], o: object) => exec(c, a, o));
  let version: string | undefined;
  try {
    const { stdout } = await run("agy", ["--version"], {});
    version = stdout.trim().split(/\s+/u)[0];
  } catch {
    return {
      ok: false,
      installed: false,
      authenticated: false,
      detail: "Antigravity CLI (agy) is not on PATH",
      fix: "curl -fsSL https://antigravity.google/install.sh | bash",
    };
  }
  // The login you already have. Nothing here asks you to make a second one.
  const ids = await agyModels((c, a, o) => run(c, a, o));
  if (!ids.length) {
    return {
      ok: false,
      installed: true,
      version,
      authenticated: false,
      detail: `agy ${version} · not signed in`,
      fix: "agy",
    };
  }
  /**
   * Setup is reported, not required.
   *
   * The rules are added on the first session that needs them, so a machine
   * that has never run one is healthy and about to work — saying "not set up"
   * would send someone to fix a thing that fixes itself.
   */
  const pending = deps.tools
    ? agySetupState(deps.tools, deps.settingsPath ?? agySettingsPath()).missingRules.length
    : 0;
  return {
    ok: true,
    installed: true,
    version,
    authenticated: true,
    detail:
      `agy ${version} · signed in · ${ids.length} models` +
      (pending ? ` · ${pending} permission rule(s) will be added on first run` : ""),
  };
}

/**
 * One question, one answer — the pre-turn calls on this backend.
 *
 * `interviewTurn` and `draftCriteria` are the two places molt asks a model
 * something that is not the work. Both were written against
 * `/chat/completions`, and `antigravity://subscription` is a name rather than
 * a URL, so both were dead ends here.
 *
 * They used to refuse in words, on the grounds that `agy` always brings its 57
 * tools and a proposal drafted by something that can read the repo is a
 * different artefact from the one every other backend produces. That was true
 * and it was the wrong trade: the window drafts criteria automatically on Run,
 * so the refusal meant every first Run on this backend ended in an apology and
 * started no turn. `interview.ts` already carries that exact lesson from the
 * Claude Code backend, and this managed to repeat it anyway.
 *
 * What makes it safe without a `tools: []` to ask for:
 *
 *   - **No MCP server is registered for this call.** Molt's tools are not on
 *     offer, so nothing here can reach the ledger.
 *   - **It runs in an empty temporary directory.** Its read-only tools work
 *     and find nothing, which is the closest thing to no tools that a CLI
 *     without a tool switch can be given — and it keeps the proposal a
 *     function of the prompt, the way the other backends' proposals are.
 *   - **Everything else is denied by default** in headless mode, which is the
 *     property this whole backend rests on.
 *
 * `--disable-slash-commands` because a task that happens to begin with `/`
 * is a task, not a command.
 */
export type AgyAskOptions = {
  model: string;
  systemPrompt: string;
  prompt: string;
  /** Injected in tests. Real callers spawn the CLI. */
  run?: (cmd: string, args: string[], opts: object) => Promise<{ stdout: string }>;
};

export async function agyAsk(
  opts: AgyAskOptions,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const run = opts.run ?? ((c: string, a: string[], o: object) => exec(c, a, o));
  const dir = opts.run ? tmpdir() : mkdtempSync(join(tmpdir(), "molt-agy-ask-"));
  try {
    const { stdout } = await run(
      "agy",
      [
        `--print=${opts.systemPrompt}\n\n${opts.prompt}`,
        "--output-format",
        "json",
        "--model",
        opts.model,
        "--print-timeout",
        "180s",
        "--disable-slash-commands",
      ],
      { cwd: dir, env: agyEnv(), maxBuffer: 1024 * 1024 * 16 },
    );
    const parsed = JSON.parse(stdout) as { status?: string; response?: string; error?: string };
    if (parsed.status && !/SUCCESS/iu.test(parsed.status)) {
      // The status names the refusal — a usage limit, a timeout — and a
      // refusal reported as an empty answer would read as molt's bug.
      return { ok: false, error: parsed.error || parsed.status };
    }
    const text = (parsed.response ?? "").trim();
    return text ? { ok: true, text } : { ok: false, error: "Antigravity returned nothing" };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  } finally {
    if (!opts.run) rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export type AgyOptions<H> = {
  model: string;
  cwd: string;
  systemPrompt: string;
  tools: readonly MoltTool[];
  runTool: ToolRunner<H>;
  /** Injected in tests, which drive a scripted CLI rather than a real one. */
  spawnFn?: typeof spawn;
  /** Injected in tests so no real settings file is written or server registered. */
  setup?: (endpoint: { url: string; headers: { name: string; value: string }[] }) => Promise<void>;
};

type AgyEvent = {
  event?: string;
  init?: { tools?: string[]; permission_mode?: string };
  step_update?: {
    step_type?: string;
    state?: string;
    text_delta?: string;
    tool_name?: string;
    tool_info?: { parameters?: Record<string, unknown>; error?: { message?: string } };
  };
  result?: {
    status?: string;
    response?: string;
    error?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
    };
  };
};

/**
 * An Antigravity session, alive for as long as molt's is.
 *
 * `--print=` with an empty value is not a typo: `--print` takes its prompt as
 * a flag value, and a bare `--print` swallows the next flag as the prompt —
 * the CLI says so by name when it happens. With stream input the prompt comes
 * from stdin, so the value is empty and every message is a line.
 */
export class AgySession<H> {
  private child?: ChildProcess;
  private mcp?: McpToolServer<H>;
  private events = new Channel<BackendEvent<H>>();
  /** One reader for the session; see the note on `AcpSession.reader`. */
  private reader?: AsyncGenerator<BackendEvent<H>>;
  private started = false;
  private buf = "";
  private reply = "";
  private preface?: string;
  /** Builtins that ran without reaching molt's ledger. Reported, not hidden. */
  private unaccounted = new Set<string>();

  constructor(private opts: AgyOptions<H>) {}

  /** A plan is not a bill. The receipt says the subscription paid. */
  costSoFarUsd(): number {
    return 0;
  }

  unaccountedTools(): string[] {
    return [...this.unaccounted];
  }

  private async start(): Promise<void> {
    const { tools, runTool, cwd, model } = this.opts;
    const mcp = new McpToolServer<H>(tools, runTool, (event) =>
      this.events.push({ kind: "host", event }),
    );
    this.mcp = mcp;
    const endpoint = await mcp.listen();

    // Rules and registration first: they have to be on disk before anything
    // reads them, and a server registered after the process starts is one this
    // run never sees. Both are idempotent, so this is a no-op after the first.
    if (this.opts.setup) await this.opts.setup(endpoint);
    else {
      const added = ensureAgyRules(tools);
      const hooked = ensureAgyHook();
      await ensureAgyServer(bridgePath());
      if (hooked) {
        this.events.push({
          kind: "info",
          text:
            `installed molt's tool gate in ${agyHooksPath()} — it has no effect on ` +
            `Antigravity sessions molt did not start`,
        });
      }
      if (added.length) {
        this.events.push({
          kind: "info",
          text:
            `added ${added.length} permission rule(s) to ${agySettingsPath()}: ` +
            `${added.join(", ")} — nothing else in that file was changed`,
        });
      }
    }

    const spawnFn = this.opts.spawnFn ?? spawn;
    const child = spawnFn(
      "agy",
      [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        model,
        // Long, not infinite. molt's own turn deadline is the real bound; this
        // only stops a wedged CLI holding a session open forever.
        "--print-timeout",
        "3600s",
        "--print=",
      ],
      { cwd, env: agyEnv(endpoint), stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => this.feed(d));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      /**
       * `agy` reports a denied tool on stderr, not as a stream event, and it
       * is the single most useful line this backend produces: it names the
       * exact rule that would have allowed it. Surfaced rather than swallowed.
       */
      const text = d.trim();
      if (text) this.events.push({ kind: "info", text: `agy: ${text.slice(0, 400)}` });
    });
    child.on("error", (e) => this.events.push(doneEvent("", errorText(e))));
    child.on("exit", (code) => {
      if (this.started) this.events.push(doneEvent(this.reply, `agy exited (${code ?? "signal"})`));
    });

    /**
     * Antigravity takes no system-prompt override, so molt's rules go in as
     * the first user message. Not equivalent — a user message can be compacted
     * away where a system prompt cannot — but the alternative is running
     * molt's loop against a model that was never told the rules.
     */
    this.preface = this.opts.systemPrompt;
    this.started = true;
  }

  private feed(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i < 0) break;
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      if (!line.startsWith("{")) {
        // Not every line is JSON: the CLI prints its refusals and warnings as
        // plain text on the same stream. Dropping them would hide the one
        // message that explains a turn that did nothing.
        this.events.push({ kind: "info", text: `agy: ${line.slice(0, 400)}` });
        continue;
      }
      try {
        this.translate(JSON.parse(line) as AgyEvent);
      } catch {
        /* a half-written line is not worth ending a session over */
      }
    }
  }

  private translate(m: AgyEvent): void {
    if (m.event === "step_update") {
      const su = m.step_update ?? {};
      if (su.step_type === "agent_response" && su.text_delta) {
        this.reply += su.text_delta;
        this.events.push({ kind: "delta", text: su.text_delta });
        return;
      }
      if (su.step_type !== "tool") return;
      const name = su.tool_name ?? "";
      if (name === "call_mcp_tool") {
        // molt's own tool, on its way to `runTool` over the MCP connection.
        // The transcript records the call; the handler reports from inside it.
        if (su.state !== "ACTIVE") return;
        const p = su.tool_info?.parameters ?? {};
        const tool = String((p as { ToolName?: string }).ToolName ?? "");
        const args = ((p as { Arguments?: Record<string, unknown> }).Arguments ?? {}) as Record<
          string,
          unknown
        >;
        if (tool) {
          this.events.push({
            kind: "assistant",
            text: "",
            toolCalls: [{ id: `agy_${tool}_${Date.now().toString(36)}`, name: tool, args }],
          });
        }
        return;
      }
      /**
       * One of its own tools, and it finished.
       *
       * A refusal arrives as ERROR and is the system working — those are not
       * reported as unaccounted, because nothing happened. A DONE is a builtin
       * that ran without molt.
       *
       * Less of this happens than first assumed: `read_file` is gated too, not
       * only writes — a live run had Antigravity's own read auto-denied and
       * fall back to molt's `read_file`, at the cost of one empty step. Safe
       * shell commands (`echo`) are the ones seen to pass unasked. Whatever
       * gets through cannot change the tree, so the bar is unharmed; the
       * ledger simply may not be a complete record of what was read.
       */
      if (su.state === "DONE" && !this.unaccounted.has(name)) {
        this.unaccounted.add(name);
        this.events.push({
          kind: "info",
          text: `Antigravity ran its own '${name}' without asking — not in molt's ledger`,
        });
      }
      return;
    }
    if (m.event === "result") {
      const r = m.result ?? {};
      const u = r.usage ?? {};
      const bad = r.status && !/SUCCESS/iu.test(r.status) ? (r.error ?? r.status) : undefined;
      this.events.push({
        kind: "done",
        // `response` is the whole answer; `reply` is the same text accumulated
        // from deltas. Prefer the former and fall back, so a turn whose deltas
        // were dropped still lands its claim.
        text: r.response || this.reply,
        /**
         * Real numbers, not an estimate. This is the one backend of the three
         * that reports its own usage — `input_tokens` counts the fresh prompt
         * and `cache_read_tokens` the part it did not pay full price for, so
         * they are added back together the way `claude-code.ts` does it.
         */
        promptTokens: (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0),
        completionTokens: u.output_tokens ?? 0,
        cachedTokens: u.cache_read_tokens ?? 0,
        cumulativeCostUsd: 0,
        ...(bad ? { error: bad } : {}),
      });
    }
  }

  async *send(messages: readonly string[]): AsyncGenerator<BackendEvent<H>> {
    if (!this.started) {
      try {
        await this.start();
      } catch (e) {
        yield doneEvent("", errorText(e));
        return;
      }
    }
    const content = [this.preface, ...messages].filter(Boolean).join("\n\n");
    this.preface = undefined;
    this.reply = "";
    this.child?.stdin?.write(
      `${JSON.stringify({ event: "user", message: { role: "user", content } })}\n`,
    );

    this.reader ??= this.events.drain();
    for (;;) {
      const next = await this.reader.next();
      if (next.done) break;
      yield next.value;
      if (next.value.kind === "done") break;
    }
  }

  async close(): Promise<void> {
    this.started = false;
    this.events.close();
    this.child?.stdin?.end();
    this.child?.kill();
    await this.mcp?.close();
  }
}

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
