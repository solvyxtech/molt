#!/usr/bin/env bash
# Work through a queue of benchmark runs, one after another, for days.
#
#   bench/harbor/campaign.sh ~/tb/queue.txt
#
# The queue is one run per line, in the arguments run.sh takes (or, for a
# harbor built-in agent, `agent:<name> <harbor run args>`). A line is removed
# from the queue when its run starts and appended to done.txt when it ends,
# so a killed campaign restarts where it was, and a line added to the file
# while the campaign runs is picked up in turn. Blank lines and # are ignored.
#
# Before starting, it waits for any harbor already running on the box to
# finish, so it can be started beside a job in flight. Every run's output is
# in jobs/<name>.log as usual; the campaign's own log is jobs/campaign.log.
set -uo pipefail

QUEUE="${1:?queue file}"
DONE="${QUEUE%.txt}.done.txt"
cd "$(dirname "$QUEUE")"
export PATH="$HOME/.local/bin:$PATH"
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/$(id -u)/podman/podman.sock}"
export PYTHONPATH="${PYTHONPATH:-$PWD}"
if [ -f ./.env ]; then set -a; . ./.env; set +a; fi
mkdir -p jobs
log() { echo "$(date -u +%FT%TZ) $*" | tee -a jobs/campaign.log; }

wait_for_harbor() {
  while pgrep -f "bin/pytho[n].*harbo[r]" >/dev/null; do sleep 60; done
}

log "campaign started · queue $QUEUE"
wait_for_harbor
while true; do
  line="$(grep -vE '^\s*(#|$)' "$QUEUE" | head -n 1 || true)"
  if [ -z "$line" ]; then
    log "queue empty · waiting for more"
    sleep 300
    continue
  fi
  # Pop it before running, so a crash mid-run does not loop on the same line.
  python3 - "$QUEUE" "$line" <<'EOF'
import sys
q, line = sys.argv[1], sys.argv[2]
lines = open(q).read().split("\n")
i = next(i for i, l in enumerate(lines) if l.strip() == line.strip())
del lines[i]
open(q, "w").write("\n".join(lines))
EOF
  log "run: $line"
  if [[ "$line" == agent:* ]]; then
    rest="${line#agent:}"
    agent="${rest%% *}"
    args="${rest#* }"
    name="$(echo "$args" | grep -oE -- '--job-name [^ ]+' | cut -d' ' -f2)"
    # shellcheck disable=SC2086
    harbor run -d terminal-bench@2.0 -e podman -a "$agent" $args -o ./jobs 2>&1 | tee -a "jobs/${name:-$agent}.log" | tail -5
  else
    # shellcheck disable=SC2086
    bench/harbor/run.sh $line 2>&1 | tail -5
  fi
  log "done: $line"
  echo "$(date -u +%FT%TZ) $line" >> "$DONE"
  podman ps -q | xargs -r podman rm -f >/dev/null 2>&1
  sleep 10
done
