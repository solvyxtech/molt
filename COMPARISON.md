# The honest map

## What already exists (don't kid yourself)

**Pi** (pi.dev) owns minimalism: a sub-1K-token system prompt vs ~10K
for Claude Code/OpenCode, four tools, multi-provider, tree sessions,
compaction, an extension ecosystem, and external validation — a
Databricks benchmark found it beat every harness tested at lower cost
because it sends roughly 3x less context per turn
([tensorlake](https://www.tensorlake.ai/blog/pi-coding-agent-efficient-system-prompting),
[deep dive](https://academy.kspl.tech/blog/2026-06-05-pi-agent-deep-dive-2026)).
**OpenCode** owns polished open-source model-agnostic. The first-party
CLIs (Claude Code, Codex, Gemini) own batteries-included and have
converged on identical feature sets
([analysis](https://pub.towardsai.net/claude-code-vs-codex-cli-vs-gemini-cli-vs-opencode-the-real-differences-after-convergence-fe71401f3f8e)).

If you want maximum capability per dollar today: use Pi. Seriously.

## What users are loudly asking for that nobody ships

Compaction is the loudest complaint in the category. Claude Code's own
issue tracker: auto-compact "causes context loss and degraded
performance" ([#13112](https://github.com/anthropics/claude-code/issues/13112)),
triggers mid-task causing hallucinations and derailment with no user
control ([#10948](https://github.com/anthropics/claude-code/issues/10948));
analyses describe repeated compaction as lossy compression stacking
until information is permanently gone
([bytebell](https://bytebell.ai/blog/claude-code-compacting-losing-work/),
[golev](https://golev.com/post/claude-saves-tokens-forgets-everything/)).
Users explicitly request manual control and preservation. Every harness
answers with a *better summary*. molt answers with **no summary**:
deterministic digest, full archive on disk, reversible.

## The gaps molt actually fills

1. **Lossless, consensual compaction.** `/shed` is user-triggered,
   mechanical (0 tokens, 0 hallucination), archives the full history as
   an exuvia file, is reversible via `/regrow`, and refuses to run if
   it wouldn't shrink context. No shipping harness does any of these.
2. **Cost observability as the product, not a footnote.** Pi is
   efficient but doesn't make the invoice a first-class UI. molt's
   `/bom`, per-turn receipts, and measured-at-startup prompt size treat
   context like a bill of materials — every token accounted for, every
   truncation visible.
3. **Hard budgets.** No harness ships a token budget that *stops the
   loop*. molt does. Set `/budget 50000` and the session cannot
   overspend — the failure mode is a message, not an invoice.
4. **Safety gates in the core.** Pi's default is YOLO — reviewers note
   you must build your own confirmation flow before autonomous runs are
   safe ([review](https://academy.kspl.tech/blog/2026-06-05-pi-agent-deep-dive-2026)).
   molt gates bash/write by default. Small tools should be safe tools.
5. **A tested UI layer.** An empirical study of 3.8K issues across the
   big CLIs found ~18% of bugs in the UI/usability layer
   ([arXiv](https://arxiv.org/html/2603.20847)). molt's UI is its only
   layer, driven by synthetic hostile streams in CI.
6. **Small enough to audit.** Plus `/wire` (exact last request JSON on
   disk) and `/race` (side-by-side model probes with receipts) —
   transparency primitives, ~850 lines total. ~700 lines, 4 source files, 2 runtime
   dependencies (ink, react). No SDK, no framework, no telemetry.

## What molt does not claim

- Not more capable than Pi/OpenCode/Claude Code — less, on purpose.
- Not "revolutionary." It is a measured, budgeted, gated harness in a
  field that ships none of those three by default.
