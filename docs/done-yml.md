# `.molt/done.yml` — the completion bar

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

Fails read-only tasks by design. If a task legitimately changes nothing, leave
this check out of that project's bar.

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
