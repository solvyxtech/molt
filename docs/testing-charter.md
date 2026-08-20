# Testing molt

A working brief for anyone — person or model — asked to find bugs in molt.

molt's claim is that nothing it says has to be taken on trust. That makes a
particular class of bug much worse here than elsewhere: not the crash, but the
**quiet wrong answer** — the cache that reports 0% because the field was
discarded, the search that says "no match" when it never looked, the receipt
numbered the same as another one. A crash gets fixed. A quiet wrong answer gets
believed.

Everything below is grounded in defects that were actually found in this
codebase, not in general advice.

---

## Part 1 — How to test, which matters more than what

These seven disciplines each come from a real failure in molt's own test suite.
Follow them or the findings will be worthless.

### 1. Verify the instrument before you trust it

Before using a measurement to judge molt, prove the measurement can see the
defect. Point it at a deliberately broken version and confirm it goes red.

> `perf_hooks.monitorEventLoopDelay` was the obvious tool for detecting a
> blocked event loop. Against the actual blocking code it reported **0.0ms of
> delay** — it is maintained in C++, and `spawnSync` runs a nested libuv loop,
> so the histogram kept sampling happily while JS was completely starved. An
> instrument that reads clean on the exact bug it is aimed at.

### 2. Mutate the fix and confirm the test fails

A test that passes is not evidence. A test that fails when you break the thing
it covers is evidence. Revert the fix in the built output, re-run, watch it go
red, restore.

> Three tests in this repo passed by luck and were caught only this way.

### 3. Refuse ceiling-only assertions

`assert(x <= limit)` is satisfied by `x = 0`, which is often exactly what a
broken implementation produces. Assert the floor too.

> A cache-breakpoint test asserted the tip marker moved no more than 20 blocks
> between requests. Stripping the markers entirely made it move **zero** blocks
> — and the test passed, while nothing past the system prompt was ever cached.

### 4. Make the test double match production

Any place a harness constructs things differently from the real program is a
place bugs hide, permanently.

> Every TUI test passed `exitOnCtrlC: false`. Production did not. So molt's
> ctrl+C handling was tested and the code the real program ran was not — ctrl+C
> killed the process and the cancel branch was dead. The same shape recurred
> with the delete-key remap, and with a fake `Response` that had no `clone()`.

### 5. Check the unit

Two numbers can both be right and still not be comparable.

> Cache markers were spaced every twelve *messages* against a lookback measured
> in *content blocks*. molt holds one message where the wire carries several,
> so the real spacing was up to 24 blocks against a 20-block window.

### 6. Prefer a bug that fails silently

Rank findings by how quiet they are, not how dramatic. The worst bug in this
codebase's history returned HTTP 200 every time.

> Anthropic's OpenAI-compatible endpoint **accepts `cache_control` and discards
> it**. Verified by sending `{"type":"bogus"}`: 200 from the compat endpoint,
> 400 from the native one. A field accepted without being parsed is a field
> being thrown away, and the bill said nothing.

### 7. Measure before and after, in the same units

"Feels faster" is not a finding. `8m 01s → 1.1s` is.

---

## Part 2 — Weak areas, ranked

Ranked by expected yield: how likely a real defect is, times how quiet it would
be.

### A. Long sessions — shedding, regrow, the proof loop

**The least-exercised path in the product.** Almost all testing is short runs.
Shedding rewrites the transcript mid-session, which invalidates the cache
prefix, changes message indices, and moves evidence into the archive. On the
native Anthropic protocol it has *never been run live*.

Check:
- Force a shed (`--auto-shed 8000`) and confirm the session continues correctly.
- After a shed, does the cache recover, or does the hit rate stay at zero?
- Does `read_file` still work for a file whose contents were just archived?
  (This exact bug existed: molt told the model to "scroll up" to messages it
  had itself deleted, then counted its own refusals as the model looping.)
- Run the proof loop to exhaustion. `formatBarFailure` is injected as a
  message and goes through protocol translation.
- Does the receipt after a shed still list the writes that happened before it?

### B. The native Anthropic protocol

Newest code, fewest live miles. Every difference between the two wire formats
is a silent failure if wrong.

Check:
- Parallel tool calls (several `tool_use` blocks in one turn) — do all results
  come back attached to the right call?
- A turn where the model emits text *and* tool calls together.
- `max_tokens` truncation: what does molt do when `stop_reason: "max_tokens"`?
- A tool result containing very large output, or invalid UTF-8.
- Streaming interrupted mid-`input_json_delta` — is the partial call dropped
  cleanly or does it become an empty call?
- The salvage path on native (`tool_choice: {type:"none"}`).

### C. Caching correctness

Silent by construction: a cache miss costs money and looks identical to a hit.

Check:
- Is `cached` non-zero from step 2 onward? If it is 0 across a whole session,
  something is discarding the markers.
- Does the prefix stay byte-identical between consecutive requests? Anything
  that mutates an earlier message throws away every entry behind it.
- Do the markers survive `/model` switching? Caches are model-scoped.
- Does the salvage request reuse the parent's prefix, or rebuild it and miss?

### D. Anything that ends a turn

A turn that ends with nothing said has spent its tokens for zero value. Every
exit path must either produce an answer or explain itself.

Check every one: budget hit, turn ceiling, step guard, network failure,
HTTP 4xx/5xx, malformed response, stream death, cancellation, bar exhaustion.
For each: does it report what it found, or just a status code? Is it
cancellable? Can molt be quit while it is happening?

> A hung salvage made molt unquittable — the one request never made
> cancellable, reached at exactly the moment you want out.

### E. Event-loop responsiveness

Three separate freezes were found on three different paths. Assume a fourth.

Check: anything synchronous that scales with input — file reads, directory
walks, regex over large content, hashing, JSON of large structures. Measure the
longest gap between JS callbacks; a blocked loop stalls for 100% of the
operation while a busy machine produces many small gaps.

### F. Evidence integrity

The receipts, journal and archive are the product. A defect here is worse than
a crash.

Check:
- Receipt numbering under deletion, concurrent sessions, and interrupted writes.
- Does the index ever disagree with the files on disk? (It did: 26 rows over 9
  files, sequences 0000–0008 each duplicated.)
- Is the journal hash chain intact after a crash mid-append?
- Does redaction actually cover every path out — screen, receipt, journal,
  archive? (Streamed text was the one place it was missing.)
- Can the bar be edited mid-session to make a failing turn pass?

### G. The CLI surface

Was almost entirely untested until recently, and it is what CI reads.

Check: every flag with a missing value, a value that is another flag, a value
of the wrong type, zero, negative, fractional. Every exit code. Every command
with no arguments. Every command in a directory with no `.molt/`.

### H. Autonomy gating

A classifier over shell strings. Assume it is wrong somewhere.

Check: write flags on read-only commands (`sort -o` was a real hole), command
substitution, pipes into writers, `env VAR=x cmd`, symlinks pointing outside
the project, relative paths climbing out with `../`, quoting that hides a
redirect.

### I. Accounting honesty

molt distinguishes measured from estimated. Check that it never blurs them:
tokens the provider reported vs molt's estimate, prices fetched vs assumed,
cached vs uncached, per-job vs per-session. A number presented with more
confidence than it was earned with is a bug here even when it is close.

---

## Part 3 — Reporting a finding

A finding is worth reporting when it has all four:

1. **Reproduction** — the exact command or input, run against the real binary
   or the built output, not read from the source.
2. **Observed vs expected**, in the user's terms, not the code's.
3. **Why it is quiet** — what a person would believe instead of the truth.
4. **The blast radius** — who hits it, how often, and what it costs them.

State plainly what you did *not* verify. An unverified guess reported as a
finding costs more than silence, because it gets acted on.

Rank by quietness × frequency, not by how alarming it sounds.

---

## Using this with molt itself

```
molt --url https://api.anthropic.com/v1 --model claude-sonnet-5
/budget 200000
```

> Read docs/testing-charter.md and work section A. Reproduce every check
> against dist/ or the real binary, not by reading source. For each finding
> give reproduction, observed vs expected, why it is quiet, and blast radius.
> Where you fix something, first write a test that fails, then mutate the fix
> and confirm the test goes red. Say plainly what you could not verify.

Work one section at a time. The tree is committed, so `git checkout .` undoes
anything it writes.
