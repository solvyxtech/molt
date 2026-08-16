#!/usr/bin/env node
/**
 * molt's command line.
 *
 * The interactive TUI is the default, but every capability is also
 * reachable headlessly — `molt run` and `molt prove` exit non-zero when the
 * bar is not met, so molt can sit in CI, in a script, or in a benchmark
 * harness without a human watching.
 */
import { render } from "ink";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Archive } from "./archive.js";
import { App } from "./app.js";
import { fmtDuration } from "./banner.js";
import { BarError, hasBar, loadBar, selectChecks, writeDefaultBar } from "./bar.js";
import { Engine } from "./engine.js";
import { providerName, storedEndpoint, type StoredEndpoint } from "./providers.js";
import { Receipts } from "./receipts.js";
import type { BarResult, EngineEvent } from "./types.js";

const VERSION = "v0.9.0";

const USAGE = `molt ${VERSION} — a coding agent that can't say "done" without proving it.

usage
  molt                      interactive session
  molt run "<task>"         headless; exits non-zero if the bar is not met
  molt prove                run .molt/done.yml now and exit
  molt init                 write a starter .molt/done.yml
  molt doctor               check the endpoint and model

  molt receipts             list completion attempts (--grep, --show <file>)
  molt archive              list shed batches (--grep, --show <n>, --explain)
  molt stats                false-claim rate and tokens per verified change
  molt --help

first run
  molt → /login (pick a provider, paste the key) → /model (pick one) → go
  the choice is remembered, so later runs start where you left off

options
  --url <base>       OpenAI-compatible base URL   (MOLT_BASE_URL)
                     default http://localhost:11434/v1
  --model <id>       model id                     (MOLT_MODEL)
                     no default — /model or --model picks one
  --key <secret>     api key, if the endpoint needs one   (MOLT_API_KEY)
                     /login stores keys in ~/.config/molt/auth.json (0600)
  --provider <name>  label shown in the status line
  --price-in <n>     USD per 1M prompt tokens      (MOLT_PRICE_IN)
  --price-out <n>    USD per 1M completion tokens  (MOLT_PRICE_OUT)
                     also read from ~/.config/molt/config.json
  --cwd <dir>        project directory (default: current)
  --budget <n>       hard token ceiling for the session
  --auto-shed <n>    shed once history exceeds n tokens
  --attempts <n>     completion attempts before molt reports failure (default 4)
  --yes              auto-approve tool calls (use in sandboxes only)
  --json             machine-readable output (run/prove/stats/receipts)
  --no-stream        disable token streaming (default: streaming on)
  --only <tags>      run only checks with these tags (comma separated)
  --skip <tags>      skip checks with these tags
  --grep <pattern>   filter receipts or archive entries
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
  cwd: string;
  budget?: number;
  autoShed?: number;
  attempts?: number;
  only?: string[];
  skip?: string[];
  grep?: string;
  show?: string;
  explain: boolean;
  stream: boolean;
  yes: boolean;
  json: boolean;
  help: boolean;
};

/** Parse a price, rejecting junk rather than letting NaN reach the meter. */
function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
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
    priceIn: num(process.env.MOLT_PRICE_IN) ?? stored.priceIn,
    priceOut: num(process.env.MOLT_PRICE_OUT) ?? stored.priceOut,
    cwd: process.cwd(),
    explain: false,
    stream: true,
    yes: false,
    json: false,
    help: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--help":
      case "-h":
        out.help = true;
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
        out.priceIn = num(next());
        break;
      case "--price-out":
        out.priceOut = num(next());
        break;
      case "--cwd":
        out.cwd = resolve(next());
        break;
      case "--budget":
        out.budget = Number(next());
        break;
      case "--auto-shed":
        out.autoShed = Number(next());
        break;
      case "--attempts":
        out.attempts = Number(next());
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
      case "--explain":
        out.explain = true;
        break;
      case "--no-stream":
        out.stream = false;
        break;
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
  return out;
}

function buildEngine(args: Args): Engine {
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
  return new Engine({
    baseUrl: args.url,
    apiKey: args.key,
    model: args.model,
    provider: args.provider ?? providerName(args.url),
    priceInPerMtok: args.priceIn,
    priceOutPerMtok: args.priceOut,
    cwd: args.cwd,
    bar,
    archive: new Archive(args.cwd),
    receipts: new Receipts(args.cwd),
    maxProofAttempts: args.attempts,
    autoShedAtTokens: args.autoShed,
    stream: args.stream,
  });
}

function printBar(result: BarResult): void {
  for (const r of result.results) {
    const tags = r.tags?.length ? `  [${r.tags.join(",")}]` : "";
    process.stdout.write(
      `${r.ok ? "pass" : "FAIL"}  ${r.name}${r.exitCode !== undefined ? ` (exit ${r.exitCode})` : ""}${tags}\n`,
    );
    if (!r.ok) {
      for (const line of r.output.trim().split("\n")) process.stdout.write(`      ${line}\n`);
    }
  }
  process.stdout.write(result.ok ? "\nbar met\n" : "\nbar NOT met\n");

  // Same reasoning as the TUI: the check output speaks to the model, and a
  // person staring at a refusal they cannot act on needs the other half.
  const onlyWorkLanded =
    !result.ok &&
    result.results.every((r) => r.ok || r.detail === "files-changed") &&
    result.results.some((r) => !r.ok && r.detail === "files-changed");
  if (onlyWorkLanded) {
    process.stdout.write(
      "\nwork-landed requires a file to have changed in this session. `molt prove` runs\n" +
        "standalone, so there is no session and no write for it to find — it fails here by\n" +
        "definition, not because anything is wrong. Run `molt prove --skip session` to check\n" +
        "the command checks on their own.\n",
    );
  }
}

async function cmdRun(args: Args): Promise<number> {
  if (!args.task) {
    process.stderr.write('molt: run needs a task, e.g. molt run "fix the failing test"\n');
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
  const engine = buildEngine(args);
  if (args.budget) engine.setBudget(args.budget);

  let failed = false;
  let sawAnswer = false;

  const emit = (ev: EngineEvent) => {
    if (args.json) {
      process.stdout.write(JSON.stringify(ev) + "\n");
      return;
    }
    switch (ev.kind) {
      case "delta":
        process.stdout.write(ev.text);
        break;
      case "cancelled":
        process.stderr.write("\nmolt: cancelled — the session is unchanged\n");
        break;
      case "assistant_text":
        process.stdout.write(`\n${ev.text}\n`);
        break;
      case "tool": {
        const took = ev.durationMs === undefined ? "" : `  ${fmtDuration(ev.durationMs)}`;
        process.stdout.write(`· ${ev.name}  ${ev.detail}${ev.note ? `  [${ev.note}]` : ""}${took}\n`);
        break;
      }
      case "proof_start":
        process.stdout.write(`\nchecking ${ev.checks} condition(s) from .molt/done.yml\n`);
        break;
      case "proof_refused":
        process.stdout.write(`completion refused (attempt ${ev.attempt})\n`);
        printBar(ev.result);
        break;
      case "proof_result":
        printBar(ev.result);
        break;
      case "proof_exhausted":
        process.stdout.write(`bar not met after ${ev.attempts} attempts\n`);
        printBar(ev.result);
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

  const confirm = async (name: string, detail: string) => {
    if (args.yes) return true;
    process.stderr.write(
      `molt: refusing ${name} (${detail}) — headless runs need --yes to act on the filesystem\n`,
    );
    return false;
  };

  for await (const ev of engine.run(args.task, confirm)) {
    emit(ev);
    if (ev.kind === "proof_exhausted" || ev.kind === "error") failed = true;
    if (ev.kind === "assistant_text") sawAnswer = true;
  }

  // An unverified answer is not a success. Neither is no answer at all.
  if (failed) return 1;
  if (!sawAnswer) return 1;
  return 0;
}

function cmdProve(args: Args): number {
  if (!hasBar(args.cwd)) {
    process.stderr.write("molt: no .molt/done.yml here. run `molt init` first.\n");
    return 2;
  }
  const engine = buildEngine(args);
  const result = engine.proveNow();
  if (!result) return 2;
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    printBar(result);
  }
  return result.ok ? 0 : 1;
}

function cmdInit(args: Args): number {
  const existed = hasBar(args.cwd);
  const p = writeDefaultBar(args.cwd);
  process.stdout.write(
    existed ? `molt: ${p} already exists, left alone\n` : `molt: wrote ${p}\n\nEdit it to say what "done" means here, then run molt.\n`,
  );
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

  if (args.show) {
    const file = receipts.list().find((f) => f === args.show || f.startsWith(args.show!));
    if (!file) {
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
  for (const r of rows) {
    const failed = r.failed.length ? `  failed: ${r.failed.join(", ")}` : "";
    process.stdout.write(
      `${r.file}  ${r.verdict.padEnd(9)} attempt ${r.attempt}  ${r.model}  ${r.sessionTokens} tok${failed}\n`,
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
  process.stdout.write(
    `completion attempts     ${s.attempts}\n` +
      `  accepted              ${s.accepted}\n` +
      `  refused               ${s.refused}\n` +
      `  exhausted             ${s.exhausted}\n\n` +
      `false-claim rate        ${(s.falseClaimRate * 100).toFixed(1)}%  ` +
      `(share of claims that did not survive the bar)\n` +
      `tokens per verified change  ${s.tokensPerVerifiedChange ?? "—"}\n\n`,
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
  if (!existsSync(args.cwd)) {
    process.stderr.write(`molt: no such directory: ${args.cwd}\n`);
    return 2;
  }

  switch (args.cmd) {
    case "run":
      return cmdRun(args);
    case "prove":
      return cmdProve(args);
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
  const { waitUntilExit } = render(
    <App engine={engine} version={VERSION} autoShed={args.autoShed} />,
  );
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
