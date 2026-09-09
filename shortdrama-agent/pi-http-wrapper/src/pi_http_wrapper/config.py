"""Environment-only configuration. Secrets are never read from project files."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from shortdrama_cli.api.errors import ApiConfigurationError

from .trusted_endpoint import resolve_trusted_environment


class ConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class Settings:
    bearer_tokens: tuple[str, ...]
    internal_token: str
    audit_log_path: Path
    skill_roots: tuple[Path, Path]
    skill_state_path: Path
    context_path: Path = Path("/var/lib/pi-http-wrapper/turn-context.json")
    pi_bin: str = "pi"
    pi_command_timeout_seconds: float = 30.0
    tool_result_timeout_seconds: float = 600.0
    tool_callback_url: str = "http://127.0.0.1:8787/internal/tool-calls"
    bind_host: str = "127.0.0.1"
    bind_port: int = 8787
    main_environment: str | None = None
    main_agent_token: str | None = None

    @classmethod
    def from_environment(cls) -> "Settings":
        raw_tokens = os.environ.get("PI_WRAPPER_BEARER_TOKENS", "")
        tokens = tuple(token.strip() for token in raw_tokens.split(",") if token.strip())
        if not tokens:
            raise ConfigurationError("PI_WRAPPER_BEARER_TOKENS must contain at least one token")
        internal_token = os.environ.get("PI_WRAPPER_INTERNAL_TOKEN", "").strip()
        if not internal_token:
            raise ConfigurationError("PI_WRAPPER_INTERNAL_TOKEN is required for the localhost tool bridge")
        if os.environ.get("PI_WRAPPER_API_KEY_FILE") or Path(".api_key").exists():
            raise ConfigurationError(".api_key is unsupported; configure PI_WRAPPER_BEARER_TOKENS via environment")
        legacy_api_base = os.environ.get("SHORTDRAMA_API_BASE", "").strip()
        if legacy_api_base:
            raise ConfigurationError(
                "SHORTDRAMA_API_BASE 已不再支持：wrapper 不再接受任意 URL，"
                "请改用 SHORTDRAMA_ENV 指定受信环境名（prod/test/dev），"
                "后端地址由 shortdrama-cli 内置的受信端点清单决定。",
            )
        main_environment = os.environ.get("SHORTDRAMA_ENV", "").strip() or None
        main_agent_token = os.environ.get("SHORTDRAMA_AGENT_TOKEN", "").strip() or None
        if (main_environment is None) != (main_agent_token is None):
            raise ConfigurationError(
                "SHORTDRAMA_ENV 与 SHORTDRAMA_AGENT_TOKEN 必须同时配置",
            )
        if main_environment is not None:
            try:
                resolve_trusted_environment(main_environment)
            except ApiConfigurationError as error:
                raise ConfigurationError(str(error)) from error
        return cls(
            bearer_tokens=tokens,
            internal_token=internal_token,
            audit_log_path=Path(os.environ.get("PI_WRAPPER_AUDIT_LOG", "/var/log/pi-http-wrapper/audit.jsonl")),
            skill_roots=(
                Path(os.environ.get("PI_WRAPPER_AGENTS_SKILLS_ROOT", "~/.agents/skills")).expanduser(),
                Path(os.environ.get("PI_WRAPPER_WORKBUDDY_SKILLS_ROOT", "~/.workbuddy/skills")).expanduser(),
            ),
            skill_state_path=Path(os.environ.get("PI_WRAPPER_SKILL_STATE_PATH", "/var/lib/pi-http-wrapper/skills.json")),
            context_path=Path(os.environ.get("PI_WRAPPER_CONTEXT_PATH", "/var/lib/pi-http-wrapper/turn-context.json")),
            pi_bin=os.environ.get("PI_BIN", "pi"),
            pi_command_timeout_seconds=float(os.environ.get("PI_WRAPPER_COMMAND_TIMEOUT_SECONDS", "30")),
            tool_result_timeout_seconds=float(os.environ.get("PI_WRAPPER_TOOL_RESULT_TIMEOUT_SECONDS", "600")),
            tool_callback_url=os.environ.get(
                "PI_WRAPPER_TOOL_CALLBACK_URL",
                "http://127.0.0.1:8787/internal/tool-calls",
            ),
            bind_host=os.environ.get("PI_WRAPPER_HOST", "127.0.0.1"),
            bind_port=int(os.environ.get("PI_WRAPPER_PORT", "8787")),
            main_environment=main_environment,
            main_agent_token=main_agent_token,
        )
