#!/usr/bin/env bash
# Run molt on Terminal-Bench 2.0 under harbor, repeatably.
#
# Every run writes a manifest beside its results naming the exact tarball
# (sha256), harbor version, dataset, model, attempts and flags — so a number
# can be reproduced, and two numbers can be compared knowing what differed.
#
#   bench/harbor/run.sh -m openrouter/anthropic/claude-sonnet-5.5 -t solvyx-molt-0.2.0.tgz
#   bench/harbor/run.sh -m ... -t ... -i fix-git -i regex-log        # a subset
#   bench/harbor/run.sh -m ... -t ... -k 3 -n 4 --name sonnet-k3      # three attempts, four at once
#
# Environment: the provider's key in the environment or in ./.env
# (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, ...), PYTHONPATH containing the
# directory that holds bench/, and for podman the API socket in DOCKER_HOST.
set -euo pipefail

MODEL=""; TARBALL=""; NAME=""; ATTEMPTS=1; CONCURRENCY=2; ENVTYPE="${HARBOR_ENV:-podman}"
DATASET="terminal-bench@2.0"; JOBS="${JOBS_DIR:-./jobs}"
INCLUDE=(); AK=()

while [ $# -gt 0 ]; do
  case "$1" in
    -m|--model) MODEL="$2"; shift 2 ;;
    -t|--tarball) TARBALL="$2"; shift 2 ;;
    -i|--include) INCLUDE+=(-i "$2"); shift 2 ;;
    -k|--attempts) ATTEMPTS="$2"; shift 2 ;;
    -n|--concurrent) CONCURRENCY="$2"; shift 2 ;;
    -e|--env) ENVTYPE="$2"; shift 2 ;;
    -d|--dataset) DATASET="$2"; shift 2 ;;
    -o|--jobs) JOBS="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --ak) AK+=(--ak "$2"); shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "run.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done
[ -n "$MODEL" ] || { echo "run.sh: -m provider/model is required" >&2; exit 2; }
[ -f "$TARBALL" ] || { echo "run.sh: -t <solvyx-molt-*.tgz> is required (npm run pack:cli && npm pack ./out-cli)" >&2; exit 2; }

TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
SHA="$(sha256sum "$TARBALL" 2>/dev/null | cut -c1-64 || shasum -a 256 "$TARBALL" | cut -c1-64)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="${NAME:-molt-${STAMP}}"
HARBOR_VERSION="$(harbor --version 2>/dev/null | head -1)"
mkdir -p "$JOBS"
ENVFILE=()
[ -f ./.env ] && ENVFILE=(--env-file ./.env)

# The manifest first, so a run that is killed still says what it was.
python3 - "$JOBS/$NAME.manifest.json" <<EOF
import json, sys
json.dump({
  "name": "$NAME", "started": "$STAMP", "dataset": "$DATASET", "environment": "$ENVTYPE",
  "model": "$MODEL", "attempts": $ATTEMPTS, "concurrency": $CONCURRENCY,
  "tarball": "$TARBALL", "tarball_sha256": "$SHA", "harbor": "$HARBOR_VERSION",
  "include": $(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps([a[i] for i in range(1,len(a),2)]))' "${INCLUDE[@]}"),
  "agent_kwargs": $(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps([a[i] for i in range(1,len(a),2)]))' "${AK[@]}"),
  "host": "$(hostname)",
}, open(sys.argv[1], "w"), indent=2)
EOF
echo "run $NAME · $MODEL · tarball ${SHA:0:12} · harbor $HARBOR_VERSION · -k $ATTEMPTS -n $CONCURRENCY" | tee "$JOBS/$NAME.log"

exec harbor run -d "$DATASET" -e "$ENVTYPE" \
  -a bench.harbor.molt_agent:Molt -m "$MODEL" \
  --ak "tarball=$TARBALL" "${AK[@]}" "${ENVFILE[@]}" "${INCLUDE[@]}" \
  -k "$ATTEMPTS" -n "$CONCURRENCY" -o "$JOBS" --job-name "$NAME" 2>&1 | tee -a "$JOBS/$NAME.log"
