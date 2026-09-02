#!/bin/sh
# Make labelled runs: a cheap model, molt's own bar, full capture.
#   finetune/generate.sh <project-copy> <n-per-prompt> [prompt-file...]
# Each run costs a few thousandths of a dollar on mercury-2.5 and 1–5 minutes
# of wall clock (the bar is most of it). Captures land in <copy>/finetune/captures.
set -u
COPY=${1:?project copy}; N=${2:-3}; shift 2
[ $# -gt 0 ] || set -- "$(dirname "$0")"/prompts/*.txt
cd "$COPY" || exit 1
mkdir -p finetune/captures
for p in "$@"; do
  i=0
  while [ $i -lt "$N" ]; do
    i=$((i+1))
    echo "== $(basename "$p") run $i ($(date +%T))"
    node dist/cli.js run "$(cat "$p")" \
      --url https://openrouter.ai/api/v1 --model inception/mercury-2.5-preview \
      --yes --revert --for 8m --attempts 3 --capture finetune/captures > /dev/null 2>&1
    echo "   exit=$?"
  done
done
node "$(dirname "$0")"/extract.mjs --out "$COPY/finetune/data/$(date +%F)" "$COPY"
