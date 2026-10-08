# The local benchmark in a Linux container: Maat runs model-written commands
# unattended (--yes), so the machine it may damage is this one, not the Mac,
# and the tools are GNU ones, as on Terminal-Bench and most servers.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 git sqlite3 jq make curl ca-certificates procps file xxd \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system user.name "bench" && git config --system user.email "bench@localhost" \
    && git config --system init.defaultBranch master
# The worker's tools run as this user: Maat runs as root with --worker-user agent (privilege
# separation, src/privsep.ts), or wholly as this user with BENCH_PRIVSEP=0. run-in-container.sh
# keeps the graders and the reference solutions in root-only places it cannot read; /root (the
# judge's HOME) is 700.
RUN useradd -m -u 1001 -s /bin/bash agent && chmod 700 /root
# Task checks (hidden, drafted, mission) run as this user (--check-user checker): its own group,
# no home (Maat gives each check run a fresh empty HOME). It can read the reference check's
# files and its own copy of the work; `agent` cannot read the reference check.
RUN useradd -M -U -u 1002 -s /bin/sh checker
ENV BENCH_AGENT_USER=agent BENCH_CHECK_USER=checker
WORKDIR /opt
# Maat itself is installed per build by run-in-container.sh (FROM maat-bench + npm i -g the packed tarball).

# run-in-container.sh overrides these: tasks run in a container-local /var/lib/bench-work and the
# host folders are mounted under /root, where the agent user cannot reach them.
ENV BENCH_WORK=/var/lib/bench-work BENCH_EXPORT=/root/bench-export RESULTS_DIR=/root/bench-results
