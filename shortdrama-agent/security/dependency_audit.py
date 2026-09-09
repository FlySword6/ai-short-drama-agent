#!/usr/bin/env python3
"""Audit every supported Python production-dependency source in the repository."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
import tomllib
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


DEFAULT_AUDIT_TIMEOUT_SECONDS = 180
INVENTORY_SCHEMA_VERSION = 1
INVENTORY_FILE_NAME = "dependency-inventory.json"
IGNORED_DIRECTORY_NAMES = {
    ".git",
    ".mypy_cache",
    ".nox",
    ".pytest_cache",
    ".ruff_cache",
    ".security-reports",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
}
SUPPORTED_LOCK_FILE_NAMES = {"uv.lock"}
UNSUPPORTED_LOCK_FILE_NAMES = {
    "Pipfile.lock",
    "pdm.lock",
    "poetry.lock",
    "pylock.toml",
}
PACKAGE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
REQUIREMENT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*")
SHA_PINNED_VCS_REQUIREMENT = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*\s*@\s*git\+https://"
    r"[^\s@]+@[0-9a-f]{40,64}$"
)
CONTEXT_DEPENDENT_REQUIREMENT = re.compile(
    r"(?im)^\s*(?:-r|--requirement|-c|--constraint|-e|--editable|"
    r"--find-links|--index-url|--extra-index-url)\b"
)


@dataclass(frozen=True)
class InventoryError:
    path: Path
    code: str


@dataclass(frozen=True)
class DependencySource:
    path: Path
    kind: str
    payload: bytes | None
    dependency_count: int
    native_input: bool = False
    fully_locked: bool = False
    vcs_pinned: tuple[str, ...] = ()


@dataclass(frozen=True)
class AuditGroup:
    audit_input: Path
    sources: tuple[Path, ...]
    digest: str
    no_deps: bool = False


@dataclass(frozen=True)
class AuditPlan:
    groups: tuple[AuditGroup, ...]
    sources: tuple[DependencySource, ...]
    errors: tuple[InventoryError, ...]
    inventory_path: Path


def _is_excluded(path: Path, excluded_root: Path | None) -> bool:
    if excluded_root is None:
        return False
    try:
        path.resolve().relative_to(excluded_root.resolve())
    except ValueError:
        return False
    return True


def _discover_dependency_files(
    root: Path,
    *,
    excluded_root: Path | None = None,
) -> tuple[list[Path], list[InventoryError]]:
    discovered: list[Path] = []
    errors: list[InventoryError] = []

    def on_error(error: OSError) -> None:
        filename = Path(error.filename) if error.filename else root
        errors.append(InventoryError(filename, "dependency_tree_unreadable"))

    for current, directories, filenames in os.walk(root, onerror=on_error):
        current_path = Path(current)
        directories[:] = sorted(
            directory
            for directory in directories
            if directory not in IGNORED_DIRECTORY_NAMES
            and not _is_excluded(current_path / directory, excluded_root)
        )
        if _is_excluded(current_path, excluded_root):
            directories.clear()
            continue
        for filename in sorted(filenames):
            if (
                fnmatch.fnmatch(filename, "requirements*.txt")
                or fnmatch.fnmatch(filename, "requirements*.lock")
                or filename == "pyproject.toml"
                or filename in SUPPORTED_LOCK_FILE_NAMES
                or filename in UNSUPPORTED_LOCK_FILE_NAMES
            ):
                discovered.append(current_path / filename)
    return sorted(discovered), errors


def _read_bytes(path: Path) -> tuple[bytes | None, InventoryError | None]:
    try:
        return path.read_bytes(), None
    except OSError:
        return None, InventoryError(path, "dependency_file_unreadable")


def _normalise_project_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _valid_requirement(requirement: object) -> bool:
    if not isinstance(requirement, str):
        return False
    value = requirement.strip()
    if (
        not value
        or "\n" in value
        or "\r" in value
        or REQUIREMENT_NAME.match(value) is None
    ):
        return False
    lowered = value.lower()
    return not (
        "@" in value
        or lowered.startswith(("file:", "git+", "hg+", "svn+", "bzr+"))
        or "${" in value
    )


def _parse_toml(
    path: Path,
) -> tuple[dict[str, object] | None, InventoryError | None]:
    content, read_error = _read_bytes(path)
    if read_error is not None:
        return None, read_error
    assert content is not None
    try:
        data = tomllib.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError):
        return None, InventoryError(path, "dependency_toml_invalid")
    return data, None


def _pyproject_source(
    path: Path,
) -> tuple[DependencySource | None, str | None, list[InventoryError]]:
    data, parse_error = _parse_toml(path)
    if parse_error is not None:
        return None, None, [parse_error]
    assert data is not None

    project = data.get("project")
    tool = data.get("tool")
    non_pep621_manager = isinstance(tool, dict) and any(
        isinstance(tool.get(manager), dict)
        and bool(tool[manager].get("dependencies"))
        for manager in ("poetry", "pdm", "flit")
    )
    if not isinstance(project, dict):
        if non_pep621_manager:
            return (
                None,
                None,
                [InventoryError(path, "pyproject_non_pep621_dependencies")],
            )
        return DependencySource(path, "pyproject", None, 0), None, []
    if non_pep621_manager:
        return (
            None,
            None,
            [InventoryError(path, "pyproject_mixed_dependency_layouts")],
        )

    name = project.get("name")
    project_name = name if isinstance(name, str) and name.strip() else None
    dynamic = project.get("dynamic", [])
    if isinstance(dynamic, list) and any(
        item in {"dependencies", "optional-dependencies"} for item in dynamic
    ):
        return (
            None,
            project_name,
            [InventoryError(path, "pyproject_dynamic_dependencies")],
        )
    if dynamic is not None and not isinstance(dynamic, list):
        return (
            None,
            project_name,
            [InventoryError(path, "pyproject_dynamic_invalid")],
        )

    requirements: list[str] = []
    vcs_pinned: list[str] = []
    dependencies = project.get("dependencies", [])
    if dependencies is None:
        dependencies = []
    if not isinstance(dependencies, list):
        return (
            None,
            project_name,
            [InventoryError(path, "pyproject_dependencies_unsupported")],
        )
    for item in dependencies:
        if isinstance(item, str) and SHA_PINNED_VCS_REQUIREMENT.match(
            item.strip()
        ):
            vcs_pinned.append(item.strip())
        elif _valid_requirement(item):
            requirements.append(item.strip())
        else:
            return (
                None,
                project_name,
                [InventoryError(path, "pyproject_dependencies_unsupported")],
            )

    optional = project.get("optional-dependencies", {})
    if optional is None:
        optional = {}
    if not isinstance(optional, dict):
        return (
            None,
            project_name,
            [InventoryError(path, "pyproject_optional_dependencies_invalid")],
        )
    # Optional groups can be enabled in production images. Auditing every group
    # is conservative and avoids guessing which extras a deploy selects.
    for group_dependencies in optional.values():
        if not isinstance(group_dependencies, list):
            return (
                None,
                project_name,
                [
                    InventoryError(
                        path,
                        "pyproject_optional_dependencies_unsupported",
                    )
                ],
            )
        for item in group_dependencies:
            if isinstance(item, str) and SHA_PINNED_VCS_REQUIREMENT.match(
                item.strip()
            ):
                vcs_pinned.append(item.strip())
            elif _valid_requirement(item):
                requirements.append(item.strip())
            else:
                return (
                    None,
                    project_name,
                    [
                        InventoryError(
                            path,
                            "pyproject_optional_dependencies_unsupported",
                        )
                    ],
                )

    unique_requirements = sorted(set(requirements), key=str.casefold)
    if not unique_requirements and not vcs_pinned:
        return DependencySource(path, "pyproject", None, 0), project_name, []
    payload = (
        ("\n".join(unique_requirements) + "\n").encode("utf-8")
        if unique_requirements
        else None
    )
    return (
        DependencySource(
            path,
            "pyproject",
            payload,
            len(unique_requirements),
            vcs_pinned=tuple(sorted(vcs_pinned)),
        ),
        project_name,
        [],
    )


def _is_sha_pinned_git_source(source: dict) -> bool:
    """uv.lock git source pinned to a full 40-hex commit SHA.

    uv writes: "https://host/org/repo.git?rev=<40hex>#<40hex>".
    """
    url = source.get("git")
    if not isinstance(url, str):
        return False
    match = re.match(
        r"^https://[^\s#?]+\.git(?:\?rev=([0-9a-f]{40}))?(?:#[0-9a-f]{40})?$",
        url,
    )
    if match is None:
        return False
    return match.group(1) is not None or bool(
        re.search(r"#[0-9a-f]{40}$", url)
    )


def _uv_lock_source(
    path: Path,
    *,
    project_name: str | None,
) -> tuple[DependencySource | None, list[InventoryError]]:
    data, parse_error = _parse_toml(path)
    if parse_error is not None:
        return None, [parse_error]
    assert data is not None

    packages = data.get("package")
    if not isinstance(packages, list):
        return None, [InventoryError(path, "uv_lock_packages_invalid")]

    versions_by_name: dict[str, set[str]] = defaultdict(set)
    display_names: dict[str, str] = {}
    errors: list[InventoryError] = []
    for package in packages:
        if not isinstance(package, dict):
            errors.append(InventoryError(path, "uv_lock_package_invalid"))
            continue
        name = package.get("name")
        version = package.get("version")
        source = package.get("source")
        if not isinstance(name, str) or not PACKAGE_NAME.fullmatch(name):
            errors.append(InventoryError(path, "uv_lock_package_name_invalid"))
            continue
        if not isinstance(source, dict):
            errors.append(InventoryError(path, "uv_lock_source_invalid"))
            continue

        registry = source.get("registry")
        if isinstance(registry, str) and registry.strip():
            pass  # auditable registry pin handled below
        else:
            local_root = source.get("virtual") == "." or source.get("editable") == "."
            if (
                local_root
                and project_name is not None
                and _normalise_project_name(name)
                == _normalise_project_name(project_name)
            ):
                continue
            if _is_sha_pinned_git_source(source):
                # Cross-repo dependency pinned to a full commit SHA; recorded
                # in the inventory, excluded from registry pip-audit.
                continue
            errors.append(InventoryError(path, "uv_lock_source_unsupported"))
            continue

        if (
            not isinstance(version, str)
            or not version.strip()
            or any(character.isspace() for character in version)
        ):
            errors.append(InventoryError(path, "uv_lock_version_invalid"))
            continue
        normalised_name = _normalise_project_name(name)
        display_names.setdefault(normalised_name, name)
        versions_by_name[normalised_name].add(version)

    for versions in versions_by_name.values():
        if len(versions) > 1:
            errors.append(InventoryError(path, "uv_lock_multiple_versions"))
    if errors:
        return None, errors

    requirements = sorted(
        (
            f"{display_names[name]}=={next(iter(versions))}"
            for name, versions in versions_by_name.items()
        ),
        key=str.casefold,
    )
    payload = ("\n".join(requirements) + "\n").encode("utf-8")
    return (
        DependencySource(
            path,
            "uv-lock",
            payload,
            len(requirements),
            fully_locked=True,
        ),
        [],
    )


def _requirements_source(
    path: Path,
) -> tuple[DependencySource | None, list[InventoryError]]:
    content, read_error = _read_bytes(path)
    if read_error is not None:
        return None, [read_error]
    assert content is not None
    try:
        content.decode("utf-8")
    except UnicodeDecodeError:
        return None, [InventoryError(path, "requirements_not_utf8")]
    dependency_count = sum(
        1
        for line in content.decode("utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith(("#", "-"))
    )
    return (
        DependencySource(
            path,
            "requirements",
            content,
            dependency_count,
            native_input=True,
        ),
        [],
    )


def _source_group_key(source: DependencySource, root: Path) -> str:
    assert source.payload is not None
    digest = hashlib.sha256(source.payload).hexdigest()
    if source.native_input and CONTEXT_DEPENDENT_REQUIREMENT.search(
        source.payload.decode("utf-8")
    ):
        parent_digest = hashlib.sha256(
            _relative(source.path.parent, root).encode("utf-8")
        ).hexdigest()
        return f"{digest}:{parent_digest}"
    return digest


def _relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.name


def _write_inventory(
    path: Path,
    *,
    root: Path,
    sources: Sequence[DependencySource],
    groups: Sequence[AuditGroup],
    errors: Sequence[InventoryError],
) -> None:
    document = {
        "schema_version": INVENTORY_SCHEMA_VERSION,
        "status": "blocked" if errors else "ready",
        "sources": [
            {
                "path": _relative(source.path, root),
                "kind": source.kind,
                "dependency_count": source.dependency_count,
                "content_sha256": (
                    hashlib.sha256(source.payload).hexdigest()
                    if source.payload is not None
                    else None
                ),
            }
            for source in sources
        ],
        "audit_groups": [
            {
                "id": group.digest[:16],
                "sources": [
                    _relative(source_path, root)
                    for source_path in group.sources
                ],
            }
            for group in groups
        ],
        "errors": [
            {
                "path": _relative(error.path, root),
                "code": error.code,
            }
            for error in errors
        ],
    }
    path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def prepare_audit_plan(root: Path, report_dir: Path) -> AuditPlan:
    root = root.resolve()
    report_dir = report_dir.resolve()
    report_dir.mkdir(parents=True, exist_ok=True)
    inventory_path = report_dir / INVENTORY_FILE_NAME
    paths, errors = _discover_dependency_files(
        root,
        excluded_root=report_dir,
    )

    pyprojects: dict[Path, tuple[DependencySource | None, str | None]] = {}
    sources: list[DependencySource] = []
    for path in (item for item in paths if item.name == "pyproject.toml"):
        source, project_name, parse_errors = _pyproject_source(path)
        errors.extend(parse_errors)
        pyprojects[path.parent] = (source, project_name)
        if source is not None:
            sources.append(source)

    for path in paths:
        if path.name == "pyproject.toml":
            continue
        if (
            fnmatch.fnmatch(path.name, "requirements*.txt")
            or fnmatch.fnmatch(path.name, "requirements*.lock")
        ):
            source, parse_errors = _requirements_source(path)
        elif path.name == "uv.lock":
            project_name = pyprojects.get(path.parent, (None, None))[1]
            source, parse_errors = _uv_lock_source(
                path,
                project_name=project_name,
            )
        elif path.name in UNSUPPORTED_LOCK_FILE_NAMES:
            source = None
            parse_errors = [
                InventoryError(path, "lockfile_exporter_not_supported")
            ]
        else:
            continue
        errors.extend(parse_errors)
        if source is not None:
            sources.append(source)

    sources.sort(key=lambda item: item.path.as_posix())
    if not sources and not errors:
        errors.append(InventoryError(root, "no_dependency_manifests_found"))
    grouped: dict[str, list[DependencySource]] = defaultdict(list)
    for source in sources:
        if source.payload is not None:
            grouped[_source_group_key(source, root)].append(source)

    input_dir = report_dir / "_audit-inputs"
    groups: list[AuditGroup] = []
    for key in sorted(grouped):
        group_sources = grouped[key]
        payload = group_sources[0].payload
        assert payload is not None
        content_digest = hashlib.sha256(payload).hexdigest()
        digest = (
            content_digest
            if key == content_digest
            else hashlib.sha256(key.encode("utf-8")).hexdigest()
        )
        native_sources = [
            source for source in group_sources if source.native_input
        ]
        if native_sources:
            audit_input = native_sources[0].path
        else:
            input_dir.mkdir(parents=True, exist_ok=True)
            audit_input = input_dir / f"{content_digest}.requirements.txt"
            audit_input.write_bytes(payload)
        groups.append(
            AuditGroup(
                audit_input=audit_input,
                sources=tuple(source.path for source in group_sources),
                digest=digest,
                no_deps=all(source.fully_locked for source in group_sources),
            )
        )

    errors.sort(key=lambda item: (item.path.as_posix(), item.code))
    _write_inventory(
        inventory_path,
        root=root,
        sources=sources,
        groups=groups,
        errors=errors,
    )
    return AuditPlan(
        groups=tuple(groups),
        sources=tuple(sources),
        errors=tuple(errors),
        inventory_path=inventory_path,
    )


def requirement_groups(root: Path) -> list[tuple[Path, list[Path]]]:
    """Recursively group exact duplicate requirements files.

    This compatibility helper is also useful to callers that only need the
    requirements-file view. Context-dependent include/options are kept
    separate because identical text in different directories can resolve to
    different dependencies.
    """

    paths, _ = _discover_dependency_files(root.resolve())
    sources: list[DependencySource] = []
    for path in paths:
        if not (
            fnmatch.fnmatch(path.name, "requirements*.txt")
            or fnmatch.fnmatch(path.name, "requirements*.lock")
        ):
            continue
        source, errors = _requirements_source(path)
        if source is not None and not errors:
            sources.append(source)
    groups: dict[str, list[DependencySource]] = defaultdict(list)
    for source in sources:
        groups[_source_group_key(source, root)].append(source)
    return [
        (
            grouped_sources[0].path,
            [source.path for source in grouped_sources],
        )
        for _, grouped_sources in sorted(groups.items())
    ]


def vulnerability_count(report_path: Path) -> int | None:
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    vulnerabilities = data.get("vulnerabilities")
    if isinstance(vulnerabilities, list):
        return len(vulnerabilities)
    # Retain compatibility with pip-audit's JSON dependency format.
    dependencies = data.get("dependencies")
    if isinstance(dependencies, list):
        return sum(
            len(item.get("vulns", []))
            for item in dependencies
            if isinstance(item, dict) and isinstance(item.get("vulns", []), list)
        )
    return None


def audit_command(
    requirement: Path,
    report: Path,
    *,
    no_deps: bool = False,
) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "pip_audit",
        "--requirement",
        str(requirement),
        "--format",
        "cyclonedx-json",
        "--output",
        str(report),
        "--progress-spinner",
        "off",
        "--strict",
    ]
    if no_deps:
        # Fully locked inputs already carry exact name==version pins, so skip
        # pip's dependency resolution (and the venv it needs to build) and ask
        # pip-audit to audit the pinned list directly.
        command.extend(["--no-deps", "--disable-pip"])
    return command


def run_audit(
    requirement: Path,
    report: Path,
    timeout_seconds: int,
    *,
    cwd: Path | None = None,
    no_deps: bool = False,
) -> int | None:
    """Return pip-audit's exit code, or ``None`` when the group times out."""

    try:
        completed = subprocess.run(
            audit_command(requirement, report, no_deps=no_deps),
            cwd=cwd,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return None
    return completed.returncode


def _positive_seconds(value: str) -> int:
    seconds = int(value)
    if seconds <= 0:
        raise argparse.ArgumentTypeError("timeout must be greater than zero")
    return seconds


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--report-dir", type=Path, required=True)
    parser.add_argument(
        "--timeout-seconds",
        type=_positive_seconds,
        default=DEFAULT_AUDIT_TIMEOUT_SECONDS,
        help="Maximum time for each unique dependency group.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = args.root.resolve()
    report_dir = args.report_dir.resolve()
    plan = prepare_audit_plan(root, report_dir)

    if plan.errors:
        for error in plan.errors:
            print(
                "dependency-audit: FAIL "
                f"file={_relative(error.path, root)} reason={error.code}"
            )
        print(
            "dependency-audit summary: "
            f"sources={len(plan.sources)} groups={len(plan.groups)} "
            f"inventory_errors={len(plan.errors)} failed={len(plan.errors)}"
        )
        return 1

    if not plan.sources:
        print("dependency-audit: FAIL reason=no_dependency_manifests_found")
        print(
            "dependency-audit summary: "
            "sources=0 groups=0 inventory_errors=0 failed=1"
        )
        return 1

    failed = 0
    for index, group in enumerate(plan.groups, 1):
        report = report_dir / f"dependencies-{index}.cdx.json"
        returncode = run_audit(
            group.audit_input,
            report,
            args.timeout_seconds,
            cwd=root,
            no_deps=group.no_deps,
        )
        count = vulnerability_count(report)
        names = ", ".join(
            _relative(source_path, root) for source_path in group.sources
        )
        if returncode is None:
            failed += 1
            print(
                "dependency-audit: FAIL "
                f"files=[{names}] reason=timeout "
                f"timeout_seconds={args.timeout_seconds}"
            )
        elif returncode != 0 or count not in {0}:
            failed += 1
            detail = "unknown" if count is None else str(count)
            print(
                f"dependency-audit: FAIL files=[{names}] "
                f"vulnerabilities={detail}"
            )
        else:
            print(f"dependency-audit: PASS files=[{names}] vulnerabilities=0")
    print(
        "dependency-audit summary: "
        f"sources={len(plan.sources)} groups={len(plan.groups)} "
        f"inventory_errors=0 failed={failed}"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
