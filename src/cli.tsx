#!/usr/bin/env node
/**
 * molt's command line.
 *
 * The interactive TUI is the default, but every capability is also
 * reachable headlessly — `molt run` and `molt prove` exit non-zero when the
 * bar is not met, so molt can sit in CI, in a script, or in a benchmark
 * harness without a human watching.
 */
import { acpAgentFor, acpHealth } from "./acp.js";
import { endpointDeprecation, expandEndpointShorthand, isOpencodeUrl, opencodeModelProblem } from "./endpoint.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { formatWithOptions } from "node:util";
import { resolve } from "node:path";
import { Archive } from "./archive.js";
import { isAutonomy, type Autonomy } from "./autonomy.js";
import { fmtCost, fmtDuration } from "./banner.js";
import { stepDid } from "./format.js";
import { BarError, hasBar, loadBar, selectChecks, writeDefaultBar } from "./bar.js";
import { Engine, type FileAccess } from "./engine.js";
import { describeDrift, driftSince } from "./git.js";
import { Journal } from "./journal.js";
import { Judgments } from "./judgment.js";
import { cmdJudge } from "./judge-cli.js";
import { Integrity } from "./integrity.js";
import { buildRepoMap, DEFAULT_MAP_TOKENS } from "./repomap.js";
import { buildBrief, DEFAULT_BRIEF_TOKENS } from "./brief.js";
import { draftMission, missionStatus, runMission, writePlan, type MissionSummary } from "./mission.js";
import { parseDuration } from "./session-commands.js";
import { jobEndWords } from "./tiers.js";
import { judgeEffort, judgeTarget } from "./judge.js";
import { commandsHere, draftCriteriaCritiqued, drafterInputsHash, drafterSnapshot, preflightCriteria, taskChecksFrom, type Draft, type DrafterInputs } from "./criteria.js";
import { listProject, removeNew } from "./leftovers.js";
import { projectScripts } from "./interview.js";
import {
  endpointProblem,
  fetchPricing,
  isSelfHosted,
  keyForUrl,
  defaultConfigDir,
  needsPriceLookup,
  planFor,
  PROVIDERS,
  providerName,
  readAuth,
  saveEndpoint,
  savePricing,
  storedEndpoint,
  type StoredEndpoint,
} from "./providers.js";
import { Receipts } from "./receipts.js";
import type { BarResult, Check, CheckAuthor, EngineEvent } from "./types.js";
import { stateDir } from "./statedir.js";
import { draftReference, snapshotProject } from "./reference.js";
import { env } from "./env.js";
import { fileURLToPath } from "node:url";
import { checkUserFrom, disablePrivSep, enablePrivSep, setIsolationLine, workerUserFrom, type PrivSep } from "./privsep.js";

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

const USAGE = `Maat Agent ${VERSION} — a coding agent that can't say "done" without proving it.
(Built on the molt engine; the older "molt" command still works.)

usage
  maat                      interactive session
  maat run "<task>"         headless; exit 0 verified · 1 not met · 3 no verdict
  maat ask "<question>"     a question, not a change — no work-landed check
  maat prove                run .maat/done.yml now and exit
  maat init                 write a starter .maat/done.yml
  maat doctor               check the endpoint and model
  maat acp                  run as an Agent Client Protocol agent on stdio, for an
                            editor's agent panel (Zed). --acp works too. Endpoint,
                            model, key and --autonomy come from the usual flags.

  maat receipts             list completion attempts (--grep, --show <file>, --repair)
  maat archive              list shed batches (--grep, --show <n>, --explain)
  maat stats                false-claim rate and tokens per verified change
  maat log                  what the model actually did, from the session log
  maat verify               recompute the log's hash chain
  maat attempts             one TSV row per attempt: verdict, tokens, cost, time
  maat judge                rule on the claims the scale could not settle:
                            accept · send back · the check was wrong
                            (list, show <n>, stats — see maat judge help)

  maat mission plan "<goal>"   draft .maat/mission/ (contract + features) for you to edit
  maat mission run          a worker per feature, held to its assertions, until done
  maat mission status       where the mission stands
  maat --help

first run
  maat → /login (pick a provider, paste the key) → /model (pick one) → go
  the choice is remembered, so later runs start where you left off

options
  --url <base>       OpenAI-compatible base URL   (MOLT_BASE_URL)
                     any server speaking the OpenAI shape: Ollama, llama.cpp,
                     vLLM, on this machine or another. /endpoint in the TUI.
                     default http://localhost:11434/v1
                     grok-build   runs your own logged-in Grok Build CLI over
                     ACP, so a SuperGrok / X Premium+ plan pays for the turn
                     instead of an API key (Maat does not store that login)
  --model <id>       model id                     (MOLT_MODEL)
                     no default — /model or --model picks one
  --key <secret>     api key, if the endpoint needs one   (MOLT_API_KEY)
                     /login stores keys in ~/.config/maat/auth.json (0600)
  --price-in <n>     USD per 1M prompt tokens      (MOLT_PRICE_IN)
  --price-out <n>    USD per 1M completion tokens  (MOLT_PRICE_OUT)
                     omit both and Maat reads the price from the provider
  --verbose          show every call, argument, and result (press v in the TUI)
  --provider <name>  label shown in the status line
  --cwd <dir>        project directory (default: current)
  --budget <n>       hard token ceiling for the session
  --review [n]       after a verified claim, n independent reviews (default 3) read
                     the task and the receipt; a majority-backed violation quoted
                     from the task labels the work "passed its checks,
                     unconfirmed". A label only: nothing is refused or redone.
  --reference        a second model writes an independent reference from the task
                     text and the project as it was before the work, and a hidden
                     check compares the deliverable with it on the task's
                     examples, edge cases and random inputs (needs python3)
  --reveal-stuck     experimental: when its own hidden checks fail the same way
                     twice, show the model their commands once instead of
                     stopping (off by default: it let the model bend correct
                     work to wrong checks, 37/60 vs 44/60)
  --no-reveal        stop at the repeat failure (the default)
  --review-advisory  experimental: the --review verdict is recorded but does not
                     gate; "verified" then needs a drafted check that asserts a
                     value, ran the work, and failed before the work began
                     (also MAAT_REVIEW_ADVISORY=1)
  --review-executable  experimental: every --review objection must carry a
                     read-only command that demonstrates it; Maat runs it on a
                     copy of the tree and an objection whose command is missing,
                     mutates, or passes on the work is a note, not a veto. A
                     failure counts only from a command that reads the work
                     (names a project path or runs its tests); it shows the
                     command failed, not that it tested what the objection
                     says. Commands run without Maat's credentials, and with
                     no throwaway copy of the tree they are not run and do not
                     count (also MAAT_REVIEW_EXECUTABLE=1)
  --signout          before an unattended claim is judged, put each stated
                     requirement to the model once beside the commands it ran
                     (off by default: 60 rounds rescued no task)
  --arbiter-model M  a different model rules on DISPUTE lines (same endpoint).
                     Without one, a dispute is rejected: the worker model as
                     its own arbiter shares the misreading
  --dispute-votes N  arbiter asks per dispute (default 1)
  --batch            batch mode: every reply is one act call carrying a plan and
                     a list of actions, for models that make one tool call per
                     reply. Each action is still approved, recorded and checked
                     as its own call. HTTP endpoints only.
  --judge <model>    draft the hidden checks and review the claim on a different
                     model than the worker (same endpoint unless --judge-url).
                     A separate judge does not share the worker's misreadings;
                     it raised verified-on-correct-work on every worker tested
                     with no wrong verifieds. Same as MAAT_JUDGE_MODEL.
                     Without one (or with the worker's own model), drafted
                     checks are the worker's and the most a run earns is
                     "passed own checks", never "verified".
  --judge-url <url>  where the judge runs, e.g. grok-build://subscription,
                     opencode://zen (OpenCode Zen models only, e.g.
                     opencode/big-pickle), or an OpenAI-style URL.
  --reasoning-checks <e>  effort for drafting checks and planning a mission only
                     (single calls outside the work loop). Defaults to --reasoning.
  --reasoning-retry <e>   effort for every step after the checks refuse a claim.
                     Defaults to --reasoning.
  --steps <n>        tool-call steps one turn may take before the loop guard
                     stops it (default 32; 0 for none). A long task bounded by
                     --budget or --for does not need the guard.
  --reasoning <e>    a reasoning model's effort: none, low, medium, high. Sent
                     only when set. A model that thinks to its ceiling and never
                     answers (Space Bunny Alpha at default) answers at low.
  --max-tokens <n>   most tokens the model may write in one reply (default
                     32768, or the model's own maximum if it is lower)
  --auto-shed <n>    shed once history exceeds n tokens (default 60000, 0 off)
  --attempts <n>     completion attempts before Maat reports failure (default 4)
  --for <5m>         wall-clock ceiling for one turn; then the bar runs on
                     whatever exists. 30s, 5m, 1h, or off
  --commit           when the bar is met, commit the files this turn wrote,
                     with the receipt named in the message (/undo takes it back)
  --revert           when the bar is not met, put those files back the way they
                     were. The receipt and the journal are never touched.
  --map <tokens>     size of the repository map added to the system prompt
                     (default 900, and off for self-hosted endpoints: it helps
                     a frontier model and distracts a small local one).
                     --no-map leaves it out entirely.
  --no-brief         leave out the environment brief (tools, manifests, git
                     state) that is gathered once and put in the system prompt
  --read <path,...>  files the model may read and never write; a write to one
                     is refused at the tool. Repeatable.
  --criterion <name=command>
                     what "done" means for THIS task, on top of the project's
                     bar: a command that must exit 0. Sealed before the work
                     starts, run with the bar, named task:<name> on the receipt.
                     Repeatable. (The window's criteria panel, headless.)
  --criteria auto    let the model draft criteria for the task and seal them
                     before the work starts; it is then held to them. They can
                     only add to the project's bar, never replace it.
  --note <text>      a criterion in words. Recorded on the receipt as stated
                     intent, shown to the model, never reported as verified.
  --capture <dir>    write one JSON per completion attempt — the full wire
                     transcript, ledger, bar result and receipt name — for
                     training Maat's safeguard model. Redacted. Off by
                     default. (MOLT_CAPTURE_DIR)
  --autonomy <level> low | medium | high — how much runs without asking
                     low asks about every command and write (default)
                     medium runs reads, read-only commands, project writes
                     high runs everything except what cannot be undone
  --yes              auto-approve every tool call (same as --autonomy high)
  --sandbox          the machine is disposable: --yes, no project boundary, and
                     what high autonomy would still ask about runs (rm, sudo,
                     python -c, a write outside the directory). For a container
                     or a throwaway VM, never for a machine you keep.
  --worker-user <u>  run the worker's tools as user <u> (Linux; Maat runs as
                     root or with passwordless sudo to <u>). Maat's records go
                     to a private state dir (MAAT_STATE_DIR) and are copied
                     into .maat/ when the job ends. For containers and
                     unattended runs. (MAAT_WORKER_USER)
  --check-user <u>   with --worker-user: task checks (hidden, drafted, mission)
                     run as user <u> in their copy of the tree, with only PATH,
                     a fresh HOME, LANG and TERM, and (root with CAP_SYS_ADMIN)
                     their own PID namespace and /tmp. Checks that run in the
                     project itself, and mutation runs, run as the worker.
                     (MAAT_CHECK_USER)
  --worker-strict    with --worker-user: refuse to start unless the worker
                     account, the check account and the PID namespace can all
                     be set up. Without it Maat carries on and every receipt
                     and the journal say which isolation was in effect.
  --json             machine-readable output (run/prove/stats/receipts)
  --version          print the version and exit
  --no-stream        disable token streaming (default: streaming on)
  --only <tags>      run only checks with these tags (comma separated)
  --skip <tags>      skip checks with these tags
  --grep <pattern>   filter receipts or archive entries
  --session <id>     which session log to read (default: most recent)
  --raw              print the log as raw JSONL rather than a summary
  --show <id>        print one receipt file or exuvia index

maat reads .maat/done.yml for what "done" means in this project.
Without it, completions are unverified and Maat will say so.`;

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
  maxTokens?: number;
  /** `--reasoning low`: a reasoning model's effort, sent only when set. */
  reasoning?: string;
  /** `--judge <model>`: the model that drafts checks and reviews (MAAT_JUDGE_MODEL). */
  judge?: string;
  /** `--judge-url <url>`: where the judge runs (MAAT_JUDGE_URL). */
  judgeUrl?: string;
  /** `--reasoning-checks high`: effort for drafting checks and planning only. */
  reasoningChecks?: string;
  /** `--reasoning-retry high`: effort after the checks refuse a claim. */
  reasoningRetry?: string;
  /** `--steps n`: the per-turn step ceiling; 0 is none. */
  steps?: number;
  /** `--batch`: the model's only tool is act — a plan and a list of actions per reply. */
  batch?: boolean;
  /** `--reveal-stuck` (opt-in) / `--no-reveal`: see EngineConfig.revealOnStuck. */
  revealStuck?: boolean;
  /** `--review-advisory`: see EngineConfig.reviewAdvisory. */
  reviewAdvisory?: boolean;
  /** `--review-executable`: see EngineConfig.reviewExecutable. */
  reviewExecutable?: boolean;
  /** `--signout`: see EngineConfig.signOut. */
  signout?: boolean;
  /** `--arbiter-model` / `--dispute-votes`: see EngineConfig.dispute. */
  arbiterModel?: string;
  disputeVotes?: number;
  /** `--reference`: an independent reference check (src/reference.ts). */
  reference?: boolean;
  /** `--review [n]`: independent review of a verified claim, n votes (default 3). A label, not a gate. */
  review?: number;
  attempts?: number;
  /** Wall-clock ceiling for one turn, in ms. `--for 5m`. */
  forMs?: number;
  /** Commit what the bar verifies. `--commit`. */
  commit?: boolean;
  /** Put the tree back when the bar is not met. `--revert`. */
  revert?: boolean;
  /** Token budget for the repository map; 0 turns it off. `--map`/`--no-map`. */
  mapTokens?: number;
  /** 0 leaves the environment brief out. */
  briefTokens?: number;
  /** `molt mission plan --force`: replace an existing mission. */
  force?: boolean;
  /**
   * `--sandbox`: the machine is disposable. Implies --yes, lifts the project
   * boundary, and approves every gated call instead of refusing it.
   */
  sandbox?: boolean;
  /** `--worker-user <name>`: the worker's tools run as that user (src/privsep.ts). */
  workerUser?: string;
  /** `--check-user <name>`: task checks run as that account (src/privsep.ts). */
  checkUser?: string;
  /** `--worker-strict`: refuse to start unless worker account, check account and PID namespace are all in place. */
  workerStrict?: boolean;
  /** `molt mission run --features n`: stop after n worker runs. */
  features?: number;
  /** Files the model may read and never write. `--read`, repeatable. */
  readOnly?: string[];
  /** Task criteria as commands. `--criterion name=cmd`, repeatable. */
  criteria?: { name: string; run: string }[];
  /**
   * `--criteria auto`: have the model draft criteria for the task before the
   * work, seal them, and hold the work to them. Headless only — nobody is
   * there to approve, and a drafted criterion can only make the bar stricter.
   */
  autoCriteria?: boolean;
  /** Task criteria in words. `--note`, repeatable. */
  notes?: string[];
  /** Directory for per-attempt capture files. `--capture`, or MOLT_CAPTURE_DIR. */
  capture?: string;
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
  /** Serve ACP on stdio. `molt acp`, or `--acp` for launchers that want a flag. */
  acp: boolean;
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
/** Says once, on stderr, that an endpoint spelling is going away. */
const deprecationsSaid = new Set<string>();
function noteDeprecated(raw: string | undefined): void {
  const note = endpointDeprecation(raw);
  if (!note || deprecationsSaid.has(note)) return;
  deprecationsSaid.add(note);
  process.stderr.write(`maat: ${note}\n`);
}

export function parseArgs(argv: string[], stored: StoredEndpoint = {}): Args {
  const out: Args = {
    cmd: "",
    url: env("BASE_URL") ?? stored.baseUrl ?? "http://localhost:11434/v1",
    model: env("MODEL") ?? stored.model ?? "",
    key: env("API_KEY") ?? stored.apiKey,
    priceIn: num(env("PRICE_IN")),
    priceOut: num(env("PRICE_OUT")),
    cwd: process.cwd(),
    explain: false,
    raw: false,
    stream: true,
    verbose: false,
    yes: false,
    json: false,
    help: false,
    version: false,
    acp: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `--` ends the options: everything after it is the command and the task,
    // however it starts. A task is free text and may itself begin with "- ".
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
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
      case "--url": {
        const given = next();
        /**
         * `--url grok-build` (or `grok`) is what people type.
         *
         * The backend's endpoint is a sentinel, not an address, and asking
         * someone to spell `grok-build://subscription` exactly is asking them
         * to get it wrong. The full form still works and is what gets stored.
         *
         * The translation itself lives in `src/endpoint.ts`, beside
         * `endpointProblem`, so the engine and the window expand the same word
         * this flag does rather than each learning it separately.
         */
        noteDeprecated(given);
        out.url = expandEndpointShorthand(given);
        /**
         * Refused here, not four retries later.
         *
         * `--url grok` typed at a build without the shorthand became
         * `grok/chat/completions`, which `fetch` rejects as an invalid URL and
         * Maat read as the network being down. The flag is the first place
         * that knows, so it is the place that says so.
         */
        const wrong = endpointProblem(out.url);
        if (wrong) {
          process.stderr.write(`maat: ${wrong}\n`);
          process.exit(2);
        }
        break;
      }
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
      case "--max-tokens":
        out.maxTokens = positiveInt("--max-tokens", next());
        break;
      case "--batch":
        out.batch = true;
        break;
      case "--reveal-stuck":
        out.revealStuck = true;
        break;
      case "--no-reveal":
        out.revealStuck = false;
        break;
      case "--review-advisory":
        out.reviewAdvisory = true;
        break;
      case "--review-executable":
        out.reviewExecutable = true;
        break;
      case "--signout":
        out.signout = true;
        break;
      case "--arbiter-model":
        out.arbiterModel = next();
        break;
      case "--dispute-votes":
        out.disputeVotes = positiveInt("--dispute-votes", next());
        break;
      case "--reference":
        out.reference = true;
        break;
      case "--review": {
        // Optional count: `--review` alone is three votes.
        const peek = argv[i + 1];
        if (peek !== undefined && /^\d+$/.test(peek)) {
          out.review = Math.max(1, Number(peek));
          i += 1;
        } else {
          out.review = 3;
        }
        break;
      }
      case "--steps": {
        const raw = next();
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) throw new Error(`--steps takes a whole number (0 for none); got ${raw}`);
        out.steps = n;
        break;
      }
      case "--judge":
        out.judge = next();
        break;
      case "--judge-url": {
        // Same words as --url (`grok`, `opencode`), and refused here rather
        // than when the first check is drafted.
        const givenJudgeUrl = next();
        noteDeprecated(givenJudgeUrl);
        const judgeUrl = expandEndpointShorthand(givenJudgeUrl);
        const wrong = endpointProblem(judgeUrl);
        if (wrong) throw new Error(`--judge-url: ${wrong}`);
        out.judgeUrl = judgeUrl;
        break;
      }
      case "--reasoning-checks":
      case "--reasoning-retry": {
        const effort = next();
        if (!REASONING_EFFORTS.includes(effort)) {
          throw new Error(`${a} takes one of ${REASONING_EFFORTS.join(", ")}; got ${effort}`);
        }
        if (a === "--reasoning-checks") out.reasoningChecks = effort;
        else out.reasoningRetry = effort;
        break;
      }
      case "--reasoning": {
        const effort = next();
        if (!REASONING_EFFORTS.includes(effort)) {
          throw new Error(`--reasoning takes one of ${REASONING_EFFORTS.join(", ")}; got ${effort}`);
        }
        out.reasoning = effort;
        break;
      }
      case "--attempts":
        out.attempts = positiveInt("--attempts", next());
        break;
      case "--for": {
        const raw = next();
        const ms = parseDuration(raw);
        if (ms === null) {
          throw new Error(`--for needs a duration like 5m, 90s or 1h, got "${raw ?? ""}"`);
        }
        out.forMs = ms;
        break;
      }
      case "--commit":
        out.commit = true;
        break;
      case "--revert":
        out.revert = true;
        break;
      case "--map":
        out.mapTokens = positiveInt("--map", next());
        break;
      case "--no-map":
        out.mapTokens = 0;
        break;
      case "--no-brief":
        out.briefTokens = 0;
        break;
      case "--force":
        out.force = true;
        break;
      case "--features":
        out.features = positiveInt("--features", next());
        break;
      case "--read":
        // Repeatable, and comma-separable: a CI job pinning six files should
        // not have to choose which spelling this flag prefers.
        out.readOnly = [
          ...(out.readOnly ?? []),
          ...next().split(",").map((t) => t.trim()).filter(Boolean),
        ];
        break;
      case "--criterion": {
        // `name=command`. A bare command gets a numbered name, so the receipt
        // still has something to call it.
        const raw = next();
        const eq = raw.indexOf("=");
        const name = eq > 0 ? raw.slice(0, eq).trim() : `criterion-${(out.criteria?.length ?? 0) + 1}`;
        const run = (eq > 0 ? raw.slice(eq + 1) : raw).trim();
        if (!run) throw new Error(`--criterion needs name=command, got "${raw}"`);
        out.criteria = [...(out.criteria ?? []), { name, run }];
        break;
      }
      case "--criteria": {
        const mode = next();
        if (mode !== "auto") throw new Error(`--criteria takes "auto"; got ${mode}`);
        out.autoCriteria = true;
        break;
      }
      case "--note":
        out.notes = [...(out.notes ?? []), next()];
        break;
      case "--capture":
        out.capture = resolve(next());
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
      case "--sandbox":
        out.sandbox = true;
        out.yes = true;
        break;
      case "--worker-user":
        out.workerUser = next();
        break;
      case "--check-user":
        out.checkUser = next();
        break;
      case "--worker-strict":
        out.workerStrict = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--acp":
        out.acp = true;
        break;
      default:
        // No option contains whitespace, so a word with a space in it is the
        // task, even one that starts with a dash ("- You are given…").
        if (a.startsWith("-") && !/\s/.test(a)) throw new Error(`unknown option: ${a}`);
        positional.push(a);
    }
  }

  out.cmd = positional[0] ?? "";
  out.task = positional.slice(1).join(" ") || undefined;

  // A stored or MAAT_BASE_URL endpoint in the old OpenCode spelling still works, for one release.
  noteDeprecated(out.url);
  out.url = expandEndpointShorthand(out.url);
  // OpenCode runs only OpenCode Zen models, as worker and as judge, refused here
  // rather than when the CLI is spawned (where it is refused again).
  if (isOpencodeUrl(out.url)) {
    const wrong = opencodeModelProblem(out.model);
    if (wrong) throw new Error(`--model: ${wrong}`);
  }
  const envJudgeUrl = process.env.MAAT_JUDGE_URL?.trim();
  if (out.judgeUrl === undefined && envJudgeUrl) noteDeprecated(envJudgeUrl);
  const judgeModel = out.judge ?? process.env.MAAT_JUDGE_MODEL?.trim();
  const judgeUrl = out.judgeUrl ?? (envJudgeUrl ? expandEndpointShorthand(envJudgeUrl) : out.url);
  if (judgeModel && isOpencodeUrl(judgeUrl)) {
    const wrong = opencodeModelProblem(judgeModel);
    if (wrong) throw new Error(`--judge: ${wrong}`);
  }

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
  try {
    return engineFor(args, session);
  } catch (e) {
    if (e instanceof BarError || e instanceof EmptySelection) {
      process.stderr.write(`maat: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
}

class EmptySelection extends Error {
  constructor() {
    super("tag selection left no checks — refusing to run an empty bar");
  }
}

/**
 * The engine for `args`, throwing where buildEngine exits.
 *
 * An ACP session is built long after the process started, on a request from
 * the editor, and a broken done.yml there is an answer to that request — the
 * editor shows it — not a reason to kill the server every other session runs
 * on.
 */
function engineFor(args: Args, session = false, extra: { files?: FileAccess } = {}): Engine {
  let bar = loadBar(args.cwd);
  if (bar && (args.only?.length || args.skip?.length)) {
    bar = selectChecks(bar, { only: args.only, skip: args.skip });
    if (bar.checks.length === 0) throw new EmptySelection();
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
    // Resolved against the endpoint this run is pointed at, so a stored key
    // is found whatever `config.json` happens to say.
    apiKey: keyForUrl(args.url, args.key),
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
    integrity: new Integrity(args.cwd),
    maxProofAttempts: args.attempts,
    turnDeadlineMs: args.forMs,
    readOnly: args.readOnly,
    // Off unless asked for, on both counts: committing and reverting are
    // things a person expects to be in charge of.
    git: { commitOnPass: args.commit === true, restoreOnFail: args.revert === true },
    autoShedAtTokens: args.autoShed,
    maxTokens: args.maxTokens,
    reasoningEffort: args.reasoning,
    retryReasoningEffort: args.reasoningRetry,
    maxSteps: args.steps,
    batch: args.batch === true,
    ...(args.revealStuck === true ? { revealOnStuck: true } : args.revealStuck === false ? { revealOnStuck: false } : {}),
    ...(args.reviewAdvisory || env("REVIEW_ADVISORY") === "1" ? { reviewAdvisory: true } : {}),
    ...(args.reviewExecutable || env("REVIEW_EXECUTABLE") === "1" ? { reviewExecutable: true } : {}),
    ...(args.signout ? { signOut: true } : {}),
    ...(args.arbiterModel || args.disputeVotes ? { dispute: { model: args.arbiterModel, votes: args.disputeVotes } } : {}),
    ...(args.review ? { review: { votes: args.review, reasoningEffort: args.reasoningChecks ?? args.reasoning } } : {}),
    // MAAT_JUDGMENT=0: no judgment cases (benchmarks, where no person will ever rule).
    ...(env("JUDGMENT") === "0" ? { judgment: false } : {}),
    captureDir: args.capture ?? env("CAPTURE_DIR"),
    stream: args.stream,
    // --yes predates autonomy and means the same thing as its top level.
    autonomy: args.yes ? "high" : args.autonomy,
    unattended: session,
    sandbox: args.sandbox === true,
    files: extra.files,
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
  const p = await fetchPricing(args.url, args.model, keyForUrl(args.url, args.key));
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
  // A check that did not run is not one of the checks that passed. Counting
  // "n/a" rows as passes printed "11 of 12 passed" over five that ran.
  const ran = result.results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.ok).length;
  const na = result.results.filter((r) => r.skipped && r.ok).length;
  const notRun = result.results.filter((r) => r.skipped && !r.ok).length;
  process.stdout.write(
    `${passed} of ${ran.length} checks passed` +
      (notRun ? ` · ${notRun} not run` : "") +
      (na ? ` · ${na} n/a` : "") +
      ` · ${fmtDuration(result.durationMs)}\n`,
  );
  for (const r of result.results) {
    const tags = r.tags?.length ? `  [${r.tags.join(",")}]` : "";
    // Same three-way distinction the receipt makes: a check that established
    // nothing is not a check that cleared the work.
    const label = r.skipped
      ? r.ok
        ? "n/a"
        : "SKIP"
      : r.ok
      ? r.established === false
        ? "pass·none"
        : "pass"
      : r.advisory
        ? "warn"
        : "FAIL";
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
  const unasked = result.undetermined ?? [];
  const failedAny = result.results.some((r) => !r.ok && !r.advisory && !r.skipped);
  process.stdout.write(
    (result.cancelled
      ? "\nbar cancelled — not a verdict on the work"
      : result.ok
        ? result.results.some((r) => r.ok && !r.skipped && r.established !== false)
          ? "\nbar met"
          : "\nbar met · but nothing was established: no check had anything to examine"
        : unasked.length && !failedAny
          ? `\nbar UNDETERMINED — ${unasked.length} required check(s) not run: ${unasked.join(", ")}`
          : "\nbar NOT met") +
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
        ? "\nwork-landed requires a file to have changed in this session. `maat prove` runs\n" +
            "standalone, so there is no session and no write for it to find — it fails here by\n" +
            "definition, not because anything is wrong. Once a turn has run it has one to read.\n"
        : "\neverything else passed. work-landed requires this turn to have changed a file, so a\n" +
            "question, a lookup, or an explanation can never satisfy it — and Maat would rather\n" +
            "refuse an honest answer than accept an invented file edit.\n" +
            'ask questions with `maat ask "<question>"`, which runs the rest of the bar and drops\n' +
            "that one check for the turn. (--skip session would leave the turn undetermined.)\n",
    );
  }
}

/**
 * How big a map to build, when nobody said.
 *
 * Measured, not assumed, and the measurement pointed both ways. Against
 * grok-4.6 over three paired runs the map was cheaper every time — 23% less
 * spend, 23% fewer tool calls, first edit 1.7 steps sooner. Against two local
 * models it lost both pairs, and the mechanism was visible: handed a list of
 * 41 files, a 20B made 25 greps and never edited anything, while the same
 * model without a map made 16 greps and 4 edits. A strong model reads a map
 * and acts; a weak one reads it and goes shopping.
 *
 * So the default follows the signal molt already trusts for the spending
 * ceiling: self-hosted means a model you are running yourself, which today
 * means a small one. `--map <n>` turns it on anyway, and is the right thing to
 * reach for the moment local models get better at this.
 */
export function defaultMapTokens(url: string): number {
  return isSelfHosted(url) ? 0 : DEFAULT_MAP_TOKENS;
}

/**
 * Give the engine its map of the repository before the first request.
 *
 * Built out here rather than in the engine because it walks the disk, and a
 * constructor that reads a thousand files is a constructor that hangs a
 * window. Failure is deliberately silent: a map is a hint, and no session
 * should fail to start because a hint could not be assembled.
 */
/**
 * The environment brief, on by default for every model.
 *
 * Unlike the map it is not gated on self-hosting: a small model is the one
 * most likely to spend six steps asking which tools exist, and the brief is a
 * few hundred tokens that answer that once.
 */
async function primeBrief(engine: Engine, args: Args): Promise<void> {
  const budget = args.briefTokens ?? DEFAULT_BRIEF_TOKENS;
  if (budget <= 0) return;
  try {
    const brief = await buildBrief({ cwd: args.cwd, budgetTokens: budget });
    if (brief.text) engine.setBrief(brief.text);
  } catch {
    /* a brief that could not be built is not a reason to refuse to start */
  }
}

async function primeRepoMap(engine: Engine, args: Args): Promise<void> {
  const budget = args.mapTokens ?? defaultMapTokens(args.url);
  if (budget <= 0) return;
  try {
    const map = await buildRepoMap(args.cwd, { budgetTokens: budget });
    if (map.text) engine.setRepoMap(map.text);
  } catch {
    /* a hint that could not be built is not a reason to refuse to start */
  }
}

/**
 * `molt attempts` — one row per completion attempt, oldest first.
 *
 * `autoresearch` keeps a `results.tsv` and reads it as the record of whether
 * the loop is getting anywhere. molt has the same data spread across prose
 * receipts and a JSON index, which is worse for exactly the question the TSV
 * answers: is this converging, and what is it costing? Tab-separated because
 * that is what `sort`, `awk` and a spreadsheet all take without argument.
 */
function cmdAttempts(args: Args): number {
  const rows = new Receipts(args.cwd).records();
  if (!rows.length) {
    process.stdout.write("no attempts yet — .maat/receipts is empty\n");
    return 0;
  }
  const head = ["seq", "iso", "verdict", "attempt", "model", "tokens", "usd", "bar_ms", "failed", "file"];
  const out = [head.join("\t")];
  for (const r of rows) {
    out.push(
      [
        r.seq,
        r.iso,
        r.verdict,
        r.attempt,
        r.model,
        r.sessionTokens,
        r.costUsd === undefined ? "" : r.costUsd.toFixed(4),
        r.barMs,
        r.failed.join(",") || "-",
        r.file,
      ].join("\t"),
    );
  }
  process.stdout.write(out.join("\n") + "\n");
  const accepted = rows.filter((r) => r.verdict === "accepted").length;
  const spent = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  process.stderr.write(
    `\n${rows.length} attempt(s) · ${accepted} accepted · ` +
      `${rows.length - accepted} not · $${spent.toFixed(2)} across all of them\n`,
  );
  return 0;
}

/**
 * The task's own criteria, from the command line, in the shape the engine
 * seals. Through the same sanitizer the window uses, so the two surfaces
 * cannot disagree about what a criterion may be.
 *
 * Until this existed the headless CLI had no way to state what "done" meant
 * for a task: `molt run` could be given rules only through the prompt, which
 * is tier 3 — advisory — and the project's own commandments say anything
 * checkable must never live only there. One real run "fixed" a coverage
 * defect for $0.039, earned an accepted receipt, and was wrong in the unit it
 * mapped; the check that would have refused it is one line of `--criterion`.
 */
export function criteriaFromArgs(args: Pick<Args, "criteria" | "notes">): {
  taskChecks: ReturnType<typeof taskChecksFrom>["taskChecks"];
  taskNotes: string[];
} {
  return taskChecksFrom({ checks: args.criteria ?? [], notes: args.notes ?? [] });
}

/** Finished, but nothing established a verdict: no bar, or required checks not run. */
const EXIT_NO_VERDICT = 3;
const REASONING_EFFORTS = ["none", "low", "medium", "high"];

/**
 * `molt mission plan|run|status`.
 *
 * plan asks the model once and writes files for a person to edit. run is a
 * loop with no model in it: a fresh worker engine per feature, built exactly
 * as `molt run` builds one, held to the assertions the feature claims. status
 * reads the files. Nothing here judges work; the assertions do.
 */
async function cmdMission(args: Args): Promise<number> {
  const [sub, ...rest] = (args.task ?? "").split(" ");
  const goal = rest.join(" ").trim();
  switch (sub) {
    case "status":
      process.stdout.write(missionStatus(args.cwd) + "\n");
      return 0;
    case "plan": {
      if (!goal) {
        process.stderr.write('maat: mission plan needs a goal, e.g. Maat mission plan "a CLI that ..."\n');
        return 2;
      }
      if (!args.model) {
        process.stderr.write("maat: no model selected — pass --model <id> or set MOLT_MODEL\n");
        return 2;
      }
      const brief = await buildBrief({ cwd: args.cwd }).catch(() => ({ text: "" }));
      const r = await draftMission({
        goal,
        context: brief.text,
        scripts: projectScripts(args.cwd),
        ask: { baseUrl: args.url, apiKey: keyForUrl(args.url, args.key), model: args.model, cwd: args.cwd, reasoningEffort: args.reasoningChecks ?? args.reasoning },
      });
      if (!r.ok) {
        process.stderr.write(`maat: ${r.error}\n`);
        return 1;
      }
      let written: string[];
      try {
        written = writePlan(args.cwd, r.plan, { force: args.force });
      } catch (e) {
        process.stderr.write(`maat: ${(e as Error).message}\n`);
        return 2;
      }
      process.stdout.write(
        `wrote ${written.join(", ")}\n` +
          `${r.plan.features.features.length} feature(s), ${r.plan.contract.assertions.length} assertion(s)\n`,
      );
      if (r.problems.length) {
        process.stdout.write(`fix before running:\n${r.problems.map((p) => `  - ${p}`).join("\n")}\n`);
      }
      process.stdout.write(`read and edit them, then: Maat mission run\n`);
      return r.problems.length ? 1 : 0;
    }
    case "run": {
      if (!args.model) {
        process.stderr.write("maat: no model selected — pass --model <id> or set MOLT_MODEL\n");
        return 2;
      }
      const confirm = async (name: string, detail: string) => {
        process.stderr.write(`maat: refusing ${name} (${detail}) — raise --autonomy, or pass --yes, for a mission\n`);
        return false;
      };
      const brief = await buildBrief({ cwd: args.cwd }).catch(() => ({ text: "" }));
      const t0 = Date.now();
      let summary: MissionSummary;
      try {
        summary = await runMission({
          cwd: args.cwd,
          maxAttempts: args.attempts,
          maxRuns: args.features,
          confirm,
          makeWorker: async (feature) => {
            const engine = buildEngine(args, true);
            if (brief.text) engine.setBrief(brief.text);
            await primeRepoMap(engine, args);
            await priceEngine(engine, args);
            process.stdout.write(`\n== ${feature.id} ${feature.title} ==\n`);
            return engine;
          },
          events: {
            featureEnd: (f, h) => {
              process.stdout.write(
                `== ${f.id} ${h.outcome}` +
                  (h.failed.length ? ` · failed ${h.failed.join(", ")}` : "") +
                  (h.receipt ? ` · ${h.receipt}` : "") +
                  ` · ${fmtDuration(h.durationMs)}\n`,
              );
            },
            milestone: (name, ok, results) => {
              process.stdout.write(
                `== milestone ${name} ${ok ? "sealed" : "NOT sealed"} · ` +
                  `${results.filter((r) => r.ok).length}/${results.length} assertion(s) pass together\n`,
              );
            },
            worker: args.json
              ? (_f, ev) => process.stdout.write(JSON.stringify(ev) + "\n")
              : (_f, ev) => {
                  if (ev.kind === "tool") process.stdout.write(`  ${ev.name} ${ev.detail}\n`);
                  else if (ev.kind === "proof_result" || ev.kind === "proof_refused") {
                    process.stdout.write(`  bar: ${ev.result.ok ? "met" : "not met"} (attempt ${ev.attempt})\n`);
                  }
                },
          },
        });
      } catch (e) {
        process.stderr.write(`maat: ${(e as Error).message}\n`);
        return 2;
      }
      process.stdout.write(
        `\nmission ${summary.stopped} · ${summary.runs} run(s) · ${fmtDuration(Date.now() - t0)}\n` +
          `done ${summary.done.length} · blocked ${summary.blocked.length} · pending ${summary.pending.length}\n` +
          `sealed: ${summary.sealed.join(", ") || "none"}` +
          (summary.unsealed.length ? ` · not sealed: ${summary.unsealed.join(", ")}` : "") +
          "\n",
      );
      return summary.stopped === "complete" && summary.unsealed.length === 0 ? 0 : summary.stopped === "contract moved" ? 2 : 1;
    }
    default:
      process.stderr.write(`maat: mission takes plan "<goal>", run, or status\n`);
      return 2;
  }
}

/** What the criteria drafter may read, taken before the turn's first step. */
function drafterSnapshotFor(args: Args): DrafterInputs {
  return drafterSnapshot(args.task ?? "", args.cwd, {
    commands: commandsHere(args.cwd),
    scripts: projectScripts(args.cwd),
    lessons: new Judgments(args.cwd).lessons(),
  });
}

/**
 * `--criteria auto`: the model writes the exam, and is then held to it.
 *
 * In the window a person edits and approves the draft. Headless there is
 * nobody, so the draft is sealed as written — which is safe for the same
 * reason drafting is safe at all: criteria only ever ADD to the project's
 * bar. A model cannot lower the bar by drafting; it can only give itself
 * more to satisfy. What it buys is the thing a long unattended run most
 * lacks: a checkable definition of done for THIS task, decided before any
 * work exists to be judged. A check that cannot run at all is dropped and
 * said, so a hallucinated command does not fail the turn for the wrong reason.
 */
async function autoDraft(
  engine: Engine,
  args: Args,
  soFar?: { draft?: Draft; sealed?: boolean; late?: boolean },
  inputs?: { snapshot: DrafterInputs; used: string[] },
  deadlineAt?: number,
): Promise<ReturnType<typeof taskChecksFrom>> {
  // Taken once, now, before the first step: the second try below and every
  // stage of each draft read this and never the folder the work is changing.
  const snapshot = inputs?.snapshot ?? drafterSnapshotFor(args);
  const none: ReturnType<typeof taskChecksFrom> = { taskChecks: [], taskNotes: [] };
  // Under --for, no draft, critique or retry waits past the run's budget
  // (the job's own deadline, taken once by the caller: runDeadlineAt).
  // Drafted, then read cold by a critic against the task text: a check that
  // invents or guesses is dropped (with a task quote), and a draft where
  // nothing runs the deliverable is asked for once more. See criteria.ts.
  const draftOnce = () =>
    draftCriteriaCritiqued({
      snapshot,
      ...(snapshot.commands ? { commands: snapshot.commands } : {}),
      lessons: [...snapshot.lessons],
      task: args.task ?? "",
      scripts: [...snapshot.scripts],
      onInputs: (sha) => inputs?.used.push(sha),
      barChecks: (engine.cfg.bar?.checks ?? []).map((c) => c.name),
      ...judgeTarget({ baseUrl: args.url, apiKey: args.key, model: args.model }),
      cwd: args.cwd,
      reasoningEffort: judgeEffort(args.reasoningChecks ?? args.reasoning),
      latency: engine.askLatency,
      deadlineAt,
      // What is ready when a time budget stops the wait (RunOptions.criteriaSoFar).
      onProgress: (d) => {
        if (soFar) soFar.draft = d;
      },
    });
  let r = await draftOnce();
  // One unlucky reply (an overloaded provider, JSON that does not parse) leaves
  // a run with no checks, and so no verdict worth the name. Asked
  // once more; a second failure is journalled as `no-checks`, not left silent.
  if (!r.ok && !soFar?.sealed) {
    process.stderr.write(`maat: criteria not drafted — ${r.error}; asking once more\n`);
    engine.cfg.journal?.append("note", { kind: "draft-failed", text: `criteria draft failed once: ${r.error}` });
    r = await draftOnce();
  }
  if (!r.ok) {
    process.stderr.write(`maat: criteria not drafted — ${r.error}; running against the project bar only\n`);
    engine.cfg.journal?.append("note", { kind: "no-checks", text: `no-checks: criteria could not be drafted after two tries — ${r.error}` });
    return none;
  }
  for (const line of r.critique) process.stderr.write(`maat: criteria review — ${line}\n`);
  // A check the seal-time lint retired is never sealed; the record says which and why.
  for (const d of r.lint ?? []) {
    engine.cfg.journal?.append("note", {
      kind: "check-lint-dropped",
      text: `drafted check ${d.name} dropped by lint ${d.rule}: ${d.why}`,
      name: d.name,
      run: d.run,
      rule: d.rule,
      redraft: d.redraft,
    });
  }
  // A time budget already sealed what was ready (criteriaSoFar), and the work
  // has begun in this folder. Sealing again would run the preflight a second
  // time — and its cleanup removes every file that appeared while it ran,
  // which by now includes the model's.
  if (soFar?.sealed) return none;
  return sealDraft(r.draft, args, soFar?.late);
}

/**
 * Snapshot the project now, before the first step, and write a reference
 * check from it in the background (src/reference.ts). Null — said once — when
 * there is no python3, the project is too large to copy, or no reference
 * applies.
 */
function startReference(args: Args, deadlineAt?: number): Promise<{ check: Check; note: Record<string, unknown> } | null> | undefined {
  const here = commandsHere(args.cwd);
  if (!here.present.includes("python3")) {
    process.stderr.write("maat: no reference check — python3 is not installed here\n");
    return undefined;
  }
  const snapshot = snapshotProject(args.cwd);
  if (!snapshot) {
    process.stderr.write("maat: no reference check — the project is too large to snapshot\n");
    return undefined;
  }
  return draftReference({
    task: args.task ?? "",
    snapshot,
    baseUrl: args.url,
    apiKey: args.key,
    model: args.model,
    cwd: args.cwd,
    reasoningEffort: args.reasoningChecks ?? args.reasoning,
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  }).then((r) => {
    if (!r.ok) {
      process.stderr.write(`maat: no reference check — ${r.why}\n`);
      return null;
    }
    process.stderr.write(`maat: reference check ready — ${r.reason}\n`);
    return {
      check: r.check,
      note: { snapshot: r.snapshot.hash, files: r.snapshot.files, reason: r.reason, source: r.source },
    };
  }).catch((e: unknown) => {
    // A throw here (a file gone mid-copy) was an unhandled rejection whenever
    // no claim was waiting on the reference — enough to end the process.
    process.stderr.write(`maat: no reference check — ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  });
}

/** A draft as sealed, hidden checks, with the ones that break before any work dropped. */
async function sealDraft(draft: Draft, args: Args, late = false): Promise<ReturnType<typeof taskChecksFrom>> {
  // Hidden: the model wrote these, and a model shown its own exam makes the
  // work equal the check. It gets the names, and the output on failure.
  // Who wrote them, recorded with the seal: the judge when one is set, else the
  // worker itself. Whether that judge is really another model is tierOf's call.
  const drafter = judgeTarget({ baseUrl: args.url, apiKey: args.key, model: args.model }).model;
  const author: CheckAuthor = process.env.MAAT_JUDGE_MODEL?.trim() ? { kind: "judge", model: drafter } : { kind: "worker", model: args.model };
  const sealed = taskChecksFrom(draft, { hidden: true, author });
  // Headless, the checks' own side effects are cleaned up (src/leftovers.ts).
  // A draft that joins at a claim (RunOptions.pendingCriteria, cut with no
  // checks ready) lands after the work began: trying it in the live folder
  // would be meaningless, and the cleanup after the try removes every file
  // that appeared meanwhile, the model's included. It joins untried.
  const beforeTry = late ? null : listProject(args.cwd);
  const broken = late ? [] : await preflightCriteria(sealed.taskChecks, { cwd: args.cwd, stray: { task: args.task ?? "" } });
  if (!late) removeNew(args.cwd, beforeTry);
  const drop = new Set(broken.map((b) => b.name));
  for (const b of broken) {
    process.stderr.write(`maat: dropped drafted criterion ${b.name} (${b.run}) — ${b.why}\n`);
  }
  const taskChecks = sealed.taskChecks.filter((c) => !drop.has(c.name));
  if (!args.json) {
    // Names only: the commands are printed when the job releases them (checks_released).
    for (const c of taskChecks) process.stdout.write(`· criterion ${c.name} (command withheld until the job ends)\n`);
    for (const n of sealed.taskNotes) process.stdout.write(`· note ${n}\n`);
  }
  return { taskChecks, taskNotes: sealed.taskNotes, ...(sealed.requirements ? { requirements: sealed.requirements } : {}) };
}

async function cmdRun(args: Args, ask = false): Promise<number> {
  if (!args.task) {
    process.stderr.write(
      ask
        ? 'maat: ask needs a question, e.g. Maat ask "what does the bar check?"\n'
        : 'maat: run needs a task, e.g. Maat run "fix the failing test"\n',
    );
    return 2;
  }
  // The TUI refuses this at the prompt; headless has to refuse it too, or a
  // CI run fires a request with an empty model and fails inside the provider.
  if (!args.model) {
    process.stderr.write(
      "maat: no model selected — pass --model <id>, set MOLT_MODEL, or run maat and use /login\n",
    );
    return 2;
  }
  const engine = buildEngine(args, true);
  if (args.budget) engine.setBudget(args.budget);
  // Independent: the brief probes tools, the map walks files, the price asks
  // the endpoint. In a row they cost the sum; together, the slowest.
  await Promise.all([primeBrief(engine, args), primeRepoMap(engine, args), priceEngine(engine, args)]);

  let failed = false;
  let sawAnswer = false;
  // Streamed text arrives without a trailing newline, so anything printed
  // after it lands on the same line as the model's last word. Track it and
  // break the line before saying anything of molt's own.
  let midLine = false;

  const emit = (raw: EngineEvent) => {
    // Hidden check commands stay out of the stream until the job releases
    // them: a harness that tees this into a file the worker can read
    // (bench/harbor) would otherwise hand them over (src/withhold.ts).
    const ev = engine.maskEvent(raw);
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
      case "stream_reset":
        // The text above belongs to an attempt that is being replayed from
        // the start. Unhandled, a log showed the answer twice with nothing to
        // say which copy counted.
        process.stdout.write(`· retrying — ${ev.why}. The reply above was abandoned; it starts again below.\n`);
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
        const said = jobEndWords(ev);
        process.stdout.write(
          `· job ${said} · ${ev.steps} step(s) · ${sp.promptTokens} in${cached} · ` +
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
        const did = stepDid(ev.outcome, ev.tools);
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
          `\nchecking ${ev.checks} condition(s) from .maat/done.yml: ${ev.names.join(", ")}\n`,
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
        process.stdout.write(
          ev.result.undetermined?.length
            ? `bar undetermined: required checks were not run\n`
            : `bar not met after ${ev.attempts} attempt${ev.attempts === 1 ? "" : "s"}\n`,
        );
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
      case "checks_released":
        for (const c of ev.checks) process.stdout.write(`· criterion ${c.name}: ${c.run}\n`);
        for (const r of ev.receipts) process.stdout.write(`· full receipt ${r}\n`);
        break;
      case "error":
        process.stderr.write(`maat: ${ev.text}\n`);
        break;
    }
  };

  // Nobody is watching a headless run, so a call that would prompt is
  // refused rather than waited on. Autonomy decides which calls those are:
  // the engine only asks about what the level does not cover.
  const confirm = async (name: string, detail: string) => {
    if (args.sandbox) {
      // Said, not hidden: the journal records every call as approved at
      // this level, and the log says which ones only ran because of the flag.
      process.stderr.write(`maat: sandbox ran ${name} (${detail})\n`);
      return true;
    }
    process.stderr.write(
      `maat: refusing ${name} (${detail}) — raise --autonomy, or pass --yes, for headless work\n`,
    );
    return false;
  };

  const { taskChecks, taskNotes } = criteriaFromArgs(args);
  // Drafted while the model starts reading: the engine seals them before the
  // first change or claim, so they still predate the work (see RunOptions).
  const soFar: { draft?: Draft; sealed?: boolean; late?: boolean } = {};
  // The drafter's inputs, frozen here; the engine journals their hash at turn
  // start and compares it with what each drafter stage actually used.
  const drafterInputs = args.autoCriteria && !ask ? { snapshot: drafterSnapshotFor(args), used: [] as string[] } : undefined;
  // One deadline for everything this job starts before its turn, taken once:
  // the drafter and the reference each used to take their own Date.now(), a
  // little later than the job's, and could wait that much past --for.
  const runDeadlineAt = args.forMs ? Date.now() + args.forMs : undefined;
  const pendingCriteria = drafterInputs ? autoDraft(engine, args, soFar, drafterInputs, runDeadlineAt) : undefined;
  const draftInputs = drafterInputs
    ? { sha: drafterInputsHash(drafterInputs.snapshot), used: () => [...drafterInputs.used] }
    : undefined;
  const criteriaSoFar = pendingCriteria
    ? () => {
        // Nothing reviewed yet: leave the draft running to join at the claim
        // (it is then sealed without the preflight, see sealDraft).
        if (soFar.draft?.checks.length) soFar.sealed = true;
        else soFar.late = true;
        return soFar.draft?.checks.length ? sealDraft(soFar.draft, args) : Promise.resolve({ taskChecks: [], taskNotes: [] });
      }
    : undefined;
  const referenceCheck = args.reference && !ask ? startReference(args, runDeadlineAt) : undefined;
  let undetermined = false;
  /** The turn's own verdict, from job_end. */
  let outcome: string | undefined;
  // How long a timed turn waits for its drafted checks; for tests and debugging.
  const waitEnv = Number(env("CRITERIA_WAIT_MS"));
  const criteriaWait = Number.isFinite(waitEnv) && waitEnv > 0 ? { criteriaWaitMs: waitEnv } : {};
  for await (const ev of engine.run(args.task, confirm, { ask, taskChecks, taskNotes, pendingCriteria, criteriaSoFar, referenceCheck, ...(draftInputs ? { draftInputs } : {}), ...criteriaWait })) {
    emit(ev);
    if (ev.kind === "proof_exhausted" && ev.result.undetermined?.length) undetermined = true;
    // The sentence that explains an undetermined bar arrives as an error, so
    // it is read, but it is not a failure of the work.
    else if (ev.kind === "proof_exhausted" || (ev.kind === "error" && !undetermined)) failed = true;
    if (ev.kind === "assistant_text") sawAnswer = true;
    if (ev.kind === "job_end") outcome = ev.outcome;
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
          ? // "no price" is true of a subscription run but reads as a gap in
            // molt's knowledge. It is not one: nothing was charged.
            acpAgentFor(engine.cfg.baseUrl)
            ? ` · your ${acpAgentFor(engine.cfg.baseUrl)!.label} plan, not metered`
            : " · no price for this model"
          : ` · ${b.costEstimated ? "~" : ""}${fmtCost(b.costUsd)}`) +
        "\n",
    );
  }

  // An unverified answer is not a success. Neither is no answer at all.
  //
  // It still exited 0 when the project had no bar: the one case where nothing
  // was checked read, to CI, exactly like the case where everything was. And
  // a bar that was only partly run (undetermined) exited 1, as though the
  // work had failed something. Three answers, three codes: 0 verified, 1 not
  // met, 3 finished without a verdict. A question (`molt ask`) is answered,
  // not verified, and 0 is the right answer to it.
  if (failed) return 1;
  // Before the answer check: an undetermined turn made its claim and was
  // judged — it just could not be settled — so there is no answer event to wait for.
  if (undetermined) return EXIT_NO_VERDICT;
  if (!sawAnswer) return 1;
  // No project bar and no task criteria: nothing judged the claim, so there
  // is no verdict. With task criteria there is one — a turn that met the
  // criteria it was sealed with is verified, bar or no bar. A benchmark
  // trial read exit 3 on a turn molt had verified, because of this line.
  //
  // Decided by the turn's own outcome, not by counting the criteria passed
  // in: drafted criteria now arrive while the model reads (pendingCriteria),
  // so that count was zero on turns they judged, and a verified turn exited 3.
  if (outcome === "verified" || outcome === "answered") return 0;
  if (!ask && outcome === "unverified") return EXIT_NO_VERDICT;
  if (!ask && !engine.cfg.bar && taskChecks.length === 0 && outcome === undefined) return EXIT_NO_VERDICT;
  return 0;
}

/**
 * `molt acp` — serve the Agent Client Protocol on stdio until the editor
 * closes it.
 *
 * Stdout carries protocol frames and nothing else. One stray line — a
 * library's console.log, a warning printed the ordinary way — and the editor
 * reads garbage where it expected JSON-RPC. So the real writer is taken once,
 * here, and handed to the server; every other write to stdout for the life of
 * the process is sent to stderr instead, where an editor keeps its agent log.
 */
async function cmdAcp(args: Args): Promise<number> {
  const frame = process.stdout.write.bind(process.stdout);
  const toStderr = process.stderr.write.bind(process.stderr) as (s: string) => boolean;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    (process.stderr.write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  const toLog = (...a: unknown[]) => void toStderr(`${formatWithOptions({ colors: false }, ...a)}\n`);
  console.log = toLog;
  console.info = toLog;
  console.debug = toLog;

  const { AcpServer } = await import("./acp-server.js");
  const { discoverModels, readRememberedEndpoints } = await import(
    "./acp-catalog.js"
  );
  const norm = (u: string) => u.trim().replace(/\/+$/, "");
  /**
   * `MOLT_ACP_SUBSCRIPTIONS=grok-build` lists exactly those
   * subscription backends without probing them. The probes spawn each CLI
   * and open a session with it; this skips that, for a machine where the
   * answer is known — and for tests, which must not depend on whose laptop
   * has which CLI signed in.
   */
  const declared = process.env.MOLT_ACP_SUBSCRIPTIONS;
  const subscriptionUsable = async (url: string): Promise<boolean> => {
    if (declared !== undefined) {
      const names = declared.split(",").map((n) => n.trim()).filter(Boolean);
      return names.some((n) => PROVIDERS[n]?.url === url);
    }
    const spec = acpAgentFor(url);
    return spec ? (await acpHealth(spec)).ok : false;
  };
  const waitRaw = Number(process.env.MOLT_ACP_DISCOVERY_WAIT_MS);
  const server = new AcpServer({
    models: {
      discover: () =>
        discoverModels({
          auth: readAuth(),
          stored: storedEndpoint(),
          remembered: readRememberedEndpoints(defaultConfigDir()),
          current: { url: args.url, key: args.key, model: args.model || undefined },
          listModels: (url, key) => new Engine({ baseUrl: url, apiKey: key, model: "probe", bar: null }).listModels(url, key),
          subscriptionUsable,
          log: (line) => void toStderr(`molt acp: ${line}\n`),
        }),
      ...(Number.isFinite(waitRaw) && waitRaw >= 0 ? { waitMs: waitRaw } : {}),
      // What /model does in the terminal: point the engine, remember the
      // choice in config.json, and re-price for the model now running.
      apply: async (engine, url, model) => {
        const flagged = norm(url) === norm(args.url);
        const key = keyForUrl(url, flagged ? args.key : undefined);
        if (norm(engine.baseUrl) !== norm(url)) engine.setBaseUrl(url, key, providerName(url));
        engine.setModel(model);
        saveEndpoint(url, model);
        if (flagged && model === args.model && args.priceSource === "set by hand") {
          engine.setPricing({ in: args.priceIn, out: args.priceOut, source: "set by hand" });
          return;
        }
        // A price belongs to a model, and a plan is not a price.
        engine.setPricing({});
        if (planFor(url)) return;
        await priceEngine(engine, { ...args, url, model, key, priceIn: undefined, priceOut: undefined });
      },
    },
    write: (line) => void frame(line),
    version: VERSION,
    log: (line) => void toStderr(`${line}\n`),
    // No model is not a reason to refuse the session any more: the editor's
    // model picker can choose one, and a prompt without one is refused with
    // a sentence saying so.
    newEngine: async ({ cwd, files }) => {
      const a: Args = { ...args, cwd };
      const engine = engineFor(a, true, { files });
      if (a.budget) engine.setBudget(a.budget);
      await primeRepoMap(engine, a);
      await priceEngine(engine, a);
      return engine;
    },
  });

  return new Promise<number>((done) => {
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      server.close();
      // Frames already written may still be queued on a pipe; exiting before
      // they drain would drop the last answers the editor is waiting for.
      // Bounded, because a pipe that broke will never drain.
      const late = setTimeout(() => done(0), 1000);
      frame("", () => {
        clearTimeout(late);
        done(0);
      });
    };
    // The editor closing the pipe is the end of the session, and so is a
    // write to a pipe nobody reads any more.
    process.stdout.on("error", end);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d: string) => server.feed(d));
    process.stdin.on("end", end);
    process.stdin.on("error", end);
  });
}

async function cmdProve(args: Args): Promise<number> {
  if (!hasBar(args.cwd)) {
    process.stderr.write("maat: no .maat/done.yml here. run `maat init` first.\n");
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
  if (result.ok) return 0;
  const failedAny = result.results.some((r) => !r.ok && !r.advisory && !r.skipped);
  return result.undetermined?.length && !failedAny ? EXIT_NO_VERDICT : 1;
}

function cmdInit(args: Args): number {
  const { path, detected, existed } = writeDefaultBar(args.cwd);
  if (existed) {
    process.stdout.write(`maat: ${path} already exists, left alone\n`);
    return 0;
  }
  process.stdout.write(`maat: wrote ${path}\n\n`);
  if (detected.length === 0) {
    process.stdout.write(
      "Maat found no build or test commands in this project, so the bar only proves\n" +
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
  process.stdout.write("\nCheck it over — it is your file, and Maat only wrote a first draft.\n");
  return 0;
}

async function cmdDoctor(args: Args): Promise<number> {
  const engine = buildEngine(args);
  const d = await engine.doctor();
  process.stdout.write(`endpoint: ${args.url}\n`);
  process.stdout.write(`model:    ${args.model}\n`);
  process.stdout.write(`bar:      ${hasBar(args.cwd) ? ".maat/done.yml" : "MISSING — completions unverified"}\n`);
  process.stdout.write(`${d.ok ? "ok" : "FAIL"}: ${d.detail}\n`);
  return d.ok && hasBar(args.cwd) ? 0 : 1;
}

async function cmdReceipts(args: Args): Promise<number> {
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
        `${report.alreadyMissing} already marked missing\n` +
        `${report.backfilled} given the change count their receipt body records\n`,
    );
    process.stdout.write(
      report.marked === 0 && report.backfilled === 0
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
          `maat: "${indexed.file}" is in the receipts index but its file is missing from ` +
            `${stateDir(args.cwd, "receipts")}. The record of it survives; the receipt ` +
            `itself does not.\n`,
        );
        return 2;
      }
      process.stderr.write(`maat: no receipt matching "${args.show}"\n`);
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
    const tree = r.head ? `  @${r.head.slice(0, 7)}${r.dirty ? "+" : ""}` : "";
    process.stdout.write(
      `${r.file}  ${r.verdict.padEnd(12)} attempt ${r.attempt}  ${r.model}  ${r.sessionTokens} tok${tree}${failed}${gone}\n`,
    );
  }
  // The receipt outranks anything that summarises the work, so the listing
  // ends by checking the summary nobody wrote down: that the tree in front of
  // you is the one the latest verdict was about.
  const latest = rows.at(-1)!;
  if (latest.head) {
    const drift = await driftSince(args.cwd, latest.head, latest.dirty === true);
    process.stdout.write(
      `\nlatest: ${latest.file} (${latest.verdict}) judged ${latest.head.slice(0, 7)}` +
        `${latest.dirty ? " + uncommitted changes" : ""} — ${describeDrift(drift)}\n`,
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
      process.stderr.write("maat: --show takes an exuvia index, e.g. --show 0\n");
      return 2;
    }
    try {
      process.stdout.write(archive.read(n));
      return 0;
    } catch (e) {
      process.stderr.write(`maat: ${String(e)}\n`);
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
      `  exhausted             ${s.exhausted}\n` +
      (s.undetermined ? `  undetermined          ${s.undetermined}  (required checks not run — neither accepted nor refused)\n` : "") +
      "\n" +
      `false-claim rate        ${rate}\n` +
      `verified changes        ${s.verifiedChanges}` +
      (s.answered || s.unchanged
        ? `  (not counted: ${[
            s.answered ? `${s.answered} accepted answer(s) to questions` : "",
            s.unchanged ? `${s.unchanged} accepted with no file changed` : "",
          ]
            .filter(Boolean)
            .join(", ")})\n`
        : "\n") +
      `tokens per verified change  ${s.tokensPerVerifiedChange ?? "—"}\n` +
      `cost per verified change    ${
        s.usdPerVerifiedChange === undefined
          ? "—"
          : `${s.costEstimated ? "~" : ""}$${s.usdPerVerifiedChange.toFixed(4)}  (priced sessions only)`
      }\n\n`,
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
  return { file: stateDir(args.cwd, "log", pick) };
}

function cmdLog(args: Args): number {
  const found = resolveSession(args);
  if ("miss" in found) {
    if (found.miss === "empty") {
      process.stdout.write("no session log in this project yet\n");
      return 0;
    }
    process.stderr.write(
      `maat: no session log starting "${args.session}" — ${found.count} session(s) in ` +
        `${stateDir(args.cwd, "log")}. \`maat log\` alone reads the most recent.\n`,
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
  const open = Journal.unfinished(entries);
  if (open) {
    process.stdout.write(
      `\nno recorded end: the log stops at a ${open.kind} (${open.iso.slice(0, 19).replace("T", " ")}Z), ` +
        "mid-turn. The process was killed, crashed, or the window was closed; the last " +
        "receipt is its final word, and anything still showing this session as working is stale.\n",
    );
  }
  process.stdout.write(
    "\nEvery line above is recomputed from the log, not narrated. Values marked ~ are\n" +
      "estimates (chars/4) because the provider did not report usage; everything else\n" +
      "is measured. `maat verify` recomputes the hash chain. `--raw` prints the JSONL.\n",
  );
  return check.ok ? 0 : 1;
}

/**
 * `maat judge`. Interactive only on a terminal: piped, it lists, so a script
 * can never sit waiting for a ruling nobody will type.
 */
async function judge(args: Args): Promise<number> {
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  let rl: import("node:readline/promises").Interface | undefined;
  try {
    return await cmdJudge(
      { cwd: args.cwd, task: args.task, notes: args.notes, json: args.json, version: VERSION },
      {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
        ask: tty
          ? async (prompt) => {
              rl ??= (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
              try {
                return await rl.question(prompt);
              } catch {
                return null;
              }
            }
          : undefined,
      },
    );
  } finally {
    rl?.close();
  }
}

function cmdVerify(args: Args): number {
  const files = Journal.sessions(args.cwd);
  // No logs is not the end of the question. It returned here, exit 0, before
  // the integrity chain was read — so deleting every session log, which is
  // the one tampering the chain exists to name, was reported as a project
  // with nothing to verify. The chain still binds those logs; ask it.
  if (files.length === 0) process.stdout.write("no session logs on disk\n");
  let bad = 0;
  let empty = 0;
  for (const f of files) {
    const path = stateDir(args.cwd, "log", f);
    const r = Journal.verify(path);
    // A log with nothing in it is not a log that verified. "ok  0 entries"
    // was printed for a zero-byte file and counted among the logs verified —
    // the same word for a chain that held and a chain that was never there.
    if (r.ok && r.entries === 0) {
      empty++;
      process.stdout.write(`none  ${f}  0 entries — nothing to verify\n`);
      continue;
    }
    const open = r.ok ? Journal.unfinished(Journal.read(stateDir(args.cwd, "log", f))) : null;
    process.stdout.write(
      `${r.ok ? "ok  " : "FAIL"}  ${f}  ${r.entries} entries` +
        (open ? `  · no recorded end (stops at ${open.kind})` : "") +
        `${r.ok ? "" : `\n      ${r.reason}`}\n`,
    );
    if (!r.ok) bad++;
  }
  const verified = files.length - empty - bad;
  if (files.length) {
    process.stdout.write(
      bad === 0
        ? `\n${verified} log(s) verified${empty ? ` · ${empty} empty log(s) hold nothing to verify` : ""}. Each entry hashes its predecessor, so any\nalteration or deletion breaks the chain from that point on.\n`
        : `\n${bad} log(s) failed verification.\n`,
    );
  }

  // The cross-link: journals, receipts and exuviae are only as trustworthy as
  // the binding that connects them. Verify the project-level integrity chain
  // too, and report the root of trust that can be shipped elsewhere.
  const i = Integrity.verify(args.cwd);
  const root = Integrity.exportRoot(args.cwd);
  if (i.drift.length) process.stdout.write(`\n${driftLines(i.drift)}\n`);

  if (!i.established) {
    // Nothing has been bound. Printing "ok" would count a check that read no
    // records as one that passed, and printing the genesis hash as a root of
    // trust would hand over a constant that is identical in every project and
    // matches whatever these files are changed to later.
    process.stdout.write(
      `integrity chain    none — no records, so nothing is bound yet\n` +
        (i.unbound.length
          ? `                   ${i.unbound.length} receipt(s)/exuvia(e) here predate the ledger\n`
          : "") +
        `                   a root of trust appears once a session binds its first receipt\n`,
    );
  } else {
    const integrityStatus = i.ok ? `ok  ${i.records} record(s)` : `BROKEN ${i.records} record(s)${i.reason ? `\n      ${i.reason}` : ""}`;
    process.stdout.write(`integrity chain    ${integrityStatus}\n`);
    // What the chain does not reach is part of its verdict. Silence here
    // would let "ok" be read as "all of this evidence is verified".
    if (i.unbound.length) {
      process.stdout.write(
        `                   ${i.unbound.length} artifact(s) on disk are not bound by it\n`,
      );
    }
    if (i.ok && !bad) {
      process.stdout.write(`\nroot of trust: ${root.root}\n`);
    }
  }

  process.stdout.write(
    "\nThis is tamper EVIDENCE, not tamper prevention: anyone with write access can\nrewrite a log and re-chain it. What it rules out is a silent edit.\n",
  );
  return bad === 0 && i.ok ? 0 : 1;
}

function driftLines(drift: { kind: string; file: string; bound: string }[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const d of drift) {
    const key = `${d.kind}:${d.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`      ${d.kind} ${d.file} no longer matches its bound hash (${d.bound})`);
  }
  return lines.length ? lines.join("\n") : "";
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  // The task text is on our command line, so `pkill -f server.py` from a model
  // restarting the task's server matched molt itself and killed the run
  // (Terminal-Bench kv-store-grpc, rstan-to-pystan: exit 143, no verdict).
  // A plain title keeps the task out of `ps`, `pgrep -f` and `pkill -f`.
  if (argv.length > 1) process.title = "maat";
  let args: Args;
  try {
    args = parseArgs(argv, storedEndpoint());
  } catch (e) {
    process.stderr.write(`maat: ${(e as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  // The judge is read where checks are drafted and claims reviewed (judge.ts).
  if (args.judge) process.env.MAAT_JUDGE_MODEL = args.judge;
  if (args.judgeUrl) process.env.MAAT_JUDGE_URL = args.judgeUrl;
  if (args.version) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (!existsSync(args.cwd)) {
    process.stderr.write(`maat: no such directory: ${args.cwd}\n`);
    return 2;
  }

  // Before anything else can print: from here on stdout is the protocol.
  if (args.acp || args.cmd === "acp") return cmdAcp(args);

  // Privilege separation, when asked for: before any record is opened, so
  // every one of them is made in the private state dir (src/privsep.ts).
  const worker = workerUserFrom(args.workerUser);
  const checker = checkUserFrom(args.checkUser);
  const separates = args.cmd === "run" || args.cmd === "ask" || (args.cmd === "mission" && (args.task ?? "").split(" ")[0] === "run");
  if (!worker && separates && (checker || args.workerStrict)) {
    process.stderr.write(`maat: ${args.workerStrict ? "--worker-strict" : "--check-user"} needs --worker-user (MAAT_WORKER_USER)\n`);
    return 2;
  }
  if (worker && separates) {
    let ps: PrivSep | undefined;
    try {
      ps = enablePrivSep({
        user: worker,
        project: args.cwd,
        helper: fileURLToPath(new URL("./fs-helper.js", import.meta.url)),
        notice: (t) => process.stderr.write(`maat: ${t}\n`),
        ...(checker ? { checkUser: checker } : {}),
        strict: args.workerStrict === true,
      });
    } catch (e) {
      // --worker-strict, or MAAT_WORKER_PIDNS=1, means refuse. Otherwise the
      // job goes on unseparated, and every receipt and the journal say so.
      if (args.workerStrict || process.env.MAAT_WORKER_PIDNS === "1") {
        process.stderr.write(`maat: ${(e as Error).message}\n`);
        return 2;
      }
      process.stderr.write(`maat: ${(e as Error).message}; carrying on WITHOUT privilege separation (--worker-strict refuses instead)\n`);
      setIsolationLine(`isolation: none (worker tools and checks run as Maat, uid ${process.getuid?.() ?? "?"}: ${(e as Error).message})`);
    }
    if (ps) {
      process.stderr.write(
        `maat: worker tools run as ${ps.worker.name} (uid ${ps.worker.uid})` +
          `${ps.pidns ? " in their own PID namespace" : ""}` +
          `${ps.check ? `; task checks run as ${ps.check.name} (uid ${ps.check.uid})` : ""}; Maat's records are in ${ps.stateRoot} until the job ends\n` +
          `maat: ${ps.isolation()}\n`,
      );
    }
    try {
      return args.cmd === "mission" ? await cmdMission(args) : await cmdRun(args, args.cmd === "ask");
    } finally {
      if (ps) {
        try {
          const dest = ps.publish();
          process.stderr.write(`maat: records copied to ${dest}\n`);
        } catch (e) {
          process.stderr.write(`maat: could not copy the records from ${ps.stateRoot} into the project: ${(e as Error).message}\n`);
        }
      }
      disablePrivSep();
      setIsolationLine(undefined);
    }
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
      return await cmdReceipts(args);
    case "archive":
      return cmdArchive(args);
    case "stats":
      return cmdStats(args);
    case "log":
      return cmdLog(args);
    case "verify":
      return cmdVerify(args);
    case "judge":
      return await judge(args);
    case "attempts":
      return cmdAttempts(args);
    case "mission":
      return await cmdMission(args);
    case "":
      break;
    default:
      process.stderr.write(`maat: unknown command "${args.cmd}"\n\n${USAGE}\n`);
      return 2;
  }

  if (!process.stdout.isTTY) {
    process.stderr.write('maat: not a terminal. use `maat run "<task>"` for headless work.\n');
    return 2;
  }

  const engine = buildEngine(args);
  if (args.budget) engine.setBudget(args.budget);
  // Before the window opens, so the first request already knows what is here.
  await primeBrief(engine, args);
  await primeRepoMap(engine, args);

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
  process.argv[1] && (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("maat") || process.argv[1].endsWith("molt"));

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`maat: ${String(e)}\n`);
      process.exit(1);
    },
  );
}
