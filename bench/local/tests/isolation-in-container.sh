#!/bin/sh
# Run the task-isolation tests where they mean something: as root in the bench image, with the
# unprivileged `agent` user the bench runs the worker as (see test_task_isolation.py).
#   bench/local/tests/isolation-in-container.sh [image]   (default maat-bench:agentu)
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
img=${1:-maat-bench:agentu}
docker image inspect "$img" >/dev/null 2>&1 || docker build -q -t "$img" "$here/container" >/dev/null
exec docker run --rm -e PYTHONDONTWRITEBYTECODE=1 -v "$here":/root/bench-src:ro -w /root/bench-src "$img" \
  python3 -m unittest -v tests.test_task_isolation
