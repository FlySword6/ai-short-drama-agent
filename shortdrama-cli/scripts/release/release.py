#!/usr/bin/env python3
"""Build deterministic release archives and metadata for shortdrama-cli."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 compatibility.
    import tomli as tomllib


ARCHIVE_PATTERN = re.compile(
    r"^shortdrama-cli-v(?P<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)-"
    r"(?P<platform>darwin|linux|windows)-(?P<arch>x64|arm64)\.(?P<extension>tar\.gz|zip)$"
)
VERSION_PATTERN = re.compile(r"^v?(?P<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$")
DEFAULT_HTTPS_PROBE = "https://api.github.com/"


def normalize_version(tag: str) -> str:
    """Return the semantic version represented by a release tag."""

    match = VERSION_PATTERN.fullmatch(tag)
    if not match:
        raise ValueError(f"Release tag must look like v1.2.3, got: {tag}")
    return match.group("version")


def project_version(project_root: Path) -> str:
    """Read the canonical version from pyproject.toml."""

    with (project_root / "pyproject.toml").open("rb") as handle:
        return str(tomllib.load(handle)["project"]["version"])


def package_version(project_root: Path) -> str:
    """Read the runtime version without importing project dependencies."""

    content = (project_root / "src" / "shortdrama_cli" / "__init__.py").read_text(encoding="utf-8")
    match = re.search(r'^__version__\s*=\s*"([^"]+)"', content, re.MULTILINE)
    if not match:
        raise ValueError("Could not find __version__ in shortdrama_cli/__init__.py")
    return match.group(1)

def skill_manifest_version(project_root: Path) -> str:
    """Read the bundled Skill version."""

    manifest = json.loads(
        (project_root / "skills" / "shortdrama-cli" / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    return str(manifest["version"])


def changelog_version(project_root: Path) -> str:
    """Read the first release heading from CHANGELOG.md."""

    content = (project_root / "CHANGELOG.md").read_text(encoding="utf-8")
    match = re.search(
        r"^##\s+(?P<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b",
        content,
        re.MULTILINE,
    )
    if not match:
        raise ValueError("Could not find a release version in CHANGELOG.md")
    return match.group("version")


def validate_versions(project_root: Path, tag: str) -> str:
    """Fail when the tag, packaging metadata, and runtime version diverge."""

    version = normalize_version(tag)
    versions = {
        "release tag": version,
        "pyproject.toml": project_version(project_root),
        "shortdrama_cli.__version__": package_version(project_root),
        "Skill manifest": skill_manifest_version(project_root),
        "CHANGELOG.md": changelog_version(project_root),
    }
    if len(set(versions.values())) != 1:
        details = ", ".join(f"{source}={value}" for source, value in versions.items())
        raise ValueError(f"Release versions do not match: {details}")
    return version


def validate_release_provenance(project_root: Path, tag: str, main_commit: str) -> str:
    """Require the release tag to point at one explicitly approved main commit."""

    version = normalize_version(tag)
    if not re.fullmatch(r"[0-9a-fA-F]{40}", main_commit):
        raise ValueError("Trusted main commit must be a full 40-character SHA")
    refs = {
        "release tag": f"refs/tags/v{version}^{{commit}}",
        "trusted main": f"{main_commit.lower()}^{{commit}}",
    }
    commits: dict[str, str] = {}
    for label, ref in refs.items():
        result = subprocess.run(
            ["git", "rev-parse", "--verify", ref],
            cwd=project_root,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise ValueError(f"Could not resolve {label} ref {ref!r}")
        commits[label] = result.stdout.strip()

    if commits["release tag"] != commits["trusted main"]:
        raise ValueError(
            "Release tag must point at the exact trusted main commit: "
            f"tag={commits['release tag']}, main={commits['trusted main']}"
        )
    return commits["release tag"]


def _copy_release_tree(app_dir: Path, skill_dir: Path, destination: Path) -> None:
    """Stage the executable directory and its matching skill."""

    if not app_dir.is_dir():
        raise FileNotFoundError(f"Missing PyInstaller onedir output: {app_dir}")
    if not (skill_dir / "SKILL.md").is_file():
        raise FileNotFoundError(f"Missing skill entrypoint: {skill_dir / 'SKILL.md'}")

    shutil.copytree(app_dir, destination)
    bundled_skill = destination / "skills" / "shortdrama-cli"
    shutil.copytree(
        skill_dir,
        bundled_skill,
        ignore=shutil.ignore_patterns(".DS_Store", "__pycache__", "*.pyc"),
    )


def _tar_filter(info: tarfile.TarInfo) -> tarfile.TarInfo:
    """Normalize archive metadata for reproducible Unix release assets."""

    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    return info


def _write_tar_gz(source: Path, archive: Path) -> None:
    """Write a deterministic gzip-compressed tar archive."""

    with archive.open("wb") as raw_handle:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw_handle, mtime=0) as gzip_handle:
            with tarfile.open(fileobj=gzip_handle, mode="w") as tar_handle:
                tar_handle.add(source, arcname="shortdrama-cli", filter=_tar_filter)


def _write_zip(source: Path, archive: Path) -> None:
    """Write a deterministic Windows zip archive."""

    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zip_handle:
        for path in sorted(source.rglob("*")):
            relative = Path("shortdrama-cli") / path.relative_to(source)
            if path.is_dir():
                continue
            info = zipfile.ZipInfo(relative.as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (path.stat().st_mode & 0xFFFF) << 16
            zip_handle.writestr(info, path.read_bytes())


def build_archive(
    *,
    project_root: Path,
    tag: str,
    platform: str,
    arch: str,
    app_dir: Path,
    skill_dir: Path,
    output_dir: Path,
) -> Path:
    """Create one versioned platform archive containing the CLI and skill."""

    version = validate_versions(project_root, tag)
    if platform not in {"darwin", "linux", "windows"}:
        raise ValueError(f"Unsupported platform: {platform}")
    if arch not in {"x64", "arm64"}:
        raise ValueError(f"Unsupported architecture: {arch}")

    output_dir.mkdir(parents=True, exist_ok=True)
    extension = "zip" if platform == "windows" else "tar.gz"
    archive = output_dir / f"shortdrama-cli-v{version}-{platform}-{arch}.{extension}"

    with tempfile.TemporaryDirectory(prefix="shortdrama-release-") as temporary_dir:
        staged_root = Path(temporary_dir) / "shortdrama-cli"
        _copy_release_tree(app_dir, skill_dir, staged_root)
        if platform == "windows":
            _write_zip(staged_root, archive)
        else:
            executable = staged_root / "shortdrama-cli"
            if executable.exists():
                executable.chmod(executable.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            _write_tar_gz(staged_root, archive)
    return archive


def sha256(path: Path) -> str:
    """Compute a release asset checksum without loading it into memory."""

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def generate_metadata(*, project_root: Path, tag: str, artifacts_dir: Path) -> tuple[Path, Path]:
    """Generate checksums.txt and a machine-readable release manifest."""

    version = validate_versions(project_root, tag)
    assets: list[dict[str, object]] = []
    checksum_lines: list[str] = []
    for path in sorted(artifacts_dir.iterdir()):
        match = ARCHIVE_PATTERN.fullmatch(path.name)
        if not match:
            continue
        if match.group("version") != version:
            raise ValueError(f"Asset version does not match release tag: {path.name}")
        digest = sha256(path)
        checksum_lines.append(f"{digest}  {path.name}")
        assets.append(
            {
                "name": path.name,
                "platform": match.group("platform"),
                "arch": match.group("arch"),
                "sha256": digest,
                "size": path.stat().st_size,
            }
        )

    expected = {
        ("darwin", "arm64"),
        ("darwin", "x64"),
        ("linux", "arm64"),
        ("linux", "x64"),
        ("windows", "x64"),
    }
    actual = {(str(asset["platform"]), str(asset["arch"])) for asset in assets}
    if actual != expected:
        raise ValueError(f"Release asset matrix mismatch: expected {sorted(expected)}, got {sorted(actual)}")

    checksums_path = artifacts_dir / "checksums.txt"
    checksums_path.write_text("\n".join(checksum_lines) + "\n", encoding="utf-8")
    manifest_path = artifacts_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "schema_version": "shortdrama_cli_release_v1",
                "version": version,
                "tag": f"v{version}",
                "github_repository": "col-shortdrama/zhongwen-shortdrama-cli",
                "assets": assets,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return checksums_path, manifest_path


def verify_packaged_tls(executable: Path, probe_url: str) -> None:
    """Make one real HTTPS request from the packaged runtime.

    Reaching the endpoint is not enough on its own: a CI runner has a system CA
    bundle that the user's machine may not, so the request must also be shown to
    have trusted a bundle carried inside the release. That pair is what "works on
    a clean machine" reduces to on a runner that is anything but clean.
    """

    if not probe_url.startswith("https://"):
        raise ValueError(f"TLS probe must use https://, got: {probe_url}")
    release_root = executable.resolve().parent
    environment = {
        name: value
        for name, value in os.environ.items()
        if name not in {"SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE"}
    }
    try:
        result = subprocess.run(
            [str(executable), "doctor", "--tls-probe", probe_url],
            capture_output=True,
            text=True,
            env=environment,
        )
    except OSError as error:  # A corrupt or wrong-architecture build never starts at all.
        raise ValueError(f"Packaged CLI at {executable} could not be executed: {error}") from error
    if result.returncode != 0:
        raise ValueError(
            f"Packaged CLI could not complete an HTTPS request to {probe_url}; "
            f"the release is missing its CA bundle: {result.stdout.strip()} {result.stderr.strip()}"
        )
    tls = json.loads(result.stdout).get("data", {}).get("tls", {})
    if not isinstance(tls.get("status"), int):
        raise ValueError(f"Packaged CLI reported no HTTP status for {probe_url}: {result.stdout.strip()}")
    ca_bundle = Path(str(tls.get("ca_bundle", ""))).resolve()
    if not ca_bundle.is_relative_to(release_root):
        raise ValueError(
            f"Packaged CLI trusted {ca_bundle}, which lives outside the release at {release_root}; "
            "this build only works on machines that already have that file."
        )
    print(f"[INFO] TLS probe {probe_url} verified with CA bundle {ca_bundle}")


def smoke_test(app_dir: Path, expected_version: str, https_probe: str | None) -> None:
    """Run the packaged executable, verify its version, then verify it can reach HTTPS."""

    executable_name = "shortdrama-cli.exe" if os.name == "nt" else "shortdrama-cli"
    executable = app_dir / executable_name
    result = subprocess.run(
        [str(executable), "--version"],
        check=True,
        capture_output=True,
        text=True,
    )
    if result.stdout.strip() != expected_version:
        raise ValueError(f"Packaged version mismatch: expected {expected_version}, got {result.stdout.strip()}")
    if https_probe:
        verify_packaged_tls(executable, https_probe)


def build_parser() -> argparse.ArgumentParser:
    """Create the release utility command parser."""

    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate")
    validate.add_argument("--tag", required=True)

    provenance = subparsers.add_parser("provenance")
    provenance.add_argument("--tag", required=True)
    provenance.add_argument("--main-commit", required=True)

    package = subparsers.add_parser("package")
    package.add_argument("--tag", required=True)
    package.add_argument("--platform", required=True)
    package.add_argument("--arch", required=True)
    package.add_argument("--app-dir", type=Path, required=True)
    package.add_argument("--skill-dir", type=Path, default=Path("skills/shortdrama-cli"))
    package.add_argument("--output-dir", type=Path, default=Path("release-assets"))

    metadata = subparsers.add_parser("metadata")
    metadata.add_argument("--tag", required=True)
    metadata.add_argument("--artifacts-dir", type=Path, default=Path("release-assets"))

    smoke = subparsers.add_parser("smoke")
    smoke.add_argument("--tag", required=True)
    smoke.add_argument("--app-dir", type=Path, required=True)
    smoke.add_argument("--https-probe", default=DEFAULT_HTTPS_PROBE)
    return parser


def main() -> None:
    """Execute one release utility command."""

    args = build_parser().parse_args()
    project_root = args.project_root.resolve()
    if args.command == "validate":
        print(validate_versions(project_root, args.tag))
    elif args.command == "provenance":
        print(validate_release_provenance(project_root, args.tag, args.main_commit))
    elif args.command == "package":
        print(
            build_archive(
                project_root=project_root,
                tag=args.tag,
                platform=args.platform,
                arch=args.arch,
                app_dir=args.app_dir.resolve(),
                skill_dir=args.skill_dir.resolve(),
                output_dir=args.output_dir.resolve(),
            )
        )
    elif args.command == "metadata":
        for path in generate_metadata(
            project_root=project_root,
            tag=args.tag,
            artifacts_dir=args.artifacts_dir.resolve(),
        ):
            print(path)
    elif args.command == "smoke":
        smoke_test(args.app_dir.resolve(), validate_versions(project_root, args.tag), args.https_probe)


if __name__ == "__main__":
    main()
