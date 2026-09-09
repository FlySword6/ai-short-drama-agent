#!/usr/bin/env python3
"""Release-installed CLI product E2E.

The runner intentionally treats the packaged CLI as a black box.  It never
imports ``shortdrama_cli`` and never connects to PostgreSQL or a provider.
Secrets are accepted only through environment variables or a gitignored env
file and are never copied into the JSON summary.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import struct
import subprocess
import tempfile
import time
import zlib
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable
from uuid import uuid4


PROJECT_ROOT = Path(__file__).resolve().parents[2]
TERMINAL_BREAKDOWN = {"draft", "failed", "discarded", "superseded"}
TERMINAL_UPLOAD = {"succeeded", "failed"}
TERMINAL_GENERATION = {"succeeded", "failed", "partial", "cancelled"}
SECRET_PATTERN = re.compile(
    r"(?i)(authorization|password|passwd|token|secret|api[_ -]?key|access[_ -]?key)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)
@dataclass
class Step:
    name: str
    ok: bool
    exit_code: int
    observed_ms: int
    assertions: list[str] = field(default_factory=list)
    error: str | None = None


class E2eFailure(RuntimeError):
    pass


def sanitize(value: object) -> str:
    text = str(value)
    text = SECRET_PATTERN.sub(r"\1\2<redacted>", text)
    text = re.sub(
        r"(?i)(--(?:password|token|api-key|secret|access-key)\s+)([^\s]+)",
        r"\1<redacted>",
        text,
    )
    text = re.sub(r"([?&](?:key|token|signature|secret|password)=)[^&\s]+", r"\1<redacted>", text, flags=re.I)
    text = re.sub(r"\b[A-Za-z0-9_+/=-]{40,}\b", "<redacted>", text)
    return text[:2_000]


def generated_portrait_fixture(width: int = 512, height: int = 512) -> bytes:
    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    rows = []
    for y in range(height):
        tone = 205 + (y % 24)
        rows.append(b"\x00" + bytes((tone, 190, 175)) * width)
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


def load_env_file(path: Path | None) -> None:
    if path is None or not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


def nested(data: dict[str, Any], *keys: str) -> Any:
    value: Any = data
    for key in keys:
        if not isinstance(value, dict) or key not in value:
            raise E2eFailure(f"响应缺少字段：{'.'.join(keys)}")
        value = value[key]
    return value


def identifier(data: dict[str, Any], *paths: tuple[str, ...]) -> str:
    for path in paths:
        value: Any = data
        for key in path:
            if not isinstance(value, dict):
                value = None
                break
            value = value.get(key)
        if isinstance(value, str) and value:
            return value
    raise E2eFailure(f"响应缺少可串联 ID：{paths}")


class Runner:
    def __init__(self, artifact_dir: Path, env: dict[str, str]) -> None:
        self.artifact_dir = artifact_dir
        self.env = env
        self.steps: list[Step] = []
        self.cli_bin = ""

    def command(
        self,
        name: str,
        args: list[str],
        *,
        expect_success: bool = True,
        expect_error_codes: Iterable[str] = (),
        cwd: Path | None = None,
        parse_json: bool = True,
    ) -> dict[str, Any]:
        started = time.monotonic()
        completed = subprocess.run(
            args,
            cwd=cwd or PROJECT_ROOT,
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )
        observed_ms = round((time.monotonic() - started) * 1_000)
        assertions: list[str] = [f"exit_code={completed.returncode}"]
        payload: dict[str, Any] = {}
        error: str | None = None
        try:
            if parse_json:
                payload = json.loads(completed.stdout)
                if not isinstance(payload, dict):
                    raise ValueError("stdout 不是 JSON 对象")
                assertions.append("stdout=json_object")
            if expect_success:
                if completed.returncode != 0:
                    raise E2eFailure(completed.stdout or completed.stderr or "命令失败")
                if parse_json and payload.get("status") != "succeeded":
                    raise E2eFailure("CLI JSON 信封不是 succeeded")
            else:
                if completed.returncode == 0:
                    raise E2eFailure("预期拒绝的命令却成功了")
                serialized = f"{completed.stdout}\n{completed.stderr}"
                matched = [code for code in expect_error_codes if code in serialized]
                if expect_error_codes and not matched:
                    raise E2eFailure(f"拒绝响应没有预期错误码：{list(expect_error_codes)}")
                assertions.extend(f"rejected={code}" for code in matched)
        except (E2eFailure, json.JSONDecodeError, ValueError) as caught:
            error = sanitize(caught)
        ok = error is None
        self.steps.append(Step(name, ok, completed.returncode, observed_ms, assertions, error))
        if not ok:
            raise E2eFailure(f"{name}: {error}")
        return payload

    def cli(
        self,
        name: str,
        args: list[str],
        *,
        expect_success: bool = True,
        expect_error_codes: Iterable[str] = (),
    ) -> dict[str, Any]:
        return self.command(
            name,
            [self.cli_bin, *args],
            expect_success=expect_success,
            expect_error_codes=expect_error_codes,
        )


def wait_for(
    runner: Runner,
    *,
    step_prefix: str,
    command: list[str],
    status_path: tuple[str, ...],
    terminals: set[str],
    timeout_seconds: int,
    interval_seconds: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        payload = runner.cli(f"{step_prefix}_poll_{attempt}", command)
        data = nested(payload, "data")
        value: Any = data
        for key in status_path:
            value = value.get(key) if isinstance(value, dict) else None
        if value in terminals:
            if value == "failed":
                raise E2eFailure(f"{step_prefix} 进入 failed")
            return payload
        time.sleep(interval_seconds)
    raise E2eFailure(f"{step_prefix} 等待终态超时")


def run_contract_suite(runner: Runner) -> None:
    raw = os.getenv("CLI_E2E_CONTRACT_TEST_COMMAND", "uv run --frozen pytest -q")
    runner.command(
        "cli_contract_and_paid_guard_suite",
        shlex.split(raw),
        cwd=PROJECT_ROOT,
        parse_json=False,
    )


def install_release(runner: Runner, release_tag: str, temp_root: Path) -> None:
    install_root = temp_root / "install"
    skill_root = temp_root / "skill"
    runner.env.update({
        "SHORTDRAMA_INSTALL_DIR": str(install_root),
        "SHORTDRAMA_SKILL_DIR": str(skill_root),
        "SHORTDRAMA_VERSION": release_tag,
        "SHORTDRAMA_NO_MODIFY_PATH": "1",
    })
    runner.command(
        "release_install",
        ["sh", str(PROJECT_ROOT / "scripts" / "install-shortdrama-cli.sh")],
        parse_json=False,
    )
    binary = install_root / "bin" / "shortdrama-cli"
    if not binary.is_file():
        raise E2eFailure("Release 安装后找不到 shortdrama-cli")
    runner.cli_bin = str(binary)


def data_of(payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data")
    if not isinstance(data, dict):
        raise E2eFailure("CLI 响应 data 不是对象")
    return data


def first_item(payload: dict[str, Any], label: str) -> dict[str, Any]:
    items = data_of(payload).get("items")
    if not isinstance(items, list) or not items or not isinstance(items[0], dict):
        raise E2eFailure(f"{label} 没有可用项")
    return items[0]


def resolve_delivery_episode(runner: Runner, created_episode_id: str) -> tuple[str, str]:
    configured = os.getenv("CLI_E2E_DELIVERY_EPISODE_ID")
    if configured:
        return configured, "configured_fixture"
    project_name = os.getenv("CLI_E2E_DELIVERY_PROJECT_NAME", "雾岛来信")
    projects = data_of(runner.cli("delivery_seed_project_list", ["project", "list"])).get("items")
    if isinstance(projects, list):
        project = next(
            (
                item for item in projects
                if isinstance(item, dict) and item.get("name") == project_name and isinstance(item.get("id"), str)
            ),
            None,
        )
        if project:
            episodes = data_of(runner.cli(
                "delivery_seed_episode_list",
                ["project", "episode-list", "--project-id", str(project["id"])],
            )).get("items")
            if isinstance(episodes, list):
                episode = next(
                    (
                        item for item in episodes
                        if isinstance(item, dict)
                        and (item.get("episode_no") == 1 or item.get("episodeNo") == 1)
                        and isinstance(item.get("id"), str)
                    ),
                    None,
                )
                if episode:
                    return str(episode["id"]), "named_fixture"
    return created_episode_id, "created_episode"


def run_chain(
    runner: Runner,
    artifact_dir: Path,
    max_cost_fen: int,
    allow_paid_generation: bool,
) -> dict[str, Any]:
    runner.cli("doctor_before_login", ["doctor"])
    runner.cli("doctor_after_login", ["doctor", "--require-auth"])
    runner.cli("whoami", ["auth", "whoami"])

    suffix = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    project = data_of(runner.cli(
        "project_create",
        ["project", "create", "--name", f"CLI E2E {suffix}", "--description", "自动化测试站全链项目"],
    ))
    project_id = identifier(project, ("id",))
    episode = data_of(runner.cli(
        "episode_create",
        [
            "project", "episode-create", "--project-id", project_id,
            "--episode-no", "1", "--name", "自动化第一集",
        ],
    ))
    episode_id = identifier(episode, ("id",))

    script_text = os.getenv(
        "CLI_E2E_SCRIPT_TEXT",
        "第1集 第1场 夜 内 雾岛旧宅\n林秋走进空房，停在窗前。\n林秋：这封信终于回来了。",
    )
    pasted = data_of(runner.cli(
        "script_paste",
        [
            "script", "paste", "--episode-id", episode_id, "--text", script_text,
            "--title", "CLI E2E 剧本", "--client-idempotency-key", str(uuid4()),
        ],
    ))
    script_version_id = identifier(pasted, ("version", "id"), ("id",))
    breakdown = data_of(runner.cli(
        "script_breakdown",
        [
            "script", "breakdown", "--episode-id", episode_id,
            "--script-version-id", script_version_id,
            "--target-duration-sec", "10",
            "--client-idempotency-key", str(uuid4()),
        ],
    ))
    run_id = identifier(breakdown, ("run", "id"), ("id",))
    breakdown_detail = wait_for(
        runner,
        step_prefix="script_breakdown",
        command=["script", "status", "--run-id", run_id],
        status_path=("run", "status"),
        terminals=TERMINAL_BREAKDOWN,
        timeout_seconds=int(os.getenv("CLI_E2E_BREAKDOWN_TIMEOUT_SECONDS", "900")),
        interval_seconds=float(os.getenv("CLI_E2E_POLL_INTERVAL_SECONDS", "3")),
    )
    if nested(data_of(breakdown_detail), "run", "status") != "draft":
        raise E2eFailure("拆解没有进入可确认 draft 状态")
    runner.cli("script_confirm", ["script", "confirm", "--run-id", run_id])
    scene = first_item(
        runner.cli("scene_list", ["project", "scene-list", "--episode-id", episode_id]),
        "场列表",
    )
    shot = first_item(
        runner.cli("shot_list", ["project", "shot-list", "--episode-id", episode_id]),
        "镜头列表",
    )
    scene_id = identifier(scene, ("id",))
    shot_id = identifier(shot, ("id",))

    common_asset = first_item(
        runner.cli("asset_search", ["asset", "search", "--scope", "common", "--query", "角色"]),
        "通用资产检索",
    )
    common_asset_id = identifier(common_asset, ("id",))

    schema = data_of(runner.cli("asset_registration_schema", ["asset", "registration-schema"]))
    registration = {
        "schema_version": schema.get("schema_version"),
        "dictionary_version": schema.get("dictionary_version"),
        "name": f"CLI E2E 肖像 {suffix}",
        "description": "自动化登记验证资产",
        "asset_kind": "character",
        "factor_type": "face_identity",
        "tags": ["cli-e2e"],
        "factor_attributes": {"view_type": "front"},
        "rights_declaration": {
            "source_kind": "self_created",
            "contains_real_person": False,
            "reference_use_confirmed": True,
        },
    }
    image = artifact_dir / "registration-fixture.png"
    image.write_bytes(generated_portrait_fixture())
    upload = data_of(runner.cli(
        "asset_register",
        [
            "asset", "register", "--file", str(image),
            "--registration-json", json.dumps(registration, ensure_ascii=False),
            "--asset-kind", "character",
            "--client-idempotency-key", str(uuid4()),
        ],
    ))
    upload_id = identifier(upload, ("id",))
    upload_detail = wait_for(
        runner,
        step_prefix="asset_register",
        command=["asset", "register-status", "--task-id", upload_id],
        status_path=("status",),
        terminals=TERMINAL_UPLOAD,
        timeout_seconds=int(os.getenv("CLI_E2E_ASSET_TIMEOUT_SECONDS", "900")),
        interval_seconds=float(os.getenv("CLI_E2E_POLL_INTERVAL_SECONDS", "3")),
    )
    upload_data = data_of(upload_detail)
    registered_asset_id = identifier(upload_data, ("result", "asset", "id"))
    registered_media_id = identifier(upload_data, ("result", "asset", "media_id"))
    runner.cli(
        "asset_add_to_project",
        ["asset", "add-to-project", "--project-id", project_id, "--asset-id", registered_asset_id],
    )

    prep = data_of(runner.cli(
        "prep_pull",
        [
            "prep", "pull", "--scene-id", scene_id, "--lane", "character",
            "--asset-id", registered_asset_id, "--asset-media-id", registered_media_id,
            "--client-idempotency-key", str(uuid4()),
        ],
    ))
    prep_item_id = identifier(prep, ("id",))
    runner.cli(
        "prep_send",
        [
            "prep", "send", "--scene-id", scene_id, "--item", prep_item_id,
            "--client-idempotency-key", str(uuid4()),
        ],
    )

    tier = first_item(
        {
            "data": {
                "items": data_of(runner.cli(
                    "generation_capability_tiers",
                    ["generation", "capability-tiers", "--media-type", "video"],
                )).get("tiers"),
            },
        },
        "视频档位",
    )
    tier_id = identifier(tier, ("tier_id",), ("tierId",))
    parameters = tier.get("params")
    if not isinstance(parameters, dict):
        raise E2eFailure("视频档位缺少 params")
    generation_input = {
        "media_kind": "video",
        "tier_id": tier_id,
        "project_id": project_id,
        "episode_id": episode_id,
        "scene_id": scene_id,
        "shot_id": shot_id,
        "supplement_prompt": "固定镜头，人物轻微呼吸，测试短片。",
        "parameters": parameters,
        "quantity": 1,
    }
    generation_key = str(uuid4())
    quote = data_of(runner.cli(
        "generation_estimate",
        [
            "generation", "estimate",
            "--payload", json.dumps(generation_input, ensure_ascii=False),
            "--client-idempotency-key", generation_key,
        ],
    ))
    quote_id = identifier(quote, ("generation_quote_id",))
    estimated_cost_fen = quote.get("estimated_cost_fen")
    if not isinstance(estimated_cost_fen, int) or estimated_cost_fen < 0:
        raise E2eFailure("报价缺少 estimated_cost_fen")
    if estimated_cost_fen > max_cost_fen:
        raise E2eFailure(f"本次估价 {estimated_cost_fen} 分超过自动化上限 {max_cost_fen} 分")

    pending_payload = {**generation_input, "generation_quote_id": quote_id}
    runner.cli(
        "paid_redline_pending_quote",
        [
            "generation", "submit",
            "--payload", json.dumps(pending_payload, ensure_ascii=False),
            "--client-idempotency-key", generation_key,
        ],
        expect_success=False,
        expect_error_codes=("GENERATION_QUOTE_UNCONFIRMED",),
    )
    runner.cli("queue_list", ["queue", "list"])
    generation_id: str | None = None
    generation_status = "estimate_only"
    if allow_paid_generation:
        runner.cli("generation_confirm", ["generation", "confirm", "--quote-id", quote_id])
        mismatched_payload = {**pending_payload, "supplement_prompt": "故意改变报价输入"}
        runner.cli(
            "paid_redline_mismatched_quote",
            [
                "generation", "submit",
                "--payload", json.dumps(mismatched_payload, ensure_ascii=False),
                "--client-idempotency-key", generation_key,
            ],
            expect_success=False,
            expect_error_codes=("GENERATION_QUOTE_CONFLICT",),
        )
        submitted = data_of(runner.cli(
            "generation_submit",
            [
                "generation", "submit",
                "--payload", json.dumps(pending_payload, ensure_ascii=False),
                "--client-idempotency-key", generation_key,
            ],
        ))
        generation_id = identifier(submitted, ("generation_request_id",))
        generation_detail = wait_for(
            runner,
            step_prefix="queue_status",
            command=["queue", "status", "--generation-id", generation_id],
            status_path=("status",),
            terminals=TERMINAL_GENERATION,
            timeout_seconds=int(os.getenv("CLI_E2E_GENERATION_TIMEOUT_SECONDS", "1800")),
            interval_seconds=float(os.getenv("CLI_E2E_POLL_INTERVAL_SECONDS", "3")),
        )
        generation_status = str(data_of(generation_detail).get("status"))
        if generation_status != "succeeded":
            raise E2eFailure(f"真实视频生成终态不是 succeeded：{generation_status}")

    delivery_episode_id, delivery_source = resolve_delivery_episode(runner, episode_id)
    manifest = data_of(runner.cli(
        "delivery_manifest",
        ["delivery", "manifest", "--episode-id", delivery_episode_id, "--partial"],
    ))
    if not isinstance(manifest.get("items"), list) or not isinstance(manifest.get("gaps"), list):
        raise E2eFailure("交付清单缺少 items/gaps")

    return {
        "project_id": project_id,
        "episode_id": episode_id,
        "scene_id": scene_id,
        "shot_id": shot_id,
        "searched_common_asset_id": common_asset_id,
        "registered_asset_id": registered_asset_id,
        "registered_media_id": registered_media_id,
        "generation_request_id": generation_id,
        "generation_status": generation_status,
        "paid_generation_executed": allow_paid_generation,
        "estimated_cost_fen": estimated_cost_fen,
        "delivery_episode_id": delivery_episode_id,
        "delivery_source": delivery_source,
        "delivery_linked_to_generation": delivery_episode_id == episode_id and generation_id is not None,
        "delivery_item_count": len(manifest["items"]),
        "delivery_gap_count": len(manifest["gaps"]),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-tag", default=os.getenv("CLI_E2E_RELEASE_TAG", ""))
    parser.add_argument("--env-file", type=Path, default=None)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--cli-bin", default="")
    parser.add_argument("--skip-install", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    load_env_file(args.env_file)
    os.environ.setdefault("SHORTDRAMA_ENV", os.getenv("CLI_E2E_TARGET_ENVIRONMENT", "test"))
    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    required = ("SHORTDRAMA_API_TOKEN",)
    missing = [key for key in required if not os.getenv(key)]
    started = datetime.now(UTC)
    env = dict(os.environ)
    result: dict[str, Any] = {
        "schema_version": "cli-product-e2e.v1",
        "generated_at": started.isoformat(),
        "target_environment": os.environ["SHORTDRAMA_ENV"],
        "base_url": None,
        "release_tag": args.release_tag or None,
        "ok": False,
        "steps": [],
        "chain": None,
        "paid_redlines": {
            "status": "deferred",
            "reason": "main-service PostgreSQL verification is outside the CLI-owned release gate",
        },
        "error": None,
        "artifacts": {
            "summary": str(args.summary.resolve()),
            "artifact_dir": str(args.artifact_dir.resolve()),
        },
    }
    runner = Runner(args.artifact_dir, env)
    try:
        if missing:
            raise E2eFailure(f"缺少 E2E 环境变量：{', '.join(missing)}")
        if args.skip_install:
            if not args.cli_bin:
                raise E2eFailure("--skip-install 必须同时提供 --cli-bin")
            runner.cli_bin = str(Path(args.cli_bin).resolve())
        else:
            if not args.release_tag:
                raise E2eFailure("Release 真安装必须提供 --release-tag")
            with tempfile.TemporaryDirectory(prefix="shortdrama-cli-release-e2e-") as directory:
                install_release(runner, args.release_tag, Path(directory))
                run_contract_suite(runner)
                chain = run_chain(
                    runner,
                    args.artifact_dir,
                    int(os.getenv("CLI_E2E_MAX_ESTIMATED_COST_FEN", "5000")),
                    False,
                )
                result["chain"] = chain
        if args.skip_install:
            run_contract_suite(runner)
            result["chain"] = run_chain(
                runner,
                args.artifact_dir,
                int(os.getenv("CLI_E2E_MAX_ESTIMATED_COST_FEN", "5000")),
                False,
            )
        result["ok"] = True
    except (E2eFailure, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        result["error"] = sanitize(error)
    finally:
        result["steps"] = [asdict(step) for step in runner.steps]
        result["finished_at"] = datetime.now(UTC).isoformat()
        args.summary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
