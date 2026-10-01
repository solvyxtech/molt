#!/bin/bash
# Stop the comparison the moment any Droid run reports Factory credits used.
cd "$(dirname "$0")"
while pgrep -f "python3 run.py both" >/dev/null; do
  for f in work/*-droid.log; do
    [ -f "$f" ] || continue
    c=$(python3 -c "
import json,sys
v=0
for l in open(sys.argv[1],errors='replace'):
    if l.startswith('{') and 'factory_credits' in l:
        try: v=max(v,(json.loads(l).get('usage') or {}).get('factory_credits') or 0)
        except Exception: pass
print(v)" "$f")
    if [ "$c" != "0" ]; then
      pkill -f "python3 run.py both"; pkill -f "droid exec"
      echo "STOPPED: $f reported factory_credits=$c"; exit 0
    fi
  done
  sleep 10
done
echo "comparison ended; no Factory credits used"
