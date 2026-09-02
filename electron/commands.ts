/**
 * Running a slash command against the engine.
 *
 * The palette itself — what matches what, and in which order — is
 * `src/commands.ts`, shared verbatim with the terminal. This file is only the
 * half that needs an engine: the commands that read or change session state.
 *
 * It lives in the main process for the same reason everything else does. The
 * renderer has no engine and no filesystem, and giving it fifteen new IPC
 * methods so it could assemble these strings itself would widen the bridge for
 * no gain. Commands that are purely about the window — switching a tab,
 * cycling the theme, opening the model picker — are handled in the renderer
 * and never reach here.
 */
import { loadBar, BarError } from "../src/bar.js";
import {
  cmdAttempts,
  cmdAutoShed,
  cmdCommit,
  cmdFor,
  cmdMap,
  cmdRead,
  cmdRevert,
  cmdUndo,
} from "../src/session-commands.js";
import type { Engine } from "../src/engine.js";
import type { BarResult } from "../src/types.js";

export type CommandOutcome =
  | { kind: "info"; text: string }
  | { kind: "error"; text: string }
  | { kind: "bar"; result: BarResult }
  | { kind: "unhandled" };

const usd = (n: number): string => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/**
 * `/budget 40000` is a token ceiling for the session; `/budget $2.50` is a
 * money ceiling for one turn. Both spellings exist because a context window is
 * measured in tokens and a bill is measured in money, and people reach for
 * whichever unit their worry is in.
 */
function budget(engine: Engine, arg: string): CommandOutcome {
  if (!arg) return { kind: "info", text: "usage: /budget <tokens|$usd|off>" };
  if (arg === "off") {
    engine.setBudget(undefined);
    return { kind: "info", text: "budget off — no session token ceiling" };
  }
  const money = /^\$?([\d.]+)\s*(usd)?$/i.exec(arg);
  if (arg.startsWith("$") || /usd$/i.test(arg)) {
    const n = Number(money?.[1]);
    if (!Number.isFinite(n) || n <= 0) return { kind: "error", text: `not a spend ceiling: ${arg}` };
    engine.setTurnBudgetUsd(n);
    return { kind: "info", text: `turn ceiling ${usd(n)} — a turn stops there and asks` };
  }
  const n = Number(arg.replace(/[_,]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return { kind: "error", text: `not a token budget: ${arg}` };
  engine.setBudget(n);
  return { kind: "info", text: `session budget ${n} tokens` };
}

function price(engine: Engine, arg: string): CommandOutcome {
  const p = engine.pricing();
  if (arg === "off") {
    engine.setPricing({});
    return { kind: "info", text: "pricing off — no cost shown" };
  }
  const two = arg.split(/\s+/).filter(Boolean).map(Number);
  if (two.length === 2 && two.every((n) => Number.isFinite(n) && n >= 0)) {
    engine.setPricing({ in: two[0], out: two[1], source: "set by hand" });
    return { kind: "info", text: `pricing set: $${two[0]}/1M in, $${two[1]}/1M out` };
  }
  if (p.in === undefined && p.out === undefined) {
    return {
      kind: "info",
      text: "no price known for this model — /price <in> <out> to set one, per 1M tokens",
    };
  }
  return {
    kind: "info",
    text:
      `$${p.in ?? "?"}/1M in · $${p.out ?? "?"}/1M out` +
      (p.cached === undefined ? "" : ` · $${p.cached}/1M cached`) +
      (p.source ? ` · ${p.source}` : ""),
  };
}

export async function runEngineCommand(
  engine: Engine,
  name: string,
  arg: string,
): Promise<CommandOutcome> {
  switch (name) {
    case "/bom": {
      const b = engine.bom();
      return {
        kind: "info",
        text:
          `system ${b.systemTokens} · tools ${b.toolSchemaTokens} · history ${b.historyTokens} · ` +
          `request ≈ ${b.requestTotalEst} · session ${b.sessionPromptTokens + b.sessionCompletionTokens}` +
          (b.budgetTokens ? ` / ${b.budgetTokens}` : "") +
          (b.sessionCachedTokens > 0 ? ` · ${b.sessionCachedTokens} cached` : "") +
          (b.costUsd === undefined ? "" : ` · ${b.costEstimated ? "~" : ""}${usd(b.costUsd)}`),
      };
    }

    case "/budget":
      return budget(engine, arg);

    case "/price":
      return price(engine, arg);

    case "/stats": {
      const st = engine.receipts?.stats();
      if (!st || st.attempts === 0)
        return { kind: "info", text: "no completion attempts recorded yet" };
      return {
        kind: "info",
        text:
          `${st.attempts} attempts · ${st.accepted} accepted · ${st.verifiedChanges} verified change(s)` +
          (st.answered ? ` · ${st.answered} answered question(s), not counted` : "") +
          ` · false-claim rate ${(st.falseClaimRate * 100).toFixed(1)}% · ` +
          `${st.tokensPerVerifiedChange ?? "—"} tokens per verified change` +
          (st.usdPerVerifiedChange === undefined
            ? ""
            : ` · ${st.costEstimated ? "~" : ""}${usd(st.usdPerVerifiedChange)} per verified change (priced sessions)`),
      };
    }

    case "/shed": {
      if (arg === "--explain" || arg === "explain") {
        const plan = engine.explainShed();
        if (!plan) return { kind: "info", text: "nothing worth shedding yet" };
        return {
          kind: "info",
          text:
            `would drop ${plan.droppedCount} message(s) · ` +
            `${plan.beforeTokens} → ${plan.afterTokens} tokens`,
        };
      }
      const shed = engine.shed();
      if (!shed) return { kind: "info", text: "nothing worth shedding yet" };
      return {
        kind: "info",
        text:
          `archived ${shed.dropped} message(s) · ` +
          `${shed.before} → ${shed.after} tokens · ${shed.path}`,
      };
    }

    case "/regrow": {
      if (!arg) return { kind: "error", text: "usage: /regrow <pattern>" };
      const r = engine.regrowMatching(arg);
      return {
        kind: "info",
        text:
          r.hits === 0
            ? `nothing in the archive matches /${arg}/`
            : `re-attached ${r.attached} of ${r.hits} match(es) · +${r.tokens} tokens of context`,
      };
    }

    case "/archive": {
      const archive = engine.archive;
      if (!archive) return { kind: "info", text: "no archive configured" };
      const entries = archive.list();
      if (entries.length === 0) return { kind: "info", text: "nothing archived this session" };
      const rows = entries
        .filter((e) => !arg || JSON.stringify(e).toLowerCase().includes(arg.toLowerCase()))
        .map(
          (e) =>
            `  ${String(e.index).padStart(4, "0")} ${e.file} · ${e.messages} message(s) · ` +
            `${e.bytes}B · ${e.firstAsk}`,
        );
      return {
        kind: "info",
        text: rows.length ? rows.join("\n") : `nothing archived matches ${arg}`,
      };
    }

    case "/wire":
      return { kind: "info", text: engine.lastRequestBody ?? "(nothing sent yet)" };

    case "/bar": {
      try {
        const bar = loadBar(engine.cwd);
        if (!bar) return { kind: "info", text: "no .molt/done.yml — /init to create one" };
        return {
          kind: "info",
          text: bar.checks
            .map((c) => `  ${c.name}: ${c.kind === "command" ? c.run : `builtin ${c.builtin}`}`)
            .join("\n"),
        };
      } catch (e) {
        return { kind: "error", text: e instanceof BarError ? e.message : String(e) };
      }
    }

    case "/prove": {
      const result = await engine.proveNow();
      if (!result) return { kind: "info", text: "no bar to check — /init to create one" };
      return { kind: "bar", result };
    }

    // One implementation, two surfaces. These are the first commands in the
    // program that are not written twice, which is why they are the first
    // that cannot drift apart.
    case "/commit":
      return cmdCommit(engine, arg);

    case "/revert":
      return cmdRevert(engine, arg);

    case "/undo":
      return cmdUndo(engine);

    case "/for":
      return cmdFor(engine, arg);

    case "/attempts":
      return cmdAttempts(engine, arg);

    case "/autoshed":
      return cmdAutoShed(engine, arg);

    case "/map":
      return cmdMap(engine, arg);

    case "/read":
      return cmdRead(engine, arg);

    default:
      return { kind: "unhandled" };
  }
}
