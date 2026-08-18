# Autonomy — how much molt does without asking

Every approval prompt is a tax on a decision that was going to be "yes". A
prompt you always approve has stopped being a control and become a reflex, and
a reflex is worse than nothing: it trains you to click through the one that
mattered.

So the decision moves up a layer. You say how far molt may go; molt asks only
at the edge of it, and shows the level on screen the whole time it is in force.

```
xai · grok-4.6 · auto medium · 12k tokens · $0.012
```

**shift+A** sets it, everywhere:

| where | what it does |
|---|---|
| at an empty prompt | opens a picker — arrows choose, enter sets, esc cancels |
| while molt is working | cycles low → medium → high → low immediately |
| while molt is asking permission | cycles immediately, without answering the prompt |

A terminal cannot tell `shift+A` from the `A` that starts "Add a test", so on
an empty line the key opens a chooser and **changes nothing until you press
enter** — and escape gives the letter back. Mid-sentence a capital is just a
capital: "fix the Auth bug" types the way it reads. Where there is no typing to
collide with, the key cycles outright, because that is where speed matters.

`ctrl+A` and `/autonomy [level]` do the same from anywhere. Headlessly:
`--autonomy <level>`.

## The levels

| level | runs without asking |
|---|---|
| **low** (default) | The tools that cannot write: `read_file`, `list_dir`, `grep`. |
| **medium** | Those, plus writes **inside the project**, plus commands that only report. |
| **high** | Everything except a named list of destructive commands, and anything leaving the project. |

The read-only tools are never gated at any level, and that is the argument for
having them at all. `ls` through `bash` is a string this classifier has to
reason about; `list_dir` is a tool with no code path to a write, so its safety
is a property of its shape rather than of a regex over a command line. There is
nothing to outsmart. The project boundary still applies to them: a listing or a
search outside the directory molt was pointed at asks, at every level.

`--yes` is `--autonomy high`.

## What "only reports" means

Mechanically, not approximately. A command is read-only when **every** segment
of it — split on `;`, `&&`, `||`, and `|` — starts with something whose whole
purpose is to report:

- `ls cat head tail wc nl sort uniq cut tr diff cmp jq find fd file stat tree
  du df pwd echo printf which whoami date basename dirname realpath readlink
  grep rg ag ack env uname hostname`
- `git` with `status log diff show branch remote ls-files rev-parse blame
  describe shortlog cat-file tag config stash`
- `npm` / `pnpm` / `yarn` / `npx` with `test run ls why outdated view`
- `curl` / `wget` **without** a flag that makes it write or send a payload
  (`-X --request -d --data -F --form -T --upload-file -o --output -O`)

Anything else asks. Three rules make that safe rather than merely tidy:

1. **Deny by default.** An unrecognised command asks. A tool molt gains next
   year asks, because a level written today cannot have consented to it.
2. **Opaque constructions ask.** Redirection (`>`, `<`), command substitution
   (`$(…)`, backticks), a leading `VAR=value`, and `sudo` all mean the effect
   is not readable from the text, so it is not judged — it is asked about.
3. **A chain is judged by its worst link.** `git status && rm -rf build` is not
   a read.

## What is never automatic

At **every** level, including high:

- **Leaving the project.** Reading or writing a path outside the directory
  molt was pointed at. molt was aimed at one tree; no level implies consent
  beyond it.
- **A named list of destructive commands.** Deletion in any form (`rm` with or
  without flags, `rmdir`, `unlink`, `shred`, `find -delete`, `find -exec`),
  emptying a file in place (`truncate`, `tee`, `>` redirection to a path),
  history and published state (`git push`, `git reset --hard`, `git clean -f`,
  `git checkout -- `, `git restore`, `git rebase`, `git stash drop`,
  `npm publish`), machine state (`sudo`, `shutdown`, `pkill`, `chmod 777`,
  `dd of=`, `mkfs`), piping a download into an interpreter, and handing one a
  program on the command line (`python -c`, `node -e`, `sh -c`) — an unread
  program's effect is not readable from the text that launched it, which is the
  same rule that sends `$(…)` to a prompt. Running a script *file* is ordinary
  work and is not gated.

  **"Named list" is the exact claim**, and it is narrower than "everything that
  could lose data". An earlier version of this page said "everything that cannot
  be undone" while the code required a flag on `rm` — so `rm secrets.env` ran
  unattended at high. That gap was found by probing the classifier rather than
  by reading it, which is the only way this kind of gap is ever found. If you
  find another, it is a bug worth filing.

## What it is not

**It is not a sandbox.** These levels decide what molt *asks about*, not what
is possible. A command that runs can do anything you can do; the classifier is
a convenience over a permission prompt, not a boundary enforced by the
operating system. High autonomy on a machine that matters is your call to
make — which is why the level is always on screen while it is in force.

**It is not a way around the bar.** Autonomy governs permission; the bar
governs completion. A turn that ran forty commands unattended still has to
prove it finished, and a failing check still refuses the claim.

## The record

Every tool call is journalled with the decision that let it through:

```
04:33:49  permission granted (auto): bash grep -rn verify src/ [autonomy medium]
04:33:50  permission granted: write_file ../other/x.ts [autonomy medium]
04:33:52  autonomy medium → high · runs everything except what cannot be undone
```

A call nobody was asked about is exactly what an audit needs to find, so it is
recorded as `auto`, with the level in force at the time — and marked `[auto]`
in the transcript as it happens. Moving the ceiling is journalled too: a
session record that does not say when the level changed cannot explain why a
command ran unattended.

See [transparency.md](transparency.md) for the log itself.
