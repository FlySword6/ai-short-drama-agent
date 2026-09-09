import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from .config import settings

logger = logging.getLogger("shortdrama_api.agent")

# Workspace-writable pi config directory so the sandboxed pi process
# can create its settings and session directories.
_PI_HOME = Path(__file__).resolve().parents[3] / "runtime" / ".pi-home"


def _pi_cmd(message: str) -> list[str]:
    """Build the pi command line with model provider from environment."""
    if sys.platform == "win32":
        pi_bin = "pi.cmd"
    else:
        pi_bin = "pi"

    cmd = [pi_bin, "-p", "--mode", "json", "--no-session"]

    # Model provider: respect PI_MODEL_PROVIDER / PI_MODEL_NAME env vars.
    provider = os.environ.get("PI_MODEL_PROVIDER", "").strip()
    model = os.environ.get("PI_MODEL_NAME", "").strip()
    if provider:
        cmd.extend(["--provider", provider])
    if model:
        cmd.extend(["--model", model])

    cmd.append(message)
    return cmd


def _pi_env() -> dict[str, str]:
    """Build the environment for the pi subprocess, forwarding API keys."""
    env = dict(os.environ)
    env["PI_CODING_AGENT_DIR"] = str(_PI_HOME)
    # Forward common LLM API key env vars from the parent process.
    for key in (
        "OPENAI_API_KEY", "OPENAI_BASE_URL",
        "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
        "DEEPSEEK_API_KEY", "KIMI_API_KEY",
        "ARK_API_KEY",
    ):
        if key in os.environ:
            env[key] = os.environ[key]
    return env


async def call_agent(message: str, context: dict | None = None) -> dict:
    full_message = message
    if context:
        context_str = "\n".join(f"{k}: {v}" for k, v in context.items())
        full_message = f"{message}\n\n上下文件:\n{context_str}"

    cmd = _pi_cmd(full_message)
    env = _pi_env()

    logger.info("Agent exec: pi -p (provider=%s model=%s) %s...",
                env.get("PI_MODEL_PROVIDER", "default"),
                env.get("PI_MODEL_NAME", "default"),
                message[:100])

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout_b, stderr_b = await asyncio.wait_for(
            proc.communicate(), timeout=settings.AGENT_TIMEOUT
        )
    except asyncio.TimeoutError:
        proc.kill()
        return {"status": "failed", "error": f"Agent timeout ({settings.AGENT_TIMEOUT}s)"}

    stdout = stdout_b.decode("utf-8", errors="replace").strip()
    stderr = stderr_b.decode("utf-8", errors="replace").strip()

    if proc.returncode != 0:
        logger.error("Agent failed rc=%d: %s", proc.returncode, stderr[:500])
        return {"status": "failed", "error": stderr or f"Agent exit code {proc.returncode}", "stdout": stdout}

    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return {"status": "succeeded", "response": stdout}


async def call_agent_stream(message: str, context: dict | None = None):
    result = await call_agent(message, context)
    yield json.dumps(result, ensure_ascii=False)
