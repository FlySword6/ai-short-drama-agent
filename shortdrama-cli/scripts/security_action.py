"""Fail-closed repository and release-artifact security checks.

The repository scan has no third-party runtime dependency.  Existing migration
debt may be suppressed only by an exact fingerprint in the time-bounded
baseline.  Secrets and packaged credentials are never suppressible.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import io
import json
import re
import subprocess
import sys
import tarfile
import zipfile
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path, PurePosixPath
from typing import Iterable, Iterator, Sequence
from urllib.parse import urlsplit


BASELINE_SCHEMA_VERSION = 1
MAX_BASELINE_LIFETIME_DAYS = 90
EXPIRY_WARNING_DAYS = 14
MAX_REPOSITORY_FILE_BYTES = 2 * 1024 * 1024
MAX_HISTORY_BLOB_BYTES = 2 * 1024 * 1024
MAX_ARTIFACT_MEMBER_BYTES = 64 * 1024 * 1024
MAX_ARTIFACT_TOTAL_BYTES = 512 * 1024 * 1024
MAX_ARTIFACT_MEMBERS = 20_000
MAX_ARTIFACT_DEPTH = 3

EXCLUDED_PARTS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "release-assets",
}
TEXT_SUFFIXES = {
    "",
    ".cfg",
    ".ini",
    ".json",
    ".key",
    ".md",
    ".p12",
    ".pem",
    ".pfx",
    ".ps1",
    ".py",
    ".sh",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}
ROOT_TEXT_FILES = {
    ".dockerignore",
    ".gitignore",
    "Dockerfile",
    "Makefile",
}

SENSITIVE_OPTION_FLAGS = {
    "--access-key",
    "--api-key",
    "--password",
    "--refresh-token",
    "--secret",
    "--secret-key",
    "--token",
}
PLAINTEXT_CREDENTIAL_FILE_FLAGS = {
    "--credential-file",
    "--password-file",
    "--token-file",
}
ARBITRARY_ENDPOINT_FLAGS = {
    "--agent-url",
    "--api-base",
    "--api-url",
    "--asset-api-base",
}
ARBITRARY_ENDPOINT_ENV = {
    "SHORTDRAMA_AGENT_URL",
    "SHORTDRAMA_API_BASE",
    "SHORTDRAMA_API_URL",
    "SHORTDRAMA_ASSET_API_BASE",
}
PLAINTEXT_CREDENTIAL_ENV_SUFFIXES = (
    "_ACCESS_KEY_FILE",
    "_API_KEY_FILE",
    "_PASSWORD_FILE",
    "_SECRET_KEY_FILE",
    "_TOKEN_FILE",
)
DATABASE_PACKAGES = {
    "asyncpg",
    "pg8000",
    "psycopg",
    "psycopg2",
    "sqlalchemy",
    "supabase",
}
DIRECT_CLOUD_PACKAGES = {
    "agentkit",
    "boto3",
    "openai",
    "tos",
    "veadk",
    "volcengine",
}
SENSITIVE_FILE_NAMES = {
    ".agent-token",
    ".env",
    ".env.local",
    "credentials.json",
    "service-account.json",
}
SENSITIVE_FILE_SUFFIXES = {
    ".key",
    ".p12",
    ".pem",
    ".pfx",
}
NON_BASELINABLE_RULES = {
    "ARTIFACT_SECRET",
    "ARTIFACT_SENSITIVE_FILE",
    "ARTIFACT_UNSCANNABLE_FILE",
    "PRIVATE_KEY",
    "PYTHON_PARSE_ERROR",
    "HISTORY_SECRET",
    "HISTORY_UNSCANNABLE_BLOB",
    "RELEASE_ARTIFACT_SCAN_MISSING",
    "RELEASE_AUDITED_COMMIT_BINDING_MISSING",
    "RELEASE_JOB_DEPENDENCY_MISSING",
    "RELEASE_TAG_PROVENANCE_MISSING",
    "REPOSITORY_FILE_TOO_LARGE",
    "REPOSITORY_SECURITY_SCAN_MISSING",
    "REPOSITORY_UNSCANNABLE_FILE",
    "SECRET_LITERAL",
    "SENSITIVE_FILE",
    "SKILL_ENDPOINT_OVERRIDE",
    "SKILL_MODEL_OVERRIDE",
    "SKILL_SECRET_ARGUMENT",
    "WORKFLOW_DANGEROUS_TRIGGER",
    "WORKFLOW_CHECKOUT_CREDENTIALS",
    "WORKFLOW_FAIL_OPEN",
    "WORKFLOW_PERMISSIONS",
    "WORKFLOW_UNPINNED_ACTION",
}
PRODUCTION_BLOCKING_RULES = {
    "ARBITRARY_ENDPOINT_ENV",
    "ARBITRARY_ENDPOINT_OPTION",
    "CLI_SECRET_OPTION",
    "CLOUD_SDK_DEPENDENCY",
    "DATABASE_DEPENDENCY",
    "DIRECT_CLOUD_ENDPOINT",
    "DIRECT_PROVIDER_NETWORK",
    "INSECURE_HTTP_ENDPOINT",
    "PLAINTEXT_CREDENTIAL_FILE",
    "PLAINTEXT_SESSION_STORAGE",
    "SENSITIVE_DEBUG_OUTPUT",
    "UNFILTERED_OUTPUT",
    "UNREDACTED_ERROR",
    "UNTRUSTED_REMOTE_URL_OUTPUT",
}

SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Volcengine access key", re.compile(r"\bAKLT[A-Za-z0-9]{16,}\b")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("OpenAI-style key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    (
        "private key",
        re.compile(r"-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----"),
    ),
)
SECRET_NAME_PATTERN = (
    r"(?:[A-Za-z][A-Za-z0-9]*[_-])*"
    r"(?:access[_-]?key|api[_-]?(?:key|token)|authorization|bearer|"
    r"client[_-]?secret|password|refresh[_-]?token|runtime[_-]?api_?key|"
    r"runtime[_-]?apikey|secret(?:[_-]?key)?|token|sk)"
)
SECRET_ASSIGNMENT = re.compile(
    rf"""(?ix)
    (?<![A-Za-z0-9_-])["']?({SECRET_NAME_PATTERN})["']?
    \s*[:=]\s*
    ["']([^"'{{}}\r\n]{{16,}})["']
    """
)
UNQUOTED_SECRET_ASSIGNMENT = re.compile(
    rf"""(?imx)
    ^\s*
    ({SECRET_NAME_PATTERN})
    \s*[:=]\s*
    ([A-Za-z0-9_./+=-]{{16,}})
    \s*(?:\#.*)?$
    """
)
SAFE_SAMPLE_VALUES = {
    "change-me",
    "changeme",
    "dummy",
    "dummy-secret",
    "example",
    "example-token",
    "fake",
    "fake-token",
    "fixture",
    "mock",
    "mock-token",
    "not-a-real",
    "not-a-real-secret",
    "placeholder",
    "sample",
    "sample-token",
    "test",
    "test-token",
}
WORKFLOW_USES = re.compile(
    r"(?:^\s*(?:-\s*)?uses\s*:\s*|[{,]\s*uses\s*:\s*)"
    r"([^#,\s}\]]+)",
    re.MULTILINE,
)
FULL_COMMIT_REF = re.compile(r"^[^@\s]+@[0-9a-fA-F]{40}$")
HTTP_URL = re.compile(r"""(?i)\bhttp://[^\s"'<>]+""")
CLOUD_HOST = re.compile(
    r"""(?ix)
    https?://[^\s"'<>]*
    (?:ark\.[^\s/"']*volces\.com|tos-[^\s/"']*volces\.com|volceapi\.com)
    """
)

# ADR 0001 / issue #24 explicitly approves two *temporary* HTTP site roots.
# Store digests rather than the URLs themselves: this scanner must remain
# subject to its own HTTP rule.  The exception is structural, not a general
# allowlist: an exact digest is accepted only as a ``site_root`` literal in a
# marked ``TrustedEndpoint`` entry of the released endpoint catalogue.
ADR_PLAIN_HTTP_ENDPOINT_CATALOGUE = "src/shortdrama_cli/server_api/endpoints.py"
ADR_PLAIN_HTTP_ENDPOINT_DIGESTS = {
    "prod": "4db2ef9b3e1bf4102378f3e96197478463840187435bbdf89c6851d4893b99ad",
    "test": "d3afef9f49d3380dc7c07ddf7be48c12fb5fef44869116b9d5981ebff54cda5e",
}
SESSION_STORAGE_MODULE = "src/shortdrama_cli/storage/session.py"
SESSION_ENVIRONMENTS = frozenset({"prod", "test", "dev"})
SESSION_ALLOWED_FIELDS = frozenset({"token", "expires_at"})


RULE_SUMMARIES = {
    "ARBITRARY_ENDPOINT_ENV": "环境变量可把生产凭证改送到任意服务地址",
    "ARBITRARY_ENDPOINT_OPTION": "命令行允许覆盖生产服务地址",
    "ARTIFACT_UNSCANNABLE_FILE": "发布制品包含无法可靠解码的文本文件",
    "CLI_SECRET_OPTION": "秘密值会进入命令行参数和进程列表",
    "CLOUD_SDK_DEPENDENCY": "薄 CLI 新增了云 Provider SDK 依赖",
    "DATABASE_DEPENDENCY": "CLI 新增了直连数据库依赖",
    "DIRECT_CLOUD_ENDPOINT": "CLI 内嵌了 Ark/TOS/Agent 云端地址",
    "DIRECT_PROVIDER_NETWORK": "Provider 绕过业务服务端直接联网",
    "HISTORY_SECRET": "Git 历史中仍存在疑似秘密",
    "HISTORY_UNSCANNABLE_BLOB": "Git 历史包含无法完整扫描的文本对象",
    "INSECURE_HTTP_ENDPOINT": "生产地址使用明文 HTTP",
    "PLAINTEXT_CREDENTIAL_FILE": "CLI 从普通文件读取凭据",
    "PLAINTEXT_SESSION_STORAGE": "会话凭据被写入普通本地文件",
    "PRIVATE_KEY": "仓库包含私钥",
    "PYTHON_PARSE_ERROR": "Python 文件无法解析，安全规则不能可靠执行",
    "RELEASE_ARTIFACT_SCAN_MISSING": "发布工作流没有扫描最终制品",
    "RELEASE_AUDITED_COMMIT_BINDING_MISSING": "构建/发布没有绑定安全 Job 审计过的提交",
    "RELEASE_JOB_DEPENDENCY_MISSING": "发布 Job 没有强制依赖前置安全检查",
    "RELEASE_TAG_PROVENANCE_MISSING": "发布工作流没有验证 Tag 来自受保护发布分支",
    "REPOSITORY_SECURITY_SCAN_MISSING": "发布工作流没有执行仓库安全门禁",
    "REPOSITORY_FILE_TOO_LARGE": "文本文件超过安全扫描上限",
    "REPOSITORY_UNSCANNABLE_FILE": "文件不是可安全扫描的 UTF-8 文本",
    "SECRET_LITERAL": "仓库包含疑似真实秘密",
    "SENSITIVE_DEBUG_OUTPUT": "调试输出可能回显提示词、响应或凭据",
    "SENSITIVE_FILE": "仓库包含敏感配置或凭据文件",
    "SKILL_ENDPOINT_OVERRIDE": "WorkBuddy/Codex Skill 指导覆盖受信服务地址",
    "SKILL_MODEL_OVERRIDE": "WorkBuddy/Codex Skill 指导选择任意 Provider 或模型",
    "SKILL_SECRET_ARGUMENT": "WorkBuddy/Codex Skill 指导把秘密放进命令行参数",
    "UNFILTERED_OUTPUT": "未经过字段白名单的数据会进入输出或运行产物",
    "UNREDACTED_ERROR": "上游响应正文或底层异常被原样返回",
    "UNTRUSTED_REMOTE_URL_OUTPUT": "服务端返回的任意 URL 被直接展示",
    "WORKFLOW_DANGEROUS_TRIGGER": "高权限工作流使用 pull_request_target",
    "WORKFLOW_CHECKOUT_CREDENTIALS": "checkout 没有逐项关闭 Git 凭据持久化",
    "WORKFLOW_FAIL_OPEN": "安全工作流允许失败后继续执行",
    "WORKFLOW_PERMISSIONS": "工作流没有声明最小权限或使用 write-all",
    "WORKFLOW_UNPINNED_ACTION": "第三方 Action 没有固定到 40 位提交 SHA",
}


@dataclass(frozen=True, slots=True)
class Finding:
    rule_id: str
    path: str
    line: int
    message: str
    fingerprint: str
    severity: str = "error"

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(slots=True)
class ScanResult:
    active: list[Finding]
    suppressed: list[Finding]
    warnings: list[str]
    baseline_errors: list[str]

    @property
    def ok(self) -> bool:
        return not self.active and not self.baseline_errors


def _fingerprint(rule_id: str, relative_path: str, identity: str) -> str:
    digest = hashlib.sha256(
        f"{rule_id}\0{relative_path}\0{identity}".encode("utf-8"),
    ).hexdigest()
    return f"{rule_id.lower()}:{digest[:24]}"


def _safe_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def _full_hash(value: str) -> str:
    """Hash reviewed literals without retaining them in the scanner source."""

    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _relative(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _is_sensitive_file_name(name: str) -> bool:
    lowered = name.lower()
    return (
        lowered in SENSITIVE_FILE_NAMES
        or lowered.startswith(".env.")
        or Path(lowered).suffix in SENSITIVE_FILE_SUFFIXES
    )


def _finding(
    rule_id: str,
    relative_path: str,
    line: int,
    identity: str,
    *,
    message: str | None = None,
) -> Finding:
    return Finding(
        rule_id=rule_id,
        path=relative_path,
        line=max(line, 1),
        message=message or RULE_SUMMARIES[rule_id],
        fingerprint=_fingerprint(rule_id, relative_path, identity),
    )


def _candidate_files(
    root: Path,
    paths: Iterable[str] | None = None,
) -> Iterator[Path]:
    """Yield scan candidates from the repository or an explicit Git diff scope.

    The explicit-path form is intentionally limited to paths reported by Git.  A
    deleted path has no working-tree content to scan and is therefore skipped;
    the separate history scan remains responsible for secrets in deleted blobs.
    """

    if paths is None:
        candidates = sorted(root.rglob("*"))
    else:
        candidates = []
        for relative_path in sorted(set(paths)):
            path = root.joinpath(*PurePosixPath(relative_path).parts)
            # ``git diff`` can include deleted files.  They cannot introduce a
            # current-tree boundary violation, so do not turn them into a
            # false failure here.
            if path.exists():
                candidates.append(path)

    for path in candidates:
        if not path.is_file() or any(part in EXCLUDED_PARTS for part in path.parts):
            continue
        if (
            path.suffix.lower() in TEXT_SUFFIXES
            or path.name in ROOT_TEXT_FILES
            or _is_sensitive_file_name(path.name)
        ):
            yield path


def _read_text(path: Path) -> str | None:
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\x00" in raw:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _is_sample_secret(value: str) -> bool:
    lowered = value.strip().lower()
    normalized = re.sub(r"[_\s]+", "-", lowered)
    if lowered.startswith(("${", "{{", "<")):
        return True
    if normalized in SAFE_SAMPLE_VALUES:
        return True
    return len(set(value)) < 5


def _scan_secrets(relative_path: str, text: str) -> list[Finding]:
    findings: list[Finding] = []
    for label, pattern in SECRET_PATTERNS:
        for match in pattern.finditer(text):
            rule_id = "PRIVATE_KEY" if label == "private key" else "SECRET_LITERAL"
            findings.append(
                _finding(
                    rule_id,
                    relative_path,
                    _line_number(text, match.start()),
                    f"{label}:{_safe_hash(match.group(0))}",
                    message=f"{RULE_SUMMARIES[rule_id]}（类型：{label}；值已隐藏）",
                )
            )
    for match in SECRET_ASSIGNMENT.finditer(text):
        value = match.group(2).strip()
        if _is_sample_secret(value):
            continue
        findings.append(
            _finding(
                "SECRET_LITERAL",
                relative_path,
                _line_number(text, match.start()),
                f"assignment:{match.group(1).lower()}:{_safe_hash(value)}",
                message=f"{RULE_SUMMARIES['SECRET_LITERAL']}（赋值目标：{match.group(1)}；值已隐藏）",
            )
        )
    for match in UNQUOTED_SECRET_ASSIGNMENT.finditer(text):
        value = match.group(2).strip()
        if _is_sample_secret(value):
            continue
        findings.append(
            _finding(
                "SECRET_LITERAL",
                relative_path,
                _line_number(text, match.start()),
                f"assignment:{match.group(1).lower()}:{_safe_hash(value)}",
                message=f"{RULE_SUMMARIES['SECRET_LITERAL']}（赋值目标：{match.group(1)}；值已隐藏）",
            )
        )
    return findings


def _call_name(node: ast.Call) -> str:
    parts: list[str] = []
    current: ast.expr = node.func
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        parts.append(current.id)
    return ".".join(reversed(parts))


def _value_names(node: ast.AST) -> set[str]:
    """Return value/key names without treating ``response.safe_id`` as raw response."""

    if isinstance(node, ast.Name):
        return {node.id.lower()}
    if isinstance(node, ast.Attribute):
        return {node.attr.lower()}
    if isinstance(node, ast.Constant):
        return {node.value.lower()} if isinstance(node.value, str) else set()
    values: set[str] = set()
    for child in ast.iter_child_nodes(node):
        values.update(_value_names(child))
    return values


def _option_flags(node: ast.AST) -> set[str]:
    if not isinstance(node, ast.Call) or not _call_name(node).endswith("Option"):
        return set()
    return {
        item.value.lower()
        for item in ast.walk(node)
        if isinstance(item, ast.Constant)
        and isinstance(item.value, str)
        and item.value.startswith("--")
    }


def _constant_value(node: ast.AST | None) -> object | None:
    """Return a literal value without evaluating application code."""

    return node.value if isinstance(node, ast.Constant) else None


def _call_has_literal_keyword(call: ast.Call, name: str, value: object) -> bool:
    return any(
        keyword.arg == name and _constant_value(keyword.value) == value
        for keyword in call.keywords
    )


def _call_has_literal_argument(call: ast.Call, value: object) -> bool:
    return any(_constant_value(argument) == value for argument in call.args)


def _has_name(node: ast.AST, name: str) -> bool:
    return any(
        isinstance(candidate, ast.Name) and candidate.id == name
        for candidate in ast.walk(node)
    )


def _tuple_or_set_of_strings(node: ast.AST) -> set[str] | None:
    if not isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return None
    values = {_constant_value(item) for item in node.elts}
    if all(isinstance(value, str) for value in values):
        return {value for value in values if isinstance(value, str)}
    return None


def _session_function_has_private_atomic_write(
    function: ast.FunctionDef,
    *,
    require_session_allowlist: bool,
) -> bool:
    """Recognize the narrow, reviewed session-write shape.

    This does not broadly bless a file named ``session.py``.  Both writers
    must use a temporary sibling, user-only directory/file modes, and an
    atomic replace.  The session writer must additionally serialize only the
    token/expiry allowlist rather than a raw response object.
    """

    calls = [node for node in ast.walk(function) if isinstance(node, ast.Call)]
    writes = [
        call
        for call in calls
        if _call_name(call) in {"temporary.write_text", "temporary.write_bytes"}
    ]
    all_writes = [
        call
        for call in calls
        if _call_name(call).endswith(("write_text", "write_bytes"))
    ]
    if len(writes) != 1 or len(all_writes) != len(writes):
        return False

    has_private_parent = any(
        _call_name(call) == "path.parent.mkdir"
        and _call_has_literal_keyword(call, "mode", 0o700)
        for call in calls
    ) and any(
        _call_name(call) == "path.parent.chmod"
        and _call_has_literal_argument(call, 0o700)
        for call in calls
    )
    has_private_file = any(
        _call_name(call) == "temporary.chmod"
        and _call_has_literal_argument(call, 0o600)
        for call in calls
    ) and any(
        _call_name(call) == "path.chmod"
        and _call_has_literal_argument(call, 0o600)
        for call in calls
    )
    has_atomic_replace = any(
        _call_name(call) == "temporary.replace" and _has_name(call, "path")
        for call in calls
    )
    temporary_assignment = any(
        isinstance(node, (ast.Assign, ast.AnnAssign))
        and _has_name(node.targets[0] if isinstance(node, ast.Assign) else node.target, "temporary")
        and _has_name(node.value, "path")
        and any(
            isinstance(candidate, ast.Constant) and candidate.value == ".tmp"
            for candidate in ast.walk(node.value)
        )
        for node in ast.walk(function)
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None
    )
    if not (
        has_private_parent
        and has_private_file
        and has_atomic_replace
        and temporary_assignment
    ):
        return False

    write = writes[0]
    if require_session_allowlist:
        allowlist_assignments = [
            node
            for node in ast.walk(function)
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id == "safe_value"
                for target in node.targets
            )
            and isinstance(node.value, ast.DictComp)
        ]
        has_exact_allowlist = any(
            any(
                _tuple_or_set_of_strings(generator.iter) == SESSION_ALLOWED_FIELDS
                for generator in assignment.value.generators
            )
            for assignment in allowlist_assignments
        )
        return has_exact_allowlist and _has_name(write, "safe_value")

    # The active-environment file is non-secret and must contain only the
    # selected profile name, never a URL or session value.
    return any(
        isinstance(candidate, ast.Dict)
        and {
            _constant_value(key) for key in candidate.keys
        } == {"environment"}
        for candidate in ast.walk(write)
    )


def _is_safe_session_storage_module(relative_path: str, text: str) -> bool:
    if relative_path != SESSION_STORAGE_MODULE:
        return False
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return False

    functions = {
        node.name: node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
    }
    environment_values: set[str] | None = None
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(
            isinstance(target, ast.Name) and target.id == "_ENVIRONMENTS"
            for target in node.targets
        ):
            continue
        if isinstance(node.value, ast.Call) and _call_name(node.value) == "frozenset":
            if node.value.args:
                environment_values = _tuple_or_set_of_strings(node.value.args[0])
    if environment_values != SESSION_ENVIRONMENTS:
        return False
    return (
        "save_session" in functions
        and "save_active_environment" in functions
        and _session_function_has_private_atomic_write(
            functions["save_session"],
            require_session_allowlist=True,
        )
        and _session_function_has_private_atomic_write(
            functions["save_active_environment"],
            require_session_allowlist=False,
        )
    )


class _PythonPolicyVisitor(ast.NodeVisitor):
    def __init__(self, relative_path: str, *, safe_session_storage: bool = False) -> None:
        self.relative_path = relative_path
        self.safe_session_storage = safe_session_storage
        self.findings: list[Finding] = []
        self.scope: list[str] = []
        self.seen_constants: set[tuple[str, str]] = set()
        self.identity_counts: dict[tuple[str, str], int] = {}

    def _add(self, rule_id: str, node: ast.AST, identity: str) -> None:
        scope = ".".join(self.scope) or "<module>"
        count_key = (rule_id, f"{scope}:{identity}")
        occurrence = self.identity_counts.get(count_key, 0) + 1
        self.identity_counts[count_key] = occurrence
        self.findings.append(
            _finding(
                rule_id,
                self.relative_path,
                getattr(node, "lineno", 1),
                f"{scope}:{identity}#{occurrence}",
            )
        )

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.scope.append(node.name)
        positional = [*node.args.posonlyargs, *node.args.args]
        defaults: list[tuple[ast.arg, ast.expr | None]] = [
            *zip(
                positional,
                [None] * (len(positional) - len(node.args.defaults))
                + list(node.args.defaults),
            ),
            *zip(node.args.kwonlyargs, node.args.kw_defaults),
        ]
        for argument, default in defaults:
            option_nodes = [
                candidate
                for candidate in (
                    [default] if isinstance(default, ast.Call) else []
                )
                if _call_name(candidate).endswith("Option")
            ]
            if argument.annotation is not None:
                option_nodes.extend(
                    candidate
                    for candidate in ast.walk(argument.annotation)
                    if isinstance(candidate, ast.Call)
                    and _call_name(candidate).endswith("Option")
                )
            if not option_nodes:
                continue
            flags = set().union(*(_option_flags(item) for item in option_nodes))
            finding_node = option_nodes[0]
            inferred_flag = f"--{argument.arg.lower().replace('_', '-')}"
            if (
                inferred_flag in SENSITIVE_OPTION_FLAGS
                and not flags & SENSITIVE_OPTION_FLAGS
            ):
                self._add("CLI_SECRET_OPTION", finding_node, inferred_flag)
            if (
                inferred_flag in PLAINTEXT_CREDENTIAL_FILE_FLAGS
                and not flags & PLAINTEXT_CREDENTIAL_FILE_FLAGS
            ):
                self._add(
                    "PLAINTEXT_CREDENTIAL_FILE",
                    finding_node,
                    inferred_flag,
                )
            if (
                inferred_flag in ARBITRARY_ENDPOINT_FLAGS
                and not flags & ARBITRARY_ENDPOINT_FLAGS
            ):
                self._add(
                    "ARBITRARY_ENDPOINT_OPTION",
                    finding_node,
                    inferred_flag,
                )
        self.generic_visit(node)
        self.scope.pop()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.visit_FunctionDef(node)  # type: ignore[arg-type]

    def visit_Constant(self, node: ast.Constant) -> None:
        if not isinstance(node.value, str):
            return
        value = node.value.strip()
        if value in ARBITRARY_ENDPOINT_ENV:
            key = ("ARBITRARY_ENDPOINT_ENV", value)
            if key not in self.seen_constants:
                self.seen_constants.add(key)
                self._add("ARBITRARY_ENDPOINT_ENV", node, value)
        if value.endswith(PLAINTEXT_CREDENTIAL_ENV_SUFFIXES):
            key = ("PLAINTEXT_CREDENTIAL_FILE", value)
            if key not in self.seen_constants:
                self.seen_constants.add(key)
                self._add("PLAINTEXT_CREDENTIAL_FILE", node, value)
        if PurePosixPath(value.replace("\\", "/")).name in SENSITIVE_FILE_NAMES:
            key = ("PLAINTEXT_CREDENTIAL_FILE", value)
            if key not in self.seen_constants:
                self.seen_constants.add(key)
                self._add("PLAINTEXT_CREDENTIAL_FILE", node, value)

    def visit_Call(self, node: ast.Call) -> None:
        name = _call_name(node)
        if name.endswith("Option"):
            flags = _option_flags(node)
            for flag in sorted(flags & SENSITIVE_OPTION_FLAGS):
                self._add("CLI_SECRET_OPTION", node, flag)
            for flag in sorted(flags & PLAINTEXT_CREDENTIAL_FILE_FLAGS):
                self._add("PLAINTEXT_CREDENTIAL_FILE", node, flag)
            for flag in sorted(flags & ARBITRARY_ENDPOINT_FLAGS):
                self._add("ARBITRARY_ENDPOINT_OPTION", node, flag)

        argument_names = (
            set().union(*(_value_names(arg) for arg in node.args))
            if node.args
            else set()
        )
        if name in {"print", "typer.echo"} or name.endswith(".print"):
            if argument_names & {
                "body",
                "detail",
                "envelope",
                "password",
                "prompt",
                "raw",
                "response",
                "secret",
                "token",
            }:
                self._add(
                    "SENSITIVE_DEBUG_OUTPUT",
                    node,
                    f"{name}:{','.join(sorted(argument_names))}",
                )
            if "remote_url" in argument_names:
                self._add("UNTRUSTED_REMOTE_URL_OUTPUT", node, name)

        if name == "write_json" and argument_names & {"envelope", "response"}:
            self._add(
                "UNFILTERED_OUTPUT",
                node,
                f"write_json:{','.join(sorted(argument_names))}",
            )

        if (
            self.relative_path.endswith("output/formatter.py")
            and name == "json.dumps"
            and "value" in argument_names
        ):
            self._add("UNFILTERED_OUTPUT", node, f"{name}:value")

        if name.endswith(("Error", "Exception")) and argument_names & {
            "body",
            "detail",
            "raw",
            "reason",
            "response",
        }:
            self._add(
                "UNREDACTED_ERROR",
                node,
                f"{name}:{','.join(sorted(argument_names))}",
            )

        if (
            self.relative_path.endswith("storage/session.py")
            and name.endswith(("write_text", "write_bytes"))
            and not self.safe_session_storage
        ):
            self._add("PLAINTEXT_SESSION_STORAGE", node, name)

        self.generic_visit(node)


def _scan_python(relative_path: str, text: str) -> list[Finding]:
    try:
        tree = ast.parse(text)
    except SyntaxError as error:
        return [
            _finding(
                "PYTHON_PARSE_ERROR",
                relative_path,
                error.lineno or 1,
                _safe_hash(f"{error.msg}:{error.offset or 0}"),
            )
        ]

    visitor = _PythonPolicyVisitor(
        relative_path,
        safe_session_storage=_is_safe_session_storage_module(relative_path, text),
    )
    visitor.visit(tree)
    findings = visitor.findings

    if relative_path.startswith("src/shortdrama_cli/providers/"):
        network_nodes = [
            node
            for node in ast.walk(tree)
            if (
                isinstance(node, (ast.Import, ast.ImportFrom))
                and (
                    (
                        isinstance(node, ast.ImportFrom)
                        and (node.module or "").split(".")[0]
                        in {"aiohttp", "httpx", "requests", "urllib"}
                    )
                    or any(
                        alias.name.split(".")[0]
                        in {"aiohttp", "httpx", "requests", "urllib"}
                        for alias in node.names
                    )
                )
            )
            or (
                isinstance(node, ast.Call)
                and _call_name(node).split(".")[-1]
                in {"request", "urlopen", "AsyncClient", "Client"}
            )
        ]
        if network_nodes:
            identity = _safe_hash(ast.dump(tree, include_attributes=False))
            findings.append(
                _finding(
                    "DIRECT_PROVIDER_NETWORK",
                    relative_path,
                    getattr(network_nodes[0], "lineno", 1),
                    identity,
                )
            )

    for node in ast.walk(tree):
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        packages = {alias.name.split(".")[0].lower() for alias in node.names}
        if isinstance(node, ast.ImportFrom) and node.module:
            packages.add(node.module.split(".")[0].lower())
        for package in packages:
            if package in DATABASE_PACKAGES:
                findings.append(
                    _finding(
                        "DATABASE_DEPENDENCY",
                        relative_path,
                        node.lineno,
                        f"import:{package}",
                    )
                )
            if package in DIRECT_CLOUD_PACKAGES:
                findings.append(
                    _finding(
                        "CLOUD_SDK_DEPENDENCY",
                        relative_path,
                        node.lineno,
                        f"import:{package}",
                    )
                )
    return findings


def _workflow_step_blocks(text: str) -> list[str]:
    lines = text.splitlines()
    starts: list[tuple[int, int]] = []
    for index, line in enumerate(lines):
        match = re.match(r"^(\s*)-\s*(?:\{|[A-Za-z_][\w-]*\s*:)", line)
        if match is not None:
            starts.append((index, len(match.group(1))))

    blocks: list[str] = []
    for start, step_indent in starts:
        end = len(lines)
        for index in range(start + 1, len(lines)):
            stripped = lines[index].strip()
            if not stripped:
                continue
            indent = len(lines[index]) - len(lines[index].lstrip())
            if indent < step_indent or (
                indent == step_indent and lines[index].lstrip().startswith("-")
            ):
                end = index
                break
        blocks.append("\n".join(lines[start:end]))
    return blocks


def _extract_run_scalars(text: str) -> list[str]:
    """Extract ``run`` scalars from one YAML step."""

    lines = text.splitlines()
    commands: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        match = re.match(r"^(\s*)(?:-\s*)?run:\s*(.*)$", line)
        if match is None:
            index += 1
            continue
        base_indent = len(match.group(1))
        value = match.group(2).strip()
        if value and value not in {"|", "|-", ">", ">-"}:
            if not value.startswith("#"):
                commands.append(value.strip("\"'"))
            index += 1
            continue

        block: list[str] = []
        index += 1
        while index < len(lines):
            child = lines[index]
            stripped = child.strip()
            if not stripped:
                index += 1
                continue
            indent = len(child) - len(child.lstrip())
            if indent <= base_indent:
                break
            if not stripped.startswith("#"):
                block.append(stripped)
            index += 1
        if block:
            commands.append(" ".join(block))
    return commands


def _workflow_run_commands(text: str) -> list[str]:
    commands: list[str] = []
    for block in _workflow_step_blocks(text):
        if re.search(r"(?im)^\s*(?:-\s*)?if\s*:", block) or re.search(
            r"(?i)[{,]\s*if\s*:",
            block,
        ):
            continue
        if re.search(
            r"(?im)^\s*continue-on-error\s*:\s*true\s*(?:#.*)?$",
            block,
        ):
            continue
        commands.extend(_extract_run_scalars(block))
    return commands


def _workflow_job_blocks(text: str) -> dict[str, str]:
    lines = text.splitlines()
    try:
        jobs_index = next(
            index for index, line in enumerate(lines) if line.strip() == "jobs:"
            and len(line) == len(line.lstrip())
        )
    except StopIteration:
        return {}

    job_starts: list[tuple[str, int]] = []
    for index in range(jobs_index + 1, len(lines)):
        line = lines[index]
        if line and len(line) == len(line.lstrip()):
            break
        match = re.match(r"^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$", line)
        if match is not None:
            job_starts.append((match.group(1), index))

    blocks: dict[str, str] = {}
    for position, (name, start) in enumerate(job_starts):
        end = (
            job_starts[position + 1][1]
            if position + 1 < len(job_starts)
            else len(lines)
        )
        for index in range(start + 1, end):
            line = lines[index]
            if line and len(line) == len(line.lstrip()):
                end = index
                break
        blocks[name] = "\n".join(lines[start:end])
    return blocks


def _job_needs(block: str) -> set[str]:
    lines = block.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"^\s{4}needs\s*:\s*(.*?)\s*(?:#.*)?$", line)
        if match is None:
            continue
        inline = match.group(1).strip()
        if inline:
            if inline.startswith("[") and inline.endswith("]"):
                return {
                    item.strip(" \"'")
                    for item in inline[1:-1].split(",")
                    if item.strip(" \"'")
                }
            return {inline.strip("\"'")}
        needs: set[str] = set()
        for child in lines[index + 1 :]:
            if not child.strip():
                continue
            indent = len(child) - len(child.lstrip())
            if indent <= 4:
                break
            item = re.match(r"^\s*-\s*([A-Za-z0-9_-]+)\s*$", child)
            if item is not None:
                needs.add(item.group(1))
        return needs
    return set()


def _root_permissions_are_read_only(text: str) -> bool:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if not re.fullmatch(r"permissions\s*:\s*(?:#.*)?", line):
            continue
        permissions: dict[str, str] = {}
        for child in lines[index + 1 :]:
            if not child.strip():
                continue
            indent = len(child) - len(child.lstrip())
            if indent == 0:
                break
            item = re.match(
                r"^\s{2}([A-Za-z-]+)\s*:\s*(read|none|write)\s*(?:#.*)?$",
                child,
                re.IGNORECASE,
            )
            if item is None:
                return False
            permissions[item.group(1).lower()] = item.group(2).lower()
        return bool(permissions) and all(
            value in {"read", "none"} for value in permissions.values()
        )
    return False


def _job_write_permissions(block: str) -> set[str]:
    return {
        match.group(1).lower()
        for match in re.finditer(
            r"(?im)^\s{6}([A-Za-z-]+)\s*:\s*write\s*(?:#.*)?$",
            block,
        )
    }


def _checkout_step_is_safe(block: str) -> bool:
    if re.search(r"(?i)\bwith\s*:\s*\{[^}]*\bpersist-credentials\s*:\s*false\b", block):
        return not re.search(
            r"(?i)\bwith\s*:\s*\{[^}]*\bpersist-credentials\s*:\s*true\b",
            block,
        )
    lines = block.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"^(\s*)with\s*:\s*(?:#.*)?$", line)
        if match is None:
            continue
        with_indent = len(match.group(1))
        values: list[str] = []
        for child in lines[index + 1 :]:
            if not child.strip():
                continue
            indent = len(child) - len(child.lstrip())
            if indent <= with_indent:
                break
            item = re.match(
                r"^\s*persist-credentials\s*:\s*(true|false)\s*(?:#.*)?$",
                child,
                re.IGNORECASE,
            )
            if item is not None:
                values.append(item.group(1).lower())
        return values == ["false"]
    return False


def _has_security_command(
    commands: Sequence[str],
    subcommand: str,
    *,
    require_strict: bool = False,
) -> bool:
    prefix = re.compile(
        rf"^python(?:3(?:\.\d+)?)?(?:\.exe)?\s+"
        rf"scripts/security_action\.py\s+{re.escape(subcommand)}\b"
    )
    for command in commands:
        normalized = " ".join(command.split())
        if not prefix.match(normalized):
            continue
        if re.search(r"(?:&&|\|\||[;&|<>`]|\$\()", normalized):
            continue
        if require_strict and "--strict" not in normalized.split():
            continue
        return True
    return False


def _scan_workflow(relative_path: str, text: str) -> list[Finding]:
    findings: list[Finding] = []
    is_release = Path(relative_path).name.lower().startswith("release")
    external_references: list[str] = []
    for match in WORKFLOW_USES.finditer(text):
        reference = match.group(1).strip("\"'")
        if not reference.startswith("./"):
            external_references.append(reference)
        if reference.startswith("./") or FULL_COMMIT_REF.fullmatch(reference):
            continue
        findings.append(
            _finding(
                "WORKFLOW_UNPINNED_ACTION",
                relative_path,
                _line_number(text, match.start()),
                reference,
                message=f"{RULE_SUMMARIES['WORKFLOW_UNPINNED_ACTION']}（{reference}）",
            )
        )
    checkout_steps = [
        block
        for block in _workflow_step_blocks(text)
        if any(
            match.group(1).strip("\"'").startswith("actions/checkout@")
            for match in WORKFLOW_USES.finditer(block)
        )
    ]
    for index, block in enumerate(checkout_steps, start=1):
        if _checkout_step_is_safe(block):
            continue
        findings.append(
            _finding(
                "WORKFLOW_CHECKOUT_CREDENTIALS",
                relative_path,
                1,
                f"checkout-step:{index}",
            )
        )
    job_blocks = _workflow_job_blocks(text)
    # A reviewed release may be split into a draft-staging step, a separate
    # release gate, and final publication.  Treat that as a distinct topology
    # rather than weakening the legacy security -> build -> publish contract.
    staged_release = is_release and (
        "stage" in job_blocks or "release-gate" in job_blocks
    )
    permission_violation = not _root_permissions_are_read_only(text)
    for job_name, block in job_blocks.items():
        writes = _job_write_permissions(block)
        if not writes:
            if re.search(
                r"(?im)^\s{4}permissions\s*:\s*write-all\s*(?:#.*)?$",
                block,
            ):
                permission_violation = True
            continue
        allowed_write_job = (
            is_release
            and writes == {"contents"}
            and (
                (not staged_release and job_name == "publish")
                or (staged_release and job_name in {"stage", "publish"})
            )
        )
        if not allowed_write_job:
            permission_violation = True
    if permission_violation:
        findings.append(
            _finding(
                "WORKFLOW_PERMISSIONS",
                relative_path,
                1,
                "missing-read-only-root-or-unapproved-write",
            )
        )
    if re.search(r"(?m)^\s*pull_request_target\s*:", text):
        findings.append(
            _finding(
                "WORKFLOW_DANGEROUS_TRIGGER",
                relative_path,
                1,
                "pull_request_target",
            )
        )
    if re.search(r"(?im)^\s*continue-on-error\s*:\s*true\s*(?:#.*)?$", text):
        findings.append(
            _finding(
                "WORKFLOW_FAIL_OPEN",
                relative_path,
                1,
                "continue-on-error",
            )
        )
    if is_release:
        security_job_name = "security" if "security" in job_blocks else "security-gate"
        security_block = job_blocks.get(security_job_name, "")
        build_block = job_blocks.get("build", "")
        publish_block = job_blocks.get("publish", "")
        stage_block = job_blocks.get("stage", "")
        release_gate_block = job_blocks.get("release-gate", "")
        provenance_block = job_blocks.get("provenance", "")
        security_commands = _workflow_run_commands(security_block)
        build_commands = _workflow_run_commands(build_block)
        publish_commands = _workflow_run_commands(publish_block)
        stage_commands = _workflow_run_commands(stage_block)
        release_gate_commands = _workflow_run_commands(release_gate_block)
        provenance_commands = _workflow_run_commands(provenance_block)
        if not _has_security_command(
            security_commands,
            "repository",
            require_strict=True,
        ):
            findings.append(
                _finding(
                    "REPOSITORY_SECURITY_SCAN_MISSING",
                    relative_path,
                    1,
                    "repository-command",
                )
            )
        if security_job_name == "security":
            artifact_scans_present = (
                _has_security_command(build_commands, "artifacts")
                and (
                    _has_security_command(stage_commands, "artifacts")
                    if staged_release
                    else _has_security_command(publish_commands, "artifacts")
                )
            )
        else:
            artifact_scans_present = _has_security_command(build_commands, "artifacts")
        if not artifact_scans_present:
            findings.append(
                _finding(
                    "RELEASE_ARTIFACT_SCAN_MISSING",
                    relative_path,
                    1,
                    "artifacts-command",
                )
            )
        if security_job_name == "security":
            if staged_release:
                dependency_ok = (
                    "security" in _job_needs(build_block)
                    and {"security", "build"} <= _job_needs(stage_block)
                    and {"security", "stage"} <= _job_needs(release_gate_block)
                    and "release-gate" in _job_needs(publish_block)
                )
                dependency_identity = "security-build-stage-release-gate-publish-needs"
            else:
                dependency_ok = (
                    "security" in _job_needs(build_block)
                    and {"security", "build"} <= _job_needs(publish_block)
                )
                dependency_identity = "security-build-publish-needs"
        else:
            dependency_ok = (
                "stage" in _job_needs(security_block)
                and "stage" in _job_needs(release_gate_block)
                and {"release-gate", "security-gate"} <= _job_needs(publish_block)
            )
            if provenance_block:
                pinned_ref = "needs.provenance.outputs.release_sha"
                dependency_ok = dependency_ok and (
                    "provenance" in _job_needs(build_block)
                    and "provenance" in _job_needs(stage_block)
                    and "provenance" in _job_needs(security_block)
                    and "provenance" in _job_needs(publish_block)
                    and all(
                        pinned_ref in block
                        for block in (build_block, stage_block, security_block, publish_block)
                    )
                )
            dependency_identity = "stage-security-gate-release-gate-publish-needs"
        if not dependency_ok or re.search(r"(?im)^\s{4}if\s*:", security_block):
            findings.append(
                _finding(
                    "RELEASE_JOB_DEPENDENCY_MISSING",
                    relative_path,
                    1,
                    dependency_identity,
                )
            )
        provenance_pattern = re.compile(
            r"(?:^|[;&|]|\bthen\b|!)\s*git\s+merge-base\s+"
            r"--is-ancestor\b"
        )
        if security_job_name == "security":
            required_provenance_commands = (
                (security_commands, stage_commands, release_gate_commands)
                if staged_release
                else (security_commands, publish_commands)
            )
            has_all_provenance = all(
                any(
                    provenance_pattern.search(command) and "origin/main" in command
                    for command in commands
                )
                for commands in required_provenance_commands
            )
        else:
            has_all_provenance = any(
                provenance_pattern.search(command) and "origin/main" in command
                for command in security_commands
            )
            if provenance_block:
                has_all_provenance = has_all_provenance or (
                    any(
                        provenance_pattern.search(command)
                        and ("origin/main" in command or "GITHUB_SHA" in command)
                        for command in provenance_commands
                    )
                    and "release_sha:" in provenance_block
                    and "GITHUB_OUTPUT" in provenance_block
                )
        if not has_all_provenance:
            findings.append(
                _finding(
                    "RELEASE_TAG_PROVENANCE_MISSING",
                    relative_path,
                    1,
                    "main-ancestry",
                )
            )
        if security_job_name == "security":
            audited_reference = "needs.security.outputs.audited_commit"
            audited_binding_blocks = (
                (build_block, stage_block, release_gate_block)
                if staged_release
                else (build_block, publish_block)
            )
            if (
                "audited_commit:" not in security_block
                or "GITHUB_OUTPUT" not in security_block
                or any(audited_reference not in block for block in audited_binding_blocks)
            ):
                findings.append(
                    _finding(
                        "RELEASE_AUDITED_COMMIT_BINDING_MISSING",
                        relative_path,
                        1,
                        "audited-commit-output-and-checkouts",
                    )
                )
    return findings


def _dependency_name(requirement: str) -> str:
    return re.split(r"[\s<>=!~;\[]", requirement.strip(), maxsplit=1)[0].lower()


def _scan_pyproject(root: Path, path: Path, text: str) -> list[Finding]:
    try:
        try:
            import tomllib  # type: ignore[import-not-found]
        except ModuleNotFoundError:
            import tomli as tomllib  # type: ignore[import-not-found,no-redef]

        value = tomllib.loads(text)
    except (ModuleNotFoundError, ValueError):
        return []
    requirements: list[str] = list(value.get("project", {}).get("dependencies", []))
    for group in value.get("dependency-groups", {}).values():
        if isinstance(group, list):
            requirements.extend(item for item in group if isinstance(item, str))

    relative_path = _relative(path, root)
    findings: list[Finding] = []
    for requirement in requirements:
        package = _dependency_name(requirement)
        if package in DATABASE_PACKAGES:
            findings.append(
                _finding(
                    "DATABASE_DEPENDENCY",
                    relative_path,
                    1,
                    f"requirement:{package}",
                )
            )
        if package in DIRECT_CLOUD_PACKAGES:
            findings.append(
                _finding(
                    "CLOUD_SDK_DEPENDENCY",
                    relative_path,
                    1,
                    f"requirement:{package}",
                )
            )
    return findings


def _is_allowed_plain_http_url(url: str) -> bool:
    hostname = (urlsplit(url).hostname or "").lower().rstrip(".")
    return (
        hostname in {"127.0.0.1", "::1", "localhost"}
        or hostname in {"example.com", "example.net", "example.org"}
        or hostname.endswith((".example.com", ".example.net", ".example.org"))
    )


def _approved_adr_plain_http_endpoint(
    relative_path: str,
    text: str,
    url: str,
) -> bool:
    """Accept only the two structurally marked ADR 0001 HTTP entries.

    The URL digest prevents the scanner source from containing a bypassable
    clear-text list.  Parsing the endpoint catalogue stops a comment, a plain
    string constant, or an arbitrary configuration mapping from claiming the
    exception: the literal must be ``site_root`` of a ``TrustedEndpoint``
    constructor whose matching ``environment`` is one of the approved names
    and whose ``allow_plain_http`` marker is exactly ``True``.
    """

    if relative_path != ADR_PLAIN_HTTP_ENDPOINT_CATALOGUE:
        return False
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return False

    digest = _full_hash(url)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or _call_name(node) != "TrustedEndpoint":
            continue
        environment = next(
            (
                _constant_value(keyword.value)
                for keyword in node.keywords
                if keyword.arg == "environment"
            ),
            None,
        )
        site_root = next(
            (
                _constant_value(keyword.value)
                for keyword in node.keywords
                if keyword.arg == "site_root"
            ),
            None,
        )
        if not isinstance(environment, str) or not isinstance(site_root, str):
            continue
        if (
            site_root == url
            and ADR_PLAIN_HTTP_ENDPOINT_DIGESTS.get(environment) == digest
            and _call_has_literal_keyword(node, "allow_plain_http", True)
        ):
            return True
    return False


def _scan_skill(relative_path: str, text: str) -> list[Finding]:
    findings: list[Finding] = []
    checks = (
        (
            "SKILL_SECRET_ARGUMENT",
            re.compile(
                r"(?<![\w-])--(?:access-key|api-key|password|refresh-token|"
                r"secret|secret-key|token)\b",
                re.IGNORECASE,
            ),
        ),
        (
            "SKILL_ENDPOINT_OVERRIDE",
            re.compile(
                r"(?<![\w-])--(?:agent-url|api-base|api-url|asset-api-base)\b|"
                r"\bSHORTDRAMA_(?:AGENT_URL|API_BASE|API_URL|ASSET_API_BASE|"
                r"RUNS_API_URL)\b",
                re.IGNORECASE,
            ),
        ),
        (
            "SKILL_MODEL_OVERRIDE",
            re.compile(
                r"(?<![\w-])--(?:model|provider)\b|"
                r"\bdoubao-[a-z0-9-]+\b",
                re.IGNORECASE,
            ),
        ),
    )
    for rule_id, pattern in checks:
        for match in pattern.finditer(text):
            findings.append(
                _finding(
                    rule_id,
                    relative_path,
                    _line_number(text, match.start()),
                    f"{match.group(0).lower()}:{match.start()}",
                )
            )
    return findings


def collect_repository_findings(
    root: Path,
    *,
    paths: Iterable[str] | None = None,
) -> list[Finding]:
    root = root.resolve()
    findings: list[Finding] = []
    for path in _candidate_files(root, paths):
        try:
            relative_path = _relative(path, root)
        except ValueError:
            # A changed symlink may point outside the checkout.  Do not read it
            # as a repository file, and fail the security gate instead.
            findings.append(
                _finding(
                    "REPOSITORY_UNSCANNABLE_FILE",
                    path.as_posix(),
                    1,
                    "outside-repository-root",
                )
            )
            continue
        try:
            size = path.stat().st_size
        except OSError:
            findings.append(
                _finding(
                    "REPOSITORY_UNSCANNABLE_FILE",
                    relative_path,
                    1,
                    "unreadable",
                )
            )
            continue
        if size > MAX_REPOSITORY_FILE_BYTES:
            findings.append(
                _finding(
                    "REPOSITORY_FILE_TOO_LARGE",
                    relative_path,
                    1,
                    f"size>{MAX_REPOSITORY_FILE_BYTES}",
                )
            )
            continue
        if _is_sensitive_file_name(path.name):
            findings.append(
                _finding(
                    "SENSITIVE_FILE",
                    relative_path,
                    1,
                    path.name,
                )
            )
        text = _read_text(path)
        if text is None:
            findings.append(
                _finding(
                    "REPOSITORY_UNSCANNABLE_FILE",
                    relative_path,
                    1,
                    _safe_hash(path.name),
                )
            )
            continue
        findings.extend(_scan_secrets(relative_path, text))

        if (
            relative_path.startswith(("src/", "scripts/"))
            and relative_path != "scripts/security_action.py"
            and path.suffix == ".py"
        ):
            findings.extend(_scan_python(relative_path, text))

        if relative_path.startswith(".github/workflows/") and path.suffix in {
            ".yaml",
            ".yml",
        }:
            findings.extend(_scan_workflow(relative_path, text))

        if relative_path == "pyproject.toml":
            findings.extend(_scan_pyproject(root, path, text))

        if relative_path.startswith("skills/"):
            findings.extend(_scan_skill(relative_path, text))

        if relative_path.startswith(("src/", "scripts/", "skills/")):
            for match in HTTP_URL.finditer(text):
                url = match.group(0)
                if _is_allowed_plain_http_url(url) or _approved_adr_plain_http_endpoint(
                    relative_path,
                    text,
                    url,
                ):
                    continue
                findings.append(
                    _finding(
                        "INSECURE_HTTP_ENDPOINT",
                        relative_path,
                        _line_number(text, match.start()),
                        _safe_hash(url),
                        message=f"{RULE_SUMMARIES['INSECURE_HTTP_ENDPOINT']}（地址已隐藏）",
                    )
                )
            for match in CLOUD_HOST.finditer(text):
                findings.append(
                    _finding(
                        "DIRECT_CLOUD_ENDPOINT",
                        relative_path,
                        _line_number(text, match.start()),
                        _safe_hash(match.group(0)),
                        message=f"{RULE_SUMMARIES['DIRECT_CLOUD_ENDPOINT']}（地址已隐藏）",
                    )
                )

    unique = {finding.fingerprint: finding for finding in findings}
    grouped: dict[tuple[str, str], list[Finding]] = {}
    for finding in unique.values():
        grouped.setdefault((finding.rule_id, finding.path), []).append(finding)
    aggregated: list[Finding] = []
    for (rule_id, relative_path), items in grouped.items():
        ordered = sorted(items, key=lambda item: (item.line, item.fingerprint))
        if len(ordered) == 1:
            aggregated.append(ordered[0])
            continue
        aggregated.append(
            _finding(
                rule_id,
                relative_path,
                ordered[0].line,
                "aggregate:" + ",".join(item.fingerprint for item in ordered),
                message=f"{RULE_SUMMARIES[rule_id]}（当前 {len(ordered)} 处）",
            )
        )
    return sorted(
        aggregated,
        key=lambda finding: (finding.path, finding.line, finding.rule_id),
    )


def _history_text_candidate(relative_path: str) -> bool:
    path = PurePosixPath(relative_path.replace("\\", "/"))
    return (
        path.suffix.lower() in TEXT_SUFFIXES
        or path.name in ROOT_TEXT_FILES
        or _is_sensitive_file_name(path.name)
    )


def _decode_history_text(blob: bytes) -> str | None:
    if blob.startswith(b"\xef\xbb\xbf"):
        try:
            return blob.decode("utf-8-sig")
        except UnicodeDecodeError:
            return None
    if blob.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            return blob.decode("utf-16")
        except UnicodeDecodeError:
            return None
    if b"\0" in blob[:8192]:
        return None
    try:
        return blob.decode("utf-8")
    except UnicodeDecodeError:
        return None


def scan_history_secrets(
    root: Path,
    revision: str = "--all",
) -> list[Finding]:
    """Scan each reachable Git blob once without printing matched values."""

    root = root.resolve()
    objects = subprocess.run(
        ["git", "rev-list", "--objects", revision],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    paths_by_object: dict[str, set[str]] = {}
    for line in objects.splitlines():
        object_id, separator, raw_path = line.partition(" ")
        if not separator or not object_id or not raw_path:
            continue
        path = raw_path.replace("\\", "/")
        if _history_text_candidate(path):
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
    eligible: list[str] = []
    findings: dict[str, Finding] = {}
    for expected_id, raw_line in zip(object_ids, checked.splitlines(), strict=True):
        parts = raw_line.split()
        if (
            len(parts) != 3
            or parts[0].decode("ascii", errors="ignore") != expected_id
        ):
            raise subprocess.CalledProcessError(
                1,
                ["git", "cat-file", "--batch-check"],
            )
        if parts[1] != b"blob":
            # Gitlinks/submodules can appear with a path but have commit type.
            continue
        try:
            size = int(parts[2])
        except ValueError as error:
            raise subprocess.CalledProcessError(
                1,
                ["git", "cat-file", "--batch-check"],
            ) from error
        if size > MAX_HISTORY_BLOB_BYTES:
            for path in sorted(paths_by_object[expected_id]):
                finding = _finding(
                    "HISTORY_UNSCANNABLE_BLOB",
                    path,
                    1,
                    f"{expected_id}:oversize:{size}",
                    message=(
                        f"{RULE_SUMMARIES['HISTORY_UNSCANNABLE_BLOB']} "
                        f"（history-object:{expected_id[:12]}；超过大小上限）"
                    ),
                )
                findings[finding.fingerprint] = finding
            continue
        eligible.append(expected_id)
    if not eligible:
        return sorted(
            findings.values(),
            key=lambda finding: (finding.path, finding.line, finding.fingerprint),
        )

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

    for object_id in eligible:
        blob = blobs[object_id]
        text = _decode_history_text(blob)
        if text is None:
            for path in sorted(paths_by_object[object_id]):
                finding = _finding(
                    "HISTORY_UNSCANNABLE_BLOB",
                    path,
                    1,
                    f"{object_id}:encoding",
                    message=(
                        f"{RULE_SUMMARIES['HISTORY_UNSCANNABLE_BLOB']} "
                        f"（history-object:{object_id[:12]}；编码或二进制内容）"
                    ),
                )
                findings[finding.fingerprint] = finding
            continue
        for path in sorted(paths_by_object[object_id]):
            for secret in _scan_secrets(path, text):
                finding = _finding(
                    "HISTORY_SECRET",
                    path,
                    secret.line,
                    f"{object_id}:{secret.fingerprint}",
                    message=(
                        f"{RULE_SUMMARIES['HISTORY_SECRET']} "
                        f"（history-object:{object_id[:12]}；值已隐藏）"
                    ),
                )
                findings[finding.fingerprint] = finding
    return sorted(
        findings.values(),
        key=lambda finding: (finding.path, finding.line, finding.fingerprint),
    )


def _revision_range(value: str) -> str:
    if not re.fullmatch(
        r"[0-9a-fA-F]{7,64}(?:\.\.[0-9a-fA-F]{7,64})?",
        value,
    ):
        raise argparse.ArgumentTypeError(
            "history range must be a commit SHA or BASE_SHA..HEAD_SHA"
        )
    return value


def _git_commit(root: Path, revision: str) -> str:
    """Resolve a commit without ever embedding a revision in a shell command."""

    completed = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"{revision}^{{commit}}"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    resolved = completed.stdout.strip()
    if completed.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40}", resolved):
        raise ValueError("Git 差异范围包含不可解析的提交")
    return resolved


def _safe_changed_path(value: str) -> str:
    """Return a repository-relative Git path or reject it before filesystem I/O."""

    normalized = value.replace("\\", "/")
    path = PurePosixPath(normalized)
    if (
        not normalized
        or path.is_absolute()
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise ValueError("Git 差异包含不安全的文件路径")
    return normalized


def changed_repository_paths(root: Path, revision: str) -> set[str]:
    """Return the current-tree files introduced or modified by a Git revision.

    A single SHA means ``SHA..HEAD``.  A supplied range must end at the checked
    out commit: scanning a different revision while reading the current working
    tree would create a false sense of coverage.  Deleted paths are deliberately
    excluded because they have no current content; ``--history`` covers secrets
    in deleted blobs.
    """

    root = root.resolve()
    base, separator, requested_head = revision.partition("..")
    head = requested_head if separator else "HEAD"
    resolved_base = _git_commit(root, base)
    resolved_head = _git_commit(root, head)
    current_head = _git_commit(root, "HEAD")
    if resolved_head != current_head:
        raise ValueError("Git 差异范围的结束提交不是当前工作树 HEAD")

    completed = subprocess.run(
        [
            "git",
            "diff",
            "--name-only",
            "-z",
            "--find-renames",
            "--diff-filter=ACMRTUXB",
            f"{resolved_base}..{resolved_head}",
            "--",
        ],
        cwd=root,
        check=True,
        capture_output=True,
    )
    return {
        _safe_changed_path(raw_path.decode("utf-8", errors="strict"))
        for raw_path in completed.stdout.split(b"\0")
        if raw_path
    }


def _parse_iso_date(value: object, field: str, fingerprint: str) -> tuple[date | None, str | None]:
    if not isinstance(value, str):
        return None, f"{fingerprint}: {field} 必须是 YYYY-MM-DD"
    try:
        return date.fromisoformat(value), None
    except ValueError:
        return None, f"{fingerprint}: {field} 必须是 YYYY-MM-DD"


def apply_baseline(
    findings: Sequence[Finding],
    baseline_path: Path,
    *,
    today: date | None = None,
) -> ScanResult:
    current_date = today or date.today()
    if not baseline_path.exists():
        return ScanResult(list(findings), [], [], [f"缺少安全基线文件：{baseline_path}"])
    try:
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return ScanResult(list(findings), [], [], [f"安全基线无法解析：{error}"])

    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(baseline, dict) or baseline.get("schema_version") != BASELINE_SCHEMA_VERSION:
        return ScanResult(
            list(findings),
            [],
            [],
            [f"安全基线 schema_version 必须为 {BASELINE_SCHEMA_VERSION}"],
        )
    entries = baseline.get("entries")
    if not isinstance(entries, list):
        return ScanResult(list(findings), [], [], ["安全基线 entries 必须是数组"])

    findings_by_id = {finding.fingerprint: finding for finding in findings}
    accepted: dict[str, dict[str, object]] = {}
    for index, entry in enumerate(entries):
        label = f"entries[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{label}: 必须是对象")
            continue
        fingerprint = entry.get("fingerprint")
        if not isinstance(fingerprint, str) or not fingerprint:
            errors.append(f"{label}: fingerprint 不能为空")
            continue
        if fingerprint in accepted:
            errors.append(f"{fingerprint}: 基线条目重复")
            continue
        accepted[fingerprint] = entry

        finding = findings_by_id.get(fingerprint)
        if finding is None:
            errors.append(f"{fingerprint}: 已失效的基线条目，修复代码时必须同步删除")
            continue
        if finding.rule_id in NON_BASELINABLE_RULES:
            errors.append(f"{fingerprint}: {finding.rule_id} 不允许建立基线")
        if entry.get("rule_id") != finding.rule_id or entry.get("path") != finding.path:
            errors.append(f"{fingerprint}: rule_id/path 与实际发现不一致")
        owner = entry.get("owner")
        reason = entry.get("reason")
        removal_plan = entry.get("removal_plan")
        if not isinstance(owner, str) or len(owner.strip()) < 3:
            errors.append(f"{fingerprint}: owner 必须明确")
        if not isinstance(reason, str) or len(reason.strip()) < 12:
            errors.append(f"{fingerprint}: reason 必须解释遗留原因")
        if not isinstance(removal_plan, str) or len(removal_plan.strip()) < 12:
            errors.append(f"{fingerprint}: removal_plan 必须写明移除方案")

        created_on, created_error = _parse_iso_date(
            entry.get("created_on"),
            "created_on",
            fingerprint,
        )
        expires_on, expiry_error = _parse_iso_date(
            entry.get("expires_on"),
            "expires_on",
            fingerprint,
        )
        errors.extend(error for error in (created_error, expiry_error) if error)
        if created_on is None or expires_on is None:
            continue
        if created_on > current_date:
            errors.append(
                f"{fingerprint}: created_on 不能晚于当前日期 "
                f"{current_date.isoformat()}"
            )
        if expires_on < current_date:
            errors.append(f"{fingerprint}: 基线已于 {expires_on.isoformat()} 到期")
        if expires_on < created_on:
            errors.append(f"{fingerprint}: expires_on 早于 created_on")
        if (expires_on - created_on).days > MAX_BASELINE_LIFETIME_DAYS:
            errors.append(
                f"{fingerprint}: 基线有效期超过 {MAX_BASELINE_LIFETIME_DAYS} 天",
            )
        remaining = (expires_on - current_date).days
        if 0 <= remaining <= EXPIRY_WARNING_DAYS:
            warnings.append(
                f"{fingerprint}: 基线将在 {remaining} 天后到期（{expires_on.isoformat()}）",
            )

    suppressed = [
        finding for finding in findings if finding.fingerprint in accepted
    ]
    active = [
        finding for finding in findings if finding.fingerprint not in accepted
    ]
    return ScanResult(active, suppressed, warnings, errors)


def _baseline_fingerprints(path: Path) -> tuple[set[str], list[str]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return set(), [f"无法读取对比基线 {path}：{type(error).__name__}"]
    if (
        not isinstance(document, dict)
        or document.get("schema_version") != BASELINE_SCHEMA_VERSION
        or not isinstance(document.get("entries"), list)
    ):
        return set(), [f"对比基线 {path} 的 schema/entries 无效"]
    fingerprints: set[str] = set()
    for index, entry in enumerate(document["entries"]):
        if not isinstance(entry, dict) or not isinstance(
            entry.get("fingerprint"),
            str,
        ):
            return set(), [f"对比基线 {path} 的 entries[{index}] 无效"]
        fingerprints.add(entry["fingerprint"])
    return fingerprints, []


def scan_repository(
    root: Path,
    *,
    baseline_path: Path | None = None,
    baseline_base_path: Path | None = None,
    today: date | None = None,
    strict: bool = False,
    changed_since: str | None = None,
) -> ScanResult:
    root = root.resolve()
    if changed_since is not None:
        if baseline_path is not None or strict:
            return ScanResult(
                [],
                [],
                [],
                ["差异仓库扫描不接受 --baseline 或 --strict；发布必须使用全仓严格扫描"],
            )
        changed_paths = changed_repository_paths(root, changed_since)
        # A baseline describes findings in the whole repository.  Applying it
        # to only a diff would let a stale entry look like an error, or worse,
        # suppress a newly changed line.  Diff mode therefore has no suppression
        # hatch: every finding in the changed files is active.  A base snapshot
        # may still be compared below, solely to prevent baseline growth.
        result = ScanResult(
            active=collect_repository_findings(root, paths=changed_paths),
            suppressed=[],
            warnings=[],
            baseline_errors=[],
        )
        if baseline_base_path is not None:
            resolved_baseline = root / ".security" / "security-baseline.json"
            current_ids, current_errors = _baseline_fingerprints(resolved_baseline)
            base_ids, base_errors = _baseline_fingerprints(baseline_base_path)
            new_ids = sorted(current_ids - base_ids)
            result.baseline_errors.extend([*current_errors, *base_errors])
            if new_ids:
                result.baseline_errors.append(
                    "安全基线只能缩小；相对目标分支新增或替换了 "
                    f"{len(new_ids)} 个 fingerprint"
                )
        return result

    findings = collect_repository_findings(root)
    resolved_baseline = baseline_path or root / ".security" / "security-baseline.json"
    result = apply_baseline(findings, resolved_baseline, today=today)
    if baseline_base_path is not None:
        current_ids, current_errors = _baseline_fingerprints(resolved_baseline)
        base_ids, base_errors = _baseline_fingerprints(baseline_base_path)
        new_ids = sorted(current_ids - base_ids)
        monotonic_errors = [*current_errors, *base_errors]
        if new_ids:
            monotonic_errors.append(
                "安全基线只能缩小；相对目标分支新增或替换了 "
                f"{len(new_ids)} 个 fingerprint"
            )
        result.baseline_errors.extend(monotonic_errors)
    if not strict:
        return result
    production_debt = [
        finding
        for finding in result.suppressed
        if finding.rule_id in PRODUCTION_BLOCKING_RULES
    ]
    if not production_debt:
        return result
    active_by_fingerprint = {
        finding.fingerprint: finding
        for finding in [*result.active, *production_debt]
    }
    return ScanResult(
        active=sorted(
            active_by_fingerprint.values(),
            key=lambda finding: (finding.path, finding.line, finding.rule_id),
        ),
        suppressed=[
            finding
            for finding in result.suppressed
            if finding.rule_id not in PRODUCTION_BLOCKING_RULES
        ],
        warnings=result.warnings,
        baseline_errors=result.baseline_errors,
    )


def _artifact_text_views(data: bytes) -> tuple[list[str], bool]:
    views: list[str] = []
    decoded_as_text = False
    if data.startswith(b"\xef\xbb\xbf"):
        try:
            views.append(data.decode("utf-8-sig"))
            decoded_as_text = True
        except UnicodeDecodeError:
            pass
    elif data.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            views.append(data.decode("utf-16"))
            decoded_as_text = True
        except UnicodeDecodeError:
            pass
    elif b"\0" in data[:8192]:
        if len(data) % 2 == 0:
            even_nuls = data[0::2].count(0)
            odd_nuls = data[1::2].count(0)
            encoding = "utf-16-le" if odd_nuls >= even_nuls else "utf-16-be"
            try:
                decoded = data.decode(encoding)
                if "\0" not in decoded[:4096]:
                    views.append(decoded)
                    decoded_as_text = True
            except UnicodeDecodeError:
                pass
    else:
        try:
            views.append(data.decode("utf-8"))
            decoded_as_text = True
        except UnicodeDecodeError:
            pass

    # A byte-oriented view still finds ASCII secrets embedded in executables.
    views.append(data.decode("latin-1", errors="ignore"))
    return list(dict.fromkeys(views)), decoded_as_text


def _artifact_secret_findings(path: str, data: bytes) -> list[Finding]:
    views, decoded_as_text = _artifact_text_views(data)
    findings: dict[str, Finding] = {}
    for text in views:
        for finding in _scan_secrets(path, text):
            artifact_finding = Finding(
                rule_id="ARTIFACT_SECRET",
                path=finding.path,
                line=finding.line,
                message="发布制品包含疑似秘密（值已隐藏）",
                fingerprint=_fingerprint(
                    "ARTIFACT_SECRET",
                    finding.path,
                    finding.fingerprint,
                ),
            )
            findings[artifact_finding.fingerprint] = artifact_finding
    if _history_text_candidate(path) and not decoded_as_text:
        finding = _finding(
            "ARTIFACT_UNSCANNABLE_FILE",
            path,
            1,
            f"unscannable:{len(data)}",
        )
        findings[finding.fingerprint] = finding
    return sorted(
        findings.values(),
        key=lambda finding: (finding.path, finding.line, finding.rule_id),
    )


def _artifact_name_finding(path: str) -> Finding | None:
    parts = PurePosixPath(path.replace("\\", "/")).parts
    sensitive = next((part for part in parts if _is_sensitive_file_name(part)), None)
    if sensitive is None:
        return None
    return _finding(
        "ARTIFACT_SENSITIVE_FILE",
        path,
        1,
        sensitive,
        message=f"发布制品包含敏感文件：{sensitive}",
    )


@dataclass(slots=True)
class _ArtifactBudget:
    members: int = 0
    total_bytes: int = 0

    def consume(self, size: int, path: str) -> None:
        self.members += 1
        self.total_bytes += size
        if self.members > MAX_ARTIFACT_MEMBERS:
            raise ValueError(f"{path}: 压缩包成员数超过安全上限")
        if size > MAX_ARTIFACT_MEMBER_BYTES:
            raise ValueError(f"{path}: 单个解压成员超过安全上限")
        if self.total_bytes > MAX_ARTIFACT_TOTAL_BYTES:
            raise ValueError(f"{path}: 压缩包累计解压大小超过安全上限")


def _looks_like_tar(path: str, data: bytes) -> bool:
    lowered = path.lower()
    return (
        lowered.endswith((".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz"))
        or data.startswith((b"\x1f\x8b", b"BZh", b"\xfd7zXZ\x00"))
        or (len(data) > 262 and data[257:262] == b"ustar")
    )


def _scan_embedded_artifact(
    display_path: str,
    data: bytes,
    *,
    depth: int,
    budget: _ArtifactBudget,
) -> list[Finding]:
    findings = _artifact_secret_findings(display_path, data)
    buffer = io.BytesIO(data)
    is_zip = zipfile.is_zipfile(buffer)
    is_tar = not is_zip and _looks_like_tar(display_path, data)
    if not is_zip and not is_tar:
        return findings
    if depth >= MAX_ARTIFACT_DEPTH:
        raise ValueError(
            f"{display_path}: 嵌套压缩包深度超过 {MAX_ARTIFACT_DEPTH} 层"
        )
    buffer.seek(0)
    if is_zip:
        with zipfile.ZipFile(buffer) as archive:
            findings.extend(
                _scan_zip_members(
                    archive,
                    display_path,
                    depth=depth + 1,
                    budget=budget,
                )
            )
        return findings
    try:
        with tarfile.open(fileobj=buffer, mode="r:*") as archive:
            findings.extend(
                _scan_tar_members(
                    archive,
                    display_path,
                    depth=depth + 1,
                    budget=budget,
                )
            )
    except tarfile.ReadError as error:
        raise ValueError(f"{display_path}: 疑似压缩包但无法安全解析") from error
    return findings


def _scan_zip_members(
    archive: zipfile.ZipFile,
    container: str,
    *,
    depth: int,
    budget: _ArtifactBudget,
) -> list[Finding]:
    findings: list[Finding] = []
    for member in archive.infolist():
        if member.is_dir():
            continue
        display_path = f"{container}!/{member.filename}"
        budget.consume(member.file_size, display_path)
        name_finding = _artifact_name_finding(display_path)
        if name_finding:
            findings.append(name_finding)
        findings.extend(
            _scan_embedded_artifact(
                display_path,
                archive.read(member),
                depth=depth,
                budget=budget,
            )
        )
    return findings


def _scan_tar_members(
    archive: tarfile.TarFile,
    container: str,
    *,
    depth: int,
    budget: _ArtifactBudget,
) -> list[Finding]:
    findings: list[Finding] = []
    for member in archive.getmembers():
        if not member.isfile():
            continue
        display_path = f"{container}!/{member.name}"
        budget.consume(member.size, display_path)
        name_finding = _artifact_name_finding(display_path)
        if name_finding:
            findings.append(name_finding)
        source = archive.extractfile(member)
        if source is not None:
            findings.extend(
                _scan_embedded_artifact(
                    display_path,
                    source.read(),
                    depth=depth,
                    budget=budget,
                )
            )
    return findings


def _scan_zip(path: Path) -> list[Finding]:
    with zipfile.ZipFile(path) as archive:
        return _scan_zip_members(
            archive,
            path.as_posix(),
            depth=0,
            budget=_ArtifactBudget(),
        )


def _scan_tar(path: Path) -> list[Finding]:
    with tarfile.open(path, "r:*") as archive:
        return _scan_tar_members(
            archive,
            path.as_posix(),
            depth=0,
            budget=_ArtifactBudget(),
        )


def collect_artifact_findings(paths: Iterable[Path]) -> tuple[list[Finding], list[str]]:
    findings: list[Finding] = []
    errors: list[str] = []
    files: list[Path] = []
    for requested in paths:
        if requested.is_dir():
            files.extend(path for path in sorted(requested.rglob("*")) if path.is_file())
        elif requested.is_file():
            files.append(requested)
        else:
            errors.append(f"制品路径不存在：{requested}")

    for path in files:
        name_finding = _artifact_name_finding(path.as_posix())
        if name_finding:
            findings.append(name_finding)
        try:
            if zipfile.is_zipfile(path):
                findings.extend(_scan_zip(path))
            elif tarfile.is_tarfile(path):
                findings.extend(_scan_tar(path))
            elif path.stat().st_size <= MAX_ARTIFACT_MEMBER_BYTES:
                findings.extend(_artifact_secret_findings(path.as_posix(), path.read_bytes()))
            else:
                errors.append(f"{path}: 单个制品超过安全扫描上限")
        except (OSError, tarfile.TarError, zipfile.BadZipFile, ValueError) as error:
            errors.append(str(error))
    unique = {finding.fingerprint: finding for finding in findings}
    return sorted(unique.values(), key=lambda item: (item.path, item.line)), errors


def _print_result(result: ScanResult, output_format: str) -> None:
    if output_format == "json":
        print(
            json.dumps(
                {
                    "ok": result.ok,
                    "active": [finding.to_dict() for finding in result.active],
                    "suppressed": [
                        finding.to_dict() for finding in result.suppressed
                    ],
                    "warnings": result.warnings,
                    "baseline_errors": result.baseline_errors,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    for error in result.baseline_errors:
        print(f"::error title=Security baseline::{error}")
    for finding in result.active:
        print(
            f"::error file={finding.path},line={finding.line},"
            f"title={finding.rule_id}::{finding.message} "
            f"[{finding.fingerprint}]"
        )
    for warning in result.warnings:
        print(f"::warning title=Security baseline::{warning}")
    print(
        "security-action: "
        f"active={len(result.active)} "
        f"baselined={len(result.suppressed)} "
        f"baseline_errors={len(result.baseline_errors)}"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    repository = subparsers.add_parser(
        "repository",
        help="扫描仓库并应用精确、限时的迁移基线",
    )
    repository.add_argument("--root", type=Path, default=Path("."))
    repository.add_argument("--baseline", type=Path)
    repository.add_argument(
        "--baseline-base",
        type=Path,
        help="目标分支基线快照；提供后当前 baseline 只能删除条目",
    )
    repository.add_argument(
        "--strict",
        action="store_true",
        help="发布模式：生产阻断规则不接受历史基线",
    )
    scan_scope = repository.add_mutually_exclusive_group()
    scan_scope.add_argument(
        "--history",
        action="store_true",
        help="扫描全部可达 Git 历史；不接受基线",
    )
    scan_scope.add_argument(
        "--history-range",
        type=_revision_range,
        help="只扫描 SHA 或 BASE_SHA..HEAD_SHA 引入的 Git 对象；不接受基线",
    )
    scan_scope.add_argument(
        "--changed-since",
        type=_revision_range,
        help=(
            "只扫描相对 SHA 或 BASE_SHA..HEAD_SHA 改动的当前文件；"
            "不接受 --baseline 或 --strict；可配合 --baseline-base 只校验基线不增长"
        ),
    )
    repository.add_argument("--format", choices=("text", "json"), default="text")

    artifacts = subparsers.add_parser(
        "artifacts",
        help="零豁免扫描发布目录、文件和压缩包",
    )
    artifacts.add_argument("paths", nargs="+", type=Path)
    artifacts.add_argument("--format", choices=("text", "json"), default="text")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.command == "repository":
        root = arguments.root.resolve()
        if arguments.history or arguments.history_range:
            try:
                history_findings = scan_history_secrets(
                    root,
                    arguments.history_range or "--all",
                )
                result = ScanResult(history_findings, [], [], [])
            except (OSError, subprocess.CalledProcessError) as error:
                result = ScanResult(
                    [],
                    [],
                    [],
                    [f"Git 历史扫描失败：{type(error).__name__}"],
                )
            _print_result(result, arguments.format)
            return 0 if result.ok else 1
        if arguments.changed_since:
            if arguments.baseline or arguments.strict:
                result = ScanResult(
                    [],
                    [],
                    [],
                    ["差异仓库扫描不接受 --baseline 或 --strict；发布必须使用全仓严格扫描"],
                )
            else:
                try:
                    baseline_base = arguments.baseline_base
                    if baseline_base is not None and not baseline_base.is_absolute():
                        baseline_base = root / baseline_base
                    result = scan_repository(
                        root,
                        baseline_base_path=baseline_base,
                        changed_since=arguments.changed_since,
                    )
                except (
                    OSError,
                    UnicodeDecodeError,
                    ValueError,
                    subprocess.CalledProcessError,
                ) as error:
                    result = ScanResult(
                        [],
                        [],
                        [],
                        [f"Git 差异扫描失败：{type(error).__name__}"],
                    )
            _print_result(result, arguments.format)
            return 0 if result.ok else 1
        baseline = arguments.baseline
        if baseline is not None and not baseline.is_absolute():
            baseline = root / baseline
        baseline_base = arguments.baseline_base
        if baseline_base is not None and not baseline_base.is_absolute():
            baseline_base = root / baseline_base
        result = scan_repository(
            root,
            baseline_path=baseline,
            baseline_base_path=baseline_base,
            strict=arguments.strict,
        )
        _print_result(result, arguments.format)
        return 0 if result.ok else 1

    findings, errors = collect_artifact_findings(arguments.paths)
    result = ScanResult(findings, [], [], errors)
    _print_result(result, arguments.format)
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
