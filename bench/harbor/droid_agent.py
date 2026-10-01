"""
Factory's Droid as a Terminal-Bench agent, for behaviour comparison only.

    harbor run -d terminal-bench@2.0 -a bench.harbor.droid_agent:Droid \
        -m openrouter/stealth/space-bunny-alpha --ak reasoning=low -i <task> ...

Runs `droid exec` headless inside the task container on a BYOK model (the
same OpenRouter model molt and Terminus-2 run on), and keeps Droid's own
stream-json log so its behaviour can be studied: turns per task, tool calls
per reply, which tools it reaches for, time, and whether it claims to be done.
Only what Droid DOES is recorded — its prompts are not captured or copied.

Needs FACTORY_API_KEY (Droid requires a Factory login even with BYOK) and
OPENROUTER_API_KEY in the environment harbor passes to the agent.
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

OPENROUTER = "https://openrouter.ai/api/v1"


class Droid(BaseInstalledAgent):
    def __init__(self, logs_dir: Path, *args: Any, reasoning: str | None = "low", **kwargs: Any) -> None:
        super().__init__(logs_dir, *args, **kwargs)
        self._reasoning = reasoning

    @staticmethod
    def name() -> str:
        return "droid"

    def version(self) -> str | None:
        return self._version or "latest"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl", "bash", "procps", "git"))
        await self.exec_as_agent(
            environment,
            command=(
                "set -e; curl -fsSL https://app.factory.ai/cli | sh; "
                'export PATH="$HOME/.local/bin:$PATH"; droid --version'
            ),
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        model = self._parsed_model_name or ""
        key = self._get_env("OPENROUTER_API_KEY") or ""
        factory = self._get_env("FACTORY_API_KEY") or ""
        if not factory:
            raise ValueError("FACTORY_API_KEY is required: Droid needs a Factory login even with BYOK")
        logs = self.environment_logs_dir.as_posix()
        settings = {
            "customModels": [
                {
                    "model": model,
                    "id": "custom:bench-model",
                    "index": 0,
                    "baseUrl": OPENROUTER,
                    "apiKey": key,
                    "displayName": model,
                    "noImageSupport": True,
                    "provider": "generic-chat-completion-api",
                }
            ]
        }
        await self._upload_config_text(
            environment,
            content=json.dumps(settings),
            remote_path="/tmp/droid-settings.json",
            filename="settings.json",
        )
        effort = f"-r {shlex.quote(self._reasoning)} " if self._reasoning else ""
        command = (
            'export PATH="$HOME/.local/bin:$PATH"; mkdir -p "$HOME/.factory" '
            f"{shlex.quote(logs)}; cp /tmp/droid-settings.json \"$HOME/.factory/settings.json\"; "
            f'droid exec --skip-permissions-unsafe -m custom:bench-model {effort}-o stream-json "$DROID_TASK" '
            f"2>&1 | tee {shlex.quote(logs)}/droid.jsonl; true"
        )
        await self.exec_as_agent(
            environment,
            command=f"bash -c {shlex.quote(command)}",
            env={"FACTORY_API_KEY": factory, "DROID_TASK": instruction},
        )
        tail = await environment.exec(command=f"tail -c 65536 {shlex.quote(logs)}/droid.jsonl")
        for line in reversed((tail.stdout or "").splitlines()):
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "completion":
                u = ev.get("usage") or {}
                context.n_input_tokens = int(u.get("input_tokens") or 0) + int(u.get("cache_read_input_tokens") or 0)
                context.n_cache_tokens = int(u.get("cache_read_input_tokens") or 0)
                context.n_output_tokens = int(u.get("output_tokens") or 0)
                break
