# Sharper checks

molt's promise is that "done" means sealed checks passed. That promise is only
as good as the checks. This page defines what a sharp check is, shows where
molt's checks failed on Terminal-Bench 2.0, and lists what molt now does
about each failure.

## The definition

A check is sharp when it has all three properties:

1. **Valid.** It demands what the task text states, and nothing else. It
   passes every correct solution. A valid check never invents a limit, never
   reads "< 32,000" as "== 32,000", and never hard-codes an answer the drafter
   had to guess.
2. **Discriminating.** It fails the wrong solutions a model is likely to
   produce. It runs the deliverable on an input and tests what comes out.
   Checking only that a file exists or a word appears in the source is not
   enough. It also fails on the untouched workspace, because a check that
   passes before any work shows nothing.
3. **Clean.** Running it changes nothing the grader will see. It builds in a
   temporary folder and leaves no files behind in the deliverable folder.

A dull check fails in one of two ways. If it is not discriminating, it lets
wrong work through. If it is not valid, it does something worse: the refusal
loop pushes correct work to fit the wrong check.

## The evidence

Two full Terminal-Bench 2.0 passes ran on the same model (Space Bunny Alpha).
In 29 of them molt said "verified" and the hidden grader failed the work.
Each receipt was read against the grader's failure output.

| Why the check missed | Cases | Tasks |
|---|---|---|
| **Not valid, and the work was bent to fit.** The check demanded something the task did not, and on refusal the model changed correct work, or the environment, to pass it. | 10 | openssl-selfsigned-cert (`-checkend` for "valid for 365 days", so the model set 366), log-summary-date-ranges ×2 (run 2: "the counts were taken from the check's expected values"), mteb-retrieve ×2 (the model patched site-packages to make the check's wrong API call work), overfull-hbox (the model replaced /bin/sh with bash for a check's `pipefail`), circuit-fibsqrt ("== 32000" for "< 32,000"), mteb-leaderboard (the check hard-coded a guessed model; the model found the right one, GritLM-7B, and switched to the guess), sqlite-db-truncate (an invented "value is int" rule dropped rows), filter-js-from-html (run 1: an invented expected output) |
| **Not discriminating: it only looked.** The file exists, a word appears in the source, the code compiles, `--help` runs. | 7 | build-pmars, sparql-university, torch-pipeline-parallelism, sam-cell-seg, headless-terminal, protein-assembly, extract-moves-from-video |
| **Not discriminating: no oracle.** It ran the deliverable but could not know the right answer, and checked only the output's shape. | 5 | raman-fitting ×2, video-processing, query-optimize (speed never checked), train-fasttext (the model measured 0.610 on the provided test split against a stated 0.62, and the check only looked at file size) |
| **Too thin.** One example, the wrong mode, or it passed before the work. | 4 | filter-js-from-html (run 2), break-filter-js-from-html (the only real check passed before any work), cancel-async-tasks (tested `task.cancel()`, but the task said keyboard interrupt), fix-git |
| **Not clean.** The check's own build left files in the deliverable folder. | 2 | polyglot-c-py, polyglot-rust-c (`gcc … -o /app/polyglot/cmain` left `cmain` next to the one file the grader requires) |
| The claim itself said the work was not finished. | 1 | path-tracing-reverse |

Two findings stand out. First, the biggest group is not weak checks but
**wrong checks**, and the harm came from how molt enforced them. The refusal
said "do not claim completion again until these pass", with no way out. In
two cases the model said in its own claim that the check was wrong, then
complied anyway. Second, **surface checks** were already forbidden by the
drafting prompt. A rule the drafter reads while drafting is a rule it can
talk itself past.

The literature agrees on both points (notes in
`research_notes/Sharper checks/literature.md`):

- **LLM-written tests are often wrong, and mostly in their expected values.**
  Only 57–59% of HumanEval problems get a fully correct self-written suite,
  and debugging against those tests lowered GPT-4o's score (arXiv 2501.12793).
- **Bad tests are worse than none.** Tests from an untrained test agent cut
  the resolve rate from 61.2% to 57.3% (arXiv 2609.09133).
- **An explicit way to flag a contradicting test cuts gaming sharply.** In
  ImpossibleBench (arXiv 2510.20270), GPT-5's cheating fell from 54% to 9%,
  and more retry rounds increased cheating.
- **Naming the forbidden moves works better than a generic warning.** On
  terminal tasks, an explicit prohibition nearly eliminated hacking where a
  generic warning did not, and for one model the generic warning backfired
  (arXiv 2608.22103).
- **People judge wrong assertions at chance, and explanations make it worse**
  (arXiv 2607.08885). A ruling should rest on the task and the check, not on
  the agent's argument.

## What molt does now

| Property | Mechanism | Where |
|---|---|---|
| Valid | **Dispute.** When a drafted check fails, the refusal says it may be wrong and offers one line: `DISPUTE <check>: "<task words>" — <why>`. Three independent reviews read the task, the check's command and its output, plus the quoted task words, but not the agent's argument. The check is retired only if a majority find it contradicts the task and quote task text that string-matches. Each check can be disputed once. A person's check can never be disputed. If every check is retired, the claim is reported unverified, never verified by nothing. A rejected dispute tells the model the check stands, and it gets its turn to fix the work. | `src/dispute.ts`, `Engine.runTurn` |
| Valid | **Forbidden moves, named.** The refusal says never to change correct work just to satisfy a drafted check. It also says never to change /bin/sh, system binaries, site-packages, `.molt/`, the check files or the clock to make a check pass. | `DISPUTE_HINT` |
| Valid | **Critic before sealing.** A fresh reading of the draft against the task text only. A check that invents or guesses is dropped, but only with a verbatim task quote. | `draftCriteriaCritiqued`, `CRITIC_SYSTEM` |
| Discriminating | **Surface-only drafts are redrafted once.** If no kept check runs the deliverable, the draft is asked for again with the critic's findings. The redraft is used only if it is no worse. | same |
| Discriminating | **Proxy checks for unknowable answers.** The drafter checks the stated threshold on the data that is present, such as accuracy ≥ 0.62 on the provided test split, a fit's error, or a query's time against the original's. | drafter `SYSTEM` |
| Clean | **Leftovers removed.** In an unattended run, files and folders that appeared while checks ran are removed. This covers the pre-work try, the CLI's preflight and every proof attempt. A file that existed before is never touched, and nothing is removed if the project could not be listed in full. | `src/leftovers.ts` |

## How it is measured

- **"Done was true"**: the share of molt's verified claims the grader
  passed. From `bench/harbor/compare.py`.
- **False verified claims by category**, using the table above, re-derived
  after each full run.
- **The critic, offline:** `bench/harbor/critic_replay.py` runs the critic on
  every sealed draft from earlier runs. It reports how often it flags drafts
  behind false claims (wanted: high) and drafts behind true claims (wanted:
  low).
- **Disputes:** the journal records every dispute and its ruling
  (`"dispute"` entries). Measured per run: how many were raised, upheld and
  rejected, and the grader's verdict on each task.

## Not solved yet

- **The same model drafts, critiques and rules.** Correlated errors between
  models of one family are high (arXiv 2506.07962). A different model family
  for the critic and the arbiter would buy real independence, at a cost.
- **Mutation testing of checks.** Running each check against a stub or empty
  deliverable before sealing is the strongest known test of whether a check
  discriminates (nl2postcond, MuTAP). molt runs checks against the untouched
  workspace and labels those that already pass, but does not yet reject or
  redraft them.
- **Checks that cannot know the answer.** Proxies help. A task graded
  against a private set can still only be approximated.
