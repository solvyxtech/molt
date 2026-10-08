# Keeping keys and hidden checks from the worker

The worker's commands, and the deliverables a check runs, are model-written
code. When they run as Maat's own user, they can read anything that user can:
other processes' command lines (`/proc/<pid>/cmdline`, `ps`), the environment
a process was started with (`/proc/<pid>/environ`, `ps -E` on macOS), files,
and, where the kernel allows ptrace between processes of one user, memory.
This page says what Maat does about each, and where that stops.

**Same-user isolation is best effort.** The boundary is running the worker as
a different user (`--worker-user`, docs/privilege-separation.md once that
lands), so that Maat's `/proc` entries, state and memory belong to someone
else. For unattended and benchmark runs, use it. Everything below is defence
in depth for runs that do not.

## Hidden check commands

A check never appears in an argv. Every check run (bar runs, mutation runs,
drafting trial runs, reference checks, mission assertions; anything that goes
through `runCheck` or `preflightCriteria`) starts its shell with one fixed
script, `HIDDEN_WRAPPER` in `src/run.ts`:

```sh
__maat_c=$(cat <&3) || exit 125; exec 3<&-; eval "unset __maat_c; $__maat_c"
```

The command arrives on fd 3, a socket (which another process cannot reopen
through `/proc/<pid>/fd/3`). The wrapper reads it to the end, closes fd 3 so
nothing the check starts inherits it, and evals it with the holding variable
unset first; the variable is never exported. So a deliverable that reads
`/proc/$PPID/cmdline` gets the wrapper, not the check, and a process scanning
`/proc/*/cmdline` while the check runs finds nothing.

What it does not cover:

- A check whose own command line contains its logic, such as
  `python3 -c "import sol; assert sol.f(2) == 4"`, runs the deliverable inside
  that python process, whose argv is the check. The wrapper hides the shell
  line, not argv words the shell then passes to a program. Prefer checks that
  run the deliverable as its own process and compare its output.
- Maat's own memory holds every check. A worker of the same user, where
  `kernel.yama.ptrace_scope` is 0 (common in containers), can read it.
- A failing check's output goes back to the model, masked only for verbatim
  copies of the command.

## Provider keys

At startup (`captureSecrets()`, `src/secrets.ts`, called first thing by the
CLI and the desktop app) Maat moves every credential-shaped variable out of
its environment into memory. Nothing it starts afterwards inherits one,
whatever environment the spawn site builds. A credential is:

- any name ending in `_API_KEY`, `_APIKEY`, `_ACCESS_KEY`, `_SECRET_KEY`,
  `_SECRET_ACCESS_KEY`, `_PRIVATE_KEY`, `_SECRET`, `_TOKEN`, `_PASSWORD`,
  `_PASSWD`, `_CREDENTIAL(S)`;
- any `XAI_*`, `GROK_*`, `TOGETHER_*`;
- `MAAT_API_KEY`, `MOLT_API_KEY`, `MAAT_JUDGE_KEY`, `MOLT_JUDGE_KEY`.

`MAAT_KEEP_ENV=NAME,NAME` lets named variables through when a task needs its
own token (`HF_TOKEN` for a download, say). The model's own client processes
(the Grok Build and OpenCode backends) are given back the keys they need; the
worker's shell, background jobs and checks never are.

Moving a key out of `process.env` does not remove it from the copy of the
environment the kernel kept when Maat was started. On Linux,
`/proc/<maat pid>/environ` still returns it to any process of the same user,
including the worker's bash, which is Maat's child. On macOS, `ps -E` does the
same. So keys should not be in Maat's exec environment at all:

| Way in | Where the key is visible to a same-user worker |
| --- | --- |
| Environment variable (`OPENROUTER_API_KEY=… maat run`) | Maat's `/proc/<pid>/environ` for the whole run |
| `MAAT_KEYS_FD=<n>` | nowhere: read to the end and closed at startup |
| `MAAT_KEYS_FILE=<path>` | the file, for as long as it exists |

Both carry `NAME=value` lines (`export` and quotes allowed, `#` comments) or a
JSON object. `MAAT_KEYS_FILE` must be a regular file of Maat's user with no
group or other permissions (mode 0600), or Maat refuses to start. Remove it
once Maat has started, or prefer the descriptor.

From a shell, without the key passing through an argv or the environment:

```sh
MAAT_KEYS_FD=3 maat run --sandbox … 3< ~/.config/maat/keys
```

From Python (what `bench/local/run.py` does):

```python
r, w = os.pipe(); os.write(w, json.dumps(keys).encode()); os.close(w)
subprocess.Popen(cmd, env=clean | {"MAAT_KEYS_FD": str(r)}, pass_fds=(r,))
os.close(r)
```

The bench container runner mounts the key file read-only under `/root`
(mode 700, out of the agent user's reach) instead of `--env-file`, which had
put it in the container's environment and in `docker inspect`; `run.py`
reads it into memory and hands it to Maat on a pipe.

What it does not cover, with a worker of Maat's own user:

- Maat's stored login (`auth.json` in its config directory) is a file that
  user can read.
- Maat's memory holds the keys (see ptrace above).
- The model's own backend process (Grok Build, OpenCode) is given its keys in
  its environment; if that backend runs the worker's commands itself, they
  are its children.
- `bench/harbor` still passes `MOLT_API_KEY` through the harness's exec
  environment.

All of these are closed by a different user for the worker.

## Tests

`test/secret-hygiene.test.ts` runs a long check carrying a marker and scans
every process's argv and environment for it (`/proc` on Linux, `ps -E` on
macOS), with an unhidden control run that the scan must find; has a check run
a child that reads every ancestor's argv and environment; and runs the real
CLI with a stub provider whose bash call does the same for keys given by fd,
by file and by environment. The Linux half is meant for a container:

```sh
docker run --rm -v "$PWD":/src:ro node:22-bookworm bash -c '
  mkdir /work && cd /src && tar --exclude=./node_modules -cf - . | tar -xf - -C /work
  cp -a /src/node_modules /work/ && chown -R node:node /work
  su node -c "cd /work && node --test dist-test/test/secret-hygiene.test.js"'
```
