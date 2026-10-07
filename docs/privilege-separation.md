# Privilege separation: `--worker-user`

Unattended, with hidden checks, the worker model's tools used to run as the
same user as Maat. Whatever Maat could read, the worker could read. On
2026-10-07 a Grok worker was seen hunting for its hidden checks with
`grep -r` over `/`, `/opt`, `~/.grok`, Maat's own `dist/` and `.maat/`.
Masking what Maat writes (hidden checks withheld from receipts, the journal
and `out/`) closes the files Maat knows about. Several leaks remained, and
all of them come from the worker and Maat being the same user:

| leak | where |
|---|---|
| the reference program | a `ref-try-*` dir under `/tmp` |
| mission contracts | `.maat/mission/contract.yml` in the task folder |
| the judge's session store | `~/.local/share/opencode`, `~/.grok` under the same HOME |
| hidden check commands | `ps`, `/proc/<pid>/cmdline` |
| everything Maat holds | Maat's process memory |
| earlier runs | bench logs and task folders in `/work` |

`--worker-user <name>` (or `MAAT_WORKER_USER`) runs the worker as another
Linux user, so the kernel enforces the boundary and Maat no longer has to
guess which paths matter. It is opt-in and meant for containers, CI and
unattended runs. The desktop app and a plain `maat run` behave exactly as
before.

```sh
# as root (a container, a CI job)
maat run --worker-user agent --sandbox --criteria auto --cwd /work/task "fix the failing test"
```

Maat must run as root, or as a user with passwordless `sudo -n -u <name>`.
The worker user must be a different, non-root user, and it must be able to
read and write the project.

## What changes when it is on

**The worker's commands run as the worker.** That covers `bash`, background
jobs (`background=true`), and an ACP worker agent (Grok Build, OpenCode)
together with every tool that agent runs itself. Grok auto-approves its own
`read_file`, `grep` and `list_dir` without asking Maat, so only the uid can
bound those. As root, Maat spawns them with the worker's uid and gid and no
supplementary groups. With sudo, it uses `sudo -n -u <name> env -i ...`. The
environment is scrubbed: every variable whose name looks like a credential is
removed, along with Maat's own `MAAT_*` and `MOLT_*` settings. HOME, USER and
LOGNAME are set to the worker's, and TMPDIR is `/tmp`. The one exception is
the worker agent's own login: an ACP spec names it (`workerCredentialEnv`;
for OpenCode, `OPENCODE_API_KEY`), and that name, and no other, passes the
scrub for that agent's process only, never for the worker's shell commands.
Grok has none: its login must be in the worker user's HOME
(`~/.grok/auth.json`), as the bench sets it up.

**The file tools run as the worker.** `read_file`, `write_file`, `edit_file`,
`list_dir`, `grep` and `inspect` are carried out by a small helper process
(`dist/fs-helper.js`) that runs as the worker user. A read the worker could
not do itself fails with `EACCES`, symlinks included, because the kernel
checks the path as that user rather than Maat checking the name. Files the
worker writes are owned by the worker.

**Maat's records leave the project while the job runs.** The journal,
receipts (including the full twins), the integrity ledger, `out/`, exuviae,
judgment cases, the mission contract and state, and Maat's temp files all
move to a state dir:

- `MAAT_STATE_DIR` if set, otherwise
- `/var/lib/maat/<session>` when Maat runs as root, otherwise
- `~/.local/state/maat/<session>`

The dir is mode 700 and owned by Maat. `<session>` includes 48 random bits.
`TMPDIR` points into it, so reference tries (`ref-try-*`), the drafter's
scratch dirs, the copy-on-run trees for hidden checks (`maat-check-*`) and
the judge's own temp files are private too. When the job starts, records
from earlier jobs are copied out of the project's `.maat/` so the hash chains
continue, and a mission's contract, features and state are moved out of the
task folder. That copy is read, and the contract removed, by the file helper
running as the worker (`fs-helper.js pack`); Maat gets back regular files and
folders by name and writes them into its own state dir. Symlinks and other
special files in the project's `.maat/` are skipped, so nothing in the state
dir can point back into the worker's reach or out to a file of root's.

These stay in the project: `.maat/done.yml`, because a person wrote it, and
`.maat/bg/`, which holds the worker's own background-job logs. The worker
makes those itself: a background job starts as the worker with a shell that
creates the folder and opens its log, so the log is opened with the
worker's permissions and Maat never opens a path in the worker's tree.
`.maat/mission/library/` also stays, because the worker writes it. A spilled
output (`.maat/out/<call>.txt`) is still readable through `read_file`: Maat
serves its own masked copy of the worker's output. The worker cannot `cat`
it from bash.

**When the job ends, the records come back.** `maat run`, `maat ask` and
`maat mission run` copy the state dir (except `tmp/`) into the project's
`.maat/`, so receipts are where people always found them and `maat verify`
checks them there. Maat reads its own state dir and the file helper, as the
worker, writes the copies (`fs-helper.js unpack`), so they are owned by the
worker and Maat writes nothing into the worker's tree. If a copy cannot be
written with the worker's permissions, Maat says so and the records stay in
the state dir, which is always kept.

**The judge stays Maat's; the checks run as Maat or as the check account.**
Judge and ask subprocesses (OpenCode, a Grok judge, an HTTP judge) run as
Maat with Maat's HOME. If that HOME is readable by the worker, Maat tightens
it to 700 when it owns it and refuses to start otherwise. Without
`--check-user`, hidden checks run as Maat in the copy-on-run tree, never as
the worker; with it, they run as the check account (next section). A check
that ran in place as Maat (a project check, or a
tree too large to copy) can leave files owned by Maat in the project. After
every bar run, those are handed back to the worker, so the worker can keep
editing its own tree. The worker may be changing the tree while that runs,
so it is never walked by path: each folder is opened relative to its parent
with `O_NOFOLLOW|O_DIRECTORY` (`/proc/self/fd/<fd>/<name>`), ownership is
changed with `fchown` on the open descriptor, and the project itself must be
the folder (device and inode) the job started in. A folder swapped for a
symlink mid-walk fails to open and is skipped; files with more than one hard
link, symlinks, special files and other file systems are left alone. Hand-back
is Linux-only; elsewhere root-made files stay Maat's. Maat's own git calls in the project (snapshots, commits,
`ls-files`, the local exclude file, the brief's probes) run as the worker,
because the repository and its config belong to the worker. Maat does not set
`safe.directory`, so its own git keeps refusing a repository another user
owns.

## The check account: `--check-user`

```sh
maat run --worker-user agent --check-user checker --worker-strict ...
```

`--check-user <name>` (or `MAAT_CHECK_USER`) needs `--worker-user`. Task
checks then run as a third account instead of as Maat: hidden checks, drafted
task checks (`--criteria auto`), `--criterion` checks, the reference check
and its try on the untouched project (the compile and probe steps before it,
which run only the reference program, stay Maat's), mission assertions in the bar and at a
milestone seal, and the tries of drafted criteria before the work. A check is
model-written and runs the worker's code, so it no longer runs as root.

What it guarantees:

- **The account.** The check account must not be root, Maat's user or the
  worker, and its primary group must not contain the worker. Maat runs as
  root (it spawns the check with that uid and gid and no supplementary
  groups), or has passwordless `sudo -n -u <name>`.
- **The environment is an allowlist.** `PATH`, `HOME`, `LANG` and `TERM`, and
  nothing else of Maat's. `HOME` is a fresh, empty folder made for that one
  run and removed after it. No provider key, no `MAAT_*` setting, no `TMPDIR`
  (the check uses `/tmp`).
- **Its own PID namespace and /tmp.** When Maat is root with `CAP_SYS_ADMIN`,
  each check run is started with `unshare --pid --fork --mount-proc`, so it is
  the init of a PID namespace with its own `/proc` (it sees none of Maat's or
  the worker's processes, and everything it starts dies with it). Inside, an
  empty tmpfs is mounted on `/tmp`, `/var/tmp` and `/dev/shm` (except one that
  holds its working directory or Maat's state dir), and the check then drops to
  its account with `setpriv --clear-groups --no-new-privs --bounding-set=-all`.
  Nothing it writes to a temp dir outlives it, so it cannot leave the
  reference check where the worker can read it.
- **Its copy is its own.** The copy-on-run tree is made in
  `<state dir>.check` (owner Maat, group the check account, mode 710) and
  handed to the check account, so it can build, write caches and commit in it
  as it would in the project. The worker is neither owner nor group of that
  folder, so it cannot enter it.
- **The reference check is readable by the check account and not the
  worker.** Its programs (`check.py`, `second.py`, `driver.py`) and its
  snapshot of the untouched project live in the same check folder, group the
  check account, folders 750 and files 640.

Checks that must run in the project itself run as the **worker**, because the
tree is the worker's: a project's own `done.yml` command checks, a task check
whose tree was too large to copy, and the mutation builtin's runs. They get
the worker's scrubbed environment, and with `CAP_SYS_ADMIN` their own PID
namespace and private /tmp per run too (a hidden check that fell back to
running in place is not visible in the worker's process list). Nothing in the
project is then made by Maat, so there is nothing to hand back.

The check account's folder must be reachable: with the default state dir
(`/var/lib/maat/<session>`), Maat opens `/var/lib/maat` to 711 when it made
it (each session's own folder stays 700). With `MAAT_STATE_DIR`, a folder
above it closed to the check account means the check account cannot be used
(Maat says so; `--worker-strict` refuses). In sudo mode Maat cannot chown, so
the check gets read-only copies and the default state dir under Maat's HOME
(700) is not reachable: set `MAAT_STATE_DIR`.

## `--worker-strict` and the isolation line

`--worker-strict` refuses to start, with exit 2 and a message naming what is
missing, unless all three are in place: the worker account, the check account
(`--check-user` must be given and usable) and the PID namespace (for the
worker, and for each check run with its private /tmp). It also refuses
`MAAT_WORKER_PIDNS=0`.

Without it, Maat carries on with whatever could be set up: a check account
that cannot be used leaves the checks running as Maat, a missing namespace
leaves the process list visible, and a worker account that cannot be used
leaves the whole job unseparated (unless `MAAT_WORKER_PIDNS=1`, which still
refuses). Each case is said on stderr. Every receipt and the journal (one
`note` entry with `kind: "isolation"`) then carry one line with the isolation
actually in effect, for example:

```
isolation: worker uid 1001, check uid 1002, pid namespace on
isolation: worker uid 1001, check uid none (task checks run as Maat, uid 0), pid namespace off
isolation: none (worker tools and checks run as Maat, uid 0: no such user: agent)
```

The line is there whenever `--worker-user` was given, strict or not, and
absent otherwise.

## The process list

`ps` shows every process's command line to every user unless `/proc` is
mounted with `hidepid=2` (`hidepid=invisible`). Hidden checks are commands,
so while one runs as Maat, a worker that can list processes can read it.
`hidepid` cannot be relied on: it is a mount option of the host or
container, and most container runtimes do not set it.

Maat's own command line is plain (`maat`), because the process title is
replaced at startup.

When Maat runs as root with `CAP_SYS_ADMIN` and `unshare`, `nsenter` and
`setpriv` are installed (util-linux), it starts one PID namespace with a
private `/proc` for the job. Every command the worker triggers runs inside
it, and so does the ACP agent with everything it starts. Inside, the worker
sees only its own processes. Background servers it starts keep running
between calls, because the namespace lives as long as Maat does. The worker
enters the namespace with `--no-new-privs` and an empty capability bounding
set, so the capability that created the namespace never reaches it, not even
through a setuid binary.

- `MAAT_WORKER_PIDNS=0` turns it off; `=1` requires it (Maat refuses to
  start without it).
- Without it, Maat says so on stderr. The fix is either to mount `/proc`
  with `hidepid=2` (the host's or the container's), or to give Maat root and
  `CAP_SYS_ADMIN`. For Docker: `docker run --cap-add=SYS_ADMIN ...`. Docker's
  default seccomp and AppArmor profiles allow it on OrbStack and on current
  Docker Engine.

Process memory needs nothing extra. `/proc/<pid>/mem` and ptrace need the
same uid (and `CAP_SYS_PTRACE`), and a separate PID namespace hides the
process entirely.

## The bench

`bench/local/container/run-in-container.sh` turns this on by default:

- `run.py` runs Maat as root with `--worker-user agent --check-user checker`.
  The image has both users: `agent` (uid 1001) and `checker` (uid 1002, its
  own group, no home). `BENCH_PRIVSEP=0` runs the whole of Maat as `agent`,
  as before.
- The container gets `--cap-add=SYS_ADMIN` for the PID namespace.
  `BENCH_PIDNS=0` drops it.
- The worker's Grok credential is copied to `/home/agent/.grok`. A Grok
  judge's credential is copied to `/root/.grok` and the OpenCode judge's to
  `/root/.local/share/opencode`. `/root` is mode 700.
- Tasks run in a container-local `/var/lib/bench-work` (mode 711), so a
  worker can reach its own task folder by name but cannot list the others.
  Each task's log is written mode 600, and after grading the task folder is
  locked to root (700). This stops a later task (a repeat of the same task,
  the other arm of a pair) from reading the checks an earlier one released.
  Everything is copied to `/work` (`BENCH_EXPORT`) when `run.py` ends. `/work`
  is a host bind mount, and on OrbStack and Docker Desktop a bind mount
  ignores `chown` and does not enforce file modes for other users, so a lock
  placed there would not hold.
- The graders and reference solutions stay root-only, as before. The graders
  (and `crosscheck.py`'s re-grades and check re-runs) work on a root-owned
  copy whose repositories are cut to their format lines, without hooks or
  attributes; nothing sets `safe.directory`.

To check it from outside a running job:

```sh
docker exec maat-bench-<name> sh -c 'ls /var/lib/maat'
docker exec maat-bench-<name> runuser -u agent -- cat /var/lib/maat/<session>/log/<file>   # Permission denied
```

## Known limitations

- **The network is shared between accounts.** The worker, the check account
  and Maat use the same network. A check (which runs the worker's code) can
  send what it can read, the reference check included, to anything it can
  reach, and the worker can fetch it from there. Privilege separation is
  about the local machine; run the container with no network, or a
  restricted one, to close this.
- **Snapshot and mutation code still read worker files by path.** Maat, as
  root, copies the worker's tree for each check (`src/scratch.ts`), snapshots
  it for the reference check (`snapshotProject`), lists it to see what a
  command created, and the mutation builtin reads and rewrites source files
  in the project by path. Those reads follow what the worker left there (a
  symlink is copied as a symlink, but a mutation target is opened by name).
  Only the hand-back walk and the records copy work by descriptor or as the
  worker.
- **The agent user's HOME and /tmp are shared between bench tasks in one
  container.** Every task in a bench container runs its worker as the same
  `agent` user, with the same `/home/agent` and the same `/tmp` (the worker's
  own PID namespace has no private /tmp). A later task's worker can read what
  an earlier one left there. Task folders and logs are locked after grading;
  HOME and /tmp are not cleared between tasks.
- In sudo mode (Maat not root) there is no PID namespace, for the worker or
  the checks. The environment is passed on sudo's command line (already
  scrubbed for the worker, allowlisted for checks).
- The ACP worker's MCP connection to Maat's tools is a loopback port behind a
  per-session bearer token held by the worker's own agent. Through it the
  worker reaches only Maat's tools, which run as the worker.
- Off Linux (macOS desktop) nothing changes. `--worker-user` works on any
  POSIX system where Maat is root, but without a PID namespace.
