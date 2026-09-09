#!/usr/bin/env bash
: <<'COMMENT'
Build the Linux x64 release asset in Volcengine CodePipeline.

The committed uv.lock remains portable. This script creates a temporary lockfile
against Volcengine's PyPI mirror and restores the repository lockfile on exit.
COMMENT

set -Eeuo pipefail

readonly RELEASE_TAG="${SHORTDRAMA_RELEASE_TAG:-v0.3.2}"
readonly RELEASE_VERSION="${RELEASE_TAG#v}"
readonly PYPI_MIRROR="${SHORTDRAMA_PYPI_MIRROR:-https://mirrors.ivolces.com/pypi}"
readonly PYTHON_BIN="${SHORTDRAMA_PYTHON:-python}"
readonly ARCHIVE_NAME="shortdrama-cli-v${RELEASE_VERSION}-linux-x64.tar.gz"

echo "[INFO] Python environment"
"${PYTHON_BIN}" --version
command -v "${PYTHON_BIN}"
"${PYTHON_BIN}" -c 'import ctypes, sys; assert sys.version_info >= (3, 11), "Python 3.11+ is required"; print("[INFO] ctypes available")'

echo "[INFO] Install uv"
"${PYTHON_BIN}" -m pip install \
  --disable-pip-version-check \
  --index-url "${PYPI_MIRROR}/simple/" \
  "uv==0.7.13"
"${PYTHON_BIN}" -m uv --version

export UV_INDEX_URL="${PYPI_MIRROR}/simple/"
export UV_CACHE_DIR="/tmp/shortdrama-uv-cache"
export UV_LINK_MODE="copy"
export UV_PYTHON="${PYTHON_BIN}"
export UV_RESOLUTION="lowest-direct"

readonly LOCK_BACKUP="$(mktemp /tmp/shortdrama-uv-lock.XXXXXX)"

restore_repository_lock() {
  mv -f "${LOCK_BACKUP}" uv.lock
}
trap restore_repository_lock EXIT

# Recent PyPI files can appear before the Volcengine mirror has synchronized
# their objects. Prefer the lowest compatible direct dependencies so the
# temporary lockfile uses mature artifacts already present on the mirror.
mv uv.lock "${LOCK_BACKUP}"
echo "[INFO] Resolve mirror-compatible dependencies"
"${PYTHON_BIN}" -m uv lock

echo "[INFO] Install mirror-locked dependencies"
"${PYTHON_BIN}" -m uv sync --locked

readonly PROJECT_PYTHON=".venv/bin/python"

# PyInstaller 6.0/altgraph still imports pkg_resources. Keep this explicit
# because a cached or mirror-generated lock can otherwise select setuptools 82+.
echo "[INFO] Ensure PyInstaller compatibility dependencies"
"${PYTHON_BIN}" -m uv pip install \
  --python "${PROJECT_PYTHON}" \
  --index-url "${PYPI_MIRROR}/simple/" \
  "setuptools==80.9.0"
"${PROJECT_PYTHON}" -c 'import pkg_resources; print("[INFO] pkg_resources available")'

echo "[INFO] Validate release version"
"${PROJECT_PYTHON}" scripts/release/release.py validate --tag "${RELEASE_TAG}"

echo "[INFO] Run tests"
"${PYTHON_BIN}" -m uv run --frozen pytest -q

echo "[INFO] Build PyInstaller application"
"${PYTHON_BIN}" -m uv run --frozen pyinstaller \
  --onedir \
  --name shortdrama-cli \
  --collect-data shortdrama_cli \
  --collect-data certifi \
  --distpath dist/app \
  --workpath build/pyinstaller \
  --specpath build/pyinstaller \
  src/shortdrama_cli/__main__.py

# The probe stays on the mirror this pipeline already installs from, because the
# CodePipeline network does not reach the default GitHub endpoint.
echo "[INFO] Smoke test packaged CLI"
"${PROJECT_PYTHON}" scripts/release/release.py smoke \
  --tag "${RELEASE_TAG}" \
  --app-dir dist/app/shortdrama-cli \
  --https-probe "${PYPI_MIRROR}/simple/"

echo "[INFO] Package Linux x64 release"
"${PROJECT_PYTHON}" scripts/release/release.py package \
  --tag "${RELEASE_TAG}" \
  --platform linux \
  --arch x64 \
  --app-dir dist/app/shortdrama-cli \
  --output-dir release-assets

if [[ ! -s "release-assets/${ARCHIVE_NAME}" ]]; then
  echo "[ERROR] Release archive was not generated: ${ARCHIVE_NAME}" >&2
  exit 1
fi

echo "[INFO] Generate checksum and copy installers"
(
  cd release-assets
  sha256sum "${ARCHIVE_NAME}" > checksums.txt
)
cp scripts/install-shortdrama-cli.sh release-assets/install-shortdrama-cli.sh
cp scripts/install-shortdrama-cli.ps1 release-assets/install-shortdrama-cli.ps1

test -s release-assets/checksums.txt
test -s release-assets/install-shortdrama-cli.sh
test -s release-assets/install-shortdrama-cli.ps1

echo "[INFO] Release assets"
ls -lh release-assets
