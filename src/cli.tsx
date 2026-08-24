#!/usr/bin/env node
/**
 * molt's command line.
 *
 * The interactive TUI is the default, but every capability is also
 * reachable headlessly — `molt run` and `molt prove` exit non-zero when the
 * bar is not met, so molt can sit in CI, in a script, or in a benchmark
 * harness without a human watching.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Archive } from "./archive.js";
import { isAutonomy, type Autonomy } from "./autonomy.js";
import { fmtCost, fmtDuration } from "./banner.js";
import { BarError, hasBar, loadBar, selectChecks, writeDefaultBar } from "./bar.js";
import { Engine } from "./engine.js";
import { Journal } from "./journal.js";
import {
  fetchPricing,
  needsPriceLookup,
  providerName,
  savePricing,
  storedEndpoint,
  type StoredEndpoint,
} from "./providers.js";
import { Receipts } from "./receipts.js";
import type { BarResult, EngineEvent } from "./types.js";

/**
 * The version, from the manifest that npm actually publishes.
 *
 * It was a string literal, correct today and destined to drift the next time
 * one of the two was bumped without the other — and a tool whose pitch is
 * "check, do not assert" should not assert its own version.
 */
const VERSION = `v${
  (() => {
    try {
      return (
        JSON.parse(
          readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version?: string }
      ).version;
    } catch {
      return undefined;
    }
  })() ?? "0.0.0-unknown"
}`;

/**
 * Which build is actually running, as opposed to which version it claims.
 *
 * Every session on this machine logged `v1.0.0-rc.4` across builds that
 * differed by hundreds of lines, because the global `molt` is a symlink into
 * a working tree and runs whatever `dist/` was last compiled. A receipt that
 * cannot name the code that produced it is not evidence, so the mtime of the
 * running file goes in the record beside the version. Cheap, needs no git,
 * and changes exactly when the build does.
 */
function buildStamp(): string | undefined {
  try {
    return statSync(new URL(import.meta.url)).mtime.toISOString();
  } catch {
    return undefined;
  }
}

const USAGE = `molt ${VERSION} — a coding agent that can't say "done" without proving it.

usage
  molt                      interactive session
  molt run "<task>"         headless; exits non-zero if the bar is not met
  molt ask "<question>"     a question, not a change — no work-landed check
  molt prove                run .molt/done.yml now and exit
  molt init                 write a starter .molt/done.yml
  molt doctor               check the endpoint and model

  molt receipts             list completion attempts (--grep, --show <file>, --repair)
  molt archive              list shed batches (--grep, --show <n>, --explain)
  molt stats                false-claim rate and tokens per verified change
  molt log                  what the model actually did, from the session log
  molt verify               recompute the log's hash chain
  molt --help

first run
  molt → /login (pick a provider, paste the key) → /model (pick one) → go
  the choice is remembered, so later runs start where you left off

options
  --url <base>       OpenAI-compatible base URL   (MOLT_BASE_URL)
                     any server speaking the OpenAI shape: Ollama, llama.cpp,
                     vLLM, on this machine or another. /endpoint in the TUI.
                     default http://localhost:11434/v1
  --model <id>       model id                     (MOLT_MODEL)
                     no default — /model or --model picks one
  --key <secret>     api key, if the endpoint needs one   (MOLT_API_KEY)
                     /login stores keys in ~/.config/molt/auth.json (0600)
  --price-in <n>     USD per 1M prompt tokens      (MOLT_PRICE_IN)
  --price-out <n>    USD per 1M completion tokens  (MOLT_PRICE_OUT)
                     omit both and molt reads the price from the provider
  --verbose          show every call, argument, and result (press v in the TUI)
  --provider <name>  label shown in the status line
  --cwd <dir>        project directory (default: current)
  --budget <n>       hard token ceiling for the session
  --auto-shed <n>    shed once history exceeds n tokens (default 60000, 0 off)
  --attempts <n>     completion attempts before molt reports failure (default 4)
  --autonomy <level> low | medium | high — how much runs without asking
                     low asks about every command and write (default)
                     medium runs reads, read-only commands, project writes
                     high runs everything except what cannot be undone
  --yes              auto-approve every tool call (same as --autonomy high)
  --json             machine-readable output (run/prove/stats/receipts)
  --version          print the version and exit
  --no-stream        disable token streaming (default: streaming on)
  --only <tags>      run only checks with these tags (comma separated)
  --skip <tags>      skip checks with these tags
  --grep <pattern>   filter receipts or archive entries
  --session <id>     which session log to read (default: most recent)
  --raw              print the log as raw JSONL rather than a summary
  --show <id>        print one receipt file or exuvia index

molt reads .molt/done.yml for what "done" means in this project.
Without it, completions are unverified and molt will say so.`;

type Args = {
  cmd: string;
  task?: string;
  url: string;
  model: string;
  key?: string;
  provider?: string;
  priceIn?: number;
  priceOut?: number;
  priceCachedIn?: number;
  priceSource?: string;
  cwd: string;
  verbose: boolean;
  budget?: number;
  autoShed?: number;
  attempts?: number;
  autonomy?: Autonomy;
  only?: string[];
  skip?: string[];
  grep?: string;
  show?: string;
  repair?: boolean;
  explain: boolean;
  session?: string;
  raw: boolean;
  stream: boolean;
  yes: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
};

/** Parse a price, rejecting junk rather than letting NaN reach the meter. */
function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * A number a flag can actually mean, or an error naming the flag.
 *
 * `--budget`, `--auto-shed` and `--attempts` already refused NaN. They still
 * took `0` and `1.5`: `--attempts 0` let the first failed bar exhaust
 * immediately, and `--budget 0` parsed as zero and was then read back as
 * "no budget set", so the flag did the opposite of what it said.
 */
function positiveInt(flag: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} needs a whole number of 1 or more, got "${raw ?? ""}"`);
  }
  return n;
}

function positiveNum(flag: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} needs a positive number, got "${raw ?? ""}"`);
  }
  return n;
}

/**
 * `stored` carries whatever /login and /model last settled on. It is passed
 * in rather than read here so this stays a pure function of argv and env:
 * precedence is explicit flag → env var → stored endpoint → fallback.
 *
 * There is deliberately no default model. molt showed `qwen2.5-coder:7b` on
 * a local endpoint whether or not anything was running there — a claim it
 * had not checked, in a status line whose job is to be trustworthy.
 */
export function parseArgs(argv: string[], stored: StoredEndpoint = {}): Args {
  const out: Args = {
    cmd: "",
    url: process.env.MOLT_BASE_URL ?? stored.baseUrl ?? "http://localhost:11434/v1",
    model: process.env.MOLT_MODEL ?? stored.model ?? "",
    key: process.env.MOLT_API_KEY ?? stored.apiKey,
    priceIn: num(process.env.MOLT_PRICE_IN),
    priceOut: num(process.env.MOLT_PRICE_OUT),
    cwd: process.cwd(),
    explain: false,
    raw: false,
    stream: true,
    verbose: false,
    yes: false,
    json: false,
    help: false,
    version: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    /**
     * The value belonging to `a`, or an error naming what is missing.
     *
     * `next()` used to hand back whatever came after, including the next flag
     * and including nothing at all. `--model --yes` set the model to "--yes"
     * and dropped `--yes` on the floor, and that request went to a real
     * endpoint and came back 404. Others turned into `undefined` and either
     * vanished silently or surfaced as a Node type error from deep inside
     * `resolve()`, which names neither the flag nor the mistake.
     */
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      // A value that is itself a flag is a forgotten value, not a value. Only
      // `--` is treated this way: a lone `-` can legitimately start one.
      if (v.startsWith("--")) throw new Error(`${a} needs a value, but got the flag "${v}"`);
      return v;
    };
    switch (a) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--version":
        out.version = true;
        break;
      case "--url":
        out.url = next();
        break;
      case "--model":
        out.model = next();
        break;
      case "--key":
        out.key = next();
        break;
      case "--provider":
        out.provider = next();
        break;
      case "--price-in":
        // Was silently ignored when it did not parse, so a typo left the meter
        // quoting the previous model's rate.
        out.priceIn = positiveNum("--price-in", next());
        break;
      case "--price-out":
        out.priceOut = positiveNum("--price-out", next());
        break;
      case "--cwd":
        out.cwd = resolve(next());
        break;
      case "--budget":
        out.budget = positiveInt("--budget", next());
        break;
      case "--auto-shed":
        out.autoShed = positiveInt("--auto-shed", next());
        break;
      case "--attempts":
        out.attempts = positiveInt("--attempts", next());
        break;
      case "--only":
        out.only = next().split(",").map((t) => t.trim()).filter(Boolean);
        break;
      case "--skip":
        out.skip = next().split(",").map((t) => t.trim()).filter(Boolean);
        break;
      case "--grep":
        out.grep = next();
        break;
      case "--show":
        out.show = next();
        break;
      case "--repair":
        out.repair = true;
        break;
      case "--explain":
        out.explain = true;
        break;
      case "--session":
        out.session = next();
        break;
      case "--raw":
        out.raw = true;
        break;
      case "--no-stream":
        out.stream = false;
        break;
      case "--verbose":
      case "-v":
        out.verbose = true;
        break;
      case "--autonomy": {
        const level = next();
        if (!isAutonomy(level)) throw new Error(`--autonomy takes low, medium, or high`);
        out.autonomy = level;
        break;
      }
      case "--yes":
      case "-y":
        out.yes = true;
        break;
      case "--json":
        out.json = true;
        break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
        positional.push(a);
    }
  }

  out.cmd = positional[0] ?? "";
  out.task = positional.slice(1).join(" ") || undefined;

  // Prices come last, because a stored price belongs to the model it was
  // fetched for and the model is not final until every flag has been read.
  // Applying yesterday's rate to today's model bills the session at a number
  // nothing checked — which is the failure the whole meter exists to avoid.
  const byHand = out.priceIn !== undefined || out.priceOut !== undefined;
  const priceable = stored.priceModel === undefined || stored.priceModel === out.model;
  out.priceIn ??= priceable ? stored.priceIn : undefined;
  out.priceOut ??= priceable ? stored.priceOut : undefined;
  if (out.priceIn !== undefined && out.priceOut !== undefined) {
    out.priceCachedIn = byHand ? undefined : priceable ? stored.priceCachedIn : undefined;
    out.priceSource = byHand ? "set by hand" : "stored";
  }
  return out;
}

/**
 * `session` says whether this invocation is a session worth journalling.
 *
 * It used to always be. `prove`, `doctor`, `archive --explain` and `verify`
 * each opened a log and wrote a `session_start` into it, so this project
 * accumulated 68 logs of which 54 held that one line and nothing else — and
 * `molt verify` then walked all of them. The journal answers "what did this
 * thing do?", and a doctor invocation did not do a session.
 */
function buildEngine(args: Args, session = false): Engine {
  let bar = null;
  try {
    bar = loadBar(args.cwd);
  } catch (e) {
    if (e instanceof BarError) {
      process.stderr.write(`molt: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
  if (bar && (args.only?.length || args.skip?.length)) {
    bar = selectChecks(bar, { only: args.only, skip: args.skip });
    if (bar.checks.length === 0) {
      process.stderr.write("molt: tag selection left no checks — refusing to run an empty bar\n");
      process.exit(2);
    }
  }
  const journal = session ? new Journal(args.cwd) : undefined;
  journal?.append("session_start", {
    sessionId: journal.sessionId,
    molt: VERSION,
    build: buildStamp(),
    provider: args.provider ?? providerName(args.url),
    model: args.model,
    endpoint: args.url,
    cwd: args.cwd,
    bar: bar ? `${bar.checks.length} check(s)` : "none — completions unverified",
    checks: bar?.checks.map((c) => c.name) ?? [],
    stream: args.stream,
  });

  return new Engine({
    journal,
    baseUrl: args.url,
    apiKey: args.key,
    model: args.model,
    provider: args.provider ?? providerName(args.url),
    priceInPerMtok: args.priceIn,
    priceOutPerMtok: args.priceOut,
    priceCachedInPerMtok: args.priceCachedIn,
    priceSource: args.priceSource,
    cwd: args.cwd,
    bar,
    archive: new Archive(args.cwd),
    receipts: new Receipts(args.cwd),
    maxProofAttempts: args.attempts,
    autoShedAtTokens: args.autoShed,
    stream: args.stream,
    // --yes predates autonomy and means the same thing as its top level.
    autonomy: args.yes ? "high" : args.autonomy,
  });
}

/**
 * Give the engine a price for the model it is about to use.
 *
 * Hand-set prices win — they are the escape hatch for endpoints that
 * publish nothing, and for accounts whose negotiated rate is not the list
 * price. Otherwise molt asks the endpoint doing the billing, and if it says
 * nothing, no cost is shown at all.
 */
async function priceEngine(engine: Engine, args: Args): Promise<void> {
  if (!needsPriceLookup(args.model, engine.pricing(), storedEndpoint())) return;
  const p = await fetchPricing(args.url, args.model, args.key);
  if (!p) {
    // Nothing published. A price only stands if it was recorded for THIS
    // model; inheriting the last one is how a Claude session gets billed at
    // grok's rates.
    if (storedEndpoint().priceModel !== args.model) engine.setPricing({});
    return;
  }
  engine.setPricing({ in: p.in, out: p.out, cached: p.cached, source: p.source });
  savePricing(args.model, p);
}

/**
 * `from` decides which explanation a work-landed failure gets.
 *
 * There are two true answers and they are not interchangeable. Under `prove`
 * there is no session, so the check fails by definition and the reader needs
 * to be told to stop worrying. Under `run` there *was* a session and it really
 * did not write anything, which usually means the task was a question — and
 * telling that reader about `molt prove` sends them to debug a command they
 * did not run. This printer was context-blind and always said the second.
 */
function printBar(result: BarResult, from: "run" | "prove"): void {
  const passed = result.results.filter((r) => r.ok).length;
  process.stdout.write(
    `${passed} of ${result.results.length} checks passed · ${fmtDuration(result.durationMs)}\n`,
  );
  for (const r of result.results) {
    const tags = r.tags?.length ? `  [${r.tags.join(",")}]` : "";
    const label = r.ok ? "pass" : r.advisory ? "warn" : "FAIL";
    const evidence = r.ok ? r.output.trim().split("\n")[0] ?? "" : "";
    process.stdout.write(
      `${label}  ${r.name}${r.exitCode !== undefined ? ` (exit ${r.exitCode})` : ""}${tags}` +
        `${r.cached ? "  [reused]" : ""}${evidence ? `  —  ${evidence}` : ""}\n`,
    );
    if (!r.ok) {
      for (const line of r.output.trim().split("\n")) process.stdout.write(`      ${line}\n`);
    }
  }
  const warned = result.warnings ?? [];
  process.stdout.write(
    (result.ok ? "\nbar met" : "\nbar NOT met") +
      (warned.length ? ` · ${warned.length} advisory check(s) failed` : "") +
      "\n",
  );

  // A check's output speaks to the model; a person staring at a refusal they
  // cannot act on needs the other half.
  const onlyWorkLanded =
    !result.ok &&
    result.results.every((r) => r.ok || r.detail === "files-changed") &&
    result.results.some((r) => !r.ok && r.detail === "files-changed");
  if (onlyWorkLanded) {
    process.stdout.write(
      from === "prove"
        ? "\nwork-landed requires a file to have changed in this session. `molt prove` runs\n" +
            "standalone, so there is no session and no write for it to find — it fails here by\n" +
            "definition, not because anything is wrong. Run `molt prove --skip session` to check\n" +
            "the command checks on their own.\n"
        : "\neverything else passed. work-landed requires this turn to have changed a file, so a\n" +
            "question, a lookup, or an explanation can never satisfy it — and molt would rather\n" +
            "refuse an honest answer than accept an invented file edit.\n" +
            'ask questions with `molt ask "<question>"`, which runs the rest of the bar and drops\n' +
            "that one check for the turn. For a whole run of questions, add --skip session.\n",
    );
  }
}

async function cmdRun(args: Args, ask = false): Promise<number> {
  if (!args.task) {
    process.stderr.write(
      ask
        ? 'molt: ask needs a question, e.g. molt ask "what does the bar check?"\n'
        : 'molt: run needs a task, e.g. molt run "fix the failing test"\n',
    );
    return 2;
  }
  // The TUI refuses this at the prompt; headless has to refuse it too, or a
  // CI run fires a request with an empty model and fails inside the provider.
  if (!args.model) {
    process.stderr.write(
      "molt: no model selected — pass --model <id>, set MOLT_MODEL, or run molt and use /login\n",
    );
    return 2;
  }
  const engine = buildEngine(args, true);
  if (args.budget) engine.setBudget(args.budget);
  await priceEngine(engine, args);

  let failed = false;
  let sawAnswer = false;
  // Streamed text arrives without a trailing newline, so anything printed
  // after it lands on the same line as the model's last word. Track it and
  // break the line before saying anything of molt's own.
  let midLine = false;

  const emit = (ev: EngineEvent) => {
    if (args.json) {
      process.stdout.write(JSON.stringify(ev) + "\n");
      return;
    }
    if (ev.kind !== "delta" && midLine) {
      process.stdout.write("\n");
      midLine = false;
    }
    switch (ev.kind) {
      case "delta":
        process.stdout.write(ev.text);
        midLine = !ev.text.endsWith("\n");
        break;
      case "message_end":
        // Handled by the midLine break above; the case is here so a streamed
        // step does not fall through to a default that prints something.
        break;
      case "cancelled":
        process.stderr.write(
          ev.filesWritten?.length
            ? `\nmolt: cancelled — conversation rolled back, but these files were already ` +
              `written and remain on disk: ${ev.filesWritten.join(", ")}\n`
            : "\nmolt: cancelled — nothing was written, and the conversation is rolled back\n",
        );
        break;
      case "assistant_text":
        // A streamed answer was already written by the deltas; printing it
        // again here is what emitted the whole final answer twice. The event
        // still counts as the answer for the exit code below.
        if (!ev.streamed) process.stdout.write(`\n${ev.text}\n`);
        break;
      case "tool": {
        const took = ev.durationMs === undefined ? "" : `  ${fmtDuration(ev.durationMs)}`;
        process.stdout.write(`· ${ev.name}  ${ev.detail}${ev.note ? `  [${ev.note}]` : ""}${took}\n`);
        if (args.verbose) {
          if (ev.args && ev.args !== "{}") {
            process.stdout.write(`      args ${ev.args.replace(/\s+/g, " ")}\n`);
          }
          if (ev.bytes !== undefined) process.stdout.write(`      → ${ev.bytes} bytes\n`);
          for (const l of (ev.preview ?? "").split("\n")) {
            if (l.trim()) process.stdout.write(`      │ ${l}\n`);
          }
        }
        break;
      }
      case "job_end": {
        // What that one task cost, said once, next to what it produced. The
        // session total still follows at the end; this is the per-job view of
        // the same books.
        const sp = ev.spend;
        const cached = sp.cachedTokens > 0 ? ` (${sp.cachedTokens} cached)` : "";
        process.stdout.write(
          `· job ${ev.outcome} · ${ev.steps} step(s) · ${sp.promptTokens} in${cached} · ` +
            `${sp.completionTokens} out · ${fmtDuration(ev.durationMs)}` +
            (sp.costUsd === undefined ? "" : ` · ${sp.estimated ? "~" : ""}${fmtCost(sp.costUsd)}`) +
            "\n",
        );
        break;
      }
      case "request":
        if (args.verbose) {
          process.stdout.write(
            `→ step ${ev.step + 1} · ${ev.messages} messages · ~${ev.estTokens} tokens → ${ev.model}\n`,
          );
        }
        break;
      case "step_summary": {
        // Printed always, not only under --verbose: a CI log that records
        // what a run cost, step by step, is the difference between a bill
        // you can audit and one you can only pay.
        const sp = ev.spend;
        const cached = sp.cachedTokens > 0 ? ` (${sp.cachedTokens} cached)` : "";
        const did = ev.outcome === "claim" ? "claims done" : ev.tools.join(", ") || "no tools";
        const spent =
          sp.costUsd === undefined ? "" : ` · ${sp.estimated ? "~" : ""}${fmtCost(sp.costUsd)}`;
        process.stdout.write(
          `· step ${ev.step + 1} · ${did} · ${sp.promptTokens} in${cached} · ` +
            `${sp.completionTokens} out · ${fmtDuration(ev.durationMs)}${spent}` +
            (sp.estimated ? " · tokens estimated" : "") + "\n",
        );
        break;
      }
      case "proof_start":
        process.stdout.write(
          `\nchecking ${ev.checks} condition(s) from .molt/done.yml: ${ev.names.join(", ")}\n`,
        );
        break;
      case "proof_refused":
        process.stdout.write(`completion refused (attempt ${ev.attempt})\n`);
        printBar(ev.result, "run");
        break;
      case "proof_result":
        printBar(ev.result, "run");
        break;
      case "proof_exhausted":
        process.stdout.write(`bar not met after ${ev.attempts} attempts\n`);
        printBar(ev.result, "run");
        break;
      case "shed":
        process.stdout.write(`· shed ${ev.dropped} msgs ${ev.before}→${ev.after} tok → ${ev.path}\n`);
        break;
      case "receipt":
        process.stdout.write(`· receipt ${ev.path}\n`);
        break;
      case "info":
        process.stdout.write(`· ${ev.text}\n`);
        break;
      case "error":
        process.stderr.write(`molt: ${ev.text}\n`);
        break;
    }
  };

  // Nobody is watching a headless run, so a call that would prompt is
  // refused rather than waited on. Autonomy decides which calls those are:
  // the engine only asks about what the level does not cover.
  const confirm = async (name: string, detail: string) => {
    process.stderr.write(
      `molt: refusing ${name} (${detail}) — raise --autonomy, or pass --yes, for headless work\n`,
    );
    return false;
  };

  for await (const ev of engine.run(args.task, confirm, { ask })) {
    emit(ev);
    if (ev.kind === "proof_exhausted" || ev.kind === "error") failed = true;
    if (ev.kind === "assistant_text") sawAnswer = true;
  }

  // What the run cost, said once at the end, in the same terms the step
  // lines used. `~` means the token counts were molt's estimate because the
  // provider reported none.
  const b = engine.bom();
  if (b.sessionPromptTokens + b.sessionCompletionTokens > 0) {
    // The context size next to the cumulative total, because "844k in" reads
    // as 844k of reading when it is one conversation resent thirty times.
    process.stdout.write(
      `\n${b.sessionPromptTokens} in` +
        (b.sessionCachedTokens > 0 ? ` (${b.sessionCachedTokens} cached)` : " (0 cached)") +
        ` · ${b.requestTotalEst} of context` +
        ` · ${b.sessionCompletionTokens} out` +
        (b.costUsd === undefined
          ? " · no price for this model"
          : ` · ${b.costEstimated ? "~" : ""}${fmtCost(b.costUsd)}`) +
        "\n",
    );
  }

  // An unverified answer is not a success. Neither is no answer at all.
  if (failed) return 1;
  if (!sawAnswer) return 1;
  return 0;
}

async function cmdProve(args: Args): Promise<number> {
  if (!hasBar(args.cwd)) {
    process.stderr.write("molt: no .molt/done.yml here. run `molt init` first.\n");
    return 2;
  }
  const engine = buildEngine(args);
  const result = await engine.proveNow();
  if (!result) return 2;
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    printBar(result, "prove");
  }
  return result.ok ? 0 : 1;
}

function cmdInit(args: Args): number {
  const { path, detected, existed } = writeDefaultBar(args.cwd);
  if (existed) {
    process.stdout.write(`molt: ${path} already exists, left alone\n`);
    return 0;
  }
  process.stdout.write(`molt: wrote ${path}\n\n`);
  if (detected.length === 0) {
    process.stdout.write(
      "molt found no build or test commands in this project, so the bar only proves\n" +
        "that work landed. Add your own commands — that is where a bar gets its value.\n",
    );
    return 0;
  }
  // Say what was read and from where. A generated file nobody can explain is
  // a file people delete the first time it fails.
  process.stdout.write("read out of this project:\n");
  for (const c of detected) {
    process.stdout.write(`  ${c.name.padEnd(8)} ${c.run.padEnd(28)} ${c.because}\n`);
  }
  process.stdout.write("\nCheck it over — it is your file, and molt only wrote a first draft.\n");
  return 0;
}

async function cmdDoctor(args: Args): Promise<number> {
  const engine = buildEngine(args);
  const d = await engine.doctor();
  process.stdout.write(`endpoint: ${args.url}\n`);
  process.stdout.write(`model:    ${args.model}\n`);
  process.stdout.write(`bar:      ${hasBar(args.cwd) ? ".molt/done.yml" : "MISSING — completions unverified"}\n`);
  process.stdout.write(`${d.ok ? "ok" : "FAIL"}: ${d.detail}\n`);
  return d.ok && hasBar(args.cwd) ? 0 : 1;
}

function cmdReceipts(args: Args): number {
  const receipts = new Receipts(args.cwd);

  if (args.repair) {
    const report = receipts.repair();
    if (args.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(
      `${report.marked} marked missing (file gone; row kept as evidence)\n` +
        `${report.kept} left alone (file exists)\n` +
        `${report.alreadyMissing} already marked missing\n`,
    );
    process.stdout.write(
      report.marked === 0
        ? "\nNothing changed. Safe to run again.\n"
        : "\nGhost rows are marked, not deleted — the record of a receipt is itself evidence.\n" +
            "Run again is a no-op. Repair does not rewrite receipt files or renumber anything.\n",
    );
    return 0;
  }

  if (args.show) {
    const file = receipts.list().find((f) => f === args.show || f.startsWith(args.show!));
    if (!file) {
      // The listing reads the index and `--show` reads the directory, so a
      // receipt whose file is gone was printed by one and denied by the other:
      // "no match" for something you were just shown. Say which of the two it
      // is — a missing file is a different problem from a wrong name, and only
      // one of them is the reader's mistake.
      const indexed = receipts
        .records()
        .find((r) => r.file === args.show || String(r.file ?? "").startsWith(args.show!));
      if (indexed) {
        process.stderr.write(
          `molt: "${indexed.file}" is in the receipts index but its file is missing from ` +
            `${join(args.cwd, ".molt", "receipts")}. The record of it survives; the receipt ` +
            `itself does not.\n`,
        );
        return 2;
      }
      process.stderr.write(`molt: no receipt matching "${args.show}"\n`);
      return 2;
    }
    process.stdout.write(receipts.read(file));
    return 0;
  }

  if (args.grep) {
    const hits = receipts.grep(args.grep);
    if (hits.length === 0) {
      process.stdout.write(`no receipt mentions /${args.grep}/\n`);
      return 1;
    }
    for (const h of hits) {
      process.stdout.write(`\n── ${h.file}\n${h.excerpt}\n`);
    }
    return 0;
  }

  const rows = receipts.records();
  if (args.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write("no completion attempts recorded yet\n");
    return 0;
  }
  const onDisk = new Set(receipts.list());
  for (const r of rows) {
    const failed = r.failed.length ? `  failed: ${r.failed.join(", ")}` : "";
    const gone = onDisk.has(r.file) ? "" : "  MISSING";
    process.stdout.write(
      `${r.file}  ${r.verdict.padEnd(9)} attempt ${r.attempt}  ${r.model}  ${r.sessionTokens} tok${failed}${gone}\n`,
    );
  }
  return 0;
}

function cmdArchive(args: Args): number {
  const archive = new Archive(args.cwd);

  if (args.explain) {
    const engine = buildEngine(args);
    const plan = engine.explainShed();
    if (!plan) {
      process.stdout.write("nothing worth shedding in a fresh session\n");
      return 0;
    }
    process.stdout.write(
      `would shed ${plan.droppedCount} messages · ${plan.beforeTokens} → ${plan.afterTokens} tokens\n\n` +
        `── what stays in context (the digest) ──\n${plan.digest}\n\n` +
        `── what is preserved on disk (the exuvia) ──\n${plan.exuvia}\n`,
    );
    return 0;
  }

  if (args.show !== undefined) {
    const n = Number(args.show);
    if (!Number.isInteger(n)) {
      process.stderr.write("molt: --show takes an exuvia index, e.g. --show 0\n");
      return 2;
    }
    try {
      process.stdout.write(archive.read(n));
      return 0;
    } catch (e) {
      process.stderr.write(`molt: ${String(e)}\n`);
      return 2;
    }
  }

  if (args.grep) {
    const hits = archive.grep(args.grep);
    if (hits.length === 0) {
      process.stdout.write(`nothing in the archive matches /${args.grep}/\n`);
      return 1;
    }
    for (const h of hits) {
      process.stdout.write(`\n── exuvia ${h.index}\n${h.excerpt}\n`);
    }
    return 0;
  }

  const entries = archive.list();
  if (args.json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write("no context has been shed in this project yet\n");
    return 0;
  }
  for (const e of entries) {
    process.stdout.write(
      `${String(e.index).padStart(4, "0")}  ${e.messages} msgs  ${e.bytes} bytes  ${e.sha256.slice(0, 12)}  ${e.file}\n`,
    );
  }
  return 0;
}

function cmdStats(args: Args): number {
  const s = new Receipts(args.cwd).stats();
  if (args.json) {
    process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    return 0;
  }
  if (s.attempts === 0) {
    process.stdout.write("no completion attempts recorded yet\n");
    return 0;
  }
  const missing = s.attempts - s.present;
  const rate =
    s.present === 0
      ? "—  (no receipts left on disk to check)"
      : `${(s.falseClaimRate * 100).toFixed(1)}%  ` +
        `(share of on-disk claims that did not survive the bar` +
        (missing === 0 ? ")" : `; ${missing} recorded attempt(s) have no file)`);
  process.stdout.write(
    `completion attempts     ${s.attempts} recorded\n` +
      `  still on disk         ${s.present}\n` +
      `  accepted              ${s.accepted}\n` +
      `  refused               ${s.refused}\n` +
      `  exhausted             ${s.exhausted}\n\n` +
      `false-claim rate        ${rate}\n` +
      `tokens per verified change  ${s.tokensPerVerifiedChange ?? "—"}\n` +
      `cost per verified change    ${s.usdPerVerifiedChange === undefined ? "—" : `$${s.usdPerVerifiedChange.toFixed(4)}`}\n\n`,
  );
  for (const [model, m] of Object.entries(s.byModel)) {
    process.stdout.write(`  ${model}: ${m.accepted} accepted / ${m.attempts} attempts\n`);
  }
  process.stdout.write(
    "\nNote: the denominator is verified changes, not claims. A harness that\n" +
      "accepts a false claim on turn one spends fewer tokens per claim and\n" +
      "produces a change you cannot trust. false-claim rate is a property of\n" +
      "the model as much as the harness — compare only at matched models.\n",
  );
  return 0;
}

/**
 * The log to read, or why there isn't one.
 *
 * "No logs at all" and "no log by that name" used to collapse into the same
 * null, so `molt log --session nosuch` reported "no session log in this
 * project yet" — with 68 of them on disk — and exited 0. A lookup that misses
 * is not the same fact as an empty project, and neither is a success.
 */
function resolveSession(args: Args): { file: string } | { miss: "empty" | "unknown"; count: number } {
  const files = Journal.sessions(args.cwd);
  if (files.length === 0) return { miss: "empty", count: 0 };
  const pick = args.session
    ? files.find((f) => f.startsWith(args.session!))
    : files[files.length - 1];
  if (!pick) return { miss: "unknown", count: files.length };
  return { file: join(args.cwd, ".molt", "log", pick) };
}

function cmdLog(args: Args): number {
  const found = resolveSession(args);
  if ("miss" in found) {
    if (found.miss === "empty") {
      process.stdout.write("no session log in this project yet\n");
      return 0;
    }
    process.stderr.write(
      `molt: no session log starting "${args.session}" — ${found.count} session(s) in ` +
        `${join(args.cwd, ".molt", "log")}. \`molt log\` alone reads the most recent.\n`,
    );
    return 2;
  }
  const { file } = found;
  const entries = Journal.read(file);
  if (args.json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
    return 0;
  }
  if (args.raw) {
    for (const e of entries) process.stdout.write(JSON.stringify(e) + "\n");
    return 0;
  }

  const check = Journal.verify(file);
  process.stdout.write(`${file}\n${entries.length} entries · chain ${check.ok ? "intact" : "BROKEN"}\n\n`);
  for (const line of Journal.summarize(entries)) process.stdout.write(line + "\n");
  process.stdout.write(
    "\nEvery line above is recomputed from the log, not narrated. Values marked ~ are\n" +
      "estimates (chars/4) because the provider did not report usage; everything else\n" +
      "is measured. `molt verify` recomputes the hash chain. `--raw` prints the JSONL.\n",
  );
  return check.ok ? 0 : 1;
}

function cmdVerify(args: Args): number {
  const files = Journal.sessions(args.cwd);
  if (files.length === 0) {
    process.stdout.write("no session logs to verify\n");
    return 0;
  }
  let bad = 0;
  for (const f of files) {
    const path = join(args.cwd, ".molt", "log", f);
    const r = Journal.verify(path);
    process.stdout.write(
      `${r.ok ? "ok  " : "FAIL"}  ${f}  ${r.entries} entries${r.ok ? "" : `\n      ${r.reason}`}\n`,
    );
    if (!r.ok) bad++;
  }
  process.stdout.write(
    bad === 0
      ? `\n${files.length} log(s) verified. Each entry hashes its predecessor, so any\nalteration or deletion breaks the chain from that point on.\n`
      : `\n${bad} log(s) failed verification.\n`,
  );
  process.stdout.write(
    "\nThis is tamper EVIDENCE, not tamper prevention: anyone with write access can\nrewrite a log and re-chain it. What it rules out is a silent edit.\n",
  );
  return bad === 0 ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv, storedEndpoint());
  } catch (e) {
    process.stderr.write(`molt: ${(e as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (args.version) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (!existsSync(args.cwd)) {
    process.stderr.write(`molt: no such directory: ${args.cwd}\n`);
    return 2;
  }

  switch (args.cmd) {
    case "run":
      return cmdRun(args);
    case "ask":
      return cmdRun(args, true);
    case "prove":
      return await cmdProve(args);
    case "init":
      return cmdInit(args);
    case "doctor":
      return cmdDoctor(args);
    case "receipts":
      return cmdReceipts(args);
    case "archive":
      return cmdArchive(args);
    case "stats":
      return cmdStats(args);
    case "log":
      return cmdLog(args);
    case "verify":
      return cmdVerify(args);
    case "":
      break;
    default:
      process.stderr.write(`molt: unknown command "${args.cmd}"\n\n${USAGE}\n`);
      return 2;
  }

  if (!process.stdout.isTTY) {
    process.stderr.write('molt: not a terminal. use `molt run "<task>"` for headless work.\n');
    return 2;
  }

  const engine = buildEngine(args);
  if (args.budget) engine.setBudget(args.budget);

  // Ink and React are loaded only here. Importing them at module top made
  // `molt prove` pay ~450ms of startup for a UI it never renders, which
  // matters because the bar wants to live in CI and in git hooks.
  const { renderApp } = await import("./app.js");
  // renderApp, not render(<App/>), because the mount options are part of the
  // behaviour: Ink exits on ctrl+C unless told not to, which made "ctrl+C
  // cancels the turn" dead code and killed molt outright, mid-request and
  // half-typed line and all.
  const { waitUntilExit } = renderApp({
    engine,
    version: VERSION,
    autoShed: args.autoShed,
    verbose: args.verbose,
  });
  await waitUntilExit();
  return 0;
}

const invokedDirectly =
  process.argv[1] && (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("molt"));

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`molt: ${String(e)}\n`);
      process.exit(1);
    },
  );
}
