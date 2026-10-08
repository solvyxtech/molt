/**
 * OpenCode as a question-answerer, so its free "Big Pickle" model (or any
 * OpenCode Zen `opencode/<model>`) can be the judge: the model that drafts the
 * hidden checks and reviews the claim. `MAAT_JUDGE_URL=opencode://zen`.
 *
 * Only OpenCode Zen models are driven. OpenCode can also sign in to other
 * vendors' consumer plans (Anthropic, GitHub Copilot, Gemini, ...); Maat never
 * routes through them. Three locks, each enough on its own: any model id that
 * is not `opencode/...` is refused before the CLI is spawned
 * (`opencodeModelProblem`); the config Maat hands the CLI enables the
 * `opencode` provider and no other (`enabled_providers`, which outranks the
 * user's global and project configs: measured on 1.18.33, `opencode models`
 * lists only `opencode/*` with ANTHROPIC_API_KEY and GEMINI_API_KEY set); and
 * other providers' credentials are scrubbed from the child's environment
 * (`opencodeChildEnv`).
 *
 * Only the real `opencode` CLI is driven. OpenCode's free tier refuses direct
 * HTTP ("can only be used from within OpenCode"), and nothing here imitates
 * the CLI's requests to get around that.
 *
 * Facts measured on opencode 1.18.33, not read off a doc page:
 *
 * - `opencode run -m <provider/model> --format json <message>` prints one JSON
 *   event per line: `step_start`, `text` (`part.text`), `tool_use`,
 *   `step_finish` (`part.tokens`), or `error` (`error.data.message`,
 *   `statusCode`). It must be spawned with stdin ignored; with an inherited
 *   pipe it never exits.
 * - There is no system-prompt flag, so the system text rides in the message.
 * - **Denying tools by config breaks the free tier.** `permission: {"*":
 *   "deny"}` (or denying bash/edit alone) is answered 403 "free tier can only
 *   be used from within OpenCode": the request no longer carries the tool
 *   list the server expects. `"ask"` keeps the request intact, and a headless
 *   `run` auto-rejects every ask (measured: bash, write, webfetch and
 *   external_directory all rejected, no file created). So tools stay offered
 *   and none can run. A rejected tool ends the turn, which is reported as such.
 * - The project directory comes from `PWD` as well as the cwd, so both are set
 *   to the empty temp directory, and `--dir` is passed too.
 */
import { withSecrets } from "./secrets.js";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorText } from "./format.js";
import { isOpencodeUrl, opencodeModelProblem } from "./endpoint.js";
import { groupSpawn, killTree, trackGroup } from "./proctree.js";

export { OPENCODE_URL, opencodeModelProblem } from "./endpoint.js";

export function isOpencode(baseUrl: string | undefined): boolean {
  return isOpencodeUrl(baseUrl);
}

/**
 * Only the `opencode` (Zen) provider is enabled, and every permission is
 * "ask", which a headless run rejects. See the file comment.
 */
export const OPENCODE_CONFIG = JSON.stringify({
  enabled_providers: ["opencode"],
  permission: {
    "*": "ask",
    bash: "ask",
    edit: "ask",
    webfetch: "ask",
    websearch: "ask",
    task: "ask",
    external_directory: "ask",
    doom_loop: "ask",
  },
});

/** The model run when none is named: OpenCode Zen's free Big Pickle. */
export const OPENCODE_DEFAULT_MODEL = "opencode/big-pickle";

/**
 * `opencode/big-pickle`, or a bare `big-pickle` meaning the same. Throws for
 * anything that is not an OpenCode Zen model (see `opencodeModelProblem`).
 */
export function opencodeModel(model: string): string {
  const problem = opencodeModelProblem(model);
  if (problem) throw new Error(problem);
  const m = model.trim();
  if (!m) return OPENCODE_DEFAULT_MODEL;
  return m.includes("/") ? m : `opencode/${m}`;
}

export function opencodeArgs(model: string, message: string, dir: string): string[] {
  return ["run", "-m", opencodeModel(model), "--format", "json", "--dir", dir, message];
}

/**
 * Environment variables that would hand the OpenCode child another provider's
 * credentials or a config of the user's choosing. OpenCode reads provider keys
 * from the environment; with only Zen enabled they are unused, and with them
 * gone they are unusable too.
 */
const FOREIGN_ENV =
  /^(?:ANTHROPIC|CLAUDE|GITHUB|GH|COPILOT|GEMINI|GOOGLE|VERTEX|OPENAI|AZURE|AWS|XAI|GROK|OPENROUTER|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|CEREBRAS|HF|HUGGINGFACE|PERPLEXITY|COHERE|MOONSHOT|ZHIPU|DASHSCOPE|OLLAMA|LMSTUDIO|VERCEL|CLOUDFLARE|SAP|BEDROCK)_|_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_ACCESS_KEY)$|^OPENCODE_CONFIG(?:_DIR)?$/u;

/**
 * The OpenCode child's environment: the caller's, minus every other provider's
 * credentials and any config path, plus Maat's own config (Zen only).
 */
export function opencodeChildEnv(base: NodeJS.ProcessEnv = withSecrets(process.env)): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    // OpenCode's own key (OPENCODE_API_KEY) is the Zen account, so it stays.
    if (FOREIGN_ENV.test(k.toUpperCase()) && !/^OPENCODE_API_KEY$/iu.test(k)) continue;
    out[k] = v;
  }
  out.OPENCODE_CONFIG_CONTENT = OPENCODE_CONFIG;
  return out;
}

export function opencodeEnv(dir: string, base: NodeJS.ProcessEnv = withSecrets(process.env)): NodeJS.ProcessEnv {
  return { ...opencodeChildEnv(base), PWD: dir };
}

export type OpencodeReply = { ok: true; text: string } | { ok: false; error: string; transient?: true };

/** The answer in a `--format json` stream, or why there is none. */
export function parseOpencodeEvents(stdout: string): OpencodeReply {
  const texts: string[] = [];
  let error: { message: string; status?: number } | undefined;
  let tool: string | undefined;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev: {
      type?: string;
      part?: { text?: string; tool?: string };
      error?: { name?: string; message?: string; data?: { message?: string; statusCode?: number } };
    };
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev.type === "text" && typeof ev.part?.text === "string") texts.push(ev.part.text);
    else if (ev.type === "tool_use" && ev.part?.tool) tool ??= ev.part.tool;
    else if (ev.type === "error" && ev.error) {
      error ??= {
        message: ev.error.data?.message ?? ev.error.message ?? ev.error.name ?? "unknown error",
        ...(ev.error.data?.statusCode !== undefined ? { status: ev.error.data.statusCode } : {}),
      };
    }
  }
  const text = texts.join("").trim();
  if (text) return { ok: true, text };
  if (error) return { ok: false, ...opencodeError(error.message, error.status) };
  if (tool) return { ok: false, error: `OpenCode tried its ${tool} tool instead of answering, and no tool is allowed here` };
  return { ok: false, error: "OpenCode returned nothing" };
}

/**
 * A provider error as a message a person can act on. Rate and usage limits
 * keep the words `rate limit` so `longQuotaText` / harnesses recognise them;
 * 429/5xx are marked transient so askModel backs off and asks again.
 */
export function opencodeError(message: string, status?: number): { error: string; transient?: true } {
  const m = message.replace(/\s+/g, " ").slice(0, 300);
  if (/free tier can only be used/iu.test(m)) {
    return { error: `OpenCode refused the request (${m}) — it must run through the opencode CLI unmodified; check \`opencode run -m opencode/big-pickle hi\` by hand` };
  }
  if (status === 429 || /rate.?limit|quota|too many requests|usage limit|limit (?:reached|exceeded)/iu.test(m)) {
    const long = /resets?\s+in|per day|daily|monthly|usage limit|quota/iu.test(m);
    return {
      error: `OpenCode rate limit${status ? ` (HTTP ${status})` : ""}: ${m}`,
      ...(long ? {} : { transient: true as const }),
    };
  }
  if (status !== undefined && status >= 500) return { error: `OpenCode provider error (HTTP ${status}): ${m}`, transient: true };
  if (status === 401 || /not logged in|unauthori[sz]ed|credential/iu.test(m)) {
    return { error: `OpenCode is not signed in (${m}) — run \`opencode auth login\`` };
  }
  return { error: `OpenCode: ${m}` };
}

export type OpencodeAskOptions = {
  model: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs?: number;
  /** The run's time budget, as an epoch ms: no attempt waits past it. */
  deadlineAt?: number;
  /** Injected in tests. Real callers spawn the CLI. */
  run?: (cmd: string, args: string[], opts: object) => Promise<{ stdout: string }>;
};

export const STALL_MS = 90_000;

const NO_TOOLS =
  "Answer in plain text only. Do not use any tools, do not read or write files, and do not run commands: " +
  "everything you need is in this message.";

function runCli(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    // stdin must be ignored: `opencode run` waits on an open pipe forever.
    // Its own process group, so a timeout ends what it started too (src/proctree.ts).
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], ...groupSpawn() });
    trackGroup(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      // `close` reports a signal only for the leader; say it was the clock.
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // A non-zero exit still carries the error event on stdout; the caller reads it.
      if (signal || timedOut) reject(new Error(`opencode did not answer within ${Math.round(opts.timeoutMs / 1000)}s`));
      else resolve({ stdout: stdout || (code ? stderr : "") });
    });
  });
}

/**
 * One question to OpenCode, in an empty temp directory, every tool refused.
 * The ask is retried once when the model reached for a tool instead of
 * answering, since that is the only way a free model "fails" a plain question.
 */
export async function opencodeAsk(opts: OpencodeAskOptions): Promise<OpencodeReply> {
  // Refused before anything is spawned: a non-Zen model never reaches the CLI.
  const refused = opencodeModelProblem(opts.model);
  if (refused) return { ok: false, error: refused };
  const injected = opts.run;
  const dir = injected ? tmpdir() : mkdtempSync(join(tmpdir(), "molt-opencode-ask-"));
  const message = `${opts.systemPrompt}\n\n${NO_TOOLS}\n\n${opts.prompt}`;
  // Big Pickle usually answers in 5-25 s but now and then stalls for minutes (measured: one
  // 300 s hang in a draft that otherwise took 2 min). A stalled attempt is cut at 90 s and asked
  // again once, rather than spending the whole allowance on one dead request.
  const timeoutMs = Math.min(opts.timeoutMs ?? 180_000, STALL_MS);
  try {
    let last: OpencodeReply = { ok: false, error: "OpenCode returned nothing" };
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = opts.deadlineAt === undefined ? undefined : opts.deadlineAt - Date.now();
      if (left !== undefined && left <= 0) return attempt ? last : { ok: false, error: "the time budget ran out before OpenCode was asked" };
      const thisMs = left === undefined ? timeoutMs : Math.min(timeoutMs, left);
      let stdout: string;
      try {
        ({ stdout } = injected
          ? await injected("opencode", opencodeArgs(opts.model, message, dir), { cwd: dir, env: opencodeEnv(dir) })
          : await runCli("opencode", opencodeArgs(opts.model, message, dir), { cwd: dir, env: opencodeEnv(dir), timeoutMs: thisMs }));
      } catch (e) {
        const em = errorText(e);
        if (/ENOENT/u.test(em)) return { ok: false, error: "the opencode CLI is not installed (npm i -g opencode-ai, or brew install sst/tap/opencode)" };
        // execFile-style errors carry the stream; try to read it before giving up.
        const out = (e as { stdout?: unknown }).stdout;
        if (typeof out === "string" && out) {
          const parsed = parseOpencodeEvents(out);
          if (!parsed.ok) return parsed;
        }
        if (/did not answer within/u.test(em) && attempt === 0) {
          last = { ok: false, error: em };
          continue;
        }
        return { ok: false, error: em };
      }
      last = parseOpencodeEvents(stdout);
      if (last.ok || !/tried its .* tool/u.test(last.error)) return last;
    }
    return last;
  } finally {
    if (!injected) rmSync(dir, { recursive: true, force: true });
  }
}
