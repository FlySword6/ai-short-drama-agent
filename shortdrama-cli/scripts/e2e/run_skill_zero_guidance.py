#!/usr/bin/env python3
"""Three-run clean Codex evaluation for the released shortdrama Skill."""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import shlex
import shutil
import statistics
import subprocess
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from run_cli_product_e2e import (
    E2eFailure,
    Runner,
    install_release,
    load_env_file,
    sanitize,
)


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GOAL = "给雾岛来信第 1 集出交付清单"


def output_schema() -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": False,
        "required": ["completed", "project_id", "episode_id", "output_path", "blocker"],
        "properties": {
            "completed": {"type": "boolean"},
            "project_id": {"type": ["string", "null"]},
            "episode_id": {"type": ["string", "null"]},
            "output_path": {"type": ["string", "null"]},
            "blocker": {"type": ["string", "null"]},
        },
    }


def shortdrama_argv(command: str) -> list[str] | None:
    if any(marker in command for marker in ("\n", "\r", ";", "|", "&", "`", "$(")):
        return None
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    if not tokens:
        return None
    executable = Path(tokens[0]).name
    if executable in {"bash", "sh", "zsh"} and ("-c" in tokens or "-lc" in tokens):
        flag = "-lc" if "-lc" in tokens else "-c"
        index = tokens.index(flag)
        if index + 1 < len(tokens):
            return shortdrama_argv(tokens[index + 1])
        return None
    if any(token in {"&&", "||", ";", "|"} for token in tokens):
        return None
    while tokens and "=" in tokens[0] and not tokens[0].startswith(("./", "/")):
        tokens = tokens[1:]
    if tokens and Path(tokens[0]).name in {"shortdrama", "shortdrama-cli"}:
        return [Path(tokens[0]).name, *tokens[1:]]
    return None


def redact_argv(argv: list[str]) -> list[str]:
    sensitive_flags = {"--password", "--token", "--api-key", "--secret", "--access-key"}
    redacted: list[str] = []
    redact_next = False
    for value in argv:
        if redact_next:
            redacted.append("<redacted>")
            redact_next = False
            continue
        lowered = value.lower()
        if lowered in sensitive_flags:
            redacted.append(value)
            redact_next = True
            continue
        if any(lowered.startswith(f"{flag}=") for flag in sensitive_flags):
            redacted.append(f"{value.split('=', 1)[0]}=<redacted>")
            continue
        redacted.append(sanitize(value))
    return redacted


def command_evidence(raw_events: str) -> list[dict[str, object]]:
    evidence: list[dict[str, object]] = []

    def visit(value: object) -> None:
        if isinstance(value, dict):
            if value.get("type") == "command_execution" and isinstance(value.get("command"), str):
                exit_code = value.get("exit_code")
                if isinstance(exit_code, int):
                    command = value["command"]
                    argv = shortdrama_argv(command)
                    if argv is not None:
                        evidence.append({
                            "argv": redact_argv(argv),
                            "exit_code": exit_code,
                            "status": value.get("status"),
                        })
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    for line in raw_events.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        visit(event)
    return evidence


def resolve_output(workdir: Path, raw: object) -> Path | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = workdir / candidate
    resolved = candidate.resolve()
    if workdir.resolve() not in resolved.parents and resolved != workdir.resolve():
        return None
    return resolved


def validate_delivery_csv(output: Path) -> None:
    text = output.read_text(encoding="utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 2:
        raise E2eFailure("交付 CSV 没有数据行")
    required = {"project_id", "episode_no", "shot_code", "generation_request_id"}
    if not required.issubset(set(rows[0])):
        raise E2eFailure("交付 CSV 表头不完整")


def minimal_codex_env(source: dict[str, str]) -> dict[str, str]:
    allowed = {
        "HOME",
        "PATH",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_ORG_ID",
        "OPENAI_PROJECT_ID",
        "SHORTDRAMA_API_TOKEN",
        "SHORTDRAMA_ENV",
    }
    return {key: value for key, value in source.items() if key in allowed and value}


def run_once(
    *,
    index: int,
    codex_bin: str,
    cli_bin: Path,
    skill_dir: Path,
    session_home: Path,
    goal: str,
    artifact_dir: Path,
    base_env: dict[str, str],
) -> dict[str, Any]:
    run_dir = artifact_dir / f"run-{index}"
    workdir = run_dir / "workspace"
    codex_home = run_dir / "codex-home"
    installed_skill = codex_home / "skills" / "shortdrama-cli"
    workdir.mkdir(parents=True)
    installed_skill.mkdir(parents=True)
    shutil.copy2(skill_dir / "SKILL.md", installed_skill / "SKILL.md")
    schema_file = run_dir / "result-schema.json"
    result_file = run_dir / "result.json"
    evidence_file = run_dir / "command-evidence.json"
    schema_file.write_text(json.dumps(output_schema(), ensure_ascii=False, indent=2), encoding="utf-8")

    env = {
        **base_env,
        "CODEX_HOME": str(codex_home),
        "SHORTDRAMA_CONFIG_HOME": str(session_home),
        "PATH": f"{cli_bin.parent}{os.pathsep}{base_env.get('PATH', '')}",
    }
    command = [
        codex_bin,
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
        "--json",
        "--output-schema",
        str(schema_file),
        "--output-last-message",
        str(result_file),
        "-C",
        str(workdir),
        goal,
    ]
    started = time.monotonic()
    completed = subprocess.run(
        command,
        env=env,
        cwd=workdir,
        text=True,
        capture_output=True,
        check=False,
    )
    duration_ms = round((time.monotonic() - started) * 1_000)
    final: dict[str, Any] = {}
    error: str | None = None
    evidence = command_evidence(completed.stdout)
    evidence_file.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    try:
        final = json.loads(result_file.read_text(encoding="utf-8"))
        if not isinstance(final, dict):
            raise E2eFailure("最终输出不是 JSON 对象")
        if completed.returncode != 0:
            raise E2eFailure(completed.stderr or "codex exec 非零退出")
        if final.get("completed") is not True:
            raise E2eFailure(final.get("blocker") or "子会话没有完成任务")
        output = resolve_output(workdir, final.get("output_path"))
        if output is None or not output.is_file() or output.stat().st_size == 0:
            raise E2eFailure("子会话没有在干净工作区落有效交付清单")
        validate_delivery_csv(output)
        project_id = final.get("project_id")
        episode_id = final.get("episode_id")
        if not isinstance(project_id, str) or not project_id:
            raise E2eFailure("子会话没有回报实际 project_id")
        if not isinstance(episode_id, str) or not episode_id:
            raise E2eFailure("子会话没有回报实际 episode_id")
        successful_commands = [
            [str(part) for part in item["argv"]]
            for item in evidence
            if item.get("exit_code") == 0 and isinstance(item.get("argv"), list)
        ]
        expected_calls = (
            (["project", "list"], None, None),
            (["project", "episode-list"], "--project-id", project_id),
            (["delivery", "manifest"], "--episode-id", episode_id),
            (["delivery", "csv"], "--episode-id", episode_id),
        )
        for prefix, flag, expected_value in expected_calls:
            matched = False
            for argv in successful_commands:
                args = argv[1:]
                if args[:len(prefix)] != prefix:
                    continue
                if flag is not None and (
                    flag not in args
                    or args.index(flag) + 1 >= len(args)
                    or args[args.index(flag) + 1] != expected_value
                ):
                    continue
                matched = True
                break
            if not matched:
                raise E2eFailure(f"命令证据缺少成功调用：{' '.join(prefix)}")
        csv_args = next(
            (
                argv[1:] for argv in successful_commands
                if argv[1:3] == ["delivery", "csv"] and "--output" in argv
            ),
            None,
        )
        if csv_args is None:
            raise E2eFailure("delivery csv 命令缺少 --output")
        output_index = csv_args.index("--output")
        if output_index + 1 >= len(csv_args):
            raise E2eFailure("delivery csv 的 --output 缺少路径")
        csv_output = Path(csv_args[output_index + 1])
        if not csv_output.is_absolute():
            csv_output = workdir / csv_output
        if csv_output.resolve() != output:
            raise E2eFailure("最终 output_path 不是 delivery csv 命令实际写出的文件")
    except (OSError, json.JSONDecodeError, E2eFailure) as caught:
        error = sanitize(caught)
    safe_result = {
        "completed": final.get("completed"),
        "project_id": final.get("project_id"),
        "episode_id": final.get("episode_id"),
        "output_path": final.get("output_path"),
        "blocker": sanitize(final.get("blocker")) if final.get("blocker") else None,
    }
    result_file.write_text(
        json.dumps(safe_result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return {
        "run": index,
        "ok": error is None,
        "exit_code": completed.returncode,
        "duration_ms": duration_ms,
        "cli_command_events": len(evidence),
        "result": safe_result,
        "error": error,
        "artifacts": {
            "command_evidence": str(evidence_file.resolve()),
            "result": str(result_file.resolve()),
            "workspace": str(workdir.resolve()),
        },
        "skill_files": ["SKILL.md"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-tag", default=os.getenv("CLI_E2E_RELEASE_TAG", ""))
    parser.add_argument("--env-file", type=Path, default=None)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--goal", default=os.getenv("CLI_E2E_ZERO_GUIDANCE_GOAL", DEFAULT_GOAL))
    parser.add_argument("--codex-bin", default=os.getenv("CODEX_BIN", "codex"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    load_env_file(args.env_file)
    os.environ.setdefault("SHORTDRAMA_ENV", os.getenv("CLI_E2E_TARGET_ENVIRONMENT", "test"))
    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    required = ("SHORTDRAMA_API_TOKEN", "OPENAI_API_KEY")
    missing = [key for key in required if not os.getenv(key)]
    result: dict[str, Any] = {
        "schema_version": "shortdrama-skill-zero-guidance.v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "target_environment": os.environ["SHORTDRAMA_ENV"],
        "release_tag": args.release_tag or None,
        "goal": args.goal,
        "ok": False,
        "runs": [],
        "success_count": 0,
        "median_duration_ms": None,
        "error": None,
    }
    try:
        if missing:
            raise E2eFailure(f"缺少零指导测试环境变量：{', '.join(missing)}")
        if not args.release_tag:
            raise E2eFailure("零指导发版门必须提供 Release tag")
        with tempfile.TemporaryDirectory(prefix="shortdrama-skill-e2e-") as directory:
            temp_root = Path(directory)
            install_runner = Runner(args.artifact_dir, dict(os.environ))
            install_release(install_runner, args.release_tag, temp_root)
            cli_bin = Path(install_runner.cli_bin)
            session_home = temp_root / "session"
            base_env = {
                **os.environ,
                "SHORTDRAMA_CONFIG_HOME": str(session_home),
            }
            skill_dir = Path(install_runner.env["SHORTDRAMA_SKILL_DIR"])
            runs = [
                run_once(
                    index=index,
                    codex_bin=args.codex_bin,
                    cli_bin=cli_bin,
                    skill_dir=skill_dir,
                    session_home=session_home,
                    goal=args.goal,
                    artifact_dir=args.artifact_dir,
                    base_env=minimal_codex_env(base_env),
                )
                for index in range(1, 4)
            ]
            result["runs"] = runs
            successful = [run for run in runs if run["ok"]]
            result["success_count"] = len(successful)
            result["median_duration_ms"] = round(
                statistics.median(run["duration_ms"] for run in runs)
            )
            result["ok"] = len(successful) >= 2
            if not result["ok"]:
                result["error"] = "三次零指导测试少于两次完成，发版门不通过"
    except (E2eFailure, OSError, subprocess.SubprocessError) as error:
        result["error"] = sanitize(error)
    finally:
        result["finished_at"] = datetime.now(UTC).isoformat()
        args.summary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
