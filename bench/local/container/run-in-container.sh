#!/bin/zsh
# Run bench/local/run.py inside a throwaway Linux container, against a packed Maat.
#   container/run-in-container.sh <name> <maat.tgz> -- <run.py args...>
# Make the tarball with: npm run pack:cli && npm pack ./out-cli
# The image is maat-bench:<sha8 of the tarball>, built once and reused, so every run
# records exactly which Maat it tested. Env passed through: REFERENCE BENCH_MODEL
# BENCH_URL BENCH_LIMIT RESULTS (file name). Results land in
# ~/.cache/maat-bench/container-results/; each task's folder and Maat's log are kept
# in ~/.cache/maat-bench/container-work/<name>/ (the only host path it can write).
# SUBSCRIPTION=grok: use the owner's Grok Build login (BENCH_URL=grok-build://subscription
# BENCH_MODEL=grok-4.7). Image is maat-bench-grok:<sha> (Dockerfile.grok: official grok
# installer, linux, pinned). ~/.grok/auth.json is mounted read-only OUTSIDE the container's
# HOME and copied to $HOME/.grok/auth.json at start (mode 600), so the Mac's file is never
# modified; nothing else from ~/.grok is used. GROK_OWN_TOOLS=1 adds a generated
# permission_mode=always-approve config (see below) so Grok works with its own tools. No OpenRouter key is passed in this mode.
# OPENCODE=1 (combines with SUBSCRIPTION=grok): add the OpenCode CLI (Dockerfile.opencode,
# image tag suffix -oc) and the OpenCode Zen entry of ~/.local/share/opencode/auth.json (only
# the "opencode" key: any other provider OpenCode is signed in to stays on the Mac), written to
# a mode-600 temp file, mounted read-only outside HOME and copied to
# /home/agent/.local/share/opencode/auth.json (mode 600). Maat runs only opencode/... models
# there. It is for the judge only:
#   ARMS="oc:MAAT_JUDGE_MODEL=opencode/big-pickle,MAAT_JUDGE_URL=opencode://zen"
# The key is never printed.
# Privilege separation (default; BENCH_PRIVSEP=0 turns it off): Maat runs as root and only the
# worker's tools run as `agent` (--worker-user agent). Maat's records sit in /var/lib/maat (700,
# root) until each job ends; the judge's logins are in /root (700); finished task folders and
# logs in /work are locked to root. BENCH_PIDNS=1 (default) also gives the container
# CAP_SYS_ADMIN so Maat can put the worker's commands in their own PID namespace with a private
# /proc (the worker then sees none of Maat's processes; it gets no capability itself).
# BENCH_PIDNS=0: no extra capability, and the worker can read the process list.
set -e
name=$1; tgz=${2:A}; shift 2; [ "$1" = "--" ] && shift
here=${0:A:h}; local_dir=${here:h}
# Image tags carry ":agentu": images with the unprivileged `agent` user (older ones lack it).
sha=$(shasum -a 256 "$tgz" | cut -c1-8); base=maat-bench:agentu; img=maat-bench:$sha-u
docker image inspect $base >/dev/null 2>&1 || docker build -q -t $base "$here" >/dev/null
if [ "$SUBSCRIPTION" = grok ]; then
  base=maat-bench-grok:agentu; img=maat-bench-grok:$sha-u
  docker image inspect $base >/dev/null 2>&1 || docker build -q -t $base -f "$here/Dockerfile.grok" "$here" >/dev/null
  [ -f ~/.grok/auth.json ] || { echo "no ~/.grok/auth.json: run 'grok login' on the Mac first" >&2; exit 1; }
  # The token is short-lived (~6 h) and a refresh inside the container may rotate the refresh
  # token the Mac holds; start with a fresh one so no refresh is needed during the run.
  left=$(python3 -c "import json,os,datetime as d;v=list(json.load(open(os.path.expanduser('~/.grok/auth.json'))).values())[0];print(int((d.datetime.fromisoformat(v['expires_at'][:26]+'+00:00')-d.datetime.now(d.timezone.utc)).total_seconds()))" 2>/dev/null || echo 0)
  [ "$left" -gt 1800 ] || echo "warning: grok token expires in ${left}s; run any 'grok' command on the Mac to refresh it first" >&2
fi
if [ "$OPENCODE" = 1 ]; then
  [ -f ~/.local/share/opencode/auth.json ] || { echo "no ~/.local/share/opencode/auth.json: run 'opencode auth login' on the Mac first" >&2; exit 1; }
  ocbase=${base%:*}-oc:agentu
  docker image inspect $ocbase >/dev/null 2>&1 || docker build -q -t $ocbase -f "$here/Dockerfile.opencode" --build-arg BASE=$base "$here" >/dev/null
  base=$ocbase; img=${img%:*}-oc:${img##*:}
fi
if ! docker image inspect "$img" >/dev/null 2>&1; then
  ctx=$(mktemp -d); cp "$tgz" "$ctx/maat.tgz"
  printf 'FROM %s\nCOPY maat.tgz /tmp/maat.tgz\nRUN npm install -g --no-fund --no-audit /tmp/maat.tgz && rm /tmp/maat.tgz\n' "$base" > "$ctx/Dockerfile"
  docker build -q -t "$img" "$ctx" >/dev/null; rm -rf "$ctx"
fi
out=~/.cache/maat-bench/container-results; mkdir -p $out
work=~/.cache/maat-bench/container-work/$name; mkdir -p $work
key=
# A Grok lane gets the OpenRouter key only when a judge model needs it (JUDGE_KEY=1).
[ "$SUBSCRIPTION" = grok ] && [ "${JUDGE_KEY:-0}" != 1 ] || key=$(node -e "import('$HOME/Documents/molt-desktop/dist/providers.js').then(m=>process.stdout.write(m.readAuth().openrouter||''))")
url=${BENCH_URL:-https://openrouter.ai/api/v1}
# The NUC tunnel is the Mac's localhost; from the container it is host.docker.internal.
url=${url//127.0.0.1/host.docker.internal}; url=${url//localhost/host.docker.internal}
# The key goes in through a file only this user can read, removed when the
# run ends: on the command line (-e KEY=...) it showed in every `ps` listing.
envf=$(mktemp); chmod 600 "$envf"; trap 'rm -f "$envf"' EXIT
printf 'OPENROUTER_API_KEY=%s\n' "$key" > "$envf"
# The graders and reference solutions are mounted where only root can reach (/root is 700),
# copied to a root-only /opt/bench, and run.py runs from there as root; it runs the agent
# as the unprivileged `agent` user (BENCH_AGENT_USER) and grades as root afterwards.
# Tasks run in a container-local /var/lib/bench-work (711: the worker reaches its own task folder
# by name but cannot list the others) and are copied to /work when run.py ends. /work is a host
# bind mount, where chown is ignored and modes are not enforced, so nothing locked there would
# stay locked from a later task's worker.
privsep=${BENCH_PRIVSEP:-1}
credmount=; startcmd='export MOLT_DIST_ABS=$(npm root -g)/@solvyx/molt/dist BENCH_WORK=/var/lib/bench-work BENCH_EXPORT=/work; mkdir -p /work $BENCH_WORK && chmod 711 $BENCH_WORK && rm -rf /opt/bench && cp -a /root/bench-src /opt/bench && chmod -R go-rwx /opt/bench && cd /opt/bench && python3 run.py "$@"'
if [ "$SUBSCRIPTION" = grok ]; then
  credmount="-v $HOME/.grok/auth.json:/root/grok-cred/auth.json:ro"
  # The worker's grok runs as `agent`, so its credential copy lives in ITS home, owned by it,
  # mode 600. A grok judge runs as Maat (root) with HOME=/root, so it gets its own copy there.
  startcmd='install -d -o agent -g agent -m 700 /home/agent/.grok && install -o agent -g agent -m 600 /root/grok-cred/auth.json /home/agent/.grok/auth.json && '$startcmd
  [ "$privsep" = 0 ] || startcmd='install -d -m 700 /root/.grok && install -m 600 /root/grok-cred/auth.json /root/.grok/auth.json && '$startcmd
  # GROK_OWN_TOOLS=1: let Grok Build use its own shell/edit tools (inside the container only).
  # Needed because Grok hides Maat's MCP tools behind its search_tool/use_tool, so by default
  # the model asks for run_terminal_command, Maat refuses, and the turn ends with no work done.
  # Writes a fresh config.toml in the container; the Mac's is never read or copied.
  [ -z "$GROK_OWN_TOOLS" ] || startcmd='install -d -o agent -g agent -m 700 /home/agent/.grok && printf "[ui]\npermission_mode = \"always-approve\"\n" > /home/agent/.grok/config.toml && chown agent:agent /home/agent/.grok/config.toml && '$startcmd
fi
if [ "$OPENCODE" = 1 ]; then
  # Only the Zen ("opencode") credential crosses into the container, never another provider's.
  ocauth=$(mktemp); chmod 600 "$ocauth"; trap 'rm -f "$envf" "$ocauth"' EXIT
  python3 -c 'import json,sys;a=json.load(open(sys.argv[1]));json.dump({k:v for k,v in a.items() if k=="opencode"},open(sys.argv[2],"w"))' ~/.local/share/opencode/auth.json "$ocauth"
  credmount="$credmount -v $ocauth:/root/oc-cred/auth.json:ro"
  # The OpenCode judge runs as Maat: with privilege separation that is root, HOME=/root, which
  # the worker cannot read; without it, as `agent`.
  if [ "$privsep" = 0 ]; then
    startcmd='install -d -o agent -g agent -m 700 /home/agent/.local /home/agent/.local/share /home/agent/.local/share/opencode && install -o agent -g agent -m 600 /root/oc-cred/auth.json /home/agent/.local/share/opencode/auth.json && '$startcmd
  else
    startcmd='install -d -m 700 /root/.local /root/.local/share /root/.local/share/opencode && install -m 600 /root/oc-cred/auth.json /root/.local/share/opencode/auth.json && '$startcmd
  fi
fi
caps=
[ "$privsep" = 0 ] || [ "${BENCH_PIDNS:-1}" = 0 ] || caps=--cap-add=SYS_ADMIN
echo "maat $img → $out/${RESULTS:-results.jsonl}"
docker run --rm --name "maat-bench-$name" ${=caps} \
  -v "$local_dir":/root/bench-src:ro -v "$out":/results -v "$work":/work ${=credmount} \
  --env-file "$envf" -e REFERENCE="${REFERENCE:-0}" -e BENCH_MODEL="${BENCH_MODEL:-}" \
  -e ARMS="${ARMS:-}" -e BENCH_TASKS="${BENCH_TASKS:-}" -e BENCH_URL="$url" -e BENCH_LIMIT="${BENCH_LIMIT:-600}" -e BENCH_REASONING="${BENCH_REASONING:-}" -e BENCH_GATE="${BENCH_GATE:-}" -e RESULTS="${RESULTS:-results.jsonl}" \
  -e MAAT_BUILD="$sha" -e PYTHONDONTWRITEBYTECODE=1 -e BENCH_PRIVSEP="$privsep" \
  "$img" sh -c "$startcmd" run "$@"
