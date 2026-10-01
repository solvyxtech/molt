#!/usr/bin/env bash
# Write jobs/STATUS.md: every job's score so far, newest first. Cheap enough
# to run from a timer every ten minutes, so a phone over ssh can `cat` it.
set -uo pipefail
cd "${1:-$HOME/tb}"
out=jobs/STATUS.md
{
  echo "# Terminal-Bench campaign — $(date -u +'%F %T UTC') on $(hostname)"
  echo
  running="$(pgrep -af 'bin/pytho[n].*harbo[r]' | grep -oE -- '--job-name [^ ]+' | cut -d' ' -f2 | head -1)"
  echo "running: ${running:-none} · queue: $(grep -cvE '^\s*(#|$)' queue.txt 2>/dev/null || echo 0) left"
  echo
  for j in $(ls -dt jobs/*/ 2>/dev/null); do
    [ -f "$j/config.json" ] || continue
    name="$(basename "$j")"
    m="jobs/$name.manifest.json"
    model="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('model',''))" "$m" 2>/dev/null || python3 -c "import json,sys;c=json.load(open(sys.argv[1]));print((c.get('agents') or [{}])[0].get('model_name',''))" "$j/config.json" 2>/dev/null)"
    tb="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('tarball_sha256','')[:8])" "$m" 2>/dev/null)"
    line="$(python3 bench/harbor/summarize.py "$j" 2>/dev/null | tail -1)"
    echo "## $name  ($model${tb:+ · tarball $tb})"
    echo "${line:-no trials yet}"
    echo
  done
  # Every molt job against the reference run, same tasks: right, fast,
  # cheap, honest. REF names the reference job (default below).
  ref="jobs/${REF:-bunny-full-terminus2}"
  if [ -d "$ref" ]; then
    echo "# molt against $(basename "$ref"), same tasks"
    echo
    for j in $(ls -dt jobs/*molt*/ 2>/dev/null); do
      [ -f "$j/config.json" ] || continue
      echo '```'
      python3 bench/harbor/compare.py "$j" "$ref" 2>/dev/null
      echo '```'
      echo
    done
  fi
} > "$out.tmp" && mv "$out.tmp" "$out"
