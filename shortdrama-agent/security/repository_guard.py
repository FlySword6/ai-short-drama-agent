#!/usr/bin/env python3
"""Fail-closed repository policy checks for the Agent monorepo.

The guard intentionally reports only rule identifiers, paths and line numbers.
It never prints matched source text because the match itself may be a secret.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import sys
import tomllib
from collections import Counter
from dataclasses import dataclass, replace
from datetime import date
from pathlib import Path, PurePosixPath
from typing import Iterable, Sequence


BASELINE_VERSION = 1
MAX_CURRENT_TEXT_BYTES = 2 * 1024 * 1024
MAX_HISTORY_BLOB_BYTES = 2 * 1024 * 1024
MAX_BASELINE_LIFETIME_DAYS = 90

# These findings represent a production boundary bypass or data-exposure risk.
# They must be remediated before a protected branch can be accepted; a legacy
# baseline is only for time-bounded supply-chain migration debt, never for a
# path that could invoke cloud resources or expose an Agent entry point.
PRODUCTION_BLOCKING_RULES = frozenset(
    {
        "AGENT_CLOUD_CREDENTIAL",
        "AGENT_DIRECT_ARK",
        "AGENT_DIRECT_TOS",
        "AGENT_DYNAMIC_AUTH_ENDPOINT",
        "AGENT_AUTO_APPROVAL",
        "AGENT_ARBITRARY_HUB",
        "PRODUCTION_A2A_SURFACE",
        "TEST_HARNESS_DEPLOYABLE",
        "TEST_HARNESS_OPEN_CORS",
        "TEST_HARNESS_DEBUG_ROUTE",
        "TEST_HARNESS_PUBLIC_BIND",
        "SAST_SHELL_TRUE",
        "SAST_UNSAFE_DESERIALIZATION",
        "SAST_DYNAMIC_EXECUTION",
        "SAST_SENSITIVE_LOG",
        "SAST_VARIABLE_URL_REQUEST",
    }
)

# These findings must never be hidden by the legacy baseline.
NON_BASELINABLE_RULES = frozenset(
    {
        "SECRET_KNOWN_PREFIX",
        "SECRET_LITERAL_ASSIGNMENT",
        "SECRET_PRIVATE_KEY",
        "SECRET_LITERAL_BEARER",
        "TRACKED_RUNTIME_CONFIG",
        "TRACKED_PRIVATE_KEY",
        "DEPENDENCY_REMOTE_SOURCE",
        "WORKFLOW_PULL_REQUEST_TARGET",
        "WORKFLOW_UNPINNED_ACTION",
        "WORKFLOW_SECRET_ON_PR",
        "WORKFLOW_MISSING_PERMISSIONS",
        "WORKFLOW_WRITE_PERMISSION",
        "WORKFLOW_CHECKOUT_PERSISTS_CREDENTIALS",
        "UNSCANNABLE_CURRENT_FILE",
        "UNSCANNABLE_HISTORY_BLOB",
        "BASELINE_GROWTH",
    }
) | PRODUCTION_BLOCKING_RULES
HISTORY_CONTENT_RULES = frozenset(
    {
        "SECRET_KNOWN_PREFIX",
        "SECRET_LITERAL_ASSIGNMENT",
        "SECRET_PRIVATE_KEY",
        "SECRET_LITERAL_BEARER",
    }
)

TEXT_SUFFIXES = {
    ".cfg",
    ".conf",
    ".env",
    ".ini",
    ".json",
    ".key",
    ".md",
    ".p12",
    ".pem",
    ".pfx",
    ".py",
    ".sh",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}

SECRET_NAMES = (
    "VOLCENGINE_ACCESS_KEY",
    "VOLCENGINE_SECRET_KEY",
    "ARK_API_KEY",
    "MODEL_API_KEY",
    "TOOL_MCP_ROUTER_API_KEY",
    "RUNTIME_APIKEY",
    "RUNTIME_API_KEY",
    "runtime_apikey",
    "runtime_api_key",
    "ACCESS_TOKEN",
    "REFRESH_TOKEN",
    "CLIENT_SECRET",
)
SECRET_NAME_PATTERN = "|".join(re.escape(name) for name in SECRET_NAMES)
QUOTED_SECRET_ASSIGNMENT = re.compile(
    rf"""(?imx)
    ^\s*(?:export\s+)?["']?(?:{SECRET_NAME_PATTERN})["']?\s*[:=]\s*
    (?P<quote>["'])(?P<value>[^"']+)(?P=quote)
    """
)
UNQUOTED_SECRET_ASSIGNMENT = re.compile(
    rf"""(?imx)
    ^\s*(?:export\s+)?["']?(?:{SECRET_NAME_PATTERN})["']?\s*[:=]\s*
    (?P<value>(?!["'])[^\s#,]+)
    """
)
KNOWN_ACCESS_KEY = re.compile(r"\bAKLT[A-Za-z0-9_-]{12,}\b")
PRIVATE_KEY_HEADER = re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")
LITERAL_BEARER = re.compile(
    r"(?i)\bBearer\s+(?!\{|\$|<|example|placeholder|test|fake)[A-Za-z0-9._~+/-]{20,}={0,2}\b"
)

WORKFLOW_USES = re.compile(
    r"""(?imx)
    (?:
        ^[ \t]*(?:-\s*)?["']?uses["']?\s*:
        |
        [{,]\s*["']?uses["']?\s*:
    )
    [ \t]*
    (?P<value>
        "[^"\r\n]+"
        |
        '[^'\r\n]+'
        |
        [^,\s}#]+
    )
    """
)
PINNED_ACTION = re.compile(r"^[^@\s]+@[0-9a-fA-F]{40}$")
DEPENDENCY_NAME = re.compile(r"^[A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_,.-]+\])?")
WORKFLOW_PERMISSION_SCOPES = (
    "actions",
    "attestations",
    "checks",
    "contents",
    "deployments",
    "discussions",
    "id-token",
    "issues",
    "models",
    "packages",
    "pages",
    "pull-requests",
    "repository-projects",
    "security-events",
    "statuses",
)


RULE_MESSAGES = {
    "SECRET_KNOWN_PREFIX": "疑似云访问密钥出现在受跟踪内容中",
    "SECRET_LITERAL_ASSIGNMENT": "敏感配置名被赋予了非占位字面量",
    "SECRET_PRIVATE_KEY": "私钥内容出现在受跟踪文件中",
    "SECRET_LITERAL_BEARER": "Bearer 凭据字面量出现在受跟踪内容中",
    "TRACKED_RUNTIME_CONFIG": "真实运行时配置文件不得由 Git 跟踪；请提交 example 模板",
    "TRACKED_PRIVATE_KEY": "私钥或凭据文件不得由 Git 跟踪",
    "AGENT_CLOUD_CREDENTIAL": "Agent 生产代码不得读取或注入云凭据/Ark endpoint",
    "AGENT_DIRECT_ARK": "Agent 生产代码不得直连 Ark",
    "AGENT_DIRECT_TOS": "Agent/test harness 不得直接创建 TOS 客户端",
    "AGENT_DYNAMIC_AUTH_ENDPOINT": "Authorization 不得发送到运行时可变 URL",
    "AGENT_AUTO_APPROVAL": "生成流程不得使用自动批准或 reviewer 布尔值授权云调用",
    "AGENT_ARBITRARY_HUB": "生产入口不得接受调用方指定的 Hub host/port",
    "PRODUCTION_A2A_SURFACE": "旧 A2A 直连表面必须迁移到认证后的平台后端",
    "TEST_HARNESS_DEPLOYABLE": "test-agent 的可部署入口必须与生产构建隔离",
    "TEST_HARNESS_OPEN_CORS": "test-agent 不得以通配 CORS 暴露服务",
    "TEST_HARNESS_DEBUG_ROUTE": "test-agent 调试路由不得进入生产表面",
    "TEST_HARNESS_PUBLIC_BIND": "test-agent 不得默认监听所有网络接口",
    "SAST_SHELL_TRUE": "禁止 shell=True",
    "SAST_UNSAFE_DESERIALIZATION": "禁止不安全反序列化",
    "SAST_DYNAMIC_EXECUTION": "禁止 eval/exec 动态执行",
    "SAST_SENSITIVE_LOG": "日志调用疑似包含 Prompt、响应或凭据",
    "SAST_VARIABLE_URL_REQUEST": "网络请求使用了未经静态约束的 URL",
    "DEPENDENCY_UNPINNED": "生产依赖应使用可复现的精确版本或受审锁文件",
    "DEPENDENCY_REMOTE_SOURCE": "依赖不得直接来自 URL、VCS 或本地路径",
    "DEPENDENCY_MISSING_LOCK": "含生产依赖的子项目缺少受跟踪锁文件",
    "DOCKER_BASE_UNPINNED": "生产基础镜像必须固定 digest",
    "WORKFLOW_PULL_REQUEST_TARGET": "禁止 pull_request_target 安全边界混淆",
    "WORKFLOW_UNPINNED_ACTION": "外部 GitHub Action 必须固定 40 位 commit SHA",
    "WORKFLOW_SECRET_ON_PR": "PR 工作流不得读取 GitHub Secret",
    "WORKFLOW_MISSING_PERMISSIONS": "工作流必须显式设置最小 permissions",
    "WORKFLOW_WRITE_PERMISSION": "安全门禁工作流禁止申请 write 权限",
    "WORKFLOW_CHECKOUT_PERSISTS_CREDENTIALS": "checkout 必须设置 persist-credentials: false",
    "UNSCANNABLE_CURRENT_FILE": "受跟踪文本无法安全扫描，必须转为 UTF-8 且不超过大小上限",
    "UNSCANNABLE_HISTORY_BLOB": "Git 历史文本无法安全扫描，禁止以编码或体积绕过秘密检查",
    "BASELINE_STALE": "遗留风险已经消失或发生变化，请从 baseline 删除对应条目",
    "BASELINE_INVALID": "baseline 格式无效或包含不可豁免规则",
    "BASELINE_GROWTH": "PR baseline 只能缩小，不得新增或替换豁免条目",
    "HISTORY_SECRET": "Git 历史中仍存在疑似凭据",
}


@dataclass(frozen=True)
class Finding:
    rule_id: str
    path: str
    line: int
    fingerprint: str
    message: str
    severity: str = "error"
    source: str = "current"

    @property
    def baselinable(self) -> bool:
        return self.rule_id not in NON_BASELINABLE_RULES


def _normalise_path(path: str | Path) -> str:
    normalised = PurePosixPath(path).as_posix()
    return normalised[2:] if normalised.startswith("./") else normalised


def _normalise_evidence(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


def _content_digest(text: str) -> str:
    canonical = text.replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _fingerprint(rule_id: str, path: str, evidence: str) -> str:
    material = "\0".join((rule_id, path, _normalise_evidence(evidence)))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:24]


def _finding(
    rule_id: str,
    path: str,
    line: int,
    evidence: str,
    *,
    source: str = "current",
) -> Finding:
    path = _normalise_path(path)
    return Finding(
        rule_id=rule_id,
        path=path,
        line=max(1, line),
        fingerprint=_fingerprint(rule_id, path, evidence),
        message=RULE_MESSAGES[rule_id],
        source=source,
    )


def _is_placeholder(value: str) -> bool:
    candidate = value.strip().strip("\"'").lower()
    if not candidate:
        return True
    if re.fullmatch(r"\$[a-z_][a-z0-9_]*", candidate):
        return True
    if re.fullmatch(r"\$\{[a-z_][a-z0-9_]*\}", candidate):
        return True
    if re.fullmatch(
        r"\$\{\{\s*(?:secrets|env|vars)\.[a-z_][a-z0-9_]*\s*\}\}",
        candidate,
    ):
        return True
    if re.fullmatch(r"\{\{\s*[a-z_][a-z0-9_.-]*\s*\}\}", candidate):
        return True
    if re.fullmatch(r"<[a-z0-9][a-z0-9_.:-]*>", candidate):
        return True
    normalised = candidate.replace("_", "-")
    return normalised in {
        "change-me",
        "changeme",
        "disabled",
        "example",
        "example-key",
        "none",
        "null",
        "placeholder",
        "replace-me",
        "xxx",
    }


def _entropy(value: str) -> float:
    if not value:
        return 0.0
    counts = Counter(value)
    length = len(value)
    return -sum((count / length) * math.log2(count / length) for count in counts.values())


def _looks_like_literal_secret(value: str) -> bool:
    value = value.strip().strip("\"'")
    if _is_placeholder(value):
        return False
    # Reject obvious code expressions while still catching YAML/env scalars.
    if value.startswith(("os.", "env.", "settings.", "getenv(", "secret_store.")):
        return False
    return len(value) >= 12 and (_entropy(value) >= 3.0 or len(value) >= 24)


def _line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _source_line(text: str, offset: int) -> str:
    start = text.rfind("\n", 0, offset) + 1
    end = text.find("\n", offset)
    if end == -1:
        end = len(text)
    return text[start:end]


def _is_text_candidate(path: str) -> bool:
    pure = PurePosixPath(path)
    return (
        pure.suffix.lower() in TEXT_SUFFIXES
        or pure.name in {"Dockerfile", "Makefile", "makefile"}
        or pure.name.startswith(".env")
        or pure.name.lower() in {"id_rsa", "id_ed25519", ".agent-token"}
    )


def _is_test_path(path: str) -> bool:
    parts = PurePosixPath(path).parts
    return "tests" in parts


def _is_production_python(path: str) -> bool:
    pure = PurePosixPath(path)
    if pure.suffix != ".py" or _is_test_path(path):
        return False
    first = pure.parts[0] if pure.parts else ""
    return (
        first == "production-chain-agent"
        or first == "sd-orchestrator"
        or first == "test-agent"
        or (first.startswith("sd-") and first.endswith("-agent"))
    )


def _dedupe(findings: Iterable[Finding]) -> list[Finding]:
    result: list[Finding] = []
    occurrences: Counter[tuple[str, str, str, str]] = Counter()
    for finding in sorted(
        findings,
        key=lambda item: (
            item.path,
            item.line,
            item.rule_id,
            item.fingerprint,
            item.source,
        ),
    ):
        key = (
            finding.rule_id,
            finding.path,
            finding.fingerprint,
            finding.source,
        )
        occurrences[key] += 1
        occurrence = occurrences[key]
        if occurrence > 1:
            finding = replace(
                finding,
                fingerprint=_fingerprint(
                    finding.rule_id,
                    finding.path,
                    f"duplicate:{finding.fingerprint}:{occurrence}",
                ),
            )
        result.append(finding)
    return sorted(
        result,
        key=lambda item: (item.path, item.line, item.rule_id, item.source),
    )


def scan_secrets(path: str, text: str, *, source: str = "current") -> list[Finding]:
    findings: list[Finding] = []
    pure = PurePosixPath(path)
    name = pure.name.lower()

    if name == "agentkit.yaml" or (
        name.startswith(".env") and name not in {".env.example", ".env.template"}
    ):
        findings.append(
            _finding("TRACKED_RUNTIME_CONFIG", path, 1, f"tracked:{name}", source=source)
        )
    if pure.suffix.lower() in {".key", ".p12", ".pfx", ".pem"} or name in {
        ".agent-token",
        "id_rsa",
        "id_ed25519",
    }:
        findings.append(
            _finding("TRACKED_PRIVATE_KEY", path, 1, f"tracked:{name}", source=source)
        )

    for match in KNOWN_ACCESS_KEY.finditer(text):
        findings.append(
            _finding(
                "SECRET_KNOWN_PREFIX",
                path,
                _line_number(text, match.start()),
                match.group(0),
                source=source,
            )
        )
    for match in PRIVATE_KEY_HEADER.finditer(text):
        findings.append(
            _finding(
                "SECRET_PRIVATE_KEY",
                path,
                _line_number(text, match.start()),
                match.group(0),
                source=source,
            )
        )
    for match in LITERAL_BEARER.finditer(text):
        findings.append(
            _finding(
                "SECRET_LITERAL_BEARER",
                path,
                _line_number(text, match.start()),
                match.group(0),
                source=source,
            )
        )
    for pattern in (QUOTED_SECRET_ASSIGNMENT, UNQUOTED_SECRET_ASSIGNMENT):
        for match in pattern.finditer(text):
            value = match.group("value")
            if (
                pattern is UNQUOTED_SECRET_ASSIGNMENT
                and PurePosixPath(path).suffix == ".py"
                and (
                    any(
                        character in value
                        for character in ("(", ")", "{", "}", "[", "]")
                    )
                    or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", value)
                )
            ):
                continue
            if _looks_like_literal_secret(value):
                findings.append(
                    _finding(
                        "SECRET_LITERAL_ASSIGNMENT",
                        path,
                        _line_number(text, match.start()),
                        match.group(0),
                        source=source,
                    )
                )
    return _dedupe(findings)


def _scan_production_code(path: str, text: str) -> list[Finding]:
    if not _is_production_python(path):
        return []
    findings: list[Finding] = []
    line_rules = (
        (
            "AGENT_CLOUD_CREDENTIAL",
            re.compile(
                r"""(?x)
                os\.(?:getenv|environ\.get)\(\s*["']
                (?:ARK_BASE_URL|ARK_API_KEY|MODEL_API_KEY|
                VOLCENGINE_ACCESS_KEY|VOLCENGINE_SECRET_KEY)["']
                |model_api_key\s*=
                """
            ),
        ),
        (
            "AGENT_DIRECT_ARK",
            re.compile(
                r"(?i)ark\.[A-Za-z0-9.-]*volces\.com|/chat/completions|ArkRuntime|ArkClient"
            ),
        ),
        (
            "AGENT_DIRECT_TOS",
            re.compile(r"(?m)^\s*(?:import|from)\s+tos\b|tos\.TosClient"),
        ),
        (
            "AGENT_AUTO_APPROVAL",
            re.compile(r"(?i)\bauto_approve\w*\b|\.approve\(\s*reviewer"),
        ),
        (
            "AGENT_ARBITRARY_HUB",
            re.compile(r"\bhub_(?:host|port)\b"),
        ),
        ("SAST_SHELL_TRUE", re.compile(r"\bshell\s*=\s*True\b")),
        (
            "SAST_UNSAFE_DESERIALIZATION",
            re.compile(r"\bpickle\.loads?\s*\(|\byaml\.load\s*\([^)]*(?!Loader=)"),
        ),
        (
            "SAST_DYNAMIC_EXECUTION",
            re.compile(r"(?<![\w.])(?:eval|exec)\s*\("),
        ),
        (
            "SAST_SENSITIVE_LOG",
            re.compile(
                r"(?i)\blogger\.(?:debug|info|warning|error|exception)\s*\("
                r"[^\n]*(?:prompt|response|token|secret|api[_ -]?key)"
            ),
        ),
        (
            "SAST_VARIABLE_URL_REQUEST",
            re.compile(
                r"(?:requests|httpx)\.(?:request|get|post|put|patch|delete)\s*\("
                r"\s*(?:method\s*,\s*)?(?:f?[\"']\{|[A-Za-z_][\w.]*\s*[,)]|f[\"'])"
            ),
        ),
    )
    for rule_id, pattern in line_rules:
        for match in pattern.finditer(text):
            findings.append(
                _finding(
                    rule_id,
                    path,
                    _line_number(text, match.start()),
                    _source_line(text, match.start()),
                )
            )

    if re.search(r"[\"']Authorization[\"']\s*:", text) and re.search(
        r"(?:requests|httpx)\.(?:request|get|post|put|patch|delete)\s*\("
        r"[^\n]*(?:self\._?\w*url|base_url|endpoint|url)",
        text,
    ):
        findings.append(
            _finding(
                "AGENT_DYNAMIC_AUTH_ENDPOINT",
                path,
                1,
                "file-has-authorization-and-dynamic-request-url",
            )
        )
    return findings


def _scan_a2a_and_test_surface(path: str, text: str) -> list[Finding]:
    findings: list[Finding] = []
    pure = PurePosixPath(path)
    content_digest = _content_digest(text)
    if (
        len(pure.parts) >= 2
        and pure.parts[0] == "production-chain-agent"
        and pure.parts[1] == "sda2a"
        and pure.suffix == ".py"
        and not _is_test_path(path)
    ):
        findings.append(
            _finding(
                "PRODUCTION_A2A_SURFACE",
                path,
                1,
                f"legacy-a2a:{path}:content-sha256:{content_digest}",
            )
        )

    # Test fixtures need to exercise unsafe strings such as ``0.0.0.0`` and
    # wildcard CORS.  They are not executable harness entry points.  Keep the
    # test-agent surface rules for source files, but do not turn an explicit
    # ``tests/`` directory into a new production finding.
    if pure.parts and pure.parts[0] == "test-agent" and not _is_test_path(path):
        deployable_names = {
            "Dockerfile",
            "agent.py",
            "agent_a2a.py",
            "agentkit.yaml",
            "agenkit-cloud.sh",
        }
        if pure.name in deployable_names:
            findings.append(
                _finding(
                    "TEST_HARNESS_DEPLOYABLE",
                    path,
                    1,
                    (
                        f"test-deployable:{pure.name}:"
                        f"content-sha256:{content_digest}"
                    ),
                )
            )
        for rule_id, pattern in (
            (
                "TEST_HARNESS_OPEN_CORS",
                re.compile(r"allow_origins\s*=\s*\[\s*[\"']\*[\"']\s*\]"),
            ),
            (
                "TEST_HARNESS_DEBUG_ROUTE",
                re.compile(r"[\"']/debug(?:/|[\"'])"),
            ),
            (
                "TEST_HARNESS_PUBLIC_BIND",
                re.compile(r"[\"']0\.0\.0\.0[\"']"),
            ),
        ):
            for match in pattern.finditer(text):
                findings.append(
                    _finding(
                        rule_id,
                        path,
                        _line_number(text, match.start()),
                        _source_line(text, match.start()),
                    )
                )
    return findings


def _dependency_is_exact(spec: str) -> bool:
    spec = spec.strip()
    if not spec or spec.startswith(("#", "-r ", "--requirement ")):
        return True
    if any(token in spec for token in (" @ ", "git+", "http://", "https://", "../", "./")):
        return False
    match = DEPENDENCY_NAME.match(spec)
    if not match:
        return True
    remainder = spec[match.end() :]
    remainder = remainder.split(";", 1)[0].strip()
    return bool(re.fullmatch(r"==[^,;\s]+", remainder))


_SHA_PINNED_VCS = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*\s*@\s*git\+https://[^\s@]+@[0-9a-f]{40,64}$"
)


def _is_sha_pinned_vcs(spec: str) -> bool:
    return _SHA_PINNED_VCS.match(spec.strip()) is not None


def _scan_dependency_file(path: str, text: str) -> list[Finding]:
    pure = PurePosixPath(path)
    findings: list[Finding] = []
    if pure.name == "requirements.txt":
        for line_number, raw_line in enumerate(text.splitlines(), 1):
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if any(
                token in line
                for token in (" @ ", "git+", "http://", "https://", "../", "./")
            ):
                findings.append(
                    _finding("DEPENDENCY_REMOTE_SOURCE", path, line_number, line)
                )
            elif not _dependency_is_exact(line):
                findings.append(
                    _finding("DEPENDENCY_UNPINNED", path, line_number, line)
                )
    elif pure.name == "pyproject.toml":
        try:
            data = tomllib.loads(text)
        except tomllib.TOMLDecodeError:
            return findings
        dependencies = data.get("project", {}).get("dependencies", [])
        if isinstance(dependencies, list):
            for dependency in dependencies:
                if not isinstance(dependency, str):
                    continue
                if _is_sha_pinned_vcs(dependency):
                    # Cross-repo dependencies pinned to a full commit SHA are
                    # reproducible; they are inventoried by dependency_audit
                    # and audited by the pinned-SHA model instead of a registry.
                    continue
                if any(
                    token in dependency
                    for token in (" @ ", "git+", "http://", "https://", "../", "./")
                ):
                    findings.append(
                        _finding(
                            "DEPENDENCY_REMOTE_SOURCE",
                            path,
                            1,
                            dependency,
                        )
                    )
                elif not _dependency_is_exact(dependency):
                    findings.append(
                        _finding("DEPENDENCY_UNPINNED", path, 1, dependency)
                    )
    return findings


def _scan_dockerfile(path: str, text: str) -> list[Finding]:
    if PurePosixPath(path).name != "Dockerfile":
        return []
    findings: list[Finding] = []
    stage_names: set[str] = set()
    for line_number, line in enumerate(text.splitlines(), 1):
        match = re.match(
            r"^\s*FROM\s+(?:--platform=\S+\s+)?(?P<image>\S+)(?P<rest>.*)$",
            line,
            re.IGNORECASE,
        )
        if match is None:
            continue
        image = match.group("image")
        image_is_immutable = (
            image.lower() == "scratch"
            or image.lower() in stage_names
            or bool(
                re.fullmatch(
                    r".+@sha256:[0-9a-f]{64}",
                    image,
                    re.IGNORECASE,
                )
            )
        )
        if not image_is_immutable:
            findings.append(
                _finding("DOCKER_BASE_UNPINNED", path, line_number, line)
            )
        alias = re.match(
            r"^\s+AS\s+(?P<name>[A-Za-z0-9_.-]+)(?:\s*(?:#.*)?)?$",
            match.group("rest"),
            re.IGNORECASE,
        )
        if alias is not None:
            stage_names.add(alias.group("name").lower())
    return findings


def _workflow_has_event(text: str, event: str) -> bool:
    escaped = re.escape(event)
    if re.search(
        rf"(?im)^\s*[\"']?{escaped}[\"']?\s*:",
        text,
    ):
        return True
    for line in text.splitlines():
        match = re.match(
            r"^[ \t]*[\"']?on[\"']?\s*:\s*(?P<value>.*?)\s*(?:#.*)?$",
            line,
            re.IGNORECASE,
        )
        if match is not None and re.search(
            rf"(?i)(?<![A-Za-z0-9_-]){escaped}(?![A-Za-z0-9_-])",
            match.group("value"),
        ):
            return True
    return False


def _flow_persist_values(text: str) -> list[str]:
    return [
        match.group("value").strip().strip("\"'").lower()
        for match in re.finditer(
            r"""(?ix)
            ["']?persist-credentials["']?\s*:\s*
            (?P<value>"[^"]*"|'[^']*'|[^,\s}]+)
            """,
            text,
        )
    ]


def _checkout_disables_persisted_credentials(
    text: str,
    action_match: re.Match[str],
) -> bool:
    lines = text.splitlines()
    line_index = text.count("\n", 0, action_match.start())
    if line_index >= len(lines):
        return False
    action_line = lines[line_index]

    flow_with = re.search(
        r"""(?ix)
        ["']?with["']?\s*:\s*
        \{(?P<body>[^{}]*)\}
        """,
        action_line,
    )
    if flow_with is not None:
        return _flow_persist_values(flow_with.group("body")) == ["false"]

    action_indent = len(action_line) - len(action_line.lstrip(" \t"))
    step_start: int | None = None
    step_indent = -1
    for index in range(line_index, -1, -1):
        step_match = re.match(r"^(?P<indent>[ \t]*)-\s+", lines[index])
        if step_match is None:
            continue
        candidate_indent = len(step_match.group("indent"))
        if candidate_indent <= action_indent:
            step_start = index
            step_indent = candidate_indent
            break
    if step_start is None:
        return False

    step_end = len(lines)
    for index in range(step_start + 1, len(lines)):
        step_match = re.match(r"^(?P<indent>[ \t]*)-\s+", lines[index])
        if step_match is not None and len(step_match.group("indent")) == step_indent:
            step_end = index
            break

    for index in range(step_start, step_end):
        with_match = re.match(
            r"""(?ix)
            ^(?P<indent>[ \t]*)["']?with["']?\s*:\s*
            (?P<value>.*)$
            """,
            lines[index],
        )
        if with_match is None or len(with_match.group("indent")) <= step_indent:
            continue
        inline_value = with_match.group("value").strip()
        if inline_value:
            flow_match = re.fullmatch(r"\{(?P<body>[^{}]*)\}\s*(?:#.*)?", inline_value)
            if flow_match is None:
                return False
            return _flow_persist_values(flow_match.group("body")) == ["false"]

        with_indent = len(with_match.group("indent"))
        values: list[str] = []
        for child_index in range(index + 1, step_end):
            child = lines[child_index]
            if not child.strip() or child.lstrip().startswith("#"):
                continue
            child_indent = len(child) - len(child.lstrip(" \t"))
            if child_indent <= with_indent:
                break
            persist_match = re.match(
                r"""(?ix)
                ^[ \t]*["']?persist-credentials["']?\s*:\s*
                (?P<value>"[^"]*"|'[^']*'|[^\s#]+)
                \s*(?:\#.*)?$
                """,
                child,
            )
            if persist_match is not None:
                values.append(
                    persist_match.group("value").strip().strip("\"'").lower()
                )
        return values == ["false"]
    return False


def _scan_workflow(path: str, text: str) -> list[Finding]:
    pure = PurePosixPath(path)
    if len(pure.parts) < 3 or pure.parts[:2] != (".github", "workflows"):
        return []
    if pure.suffix.lower() not in {".yml", ".yaml"}:
        return []
    findings: list[Finding] = []
    if _workflow_has_event(text, "pull_request_target"):
        event_match = re.search(r"(?i)pull_request_target", text)
        assert event_match is not None
        findings.append(
            _finding(
                "WORKFLOW_PULL_REQUEST_TARGET",
                path,
                _line_number(text, event_match.start()),
                "pull_request_target",
            )
        )
    action_matches: list[tuple[str, re.Match[str]]] = []
    for match in WORKFLOW_USES.finditer(text):
        action_ref = match.group("value").strip("\"'")
        action_matches.append((action_ref, match))
        if not PINNED_ACTION.fullmatch(action_ref):
            findings.append(
                _finding(
                    "WORKFLOW_UNPINNED_ACTION",
                    path,
                    _line_number(text, match.start()),
                    action_ref,
                )
            )
    if not re.search(
        r"""(?imx)
        ^["']?permissions["']?\s*:\s*
        (?:
            \{[^{}\r\n]*\}
            |
            (?:\#.*)?$
        )
        """,
        text,
    ):
        findings.append(
            _finding(
                "WORKFLOW_MISSING_PERMISSIONS",
                path,
                1,
                "missing-top-level-permissions",
            )
        )
    permission_scopes = "|".join(re.escape(scope) for scope in WORKFLOW_PERMISSION_SCOPES)
    write_permission = re.search(
        rf"""(?imx)
        (?:
            ^[ \t]*["']?permissions["']?\s*:\s*["']?write-all["']?
            |
            (?:^|[{{,])[ \t]*["']?(?:{permission_scopes})["']?
            \s*:\s*["']?write["']?
        )
        (?=\s*(?:[,}}\#]|$))
        """,
        text,
    )
    if write_permission is not None:
        findings.append(
            _finding(
                "WORKFLOW_WRITE_PERMISSION",
                path,
                _line_number(text, write_permission.start()),
                _source_line(text, write_permission.start()),
            )
        )
    if _workflow_has_event(text, "pull_request") and re.search(
        r"\bsecrets\s*(?:\.|\[)",
        text,
        re.IGNORECASE,
    ):
        match = re.search(
            r"\bsecrets\s*(?:\.|\[)",
            text,
            re.IGNORECASE,
        )
        assert match is not None
        findings.append(
            _finding(
                "WORKFLOW_SECRET_ON_PR",
                path,
                _line_number(text, match.start()),
                "secret-context-on-pull-request",
            )
        )
    for action_ref, action_match in action_matches:
        if action_ref.startswith(
            "actions/checkout@"
        ) and not _checkout_disables_persisted_credentials(text, action_match):
            findings.append(
                _finding(
                    "WORKFLOW_CHECKOUT_PERSISTS_CREDENTIALS",
                    path,
                    _line_number(text, action_match.start()),
                    f"unsafe-checkout:{action_ref}",
                )
            )
    return findings


def scan_file(path: str, text: str) -> list[Finding]:
    findings: list[Finding] = []
    findings.extend(scan_secrets(path, text))
    findings.extend(_scan_production_code(path, text))
    findings.extend(_scan_a2a_and_test_surface(path, text))
    findings.extend(_scan_dependency_file(path, text))
    findings.extend(_scan_dockerfile(path, text))
    findings.extend(_scan_workflow(path, text))
    return _dedupe(findings)


def _git(root: Path, *args: str, text: bool = False) -> str | bytes:
    completed = subprocess.run(
        ["git", *args],
        cwd=root,
        check=True,
        capture_output=True,
        text=text,
        encoding="utf-8" if text else None,
        errors="replace" if text else None,
    )
    return completed.stdout


def tracked_paths(root: Path) -> list[str]:
    output = _git(root, "ls-files", "-z")
    assert isinstance(output, bytes)
    return sorted(
        _normalise_path(item.decode("utf-8", errors="surrogateescape"))
        for item in output.split(b"\0")
        if item
    )


def changed_paths(root: Path, base_sha: str) -> list[str]:
    """Paths changed between merge-base(base_sha, HEAD) and the worktree."""
    base = _git(root, "merge-base", base_sha, "HEAD", text=True).strip()
    if not base:
        raise subprocess.CalledProcessError(1, ["git", "merge-base"])
    output = _git(
        root,
        "diff",
        "--name-only",
        "--diff-filter=ACMR",
        "-z",
        base,
        "--",
    )
    assert isinstance(output, bytes)
    return sorted(
        _normalise_path(item.decode("utf-8", errors="surrogateescape"))
        for item in output.split(b"\0")
        if item
    )


def _read_current_text(root: Path, path: str) -> tuple[str | None, str | None]:
    candidate = root / path
    try:
        raw = candidate.read_bytes()
    except OSError:
        return None, "read-error"
    if len(raw) > MAX_CURRENT_TEXT_BYTES:
        return None, "oversize"
    if b"\0" in raw:
        return None, "nul-byte"
    try:
        return raw.decode("utf-8"), None
    except UnicodeDecodeError:
        return None, "non-utf8"


def scan_current(
    root: Path,
    *,
    paths: Sequence[str] | None = None,
    manifest_paths: Sequence[str] | None = None,
) -> list[Finding]:
    paths = list(paths) if paths is not None else tracked_paths(root)
    # Derived checks (missing-lock) must see the full tracked manifest set even
    # when only changed files are scanned; otherwise editing a pyproject.toml
    # without touching its existing uv.lock would be misreported.
    manifest = (
        list(manifest_paths) if manifest_paths is not None else list(paths)
    )
    findings: list[Finding] = []
    pyproject_dirs: set[str] = set()
    lock_dirs: set[str] = set()

    for path in manifest:
        pure = PurePosixPath(_normalise_path(path))
        if pure.name == "pyproject.toml":
            pyproject_dirs.add(str(pure.parent))
        if pure.name in {"uv.lock", "poetry.lock", "Pipfile.lock"}:
            lock_dirs.add(str(pure.parent))

    for path in paths:
        path = _normalise_path(path)
        if not _is_text_candidate(path):
            continue
        text, read_error = _read_current_text(root, path)
        if text is None:
            findings.extend(scan_secrets(path, ""))
            findings.append(
                _finding(
                    "UNSCANNABLE_CURRENT_FILE",
                    path,
                    1,
                    read_error or "unknown-read-error",
                )
            )
            continue
        findings.extend(scan_file(path, text))

    for directory in sorted(pyproject_dirs - lock_dirs):
        path = _normalise_path(PurePosixPath(directory) / "pyproject.toml")
        findings.append(
            _finding(
                "DEPENDENCY_MISSING_LOCK",
                path,
                1,
                f"missing-lock:{directory}",
            )
        )
    return _dedupe(findings)


def scan_history_secrets(
    root: Path,
    revision: str = "--all",
) -> list[Finding]:
    objects_output = _git(root, "rev-list", "--objects", revision, text=True)
    assert isinstance(objects_output, str)

    paths_by_object: dict[str, set[str]] = {}
    for line in objects_output.splitlines():
        object_id, separator, raw_path = line.partition(" ")
        if not separator or not object_id or not raw_path:
            continue
        path = _normalise_path(raw_path)
        if _is_text_candidate(path):
            paths_by_object.setdefault(object_id, set()).add(path)

    if not paths_by_object:
        return []

    object_ids = list(paths_by_object)
    request = "".join(f"{object_id}\n" for object_id in object_ids).encode("ascii")
    checked = subprocess.run(
        ["git", "cat-file", "--batch-check"],
        cwd=root,
        input=request,
        check=True,
        capture_output=True,
    ).stdout

    findings: list[Finding] = []
    eligible: list[str] = []
    for expected_id, raw_line in zip(object_ids, checked.splitlines(), strict=True):
        parts = raw_line.split()
        if (
            len(parts) != 3
            or parts[0].decode("ascii", errors="ignore") != expected_id
            or parts[1] != b"blob"
        ):
            raise subprocess.CalledProcessError(
                1,
                ["git", "cat-file", "--batch-check"],
            )
        try:
            size = int(parts[2])
        except ValueError as error:
            raise subprocess.CalledProcessError(
                1,
                ["git", "cat-file", "--batch-check"],
            ) from error
        if size < 0:
            raise subprocess.CalledProcessError(
                1,
                ["git", "cat-file", "--batch-check"],
            )
        if size > MAX_HISTORY_BLOB_BYTES:
            for path in sorted(paths_by_object[expected_id]):
                findings.append(
                    _finding(
                        "UNSCANNABLE_HISTORY_BLOB",
                        path,
                        1,
                        f"oversize:{expected_id}",
                        source=f"history-object:{expected_id[:12]}",
                    )
                )
        else:
            eligible.append(expected_id)

    if not eligible:
        return _dedupe(findings)

    payload = subprocess.run(
        ["git", "cat-file", "--batch"],
        cwd=root,
        input="".join(f"{object_id}\n" for object_id in eligible).encode("ascii"),
        check=True,
        capture_output=True,
    ).stdout

    blobs: dict[str, bytes] = {}
    offset = 0
    for expected_id in eligible:
        header_end = payload.find(b"\n", offset)
        if header_end < 0:
            raise subprocess.CalledProcessError(1, ["git", "cat-file", "--batch"])
        header = payload[offset:header_end].split()
        offset = header_end + 1
        if len(header) != 3 or header[1] != b"blob":
            raise subprocess.CalledProcessError(1, ["git", "cat-file", "--batch"])
        object_id = header[0].decode("ascii", errors="ignore")
        try:
            size = int(header[2])
        except ValueError as error:
            raise subprocess.CalledProcessError(
                1,
                ["git", "cat-file", "--batch"],
            ) from error
        end = offset + size
        if object_id != expected_id or end > len(payload):
            raise subprocess.CalledProcessError(1, ["git", "cat-file", "--batch"])
        blobs[object_id] = payload[offset:end]
        offset = end
        if payload[offset : offset + 1] != b"\n":
            raise subprocess.CalledProcessError(1, ["git", "cat-file", "--batch"])
        offset += 1

    seen_locations: set[tuple[str, str, int]] = set()
    for object_id in eligible:
        blob = blobs[object_id]
        if b"\0" in blob:
            for path in sorted(paths_by_object[object_id]):
                findings.append(
                    _finding(
                        "UNSCANNABLE_HISTORY_BLOB",
                        path,
                        1,
                        f"nul-byte:{object_id}",
                        source=f"history-object:{object_id[:12]}",
                    )
                )
            continue
        try:
            text = blob.decode("utf-8")
        except UnicodeDecodeError:
            for path in sorted(paths_by_object[object_id]):
                findings.append(
                    _finding(
                        "UNSCANNABLE_HISTORY_BLOB",
                        path,
                        1,
                        f"non-utf8:{object_id}",
                        source=f"history-object:{object_id[:12]}",
                    )
                )
            continue
        for path in sorted(paths_by_object[object_id]):
            for finding in scan_secrets(
                path,
                text,
                source=f"history-object:{object_id[:12]}",
            ):
                if finding.rule_id not in HISTORY_CONTENT_RULES:
                    continue
                # Several secret recognisers may intentionally match the same
                # source line. History mode reports the location once without
                # revealing which value or recogniser matched.
                key = (object_id, finding.path, finding.line)
                if key in seen_locations:
                    continue
                seen_locations.add(key)
                findings.append(
                    replace(
                        finding,
                        rule_id="HISTORY_SECRET",
                        message=RULE_MESSAGES["HISTORY_SECRET"],
                        fingerprint=_fingerprint(
                            "HISTORY_SECRET", finding.path, finding.fingerprint
                        ),
                    )
                )
    return _dedupe(findings)


def load_baseline(path: Path) -> tuple[dict[str, dict[str, str]], list[Finding]]:
    if not path.exists():
        return {}, [
            _finding("BASELINE_INVALID", str(path), 1, "baseline-file-missing")
        ]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}, [_finding("BASELINE_INVALID", str(path), 1, "invalid-json")]
    if data.get("version") != BASELINE_VERSION or not isinstance(
        data.get("findings"), list
    ):
        return {}, [
            _finding("BASELINE_INVALID", str(path), 1, "invalid-version-or-findings")
        ]

    owner = data.get("owner")
    created_on = data.get("created_on")
    expires_on = data.get("expires_on")
    reason = data.get("reason")
    removal_plan = data.get("removal_plan")
    if not all(
        isinstance(value, str)
        for value in (owner, created_on, expires_on, reason, removal_plan)
    ):
        return {}, [
            _finding(
                "BASELINE_INVALID",
                str(path),
                1,
                "missing-owner-or-expiry",
            )
        ]
    try:
        created = date.fromisoformat(created_on)
        expiry = date.fromisoformat(expires_on)
    except ValueError:
        return {}, [
            _finding("BASELINE_INVALID", str(path), 1, "invalid-created-or-expiry")
        ]
    if (
        not owner.strip()
        or not reason.strip()
        or not removal_plan.strip()
        or created > date.today()
        or expiry < date.today()
        or expiry < created
        or (expiry - created).days > MAX_BASELINE_LIFETIME_DAYS
    ):
        return {}, [
            _finding(
                "BASELINE_INVALID",
                str(path),
                1,
                "owner-missing-or-expired",
            )
        ]

    entries: dict[str, dict[str, str]] = {}
    invalid: list[Finding] = []
    for item in data["findings"]:
        if not isinstance(item, dict):
            invalid.append(
                _finding("BASELINE_INVALID", str(path), 1, "non-object-entry")
            )
            continue
        fingerprint = item.get("fingerprint")
        rule_id = item.get("rule_id")
        item_path = item.get("path")
        if not all(
            isinstance(value, str)
            for value in (fingerprint, rule_id, item_path)
        ):
            invalid.append(
                _finding("BASELINE_INVALID", str(path), 1, "invalid-entry-fields")
            )
            continue
        if rule_id in NON_BASELINABLE_RULES:
            invalid.append(
                _finding(
                    "BASELINE_INVALID",
                    str(path),
                    1,
                    f"non-baselinable-rule:{rule_id}",
                )
            )
            continue
        entries[fingerprint] = {
            "rule_id": rule_id,
            "path": _normalise_path(item_path),
            "owner": owner,
            "created_on": created_on,
            "expires_on": expires_on,
            "reason": reason,
            "removal_plan": removal_plan,
        }
    return entries, _dedupe(invalid)


def validate_baseline_not_grown(
    current_path: Path,
    base_path: Path,
) -> list[Finding]:
    current_entries, current_errors = load_baseline(current_path)
    if current_errors:
        # The normal baseline application path reports these errors already.
        return []
    base_entries, base_errors = load_baseline(base_path)
    if base_errors:
        return base_errors

    findings: list[Finding] = []
    for fingerprint, current_entry in current_entries.items():
        if base_entries.get(fingerprint) != current_entry:
            findings.append(
                _finding(
                    "BASELINE_GROWTH",
                    current_path.as_posix(),
                    1,
                    (
                        f"entry-added-or-replaced:{fingerprint}:"
                        f"{current_entry['rule_id']}:{current_entry['path']}"
                    ),
                )
            )
    return _dedupe(findings)


def apply_baseline(
    findings: Sequence[Finding],
    baseline_path: Path,
    *,
    report_stale: bool = True,
) -> tuple[list[Finding], list[Finding]]:
    entries, baseline_errors = load_baseline(baseline_path)
    if baseline_errors:
        return list(findings) + baseline_errors, []
    used: set[str] = set()
    active: list[Finding] = []
    suppressed: list[Finding] = []
    for finding in findings:
        entry = entries.get(finding.fingerprint)
        if (
            finding.baselinable
            and entry
            and entry["rule_id"] == finding.rule_id
            and entry["path"] == finding.path
        ):
            used.add(finding.fingerprint)
            suppressed.append(finding)
        else:
            active.append(finding)
    if report_stale:
        for fingerprint, entry in entries.items():
            if fingerprint not in used:
                active.append(
                    _finding(
                        "BASELINE_STALE",
                        entry["path"],
                        1,
                        f"stale:{entry['rule_id']}:{fingerprint}",
                    )
                )
    return _dedupe(active), _dedupe(suppressed)


def _read_revision_text(root: Path, revision: str, path: str) -> str | None:
    """Text of a path at a revision, or None when absent/undecodable/oversize."""
    try:
        raw = _git(root, "show", f"{revision}:{path}")
    except subprocess.CalledProcessError:
        return None
    if not isinstance(raw, bytes):
        return None
    if b"\0" in raw or len(raw) > MAX_CURRENT_TEXT_BYTES:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def scan_changed(
    root: Path,
    base_sha: str,
) -> list[Finding]:
    """All-rule scan of violations introduced by changes since base_sha.

    Findings are computed on the current tree for changed paths; a finding is
    dropped when the same (rule, path, line) already existed in the base tree,
    so legacy violations a PR does not touch stay out of scope. Derived checks
    use the full tracked manifest set.
    """
    manifest = tracked_paths(root)
    changed = changed_paths(root, base_sha)
    findings = scan_current(root, paths=changed, manifest_paths=manifest)

    base_text_cache: dict[str, str | None] = {}

    def base_text(path: str) -> str | None:
        if path not in base_text_cache:
            base_text_cache[path] = _read_revision_text(root, base_sha, path)
        return base_text_cache[path]

    filtered: list[Finding] = []
    for finding in findings:
        if finding.rule_id == "DEPENDENCY_MISSING_LOCK":
            # Derived check: compare directory manifest state, not file text.
            if not _missing_lock_introduced(root, base_sha, finding.path):
                continue
            filtered.append(finding)
            continue
        base = base_text(finding.path)
        if base is None:
            filtered.append(finding)
            continue
        base_findings = scan_file(finding.path, base)
        if finding.fingerprint in {item.fingerprint for item in base_findings}:
            # Identical evidence existed at base: pre-existing.
            continue
        if finding.rule_id in _CONTENT_DIGEST_RULES and any(
            item.rule_id == finding.rule_id for item in base_findings
        ):
            # Rules that fold a content digest into the fingerprint change it
            # on every edit of a legacy violating file; a same-rule hit at
            # base means the violation is pre-existing, not introduced.
            continue
        filtered.append(finding)

    return _dedupe(filtered)


_CONTENT_DIGEST_RULES = {"TEST_HARNESS_DEPLOYABLE", "PRODUCTION_A2A_SURFACE"}


def _missing_lock_introduced(root: Path, base_sha: str, path: str) -> bool:
    """True when the pyproject directory gained lock-less status since base."""
    directory = PurePosixPath(path).parent.as_posix()
    tracked = tracked_paths(root)
    pyproject = f"{directory}/pyproject.toml"
    lock_names = ("uv.lock", "poetry.lock", "Pipfile.lock")
    head_lockless = pyproject in tracked and not any(
        f"{directory}/{name}" in tracked for name in lock_names
    )
    if not head_lockless:
        return False
    base_files = _git(
        root, "ls-tree", "-r", "--name-only", base_sha, "--", directory, text=True
    )
    base_lines = {line.strip() for line in base_files.splitlines() if line.strip()}
    base_pyproject = f"{directory}/pyproject.toml" in base_lines
    base_has_lock = any(
        f"{directory}/{name}" in base_lines for name in lock_names
    )
    # Introduced means: the directory is lock-less at HEAD but was not in this
    # state at base -- either it had a lock, or it had no pyproject at all.
    return (base_pyproject and base_has_lock) or not base_pyproject


def baseline_document(
    findings: Sequence[Finding],
    *,
    owner: str,
    expires_on: str,
) -> dict[str, object]:
    if not owner.strip():
        raise ValueError("baseline owner must not be empty")
    created = date.today()
    expiry = date.fromisoformat(expires_on)
    if expiry < created:
        raise ValueError("baseline expiry must not be in the past")
    if (expiry - created).days > MAX_BASELINE_LIFETIME_DAYS:
        raise ValueError(
            f"baseline lifetime must not exceed {MAX_BASELINE_LIFETIME_DAYS} days"
        )
    entries = [
        {
            "fingerprint": finding.fingerprint,
            "rule_id": finding.rule_id,
            "path": finding.path,
        }
        for finding in _dedupe(findings)
        if finding.baselinable
    ]
    return {
        "version": BASELINE_VERSION,
        "owner": owner,
        "created_on": created.isoformat(),
        "expires_on": expires_on,
        "reason": (
            "Pre-existing supply-chain migration debt found before Security Action "
            "enforcement; "
            "only the exact fingerprints below are temporarily suppressed."
        ),
        "removal_plan": (
            "Delete each entry in the same PR that removes its finding. Complete "
            "the Agent security migration or obtain a newly reviewed baseline "
            "before expiry."
        ),
        "policy": (
            "Only pre-existing supply-chain migration debt may be listed. "
            "Secrets, tracked runtime configs, production-blocking Agent boundary "
            "findings, remote dependencies and unsafe workflow constructs are "
            "never baselinable."
        ),
        "findings": entries,
    }


def write_baseline(
    path: Path,
    findings: Sequence[Finding],
    *,
    owner: str,
    expires_on: str,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            baseline_document(
                findings,
                owner=owner,
                expires_on=expires_on,
            ),
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def _print_finding(finding: Finding, output_format: str) -> None:
    message = f"{finding.rule_id}: {finding.message}"
    if finding.source != "current":
        message += f" ({finding.source})"
    if output_format == "github":
        safe_message = message.replace("%", "%25").replace("\r", "%0D").replace(
            "\n", "%0A"
        )
        safe_path = finding.path.replace("%", "%25").replace(",", "%2C")
        print(
            f"::error file={safe_path},line={finding.line},title={finding.rule_id}"
            f"::{safe_message}"
        )
    else:
        print(f"ERROR {finding.rule_id} {finding.path}:{finding.line} - {message}")


def _revision_range(value: str) -> str:
    if not re.fullmatch(
        r"[0-9a-fA-F]{7,64}(?:\.\.[0-9a-fA-F]{7,64})?",
        value,
    ):
        raise argparse.ArgumentTypeError(
            "history range must be a commit SHA or BASE_SHA..HEAD_SHA"
        )
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--baseline",
        type=Path,
        default=Path("security/legacy-baseline.json"),
    )
    parser.add_argument(
        "--baseline-base",
        type=Path,
        help=(
            "Trusted baseline from the PR base commit. Every current entry and "
            "its metadata must already exist there; deletion is allowed."
        ),
    )
    history_group = parser.add_mutually_exclusive_group()
    history_group.add_argument(
        "--history",
        action="store_true",
        help="Scan every reachable Git commit for secrets; baseline is ignored.",
    )
    history_group.add_argument(
        "--history-range",
        type=_revision_range,
        help="Scan only objects introduced by SHA or BASE_SHA..HEAD_SHA.",
    )
    history_group.add_argument(
        "--diff-base",
        metavar="SHA",
        help=(
            "All-rule scan of only the violations introduced since SHA "
            "(merge-base with HEAD); gates new violations only."
        ),
    )
    parser.add_argument(
        "--write-baseline",
        action="store_true",
        help="Write only baselinable current findings. Non-baselinable findings remain errors.",
    )
    parser.add_argument(
        "--baseline-owner",
        help="Required with --write-baseline; accountable role or team.",
    )
    parser.add_argument(
        "--baseline-expiry",
        help="Required with --write-baseline; ISO date after which CI rejects the baseline.",
    )
    parser.add_argument("--format", choices=("text", "github"), default="text")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = args.root.resolve()
    baseline_path = args.baseline
    if not baseline_path.is_absolute():
        baseline_path = root / baseline_path
    baseline_base_path = args.baseline_base
    if baseline_base_path is not None and not baseline_base_path.is_absolute():
        baseline_base_path = root / baseline_base_path
    if baseline_base_path is not None and (
        args.history or args.history_range or args.write_baseline
    ):
        print("--baseline-base is only valid for current policy enforcement")
        return 2

    try:
        if args.history:
            findings = scan_history_secrets(root)
        elif args.history_range:
            findings = scan_history_secrets(root, args.history_range)
        elif args.diff_base:
            findings = scan_changed(root, args.diff_base)
        else:
            findings = scan_current(root)
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"repository guard could not inspect Git state: {type(exc).__name__}")
        return 2

    history_mode = bool(args.history or args.history_range)
    if history_mode:
        active = findings
        suppressed: list[Finding] = []
    elif args.diff_base:
        active, suppressed = apply_baseline(
            findings,
            baseline_path,
            report_stale=False,
        )
    elif args.write_baseline:
        if not args.baseline_owner or not args.baseline_expiry:
            print(
                "--write-baseline requires --baseline-owner and --baseline-expiry"
            )
            return 2
        try:
            write_baseline(
                baseline_path,
                findings,
                owner=args.baseline_owner,
                expires_on=args.baseline_expiry,
            )
        except ValueError as exc:
            print(f"invalid baseline metadata: {exc}")
            return 2
        active = [finding for finding in findings if not finding.baselinable]
        suppressed = [finding for finding in findings if finding.baselinable]
    else:
        active, suppressed = apply_baseline(findings, baseline_path)
        if baseline_base_path is not None:
            active.extend(
                validate_baseline_not_grown(
                    baseline_path,
                    baseline_base_path,
                )
            )
            active = _dedupe(active)

    for finding in active:
        _print_finding(finding, args.format)
    print(
        "repository-guard summary: "
        f"active={len(active)} baseline={len(suppressed)} mode="
        f"{'history' if history_mode else ('diff' if args.diff_base else 'current')}"
    )
    return 1 if active else 0


if __name__ == "__main__":
    raise SystemExit(main())
