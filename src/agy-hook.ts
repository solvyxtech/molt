/**
 * A `PreToolUse` gate, so Antigravity brings no tools of its own.
 *
 * Claude Code takes `tools: []` and Grok takes an agent profile. `agy` has
 * neither, and the permission system alone is not equivalent: a tool it denies
 * still *ends the turn*, so molt's first step was spent on Antigravity trying
 * its own `read_file`, being refused, and stopping with nothing said. The
 * work got done on step two. One wasted step per turn is not a backend.
 *
 * A hook is the difference, because `PreToolUse` returns a `reason` that is
 * shown to the *agent*: it is told, in the same turn, that molt runs every
 * tool and which ones to call instead. Measured — the same task that took two
 * steps takes one, with no builtin attempts at all.
 *
 * ## Why this is safe to install globally
 *
 * Hooks live in `~/.gemini/config/hooks.json`, which applies to every session
 * on the machine, including the ones you run yourself. Gating those would be
 * molt reaching well outside its own turn.
 *
 * So the first thing this does is look for `MOLT_MCP_URL`. molt sets it on the
 * `agy` process it spawns, and a hook `agy` spawns inherits it — the same
 * measured fact the MCP bridge relies on. Without it this exits silently with
 * no opinion, and your own sessions behave exactly as they did before molt was
 * installed.
 *
 * ## Why an allow-list
 *
 * Named tools, not a pattern: a denylist would quietly admit whatever
 * Antigravity adds next, and this file is meant to be the complete statement
 * of what an agent may do without going through molt. The listed few are
 * bookkeeping — they touch no file, run no command, and reach no network.
 */
const ALLOWED = new Set([
  // molt's own tools arrive through this one.
  "call_mcp_tool",
  // Bookkeeping the agent needs to end a turn tidily. None of these touch the
  // world; denying them wedges the loop without protecting anything.
  "finish",
  "todo_write",
  "manage_task",
  "wait",
  "ask_question",
  "ask_permission",
  "ask_custom_permission",
]);

async function main(): Promise<void> {
  // No molt session on the other end: say nothing, decide nothing.
  if (!process.env.MOLT_MCP_URL) return;

  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;

  let name = "";
  try {
    name = ((JSON.parse(raw) as { toolCall?: { name?: string } }).toolCall?.name ?? "").trim();
  } catch {
    /* A payload this cannot read is not one it should judge. */
  }

  if (!name || ALLOWED.has(name)) {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  /**
   * The reason is the whole point. It reaches the model, so the turn corrects
   * itself rather than ending — and it names the tools that do work, because
   * "denied" with no alternative is how a model concludes it cannot proceed.
   */
  process.stdout.write(
    JSON.stringify({
      decision: "deny",
      reason:
        `molt runs every tool in this session, so the work lands on its ledger and can be ` +
        `checked. '${name}' is not available here. Use molt's tools instead — read_file, ` +
        `write_file, edit_file, list_dir, grep, bash — which do the same jobs.`,
    }),
  );
}

void main();
