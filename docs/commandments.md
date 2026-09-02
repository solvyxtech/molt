# The commandments

Rules that apply to every run, whatever model is behind it.

Every entry here was bought with a run that went wrong. None of them is a
preference, and none was written because it sounded wise — each names the
failure that produced it, so that a later reader can ask whether that failure
is still possible rather than whether the rule still sounds good. A rule
nobody can trace to a failure should be deleted, because the cost of a rule is
not its tokens but the attention it takes from the others.

## Three tiers, and the rule about which to use

A rule can live in one of three places, and they are not equally strong.

1. **Refused at the tool boundary.** The model cannot proceed. `write_file`
   refusing a unified diff as its payload; a read-only path; the autonomy gate
   on an irreversible command.
2. **Checked at the bar.** The claim is refused after the fact, with the
   evidence attached. `files-changed`, `claims-grounded`, `diff-covered`,
   `mutation`, `spec-intact`.
3. **Stated in the prompt.** Advisory. A model may ignore it.

> **Anything enforceable at tier 1 or 2 must never live only at tier 3.**

The prompt is for what cannot be mechanised. When somebody works out how to
check a prompt rule, it is promoted and the prose is cut — see `spec-intact`
below, which began as a sentence and became a builtin within a day.

## The rules

### 1. Claim only what the record shows
*Tier 2 — `claims-grounded`, `record-intact`.*

An agent naming a file it never created is a documented failure mode. The
claim is checked against the session's own write ledger, not against the
model's confidence. Extended 2026-09-01: a claim that a file was **created**
is a claim of a write, and only the ledger can ground it — a file that merely
already existed does not.

### 2. A file you created and then removed is not work
*Tier 2 — `files-changed`.*

A local 30B wrote `test-duration.js` to verify its own change, renamed it to
`.cjs` so node would run it under an ESM package, and was told its work had
not landed. It then spent its last attempt fighting that message instead of
the real failure beside it. Created-and-gone contributes nothing to the tree,
so it is named and not fatal — unless *every* write vanished, or the claim
names the path.

### 3. Changing behaviour obliges you to reconcile the tests that pinned it
*Tier 3 — the prompt.*

`qwen3-coder-30b` implemented a change correctly and then **added** an
assertion for the new behaviour beside the one asserting the old, four runs
running, leaving the suite red. It was shown the failing assertion 32 times
across 19 test runs; it was never short of information, it was short of the
rule. Told the rule up front, it reconciled and passed. This is the clearest
evidence in the project that a sentence can lift a weak model over the bar.

### 4. A test that contradicts your change is not an obstacle to remove
*Tier 2 — `spec-intact`. Also stated at tier 3, to save a wasted attempt.*

Asked to prove a defect with a failing test, Mercury 2.5 opened the test that
pinned the existing behaviour and inverted it — `assert.equal(r.ok, true)`
became `assert.equal(r.ok, false)` — so the suite agreed with the change it
had already made. Red-before-green is satisfied by that trivially and it
proves nothing: the specification was rewritten to match the code. Deleting an
assertion now fails the bar. `removals: allow` exists for a genuinely obsolete
test, and is deliberately awkward, because that is a decision somebody should
make on purpose.

### 5. State input, wrong output, and right output — or you have not found a defect
*Tier 3 — task prompts for review and bug-hunting work.*

Without it, "find a bug" invites invention, and `files-changed` pushes in the
same direction by requiring that something change.

### 6. Quote the authority you are judging against
*Tier 3, promotable.*

Mercury cited a comment as proving a defect. The comment said the opposite —
it explained the behaviour and endorsed it. Requiring the quote is what made
the failure legible; without it, a plausible-sounding claim would have been
accepted. **This one is promotable to tier 2**: whether a quoted string
appears verbatim in the file it cites is a `grep`, not a judgement.

### 7. Do not route around a refusal with another tool
*Tier 2 — `tree-accounted`. The refusals say so as well.*

A read-only file refused at `write_file` must not then be edited by `bash`.
This was tier 1 in name only: the refusal text said it, and nothing checked
it. On 2026-09-02 a model asked to change behaviour a test pinned wrote a
scratch script, ran it with `node`, and the script deleted the assertion;
`spec-intact` reported "no test file was changed" and the turn was accepted.
`tree-accounted` now snapshots the working tree when a turn begins and refuses
a claim if any file changed on disk that no tool call wrote, and `spec-intact`
reads assertions from that snapshot as well as from the ledger — so the route
is refused whatever tool took it.

### 8. Say the work is unfinished rather than invent work
*Tier 2 and 3 — `files-changed` says it in the refusal itself.*

The gate that demands a change is the gate that teaches a model to fabricate
one. Every refusal here names the honest exit, and ranks fabrication below
finding nothing.

## What is still only asked, not checked

- **Rule 5** — no mechanical form yet.
- **Rule 6** — has one, described above, not yet built.
- **Task fidelity.** The project bar verifies that the project is healthy, not
  that the task was done. That gap is what per-task criteria exist to close,
  and they are sealed before the work starts so the model cannot write its own
  exam. Reachable from both surfaces: the window's criteria panel, and
  `molt run --criterion name=command --note "..."` headlessly.
