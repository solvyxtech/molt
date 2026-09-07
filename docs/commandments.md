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

## The fourth tier: what no check can reach

The three tiers above are refusal at the tool boundary, judgement at the bar,
and instruction in the prompt. There is a fourth thing, and pretending
otherwise is its own dishonesty.

On 2026-09-07 a turn was accepted at 11 of 11 checks. Types clean, suite green,
window boots, window drives, every write ledgered, no assertion removed,
changed lines covered, mutants killed, the shipped build current. The change
was still worse than it looked: asked to stop a check blaming the wrong party,
it hedged in *every* case, including the one where the ledger names the writer
and molt has proof. It gave away evidence molt had.

No check saw it, and none could have. "This discards information that was
available" is not a property of the tree, the tests, the coverage or the
diff — it is a judgement about whether the change was the right shape, and the
bar does not make judgements. It establishes facts.

So the rule for this tier is not a check. It is:

> **An accepted receipt means every check passed. It does not mean the work is
> good, and molt must never be written as though it did.**

What follows from that is a duty on the receipt rather than on the model: if
the only thing that catches this class is a person reading the change, then
reading the change has to be cheap. That is why a receipt carries the lines the
turn wrote — molt's own ledger, attributable per tool call, and narrower than
`git diff`, which shows the working tree rather than this turn and is worth
nothing when more than one agent is editing it.

## The tree is not the deliverable

Three failures on 2026-09-07, all of them the same sentence.

1. A turn fixed `src/`, passed ten checks, wrote an accepted receipt — and the
   person who opened the app got a build from forty minutes earlier.
2. A commit staged four source files and left the two modules they import
   untracked. A fresh clone failed typecheck on four files, minutes after
   `npm run check` passed at 1,296 tests.
3. Between those, a turn was refused four times and exhausted for twelve files
   it had not written, because two other agents were editing the same checkout
   and molt reported their work as the turn's.

The first two are one fault: **molt judges the working tree, and the working
tree is not what anyone receives.** What is received is a build, a commit, an
install, a package — each derived from the tree and each able to disagree with
it. A green bar says the tree is healthy. It has never said the artifact is.

The third is the same fault seen from the other side: the tree is not solely
the turn's either, so a finding about the tree is not automatically a finding
about the work.

What follows:

- **Every check names the artifact it judges.** `build-current` judges built
  output against source. `imports-tracked` judges what git holds against what
  committed code imports. `tree-accounted`, `files-changed` and the rest judge
  the tree, and say so.
- **A check that judges an artifact this machine does not build says nothing
  about it rather than failing.** The installed app is listed in this
  project's own bar and skipped where it is absent — enforced on the machine
  that is about to hand it over, silent on the machine that is not.
- **When a commit moves modules, verify a clone rather than the tree.** No
  suite that reads the working tree can see a file missing from the commit.
- **A finding about the tree is attributed only as far as the ledger reaches.**
  Name the turn where a tool call is on record; say what changed and stop
  guessing where none is.

The general form, for whatever the fourth instance turns out to be: *before
adding a check, say which artifact it judges — and if the answer is "the
working tree", ask what is actually being handed over.*

