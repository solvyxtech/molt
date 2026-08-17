# Prior art

molt is not the first tool to notice that agents declare victory too early,
and it does not invent the ideas it combines. This page names what came
before, accurately, because a project whose entire pitch is refusing to
overclaim cannot start by overclaiming.

If something here is described wrongly, that is a bug — please file it.

## Completion gates

**Claude Code hooks.** A `Stop` hook exiting 2 blocks the end of a turn and
returns stderr to the model, which then keeps working. This is a real,
shipped, general mechanism, and it can enforce a test gate today. It is
opt-in: you write the script, wire it into `settings.json`, and handle
loop-safety via `stop_hook_active` yourself.

molt's difference is *default*, not *capability*. If you already run a Stop
hook that gates on your suite, you have most of what molt's proof loop does.

**Harness-engineering literature.** The pattern — termination criteria owned
by the harness, verification/validation dual gates, planner/generator/evaluator
splits — is well described in 2026 writing on agent harnesses. molt is an
implementation of an idea the field had already articulated.

**Bolt-on verifiers.** ProofShot records video evidence for UI work.
Orchestrators like swarm runners verify each step against an isolated git
branch. Agent-forensics suites sign and replay runs. These are agent-agnostic
by design, which is their strength and their ceiling: they observe from outside
and cannot reach a case where the evidence was destroyed by compaction.

## Context compaction

**Claude Code microcompact.** A deterministic pass that clears old tool
results before the expensive summarization tier. No model call. molt's
`shed` is not the first mechanical compaction in a coding agent.

**OpenCode.** Prunes old tool outputs before full compaction.

**Transcript archives.** Claude Code writes session transcripts to disk, and
`/rewind` offers checkpoint-scoped summarization. Keeping the original around
is not novel either.

**Server-side compaction.** Anthropic's API offers automatic summarization at
a token threshold.

## What molt does differently

Not "first" — different, and specifically:

1. **The bar is a committed file, not a hook script.** `.molt/done.yml` is
   versioned, reviewable, and portable in principle across harnesses. A hook
   is code in one tool's config format.

2. **The gate is the default contract.** No configuration required for the
   refusal loop to exist. A project without a bar is warned on every launch.

3. **Verification reads from a record the same harness preserved.** This is
   the piece that is not a bolt-on. When a claim references work from forty
   turns ago, molt checks the original, because `shed` archived it and
   `record-intact` proves the archive is whole. A harness that summarized the
   original away has nothing to check against, and an external verifier does
   not own the context to begin with.

4. **The bar cannot be lowered by the work being judged against it.** The
   fingerprint check turns an instruction into a control.

5. **Trustworthiness is measured, not asserted.** `molt stats` reports
   false-claim rate and tokens per verified change from the receipt index,
   and `rnd/grade.mjs` runs the same scenarios against any harness.

That combination is what molt is. Each ingredient exists somewhere; the
bundle is a product position, not a moat. The durable part is (3), because
it requires owning both compaction and verification in one harness.

## Why the gap might exist

Worth saying plainly, because it explains more than "nobody thought of it":

A harness that refuses to declare victory produces slower demos, lower
apparent completion rates, and worse benchmark numbers. A vendor whose growth
metric is tasks completed has no reason to ship the thing that makes that
number honest.

That is a structural gap rather than a technical one — which is the only kind
a small project can hold.
