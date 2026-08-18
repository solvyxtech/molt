# Changelog

## Unreleased — the meter says what it knows, and you set the ceiling

The status line quoted a cost to six decimal places from a price nobody had
checked, and the TUI showed a spinner where the work was. Both are the same
failure in a tool whose whole claim is that nothing has to be taken on trust:
a number presented with more confidence than it was earned with.

### Added

- **`list_dir`, `grep`, and `edit_file`.** Three tools became six, which is a
  change to a stated design rule and so needs its reason in the open: `ls`
  through `bash` is a string the autonomy classifier has to reason about, and an
  unfamiliar construction sends it to a prompt — in one real session, a model
  that could not list a directory started guessing filenames. A tool with no
  write in it needs no classifier and is never gated at any level; safety by
  shape beats safety by regex.

  `list_dir` and `grep` skip build and dependency directories (saying which),
  cap their own output, and refuse to walk outside the project. `edit_file`
  replaces exact text and refuses rather than guesses: absent text fails, and
  text appearing more than once fails without `replace_all`, because a write
  that lands on the wrong occurrence looks exactly like a write that worked.
  Edits are ledgered like any other write, so `files-changed` and
  `record-intact` prove them, and a superseded read is elided the same way.
- **Autonomy levels — `shift+A`.** low (default) asks about every command and
  every write, as before; medium runs reads, writes inside the project, and
  commands that only report; high runs everything except what cannot be undone.
  The level sits beside the model in the status line the whole time it is in
  force, and is also `/autonomy [level]` or `--autonomy <level>`. `--yes` now
  means high.

  The key works everywhere, but not identically: at an empty prompt it opens a
  picker that changes nothing until you confirm — a terminal cannot tell
  `shift+A` from the `A` that starts "Add a test", and a permission ceiling
  must not move on a typo; escape gives the letter back. While molt is working,
  or while it is asking permission, it cycles immediately.

  The classifier is mechanical and denies by default: a short allowlist of
  reporting commands, judged segment by segment, with redirection, command
  substitution, leading assignments, and `sudo` disqualified because their
  effect is not readable from the text. Leaving the project and anything
  irreversible (`rm -rf`, `git push`, `git reset --hard`, piping a download
  into a shell, …) ask at every level, including high. Unasked calls are marked
  `[auto]` on screen and journalled with the level that allowed them, and
  moving the ceiling is journalled too. It governs what molt asks about, not
  what is possible — see `docs/autonomy.md`.
- **The live view — press `shift+V`** while a turn is running (`ctrl+V` any
  time, or `/verbose`). A bounded panel showing what the model is doing right now, the
  exact arguments of every tool call, the head of every result, each check's
  command and duration, and what every job has cost. Feed lines are recorded
  whether or not the view is open, so the key reveals what already happened
  rather than starting a recording. Verbatim throughout — a view that
  paraphrases is one more claim to check.
- **Per-job accounting.** Every user turn is a job with its own tokens, cost,
  step count, duration, and outcome (`verified`, `unverified`, `not proven`,
  `cancelled`), measured as a delta against the session meter rather than by
  resetting it. Shown in the view, and printed headlessly at the end of a run.
- **A one-line overview after every step and every verification.** `step 2 ·
  read_file, bash · 3.4k in (2.1k cached) · 412 out · 6.2s · 0.31¢`, and
  `2 of 3 checks passed · 4.1s · failed: tests` followed by what happens next.
  Printed headlessly too, so a CI log records what a run cost step by step.
- **Prices read from the provider.** `fetchPricing` asks the endpoint that
  will do the billing (xAI's `/language-models`, OpenRouter's `/models`) and
  stamps the result with the model it belongs to. `/price` shows the rate and
  its source, sets one by hand for endpoints that publish none, and `--verbose`
  is the headless equivalent of the view.
- **Cached prompt tokens are counted and billed at the cache rate** when the
  provider publishes one, instead of at the full prompt rate.
- **Provider-reported cost is used when there is one** (OpenRouter's
  `usage.cost`), and only when *every* step reported one — a total that blends
  a billed step with a priced one is neither figure.

- **`/ask`, and a leading `?`.** A question changes nothing, so a bar that
  requires a change can only ever refuse it — and molt would rather refuse an
  honest answer than accept an invented file edit. Asking runs the rest of the
  bar and drops only the checks that need a write, says which it dropped, and
  records it in the receipt. `molt ask "<question>"` headlessly.

  molt does not infer this. The only party that knows whether "done" meant a
  change is the person who asked, and the only other candidate — letting the
  model decide whether its own claim needs proving — is the decision the whole
  tool exists to take away from it.

### Fixed

- **A large file could not be read at all, and the dead end looked like a
  model looping.** `read_file` took a path and nothing else, and every result
  was cut to 2048 bytes — so for a 17KB README a model got the first 2KB and
  had no mechanism whatsoever to reach the rest. Its only available move was to
  call `read_file` again and receive the same 2KB. A reported session spent 32
  steps re-reading four files, was stopped by the step guard, produced no
  answer, and cost about fifty cents.

  Four changes, each of which was necessary:
  - `read_file` takes `offset` and `limit`, and a partial result says how many
    lines remain and the offset that continues it. The dead end becomes a path.
  - The notice saying how to continue is budgeted *inside* the byte cap. The
    first version appended it afterwards, so truncation cut off the one
    sentence that told the model how to proceed — the same dead end, rebuilt
    one layer up.
  - Caps are sized per kind of result: 16KB for a file, 8KB for command
    output. At 2048 bytes for everything, paging through a README took nine
    round trips, and each round trip resent the whole conversation — the tight
    cap cost far more tokens than the large read it was avoiding.
  - A repeated call that returns byte-identical output gets a pointer to the
    earlier result instead of the payload, and two consecutive steps of nothing
    but repeats stops the turn with what it spent. The step guard now reports
    tokens and cost too, rather than a bare "loop guard".

  The same request now finishes in 6 steps for $0.086, verified, instead of 32
  steps and no answer.
- **The elision notice invited the loop it was part of.** A superseded read was
  replaced with "full contents remain in the archived record", which reads to a
  model as an instruction to go and get them — possible only by re-reading the
  file. It now points at the newer copy already in the conversation.
- **`2>/dev/null` counted as a file write**, so ordinary exploration
  (`ls -la .molt 2>/dev/null`) was refused at medium autonomy and a model that
  could not list a directory guessed filenames instead. Discards and
  descriptor redirections are allowed; redirection to a path still asks.
- **The proof loop re-ran the bar against state nothing had touched.** A model
  that repeated its claim without calling a tool got the full four attempts,
  each paying for a complete test suite, and each necessarily reaching the
  same verdict. molt now stops as soon as an attempt cannot differ from the
  last, says why, and still writes the receipt. Reported from the field as a
  loop when asking questions in a repo whose bar requires a write.

- **Streaming responses carry no usage block unless asked, so every cost was a
  guess.** molt now sends `stream_options: {include_usage: true}` and falls
  back once, permanently, for servers that reject the field. Streaming is the
  default, so this was the default path: token counts came from `chars/4` over
  the wire JSON while the meter rendered them like measurements.
- **A stored price with no model attached was applied to every model.** The
  shipped config carried `priceIn`/`priceOut` and nothing saying what they were
  for; a figure entered once — off by a factor of a hundred, in the case that
  prompted this — was then used forever, and survived every model switch.
  Unattributed prices are now re-fetched rather than trusted.
- **Sub-cent costs rendered as `$0.000024`** — six digits to count in the one
  field that has to be legible at a glance. Cost is now three decimals at the
  most (`$0.003`), with `<$0.001` below that rather than a false zero, and a
  cost resting on molt's own token estimate is prefixed `~` so a guess and a
  bill do not look alike.
- **The meter changed unit as it climbed.** Quoting small sums in cents made
  the session total read `0.9¢` and then `$0.029` — which looks like it went
  down. Cost is always in dollars now; only the decimals move.
- **The TUI redrew the entire session on every frame.** A terminal can only
  erase what is still on screen, so once the output was taller than the window
  the transcript tore and duplicated — and the more molt had to say, the worse
  it got. The transcript is now printed once and never redrawn, and every live
  region (the view, a streaming answer) is bounded and fitted to the window
  width.
- **`pruned N superseded tool result(s) · −-17 tokens`.** Eliding a result
  shorter than the notice explaining its absence dropped content *and* grew
  the context. Such results are now left alone.
- **The session meter was not reset by `/clear`.** Token totals and cost
  carried across a reset session.
- **Headless output ran the model's last streamed word into molt's next line.**

## 1.0.0-rc.3 — the archive earns its claim

An audit found that "verification runs against preserved history" was
architecture, not function: pass/fail came entirely from an in-memory ledger
that was never shed, and `record-intact` only checked the archive against
itself. Deleting the whole archive changed no outcome. This release makes the
claim literally true.

### Added

- **Write evidence travels with shed context.** Every write performed during
  shed messages is embedded in the exuvia as a `molt-ledger` block — path,
  hash before, hash after — and **removed from memory**. After a shed, the
  archive is the only place that evidence exists. Delete an exuvia and a
  completion check fails, naming the work that can no longer be proven.
- **Evidence survives across sessions.** A fresh process with an empty
  in-memory ledger can still prove yesterday's writes.
- **`claims-grounded` builtin.** Every file path the model names in its final
  answer must exist or have been written here — catching invented file
  references, a documented failure mode. Conservative by design: URLs are
  stripped and a token must look like a path with an extension, because
  over-matching would fail correct work.
- **Three independent expectations for `record-intact`**, none supplied by
  the archive: batches shed this session, write records handed over, and
  archive filenames recorded in the hash-chained journal. The last survives a
  process restart, so a deleted exuvia is caught tomorrow as well as today.
- **molt refuses to shed when no archive is configured and there is write
  evidence to lose.** Shedding must shrink context, never the ability to
  prove what happened.

- **`/ask`, and a leading `?`.** A question changes nothing, so a bar that
  requires a change can only ever refuse it — and molt would rather refuse an
  honest answer than accept an invented file edit. Asking runs the rest of the
  bar and drops only the checks that need a write, says which it dropped, and
  records it in the receipt. `molt ask "<question>"` headlessly.

  molt does not infer this. The only party that knows whether "done" meant a
  change is the person who asked, and the only other candidate — letting the
  model decide whether its own claim needs proving — is the decision the whole
  tool exists to take away from it.

### Fixed

- **A large file could not be read at all, and the dead end looked like a
  model looping.** `read_file` took a path and nothing else, and every result
  was cut to 2048 bytes — so for a 17KB README a model got the first 2KB and
  had no mechanism whatsoever to reach the rest. Its only available move was to
  call `read_file` again and receive the same 2KB. A reported session spent 32
  steps re-reading four files, was stopped by the step guard, produced no
  answer, and cost about fifty cents.

  Four changes, each of which was necessary:
  - `read_file` takes `offset` and `limit`, and a partial result says how many
    lines remain and the offset that continues it. The dead end becomes a path.
  - The notice saying how to continue is budgeted *inside* the byte cap. The
    first version appended it afterwards, so truncation cut off the one
    sentence that told the model how to proceed — the same dead end, rebuilt
    one layer up.
  - Caps are sized per kind of result: 16KB for a file, 8KB for command
    output. At 2048 bytes for everything, paging through a README took nine
    round trips, and each round trip resent the whole conversation — the tight
    cap cost far more tokens than the large read it was avoiding.
  - A repeated call that returns byte-identical output gets a pointer to the
    earlier result instead of the payload, and two consecutive steps of nothing
    but repeats stops the turn with what it spent. The step guard now reports
    tokens and cost too, rather than a bare "loop guard".

  The same request now finishes in 6 steps for $0.086, verified, instead of 32
  steps and no answer.
- **The elision notice invited the loop it was part of.** A superseded read was
  replaced with "full contents remain in the archived record", which reads to a
  model as an instruction to go and get them — possible only by re-reading the
  file. It now points at the newer copy already in the conversation.
- **`2>/dev/null` counted as a file write**, so ordinary exploration
  (`ls -la .molt 2>/dev/null`) was refused at medium autonomy and a model that
  could not list a directory guessed filenames instead. Discards and
  descriptor redirections are allowed; redirection to a path still asks.
- **The proof loop re-ran the bar against state nothing had touched.** A model
  that repeated its claim without calling a tool got the full four attempts,
  each paying for a complete test suite, and each necessarily reaching the
  same verdict. molt now stops as soon as an attempt cannot differ from the
  last, says why, and still writes the receipt. Reported from the field as a
  loop when asking questions in a repo whose bar requires a write.

- **`record-intact` broke every reopened project.** It required the archive to
  hold exactly what the current session shed, but the archive is per project
  and persists. Any second session in a project that had ever shed would fail.
  Found by running an end-to-end scenario, not by reading the code.
- **Ledger entries are keyed by tool-call id, not message index.** Indices
  shift when a shed replaces a dropped prefix with a digest, so every entry
  needed rebasing and a missed rebase would silently misfile evidence. The
  rebasing was also unobservable through the public surface, meaning the test
  covering it could not fail. Removing the index removed the whole class of
  bug rather than testing around it.

### Method

Every mutation in the sweep is now caught. Three survived at first and each
exposed a genuine gap:

- nothing asserted the live ledger *gives up* what the archive takes on —
  without that, the archive is optional and the claim is false
- nothing checked evidence placement across repeated sheds
- the batch-count check was redundant with the write-count check except for a
  shed batch containing no writes, which now has its own test, because losing
  archived conversation is a loss even when no file work was lost

## 1.0.0-rc.2 — any model you don't fully trust

A positioning correction, documented rather than quietly applied.

### Changed

- **The audience is no longer "local models".** It is any model you don't
  fully trust. Local remains the sharpest case — small context windows,
  weaker agentic judgement, poor summarization at small parameter counts —
  but the trust gap it addresses was never local-specific. The most-cited
  destructive incident in the field involved a frontier model, and Claude
  Code declaring completion over a failing suite is a frontier-model
  behaviour.
- **Intent is explicitly out of scope.** molt does not try to detect
  dishonesty. Whether a model lied or was merely wrong, the cost is
  identical, so molt checks the work rather than the motive.
- README leads with the trust gap in AI-generated code generally, and lists
  the OpenAI-compatible providers molt already works with.

### Added

- **`docs/why.md`** — why molt exists, where local models fit, how hosted
  models change the argument, and a worked example: a table of confident,
  incorrect claims made by the AI assistant used to build this repository,
  each with what was actually true. Including two claims molt itself made
  about its own behaviour, and two tests that passed while the code they
  covered was deliberately sabotaged.

  It is there because a documented failure from the tool that built the
  project is better evidence than a statistic from a survey — and because a
  project about refusing false claims should be able to show its own.

## 1.0.0-rc.1 — the record

molt claims things: that a check passed, that a file changed, that context was
shed. This release makes every one of those claims checkable against an
artifact molt cannot silently edit.

### Added

- **Hash-chained session log.** `.molt/log/<id>.jsonl` — append-only, one
  entry per event: session start, user messages, requests, responses, tool
  calls, tool results, permission decisions, bar runs with per-check exit
  codes, sheds, elisions, receipts, cancellations, errors. Each entry stores
  the SHA-256 of the previous one.
- **`molt log`** — what the model actually did, every line recomputed from
  entries rather than narrated. `--raw` for the JSONL, `--json` for parsed
  entries, `--session <id>` to pick one.
- **`molt verify`** — recomputes the chain and names the exact entry where it
  broke. Proven against three tampering modes: modifying a bar result,
  deleting a permission entry, and inserting a forged one.
- **Estimated vs measured, stated everywhere.** Exit codes, byte counts,
  durations, file hashes, and provider-reported usage are measured. Request
  size and token counts absent a usage block are estimates, marked `~` in
  output and `"estimated": true` in the log.
- **`docs/transparency.md`** — what is recorded, what is deliberately not,
  and how to reconstruct any claim end to end.

- **`/ask`, and a leading `?`.** A question changes nothing, so a bar that
  requires a change can only ever refuse it — and molt would rather refuse an
  honest answer than accept an invented file edit. Asking runs the rest of the
  bar and drops only the checks that need a write, says which it dropped, and
  records it in the receipt. `molt ask "<question>"` headlessly.

  molt does not infer this. The only party that knows whether "done" meant a
  change is the person who asked, and the only other candidate — letting the
  model decide whether its own claim needs proving — is the decision the whole
  tool exists to take away from it.

### Fixed

- **A large file could not be read at all, and the dead end looked like a
  model looping.** `read_file` took a path and nothing else, and every result
  was cut to 2048 bytes — so for a 17KB README a model got the first 2KB and
  had no mechanism whatsoever to reach the rest. Its only available move was to
  call `read_file` again and receive the same 2KB. A reported session spent 32
  steps re-reading four files, was stopped by the step guard, produced no
  answer, and cost about fifty cents.

  Four changes, each of which was necessary:
  - `read_file` takes `offset` and `limit`, and a partial result says how many
    lines remain and the offset that continues it. The dead end becomes a path.
  - The notice saying how to continue is budgeted *inside* the byte cap. The
    first version appended it afterwards, so truncation cut off the one
    sentence that told the model how to proceed — the same dead end, rebuilt
    one layer up.
  - Caps are sized per kind of result: 16KB for a file, 8KB for command
    output. At 2048 bytes for everything, paging through a README took nine
    round trips, and each round trip resent the whole conversation — the tight
    cap cost far more tokens than the large read it was avoiding.
  - A repeated call that returns byte-identical output gets a pointer to the
    earlier result instead of the payload, and two consecutive steps of nothing
    but repeats stops the turn with what it spent. The step guard now reports
    tokens and cost too, rather than a bare "loop guard".

  The same request now finishes in 6 steps for $0.086, verified, instead of 32
  steps and no answer.
- **The elision notice invited the loop it was part of.** A superseded read was
  replaced with "full contents remain in the archived record", which reads to a
  model as an instruction to go and get them — possible only by re-reading the
  file. It now points at the newer copy already in the conversation.
- **`2>/dev/null` counted as a file write**, so ordinary exploration
  (`ls -la .molt 2>/dev/null`) was refused at medium autonomy and a model that
  could not list a directory guessed filenames instead. Discards and
  descriptor redirections are allowed; redirection to a path still asks.
- **The proof loop re-ran the bar against state nothing had touched.** A model
  that repeated its claim without calling a tool got the full four attempts,
  each paying for a complete test suite, and each necessarily reaching the
  same verdict. molt now stops as soon as an attempt cannot differ from the
  last, says why, and still writes the receipt. Reported from the field as a
  loop when asking questions in a repo whose bar requires a write.

- **"cancelled — the session is unchanged" was not literally true.** The user
  turn was pushed before the request, so a cancellation left it behind.
  Cancelling now rolls the turn back to its starting length; a test asserts
  the record is byte-identical afterwards. A claim molt makes about itself is
  held to the same standard as one the model makes.

### Deliberately not logged

Message content. The log records a user message's length, a 120-character
preview, and a digest — not the text; tool results by byte count and digest,
not contents. Prompts contain credentials and private code, and a verbose
audit log is exactly the file that quietly accumulates them. There is a test
asserting a secret in a prompt never reaches the log.

### Honest limit

The chain is tamper **evidence**, not tamper prevention. Anyone with write
access can rewrite a log and re-chain it. What it rules out is a silent edit.

### Cost

Zero tokens. All four artifact directories are disk only and never enter a
prompt. A 16-entry session is 5.2 KB, about 329 bytes per entry.

## 0.9.0 — token efficiency, measured

History is resent on every request, so anything lingering in context is paid
for repeatedly. Measured on a modelled 12-step task with two refusals:
**125,839 → 42,633 prompt tokens sent (66% less)**, final history 8,982 →
2,681 tokens.

Fixed overhead was measured first and deliberately left alone: the system
prompt is 138 tokens and the tool schema 157, together about 5% of a real
session. Shrinking them is a rounding error.

### Added

- **Superseded tool-result elision.** A file read and then written is dead
  weight — the model will never use the stale contents again, but every
  later request pays for them. Same for a path read twice. Only `read_file`
  results are touched, only when a later call supersedes them, and the
  replacement says plainly what happened. Mechanical, idempotent, and the
  full original stays in the archived record.

- **`/ask`, and a leading `?`.** A question changes nothing, so a bar that
  requires a change can only ever refuse it — and molt would rather refuse an
  honest answer than accept an invented file edit. Asking runs the rest of the
  bar and drops only the checks that need a write, says which it dropped, and
  records it in the receipt. `molt ask "<question>"` headlessly.

  molt does not infer this. The only party that knows whether "done" meant a
  change is the person who asked, and the only other candidate — letting the
  model decide whether its own claim needs proving — is the decision the whole
  tool exists to take away from it.

### Fixed

- **A large file could not be read at all, and the dead end looked like a
  model looping.** `read_file` took a path and nothing else, and every result
  was cut to 2048 bytes — so for a 17KB README a model got the first 2KB and
  had no mechanism whatsoever to reach the rest. Its only available move was to
  call `read_file` again and receive the same 2KB. A reported session spent 32
  steps re-reading four files, was stopped by the step guard, produced no
  answer, and cost about fifty cents.

  Four changes, each of which was necessary:
  - `read_file` takes `offset` and `limit`, and a partial result says how many
    lines remain and the offset that continues it. The dead end becomes a path.
  - The notice saying how to continue is budgeted *inside* the byte cap. The
    first version appended it afterwards, so truncation cut off the one
    sentence that told the model how to proceed — the same dead end, rebuilt
    one layer up.
  - Caps are sized per kind of result: 16KB for a file, 8KB for command
    output. At 2048 bytes for everything, paging through a README took nine
    round trips, and each round trip resent the whole conversation — the tight
    cap cost far more tokens than the large read it was avoiding.
  - A repeated call that returns byte-identical output gets a pointer to the
    earlier result instead of the payload, and two consecutive steps of nothing
    but repeats stops the turn with what it spent. The step guard now reports
    tokens and cost too, rather than a bare "loop guard".

  The same request now finishes in 6 steps for $0.086, verified, instead of 32
  steps and no answer.
- **The elision notice invited the loop it was part of.** A superseded read was
  replaced with "full contents remain in the archived record", which reads to a
  model as an instruction to go and get them — possible only by re-reading the
  file. It now points at the newer copy already in the conversation.
- **`2>/dev/null` counted as a file write**, so ordinary exploration
  (`ls -la .molt 2>/dev/null`) was refused at medium autonomy and a model that
  could not list a directory guessed filenames instead. Discards and
  descriptor redirections are allowed; redirection to a path still asks.
- **The proof loop re-ran the bar against state nothing had touched.** A model
  that repeated its claim without calling a tool got the full four attempts,
  each paying for a complete test suite, and each necessarily reaching the
  same verdict. molt now stops as soon as an attempt cannot differ from the
  last, says why, and still writes the receipt. Reported from the field as a
  loop when asking questions in a repo whose bar requires a write.

- **Stale bar failures were carried forever.** Each refusal appended a full
  failure message that was resent on every subsequent request, so attempt 3
  paid for attempts 1 and 2 as well. Earlier failures now collapse to a
  one-line marker; the model still knows a previous attempt was refused
  without re-reading output it has already acted on.
- **Headless startup was 7x slower than it needed to be.** `cli.tsx`
  imported Ink at module top, so `molt prove` loaded React and the entire
  TUI without rendering it: 528ms → 88ms after moving to a dynamic import.
  This matters because the bar wants to live in CI and in git hooks.

### Changed

- `TOOL_RESULT_MAX_BYTES` 4096 → 2048. Tool results dominate history, and
  truncation has always been visible rather than silent.

### Known tension, not yet addressed

Shedding rewrites the context prefix, which invalidates a provider's cached
prefix. Measured on a sample session: shedding cut history 11,480 → 2,971
tokens, but the next request then re-reads those 2,971 uncached. On a
caching provider, shedding mid-task can cost more than it saves. Auto-shed
should probably fire at task boundaries rather than token thresholds — but
that number is arithmetic, not an observation, and it needs measuring
against a real provider before behaviour changes.

## 0.8.0 — streaming, and a palette you do not have to memorise

### Added

- **Token streaming, on by default.** SSE parsing with delta reassembly.
  `--no-stream` opts out. The TUI renders fragments as they arrive; headless
  runs write them straight to stdout.
- **Ctrl-C cancels the turn** instead of killing molt. The assistant turn is
  committed only once a response completes, so a cancelled stream leaves the
  session exactly as it was — no half-written message.
- **Command palette.** Type `/` to see every command with its summary; `↑↓`
  to choose, `tab` to fill, `enter` to run, `esc` to clear. Matching is
  exact → prefix → subsequence (`/rgw` finds `/regrow`) → summary word
  (`/token` finds `/budget`), with stable tie-breaking so the list never
  reorders under your fingers.
- **Arrow-key permission prompts.** Allow/deny is chosen with arrows and
  confirmed with enter. `y`/`n` still work.
- **Streaming mock provider.** `rnd/mock-provider.mjs` serves SSE when asked,
  splitting tool arguments at an inconvenient boundary, so the demo and the
  grader exercise the streaming path rather than only the JSON one.

- **`/ask`, and a leading `?`.** A question changes nothing, so a bar that
  requires a change can only ever refuse it — and molt would rather refuse an
  honest answer than accept an invented file edit. Asking runs the rest of the
  bar and drops only the checks that need a write, says which it dropped, and
  records it in the receipt. `molt ask "<question>"` headlessly.

  molt does not infer this. The only party that knows whether "done" meant a
  change is the person who asked, and the only other candidate — letting the
  model decide whether its own claim needs proving — is the decision the whole
  tool exists to take away from it.

### Fixed

- **A large file could not be read at all, and the dead end looked like a
  model looping.** `read_file` took a path and nothing else, and every result
  was cut to 2048 bytes — so for a 17KB README a model got the first 2KB and
  had no mechanism whatsoever to reach the rest. Its only available move was to
  call `read_file` again and receive the same 2KB. A reported session spent 32
  steps re-reading four files, was stopped by the step guard, produced no
  answer, and cost about fifty cents.

  Four changes, each of which was necessary:
  - `read_file` takes `offset` and `limit`, and a partial result says how many
    lines remain and the offset that continues it. The dead end becomes a path.
  - The notice saying how to continue is budgeted *inside* the byte cap. The
    first version appended it afterwards, so truncation cut off the one
    sentence that told the model how to proceed — the same dead end, rebuilt
    one layer up.
  - Caps are sized per kind of result: 16KB for a file, 8KB for command
    output. At 2048 bytes for everything, paging through a README took nine
    round trips, and each round trip resent the whole conversation — the tight
    cap cost far more tokens than the large read it was avoiding.
  - A repeated call that returns byte-identical output gets a pointer to the
    earlier result instead of the payload, and two consecutive steps of nothing
    but repeats stops the turn with what it spent. The step guard now reports
    tokens and cost too, rather than a bare "loop guard".

  The same request now finishes in 6 steps for $0.086, verified, instead of 32
  steps and no answer.
- **The elision notice invited the loop it was part of.** A superseded read was
  replaced with "full contents remain in the archived record", which reads to a
  model as an instruction to go and get them — possible only by re-reading the
  file. It now points at the newer copy already in the conversation.
- **`2>/dev/null` counted as a file write**, so ordinary exploration
  (`ls -la .molt 2>/dev/null`) was refused at medium autonomy and a model that
  could not list a directory guessed filenames instead. Discards and
  descriptor redirections are allowed; redirection to a path still asks.
- **The proof loop re-ran the bar against state nothing had touched.** A model
  that repeated its claim without calling a tool got the full four attempts,
  each paying for a complete test suite, and each necessarily reaching the
  same verdict. molt now stops as soon as an attempt cannot differ from the
  last, says why, and still writes the receipt. Reported from the field as a
  loop when asking questions in a repo whose bar requires a write.

- **The round-trip test was measuring the wrong thing.** It asserted seeded
  facts were recoverable from the archive *plus* context combined — which
  proves preservation, not recovery. It now sheds facts out of live context,
  regrows them, and requires all 120 in the messages that would actually be
  sent. Facts are seeded past the digest's excerpt cap, because a fact at the
  front of a message survives shedding and would have tested nothing.
- **Receipts are greppable.** Exit codes lived only in a markdown table cell,
  so `rg "exit:" .molt/receipts` returned nothing. Each check now emits plain
  `check:`, `command:`, `exit:`, `result:`, `duration_ms:` lines.

### Notes

- Help text is generated from the command registry, so it cannot drift from
  what the palette offers.

## 0.7.0 — surfaces, tags, and measurement

0.6.0 shipped capabilities with no way to reach them. The archive could be
searched and context could be regrown, but neither was reachable from the CLI
or the TUI. That is fixed, plus the two things that make the thesis arguable
in public: measurement, and an honest account of prior art.

### Added

- **`molt receipts`** — list attempts, `--grep` for the evidence behind a
  claim, `--show` a single receipt. Backed by a machine-readable
  `.molt/receipts/index.jsonl`.
- **`molt archive`** — list shed batches, `--grep` the preserved record,
  `--show <n>` one exuvia, and `--explain` to see the digest and the original
  side by side.
- **`molt stats`** — false-claim rate and tokens per verified change, printed
  with the caveats that keep them from being quoted misleadingly.
- **TUI equivalents** — `/regrow <pattern>`, `/archive`, `/receipts`,
  `/stats`, `/shed --explain`.
- **Check tags** — `tags: [fast, slow, ci, local, manual]` with `--only` and
  `--skip`. An untagged check always runs, so omitting a tag cannot quietly
  remove a condition from the bar.
- **`rnd/grade.mjs`** — a harness-agnostic grader. Scenarios with hidden
  graders that inspect the workspace rather than the agent's report, runnable
  against any agent CLI. Refusing correct work counts as a miss, so nothing
  scores well by refusing everything.
- **`reverter` model personality** — writes the work, deletes it, claims done.
- **`docs/prior-art.md`** — what Claude Code hooks, microcompact, OpenCode
  pruning, and the bolt-on verifiers already do, and precisely what is
  different here. molt makes no novelty claim.
- **`docs/metrics.md`** — what the numbers can and cannot support, and the
  confounds to report rather than hide.

### Changed

- README claims behaviour rather than priority. "First harness that…" is
  falsifiable by a stranger's blog post; "refuses to say done without proving
  it" is falsifiable only by testing molt, and is always true.

## 0.6.0 — the proof loop

molt's first release as a verification-first agent. The pitch changed from
"compaction without a model call" to something defensible: **a coding agent that
can't say "done" without proving it.**

### Added

- **`.molt/done.yml`** — the completion bar as a committed, versioned artifact.
  Shell commands plus builtins, strictly validated.
- **The refusing loop** — a final answer is treated as a claim. Failing checks
  are returned to the model verbatim and the loop continues; a persistent false
  claim exhausts its attempts and molt reports failure rather than success.
- **`files-changed` builtin** — proves at least one file actually changed and
  every write molt performed survived on disk byte-for-byte.
- **`record-intact` builtin** — proves the shed archive is complete and
  auditable.
- **Bar tamper detection** — `done.yml` is fingerprinted at session start; an
  agent that edits it to lower the bar fails a `bar-unmodified` check.
- **`.molt/receipts/`** — evidence for every completion attempt, refusals
  included.
- **Headless commands** — `molt run`, `molt prove`, `molt init`, `molt doctor`,
  all exiting non-zero when the bar is not met, with `--json` event output.
- **`rnd/mock-provider.mjs` and `rnd/demo.sh`** — four scripted model
  personalities with known-correct outcomes, graded automatically.

- **`/ask`, and a leading `?`.** A question changes nothing, so a bar that
  requires a change can only ever refuse it — and molt would rather refuse an
  honest answer than accept an invented file edit. Asking runs the rest of the
  bar and drops only the checks that need a write, says which it dropped, and
  records it in the receipt. `molt ask "<question>"` headlessly.

  molt does not infer this. The only party that knows whether "done" meant a
  change is the person who asked, and the only other candidate — letting the
  model decide whether its own claim needs proving — is the decision the whole
  tool exists to take away from it.

### Fixed

- **A large file could not be read at all, and the dead end looked like a
  model looping.** `read_file` took a path and nothing else, and every result
  was cut to 2048 bytes — so for a 17KB README a model got the first 2KB and
  had no mechanism whatsoever to reach the rest. Its only available move was to
  call `read_file` again and receive the same 2KB. A reported session spent 32
  steps re-reading four files, was stopped by the step guard, produced no
  answer, and cost about fifty cents.

  Four changes, each of which was necessary:
  - `read_file` takes `offset` and `limit`, and a partial result says how many
    lines remain and the offset that continues it. The dead end becomes a path.
  - The notice saying how to continue is budgeted *inside* the byte cap. The
    first version appended it afterwards, so truncation cut off the one
    sentence that told the model how to proceed — the same dead end, rebuilt
    one layer up.
  - Caps are sized per kind of result: 16KB for a file, 8KB for command
    output. At 2048 bytes for everything, paging through a README took nine
    round trips, and each round trip resent the whole conversation — the tight
    cap cost far more tokens than the large read it was avoiding.
  - A repeated call that returns byte-identical output gets a pointer to the
    earlier result instead of the payload, and two consecutive steps of nothing
    but repeats stops the turn with what it spent. The step guard now reports
    tokens and cost too, rather than a bare "loop guard".

  The same request now finishes in 6 steps for $0.086, verified, instead of 32
  steps and no answer.
- **The elision notice invited the loop it was part of.** A superseded read was
  replaced with "full contents remain in the archived record", which reads to a
  model as an instruction to go and get them — possible only by re-reading the
  file. It now points at the newer copy already in the conversation.
- **`2>/dev/null` counted as a file write**, so ordinary exploration
  (`ls -la .molt 2>/dev/null`) was refused at medium autonomy and a model that
  could not list a directory guessed filenames instead. Discards and
  descriptor redirections are allowed; redirection to a path still asks.
- **The proof loop re-ran the bar against state nothing had touched.** A model
  that repeated its claim without calling a tool got the full four attempts,
  each paying for a complete test suite, and each necessarily reaching the
  same verdict. molt now stops as soon as an attempt cannot differ from the
  last, says why, and still writes the receipt. Reported from the field as a
  loop when asking questions in a repo whose bar requires a write.

- **Shedding could not fire inside a long tool run.** `planShed` only cut on
  user turns, so a single request producing thirty tool calls — exactly when
  context runs out — could never be compacted. Added a fallback that keeps the
  most recent messages.
- **Cut points could orphan a tool result** from the assistant turn that
  requested it, producing a payload OpenAI-compatible providers reject. Cuts are
  now tool-boundary safe, with a 400-transcript fuzz guarding it.
- **`run: true` crashed the bar parser.** YAML coerces bare scalars to booleans,
  and `/usr/bin/true` is a legitimate check. Scalars are now stringified.
- **Shedding is two-phase.** The archive write happens between planning and
  committing, so a failed write leaves context byte-identical instead of
  destroying it.
- **Digests are merged, not nested.** Prior digests are carried through whole
  rather than re-excerpted, which was silently rotting the earliest context
  across repeated sheds.
- **The digest is a system message**, not a user turn. As a user turn it read as
  fresh instructions and could re-trigger completed work.

### Known gaps

- No streaming. Responses appear when complete.
- No published cross-harness benchmark yet.
