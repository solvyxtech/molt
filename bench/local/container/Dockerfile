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
ENV BENCH_AGENT_USER=agent
WORKDIR /opt
# Maat itself is installed per build by run-in-container.sh (FROM maat-bench + npm i -g the packed tarball).

ENV BENCH_WORK=/work RESULTS_DIR=/results
