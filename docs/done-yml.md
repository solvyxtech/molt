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
```

A check needs **exactly one** of `run` or `builtin`. A malformed bar is a hard
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
