"""Stable output formatting for WorkBuddy and humans."""

import json
import sys
from typing import Any, Literal

from rich.console import Console

OutputFormat = Literal["human", "json"]

console = Console()

_SENSITIVE_OUTPUT_KEYS = frozenset(
    {
        "access_key",
        "api_key",
        "authorization",
        "body",
        "connection_string",
        "content",
        "credential",
        "credentials",
        "error_detail",
        "password",
        "prompt",
        "raw",
        "raw_error",
        "raw_response",
        "refresh_token",
        "result",
        "script",
        "script_content",
        "secret",
        "token",
        "tool_args",
        "tool_result",
        "vendor_response",
    }
)


def _is_sensitive_output_key(key: object) -> bool:
    """Recognize fields that must never reach a CLI transcript or JSON consumer."""

    normalized = str(key).lower().replace("-", "_")
    return (
        normalized in _SENSITIVE_OUTPUT_KEYS
        or normalized.endswith(("_token", "_secret", "_password", "_prompt"))
    )


def redact_output(value: Any) -> Any:
    """Project remote output to a safe CLI representation.

    The backend remains the source of authorization and audit decisions.  This
    client-side projection is a defence in depth measure: an unexpected backend
    envelope must not make a prompt, credential, raw provider response, or tool
    payload appear in terminal logs, WorkBuddy output, or copied JSON.
    """

    if isinstance(value, dict):
        return {
            str(key): "[redacted]" if _is_sensitive_output_key(key) else redact_output(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_output(item) for item in value]
    if isinstance(value, tuple):
        return [redact_output(item) for item in value]
    return value


def print_response(value: dict[str, Any], output_format: OutputFormat) -> None:
    """Print a response as compact human text or stable JSON."""

    safe_value = redact_output(value)
    if not isinstance(safe_value, dict):  # pragma: no cover - protects the public type boundary.
        safe_value = {"status": "failed", "error": {"code": "invalid_output"}}

    if output_format == "json":
        # Rich wraps long strings at the terminal width, which can inject raw
        # newlines inside JSON strings and make agent output unparsable.
        sys.stdout.write(f"{json.dumps(safe_value, ensure_ascii=False, indent=2)}\n")
        sys.stdout.flush()
        return

    status = safe_value.get("status")
    action = safe_value.get("action")
    if action == "generate_image" and status == "submitted":
        console.print(
            "image_generation=submitted "
            f"task={safe_value.get('task_id')} "
            f"project={safe_value.get('project_id')} "
            f"scene={safe_value.get('scene_id')} "
            f"variants={safe_value.get('variants', _variants_from_usage(safe_value))}"
        )
        return

    if action:
        parts = [f"{str(action).replace('_', '-')}={status}"]
        for key in ("task_id", "project_id", "script_id", "scene_id", "asset_id", "result_id"):
            if safe_value.get(key) is not None:
                parts.append(f"{key.removesuffix('_id')}={safe_value.get(key)}")
        console.print(" ".join(parts))
        return

    if status == "failed":
        error = safe_value.get("error", {})
        console.print(f"failed code={error.get('code')} message={error.get('message')}")
        return

    console.print(json.dumps(safe_value, ensure_ascii=False))


def _variants_from_usage(value: dict[str, Any]) -> int | None:
    results = value.get("results")
    return len(results) if isinstance(results, list) else None
