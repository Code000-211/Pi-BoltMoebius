"""
A Harbor agent that runs a Pi-Lightspeed build on Terminal-Bench tasks (https://github.com/harbor-framework/terminal-bench-2-1).

    PYTHONPATH=bench/harness harbor run -d terminal-bench/terminal-bench-2-1 -e docker \\
        --agent-import-path tb_agent:PiLightspeed -m melious/deepseek-v4.1-flash \\
        --ak harness_dir=out/pi-bolt --ak extensions=<folder of docsearch> --ak models_json=~/.pi/agent/models.json

`harness_dir` (a build from scripts/build-pi.sh) is uploaded into the task's container, and each folder in `extensions`
(comma-separated, each with an index.ts) next to it and loaded with `-e`; nothing else is (`-ne -ns -np -nc`), so the run
measures the repository's build, not an installation's settings. `models_json` gives the model's provider: only that
provider goes into the container's agent folder.
"""

from __future__ import annotations

import json
import shlex
import subprocess
import tempfile
import tomllib
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

HARNESS_DIR = "/opt/pi-harness"
EXTENSIONS_DIR = "/opt/pi-extensions"
AGENT_DIR = "/opt/pi-agent"


class PiLightspeed(BaseInstalledAgent):
    def __init__(
        self,
        *args,
        harness_dir: str | None = None,
        extensions: str = "",
        models_json: str = "~/.pi/agent/models.json",
        time_limit: str = "true",
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        # PI_TIME_LIMIT from the task's agent timeout (off: "false", to measure without it).
        self._tell_time_limit = str(time_limit).lower() not in ("false", "0", "no", "off")
        if not harness_dir:
            raise ValueError("PiLightspeed needs --ak harness_dir=<folder of the Pi build>")
        self._harness_dir = Path(harness_dir).expanduser()
        self._extensions = [Path(p).expanduser() for p in extensions.split(",") if p]
        self._models_json = Path(models_json).expanduser()

    @staticmethod
    def name() -> str:
        return "pi-lightspeed"

    def version(self) -> str | None:
        return None

    def _provider(self) -> tuple[str, dict]:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be provider/model, the provider defined in models_json")
        provider = self.model_name.split("/", 1)[0]
        config = json.loads(self._models_json.read_text()).get("providers", {}).get(provider)
        if config is None:
            raise ValueError(f"Provider {provider} is not in {self._models_json}")
        key = config.get("apiKey", "")
        if key.startswith("!"):
            # A command that prints the key reads files of this machine: the container gets the key it printed.
            printed = subprocess.run(key[1:], shell=True, capture_output=True, text=True, check=True).stdout.strip()
            config = {**config, "apiKey": printed}
        return provider, config

    async def install(self, environment: BaseEnvironment) -> None:
        await environment.upload_dir(self._harness_dir, HARNESS_DIR)
        for extension in self._extensions:
            await environment.upload_dir(extension, f"{EXTENSIONS_DIR}/{extension.name}")
        provider, config = self._provider()
        with tempfile.TemporaryDirectory() as tmp:
            models = Path(tmp) / "models.json"
            models.write_text(json.dumps({"providers": {provider: config}}))
            await self.exec_as_root(environment, f"mkdir -p {AGENT_DIR}")
            await environment.upload_file(models, f"{AGENT_DIR}/models.json")

    @staticmethod
    def _time_limit(environment: BaseEnvironment) -> float | None:
        """The task's agent timeout from its task.toml (beside its environment folder), as the run is given it."""
        try:
            task = tomllib.loads((Path(environment.environment_dir).parent / "task.toml").read_text())
            return float(task["agent"]["timeout_sec"])
        except (OSError, KeyError, ValueError, TypeError):
            return None

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        extension_args = "".join(f"-e {EXTENSIONS_DIR}/{e.name}/index.ts " for e in self._extensions)
        limit = self._time_limit(environment) if self._tell_time_limit else None
        # Less a little for starting up and the last request: the notices come a bit early rather than late.
        time_env = f"PI_TIME_LIMIT={int(limit * 0.95)} " if limit else ""
        events = self.environment_logs_dir / "pi.jsonl"
        stderr = self.environment_logs_dir / "pi.stderr"
        await self.exec_as_agent(
            environment,
            command=(
                f"{time_env}PI_CODING_AGENT_DIR={AGENT_DIR} {HARNESS_DIR}/pi --mode json --no-session -ne -ns -np -nc --no-mcp "
                f"{extension_args}--model {shlex.quote(self.model_name)} {shlex.quote(instruction)} "
                f"</dev/null 2>{shlex.quote(str(stderr))} | grep --line-buffered -v '\"type\":\"message_update\"' "
                f"> {shlex.quote(str(events))}"
            ),
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        events = self.logs_dir / "pi.jsonl"
        if not events.exists():
            return
        steps = inp = cache = out = 0
        cost = 0.0
        for line in events.read_text(errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = event.get("message") or {}
            if event.get("type") != "message_end" or message.get("role") != "assistant":
                continue
            usage = message.get("usage") or {}
            steps += 1
            inp += usage.get("input", 0)
            cache += usage.get("cacheRead", 0)
            out += usage.get("output", 0)
            cost += (usage.get("cost") or {}).get("total", 0.0)
        context.metadata = {**(context.metadata or {}), "turns": steps}
        context.n_input_tokens = inp + cache
        context.n_cache_tokens = cache
        context.n_output_tokens = out
        context.cost_usd = cost
