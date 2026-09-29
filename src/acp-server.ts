/**
 * molt as an ACP agent: an editor drives molt the way molt drives Grok.
 *
 * `molt acp` speaks the Agent Client Protocol on stdio, so an editor's agent
 * panel (Zed first) can run molt in place of its own agent. The editor sends
 * prompts; molt runs its ordinary turn — the same engine, the same autonomy
 * gate, the same ledger, the same bar — and reports it back as ACP updates.
 *
 * What the protocol could not say before is the reason molt exists: whether
 * "done" was proven. Every turn ends with the bar's verdict, as the last
 * agent message and in the prompt response's `_meta.molt`, and the bar's
 * checks are the turn's plan. A turn the bar refused still ends `end_turn`
 * — ACP's `refusal` means the agent declined the prompt, which drops it from
 * the editor's history, and molt refusing a completion is not that.
 *
 * Permission questions are molt's own: the autonomy level decides what is
 * asked, exactly as in the terminal and the window, and the editor only
 * supplies the answer. The level is exposed as the session's mode.
 *
 * Schema: agent-client-protocol v1 as Zed builds it (Rust crate 2.2.0,
 * schema 1.9.1). Nothing in here writes to stdout; the caller hands in the
 * one function that may.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTONOMY_LEVELS,
  AUTONOMY_SUMMARY,
  insideProject,
  isAutonomy,
  isIrreversible,
  type Autonomy,
} from "./autonomy.js";
import type { Engine, FileAccess } from "./engine.js";
import { applyEdit } from "./files.js";
import { INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, RpcError, RpcPeer } from "./jsonrpc.js";
import type { BarResult, CheckResult, ConfirmCall, EngineEvent, JobOutcome, Spend } from "./types.js";

/** The ACP major version molt speaks. */
export const ACP_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Wire shapes: the parts of the schema molt reads or writes
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "resource_link";
      uri: string;
      name?: string;
      title?: string;
      mimeType?: string;
    }
  | {
      type: "resource";
      resource: { uri: string; text?: string; blob?: string; mimeType?: string };
    }
  | { type: "image"; mimeType?: string; data?: string; uri?: string }
  | { type: "audio"; mimeType?: string; data?: string };

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolCallContent =
  | { type: "content"; content: { type: "text"; text: string } }
  | { type: "diff"; path: string; oldText: string | null; newText: string };

export type PlanEntry = {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
};

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

type PermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

type ClientCaps = { readTextFile: boolean; writeTextFile: boolean };

// ---------------------------------------------------------------------------
// Pure mapping from molt's world to ACP's — exported for the tests
// ---------------------------------------------------------------------------

/** ACP's tool kind for one of molt's tools; it picks the icon an editor shows. */
export function toolKind(name: string): ToolKind {
  switch (name) {
    case "read_file":
    case "list_dir":
      return "read";
    case "grep":
      return "search";
    case "write_file":
    case "edit_file":
      return "edit";
    case "bash":
      return "execute";
    default:
      return "other";
  }
}

const oneLine = (s: string, max = 160): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** What the row says: the verb and its object, in the person's terms. */
export function toolTitle(name: string, args: Record<string, unknown>): string {
  const path = typeof args.path === "string" && args.path ? args.path : undefined;
  switch (name) {
    case "read_file": {
      const offset = Number(args.offset);
      return `Read ${path ?? "(no path)"}${Number.isFinite(offset) && offset > 0 ? ` from line ${offset + 1}` : ""}`;
    }
    case "list_dir":
      return `List ${path ?? "."}`;
    case "grep":
      return `Search for ${oneLine(String(args.pattern ?? ""), 80)} in ${path ?? "."}`;
    case "write_file":
      return `Write ${path ?? "(no path)"}`;
    case "edit_file":
      return `Edit ${path ?? "(no path)"}`;
    case "bash":
      return `Run ${oneLine(String(args.command ?? ""))}`;
    default:
      return name;
  }
}

/** Where the call acts, so an editor can follow along. Absolute, as ACP requires. */
export function toolLocations(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): { path: string; line?: number }[] {
  const path = typeof args.path === "string" && args.path ? args.path : undefined;
  if (!path || !["read_file", "list_dir", "grep", "write_file", "edit_file"].includes(name)) return [];
  const abs = resolve(cwd, path);
  const offset = Number(args.offset);
  return [{ path: abs, ...(name === "read_file" && Number.isFinite(offset) && offset > 0 ? { line: offset + 1 } : {}) }];
}

/**
 * What "always" would remember for this call, or null where molt will not
 * offer it.
 *
 * The autonomy rules say leaving the project and anything irreversible
 * always ask, at every level, and an "always allow" answer must not become a
 * way around that. So writes are remembered as "writes inside this project"
 * and commands as that exact command, and neither is offered at all for a
 * path outside the project or a command molt classifies as irreversible.
 */
export function alwaysKey(name: string, args: Record<string, unknown>, cwd: string): string | null {
  if (name === "write_file" || name === "edit_file") {
    return typeof args.path === "string" && args.path && insideProject(cwd, args.path) ? "write" : null;
  }
  if (name === "bash") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    return command && !isIrreversible(command) ? `bash:${command}` : null;
  }
  return null;
}

export function permissionOptions(key: string | null): { optionId: string; name: string; kind: string }[] {
  const scope = key === "write" ? "writes in this project" : "this command";
  return [
    { optionId: "allow_once", name: "Allow", kind: "allow_once" },
    ...(key ? [{ optionId: "allow_always", name: `Always allow ${scope}`, kind: "allow_always" }] : []),
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ...(key ? [{ optionId: "reject_always", name: `Always reject ${scope}`, kind: "reject_always" }] : []),
  ];
}

/** A fence longer than any backtick run inside the text, so the text cannot close it. */
function fenced(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}`;
}

/** Whether a finished call failed, from what molt reported about it. */
export function toolFailed(ev: Extract<EngineEvent, { kind: "tool" }>): boolean {
  if (ev.note && ["error", "denied", "cancelled", "out of time", "malformed"].includes(ev.note)) return true;
  const head = ev.preview ?? "";
  if (/^(write refused|edit refused|no such file|tool error|unknown tool)/.test(head)) return true;
  // A command that exited non-zero ran, and its output is the result — but
  // an editor shows a failed command as failed, and so does molt's own log.
  return ev.name === "bash" && /^(exit \S+|timeout)\n/.test(head);
}

/** The prompt, as the one string molt's turn takes. */
export function promptText(blocks: ContentBlock[], cwd: string): string {
  const inline: string[] = [];
  const attached: string[] = [];
  const shown = (uri: string): string => {
    if (!uri.startsWith("file:")) return uri;
    try {
      const abs = fileURLToPath(uri);
      const rel = relative(cwd, abs);
      return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : abs;
    } catch {
      return uri;
    }
  };
  for (const b of blocks) {
    switch (b?.type) {
      case "text":
        inline.push(b.text);
        break;
      case "resource_link":
        inline.push(b.uri.startsWith("file:") ? `\`${shown(b.uri)}\`` : `[${b.name ?? b.uri}](${b.uri})`);
        break;
      case "resource": {
        const where = shown(b.resource.uri);
        inline.push(`\`${where}\``);
        attached.push(
          typeof b.resource.text === "string"
            ? `Attached by the editor — ${where}:\n${fenced(b.resource.text)}`
            : `Attached by the editor — ${where}: binary content, not included.`,
        );
        break;
      }
      case "image":
      case "audio":
        inline.push(`[${b.type} attachment omitted: molt cannot read ${b.type}]`);
        break;
      default:
        break;
    }
  }
  // Adjacent blocks are how an editor spells an inline mention: text, a
  // link, more text. Joined without a separator they read as one sentence.
  const body = inline.join("");
  return attached.length ? `${body}\n\n${attached.join("\n\n")}` : body;
}

function checkLabel(r: CheckResult): string {
  if (r.skipped) return r.ok ? "n/a" : "not run";
  if (!r.ok) return r.advisory ? "warn" : "FAILED";
  return r.established === false ? "pass (nothing to establish)" : r.cached ? "pass (reused)" : "pass";
}

/** The bar as a plan: one entry per check, in the order molt runs them. */
export function planFromResult(result: BarResult): PlanEntry[] {
  return result.results.map((r) => ({
    content: `${r.name}: ${checkLabel(r)}`,
    priority: r.advisory ? "low" : "high",
    // A plan entry has no "failed". An unmet check is work still to do, and
    // that is what pending says.
    status: r.ok ? "completed" : "pending",
  }));
}

export function planFromNames(names: string[], status: PlanEntry["status"]): PlanEntry[] {
  return names.map((n) => ({ content: n, priority: "high", status }));
}

export type TurnRecord = {
  outcome?: JobOutcome;
  bar?: BarResult;
  /** How the bar ended: met, or refused for the last time, or never run. */
  barEnd?: "met" | "exhausted";
  attempts?: number;
  receipt?: string;
  /** The engine's own sentence explaining an unmet or undetermined bar. */
  why?: string;
  filesWritten?: string[];
  hasBar: boolean;
};

/**
 * The verdict, as the last thing the person reads.
 *
 * Said in molt's terms, and never softer than the receipt: an answer nothing
 * checked is "unverified", not "done".
 */
export function verdictText(t: TurnRecord, cwd: string): string {
  const rel = (p: string) => (isAbsolute(p) ? relative(cwd, p) || p : p);
  const receipt = t.receipt ? ` · receipt \`${rel(t.receipt)}\`` : "";
  const bar = t.bar;
  const ran = bar ? bar.results.filter((r) => !r.skipped) : [];
  const passed = ran.filter((r) => r.ok).length;
  const counts = bar ? `${passed} of ${ran.length} checks passed` : "";
  let head: string;
  switch (t.outcome) {
    case "verified":
      head = `**molt · bar met** — done is proven: ${counts}${receipt}`;
      break;
    case "answered":
      head = `**molt · answered** — a question; nothing was written, so the bar ran advisory and could not refuse it${counts ? ` (${counts})` : ""}${receipt}`;
      break;
    case "unverified":
      head = t.hasBar
        ? `**molt · unverified** — the answer was not checked${receipt}`
        : "**molt · unverified** — this project has no `.molt/done.yml`, so nothing checked this answer. `molt init` adds a bar.";
      break;
    case "not proven":
      head = bar?.undetermined?.length && !bar.results.some((r) => !r.ok && !r.advisory && !r.skipped)
        ? `**molt · bar undetermined** — required checks were not run: ${bar.undetermined.join(", ")}${receipt}`
        : `**molt · bar NOT met** — done is not proven after ${t.attempts ?? 1} attempt${t.attempts === 1 ? "" : "s"}: ${counts}${receipt}`;
      break;
    case "cancelled":
      head = t.filesWritten?.length
        ? `**molt · cancelled** — the conversation is rolled back, but these files were already written and stay on disk: ${t.filesWritten.map((f) => `\`${f}\``).join(", ")}`
        : "**molt · cancelled** — nothing was written, and the conversation is rolled back";
      break;
    case "stopped":
      head = "**molt · stopped** — the turn ended without an answer, and nothing was verified";
      break;
    default:
      head = "**molt · error** — the turn failed, and nothing was verified";
  }
  const lines = [head];
  if (bar && t.outcome !== "cancelled") {
    for (const r of bar.results) {
      const mark = r.skipped ? "·" : r.ok ? "✓" : r.advisory ? "!" : "✗";
      const evidence = (r.ok ? "" : r.output.trim().split("\n")[0] ?? "").slice(0, 200);
      lines.push(`- ${mark} ${r.name} — ${checkLabel(r)}${evidence ? `: ${evidence}` : ""}`);
    }
  }
  if (t.why && t.outcome === "not proven") lines.push("", t.why);
  return `\n\n---\n${lines.join("\n")}\n`;
}

export function stopReasonFor(t: {
  cancelled: boolean;
  outcome?: JobOutcome;
  ceiling?: "steps" | "budget" | "turn";
  truncated: boolean;
}): StopReason | null {
  if (t.cancelled || t.outcome === "cancelled") return "cancelled";
  if (t.ceiling === "steps") return "max_turn_requests";
  if (t.ceiling === "budget" || t.ceiling === "turn") return "max_tokens";
  if (t.outcome === "error") return t.truncated ? "max_tokens" : null;
  return "end_turn";
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export type NewEngine = (ctx: { cwd: string; sessionId: string; files?: FileAccess }) => Promise<Engine>;

export type AcpServerOptions = {
  /** One complete frame to the client. The only thing allowed to reach stdout. */
  write: (line: string) => void;
  newEngine: NewEngine;
  /** Diagnostics. stderr in the real process. */
  log?: (line: string) => void;
  version: string;
};

type Turn = {
  cancelled: boolean;
  onCancel: Promise<void>;
  cancel: () => void;
};

type Session = {
  id: string;
  cwd: string;
  engine: Engine;
  turn?: Turn;
  /** "always" answers, by alwaysKey. */
  always: Map<string, boolean>;
  /** Tool calls the editor has been told about, so each is created once. */
  announced: Set<string>;
  asks: number;
};

const MODE_NAMES: Record<Autonomy, string> = {
  low: "Ask first (low autonomy)",
  medium: "Project writes (medium autonomy)",
  high: "Most things (high autonomy)",
};

export class AcpServer {
  readonly peer: RpcPeer;
  private sessions = new Map<string, Session>();
  private caps: ClientCaps = { readTextFile: false, writeTextFile: false };
  private initialized = false;

  constructor(private opts: AcpServerOptions) {
    this.peer = new RpcPeer({
      write: opts.write,
      onRequest: (m, p) => this.handle(m, p),
      onNotify: (m, p) => this.notified(m, p),
      onGarbage: "reply",
    });
  }

  private log(line: string): void {
    this.opts.log?.(`molt acp: ${line}`);
  }

  feed(chunk: string): void {
    this.peer.feed(chunk);
  }

  /** The client went away: stop every turn, answer nothing more. */
  close(): void {
    for (const s of this.sessions.values()) {
      s.turn?.cancel();
      s.engine.cancel();
    }
    this.peer.fail(new Error("client disconnected"));
  }

  private async handle(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      if (params !== undefined) throw new RpcError(INVALID_PARAMS, "params must be an object");
    }
    switch (method) {
      case "initialize":
        return this.initialize(p);
      case "authenticate":
        throw new RpcError(
          INVALID_PARAMS,
          "molt advertises no authentication methods: it reads provider keys from its own config " +
            "(run `molt` in a terminal and use /login) or from MOLT_API_KEY",
        );
      case "session/new":
        return this.newSession(p);
      case "session/set_mode":
        return this.setMode(p);
      case "session/prompt":
        return this.prompt(p);
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  private notified(method: string, params: unknown): void {
    if (method === "session/cancel") {
      const id = (params as { sessionId?: unknown } | null)?.sessionId;
      const s = typeof id === "string" ? this.sessions.get(id) : undefined;
      if (!s) {
        this.log(`session/cancel for unknown session ${String(id)}`);
        return;
      }
      s.turn?.cancel();
      s.engine.cancel();
      return;
    }
    this.log(`ignoring notification ${method}`);
  }

  private initialize(p: Record<string, unknown>): unknown {
    const fs = ((p.clientCapabilities as Record<string, unknown> | undefined)?.fs ?? {}) as Record<string, unknown>;
    this.caps = { readTextFile: fs.readTextFile === true, writeTextFile: fs.writeTextFile === true };
    this.initialized = true;
    const info = p.clientInfo as { name?: string; version?: string } | undefined;
    this.log(
      `initialized by ${info?.name ?? "a client"}${info?.version ? ` ${info.version}` : ""} · ` +
        `fs read ${this.caps.readTextFile ? "via editor" : "on disk"}, write ${this.caps.writeTextFile ? "via editor" : "on disk"}`,
    );
    return {
      // molt speaks exactly one version. A client asking for another gets
      // this one and decides for itself, as the spec says it should.
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        // Not implemented: a session lives as long as this process.
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        // molt does not connect to MCP servers; see CONTRIBUTING's non-goals.
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: {},
      },
      authMethods: [],
      agentInfo: { name: "molt", title: "molt", version: this.opts.version },
    };
  }

  private session(p: Record<string, unknown>): Session {
    const id = p.sessionId;
    if (typeof id !== "string") throw new RpcError(INVALID_PARAMS, "sessionId is required");
    const s = this.sessions.get(id);
    if (!s) throw new RpcError(INVALID_PARAMS, `no such session: ${id}`);
    return s;
  }

  private async newSession(p: Record<string, unknown>): Promise<unknown> {
    if (!this.initialized) throw new RpcError(INVALID_REQUEST, "initialize first");
    const cwd = p.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) {
      throw new RpcError(INVALID_PARAMS, "cwd must be an absolute path");
    }
    if (!existsSync(cwd)) throw new RpcError(INVALID_PARAMS, `no such directory: ${cwd}`);
    const mcp = Array.isArray(p.mcpServers) ? (p.mcpServers as { name?: string }[]) : [];
    if (mcp.length) {
      // Accepted rather than refused: an editor passes its configured servers
      // to every agent, and refusing the session over them would make molt
      // unusable for anyone who has one. Said, so nobody believes they work.
      this.log(
        `ignoring ${mcp.length} MCP server(s) (${mcp.map((m) => m.name ?? "?").join(", ")}): ` +
          `molt uses its own tools only`,
      );
    }
    const sessionId = randomUUID();
    const files = this.fileAccess(sessionId);
    let engine: Engine;
    try {
      engine = await this.opts.newEngine({ cwd, sessionId, files });
    } catch (e) {
      throw new RpcError(INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
    }
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd,
      engine,
      always: new Map(),
      announced: new Set(),
      asks: 0,
    });
    this.log(`session ${sessionId} in ${cwd} · ${engine.model} · autonomy ${engine.autonomy}`);
    // After the response, so the editor knows the session before it hears
    // about it.
    setImmediate(() =>
      this.update(sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "ask",
            description:
              "Ask a question: a turn that writes nothing is judged as an answer, not refused for doing no work",
            input: { hint: "question" },
          },
        ],
      }),
    );
    return {
      sessionId,
      modes: {
        currentModeId: engine.autonomy,
        availableModes: AUTONOMY_LEVELS.map((level) => ({
          id: level,
          name: MODE_NAMES[level],
          description: AUTONOMY_SUMMARY[level],
        })),
      },
    };
  }

  /** The editor's buffers, when it offers them; disk otherwise. */
  private fileAccess(sessionId: string): FileAccess | undefined {
    if (!this.caps.readTextFile && !this.caps.writeTextFile) return undefined;
    const files: FileAccess = {};
    if (this.caps.readTextFile) {
      files.read = async (path) => {
        const r = (await this.peer.request("fs/read_text_file", { sessionId, path })) as { content?: unknown };
        if (typeof r?.content !== "string") throw new Error("fs/read_text_file returned no content");
        return r.content;
      };
    }
    if (this.caps.writeTextFile) {
      files.write = async (path, content) => {
        await this.peer.request("fs/write_text_file", { sessionId, path, content });
      };
    }
    return files;
  }

  private setMode(p: Record<string, unknown>): unknown {
    const s = this.session(p);
    const mode = p.modeId;
    if (typeof mode !== "string" || !isAutonomy(mode)) {
      throw new RpcError(INVALID_PARAMS, `modeId must be one of ${AUTONOMY_LEVELS.join(", ")}`);
    }
    s.engine.setAutonomy(mode);
    this.log(`session ${s.id} autonomy → ${mode}`);
    return {};
  }

  private update(sessionId: string, update: Record<string, unknown>): void {
    this.peer.notify("session/update", { sessionId, update });
  }

  private async prompt(p: Record<string, unknown>): Promise<unknown> {
    const s = this.session(p);
    if (s.turn) throw new RpcError(INVALID_REQUEST, "a turn is already running in this session");
    if (!Array.isArray(p.prompt)) throw new RpcError(INVALID_PARAMS, "prompt must be an array of content blocks");
    const raw = promptText(p.prompt as ContentBlock[], s.cwd);
    // A leading "?" or /ask marks a question, as it does in the terminal. It
    // has to be the person who says so: molt never lets the model decide
    // which of its own claims need proving.
    const asking = /^\?\s*\S/.test(raw) || /^\/ask\s+\S/.test(raw);
    const text = asking ? raw.replace(/^(\?|\/ask)\s*/, "") : raw;
    if (!text.trim()) throw new RpcError(INVALID_PARAMS, "the prompt is empty");

    let cancelNow!: () => void;
    const onCancel = new Promise<void>((r) => (cancelNow = r));
    const turn: Turn = {
      cancelled: false,
      onCancel,
      cancel: () => {
        turn.cancelled = true;
        cancelNow();
      },
    };
    s.turn = turn;
    s.announced.clear();
    try {
      return await this.runTurn(s, turn, text, asking);
    } finally {
      s.turn = undefined;
    }
  }

  /** Ask the editor, and give up waiting the moment the turn is cancelled. */
  private async askPermission(s: Session, turn: Turn, params: Record<string, unknown>): Promise<PermissionOutcome> {
    if (turn.cancelled) return { outcome: "cancelled" };
    try {
      const answer = await Promise.race([
        this.peer.request("session/request_permission", { sessionId: s.id, ...params }),
        turn.onCancel.then(() => ({ outcome: { outcome: "cancelled" } })),
      ]);
      const outcome = (answer as { outcome?: PermissionOutcome } | null)?.outcome;
      return outcome && (outcome.outcome === "selected" || outcome.outcome === "cancelled")
        ? outcome
        : { outcome: "cancelled" };
    } catch (e) {
      this.log(`session/request_permission failed: ${e instanceof Error ? e.message : String(e)} — treated as a refusal`);
      return { outcome: "cancelled" };
    }
  }

  /** What approving a write would do, shown in the question itself. */
  private async proposedDiff(s: Session, name: string, args: Record<string, unknown>): Promise<ToolCallContent[]> {
    if (name !== "write_file" && name !== "edit_file") return [];
    if (typeof args.path !== "string" || !args.path) return [];
    const abs = resolve(s.cwd, args.path);
    try {
      let current: string | null = null;
      if (existsSync(abs)) {
        const read = this.caps.readTextFile
          ? ((await this.peer.request("fs/read_text_file", { sessionId: s.id, path: abs })) as { content?: string })
              .content
          : undefined;
        current = typeof read === "string" ? read : readFileSync(abs, "utf8");
      }
      if (name === "write_file") {
        return [{ type: "diff", path: abs, oldText: current, newText: String(args.content ?? "") }];
      }
      if (current === null) return [];
      const edit = applyEdit(current, String(args.old_text ?? ""), String(args.new_text ?? ""), args.replace_all === true);
      return edit.ok ? [{ type: "diff", path: abs, oldText: current, newText: edit.text }] : [];
    } catch {
      // A preview is a courtesy. The question can be asked without it.
      return [];
    }
  }

  private async runTurn(s: Session, turn: Turn, text: string, asking: boolean): Promise<unknown> {
    const { engine, cwd } = s;
    const record: TurnRecord = { hasBar: engine.hasBar };
    let ceiling: "steps" | "budget" | "turn" | undefined;
    let truncated = false;
    let lastError: string | undefined;
    let spend: Spend | undefined;
    let exhaustedSeen = false;
    /** A message ended; the next text starts a new paragraph. */
    let paragraph = false;
    let wroteText = false;

    const say = (t: string) => {
      if (!t) return;
      const text = paragraph && wroteText ? `\n\n${t.replace(/^\n+/, "")}` : t;
      paragraph = false;
      wroteText = true;
      this.update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    };
    const note = (t: string) => say(`\n\n_molt: ${t.replace(/\n+/g, " ")}_\n\n`);
    const plan = (entries: PlanEntry[]) => {
      if (entries.length) this.update(s.id, { sessionUpdate: "plan", entries });
    };
    const announce = (id: string, name: string, args: Record<string, unknown>, status: ToolStatus, extra: Record<string, unknown> = {}) => {
      s.announced.add(id);
      paragraph = true;
      this.update(s.id, {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: toolTitle(name, args),
        kind: toolKind(name),
        status,
        locations: toolLocations(name, args, cwd),
        rawInput: args,
        ...extra,
      });
    };

    const confirm = async (name: string, _detail: string, call?: ConfirmCall): Promise<boolean> => {
      if (turn.cancelled) return false;
      const id = call?.id ?? `molt-ask-${++s.asks}`;
      const args = call?.args ?? {};
      const key = alwaysKey(name, args, cwd);
      if (key !== null && s.always.has(key)) return s.always.get(key)!;
      const preview = await this.proposedDiff(s, name, args);
      const why: ToolCallContent[] = call?.why
        ? [{ type: "content", content: { type: "text", text: `molt asks because ${call.why}.` } }]
        : [];
      announce(id, name, args, "pending", { content: [...preview, ...why] });
      const outcome = await this.askPermission(s, turn, {
        toolCall: {
          toolCallId: id,
          title: toolTitle(name, args),
          kind: toolKind(name),
          status: "pending",
          locations: toolLocations(name, args, cwd),
          rawInput: args,
          content: [...preview, ...why],
        },
        options: permissionOptions(key),
      });
      if (outcome.outcome !== "selected") return false;
      switch (outcome.optionId) {
        case "allow_once":
          return true;
        case "allow_always":
          if (key !== null) s.always.set(key, true);
          return true;
        case "reject_always":
          if (key !== null) s.always.set(key, false);
          return false;
        default:
          return false;
      }
    };

    /**
     * The step or spending ceiling, asked the way the window asks it.
     *
     * Headless `molt run` has nobody to ask and stops; an editor has somebody,
     * and stopping dead at a ceiling converts everything already spent into
     * nothing. So the question goes to the person, as a permission request on
     * a row of its own — the one channel ACP has for "yes or no, from a human".
     */
    const onCeiling = async (spent: string): Promise<boolean> => {
      const id = `molt-ceiling-${++s.asks}`;
      paragraph = true;
      const title = `Keep going? This turn has reached its ceiling (${spent})`;
      this.update(s.id, { sessionUpdate: "tool_call", toolCallId: id, title, kind: "other", status: "pending" });
      const outcome = await this.askPermission(s, turn, {
        toolCall: { toolCallId: id, title, kind: "other", status: "pending" },
        options: [
          { optionId: "continue", name: "Continue", kind: "allow_once" },
          { optionId: "stop", name: "Stop here", kind: "reject_once" },
        ],
      });
      const more = outcome.outcome === "selected" && outcome.optionId === "continue";
      this.update(s.id, { sessionUpdate: "tool_call_update", toolCallId: id, status: more ? "completed" : "failed" });
      return more;
    };

    const onEvent = (ev: EngineEvent) => {
      switch (ev.kind) {
        case "delta":
          say(ev.text);
          break;
        case "assistant_text":
          if (!ev.streamed) say(ev.text);
          break;
        case "message_end":
          paragraph = true;
          break;
        case "thought":
          this.update(s.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: ev.text } });
          break;
        case "stream_reset":
          note(`the reply above was abandoned mid-stream (${ev.why}); it starts again below`);
          break;
        case "job_start":
          if (engine.cfg.bar?.checks.length) {
            plan(planFromNames(engine.cfg.bar.checks.map((c) => c.name), "pending"));
          }
          break;
        case "tool_start": {
          const id = ev.id ?? `molt-tool-${++s.asks}`;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(ev.args ?? "{}") as Record<string, unknown>;
          } catch {
            /* the title falls back to the name */
          }
          if (s.announced.has(id)) {
            this.update(s.id, { sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
          } else {
            announce(id, ev.name, args, "in_progress");
          }
          break;
        }
        case "tool": {
          const id = ev.id ?? `molt-tool-${++s.asks}`;
          const status: ToolStatus = toolFailed(ev) ? "failed" : "completed";
          const content: ToolCallContent[] = ev.diff
            ? [{ type: "diff", path: ev.diff.path, oldText: ev.diff.oldText, newText: ev.diff.newText }]
            : ev.preview
              ? [{ type: "content", content: { type: "text", text: fenced(ev.preview) } }]
              : [];
          const rawOutput = {
            bytes: ev.bytes ?? 0,
            ...(ev.note ? { note: ev.note } : {}),
            ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
          };
          if (s.announced.has(id)) {
            this.update(s.id, { sessionUpdate: "tool_call_update", toolCallId: id, status, content, rawOutput });
          } else {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(ev.args ?? "{}") as Record<string, unknown>;
            } catch {
              /* malformed: announced by name */
            }
            announce(id, ev.name, args, status, { content, rawOutput });
          }
          break;
        }
        case "step_summary": {
          const used = ev.spend.promptTokens + ev.spend.completionTokens;
          this.update(s.id, {
            sessionUpdate: "usage_update",
            // The size of the conversation this step sent and received, which
            // is what a context meter shows. `size` is the window the endpoint
            // has named, and 0 until it names one: molt does not invent a
            // window, because a meter against a guess reads as a measurement.
            used,
            size: engine.learnedWindow,
            ...(ev.sessionCostUsd !== undefined ? { cost: { amount: ev.sessionCostUsd, currency: "USD" } } : {}),
            _meta: {
              molt: {
                step: ev.step + 1,
                sessionTokens: ev.sessionTokens,
                stepCostUsd: ev.spend.costUsd ?? null,
                estimated: ev.spend.estimated,
                billed: ev.spend.billed,
              },
            },
          });
          if (ev.outcome === "truncated") truncated = true;
          break;
        }
        case "proof_start":
          plan(planFromNames(ev.names, "in_progress"));
          break;
        case "proof_refused": {
          record.bar = ev.result;
          plan(planFromResult(ev.result));
          const failing = ev.result.results.filter((r) => !r.ok && !r.advisory && !r.skipped).map((r) => r.name);
          note(
            `completion refused (attempt ${ev.attempt})${failing.length ? ` — failing: ${failing.join(", ")}` : ""}. ` +
              `The failures went back to the model.`,
          );
          break;
        }
        case "proof_result":
          record.bar = ev.result;
          record.barEnd = "met";
          plan(planFromResult(ev.result));
          break;
        case "proof_exhausted":
          record.bar = ev.result;
          record.barEnd = "exhausted";
          record.attempts = ev.attempts;
          exhaustedSeen = true;
          plan(planFromResult(ev.result));
          break;
        case "receipt":
          record.receipt = ev.path;
          break;
        case "shed":
          note(`shed ${ev.dropped} messages (${ev.before}→${ev.after} tokens); the originals are kept in ${ev.path}`);
          break;
        case "cancelled":
          record.filesWritten = ev.filesWritten;
          break;
        case "info":
          note(ev.text);
          break;
        case "error":
          if (ev.ceiling) ceiling = ev.ceiling;
          lastError = ev.text;
          // After an exhausted bar the engine explains the verdict; that
          // sentence belongs with the verdict, not above it.
          if (exhaustedSeen) record.why = ev.text;
          else note(ev.text);
          break;
        case "job_end":
          record.outcome = ev.outcome;
          spend = ev.spend;
          break;
        default:
          break;
      }
    };

    try {
      for await (const ev of engine.run(text, confirm, { ask: asking, onCeiling })) {
        onEvent(ev);
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      record.outcome = turn.cancelled ? "cancelled" : "error";
    }

    const stopReason = stopReasonFor({ cancelled: turn.cancelled, outcome: record.outcome, ceiling, truncated });
    if (stopReason === null) {
      // A turn that failed outright — the provider refused, the endpoint is
      // down — is an error in ACP's terms, and an editor shows it as one.
      throw new RpcError(INTERNAL_ERROR, lastError ?? "the turn failed");
    }
    if (stopReason === "cancelled") record.outcome = "cancelled";
    paragraph = true;
    say(verdictText(record, cwd));

    const verdict =
      record.outcome === "verified"
        ? "met"
        : record.outcome === "not proven"
          ? record.bar?.undetermined?.length && !record.bar.results.some((r) => !r.ok && !r.advisory && !r.skipped)
            ? "undetermined"
            : "not met"
          : record.outcome === "answered"
            ? "answered"
            : record.outcome === "unverified"
              ? "unverified"
              : (record.outcome ?? "none");
    return {
      stopReason,
      ...(spend
        ? {
            usage: {
              totalTokens: spend.promptTokens + spend.completionTokens,
              inputTokens: spend.promptTokens,
              outputTokens: spend.completionTokens,
              ...(spend.cachedTokens ? { cachedReadTokens: spend.cachedTokens } : {}),
            },
          }
        : {}),
      _meta: {
        molt: {
          outcome: record.outcome ?? null,
          verdict,
          receipt: record.receipt ?? null,
          ...(record.bar
            ? {
                checks: record.bar.results.map((r) => ({
                  name: r.name,
                  ok: r.ok,
                  ...(r.skipped ? { skipped: r.skipped } : {}),
                  ...(r.advisory ? { advisory: true } : {}),
                  ...(r.established === false ? { established: false } : {}),
                })),
              }
            : {}),
          ...(spend?.costUsd !== undefined ? { costUsd: spend.costUsd, costEstimated: spend.estimated } : {}),
        },
      },
    };
  }
}
