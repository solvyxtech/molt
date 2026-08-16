# Changelog

## 0.9.0 — the login and model picker, restored

### Added

- **`/login`.** Pick a provider, paste a key, and molt stores it in
  `~/.config/molt/auth.json` at 0600 — outside the repo, so a tool whose
  whole pitch is an auditable record never writes a credential into one.
  Presets: ollama, openrouter, anthropic, openai, xai, groq. `/login xai`
  skips the picker. Key entry is masked and never enters the transcript.
- **`/model` with no argument** lists every model across the providers you
  hold a key for, grouped by provider. Picking one from another provider
  switches the endpoint and resets the session — different endpoint,
  different world. `/model <id>` still switches directly.
- **Both pickers are driven by the arrow keys.** `↑↓` to choose, enter to
  commit, esc to cancel — nothing typed, no ordinals on screen to read off
  and retype. Provider headers are rendered in the same bright colour the
  highlighted row gets, and are not selectable: the highlight steps over
  them, so a header can never be committed. Long lists scroll around the
  selection, and each drawn row carries its index in the full list, so a
  scrolled list cannot highlight one row while committing another.
- **The endpoint is remembered.** The provider and model you settle on are
  written to `~/.config/molt/config.json`, so a bare `molt` resumes there
  instead of starting from a guess.

- **A working indicator, and per-tool timing.** While a turn is in flight the
  prompt row shows a spinner, what the model is doing right now, and how long
  it has been doing it — `thinking`, `responding`, the name of a running
  tool, or `checking the bar`. The phase clock restarts only when the phase
  actually changes, so it answers "is this stuck?" rather than counting the
  whole turn. Each completed tool call carries its own duration on its line,
  timed around execution only: waiting on a human to approve a gated tool is
  not the tool being slow. A new `tool_start` event makes this possible —
  previously the only tool event fired on completion, so nothing could be
  said while the work was happening. Headless output carries the durations
  too, and `--json` gets the new event.

### Changed

- **The banner no longer repeats the session state.** The endpoint and model
  line under the wordmark said the same thing as the status line pinned above
  the prompt. The banner is a splash and scrolls away as the transcript
  grows, so its copy went stale while the pinned one stayed live — printing
  both meant the wrong one was on screen most of the time. The wordmark now
  settles to the version alone.

### Fixed

- **The command palette showed "… N more" and would not scroll to them.** It
  drew `matches.slice(0, 6)` regardless of the selection, so arrowing past the
  sixth row moved a highlight that was off screen, under a label advertising
  rows it would not display — worse than showing nothing, because it told you
  they existed and then hid them. The palette and the model picker now share
  one windowing helper (`windowAround`), which keeps the highlight visible,
  pins at both ends, and reports how many rows are hidden **above and below**
  rather than only below.
- **A refused claim stayed on screen and the next one appended to it.** The
  proof loop deliberately withholds a claim it refused — the engine emits no
  `assistant_text` — but streaming had already painted the text, and nothing
  cleared the buffer on refusal. Three refused attempts ran together on one
  line, and the answer molt had just refused to stand behind was left on
  screen looking like the answer. The stream buffer is now cleared on
  `proof_refused` and `proof_exhausted`.
- **The cost read `$0.0000` on cheap turns.** The arithmetic was right; the
  formatter was not. A fixed four decimal places flattened everything under
  $0.0001 to zero, so a 998-token turn at $0.02/Mtok — really $0.000024 —
  showed a meter stuck at zero while the token count climbed, which reads as
  broken pricing rather than a cheap turn. Decimals now scale to the amount,
  and below a millionth of a dollar it says `<$0.000001` rather than printing
  a zero that is not one.
- **The status line named the subdomain, not the provider.** `api.x.ai` was
  split on the first dot and rendered as `api` — the same label every vendor
  that fronts an API that way would get. The endpoint is now matched against
  the provider presets, falling back to the host with `api.`/`www.` stripped.
- **Token counts stop at `k`.** A session on a 1M-token context rendered as
  `2400k`, which is arithmetic the reader has to finish. Now `2.4M`.
- **The cost meter was never wired up.** `priceInPerMtok` and
  `priceOutPerMtok` were read by `Engine.costUsd()` but nothing anywhere set
  them, so the cost was always `undefined` and never rendered beside the
  token count. Pricing is now read from `~/.config/molt/config.json`
  (`priceIn` / `priceOut`, in USD per 1M tokens) and from `--price-in` /
  `--price-out` or `MOLT_PRICE_IN` / `MOLT_PRICE_OUT`, precedence flag → env
  → stored. An unusable value is ignored rather than allowed to reach the
  meter as `NaN`, and prices survive the config rewrite that `/model` does on
  every switch.
- **`tok` is spelled `tokens`.** The abbreviation saved three characters on
  the one line whose whole job is to be read at a glance.
- **molt no longer names a model it has not checked.** The status line
  reported `qwen2.5-coder:7b` on a local endpoint whether or not anything
  was running there, and showed a token count and cost against it. There is
  now no default model: until one is selected the line reads `no model ·
  /login`, and usage and cost are withheld rather than shown against a
  session that has not started. Sending a prompt with no model selected is
  refused with that instruction instead of failing inside the provider.
  This is the same rule the code already applied to pricing — *undefined
  when no pricing is configured, omitted rather than faked.*

### Restored

- `/login` and the cross-provider model picker existed in 0.5.0 and were
  lost in the 0.8.0 rewrite. `Engine.setBaseUrl` and `Engine.listModels`
  survived it as dead code; they are the substrate this is rebuilt on. The
  selection rules now live in `src/providers.ts`, pure and tested, rather
  than inline in the TUI — and rendering and selection read one array, so a
  number can no longer resolve to a row other than the one printed.

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
