# `.molt/done.yml` — the completion bar

`molt init` writes a first draft by reading the project: `package.json` scripts
(with the runner your lockfile implies), `Cargo.toml`, `go.mod`,
`pyproject.toml`, or a `Makefile`. Every generated check names its source in a
comment, and molt proposes nothing the project does not itself declare. Edit
freely — it is your file, and a first draft is all it claims to be.

The bar is what "done" means in this project, as a file you commit.

molt will not emit a final answer while any check fails. This is the default
contract, not a configuration option: a project without a bar gets a warning
on every launch saying its completions are unverified.

## Schema

```yaml
version: 1            # required, must be 1

checks:               # required, non-empty
  - name: <string>    # required, unique within the file
    run: <command>    # a shell command …
    timeout: 300      # optional, seconds (default 120)
    expect_exit: 0    # optional (default 0)
    advisory: false   # optional — true reports without blocking

  - name: <string>
    builtin: <id>     # … or a molt builtin, but never both

  - name: <string>
    builtin: mutation # the one builtin that also takes a `run`: the command
    run: <command>    # that must go red when a changed line is broken
```

A check needs **exactly one** of `run` or `builtin` — except `mutation`, which
needs both, because molt chooses the lines to break and only the project knows
which command should notice. A malformed bar is a hard
error, never a silent fallback to "no checks" — degrading quietly would switch
molt's central promise off by accident, which is worse than crashing.

### `run`

Any shell command, executed in the project directory. Passes when its exit code
matches `expect_exit`. Both stdout and stderr are captured and, on failure,
returned to the model verbatim.

YAML coerces bare scalars, so `run: true` arrives as a boolean — molt stringifies
it, because `/usr/bin/true` is a legitimate check. A `run` that is a list or a
mapping is rejected.

Every check runs on every attempt, even after one fails. A partial bar is not
a bar.

### Builtins

Builtins are checks only molt can run, because only molt still holds the full
session record — including context that has already been shed.

#### `files-changed`

Passes when at least one file was actually modified **and** every write molt
performed is still on disk with the exact content molt wrote.

Catches:

- an agent that claimed completion having written nothing
- writes that appear in the record but never landed (denied, errored, skipped)
- a file written and then deleted or overwritten later in the session
- a "fix" that rewrote a file with byte-identical contents
- a change whose every line is a comment or a blank

That last one is the check's own scar. A model asked to *read* a file was
refused for changing nothing, and on its next attempt added the line

```
// molt: CLI entry point - handles command parsing and execution
```

above a function whose signature already said that — then wrote in its receipt
that the edit was "to satisfy the work-landed check". Every other check passed,
so molt certified a task nobody had done. A gate must never be the reason a
change exists, and `files-changed` now reads the diff rather than only the hash.

The measurement is deliberately crude: of the lines that differ, how many are
neither blank nor purely a comment. It over-counts rather than refusing real
work, with two known blind spots — comment syntax is guessed from the line
rather than parsed, and a change that only *moves* code scores zero.

```yaml
  - name: work-landed
    builtin: files-changed
    comment-only: allow   # optional — a comment-only diff counts as work
```

Set `comment-only: allow` for a project where documentation genuinely is the
task, or to work around the move-only blind spot. It is refused on any other
builtin, so a typo is an error rather than a setting that quietly does nothing.

Fails read-only tasks by design. If a task legitimately changes nothing, leave
this check out of that project's bar — or use `molt ask`, which drops the write
checks for the turn.


#### `diff-covered`

Passes when every line this turn added is executed by the tests, and every
branch on those lines goes both ways.

This is the gap the checks above leave. `files-changed` proves a file moved.
The substance rule proves the movement was not only comments. Neither can say
whether the new code *does* anything.

A real turn added exactly this and passed six checks:

```js
export const MAX_COMMAND_LENGTH = 16384;           // referenced nowhere
if (path.length > MAX_PATH_LENGTH) return false;   // branch never taken
```

Branch counts are what catch the second line. Line coverage calls it covered —
the `if` executed. Only the branch count shows the `return false` was never
reached.

```yaml
  - name: work-proven
    builtin: diff-covered
    lcov: coverage/lcov.info
    tags: [session]
```

It does **not** run coverage. The command differs per project and a check that
guessed would be wrong more often than useful, so it reads the lcov your own
test command wrote. Node's test runner emits it with
`--test-reporter=lcov`; so do c8, nyc and pytest-cov.

A missing report **fails**. A check that verifies nothing when its input is
absent is worse than no check, because it is counted as one.

A changed line absent from the report is not held against anyone — lcov lists
only what the tool considers executable, so a type or an import simply is not
there. Silence means "not instrumented", not "not run".

Known limit: it catches the dead branch and not the dead constant. A
module-level `export const` executes at import, so coverage cannot see that
nothing references it.

#### `mutation`

Passes when breaking each new line makes the tests fail.

The rung above `diff-covered`. Coverage proves a line runs; it cannot prove
anything *checks* what the line does. A test that executes code while asserting
nothing satisfies coverage completely, and leaves the line exactly as unproven
as one never run — but with a green tick beside it.

```yaml
  - name: work-tested
    builtin: mutation
    run: npm test
    sample: 4
    timeout: 600
    tags: [session, slow]
```

`run` is the command that should fail when code is broken. `sample` is how many
changed lines to break — **each one costs a full run of that command**, so keep
it small and expect this on a slow tag rather than the inner loop. The report
says how many changed lines went unexamined; a bound nobody is told about reads
as completeness.

It runs the command once **unmutated** first and refuses to proceed unless that
passes. Without it, a suite that is already failing makes every mutation look
killed — the command failed, after all — and the check reports success having
tested nothing.

Every file is hashed before it is touched and verified after. A failed restore
is reported as this check failing, whatever the mutations found: a verification
tool that leaves your source altered has done something worse than miss a bug.

#### `record-intact`

Passes when everything this project shed is still recoverable.

Shedding moves write evidence out of memory and into the archive, so this is
the check that keeps the archive honest. It compares what is on disk against
three expectations the archive cannot itself supply:

- how many batches this session archived (engine memory)
- how many write records it handed over (engine memory)
- which archive files the session log recorded (the hash-chained journal,
  so a loss is caught in a later process too)

Fails when an exuvia was deleted or its evidence block corrupted, naming the
files that can no longer be proven. Passes trivially in a project that has
never shed.

#### `spec-intact`

Passes when no assertion was deleted from a test file this turn.

A turn may add tests freely. Deleting an assertion is a change to what the
project promises, and a model that does it while fixing a bug has usually
rewritten the specification to agree with its own change. Observed: asked to
prove a defect with a failing test, a model inverted the assertion that pinned
the existing behaviour instead. Compared as a set, so moving or reindenting an
assertion is not a removal.

```yaml
  - name: spec-intact
    builtin: spec-intact
    removals: allow    # optional — this turn may delete assertions
```

`removals: allow` is deliberately awkward: a test being obsolete is a decision
somebody should make on purpose. It is refused on any other builtin.

Known limit: it reads the write ledger, so an edit made through `bash` — a
script the model wrote and ran, `sed -i`, `cp` — is not seen by it, or by any
other ledger-reading builtin. At `--yes` those commands do not prompt.

#### `tree-accounted`

Passes when every file that changed on disk this turn was written through
`write_file` or `edit_file`.

The ledger builtins above read what the tools wrote. This reads what the disk
did. A test file rewritten by a script the model ran, an assertion commented
out with `sed -i`, a file emptied with `cp /dev/null` — none has a ledger
entry, and every ledger-reading check was blind to them. At `--yes` none of
those commands asks. molt snapshots the working tree (content hashes, with
`.molt/`, build output and dependencies skipped) when a turn begins and diffs
it when the claim is made; any changed, created or deleted path the ledger
does not hold refuses the claim and names the path. `spec-intact` reads the
same snapshot, so an assertion removed by any route is named.

```yaml
  - name: work-accounted
    builtin: tree-accounted
    outside: allow     # optional — changes made by commands are permitted
```

`outside: allow` is for a project whose tasks legitimately run generators or
installs. It is refused on any other builtin.

Fails closed: a tree too large to snapshot within molt's walk bound (20,000
entries or three seconds) refuses rather than passes, because a snapshot of an
unknown subset proves nothing about the rest.

#### `claims-grounded`

Passes when every file path the model names in its final answer either exists
on disk or was written in this project — including writes recorded only in
the archive.

Catches fabricated file references: an agent naming a module it never created
and reporting success. Deliberately conservative — a token must look like a
path with an extension, and URLs are stripped before scanning — because
over-matching would fail correct work, which is worse than missing a made-up
reference.

It says nothing to ground rather than passing vacuously when the claim
mentions no files.

## `watch` — what a check reads

```yaml
  - name: tests
    run: npm test
    watch: ["src/**", "test/**", "package.json"]
```

molt reuses a check's result for as long as nothing it watches has moved. A
completion claim runs the whole bar, and the loop allows several attempts, so a
ten-second suite can cost forty seconds of inner loop re-proving something that
could not have changed. Declaring the scope removes that.

Four rules keep a reused result honest, and they are worth knowing before you
rely on it:

- **Memory only, one session.** Never written to disk, never shared between
  processes. `molt prove` always measures rather than remembers.
- **Commands only.** Builtins read the session record rather than the
  filesystem, and they are cheap.
- **The check is part of the key.** Change the command or `expect_exit` and the
  previous result is not reused.
- **It says so.** A reused result is marked in the transcript, the receipt
  (`ran: no — reused`), and the log. A cached pass that looks like a fresh pass
  would be the exact claim molt exists to refuse.

Without `watch`, a check is fingerprinted against the whole project — correct,
and almost never reusable. molt does not guess what a command reads; scope is
something you declare, because a scope that is too narrow buys speed with a
stale pass, and that trade is not molt's to make on your behalf.

The signature is path, size, and modification time, not content hashes: reading
a repository to decide whether to read a repository is not a saving. Touching a
file without editing it re-runs the check, which is the safe direction to be
wrong in.

## Advisory checks

```yaml
  - name: lint
    run: npm run lint
    advisory: true
```

An advisory check runs, reports, and is recorded — and does not block a
completion. Its failure shows as `warn` rather than `FAIL`, and the bar is still
"met".

The distinction matters because not every condition worth running is a
condition worth refusing over. A linter's opinion, a coverage delta, a
bundle-size trend: treating those as a broken contract teaches people to take
the check out of the bar rather than to read it, and a bar people delete checks
from is worse than one that distinguishes. Advisory failures are handed to the
model too — it just is not blocked by them.

Everything else about the check is unchanged: it is selected by tag, it appears
in the receipt, and it cannot be edited by the work being judged against it.

## Tamper detection

molt fingerprints `done.yml` when the session starts and compares before every
run. If the file changed mid-session, a check named `bar-unmodified` fails and
the completion is refused, whatever the other checks say.

The agent is also told not to edit the file. That instruction is a hope. The
fingerprint is a control.

If you genuinely need to change the bar mid-task, stop the session and restart
it — that makes the change visible and deliberate rather than something the
work did to its own grading.

## Writing a good bar

The bar is only as strong as what you put in it, and molt says so plainly. A
bar of `run: true` proves nothing, and molt will happily report it passing.

Practical guidance:

- **Start with what CI already runs.** If your pipeline runs typecheck, lint,
  and tests, those are your first three checks.
- **Prefer specific over broad.** `npm test -- auth` on an auth task gives the
  model a tighter feedback signal than a 400-test suite.
- **Mind the clock.** Every check runs on every completion attempt. A 5-minute
  suite times four attempts is 20 minutes. Use `timeout`, and keep slow
  end-to-end checks for CI rather than the inner loop.
- **Include `files-changed`** unless the project has read-only tasks. It is the
  cheapest check in the file and it catches the most common lie.
- **Do not encode style preferences.** A bar is for correctness. Formatting
  belongs in a pre-commit hook, where a failure does not cost a model turn.

## Example

```yaml
version: 1

checks:
  - name: types
    run: npm run typecheck
    timeout: 120

  - name: tests
    run: npm test
    timeout: 300

  - name: no-debug-leftovers
    run: "! grep -rn 'console.log' src/"

  - name: work-landed
    builtin: files-changed

  - name: record-intact
    builtin: record-intact
```
