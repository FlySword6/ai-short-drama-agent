from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import zipfile
from pathlib import Path
from typing import Any

import pytest
import yaml

from scripts.release.release import (
    build_archive,
    generate_metadata,
    validate_release_provenance,
    validate_versions,
    verify_packaged_tls,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _fake_release_inputs(tmp_path: Path, *, windows: bool = False) -> tuple[Path, Path]:
    app_dir = tmp_path / "app"
    skill_dir = tmp_path / "skill"
    app_dir.mkdir()
    skill_dir.mkdir()
    executable = app_dir / ("shortdrama-cli.exe" if windows else "shortdrama-cli")
    executable.write_text("binary", encoding="utf-8")
    executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
    (skill_dir / "SKILL.md").write_text("---\nname: shortdrama-cli\n---\n", encoding="utf-8")
    (skill_dir / ".DS_Store").write_text("ignored", encoding="utf-8")
    return app_dir, skill_dir


def test_release_version_matches_project_metadata() -> None:
    assert validate_versions(PROJECT_ROOT, "v0.3.2") == "0.3.2"
    with pytest.raises(ValueError, match="do not match"):
        validate_versions(PROJECT_ROOT, "v0.3.3")


def test_volcengine_builder_defaults_to_current_release() -> None:
    source = (PROJECT_ROOT / "scripts" / "build-volcengine-release.sh").read_text(
        encoding="utf-8"
    )
    assert 'SHORTDRAMA_RELEASE_TAG:-v0.3.2' in source
    assert 'sys.version_info >= (3, 11)' in source


def test_release_provenance_requires_pinned_main_commit(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q", "--initial-branch=main"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.name", "Release Test"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "release-test@example.invalid"],
        cwd=tmp_path,
        check=True,
    )
    tracked = tmp_path / "release.txt"
    tracked.write_text("release\n", encoding="utf-8")
    subprocess.run(["git", "add", "release.txt"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "release"], cwd=tmp_path, check=True)
    release_commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, check=True, capture_output=True, text=True
    ).stdout.strip()
    subprocess.run(["git", "tag", "v0.3.2"], cwd=tmp_path, check=True)

    tracked.write_text("later\n", encoding="utf-8")
    subprocess.run(["git", "commit", "-q", "-am", "later"], cwd=tmp_path, check=True)
    later_commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, check=True, capture_output=True, text=True
    ).stdout.strip()

    assert validate_release_provenance(tmp_path, "v0.3.2", release_commit) == release_commit
    with pytest.raises(ValueError, match="exact trusted main commit"):
        validate_release_provenance(tmp_path, "v0.3.2", later_commit)
    with pytest.raises(ValueError, match="40-character"):
        validate_release_provenance(tmp_path, "v0.3.2", release_commit[:12])

def test_release_workflow_pins_one_trusted_commit_before_all_jobs() -> None:
    workflow = _load_workflow(PROJECT_ROOT / ".github" / "workflows" / "release.yml")
    triggers = workflow["on"]
    assert "push" not in triggers, "tag-sourced workflow must not self-verify untrusted code"
    assert triggers["workflow_dispatch"]["inputs"]["main_commit"]["required"] is True

    jobs = workflow["jobs"]
    provenance = jobs["provenance"]
    provenance_steps = _steps(provenance)
    provenance_command = next(
        step["run"] for step in provenance_steps if step.get("name") == "Pin trusted release commit"
    )
    assert '--main-commit "${TRUSTED_MAIN_SHA}"' in provenance_command
    assert provenance["outputs"]["release_sha"] == "${{ steps.pin.outputs.release_sha }}"
    provenance_checkout = next(step for step in provenance_steps if step.get("name") == "Check out trusted workflow commit")
    assert provenance_checkout["with"]["ref"] == "${{ github.sha }}"
    assert "github.ref_protected" in json.dumps(provenance)
    assert "git fetch" not in json.dumps(workflow)
    for job_name in ("provenance", "stage", "publish"):
        assert jobs[job_name]["environment"] == "release"

    for job_name in ("build", "stage", "security-gate", "publish"):
        needs = jobs[job_name]["needs"]
        assert "provenance" in ([needs] if isinstance(needs, str) else needs)

    build_steps = _steps(jobs["build"])
    for job_name in ("build", "stage", "security-gate"):
        checkout = next(step for step in _steps(jobs[job_name]) if step.get("name") == "Check out pinned release commit")
        assert checkout["with"]["ref"] == "${{ needs.provenance.outputs.release_sha }}"

    for job_name in ("stage", "publish"):
        write_step = next(
            step for step in _steps(jobs[job_name])
            if step.get("name", "").startswith("Recheck pinned tag")
        )
        assert "resolve-remote-tag-commit.sh" in write_step["run"]
        assert "gh release" in write_step["run"]
    assert not any(step.get("name") == "Verify exact main release provenance" for step in build_steps)


def test_remote_tag_resolver_follows_annotated_tag(tmp_path: Path) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_gh = fake_bin / "gh"
    fake_gh.write_text(
        "#!/usr/bin/env bash\n"
        "case \"$*\" in\n"
        "  *'/git/ref/tags/v0.3.2'*) printf 'tag tag-object\\n' ;;\n"
        "  *'/git/tags/tag-object'*) printf 'commit 0123456789abcdef0123456789abcdef01234567\\n' ;;\n"
        "  *) exit 1 ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    fake_gh.chmod(fake_gh.stat().st_mode | stat.S_IXUSR)
    environment = {**os.environ, "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}"}
    result = subprocess.run(
        [
            PROJECT_ROOT / "scripts" / "release" / "resolve-remote-tag-commit.sh",
            "owner/repo",
            "v0.3.2",
        ],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )
    assert result.stdout.strip() == "0123456789abcdef0123456789abcdef01234567"


def test_unix_archive_contains_cli_and_matching_skill(tmp_path: Path) -> None:
    app_dir, skill_dir = _fake_release_inputs(tmp_path)
    archive = build_archive(
        project_root=PROJECT_ROOT,
        tag="v0.3.2",
        platform="darwin",
        arch="arm64",
        app_dir=app_dir,
        skill_dir=skill_dir,
        output_dir=tmp_path / "release-assets",
    )

    with tarfile.open(archive, "r:gz") as release_tar:
        names = set(release_tar.getnames())
        executable = release_tar.getmember("shortdrama-cli/shortdrama-cli")

    assert "shortdrama-cli/skills/shortdrama-cli/SKILL.md" in names
    assert not any(name.endswith(".DS_Store") for name in names)
    if os.name != "nt":
        assert executable.mode & stat.S_IXUSR


def test_windows_archive_contains_cli_and_matching_skill(tmp_path: Path) -> None:
    app_dir, skill_dir = _fake_release_inputs(tmp_path, windows=True)
    archive = build_archive(
        project_root=PROJECT_ROOT,
        tag="v0.3.2",
        platform="windows",
        arch="x64",
        app_dir=app_dir,
        skill_dir=skill_dir,
        output_dir=tmp_path / "release-assets",
    )

    with zipfile.ZipFile(archive) as release_zip:
        names = set(release_zip.namelist())

    assert "shortdrama-cli/shortdrama-cli.exe" in names
    assert "shortdrama-cli/skills/shortdrama-cli/SKILL.md" in names


def test_release_metadata_requires_complete_platform_matrix(tmp_path: Path) -> None:
    assets = {
        "shortdrama-cli-v0.3.2-darwin-arm64.tar.gz",
        "shortdrama-cli-v0.3.2-darwin-x64.tar.gz",
        "shortdrama-cli-v0.3.2-linux-arm64.tar.gz",
        "shortdrama-cli-v0.3.2-linux-x64.tar.gz",
        "shortdrama-cli-v0.3.2-windows-x64.zip",
    }
    for name in assets:
        (tmp_path / name).write_bytes(name.encode())

    checksums, manifest = generate_metadata(
        project_root=PROJECT_ROOT,
        tag="v0.3.2",
        artifacts_dir=tmp_path,
    )
    manifest_data = json.loads(manifest.read_text(encoding="utf-8"))

    assert {asset["name"] for asset in manifest_data["assets"]} == assets
    for line in checksums.read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", maxsplit=1)
        assert digest == hashlib.sha256((tmp_path / name).read_bytes()).hexdigest()


def _load_workflow(path: Path) -> dict[str, Any]:
    workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(workflow, dict)
    # YAML 1.1 treats the unquoted GitHub key ``on`` as boolean true.
    if True in workflow and "on" not in workflow:
        workflow["on"] = workflow.pop(True)
    return workflow


def _steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    steps = job.get("steps")
    assert isinstance(steps, list)
    assert all(isinstance(step, dict) for step in steps)
    return steps


def _secret_expressions(value: Any) -> set[str]:
    if isinstance(value, dict):
        return {
            secret
            for child in value.values()
            for secret in _secret_expressions(child)
        }
    if isinstance(value, list):
        return {
            secret
            for child in value
            for secret in _secret_expressions(child)
        }
    return set(re.findall(r"secrets\.([A-Z0-9_]+)", str(value)))


def test_skill_zero_guidance_workflow_is_reusable_and_manual() -> None:
    workflow = _load_workflow(PROJECT_ROOT / ".github/workflows/skill-zero-guidance.yml")
    triggers = workflow["on"]
    assert set(triggers) == {"workflow_call", "workflow_dispatch"}
    for trigger in ("workflow_call", "workflow_dispatch"):
        tag = triggers[trigger]["inputs"]["tag"]
        assert tag["required"] is True
        assert tag["type"] == "string"

    assert workflow["permissions"] == {"contents": "read"}
    assert workflow["concurrency"] == {
        "group": "skill-zero-guidance-${{ inputs.tag }}",
        "cancel-in-progress": False,
    }
    assert set(workflow["jobs"]) == {"evaluate"}
    job = workflow["jobs"]["evaluate"]
    assert job["timeout-minutes"] == 60
    assert job["environment"] == "test"
    assert job.get("permissions", {"contents": "read"}) == {"contents": "read"}

    expected_secrets = {
        "TEST_ENV_ADMIN_USERNAME",
        "TEST_ENV_ADMIN_PASSWORD",
        "OPENAI_API_KEY",
    }
    assert set(triggers["workflow_call"]["secrets"]) == expected_secrets
    assert all(
        config["required"] is True
        for config in triggers["workflow_call"]["secrets"].values()
    )
    assert _secret_expressions(workflow) == expected_secrets
    workflow_text = json.dumps(workflow, ensure_ascii=False)
    for forbidden in (
        "CLI_E2E_REPO_TOKEN",
        "CLI_E2E_POSTGRES_URL",
        "GENERATION_QUOTES_TEST_DATABASE_URL",
        "GH_TOKEN",
    ):
        assert forbidden not in workflow_text

    steps = _steps(job)
    checkout = next(step for step in steps if step.get("name") == "Check out release tag")
    assert checkout["with"] == {
        "ref": "${{ inputs.tag }}",
        "fetch-depth": 0,
        "persist-credentials": False,
    }
    validation = next(step for step in steps if step.get("name") == "Select and verify release tag")
    validation_command = validation["run"]
    assert "git show-ref --verify --quiet" in validation_command
    assert "^v[0-9]+\\.[0-9]+\\.[0-9]+" in validation_command
    assert 'git checkout --detach "${tag_ref}"' in validation_command

    install = next(step for step in steps if step.get("name") == "Install locked dependencies and Codex")
    assert "uv sync --frozen" in install["run"]
    assert "@openai/codex@0.145.0" in install["run"]
    evaluation = next(step for step in steps if step.get("name") == "Run three clean Skill zero-guidance sessions")
    assert "scripts/e2e/run_skill_zero_guidance.py" in evaluation["run"]
    assert '--release-tag "${RELEASE_TAG}"' in evaluation["run"]
    upload = next(step for step in steps if step.get("name") == "Upload Skill zero-guidance evidence")
    assert upload["if"] == "${{ always() }}"
    assert upload["with"]["path"] == "artifacts/skill-zero-guidance/"
    assert upload["with"]["if-no-files-found"] == "warn"


def test_release_keeps_zero_guidance_independent_from_publish() -> None:
    workflow = _load_workflow(PROJECT_ROOT / ".github/workflows/release.yml")
    jobs = workflow["jobs"]
    assert "skill-zero-guidance" not in jobs
    assert set(jobs["publish"]["needs"]) == {
        "provenance",
        "release-gate",
        "security-gate",
    }

    release_gate = jobs["release-gate"]
    assert release_gate["needs"] == "stage"
    assert release_gate["permissions"] == {"contents": "read"}
    release_gate_text = json.dumps(release_gate, ensure_ascii=False)
    for forbidden in (
        "OPENAI_API_KEY",
        "skill-zero-guidance",
        "@openai/codex",
        "run_skill_zero_guidance.py",
        "GENERATION_QUOTES_TEST_DATABASE_URL",
        "CLI_E2E_POSTGRES_URL",
        "CLI_E2E_REPO_TOKEN",
        "zhongwen-shortdrama-main",
        "run-cli-paid-redlines.mts",
        "--paid-redline-summary",
        "CLI_E2E_ALLOW_PAID_GENERATION",
        "SHORTDRAMA_API_TOKEN",
        "TEST_ENV_ADMIN_PASSWORD",
        "run_cli_product_e2e.py",
    ):
        assert forbidden not in release_gate_text
    assert "actions/download-artifact@" in release_gate_text
    assert "shortdrama-cli-linux-x64" in release_gate_text
    assert "gh release create" not in release_gate_text
    assert "gh release upload" not in release_gate_text
    assert "gh release edit" not in release_gate_text
    execute_step = next(
        step for step in _steps(release_gate)
        if step.get("name") == "Execute the packaged CLI and verify the bundled Skill"
    )
    assert "shortdrama-cli --version" in execute_step["run"]
    assert "SKILL.md" in execute_step["run"]


def test_release_workflow_and_shell_installer_contract() -> None:
    workflow = (PROJECT_ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
    assert "ubuntu-22.04-arm" in workflow
    assert "macos-15-intel" in workflow
    assert "macos-15" in workflow
    assert "windows-2022" in workflow
    assert "Pin trusted release commit" in workflow
    assert '--main-commit "${TRUSTED_MAIN_SHA}"' in workflow
    assert "Release tag moved after provenance verification" in workflow
    assert "gh release create" in workflow
    assert "scripts/install-shortdrama-cli.sh" in workflow
    assert "scripts/install-shortdrama-cli.ps1" in workflow
    assert "Stage draft GitHub Release" in workflow
    assert "--draft" in workflow
    assert "run_cli_product_e2e.py" not in workflow
    assert "SHORTDRAMA_API_TOKEN" not in workflow
    assert "TEST_ENV_ADMIN_PASSWORD" not in workflow
    assert "skill-zero-guidance.yml" not in workflow
    assert "CLI_E2E_POSTGRES_URL" not in workflow
    assert "zhongwen-shortdrama-main" not in workflow
    assert "OPENAI_API_KEY" not in workflow
    assert (PROJECT_ROOT / ".github/workflows/skill-zero-guidance.yml").is_file()
    assert "gh release edit" in workflow
    assert "--draft=false" in workflow
    shell_installer = (PROJECT_ROOT / "scripts/install-shortdrama-cli.sh").read_text(encoding="utf-8")
    powershell_installer = (PROJECT_ROOT / "scripts/install-shortdrama-cli.ps1").read_text(encoding="utf-8")
    assert '"$INSTALL_ROOT/bin/shortdrama"' in shell_installer
    assert '"shortdrama.cmd"' in powershell_installer
    assert '$HOME/.bash_profile' in shell_installer

    shell = shutil.which("sh")
    if shell:
        subprocess.run(
            [shell, "-n", str(PROJECT_ROOT / "scripts/install-shortdrama-cli.sh")],
            check=True,
        )


def test_every_build_path_ships_a_ca_bundle_and_proves_it_over_https() -> None:
    """Guard issue #27: a build that skips either half looks fine until first use."""

    build_files = {
        name: (PROJECT_ROOT / name).read_text(encoding="utf-8")
        for name in (
            ".github/workflows/release.yml",
            "Makefile",
            "scripts/build-volcengine-release.sh",
        )
    }
    for name, content in build_files.items():
        assert "--collect-data certifi" in content, f"{name} packages no CA bundle"

    assert "certifi" in (PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    for name in (".github/workflows/release.yml", "scripts/build-volcengine-release.sh"):
        assert "--https-probe" in build_files[name], f"{name} never proves the packaged CLI can reach HTTPS"


def test_release_workflow_stays_parseable_by_github() -> None:
    """GitHub refuses the whole file over one bad expression, and a tag then triggers nothing.

    A job-level ``env:`` block cannot read the ``env`` context. When it does, every push
    reports a nameless 0-second failure and no release run ever starts — which is how
    v0.3.1 reached the remote with no workflow behind it.
    """

    workflow = yaml.safe_load((PROJECT_ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8"))
    offenders = [
        f"{job}.env.{key}"
        for job, config in workflow["jobs"].items()
        for key, value in (config.get("env") or {}).items()
        if "env." in str(value)
    ]
    assert offenders == [], f"job-level env cannot reference the env context: {offenders}"


@pytest.mark.skipif(os.name == "nt", reason="The stub release is a POSIX shell script.")
def test_smoke_rejects_a_release_that_cannot_complete_an_https_request(tmp_path: Path) -> None:
    executable = tmp_path / "shortdrama-cli"
    executable.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
    executable.chmod(executable.stat().st_mode | stat.S_IXUSR)

    with pytest.raises(ValueError, match="missing its CA bundle"):
        verify_packaged_tls(executable, "https://example.test/")


def test_smoke_reports_a_release_that_will_not_start_at_all(tmp_path: Path) -> None:
    """A corrupt or wrong-architecture build raises OSError instead of exiting non-zero."""

    with pytest.raises(ValueError, match="could not be executed"):
        verify_packaged_tls(tmp_path / "shortdrama-cli", "https://example.test/")


def test_smoke_refuses_a_plaintext_probe(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="must use https"):
        verify_packaged_tls(tmp_path / "shortdrama-cli", "http://example.test/")


@pytest.mark.skipif(os.name == "nt", reason="The stub release is a POSIX shell script.")
def test_smoke_rejects_a_release_that_borrowed_the_host_ca_bundle(tmp_path: Path) -> None:
    """A runner with a system trust store would otherwise report this build healthy."""

    host_bundle = tmp_path / "host" / "cert.pem"
    host_bundle.parent.mkdir()
    host_bundle.write_text("", encoding="utf-8")
    payload = json.dumps(
        {"status": "succeeded", "data": {"tls": {"status": 200, "ca_bundle": str(host_bundle)}}}
    )
    executable = tmp_path / "release" / "shortdrama-cli"
    executable.parent.mkdir()
    executable.write_text(f"#!/bin/sh\ncat <<'JSON'\n{payload}\nJSON\n", encoding="utf-8")
    executable.chmod(executable.stat().st_mode | stat.S_IXUSR)

    with pytest.raises(ValueError, match="outside the release"):
        verify_packaged_tls(executable, "https://example.test/")
