#!/bin/sh
# Install a versioned shortdrama-cli onedir release and its matching Agent Skill.

set -eu

REPOSITORY="${SHORTDRAMA_GITHUB_REPOSITORY:-col-shortdrama/zhongwen-shortdrama-cli}"
INSTALL_ROOT="${SHORTDRAMA_INSTALL_DIR:-$HOME/.shortdrama}"
SKILL_TARGET="${SHORTDRAMA_SKILL_DIR:-$HOME/.agents/skills/shortdrama-cli}"
REQUESTED_VERSION="${SHORTDRAMA_VERSION:-}"

fail() {
  printf 'shortdrama-cli installer: %s\n' "$1" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) PLATFORM="darwin" ;;
    Linux) PLATFORM="linux" ;;
    *) fail "unsupported operating system: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) fail "unsupported CPU architecture: $(uname -m)" ;;
  esac
}

github_cli_ready() {
  command_exists gh && gh auth status >/dev/null 2>&1
}

resolve_tag() {
  if [ -n "$REQUESTED_VERSION" ]; then
    case "$REQUESTED_VERSION" in
      v*) TAG="$REQUESTED_VERSION" ;;
      *) TAG="v$REQUESTED_VERSION" ;;
    esac
    return
  fi

  if github_cli_ready; then
    TAG="$(gh release view --repo "$REPOSITORY" --json tagName --jq .tagName)"
  else
    command_exists curl || fail "curl is required when GitHub CLI is unavailable"
    TAG="$(curl -fsSL "https://api.github.com/repos/$REPOSITORY/releases/latest" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | head -n 1)"
  fi
  [ -n "$TAG" ] || fail "could not resolve the latest release; authenticate with 'gh auth login' for a private repository"
}

download_release_asset() {
  asset_name="$1"
  destination="$2"
  if github_cli_ready; then
    gh release download "$TAG" --repo "$REPOSITORY" --pattern "$asset_name" --dir "$(dirname "$destination")" --clobber >/dev/null
  else
    command_exists curl || fail "curl is required to download release assets"
    curl -fL "https://github.com/$REPOSITORY/releases/download/$TAG/$asset_name" -o "$destination" \
      || fail "download failed; authenticate with 'gh auth login' if the repository is private"
  fi
  [ -f "$destination" ] || fail "release asset was not downloaded: $asset_name"
}

verify_checksum() {
  expected="$(awk -v name="$ASSET_NAME" '$2 == name {print $1}' "$CHECKSUMS_FILE")"
  [ -n "$expected" ] || fail "checksum entry missing for $ASSET_NAME"
  if command_exists sha256sum; then
    actual="$(sha256sum "$ARCHIVE_FILE" | awk '{print $1}')"
  elif command_exists shasum; then
    actual="$(shasum -a 256 "$ARCHIVE_FILE" | awk '{print $1}')"
  else
    fail "sha256sum or shasum is required for integrity verification"
  fi
  [ "$expected" = "$actual" ] || fail "SHA-256 verification failed for $ASSET_NAME"
}

configure_path() {
  BIN_DIR="$INSTALL_ROOT/bin"
  case ":$PATH:" in
    *":$BIN_DIR:"*) return ;;
  esac

  if [ "${SHORTDRAMA_NO_MODIFY_PATH:-0}" = "1" ]; then
    printf 'Add this directory to PATH: %s\n' "$BIN_DIR"
    return
  fi

  shell_name="$(basename "${SHELL:-sh}")"
  case "$shell_name" in
    zsh) profile="$HOME/.zshrc" ;;
    bash)
      # macOS terminals open login shells, which read .bash_profile and never .bashrc.
      if [ "$PLATFORM" = "darwin" ]; then
        profile="$HOME/.bash_profile"
      else
        profile="$HOME/.bashrc"
      fi
      ;;
    *) profile="$HOME/.profile" ;;
  esac
  path_line="export PATH=\"$BIN_DIR:\$PATH\" # shortdrama-cli"
  if [ ! -f "$profile" ] || ! grep -F "$path_line" "$profile" >/dev/null 2>&1; then
    printf '\n%s\n' "$path_line" >> "$profile"
    printf 'Updated PATH in %s; open a new terminal to use shortdrama-cli.\n' "$profile"
  fi
}

detect_platform
resolve_tag
VERSION="${TAG#v}"
ASSET_NAME="shortdrama-cli-v$VERSION-$PLATFORM-$ARCH.tar.gz"

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/shortdrama-install.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT HUP INT TERM
ARCHIVE_FILE="$TEMP_ROOT/$ASSET_NAME"
CHECKSUMS_FILE="$TEMP_ROOT/checksums.txt"

printf 'Installing shortdrama-cli %s for %s-%s...\n' "$VERSION" "$PLATFORM" "$ARCH"
download_release_asset "$ASSET_NAME" "$ARCHIVE_FILE"
download_release_asset "checksums.txt" "$CHECKSUMS_FILE"
verify_checksum

mkdir -p "$TEMP_ROOT/extract"
tar -xzf "$ARCHIVE_FILE" -C "$TEMP_ROOT/extract"
[ -x "$TEMP_ROOT/extract/shortdrama-cli/shortdrama-cli" ] \
  || fail "archive does not contain the expected executable"
[ -f "$TEMP_ROOT/extract/shortdrama-cli/skills/shortdrama-cli/SKILL.md" ] \
  || fail "archive does not contain the matching skill"

VERSION_DIR="$INSTALL_ROOT/versions/$VERSION"
mkdir -p "$INSTALL_ROOT/versions" "$INSTALL_ROOT/bin" "$(dirname "$SKILL_TARGET")"
rm -rf "$VERSION_DIR"
mkdir -p "$VERSION_DIR"
cp -R "$TEMP_ROOT/extract/shortdrama-cli" "$VERSION_DIR/shortdrama-cli"
ln -sfn "$VERSION_DIR/shortdrama-cli/shortdrama-cli" "$INSTALL_ROOT/bin/shortdrama-cli"
ln -sfn "$VERSION_DIR/shortdrama-cli/shortdrama-cli" "$INSTALL_ROOT/bin/shortdrama"

rm -rf "$SKILL_TARGET"
cp -R "$VERSION_DIR/shortdrama-cli/skills/shortdrama-cli" "$SKILL_TARGET"
configure_path

INSTALLED_VERSION="$($INSTALL_ROOT/bin/shortdrama-cli --version)"
[ "$INSTALLED_VERSION" = "$VERSION" ] || fail "installed version check failed"

printf 'Installed shortdrama-cli %s\n' "$INSTALLED_VERSION"
printf 'Binary: %s\n' "$INSTALL_ROOT/bin/shortdrama-cli"
printf 'Skill:  %s\n' "$SKILL_TARGET"
