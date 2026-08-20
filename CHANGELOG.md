# Changelog

## 1.0.0-rc.4 — the meter says what it knows, and you set the ceiling

The status line quoted a cost to six decimal places from a price nobody had
checked, and the TUI showed a spinner where the work was. Both are the same
failure in a tool whose whole claim is that nothing has to be taken on trust:
a number presented with more confidence than it was earned with.

### Added

- **`/endpoint <url>` — point molt at a model you host.** `/login` only knew
  the six presets, so a server you run yourself was unreachable from the TUI:
  `--url` worked headlessly and nowhere else. Anything speaking the OpenAI
  shape now works — Ollama on this machine, llama.cpp or vLLM on another box on
  the network. No key is asked for, because the case this exists to serve wants
  none. molt checks the endpoint is reachable straight away rather than finding
  out on the first turn, and a bare `host:port` is told it needs a scheme
  rather than being informed that `192.168.0.72:` is not a scheme molt can call.

- **The step guard asks too.** The other door out of a turn had the same fault
  as the ceiling: it stopped dead. A reported run reached it having spent
  1,344,777 tokens and $0.89, and got no answer for any of it — the same waste,
  by the other route, and reached precisely because `/budget off` had removed
  the ceiling that would otherwise have asked first. The cap is extensible on
  the same terms now: asked once per cap, stopping the default, and only where
  somebody is watching.

- **The spending ceiling asks before it gives up.** Stopping dead at the
  ceiling is the most expensive outcome molt has: the money is already spent,
  and ending there converts it into nothing at all. A reported run reached
  $1.02 of a $1.00 ceiling twenty steps into real work and got no answer for
  any of it — *"it seems like a bigger waste if you spend the money and never
  get an output"*, which is exactly right.

  An interactive session is now offered the choice: **carry on** doubles the
  ceiling and the turn continues, **stop here** does what it always did and
  reports what was found. Stopping is the default, and the question returns at
  each new ceiling — carrying on is a decision taken once per limit, not a
  limit quietly switched off.

  Deliberately not routed through the `confirm` used for tool permission.
  `--yes` means "do not ask me about tool calls", and reading it as "spend
  without limit" would let a headless run go through a budget unattended. A
  turn with nobody watching still stops at the ceiling.

- **Anthropic's native Messages API, because the compatible one cannot cache.**
  molt reached Anthropic through its OpenAI-compatible `/chat/completions`,
  which accepts `cache_control` and throws it away. Measured against the live
  API: `{"type":"bogus"}` returns **200** there and **400** on `/v1/messages`
  naming the field; no compat response has ever carried a cache field; the
  `prompt-caching` beta header changes nothing. A field accepted without being
  parsed is a field being discarded — so an agent loop on that endpoint re-read
  its entire conversation at full price on every step, for ever.

  molt now speaks the native protocol when the endpoint is Anthropic, and the
  translation lives at the edge: `Msg` stays OpenAI-shaped everywhere else, so
  the transcript, shedding, the archive, receipts, the journal and the bar are
  untouched — a wire format has no business in the evidence path. Three
  differences do the damage if you get them wrong, and each fails silently:
  system is a top-level field, not a message; every tool result belonging to one
  assistant turn must arrive inside a *single* user turn as `tool_result`
  blocks; and `tool_calls` become `tool_use` blocks beside the text rather than
  a sibling field. Streaming is block-oriented rather than choice-oriented, so
  it has its own reader — tool arguments arrive as `input_json_delta` fragments
  that are only valid JSON once the block closes, and reassembling them per
  block index is the part that turns a real call into an empty one.

  Verified live end to end: a two-step agentic run with parallel tool calls
  served **3,063 of 3,384 prompt tokens from cache (90%)**. The same run on the
  compatibility endpoint caches nothing at all.

- **Anthropic's published prices, since it has no endpoint to ask.** Every other
  provider molt talks to publishes a price list; Anthropic does not, so the
  meter read "no price for this model" on exactly the endpoint where caching
  does the most work. Standard rates are carried in-tree — deliberately not the
  lower introductory ones, because a promotion expires and a budget that
  under-counts stops you too late. Cache reads are priced at a tenth of input,
  which is the whole reason the native protocol was worth writing. `/price`
  still overrides both numbers.

- **Prompt caching, on whichever provider you point it at.** Re-sending the
  conversation every step is what an agent loop *is*, and it is where the money
  goes: a measured session here spent 939,000 prompt tokens against 7,900
  completion tokens — 99.2% of the input bill was re-reading what had already
  been sent. Providers split into two camps and molt now serves both. OpenAI,
  xAI, Groq and most OpenAI-compatible hosts match on the prefix with no opt-in;
  there is nothing to send, and the only thing that matters is that the prefix
  does not move — which `test/cache.test.ts` now pins. Anthropic-family models
  cache only up to a `cache_control` breakpoint, and without markers the hit
  rate is exactly zero: the same session costs about **2.2× more**. molt places
  them automatically — one on the system prompt (which sits behind the tools, so
  it caches both) and up to three rolling along the tail, spaced to stay inside
  Anthropic's 20-block lookback, because an agent step that appends a dozen tool
  results can otherwise push the previous marker out of range and miss silently.
  Applied by model as well as by host, so an Anthropic model reached through
  OpenRouter gets the same treatment as one reached directly.

  **A marker never changes what the model reads.** Text, order, roles, tool
  calls and tool-call ids are asserted byte-identical with the markers stripped;
  assistant turns carrying tool calls are left alone entirely. And an endpoint
  that refuses `cache_control` costs one retry, not a turn — molt drops caching
  for the session, says so in the log, and carries on, the same way it already
  handles a provider that rejects `stream_options`.

  Cache accounting reads Anthropic's `cache_read_input_tokens` /
  `cache_creation_input_tokens` as well as the OpenAI `prompt_tokens_details`
  shape, so a working cache is never reported as 0% just because the provider
  named the field differently.

- **The view shows everything now.** Results were capped at 600 characters and
  five lines on their way to the screen, while the model got the whole thing —
  so the two of you were looking at different text, which is the one outcome a
  transparency view cannot have. Every line of every result is shown, exactly
  the bytes the model received, and a failing check's output is no longer cut
  off after eight lines. The panel stays a fixed height (a growing live region
  tears the terminal) and the full detail goes to the transcript, which is
  printed once and never redrawn — so the terminal's own scrollback keeps it
  all. Opening the view also prints everything recorded before you opened it.
- **`edit_file` silently corrupted any replacement containing `$`.** The single
  replacement used `String.replace`, which reads `$&`, `$1`, `` $` `` and `$'`
  in the replacement as substitutions rather than text — so editing a regex, a
  shell script, or anything with jQuery in it wrote something other than what
  was asked for, in the one tool whose whole job is exactness.
  `const price = OLD;` with `$&` came out as
  `const price = OLD and const price =  and $1;`. It splits and joins now, like
  `replace_all` already did.
- **A malformed tool call told the model the wrong thing.** Unparseable
  arguments became `{}` and the tool ran anyway, so a bad `read_file` surfaced
  as "EISDIR: illegal operation on a directory" — sending the model to debug a
  path it never sent. Nothing runs now, and the result says the arguments were
  not valid JSON and shows what arrived.
- **`--budget`, `--auto-shed` and `--attempts` accepted junk as NaN**, which
  compares false against everything and silently switched the limit off.
  Rejected with a message naming the flag and the value.
- **"Cancelled — the session is unchanged" was not true.** The transcript rolls
  back; the filesystem cannot, and molt cannot un-write a file. Cancelling now
  names the files that were already written and are still on disk, or says
  plainly that none were.
- **A dead branch in the receipt** (`r.ok ? (r.advisory ? "pass" : "pass")`) and
  **a fingerprint that could collide inside a millisecond**, letting a stale bar
  result be reused after an unreadable scope. Both from the same review.
- **Shedding removed a file from context and then molt refused to give it
  back.** The read-coverage map that stops a model re-reading what it already
  has did not know about compaction — so after a shed, molt told the model to
  "scroll up" to messages it had just archived, refused the re-read, and then
  counted its own refusals as the model going in circles. A reported session
  spent 29 of its 31 repeat-refusals after the first shed, ran 42 steps, and was
  killed by the no-progress guard with nothing verified. Coverage is cleared
  when context is shed, which is the only honest state: the model no longer has
  what it was shown.
- **The no-progress stop reported the session's tokens as the turn's.** The
  message that said "this turn used 1,664,354 tokens" was quoting a
  three-turn session total, which made a stop look several times worse than it
  was. It reports the turn's own spend now, and names the session total
  separately.
- **The last of the truncation is gone.** A tool line cut the command at eighty
  characters, so the one thing you most need to read — what molt actually ran —
  was the thing being abbreviated. The working line cut what it was working on
  at forty-eight. `/shed --explain` showed twelve lines of a digest and twelve
  of an exuvia. `/archive <pattern>` stopped at five hits and 200 characters
  each. All of it prints whole now and wraps; the transcript is written once and
  never repainted, so there was never a rendering cost to pay for it.
- **You can type while molt is working.** Keystrokes were swallowed for the
  whole turn, so a thought that arrived mid-run had to be held until it
  finished. The line is yours now, and enter queues it to start the moment the
  turn ends. shift+V and shift+A still work there, but only on an empty line —
  which is the same rule as at an idle prompt: a letter is a command when there
  is nothing to type it into, and a letter otherwise.
- **`claims-grounded` called `Date.now` a missing file.** It also flagged
  `r.ok`, `String.replace`, `Journal.protect` and `//example.com`, and refused a
  correct analysis over all of them. "Anything after a dot" describes a method
  call as readily as a filename, so the extension is checked against a list of
  actual file extensions now. An allowlist, because this check refuses work: an
  extension missing from the list costs one unnoticed fabrication, and the
  alternative cost a real session its completion for writing `Date.now()` in a
  sentence.
- **A prompt longer than the terminal was clipped, not wrapped.** The input row
  was a Box of sibling Texts, which lay out as flex children — cut at the edge
  of the window rather than reflowed — so the tail of a long prompt vanished and
  the caret sat at the cut. Reported as "the cursor doesn't follow onto the
  second line"; there was no second line. It is one `<Text>` with nested Texts
  now, which is a single inline run, so it wraps and the caret wraps with it.
- **A streamed answer was truncated to its last eight lines.** The live region
  was capped to bound what the terminal has to repaint, which is a real
  constraint — but it gave up the wrong half. Completed lines now go straight
  into the transcript, which is printed once and never redrawn, and only the
  line still being written stays live. The repaint is one line; the answer is
  all of it. A refused claim is no longer wiped from the screen either: it was
  streamed, a terminal cannot unprint, and hiding the words the model actually
  produced is its own small dishonesty — it is marked instead, right above the
  reason it was rejected.
- **No credential-shaped literal anywhere in the source.** The redaction tests
  needed key-shaped strings and had them written out — `sk-proj-…`, `ghp_…`,
  `xai-…` — all invented, none real, and every one of them something a reader
  has to stop and check. Someone did, and was right to: a project arguing "do
  not take claims on trust" should not ship test data that has to be verified
  by hand, and GitHub's scanner would have flagged the PAT-shaped one and tried
  to revoke a token that never existed. The fixtures are assembled at runtime
  now, so the values are exactly as key-shaped as the redactor needs to see and
  the source contains nothing that looks like a credential.
- **One bar template instead of two.** `DEFAULT_BAR` was a hand-written
  template that nothing generated any more, sitting next to the generator that
  actually writes the file. It is now derived from that generator
  (`FALLBACK_BAR`), so the thing molt writes when it can detect nothing is the
  thing the code produces rather than a second copy that could drift from it.
- **Checks now say what they established, and receipts say what happened.**
  `pass work-landed` is a header, not a finding — and the finding was already
  computed, shown only when the check failed. Every result now carries its
  evidence on the same line: *2 files modified and verified byte-for-byte on
  disk*, *`npm test` exited 0 in 9578ms*.

  The receipt was worse: it opened with a provider name and a token count, and
  never said what the model actually did. It now answers the two questions
  someone reading it actually has, in that order — what changed (each file with
  the hashes before and after, and what proves they are still there), what the
  model ran, then each check with what it established. The session metadata
  moved to the bottom, where it belongs.
- **`claims-grounded` stopped seeing short filenames.** Excluding "e.g." by
  shape — a short stem with a short extension — also excluded `a.ts` and
  `b.js`, so a claim about a real file was no longer checked at all. The named
  list of abbreviations was doing the work; the shape rule was only costing
  coverage.
- **`watch:` on a check, and result reuse.** A completion claim runs the whole
  bar and the loop allows several attempts, so a ten-second suite costs forty
  seconds of inner loop re-proving what could not have changed. A check that
  declares what it reads is reused while none of it has moved: measured on a
  bar with a five-second suite, an attempt following a docs-only edit went from
  5.4s to 0.0s, and an attempt following a source edit re-ran everything.

  This is the most dangerous feature in the project, because a wrong cache is a
  false "verified" produced by molt itself — so it is bounded four ways. Memory
  only, one session, never on disk. Commands only, never builtins. The command
  and `expect_exit` are part of the key, so an edited bar cannot reuse the old
  bar's result. And every reused result says so, in the transcript, the receipt
  (`ran: no — reused`), and the log. Undeclared checks are fingerprinted against
  the whole project: correct, and almost never reusable. molt does not guess
  what a command reads.
- **`molt init` reads the project and writes a bar that gates on it.** It wrote
  three builtins and a block of commented-out examples, leaving the important
  half to you — which is the wrong default for the one file the whole product
  turns on. A bar of builtins alone proves a file changed and the record is
  intact: both true, neither the thing anyone cares about, and anyone who
  skipped uncommenting got a gate that could not fail for a reason worth
  knowing. molt now reads `package.json` scripts (with the right runner, from
  the lockfile), `Cargo.toml`, `go.mod`, `pyproject.toml`, and a `Makefile`,
  and writes the commands it finds — naming, next to each check, where it came
  from. A lint script lands as `advisory: true`, because a style opinion is
  information rather than a contract. Nothing is proposed that the project does
  not declare.
- **A standing note that shedding cannot take.** Compaction is lossy by design
  and the first thing it loses is intent: after a shed the model reads a digest
  of its own past, re-derives what it was doing, and usually re-reads the files
  it had just finished with. A few hundred tokens — the request, the files
  changed so far, the last thing the bar refused — now ride along outside the
  working set, so a compaction costs the model its notes and not its purpose.
  It lives beside the transcript rather than in it, which is what keeps it from
  shifting the indices a cancellation depends on.
- **Word navigation in the prompt.** `alt+←`/`alt+→` move by word and `alt+D`
  deletes the word ahead. `ctrl+W` could already chop a long path in one
  stroke; getting back in front of it took an arrow per character.
- **Advisory checks.** `advisory: true` on a check in `done.yml` makes a failure
  information rather than a refusal: it runs, it is reported as `warn`, it is
  recorded in the receipt, and it does not block a completion. Not every
  condition worth running is worth refusing over — treating a linter's opinion
  as a broken contract teaches people to delete the check instead of reading it.
- **One minimum-secret-length constant instead of three.** `redact`, the
  journal, and the receipts each spelled out the same threshold; a guard whose
  threshold lives in three files eventually differs in three files. Also a test
  pinning that redaction is stateless across calls — every pattern carries `/g`,
  which is harmless with `String.replace` and a silent skipped-match bug the
  moment anyone reaches for `.test()`.
- **Credentials are masked before anything is written.** The journal already
  refused to log message content for this reason, and then logged
  `curl -H "authorization: Bearer sk-live-…"` verbatim in a tool call's detail.
  Values molt actually holds (the session key) are masked exactly; provider key
  shapes, bearer headers, private-key blocks, and assignments to something named
  "secret" are masked by pattern, keeping the field name so the record still
  says *what* was hidden. Receipts are filtered the same way, because a receipt
  is a document you hand to someone who does not trust you.
- **Cost in the record.** Receipts carry what the session had spent when the
  claim was made, and `molt stats` reports **cost per verified change** beside
  tokens per verified change — the number molt's own pitch stands or falls by.
- **A standing probe suite for the autonomy classifier** (81 cases × 8
  shell variations). Every hole this classifier has had was found by running
  commands against it, never by reading it, so the probing is now a test that
  runs in CI.
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

### Changed

- **`EngineConfig.retryBackoffMs`** overrides the wait between retries. Added
  because the real backoff put half a minute into molt's own suite, which runs
  on every proof attempt — up to four of those in a turn.

- **`grepFiles`, `walk`'s tool-facing form, and the file-search path are async.**
  `walkAsync` is the one the model's tools use; the synchronous `walk` remains
  for fingerprinting. Both take a `deadline`, and `walk` now also takes
  `examine` — a cap on entries looked at, which is the bound that was missing.

- **`runBar`, `runCheck` and `Engine.proveNow` are async.** They shell out, and
  shelling out synchronously is what froze the UI. They return promises now;
  `await` them.

### Removed

- **The no-progress stop.** molt ended a turn after two consecutive steps whose
  calls it had mostly answered before. It was the wrong instrument: repetition
  is a *guess* at waste, and a model that re-reads a file it just edited,
  re-runs a suite to watch it go green, or re-checks a path before writing is
  repeating a call and making progress — and the read-coverage branch counts a
  largely-overlapping re-read as a repeat too. A reported session lost a turn
  with 384,000 tokens of real work in it and nothing to show, which is the
  "maximum cost, zero value" outcome the salvage path exists to prevent. Spend
  is bounded by the instruments that measure spend directly, are checked before
  every step, warn on the way up, and are yours to set: `/budget` for the
  session, the per-turn ceiling, and the step guard behind both. What survives
  is the half that pays for itself — a repeated call still gets a pointer
  instead of its payload, so a loop gets cheaper as it goes, and molt says on
  screen that it is going in circles.

### Fixed

- **A build artifact could satisfy the bar.** molt found this one itself, and
  walked straight into it: a file it had written under `dist-test/` no longer
  matched its ledgered hash, because a rebuild had overwritten it. Rather than
  conclude that a generated file has no business in the ledger, it **rewrote
  the compiled artifact so the hashes would agree** — and got a green receipt
  in 34ms, because a path under `dist-test/` is outside every `watch:` glob in
  the bar, so the two expensive checks were reused as well.

  So there was a route to "bar met" containing no verification: write into a
  build directory, watch the checks be skipped, be accepted. Writes into
  generated paths no longer enter the ledger — the write still happens, and the
  result says plainly that it does not count as work and why. That closes both
  halves: nothing under `dist/`, `dist-test/` or `node_modules/` can be work
  landed, and nothing outside the watch globs can quietly skip the checks.

- **A receipt said writes had not landed when they had.** `work-landed`
  compared a count of write *calls* against a ledger keyed by *path* — one
  entry per file, merging the first hash with the last. A turn that edited four
  files nine times between them therefore recorded *"5 further write(s) in the
  record did not land"*, and nothing had failed to land. Two counts, different
  units; the same mistake the cache breakpoints made with blocks and messages.
  A receipt is the document handed to someone who does not trust you, and that
  sentence was false in one.

- **molt's own bar was intermittently failing on a timing test.** Found by molt
  itself, mid-task, and correctly diagnosed as unrelated to the change it was
  making — but not harmless: a spurious bar failure costs a whole proof
  attempt, which is ninety seconds and a turn. The responsiveness checks
  measure wall-clock scheduling, and a transient burst beside them can
  deschedule the test process for longer than molt would ever block.

  Two changes. The stall bound is calibrated against the same machine's idle
  noise, taken in the same process immediately before the work, so a busy box
  raises the threshold instead of failing the test. And a bad first measurement
  is taken again before it is believed — safe here for a reason specific to
  this defect: blocking is deterministic, so a real regression fails both
  attempts, while a scheduling burst does not repeat. Confirmed by mutation:
  restoring the blocking implementation still fails all five checks.

- **The live view showed the payload instead of the work.** Every line of every
  tool result went into the feed, so one nine-kilobyte file read put two
  hundred entries in it and the panel — nine rows — showed the tail of a file
  dump with no sign of which call had produced it. Reported as molt spewing and
  filling the terminal, *"not good for traceability or what the model is
  actually doing"*, which names it exactly: a payload is not an account of an
  action.

  The panel shows the head of a result and then says how many lines it held
  back and that the model received all of them. The complaint this replaced was
  the opposite one — a view showing five lines of forty was asking you to trust
  the other thirty-five — and the same rule settles both: truncation that names
  what it hid is not a sample. `--verbose` still writes every line to the
  transcript, because that is the deliberate request for the whole thing.

- **The ceiling warning gave advice you could not take.** molt says *"80% of
  the ceiling — /budget raises it"* on the way up, and then queued `/budget`
  until after the turn it was warning about had already been stopped. A
  reported run typed `/budget off` at 80%, watched it come back *"queued — molt
  will start this when the current turn ends"*, and lost the turn at $1.02 of
  $1.00 with nothing verified.

  The engine already re-read the ceiling at the top of every step, so a limit
  raised mid-turn would have applied to the next one — nothing could deliver
  it. `/budget` and `/price` now run while a turn is going. Only those two:
  they change what molt may do next and nothing about the conversation, whereas
  moving the model or the endpoint halfway through is its own kind of wrong and
  still waits.

- **Opening the transparency view wrote itself into the chat.** shift+V dumped
  everything recorded so far into the transcript and then mirrored every note
  after it — each argument, byte count and line of every result — interleaved
  with what the model had said. The transcript is printed once and never
  redrawn, so closing the view could take none of it back. Reported as the view
  ruining the chat log and pushing the model's own words out of sight.

  Looking and recording are separate acts now. shift+V is a live view that
  leaves no trace in the record; `--verbose` at launch is the deliberate
  request to keep all of it in the scrollback, and still does. The panel shows
  exactly what it showed before.

- **A pasted block was drawn on top of itself.** A terminal sends carriage
  return for a line ending — pressing Return sends `\r`, and so does every
  newline inside a paste. Nothing downstream expected it: the prompt splits on
  `\n`, so a pasted block read as one enormous line and never summarised, and
  the raw `\r` characters reached the screen, where they mean *return to column
  one*. Each pasted line was therefore painted over the one before it. That is
  the interleaved, half-missing text reported three times — and it was never
  missing, only overwritten.

  Carriage returns become newlines on the way in, `\r\n` collapsing to one, but
  only in chunks longer than a single character: a chunk that *is* `\r` is the
  Return key, and rewriting that would leave the prompt with no way to be sent.
  Done byte by byte rather than through a string, because a chunk can split a
  multi-byte character and decoding half of one turns pasted text into
  replacement characters.

- **`/model` moved the model but not the endpoint.** Choosing an Anthropic
  model after starting on xAI sent the Anthropic key to `api.x.ai` and came
  back *"Incorrect API key provided. You can obtain an API key from
  console.x.ai"* — a confusing message about the wrong provider entirely.
  `applyModel` was doing the right thing; the endpoint, the protocol choice and
  the caching style were computed once in the constructor and never moved
  again, so switching provider left all three pointing at the session's first
  one. They are derived from the configuration now, which cannot go stale. A
  provider switch also clears what the previous endpoint had refused —
  `cache_control` or `stream_options` — since that says nothing about the new
  one.

- **A pasted block looked like it had been cut off.** The summary showed the
  opening words with a trailing "+10 more lines", which reads as truncation —
  reported as *"it only pastes some of the text, or I can't see the whole
  text"* — when every character had in fact been kept and sent. The count goes
  first now (`[11 lines, 619 chars] Section 3 of…`), before the eye reaches
  anything that looks missing.

  The same fix closed a case the first one missed. A chunked paste arrives
  before its first newline does, so four hundred characters of a single line
  grew the prompt to six rows and collapsed it again when the newline landed —
  the same height oscillation, reached without a newline in sight. The prompt
  now summarises on width as well as on line count, and the tests measure the
  rows the prompt actually occupies rather than the height of the whole frame,
  which grows for reasons of its own and made the first version of them pass
  regardless.

- **Pasting more than one line tore the display.** The prompt is a live region,
  and a paste arrives in several reads, so an eight-line block re-rendered it at
  eight different heights on the way in — 10 rows to 15 in a measured run. A
  terminal repaints that region by erasing a line count, so the result came out
  interleaved: lines overwritten, fragments in the wrong order, whole lines
  gone. Reported from use, with a pasted list that lost two of its seven points
  and merged three others.

  The text is kept in full and drawn on one line: the first line, then how many
  more there are and how many characters. Frame height now holds constant while
  a paste arrives, and every character still reaches the model — bounding the
  display must not bound the message.

- **A cache that stopped working said nothing.** Worse than one that never
  worked, because the never-cached warning cannot fire: the session total keeps
  the early hits and looks healthy while every new step pays full price.
  Observed on a real run against xAI — two steps reusing most of the
  conversation, then 128 tokens reused against a prompt growing to 50,000,
  which was most of that turn's bill. molt now says so once, per step rather
  than cumulatively, and only above 10,000 prompt tokens where the difference
  is real money.

- **Cache breakpoints were spaced in the wrong unit.** The rolling markers were
  placed every twelve *messages*, but Anthropic's lookback is denominated in
  *content blocks*, and molt holds one message where the wire carries several —
  an assistant turn with three tool calls is one message and four blocks. The
  ratio runs from about 1.5× at one tool call per step to 1.9× at ten, so a
  twelve-message stride reached twenty-four blocks under parallel tool calls,
  past the window, silently. Spacing is counted in blocks now.

  The test that was supposed to catch this asserted the wrong property — the
  gap between markers within a single request — and in message units, so it
  passed because its fixture made one call per step. What actually has to stay
  inside the window is how far the *tip* marker moves between consecutive
  requests, since that is the distance it reaches back to find the entry the
  last request wrote. Measured on the native wire: 3 blocks per step at one
  tool call, 7 at three, 13 at six. It is asserted at each of those now, and
  the test also requires the marker to advance at all — pinning it to the front
  satisfied a ceiling-only assertion while caching nothing past the system
  prompt, which is what the first rewrite of it did.

  Known limit, stated rather than papered over: a marker can only sit on a
  message carrying text, so an assistant turn making ten parallel calls is
  twenty-one blocks that no marker can land inside. Such a step overshoots the
  window, that one request pays full price, and the next recovers.

- **Backspace deleted forwards.** Terminals send DEL (0x7f) for the Backspace
  key, and Ink labels that `key.delete` — its own source carries a TODO calling
  the split a mistake — while the real forward-delete (`ESC [ 3 ~`) arrives as
  `key.delete` too, with an empty `input` in both cases. Nothing in Ink's public
  API tells them apart, so molt had been guessing from the caret position:
  forward if anything was ahead of the caret, backwards otherwise. That is why
  it looked erratic rather than simply wrong — correct at the end of a line, and
  eating the wrong character everywhere else.

  A guess cannot be fixed by guessing better, so the distinction is restored
  where it still exists: 0x7f becomes 0x08 on the way in, before Ink classifies
  it. Backspace now arrives as `key.backspace` and `key.delete` means only the
  key that actually deletes forward. alt+Backspace deletes the word behind the
  caret, which had been unreachable for the same reason.

  The remap lives in `renderApp` beside the ctrl+C setting, and the test helper
  now mounts through it rather than calling `render` itself — a helper that
  mounts its own way tests something the real program never runs, which is
  exactly how the ctrl+C bug survived a whole suite.

- **A flag with no value ate the next flag.** `next()` returned whatever came
  after, including another flag and including nothing. `molt run x --model
  --yes` set the model to `--yes`, dropped `--yes`, and sent that to a live
  endpoint for a 404. Others became `undefined` and either vanished silently or
  surfaced as `paths[0] must be of type string` from inside `resolve()`, naming
  neither the flag nor the mistake. Every value-taking flag now says what it
  wanted. `--attempts 0` (which let the first failed bar exhaust immediately),
  `--attempts 1.5`, and `--budget 0` (which parsed as zero and read back as "no
  budget") are refused, and `--price-in`/`--price-out` reject junk the way
  `--budget` already did instead of ignoring it.
- **`molt run` explained `molt prove`.** A work-landed failure always printed
  the standalone-prove footnote, which is true under `prove` and false under
  `run`: there *was* a session and it really did not write anything, which
  usually means the task was a question. The reader was sent to debug a command
  they had not run. The printer knows its caller now and `run` gets the `molt
  ask` answer the engine and the TUI already gave.
- **Receipts reused their numbers.** The sequence came from `count()` — how
  many receipt files exist now — which only matches "the next number" while
  nobody deletes one. Delete `0000` and the next write is `0001` again, so two
  receipts share a number and the index lists both. This project's own `.molt`
  reached 26 index rows over 9 files with sequences 0000–0008 each duplicated,
  and `molt receipts --show` reported no match for a receipt the listing had
  just printed. Numbering is now one past the highest ever issued, taken from
  the index as well as the directory, since the index is the part that
  remembers what was deleted. `--show` distinguishes "indexed, file missing"
  from "no such receipt".
- **`sort -o` and `uniq -o` ran unattended at medium autonomy.** Both are on
  the read-only table and nothing looked at `-o`/`--output`, so they overwrote
  a named file without asking — the same hole that kept `sed` and `awk` off
  that table in the first place. They ask now when told to write, and still run
  when only reading. `find -o` and `du -o`, where the flag means something
  harmless, are untouched.
- **`molt log --session <unknown>` said there were no logs and exited 0.**
  With 68 of them on disk. "No logs at all" and "no log by that name" collapsed
  into one null. They are separate answers now, and a miss names the id, says
  how many sessions there are, and exits 2.
- **`prove`, `doctor`, `verify` and `archive --explain` each opened a session
  log.** 68 logs in this project, 54 holding a single `session_start` and
  nothing else — and `molt verify` then walked all of them. The journal answers
  "what did this thing do?", and a doctor invocation did not do a session.
- **A search still froze the terminal, in the regex rather than the walk.**
  Bounding the directory walk fixed the eight-minute case; the scan then
  yielded only between files, and gated even that on a counter that fires once
  in eight. `.*with.*some.*words.*absent` over ten megabytes spent 457ms in the
  regex engine and blocked for **100%** of it. It yields every file and every
  thousand lines now. Found by the responsiveness check, which is what it is
  for.

- **Working looked like nothing happening.** With the transparency view
  closed, a step that took a minute was a spinner, a clock, and a line of
  accounting — no sense of what molt was reading or why, which is what "big
  empty spaces … hard to see what is actually happening" turned out to mean.
  A tool call now says how much came back (`read_file engine.ts → 8.9 KB`),
  which is the cheapest possible answer to "what did that actually do", and
  the wait says what it is waiting for (`thinking · step 2 · ~3.2k tokens
  sent`) rather than only how long it has been waiting. Both cost no extra
  rows: the full record is still one keystroke away.
- **The status line could clip what you were typing.** It and the typed line
  were flex siblings on a single row, and a row is clipped at the window edge
  rather than reflowed — so a longer status line pushed a half-written message
  off the right edge, which read as typing having stopped working. The status
  wraps now and the typed line has a row of its own. What molt has to say does
  not cost you sight of what you are saying.

- **Hitting the budget left molt unquittable.** The salvage request was the
  one request molt never made cancellable, and by the time it runs `inFlight`
  has already been cleared — so ctrl+C reached nothing, the turn stayed busy,
  and the prompt never came back. Exactly the moment you most want out. The
  salvage is cancellable now, and a second ctrl+C leaves regardless of what
  the turn is doing: "you can always get out" should not rest on having fixed
  every possible hang.
- **Every paragraph break the model wrote was deleted.** Ink drops a
  whitespace-only `<Static>` item when the items arrive one at a time — which
  is exactly how streamed output arrives. All at once the blank lines survive;
  incrementally they vanish, so prose written as paragraphs came out as one
  dense block. The break is carried on the row beneath it now, where it is no
  longer a whitespace-only item. A run of blank lines still reads as one: a
  model that left four did not mean four.
- **`--no-stream` hid everything the model said.** Prose arrives in the message
  body there, and nothing carried it — `assistant_text` is the turn's final
  answer and only comes at the end. So a non-streaming provider showed tool
  calls and step lines with none of the reasoning between them. It goes out as
  a delta now, the event that means "the model is talking", so both kinds of
  provider reach the screen the same way.

- **A directory walk yielded only every sixteenth directory.** Enough on an
  idle disk, not enough on a busy one: a slow `readdirSync` is slow on its own,
  and batching the yields stacked however many landed together into one stall.
  It yields per directory now, and the file scan every eighth file rather than
  every thirty-second. A search over ten thousand files stalls 21ms of 313ms —
  the same as an idle event loop's own scheduling noise.

- **Every way a step could fail threw the turn away, one policy at a time.**
  The network path had learned to retry; a refused request had learned to
  salvage; a stream that died halfway, a non-JSON body, and a response with no
  message in it had learned neither and ended the turn where they stood. None
  of those say anything about whether the work is any good, and by step nine a
  turn has tens of thousands of tokens of reading in it. They are one policy
  now: retry what a second attempt could plausibly fix — dropped connections,
  429, 408, 5xx, a broken stream, a proxy's HTML error page — and whatever
  happens, close by reporting what was found. A single rate limit is now
  ridden out rather than salvaged from, which is the cheaper outcome by far.
  `Retry-After` is believed when the provider sends it, since guessing shorter
  buys a second refusal and guessing longer spends the wait for nothing. A 400
  or a 401 is still neither retried nor salvaged: the request or the
  credentials are wrong, and paying twice to be told so is the spending this
  exists to stop.
- **`read_file` returned about four hundred lines at a time.** A part is not
  cheaper than the whole — the file lands in the conversation either way, only
  spread across steps that each resend everything before them. Reading molt's
  own `src/` took 36 round trips; it takes 27 now, against a floor of 22. The
  cap stops at 32KB deliberately: 64KB saves three more trips and doubles what
  one careless read can dump into the context, and overflowing into a shed
  costs the prompt cache the whole session has been riding on.

- **One `grep` ran for eight minutes and returned nothing.** Three faults
  compounding. `globToRegExp` escaped `{` and `}`, so the very ordinary
  `*.{ts,tsx}` compiled to `^[^/]*\.\{ts,tsx\}$` and matched a file literally
  named that — no error, no matches. The walk's `limit` counts entries *kept*,
  and a glob that keeps nothing never reaches it, so the cap that was supposed
  to bound the work was unreachable. And `SEARCH_DEADLINE_MS` was created
  before the walk and first consulted in the scan loop *after* it — bounding
  the cheap phase and not the expensive one. So a search under a home directory
  walked to depth 12 for eight minutes, synchronously, froze the terminal for
  all of it, and reported "no match". Braces expand, the walk is bounded by
  entries examined and by a clock, and it runs off the main thread: the same
  search now takes 1.1s and finds its 113 matches.
- **"No match" could mean "I never looked".** A search cut short by its own
  bounds reported an empty result identically to one that had read the whole
  tree, so a model could conclude a symbol did not exist and act on it. A
  partial walk now says it was partial and that this is not evidence of absence.
- **A dropped connection threw the whole turn away.** `TypeError: fetch failed`
  — a DNS blip, a reset, a laptop waking up — ended the turn on the spot, with
  no retry and none of the salvage every other stop gets. One reported session
  lost forty-nine thousand tokens of reading that way, and was told only
  "network: TypeError: fetch failed". Requests retry with backoff, the waiting
  is visible while it happens, and a turn that genuinely cannot reach the
  provider still closes by reporting what it found.

- **molt froze while it worked.** The `bash` tool and every bar check ran
  through `execSync`, which does not merely block the caller — it stops Node's
  event loop for the life of the command. Measured: a two-second command
  produced **zero** ticks of the TUI's 90ms spinner. So the spinner stopped
  mid-frame, the elapsed counter stopped, and keystrokes sat unread in the
  buffer until the command finished. On a bar check, whose default timeout is
  two minutes, that is a two-minute freeze — and the thing you most want to
  interrupt, a suite that has obviously gone wrong, was the one thing you could
  not, because ctrl+C could not be *read* until it was over. Both now run
  through `runCommand`, which spawns and awaits; the same command now yields 22
  of an expected 22 ticks. ctrl+C also kills the command it is waiting on
  rather than only the network request, which had already finished.

- **Every step's narration ran into the next one's.** Streamed prose does not
  end in a newline, and nothing said where a message stopped — so the tail of
  each step sat in the live region and the next step's first word was appended
  straight onto it: "…real bugs and product defects.The workspace is the home
  directory…", one paragraph growing all turn, printed *below* the tool calls
  it was introducing. The engine states the boundary now (`message_end`, sent
  after the message is on the transcript and before the tools it asked for), so
  narration lands above the work it introduces and each step starts on its own
  line.
- **`molt run` printed the final answer twice.** The deltas streamed it and
  `assistant_text` repeated it verbatim. That event now says whether the text
  already went out as deltas; it is still sent either way, because the exit code
  turns on it.
- **A key the model echoed back was redacted everywhere except the screen.**
  Tool arguments and previews were masked and streamed text was not — and
  streaming is the default path. The whole streamed message is masked before it
  is yielded (joined first: a key split across two chunks matches neither half).
- **ctrl+C killed molt instead of stopping the turn.** Ink exits the process on
  ctrl+C on its own unless told not to, beside whatever the app does with the
  key — so "ctrl+C cancels the turn" was dead code, and the key took the session
  down mid-request with a half-typed line. molt owns the key now: it cancels a
  running turn, clears a written line, and exits only on a second press of an
  empty one. Every test had passed `exitOnCtrlC: false`, which is exactly why
  none of them caught it; the TUI has one mount helper now and the flag is not
  a knob a caller can get wrong.
- **A price was inherited by the next model.** Switching from grok-4.6 to
  claude-sonnet-4-6 kept grok's $2/$6, because Anthropic publishes no prices and
  molt was written to preserve an existing rate rather than blank a meter
  somebody had configured. So a real session was shown **$0.42 for work that
  cost about $0.69** — a meter 40% under the truth, which is worse than one
  showing nothing. A price only stands for the model it was recorded against;
  otherwise it is cleared, and molt says so.
- **`molt stats` reported one session as the whole project.** Session totals
  climb across the attempts inside a session, so taking the largest reading
  across *all* receipts gives the biggest session rather than the sum — five
  sessions of work reported as whichever was largest, with cost per verified
  change inheriting the same undercount. Receipts now record which session they
  belong to, and older ones are grouped by watching the counter reset. Found by
  molt reviewing its own source.
- **`python -c`, `node -e`, `ruby -e`, and `sh -c` ran unattended at high
  autonomy.** `python -c "os.remove(x)"` deletes a file without the word `rm`
  appearing anywhere — not a gap in the deny-list so much as the reason a
  deny-list cannot be the whole answer. An interpreter handed a program on the
  command line is opaque by the same rule that already sends `$(...)` to a
  prompt. Running a script *file* is untouched. (The same review claimed
  `/bin/rm`, `env rm`, and `busybox rm` slipped through; they did not, and
  there is now a test saying so.)
- **The README told people to install a package that does not exist.**
  `npx @solvyxtech/molt` — the GitHub org — where the package is `@solvyx/molt`.
- **The version was a string literal in `cli.tsx`**, correct today and destined
  to drift from `package.json`. Read from the manifest npm actually publishes.
- **A comment promised advisory failures were handed to the model.** They are
  not, deliberately — a check that does not gate has no place in the "fix these
  and claim again" message, or the model spends tokens fixing theatre.
- **`claims-grounded` refused a correct document, then made the model wreck it.**
  Three faults at once, reported from a real session that spent 1.13M tokens
  and never finished. "e.g." parses as a stem and a one-letter extension, so it
  was flagged as a missing file — along with "i.e.". A file the model had *read*
  did not count as grounded, only one it had written or one sitting in the
  project directory, so an assessment of source installed elsewhere was called
  a fabrication for naming files it had just been reading. And a bar failing
  identically on every attempt kept going, so the model spent step after step
  stripping abbreviations out of its own prose to satisfy a check that was
  wrong about it.

  Reading a file now grounds a reference to it — the same evidence a write is,
  one step earlier. Prose abbreviations are excluded by name and by shape,
  while anything in backticks is still trusted as a filename. And a bar that
  fails in exactly the same way twice stops, because the model is not
  converging on it: either the work cannot satisfy the check, or the check is
  wrong about the work, and both are worth a person's attention rather than
  more tokens.
- **"844k in" read as 844,000 tokens of reading.** It is one conversation
  resent once per step — thirty steps at a 28k context is 840k billed input,
  and maybe 30k of distinct content. The session line now shows the live
  context size beside the cumulative total, and always shows the cached share
  rather than hiding it when it is zero.
- **Anthropic's compatibility endpoint caches nothing**, which molt had no way
  of telling you. Identical prefixes bill identically and its `usage` carries
  no cached figure — prompt caching there needs `cache_control` breakpoints the
  OpenAI-compatible schema cannot express. So every step re-bills the whole
  conversation at full rate: the 844k above is about $2.53 on Claude Sonnet
  versus roughly $0.74 on a provider that caches automatically. molt now says
  so, once, when a session passes 100k uncached prompt tokens. Combined with
  Anthropic publishing no prices, that was the most expensive and least visible
  configuration available.
- **The turn ceiling was denominated in the wrong unit.** Tokens scale with
  context size, so the same limit bought forty steps on a small project and
  four on a large one — it measured depth, not waste. It also ignored caching:
  228,000 cumulative prompt tokens with 75% cache hits costs about $0.22 while
  the token count says $0.68, so the budget was charging for tokens the
  provider was discounting. The ceiling is money now ($1.00 a turn by default),
  with a generous token fallback (500k) only when no price is known — and it
  says something at 50% and 80% of the way up rather than speaking for the
  first time when it stops you. `/budget $2.50` sets it, `/budget off` removes
  it. Waste is caught by the guards that can recognise waste; this is only a
  backstop against a turn that is genuinely expensive.
- **`/model` listed no Anthropic models after a successful login.** Their
  compatibility layer accepts `Authorization: Bearer` on `/chat/completions`
  but not on `/models`, which wants `x-api-key` and `anthropic-version` — so a
  working key produced a 401 on the model list and an empty provider in the
  picker. Headers are now chosen per endpoint.
- **Logging in changed the provider but kept the old model**, so the status
  line read `anthropic · grok-4.6` — a pairing that exists nowhere, shown as
  fact, on the row whose entire job is to say what you are pointed at. A model
  belongs to the endpoint that serves it; switching endpoints clears it, and
  the picker opens straight away. With no model selected the hint now says
  `/model` when a key is already stored, rather than telling someone who just
  logged in to log in.
- **`grep` could hang molt indefinitely.** A pattern the model wrote —
  `(a+)+$` against a long line — ran with no timeout, no output, and no way
  back. `bash` and bar checks have had timeouts all along; the tool running
  model-supplied input had none. Nested quantifiers are declined before they
  run (naming the simpler equivalent), with a 5s deadline and a line-length cap
  behind that.
- **The project boundary was crossable by a symlink.** `insideProject` resolved
  lexically, so a link inside the project pointing anywhere read as "inside" —
  and a model at high autonomy can create that link itself. Resolved through
  symlinks now, including for files that do not exist yet.
- **`molt doctor` exited 0 with a model the endpoint does not have**, so a
  preflight passed and every subsequent request failed at the provider.
- **A model drifting its read offset a few lines at a time** ran to the step
  guard — 32 steps, 99,000 tokens — because a window overlapping an earlier one
  by 99% is not *contained* by it. What counts is how much of a read is new.
  Same shape now stops in 3 steps.
- **Paging and pruning combined into a 661,000-token loop.** Elision was keyed
  on the file path, so lines 401-440 of a file "superseded" lines 1-40 — molt
  deleted what the model had just read, and the model went back to read it
  again. Every step, for thirteen minutes, at $0.93, with no answer. Two
  features that were each correct alone. Elision now keys on the exact window,
  and a write still invalidates every part of that file.
- **Shifted offsets walked past the repeat guard.** Asking for line 181 and then
  line 182 returns almost the same bytes under a different key, so exact-match
  detection saw nothing. molt now tracks which lines of which file it has
  already shown, and a request inside that coverage gets a pointer. The
  no-progress stop now triggers on a majority of repeats rather than requiring
  every call in a step to be one.
- **A stopped turn threw away everything it had paid for.** The step guard, the
  budget, the turn ceiling, and the no-progress stop all ended a turn with
  nothing — maximum cost, zero value. A stopped turn now gets one final request
  with tools disabled, asking for what was found and what could not be
  determined. That answer is explicitly **not** run through the bar and is
  labelled as notes rather than a completed task, because presenting it as
  verified would be the lie this tool exists to refuse.
- **A per-turn token ceiling** (200k, `/budget` to change) and **shedding on by
  default** (60k of history). Both existed as options nobody set; the runaway
  session had neither.
- **`git stash`, `git config`, and `git tag` were classified read-only** and ran
  unattended at medium — bare `git stash` moves the working tree, `git config`
  writes a file, `git tag` creates a ref. Found by a model reading the list and
  saying so.
- **`claimedWrites` ignored `edit_file`**, so a session whose edits all failed
  reported "no file was modified" rather than naming the edits that did not
  land: a correct refusal with a misleading reason.
- **An unrecognised tool ran unattended at `high`**, which contradicted the
  deny-by-default rule stated at the top of the classifier. A level written
  today cannot consent to a tool added tomorrow; unknown tools now ask at every
  level. Found by the probe suite on its first run.
- **`high` autonomy ran `rm secrets.env` unattended**, while this changelog and
  `docs/autonomy.md` both said it ran "everything except what cannot be undone".
  The deny-list required a flag on `rm`, so deleting one named file was not on
  it — and neither were `find -exec`, `find -delete`, `truncate`, `tee`, `>`
  redirection to a path, `git checkout -- `, `git restore`, `git rebase`, or
  `git stash drop`. All now ask at every level. The documented promise is now
  "a named list", which is what the code actually implements: found by probing
  the classifier, which is the only way this kind of gap is found.
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

### Fixed

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

### Fixed

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

### Fixed

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

### Fixed

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

### Fixed

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
