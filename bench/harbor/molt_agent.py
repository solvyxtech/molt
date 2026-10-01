"""
molt as a Terminal-Bench agent, for the harbor framework.

    harbor run -d terminal-bench@2.0 -a bench.harbor.molt_agent:Molt \
        -m anthropic/claude-sonnet-4-5 -n 4 --ak tarball=out-cli/solvyx-molt-0.2.0.tgz

What this does, and why each part is the way it is:

- **Installs molt from a tarball, not from npm.** `npm run pack:cli` stages the
  CLI package; `npm pack ./out-cli` makes the tarball. Installing from a file
  means the score is the score of THIS tree, not of whatever was last
  published — which is the only way a harness change can be measured.

- **Runs `molt run --yes --criteria auto`.** Nobody is watching a benchmark
  container, so the model drafts its own acceptance criteria before the
  work, they are sealed, and molt refuses "done" until they pass. That is the
  pre-completion self-verification LangChain found worth thirteen points on
  this benchmark, done as commands rather than as a checklist the model reads.

- **Never fails the trial on molt's exit code.** Harbor grades what is on disk
  when the agent returns; a run that molt could not verify (exit 3) or refused
  (exit 1) may still have done the task. Only exit 2 — usage or configuration —
  is raised, because that is a broken harness, not a failed task.

- **Moves `.molt/` out of the task directory before grading.** Receipts, the
  journal and the ledger are molt's record, not the task's output. They are
  kept under the agent's logs so a trial can be audited afterwards.

Model names follow harbor's `provider/model` convention. The provider picks
the endpoint and the key; anything else needs `MOLT_BASE_URL` in the env.
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Where a provider prefix sends molt, and which host variable holds its key.
PROVIDERS: dict[str, tuple[str, str]] = {
    "anthropic": ("https://api.anthropic.com/v1", "ANTHROPIC_API_KEY"),
    "openai": ("https://api.openai.com/v1", "OPENAI_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    "xai": ("https://api.x.ai/v1", "XAI_API_KEY"),
    "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    "mistral": ("https://api.mistral.ai/v1", "MISTRAL_API_KEY"),
    "deepseek": ("https://api.deepseek.com/v1", "DEEPSEEK_API_KEY"),
}

REMOTE_TARBALL = "/tmp/molt-cli.tgz"


class Molt(BaseInstalledAgent):
    """molt, installed into the task container and run headless."""

    def __init__(
        self,
        logs_dir: Path,
        *args: Any,
        tarball: str | None = None,
        attempts: int = 3,
        criteria: str = "auto",
        for_: str | None = None,
        map_tokens: int | None = None,
        max_tokens: int | None = None,
        auto_shed: int | None = None,
        budget: int | None = None,
        reasoning: str | None = None,
        steps: int = 300,
        batch: bool | str = False,
        reasoning_checks: str | None = None,
        reasoning_retry: str | None = None,
        review: int | str | None = None,
        pace: bool | str = False,
        **kwargs: Any,
    ) -> None:
        # `for` is a keyword; harbor passes --ak for=12m as kwargs["for"].
        for_ = kwargs.pop("for", for_)
        super().__init__(logs_dir, *args, **kwargs)
        self._tarball = Path(tarball) if tarball else None
        self._attempts = int(attempts)
        self._criteria = criteria
        self._for = for_
        self._map_tokens = map_tokens
        self._max_tokens = max_tokens
        self._auto_shed = auto_shed
        # A token ceiling per task, in molt's --budget. molt itself has no
        # default ceiling on purpose; a benchmark with a fixed credit does.
        self._budget = budget
        # A reasoning model's effort. Space Bunny Alpha at its default thinks
        # to the ceiling and never answers; `low` answers.
        self._reasoning = reasoning
        # molt's default step guard (32) is sized for a chat turn; a hard task
        # here needs many more, and the token budget and the task's own clock
        # already bound it.
        self._steps = int(steps)
        # Batch mode: one act call per reply carrying a list of actions.
        self._batch = str(batch).lower() in ("1", "true", "yes", "on")
        # Effort for drafting checks only, and for steps after a refusal.
        self._reasoning_checks = reasoning_checks
        self._reasoning_retry = reasoning_retry
        # Independent review of a verified claim: votes, or None for off.
        self._review = int(review) if review not in (None, "", "0", 0) else None
        # Pace: give molt the task's own time limit (task.toml's public
        # [agent] timeout_sec, never the tests) as its --for deadline, less a
        # margin for drafting checks before the turn and the review after it.
        # molt then shows the model the clock after every step, warns at 75%,
        # and never starts a command longer than the time left.
        self._pace = str(pace).lower() in ("1", "true", "yes", "on")

    def _task_timeout_sec(self) -> float | None:
        """The task's agent timeout, as harbor will apply it, or None if unknown."""
        import glob
        import tomllib

        try:
            trial = Path(self.logs_dir).parent
            cfg = json.loads((trial / "config.json").read_text())
            name = (cfg.get("task") or {}).get("path")
            agent = cfg.get("agent") or {}
            if agent.get("override_timeout_sec"):
                base = float(agent["override_timeout_sec"])
            else:
                found = glob.glob(os.path.expanduser(f"~/.cache/harbor/tasks/*/{name}/task.toml"))
                if not name or not found:
                    return None
                base = float(tomllib.loads(Path(found[0]).read_text())["agent"]["timeout_sec"])
            return base * float(cfg.get("agent_timeout_multiplier") or 1.0)
        except (OSError, ValueError, KeyError, TypeError):
            return None

    @staticmethod
    def name() -> str:
        return "molt"

    def version(self) -> str | None:
        return self._version or "0.2.0"

    async def install(self, environment: BaseEnvironment) -> None:
        # Node 20.11+ is a hard requirement. Debian's apt nodejs is often 18,
        # so the distro package is only accepted when it is new enough; the
        # NodeSource script is the fallback on apt systems.
        await self.ensure_system_dependencies(
            environment, ("curl", "bash", "nodejs", "npm", "procps", "git")
        )
        await self.exec_as_root(
            environment,
            command=(
                "set -e; "
                "if ! node -e 'process.exit(+process.versions.node.split(\".\")[0] >= 20 ? 0 : 1)'; then "
                "  if command -v apt-get >/dev/null 2>&1; then "
                "    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; "
                "  elif command -v apk >/dev/null 2>&1; then apk add --no-cache nodejs-current npm; "
                "  else echo 'node >= 20.11 is required and no way to install it was found' >&2; exit 1; fi; "
                "fi; node --version"
            ),
        )
        if self._tarball is None:
            raise ValueError(
                "pass --ak tarball=<path to solvyx-molt-*.tgz> — build it with "
                "`npm run pack:cli && npm pack ./out-cli`"
            )
        if not self._tarball.is_file():
            raise FileNotFoundError(f"molt tarball not found: {self._tarball}")
        await environment.upload_file(self._tarball, REMOTE_TARBALL)
        await self.exec_as_root(
            environment,
            command=f"set -e; npm install -g {shlex.quote(REMOTE_TARBALL)} && molt --version",
        )

    def _endpoint(self) -> tuple[str, str | None]:
        """Base URL and key for the model harbor was given."""
        provider = self._parsed_model_provider
        base = self._get_env("MOLT_BASE_URL")
        key = self._get_env("MOLT_API_KEY")
        if provider in PROVIDERS:
            url, key_var = PROVIDERS[provider]
            return base or url, key or self._get_env(key_var)
        if base:
            return base, key
        raise ValueError(
            f"model {self.model_name!r}: unknown provider prefix. Use one of "
            f"{', '.join(sorted(PROVIDERS))}/<model>, or set MOLT_BASE_URL (and "
            "MOLT_API_KEY) with --ae for an OpenAI-compatible endpoint."
        )

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        base_url, api_key = self._endpoint()
        model = self._parsed_model_name or ""
        logs = self.environment_logs_dir.as_posix()

        env: dict[str, str] = {
            "MOLT_BASE_URL": base_url,
            "MOLT_MODEL": model,
            # The whole instruction as one variable, so no quoting can eat it.
            "MOLT_TASK": instruction,
            # A benchmark container has no config directory and must not
            # create one anywhere it is not allowed to.
            "MOLT_CONFIG_DIR": f"{logs}/config",
            # A hosted model silent this long is stalled, not thinking: retry.
            "MOLT_REQUEST_FIRST_BYTE_MS": "180000",
            "MOLT_REQUEST_IDLE_MS": "120000",
        }
        if api_key:
            env["MOLT_API_KEY"] = api_key
        env.update(self._resolved_env_vars)

        # --sandbox: the container is disposable, so the project boundary is
        # the machine and nothing is refused for being irreversible. This is
        # what every other adapter does too (Claude Code runs with
        # --permission-mode bypassPermissions here).
        # Streamed: every chunk resets the request watchdog, so a stalled
        # request is caught in minutes. Unstreamed, the watchdog must allow
        # the whole answer to arrive at once, and a stall outlived the task.
        flags = ["--sandbox", "--json", f"--attempts {self._attempts}"]
        if self._criteria == "auto":
            flags.append("--criteria auto")
        if self._for:
            flags.append(f"--for {shlex.quote(str(self._for))}")
        elif self._pace:
            limit = self._task_timeout_sec()
            if limit:
                flags.append(f"--for {max(60, int(limit * 0.85) - 60)}s")
        if self._map_tokens is not None:
            flags.append("--no-map" if int(self._map_tokens) <= 0 else f"--map {int(self._map_tokens)}")
        if self._max_tokens is not None:
            flags.append(f"--max-tokens {int(self._max_tokens)}")
        if self._auto_shed is not None:
            flags.append(f"--auto-shed {int(self._auto_shed)}")
        if self._budget is not None:
            flags.append(f"--budget {int(self._budget)}")
        if self._reasoning:
            flags.append(f"--reasoning {shlex.quote(str(self._reasoning))}")
        flags.append(f"--steps {self._steps}")
        if self._batch:
            flags.append("--batch")
        if self._reasoning_checks:
            flags.append(f"--reasoning-checks {shlex.quote(str(self._reasoning_checks))}")
        if self._review:
            flags.append(f"--review {self._review}")
        if self._reasoning_retry:
            flags.append(f"--reasoning-retry {shlex.quote(str(self._reasoning_retry))}")

        # The exit code is recorded and, except for a usage error, swallowed:
        # harbor grades the disk, and a refused claim can still be a done task.
        # `.molt/` is moved out of the way before the verifier looks, and
        # kept, so the receipts can be read on the host afterwards.
        command = (
            f"mkdir -p {shlex.quote(logs)}/config; "
            f'printf "%s" "$MOLT_TASK" > {shlex.quote(logs)}/instruction.txt; '
            f'molt run {" ".join(flags)} "$MOLT_TASK" 2>&1 | tee {shlex.quote(logs)}/molt.jsonl; '
            "rc=${PIPESTATUS[0]}; "
            f"echo $rc > {shlex.quote(logs)}/exit-code; "
            f"if [ -d .molt ]; then rm -rf {shlex.quote(logs)}/record; mv .molt {shlex.quote(logs)}/record; fi; "
            "[ \"$rc\" -ne 2 ]"
        )
        await self.exec_as_agent(environment, command=f"bash -c {shlex.quote(command)}", env=env)

        # Spend, from the last job_end event molt wrote. The log is read back
        # through the container rather than the synced copy because the sync
        # happens after this method returns.
        tail = await environment.exec(
            command=f"tail -c 65536 {shlex.quote(logs)}/molt.jsonl",
        )
        spend = _last_job_end(tail.stdout or "")
        if spend:
            context.n_input_tokens = int(spend.get("promptTokens") or 0)
            context.n_cache_tokens = int(spend.get("cachedTokens") or 0)
            context.n_output_tokens = int(spend.get("completionTokens") or 0)
            cost = spend.get("costUsd")
            context.cost_usd = float(cost) if cost is not None else None


def _last_job_end(text: str) -> dict[str, Any] | None:
    """The `spend` of the last job_end line in a molt --json log."""
    found: dict[str, Any] | None = None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("kind") == "job_end" and isinstance(ev.get("spend"), dict):
            found = ev["spend"]
    return found


if __name__ == "__main__":  # a smoke check of the pure parts, no harbor needed
    sample = '{"kind":"job_end","spend":{"promptTokens":10,"completionTokens":2,"cachedTokens":0}}'
    assert _last_job_end(f"noise\n{sample}\n")["promptTokens"] == 10
    assert _last_job_end("nothing") is None
    print("ok")
