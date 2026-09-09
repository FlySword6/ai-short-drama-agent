from __future__ import annotations

import io
import json
import subprocess
import zipfile
from datetime import date
from pathlib import Path

import scripts.security_action as security_action
from scripts.security_action import (
    FULL_COMMIT_REF,
    WORKFLOW_USES,
    apply_baseline,
    collect_artifact_findings,
    collect_repository_findings,
    scan_history_secrets,
    scan_repository,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CREATED_ON = "2026-08-03"
EXPIRES_ON = "2026-10-02"
SAFE_RELEASE_WORKFLOW = """
name: Release
permissions:
  contents: read
jobs:
  security:
    outputs:
      audited_commit: ${{ steps.provenance.outputs.audited_commit }}
    steps:
      - uses: actions/checkout@1111111111111111111111111111111111111111
        with:
          persist-credentials: false
      - id: provenance
        run: |
          git merge-base --is-ancestor refs/tags/v1 origin/main
          echo "audited_commit=1111111111111111111111111111111111111111" >> "${GITHUB_OUTPUT}"
      - run: python scripts/security_action.py repository --root . --strict
  build:
    needs: security
    steps:
      - uses: actions/checkout@2222222222222222222222222222222222222222
        with:
          ref: ${{ needs.security.outputs.audited_commit }}
          persist-credentials: false
      - run: python scripts/security_action.py artifacts release-assets
  publish:
    needs: [security, build]
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@3333333333333333333333333333333333333333
        with:
          ref: ${{ needs.security.outputs.audited_commit }}
          persist-credentials: false
      - run: git merge-base --is-ancestor refs/tags/v1 origin/main
      - run: python scripts/security_action.py artifacts release-assets
"""


STAGED_RELEASE_WORKFLOW = """
name: Release
permissions:
  contents: read
jobs:
  security:
    outputs:
      audited_commit: ${{ steps.provenance.outputs.audited_commit }}
    steps:
      - uses: actions/checkout@1111111111111111111111111111111111111111
        with:
          persist-credentials: false
      - id: provenance
        run: |
          git merge-base --is-ancestor refs/tags/v1 origin/main
          echo "audited_commit=1111111111111111111111111111111111111111" >> "${GITHUB_OUTPUT}"
      - run: python scripts/security_action.py repository --root . --strict
  build:
    needs: security
    steps:
      - uses: actions/checkout@2222222222222222222222222222222222222222
        with:
          ref: ${{ needs.security.outputs.audited_commit }}
          persist-credentials: false
      - run: python scripts/security_action.py artifacts release-assets
  stage:
    needs: [security, build]
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@3333333333333333333333333333333333333333
        with:
          ref: ${{ needs.security.outputs.audited_commit }}
          persist-credentials: false
      - run: git merge-base --is-ancestor refs/tags/v1 origin/main
      - run: python scripts/security_action.py artifacts release-assets
  release-gate:
    needs: [security, stage]
    steps:
      - uses: actions/checkout@4444444444444444444444444444444444444444
        with:
          ref: ${{ needs.security.outputs.audited_commit }}
          token: ${{ secrets.CROSS_REPO_TOKEN }}
          persist-credentials: false
      - run: git merge-base --is-ancestor refs/tags/v1 origin/main
  publish:
    needs: release-gate
    permissions:
      contents: write
    steps:
      - run: gh release edit v1 --draft=false
"""


def _write(path: Path, value: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")
    return path


def _baseline_entry(finding, *, expires_on: str = EXPIRES_ON) -> dict[str, str]:
    return {
        "fingerprint": finding.fingerprint,
        "rule_id": finding.rule_id,
        "path": finding.path,
        "owner": "CLI security maintainer",
        "reason": "Existing migration debt verified during the initial security rollout.",
        "removal_plan": "Replace this exact legacy path with the managed backend boundary.",
        "created_on": CREATED_ON,
        "expires_on": expires_on,
    }


def _write_baseline(path: Path, entries: list[dict[str, str]]) -> Path:
    return _write(
        path,
        json.dumps({"schema_version": 1, "entries": entries}, indent=2),
    )


def test_secret_assignments_are_non_suppressible_and_redacted(tmp_path: Path) -> None:
    names = (
        "runtime_apikey",
        "runtime_api_key",
        "authorization",
        "bearer",
        "VOLCENGINE_SK",
        "ARK_API_KEY",
        "SHORTDRAMA_API_TOKEN",
    )
    secret_values = [
        f"Unit{index}_" + ("Q9zY7x" * 5) for index in range(len(names))
    ]
    for index, (name, secret_value) in enumerate(zip(names, secret_values)):
        _write(
            tmp_path / "config" / f"secret-{index}.yaml",
            f"{name}: '{secret_value}'\n",
        )
    unquoted_value = "U5tS4rQ3pN2mL9kJ8hG7fD6s"
    _write(
        tmp_path / "config" / "unquoted.yaml",
        f"runtime_apikey: {unquoted_value}\n",
    )

    findings = collect_repository_findings(tmp_path)
    secrets = [finding for finding in findings if finding.rule_id == "SECRET_LITERAL"]

    assert len(secrets) == len(secret_values) + 1
    serialized = json.dumps([finding.to_dict() for finding in secrets])
    assert all(secret_value not in serialized for secret_value in secret_values)
    assert unquoted_value not in serialized

    baseline = _write_baseline(
        tmp_path / ".security" / "security-baseline.json",
        [_baseline_entry(secrets[0])],
    )
    result = apply_baseline(findings, baseline, today=date(2026, 8, 10))

    assert not result.ok
    assert any("不允许建立基线" in error for error in result.baseline_errors)


def test_real_secrets_containing_sample_words_are_not_exempted(
    tmp_path: Path,
) -> None:
    secret_values = (
        "Q8z_" + "test" + "_R7yW6vU5tS4pN3mK2",
        "test-" + "A9zY8xW7vU6tS5rQ4pN3",
    )
    for index, secret_value in enumerate(secret_values):
        _write(
            tmp_path / "config" / f"production-{index}.yaml",
            f"runtime_apikey: '{secret_value}'\n",
        )

    findings = collect_repository_findings(tmp_path)
    secrets = [finding for finding in findings if finding.rule_id == "SECRET_LITERAL"]

    assert len(secrets) == len(secret_values)
    serialized = json.dumps([finding.to_dict() for finding in secrets])
    assert all(secret_value not in serialized for secret_value in secret_values)


def test_repository_policy_detects_cli_boundary_violations(tmp_path: Path) -> None:
    _write(
        tmp_path / "pyproject.toml",
        """
[project]
dependencies = ["psycopg>=3", "openai>=1"]
""",
    )
    _write(
        tmp_path / "src" / "shortdrama_cli" / "cli" / "unsafe.py",
        """
import typer

def command(
    token: str = typer.Option(None, "--credential"),
    token_file: str = typer.Option(None),
    api_base: str = typer.Option(None, "--backend"),
):
    prompt = "private input"
    typer.echo(prompt)
""",
    )
    _write(
        tmp_path / "src" / "shortdrama_cli" / "providers" / "remote.py",
        """
from urllib.request import urlopen

DEFAULT = "https://demo.volceapi.com/invoke"

def invoke():
    return urlopen(DEFAULT)
""",
    )
    _write(
        tmp_path / "src" / "shortdrama_cli" / "providers" / "mock.py",
        "from urllib.request import urlopen\n\ndef invoke():\n    return urlopen('https://service.invalid')\n",
    )
    _write(
        tmp_path / "src" / "shortdrama_cli" / "storage" / "session.py",
        """
def save(path, value):
    path.write_text(value)
""",
    )

    rule_ids = {finding.rule_id for finding in collect_repository_findings(tmp_path)}

    assert {
        "ARBITRARY_ENDPOINT_OPTION",
        "CLI_SECRET_OPTION",
        "CLOUD_SDK_DEPENDENCY",
        "DATABASE_DEPENDENCY",
        "DIRECT_CLOUD_ENDPOINT",
        "DIRECT_PROVIDER_NETWORK",
        "PLAINTEXT_CREDENTIAL_FILE",
        "PLAINTEXT_SESSION_STORAGE",
        "SENSITIVE_DEBUG_OUTPUT",
    } <= rule_ids
    assert any(
        finding.rule_id == "DIRECT_PROVIDER_NETWORK"
        and finding.path.endswith("providers/mock.py")
        for finding in collect_repository_findings(tmp_path)
    )


def test_annotated_typer_options_cannot_hide_inferred_sensitive_flags(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / "src" / "shortdrama_cli" / "cli" / "annotated.py",
        """
from typing import Annotated
import typer

def command(
    token: Annotated[str, typer.Option()],
    token_file: Annotated[str, typer.Option()],
    api_base: Annotated[str, typer.Option()],
):
    pass
""",
    )

    rule_ids = {
        finding.rule_id for finding in collect_repository_findings(tmp_path)
    }

    assert {
        "ARBITRARY_ENDPOINT_OPTION",
        "CLI_SECRET_OPTION",
        "PLAINTEXT_CREDENTIAL_FILE",
    } <= rule_ids


def test_repository_scan_fails_closed_on_unscannable_python_and_files(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / "src" / "shortdrama_cli" / "broken.py",
        "def broken(:\n",
    )
    _write(
        tmp_path / ".env.production",
        "MODE=production\n",
    )
    _write(
        tmp_path / "src" / "shortdrama_cli" / "large.py",
        "#" + ("x" * (2 * 1024 * 1024)),
    )

    findings = collect_repository_findings(tmp_path)
    rule_ids = {finding.rule_id for finding in findings}

    assert {
        "PYTHON_PARSE_ERROR",
        "REPOSITORY_FILE_TOO_LARGE",
        "SENSITIVE_FILE",
    } <= rule_ids


def test_plain_http_allowlist_uses_hostname_not_substring(tmp_path: Path) -> None:
    _write(
        tmp_path / "src" / "shortdrama_cli" / "config.py",
        'URL = "http://localhost.attacker.invalid/api"\n'
        'SAFE = "http://localhost/api"\n',
    )

    findings = [
        finding
        for finding in collect_repository_findings(tmp_path)
        if finding.rule_id == "INSECURE_HTTP_ENDPOINT"
    ]

    assert len(findings) == 1


def test_adr_plain_http_exception_requires_marked_endpoint_catalogue(
    tmp_path: Path,
) -> None:
    endpoint_path = (
        tmp_path
        / "src"
        / "shortdrama_cli"
        / "server_api"
        / "endpoints.py"
    )
    approved_prod = "http://101.126.6.208/"
    approved_test = "http://shortdrama-main-test.col.com/"
    _write(
        endpoint_path,
        f'''\
class TrustedEndpoint:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

TRUSTED_ENDPOINT_PROFILES = {{
    "prod": TrustedEndpoint(
        environment="prod",
        site_root="{approved_prod}",
        allow_plain_http=True,
    ),
    "test": TrustedEndpoint(
        environment="test",
        site_root="{approved_test}",
        allow_plain_http=True,
    ),
}}
''',
    )

    approved = {
        finding.rule_id
        for finding in collect_repository_findings(tmp_path)
        if finding.path == endpoint_path.relative_to(tmp_path).as_posix()
    }
    assert "INSECURE_HTTP_ENDPOINT" not in approved

    _write(
        endpoint_path,
        f'''\
class TrustedEndpoint:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

TRUSTED_ENDPOINT_PROFILES = {{
    "prod": TrustedEndpoint(
        environment="prod",
        site_root="{approved_prod}",
        allow_plain_http=False,
    ),
    "test": TrustedEndpoint(
        environment="test",
        site_root="{approved_test}",
        allow_plain_http=True,
    ),
}}
''',
    )
    unmarked = {
        finding.rule_id
        for finding in collect_repository_findings(tmp_path)
        if finding.path == endpoint_path.relative_to(tmp_path).as_posix()
    }
    assert "INSECURE_HTTP_ENDPOINT" in unmarked


def test_adr_plain_http_exception_rejects_other_paths_and_urls(tmp_path: Path) -> None:
    approved_prod = "http://101.126.6.208/"
    _write(
        tmp_path / "src" / "shortdrama_cli" / "other.py",
        f'URL = "{approved_prod}"\n',
    )
    endpoint_path = (
        tmp_path
        / "src"
        / "shortdrama_cli"
        / "server_api"
        / "endpoints.py"
    )
    _write(
        endpoint_path,
        '''\
class TrustedEndpoint:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

TRUSTED_ENDPOINT_PROFILES = {
    "prod": TrustedEndpoint(
        environment="prod",
        site_root="http://attacker.invalid/",
        allow_plain_http=True,
    ),
}
''',
    )

    findings = [
        finding
        for finding in collect_repository_findings(tmp_path)
        if finding.rule_id == "INSECURE_HTTP_ENDPOINT"
    ]
    assert len(findings) == 2


def test_session_exception_requires_private_atomic_writes_and_allowlist(
    tmp_path: Path,
) -> None:
    session_path = (
        tmp_path / "src" / "shortdrama_cli" / "storage" / "session.py"
    )
    _write(
        session_path,
        '''\
_ENVIRONMENTS = frozenset({"prod", "test", "dev"})

def save_active_environment(value):
    path = value
    path.parent.mkdir(mode=0o700)
    path.parent.chmod(0o700)
    temporary = path.with_suffix(".tmp")
    temporary.write_text({"environment": "test"})
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)

def save_session(value):
    path = value
    path.parent.mkdir(mode=0o700)
    path.parent.chmod(0o700)
    safe_value = {key: value[key] for key in ("token", "expires_at")}
    temporary = path.with_suffix(".tmp")
    temporary.write_text(safe_value)
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)
''',
    )

    safe = {
        finding.rule_id
        for finding in collect_repository_findings(tmp_path)
        if finding.path == session_path.relative_to(tmp_path).as_posix()
    }
    assert "PLAINTEXT_SESSION_STORAGE" not in safe

    _write(
        session_path,
        session_path.read_text(encoding="utf-8").replace(
            "temporary.chmod(0o600)\n    temporary.replace(path)",
            "temporary.replace(path)",
            1,
        ),
    )
    unsafe = {
        finding.rule_id
        for finding in collect_repository_findings(tmp_path)
        if finding.path == session_path.relative_to(tmp_path).as_posix()
    }
    assert "PLAINTEXT_SESSION_STORAGE" in unsafe


def test_skill_contract_blocks_external_client_bypass_guidance(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / "skills" / "unsafe" / "SKILL.md",
        """
tool --api-base https://untrusted.invalid --token SECRET_FROM_ENV
Use the `--model` option or the `--provider` option.
""",
    )

    rule_ids = {finding.rule_id for finding in collect_repository_findings(tmp_path)}

    assert {
        "SKILL_ENDPOINT_OVERRIDE",
        "SKILL_MODEL_OVERRIDE",
        "SKILL_SECRET_ARGUMENT",
    } <= rule_ids


def test_baseline_is_exact_time_bounded_and_requires_cleanup(tmp_path: Path) -> None:
    source = _write(
        tmp_path / "src" / "shortdrama_cli" / "cli" / "legacy.py",
        """
import typer

def command(token: str = typer.Option(None)):
    pass
""",
    )
    finding = collect_repository_findings(tmp_path)[0]
    baseline = _write_baseline(
        tmp_path / ".security" / "security-baseline.json",
        [_baseline_entry(finding)],
    )

    result = scan_repository(tmp_path, baseline_path=baseline, today=date(2026, 8, 10))
    assert result.ok
    assert [item.fingerprint for item in result.suppressed] == [finding.fingerprint]

    source.write_text(
        source.read_text(encoding="utf-8")
        + "\ndef second(password: str = typer.Option(None)):\n    pass\n",
        encoding="utf-8",
    )
    changed = scan_repository(
        tmp_path,
        baseline_path=baseline,
        today=date(2026, 8, 10),
    )
    assert not changed.ok
    assert changed.active
    assert any("已失效的基线条目" in error for error in changed.baseline_errors)

    source.unlink()
    stale = scan_repository(tmp_path, baseline_path=baseline, today=date(2026, 8, 10))
    assert not stale.ok
    assert any("已失效的基线条目" in error for error in stale.baseline_errors)


def test_expired_baseline_fails_closed(tmp_path: Path) -> None:
    _write(
        tmp_path / "src" / "shortdrama_cli" / "cli" / "legacy.py",
        "import typer\ndef command(token: str = typer.Option(None)):\n    pass\n",
    )
    finding = collect_repository_findings(tmp_path)[0]
    baseline = _write_baseline(
        tmp_path / ".security" / "security-baseline.json",
        [_baseline_entry(finding, expires_on="2026-08-09")],
    )

    result = scan_repository(tmp_path, baseline_path=baseline, today=date(2026, 8, 10))

    assert not result.ok
    assert any("已于 2026-08-09 到期" in error for error in result.baseline_errors)


def test_future_dated_baseline_fails_closed(tmp_path: Path) -> None:
    _write(
        tmp_path / "src" / "shortdrama_cli" / "cli" / "legacy.py",
        "import typer\ndef command(token: str = typer.Option(None)):\n    pass\n",
    )
    finding = collect_repository_findings(tmp_path)[0]
    entry = _baseline_entry(finding, expires_on="2030-02-01")
    entry["created_on"] = "2030-01-01"
    baseline = _write_baseline(
        tmp_path / ".security" / "security-baseline.json",
        [entry],
    )

    result = scan_repository(tmp_path, baseline_path=baseline, today=date(2026, 8, 10))

    assert not result.ok
    assert any("created_on 不能晚于当前日期" in error for error in result.baseline_errors)


def test_baseline_cannot_grow_relative_to_target_branch(tmp_path: Path) -> None:
    for name in ("legacy_a.py", "legacy_b.py"):
        _write(
            tmp_path / "src" / "shortdrama_cli" / "cli" / name,
            "import typer\ndef command(token: str = typer.Option(None)):\n    pass\n",
        )
    findings = collect_repository_findings(tmp_path)
    base = _write_baseline(
        tmp_path / "base-security-baseline.json",
        [_baseline_entry(findings[0])],
    )
    current = _write_baseline(
        tmp_path / ".security" / "security-baseline.json",
        [_baseline_entry(finding) for finding in findings],
    )

    result = scan_repository(
        tmp_path,
        baseline_path=current,
        baseline_base_path=base,
        today=date(2026, 8, 10),
    )

    assert not result.ok
    assert any("只能缩小" in error for error in result.baseline_errors)


def test_strict_release_mode_rejects_production_debt_baseline(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / "src" / "shortdrama_cli" / "cli" / "legacy.py",
        "import typer\ndef command(token: str = typer.Option(None)):\n    pass\n",
    )
    finding = collect_repository_findings(tmp_path)[0]
    baseline = _write_baseline(
        tmp_path / ".security" / "security-baseline.json",
        [_baseline_entry(finding)],
    )

    migration = scan_repository(
        tmp_path,
        baseline_path=baseline,
        today=date(2026, 8, 10),
    )
    release = scan_repository(
        tmp_path,
        baseline_path=baseline,
        today=date(2026, 8, 10),
        strict=True,
    )

    assert migration.ok
    assert not release.ok
    assert [item.rule_id for item in release.active] == ["CLI_SECRET_OPTION"]


def test_workflow_requires_sha_pins_and_release_scans(tmp_path: Path) -> None:
    release = _write(
        tmp_path / ".github" / "workflows" / "release.yml",
        """
name: Release
jobs:
  build:
    steps:
      - { uses: actions/checkout@v4 }
""",
    )
    rule_ids = {finding.rule_id for finding in collect_repository_findings(tmp_path)}
    assert {
        "RELEASE_ARTIFACT_SCAN_MISSING",
        "RELEASE_TAG_PROVENANCE_MISSING",
        "REPOSITORY_SECURITY_SCAN_MISSING",
        "WORKFLOW_UNPINNED_ACTION",
    } <= rule_ids

    release.write_text(SAFE_RELEASE_WORKFLOW, encoding="utf-8")
    assert not collect_repository_findings(tmp_path)

    release.write_text(
        """
name: Release
# python scripts/security_action.py repository --root . --strict
# python scripts/security_action.py artifacts release-assets
# git merge-base --is-ancestor refs/tags/v1 origin/main
jobs: {}
""",
        encoding="utf-8",
    )
    comment_only = {
        finding.rule_id for finding in collect_repository_findings(tmp_path)
    }
    assert {
        "RELEASE_ARTIFACT_SCAN_MISSING",
        "RELEASE_TAG_PROVENANCE_MISSING",
        "REPOSITORY_SECURITY_SCAN_MISSING",
    } <= comment_only


def test_release_workflow_rejects_fail_open_and_dependency_bypasses(
    tmp_path: Path,
) -> None:
    workflow = tmp_path / ".github" / "workflows" / "release.yml"
    mutations = {
        "ignored-command": (
            SAFE_RELEASE_WORKFLOW.replace(
                "repository --root . --strict",
                "repository --root . --strict || echo ignored",
            ),
            "REPOSITORY_SECURITY_SCAN_MISSING",
        ),
        "ignored-artifact-scan": (
            SAFE_RELEASE_WORKFLOW.replace(
                "artifacts release-assets",
                "artifacts release-assets || echo ignored",
            ),
            "RELEASE_ARTIFACT_SCAN_MISSING",
        ),
        "conditional-command": (
            SAFE_RELEASE_WORKFLOW.replace(
                "      - run: python scripts/security_action.py repository",
                "      - if: false\n"
                "        run: python scripts/security_action.py repository",
            ),
            "REPOSITORY_SECURITY_SCAN_MISSING",
        ),
        "broken-needs": (
            SAFE_RELEASE_WORKFLOW.replace(
                "  build:\n    needs: security",
                "  build:\n    needs: other",
            ),
            "RELEASE_JOB_DEPENDENCY_MISSING",
        ),
        "unbound-commit": (
            SAFE_RELEASE_WORKFLOW.replace(
                "          ref: ${{ needs.security.outputs.audited_commit }}",
                "          ref: refs/tags/v1",
                1,
            ),
            "RELEASE_AUDITED_COMMIT_BINDING_MISSING",
        ),
        "checkout-env-decoy": (
            SAFE_RELEASE_WORKFLOW.replace(
                "        with:\n          persist-credentials: false",
                "        env:\n"
                "          persist-credentials: false\n"
                "        with:\n"
                "          persist-credentials: true",
                1,
            ),
            "WORKFLOW_CHECKOUT_CREDENTIALS",
        ),
        "extra-write-permission": (
            SAFE_RELEASE_WORKFLOW.replace(
                "  security:\n",
                "  security:\n"
                "    permissions:\n"
                "      actions: write\n",
            ),
            "WORKFLOW_PERMISSIONS",
        ),
    }
    for name, (content, expected_rule) in mutations.items():
        _write(workflow, content)
        rule_ids = {
            finding.rule_id
            for finding in collect_repository_findings(tmp_path)
        }
        assert expected_rule in rule_ids, name


def test_release_workflow_accepts_staged_gate_and_rejects_bypasses(
    tmp_path: Path,
) -> None:
    workflow = tmp_path / ".github" / "workflows" / "release.yml"
    workflow.parent.mkdir(parents=True)
    workflow.write_text(STAGED_RELEASE_WORKFLOW, encoding="utf-8")

    assert not collect_repository_findings(tmp_path)

    mutations = {
        "stage-skips-build": (
            STAGED_RELEASE_WORKFLOW.replace(
                "  stage:\n    needs: [security, build]",
                "  stage:\n    needs: security",
            ),
            "RELEASE_JOB_DEPENDENCY_MISSING",
        ),
        "gate-skips-stage": (
            STAGED_RELEASE_WORKFLOW.replace(
                "  release-gate:\n    needs: [security, stage]",
                "  release-gate:\n    needs: security",
            ),
            "RELEASE_JOB_DEPENDENCY_MISSING",
        ),
        "stage-missing-artifact-scan": (
            STAGED_RELEASE_WORKFLOW.replace(
                "      - run: python scripts/security_action.py artifacts release-assets\n"
                "  release-gate:",
                "  release-gate:",
                1,
            ),
            "RELEASE_ARTIFACT_SCAN_MISSING",
        ),
        "gate-missing-provenance": (
            STAGED_RELEASE_WORKFLOW.replace(
                "      - run: git merge-base --is-ancestor refs/tags/v1 origin/main\n"
                "  publish:",
                "  publish:",
            ),
            "RELEASE_TAG_PROVENANCE_MISSING",
        ),
        "gate-missing-audited-binding": (
            STAGED_RELEASE_WORKFLOW.replace(
                "          ref: ${{ needs.security.outputs.audited_commit }}\n"
                "          token: ${{ secrets.CROSS_REPO_TOKEN }}",
                "          ref: refs/tags/v1\n"
                "          token: ${{ secrets.CROSS_REPO_TOKEN }}",
            ),
            "RELEASE_AUDITED_COMMIT_BINDING_MISSING",
        ),
        "gate-gets-write-permission": (
            STAGED_RELEASE_WORKFLOW.replace(
                "  release-gate:\n",
                "  release-gate:\n"
                "    permissions:\n"
                "      actions: write\n",
            ),
            "WORKFLOW_PERMISSIONS",
        ),
    }
    for name, (content, expected_rule) in mutations.items():
        workflow.write_text(content, encoding="utf-8")
        rule_ids = {
            finding.rule_id
            for finding in collect_repository_findings(tmp_path)
        }
        assert expected_rule in rule_ids, name



def test_release_scanner_accepts_single_pinned_provenance_job(tmp_path: Path) -> None:
    workflow = tmp_path / ".github" / "workflows" / "release.yml"
    workflow.parent.mkdir(parents=True)
    workflow.write_text(
        (PROJECT_ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    assert not collect_repository_findings(tmp_path)

def test_artifact_scan_has_no_baseline_and_reads_archives(tmp_path: Path) -> None:
    clean = _write(tmp_path / "clean.txt", "safe release metadata")
    clean_findings, clean_errors = collect_artifact_findings([clean])
    assert not clean_findings
    assert not clean_errors

    secret_value = "".join(("AK", "LT", "U8vW3xY7zQ2pR6sT9nM4"))
    archive_path = tmp_path / "release.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("shortdrama-cli/readme.txt", f"runtime_apikey='{secret_value}'")
        archive.writestr("shortdrama-cli/.env", "MODE=production")

    findings, errors = collect_artifact_findings([archive_path])
    serialized = json.dumps([finding.to_dict() for finding in findings])

    assert not errors
    assert {"ARTIFACT_SECRET", "ARTIFACT_SENSITIVE_FILE"} <= {
        finding.rule_id for finding in findings
    }
    assert secret_value not in serialized


def test_artifact_scan_recurses_into_nested_archives(tmp_path: Path) -> None:
    secret_value = "".join(("AK", "LT", "N8mV7cX6zL5kJ4hG3fD2"))
    inner_buffer = io.BytesIO()
    with zipfile.ZipFile(inner_buffer, "w") as inner:
        inner.writestr("payload/config.txt", f"runtime_apikey={secret_value}")
    outer_path = tmp_path / "outer.zip"
    with zipfile.ZipFile(outer_path, "w") as outer:
        outer.writestr("bundle/inner.zip", inner_buffer.getvalue())

    findings, errors = collect_artifact_findings([outer_path])
    serialized = json.dumps([finding.to_dict() for finding in findings])

    assert not errors
    assert any(finding.rule_id == "ARTIFACT_SECRET" for finding in findings)
    assert secret_value not in serialized


def test_artifact_scan_detects_prefixed_secret_name_in_utf16(
    tmp_path: Path,
) -> None:
    secret_value = "V8wX7yZ6qP5nM4kJ3hG2fD1s"
    archive_path = tmp_path / "utf16-release.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr(
            "bundle/config.json",
            f'{{"ARK_API_KEY": "{secret_value}"}}'.encode("utf-16"),
        )

    findings, errors = collect_artifact_findings([archive_path])
    serialized = json.dumps([finding.to_dict() for finding in findings])

    assert not errors
    assert "ARTIFACT_SECRET" in {finding.rule_id for finding in findings}
    assert secret_value not in serialized


def test_history_scan_finds_deleted_secret_without_printing_value(
    tmp_path: Path,
) -> None:
    def git(*arguments: str) -> None:
        subprocess.run(
            ["git", *arguments],
            cwd=tmp_path,
            check=True,
            capture_output=True,
        )

    git("init", "-q")
    git("config", "user.email", "security-test@example.invalid")
    git("config", "user.name", "Security Test")
    _write(tmp_path / "config.yaml", "MODE: safe\n")
    git("add", "config.yaml")
    git("commit", "-qm", "safe base")
    base_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    secret_value = "H7gF6dS5aP4oI3uY2tR9eW8q"
    secret_path = _write(
        tmp_path / "config.yaml",
        f"runtime_apikey: {secret_value}\n",
    )
    git("add", "config.yaml")
    git("commit", "-qm", "add synthetic secret")
    secret_path.write_text("MODE: safe again\n", encoding="utf-8")
    git("add", "config.yaml")
    git("commit", "-qm", "remove synthetic secret")
    head_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    findings = scan_history_secrets(tmp_path, f"{base_sha}..{head_sha}")
    serialized = json.dumps([finding.to_dict() for finding in findings])

    assert any(finding.rule_id == "HISTORY_SECRET" for finding in findings)
    assert secret_value not in serialized


def test_changed_since_scans_only_changed_current_files_and_fails_closed(
    tmp_path: Path,
) -> None:
    def git(*arguments: str) -> None:
        subprocess.run(
            ["git", *arguments],
            cwd=tmp_path,
            check=True,
            capture_output=True,
        )

    def commit(message: str) -> str:
        git("add", ".")
        git("commit", "-qm", message)
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=tmp_path,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    git("init", "-q")
    git("config", "user.email", "security-test@example.invalid")
    git("config", "user.name", "Security Test")
    unsafe = _write(
        tmp_path / "src" / "shortdrama_cli" / "providers" / "legacy.py",
        "from urllib.request import urlopen\n\ndef invoke():\n    return urlopen('https://legacy.invalid')\n",
    )
    commit("legacy unsafe provider")

    _write(tmp_path / "docs" / "note.md", "safe documentation\n")
    safe_head = commit("add safe note")
    safe_base = subprocess.run(
        ["git", "rev-parse", "HEAD~1"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    unchanged_legacy = scan_repository(
        tmp_path,
        changed_since=f"{safe_base}..{safe_head}",
    )
    assert unchanged_legacy.ok

    unsafe.write_text(
        unsafe.read_text(encoding="utf-8") + "\n# touched during this change\n",
        encoding="utf-8",
    )
    unsafe_base = safe_head
    unsafe_head = commit("touch unsafe legacy provider")
    changed_legacy = scan_repository(
        tmp_path,
        changed_since=f"{unsafe_base}..{unsafe_head}",
    )
    assert not changed_legacy.ok
    assert {finding.rule_id for finding in changed_legacy.active} == {
        "DIRECT_PROVIDER_NETWORK"
    }


def test_changed_since_invalid_revision_fails_closed(
    tmp_path: Path,
    capsys,
) -> None:
    exit_code = security_action.main(
        [
            "repository",
            "--root",
            str(tmp_path),
            "--changed-since",
            "deadbeef",
        ]
    )

    captured = capsys.readouterr().out
    assert exit_code == 1
    assert "Git 差异扫描失败" in captured
    assert "deadbeef" not in captured


def test_changed_since_rejects_a_range_not_ending_at_current_head(
    tmp_path: Path,
) -> None:
    def git(*arguments: str) -> None:
        subprocess.run(
            ["git", *arguments],
            cwd=tmp_path,
            check=True,
            capture_output=True,
        )

    git("init", "-q")
    git("config", "user.email", "security-test@example.invalid")
    git("config", "user.name", "Security Test")
    _write(tmp_path / "safe.txt", "first\n")
    git("add", "safe.txt")
    git("commit", "-qm", "first")
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    _write(tmp_path / "safe.txt", "second\n")
    git("add", "safe.txt")
    git("commit", "-qm", "second")
    stale_head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    _write(tmp_path / "safe.txt", "third\n")
    git("add", "safe.txt")
    git("commit", "-qm", "third")

    try:
        scan_repository(tmp_path, changed_since=f"{base}..{stale_head}")
    except ValueError as error:
        assert "不是当前工作树 HEAD" in str(error)
    else:
        raise AssertionError("差异扫描必须拒绝不以当前 HEAD 结束的范围")


def test_changed_since_rejects_release_bypass_options(tmp_path: Path) -> None:
    result = scan_repository(
        tmp_path,
        changed_since="deadbeef",
        strict=True,
    )

    assert not result.ok
    assert any("不接受 --baseline 或 --strict" in error for error in result.baseline_errors)


def test_changed_since_allows_only_baseline_monotonic_comparison(
    tmp_path: Path,
) -> None:
    def git(*arguments: str) -> None:
        subprocess.run(
            ["git", *arguments],
            cwd=tmp_path,
            check=True,
            capture_output=True,
        )

    git("init", "-q")
    git("config", "user.email", "security-test@example.invalid")
    git("config", "user.name", "Security Test")
    _write(tmp_path / "safe.py", "value = 'safe'\n")
    git("add", "safe.py")
    git("commit", "-qm", "safe base")
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    _write(tmp_path / "safe.py", "value = 'still safe'\n")
    git("add", "safe.py")
    git("commit", "-qm", "safe change")
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    baseline = _write_baseline(
        tmp_path / ".security" / "security-baseline.json",
        [],
    )
    baseline_base = _write_baseline(
        tmp_path / "base-security-baseline.json",
        [],
    )
    clean = scan_repository(
        tmp_path,
        changed_since=f"{base}..{head}",
        baseline_base_path=baseline_base,
    )
    assert clean.ok

    fake_finding = security_action._finding(
        "ARBITRARY_ENDPOINT_OPTION",
        "safe.py",
        1,
        "synthetic-baseline-growth",
    )
    _write_baseline(baseline, [_baseline_entry(fake_finding)])
    grown = scan_repository(
        tmp_path,
        changed_since=f"{base}..{head}",
        baseline_base_path=baseline_base,
    )
    assert not grown.ok
    assert any("只能缩小" in error for error in grown.baseline_errors)


def test_history_scan_fails_closed_on_oversized_text_blob(
    tmp_path: Path,
    monkeypatch,
) -> None:
    def git(*arguments: str) -> None:
        subprocess.run(
            ["git", *arguments],
            cwd=tmp_path,
            check=True,
            capture_output=True,
        )

    git("init", "-q")
    git("config", "user.email", "security-test@example.invalid")
    git("config", "user.name", "Security Test")
    monkeypatch.setattr(security_action, "MAX_HISTORY_BLOB_BYTES", 64)
    _write(tmp_path / "oversized.json", "x" * 128)
    git("add", "oversized.json")
    git("commit", "-qm", "add oversized text")

    findings = scan_history_secrets(tmp_path)

    assert {
        finding.rule_id for finding in findings
    } == {"HISTORY_UNSCANNABLE_BLOB"}


def test_checked_in_workflows_are_pinned_and_enforce_security_contract() -> None:
    security = (
        PROJECT_ROOT / ".github" / "workflows" / "security.yml"
    ).read_text(encoding="utf-8")
    release = (
        PROJECT_ROOT / ".github" / "workflows" / "release.yml"
    ).read_text(encoding="utf-8")

    for workflow in (security, release):
        external_actions = [
            match.group(1).strip("\"'")
            for match in WORKFLOW_USES.finditer(workflow)
            if not match.group(1).startswith("./")
        ]
        assert external_actions
        assert all(FULL_COMMIT_REF.fullmatch(reference) for reference in external_actions)
        checkout_count = sum(
            reference.startswith("actions/checkout@") for reference in external_actions
        )
        assert workflow.count("persist-credentials: false") == checkout_count

    assert "pip-audit==2.10.1" in security
    assert "--format cyclonedx-json" in security
    assert 'test -s "${RUNNER_TEMP}/runtime-sbom.cdx.json"' in security
    assert "actions/upload-artifact@" in security
    assert "retention-days: 14" in security
    assert "bandit==1.9.4" in security
    assert "uv run --frozen pytest -q" in security
    assert "security-action-tests:" in security
    assert "ubuntu-22.04, macos-14" in security
    assert "PYTHONPATH:" not in security
    assert "run: make security-test" in security
    assert "Repository policy (changed files)" in security
    assert "--changed-since" in security
    assert "fetch-depth: 0" in security
    assert 'git cat-file -e "${BASE_SHA}^{commit}"' in security
    assert 'git merge-base --is-ancestor "${BASE_SHA}" "${HEAD_SHA}"' in security
    assert "force-push can make github.event.before unavailable" in security
    # Both force-push fallbacks run in fork Actions with no stored checkout
    # credentials.  They must use only the already checked-out main ref;
    # neither the repository policy nor history-secret job may reintroduce a
    # credentialed remote fetch.
    assert security.count('main_ref="refs/remotes/origin/main"') == 2
    assert security.count('git show-ref --verify --quiet "${main_ref}"') == 2
    assert "Checkout did not provide the trusted main reference; refusing to skip security scanning." in security
    assert "Could not compute a comparison base; refusing to skip security scanning." in security
    assert "git fetch --no-tags origin main" not in security

    makefile = (PROJECT_ROOT / "Makefile").read_text(encoding="utf-8")
    assert "security-test:\n\t$(UV) run --frozen python -m pytest -q tests/test_security_action.py" in makefile
    assert "PYTHONPATH" not in makefile

    assert "python scripts/security_action.py repository --root . --history" in security
    assert "--history-range" in security
    assert "fetch-depth: 0" in security

    assert "security-gate:" in release
    assert "python scripts/security_action.py repository --root . --strict" in release
    assert "python scripts/security_action.py repository --root . --history" in release
    assert "python scripts/security_action.py artifacts dist/app/shortdrama-cli" in release
    assert "git merge-base --is-ancestor" in release
    assert "GITHUB_SHA" in release
    assert "github.ref_protected" in release
    assert "needs: [provenance, release-gate, security-gate]" in release
    assert "permissions:\n      contents: write" in release
