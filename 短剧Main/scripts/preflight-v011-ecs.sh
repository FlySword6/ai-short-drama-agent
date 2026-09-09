#!/usr/bin/env bash
# Read-only local/dev-test Compose compatibility check. It never builds, pulls,
# starts, stops, pushes, deploys, or validates production.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  SHORTDRAMA_IMAGE=shortdrama-devtest:v0.1.1-<commit> \
  SHORTDRAMA_ROLLBACK_IMAGE=shortdrama-devtest:v0.1.1-<previous-commit> \
  ./scripts/preflight-v011-ecs.sh --env-file .env

Options:
  --env-file PATH  Runtime environment file. Defaults to SHORTDRAMA_ENV_FILE,
                   then .env. Dev/test only.
  --offline        Static-only mode. Do not require Docker or inspect this
                   host's architecture, resources, or listening ports.
  --help           Show this help.

The check reports only variable names, never their values. It does not read
secrets into output, contact the network, pull images, start services, or
modify local/remote state.

This script is not a production readiness or deployment check. Production uses
docs/deploy/pipeline-guide.md and deploy/k8s/.
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

env_file="${SHORTDRAMA_ENV_FILE:-.env}"
offline=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || { echo "--env-file requires a path" >&2; exit 64; }
      env_file="$2"
      shift 2
      ;;
    --offline) offline=true; shift ;;
    -h|--help|help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
done

errors=0
blocked=0
warnings=0

pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; warnings=$((warnings + 1)); }
error() { printf 'ERROR %s\n' "$*" >&2; errors=$((errors + 1)); }
block() { printf 'BLOCK %s\n' "$*" >&2; blocked=$((blocked + 1)); }

declare -A values=()

# Deliberately parse rather than source a runtime env file: sourced files can
# execute shell code. Compose's env-file grammar is intentionally simple here.
read_env_file() {
  local line key value line_number=0
  [[ -f "$env_file" ]] || { error "runtime env file is missing"; return; }
  [[ -r "$env_file" ]] || { error "runtime env file is not readable"; return; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      value="${BASH_REMATCH[3]}"
      # Remove only matching single/double wrapping quotes. We do not need the
      # secret itself; this is solely presence/placeholder validation.
      if [[ ${#value} -ge 2 && ( "${value:0:1}" == '"' && "${value: -1}" == '"' || "${value:0:1}" == "'" && "${value: -1}" == "'" ) ]]; then
        value="${value:1:${#value}-2}"
      fi
      values["$key"]="$value"
    else
      error "runtime env file has an unsupported line at ${line_number}"
    fi
  done < "$env_file"
}

is_placeholder() {
  local value="$1"
  [[ -z "$value" || "$value" == *'<'*'>'* || "$value" == "change-me" || "$value" == "replace-me" || "$value" == "TODO" ]]
}

required_env() {
  local key
  for key in "$@"; do
    if is_placeholder "${values[$key]-}"; then
      error "required runtime variable is absent or a placeholder: $key"
    else
      pass "required runtime variable is present: $key"
    fi
  done
}

required_any_env() {
  local label="$1"
  shift
  local key
  for key in "$@"; do
    if ! is_placeholder "${values[$key]-}"; then
      pass "required runtime alternative is present: $label"
      return
    fi
  done
  error "at least one runtime variable is required for $label: $*"
}

validate_runtime_env() {
  read_env_file
  [[ -f "$env_file" && -r "$env_file" ]] || return

  required_env APP_NAME APP_VERSION ADMIN_USERNAMES POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD TOS_BUCKET TOS_PUBLIC_BASE_URL TOS_REGION TOS_ACCESS_KEY TOS_SECRET_KEY
  required_any_env "TOS SDK endpoint" TOS_SDK_ENDPOINT TOS_ENDPOINT

  if [[ -n "${values[DATABASE_URL]-}" ]]; then
    error "DATABASE_URL must be empty in the Compose runtime env; Compose provides POSTGRES_HOST=db"
  else
    pass "DATABASE_URL is empty for Compose"
  fi
  if [[ "${values[AUTH_REGISTRATION_ENABLED]-}" != "true" && "${values[AUTH_REGISTRATION_ENABLED]-}" != "false" ]]; then
    error "AUTH_REGISTRATION_ENABLED must be exactly true or false"
  else
    pass "registration switch is explicit"
  fi
  if [[ "${values[ALLOW_PAID_GENERATION]-}" != "true" && "${values[ALLOW_PAID_GENERATION]-}" != "false" ]]; then
    error "ALLOW_PAID_GENERATION must be exactly true or false"
  fi
  if [[ "${values[ALLOW_PAID_GENERATION]-}" == "true" ]]; then
    required_env PAID_GENERATION_BUDGET_FEN ARK_API_KEY
    if ! [[ "${values[PAID_GENERATION_BUDGET_FEN]-}" =~ ^[1-9][0-9]*$ ]]; then
      error "PAID_GENERATION_BUDGET_FEN must be a positive integer when paid generation is enabled"
    fi
    if is_placeholder "${values[ARK_IMAGE_MODEL]-}" && is_placeholder "${values[ARK_VIDEO_MODEL]-}"; then
      error "at least one of ARK_IMAGE_MODEL or ARK_VIDEO_MODEL is required when paid generation is enabled"
    fi
  else
    pass "paid generation is disabled (no paid task can be created)"
  fi
}

validate_static_devtest_files() {
  local required_file
  for required_file in compose.yaml Dockerfile deploy/Caddyfile scripts/release-amd64.sh scripts/release-smoke.sh; do
    [[ -f "$required_file" ]] && pass "dev/test file exists: $required_file" || error "dev/test file is missing: $required_file"
  done

  [[ -f compose.yaml ]] && {
    rg -q 'platform: \$\{SHORTDRAMA_PLATFORM:-linux/amd64\}' compose.yaml && pass "Compose pins service platform to linux/amd64" || error "Compose does not pin linux/amd64 platform"
    rg -q 'image: \$\{SHORTDRAMA_IMAGE:-' compose.yaml && pass "Compose accepts a release image tag" || error "Compose has no configurable release image tag"
    rg -q 'condition: service_healthy' compose.yaml && pass "Compose has health-gated dependencies" || error "Compose is missing health-gated dependencies"
    rg -q 'SHORTDRAMA_HTTP_PORT' compose.yaml && pass "Compose exposes configurable HTTP port" || error "Compose has no configurable HTTP port"
  }
  [[ -f deploy/Caddyfile ]] && rg -q 'reverse_proxy app:8000' deploy/Caddyfile && pass "Caddy points at the app health service" || error "Caddy upstream contract is missing"
}

validate_migrations() {
  local -a files=()
  local file expected=1 number
  [[ -d migrations ]] || { error "migrations directory is missing"; return; }
  while IFS= read -r file; do files+=("$file"); done < <(find migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' -print | LC_ALL=C sort)
  [[ ${#files[@]} -gt 0 ]] || { error "no numbered SQL migrations found"; return; }
  for file in "${files[@]}"; do
    number="$(basename "$file" | cut -d_ -f1)"
    if (( 10#$number != expected )); then
      error "migration order is not continuous before $(basename "$file")"
      return
    fi
    expected=$((expected + 1))
  done
  pass "migration order is continuous: 001 through $(printf '%03d' $((expected - 1)))"
}

validate_devtest_image_anchors() {
  local image="${SHORTDRAMA_IMAGE:-}"
  local rollback="${SHORTDRAMA_ROLLBACK_IMAGE:-}"
  if [[ "$image" =~ ^[^[:space:]]+:v0\.1\.1-[A-Za-z0-9._-]+$ && "$image" != *':v0.1.1-local' ]]; then
    pass "release image tag is explicit and non-local"
  else
    error "set SHORTDRAMA_IMAGE to an immutable-looking v0.1.1 dev/test tag"
  fi
  if [[ "$rollback" =~ ^[^[:space:]]+:v0\.1\.1-[A-Za-z0-9._-]+$ && "$rollback" != "$image" ]]; then
    pass "rollback image anchor is explicit and differs from release image"
  else
    error "set SHORTDRAMA_ROLLBACK_IMAGE to a distinct prior v0.1.1 dev/test image tag"
  fi
  if [[ "${SHORTDRAMA_PLATFORM:-linux/amd64}" == "linux/amd64" ]]; then
    pass "dev/test platform is linux/amd64"
  else
    error "SHORTDRAMA_PLATFORM must be linux/amd64"
  fi
}

bytes_to_gib() { awk -v bytes="$1" 'BEGIN { printf "%.1f", bytes / 1024 / 1024 / 1024 }'; }

validate_host() {
  local architecture available_kb memory_bytes http_port port_busy=0
  architecture="$(uname -m 2>/dev/null || true)"
  if [[ "$architecture" == "x86_64" || "$architecture" == "amd64" ]]; then
    pass "host architecture is AMD64-compatible"
  else
    block "host architecture is ${architecture:-unknown}; run non-offline preflight on an AMD64 dev/test host"
  fi

  available_kb="$(df -Pk . 2>/dev/null | awk 'NR == 2 { print $4 }')"
  if [[ "$available_kb" =~ ^[0-9]+$ ]] && (( available_kb >= 20 * 1024 * 1024 )); then
    pass "repository filesystem has at least 20 GiB available"
  elif [[ "$available_kb" =~ ^[0-9]+$ ]]; then
    block "repository filesystem has less than 20 GiB available"
  else
    block "could not inspect available disk space"
  fi

  memory_bytes=""
  if [[ -r /proc/meminfo ]]; then
    memory_bytes="$(awk '/MemTotal:/ { print $2 * 1024; exit }' /proc/meminfo)"
  elif command -v sysctl >/dev/null 2>&1; then
    memory_bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
  fi
  if [[ "$memory_bytes" =~ ^[0-9]+$ ]] && (( memory_bytes >= 4 * 1024 * 1024 * 1024 )); then
    pass "host memory is at least 4 GiB"
  elif [[ "$memory_bytes" =~ ^[0-9]+$ ]]; then
    block "host memory is below 4 GiB"
  else
    block "could not inspect host memory"
  fi

  http_port="${SHORTDRAMA_HTTP_PORT:-80}"
  if ! [[ "$http_port" =~ ^[1-9][0-9]{0,4}$ ]] || (( http_port > 65535 )); then
    error "SHORTDRAMA_HTTP_PORT must be an integer from 1 to 65535"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$http_port" -sTCP:LISTEN >/dev/null 2>&1 && port_busy=1 || true
    (( port_busy == 0 )) && pass "HTTP port ${http_port} is free" || block "HTTP port ${http_port} is already listening"
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$http_port" 2>/dev/null | grep -q LISTEN && port_busy=1 || true
    (( port_busy == 0 )) && pass "HTTP port ${http_port} is free" || block "HTTP port ${http_port} is already listening"
  else
    block "cannot inspect whether HTTP port ${http_port} is free (need lsof or ss)"
  fi

  if ! command -v docker >/dev/null 2>&1; then
    block "Docker CLI is unavailable"
    return
  fi
  if ! docker info >/dev/null 2>&1; then
    block "Docker daemon is unavailable or inaccessible"
    return
  fi
  pass "Docker daemon is reachable"
  if SHORTDRAMA_ENV_FILE="$env_file" SHORTDRAMA_IMAGE="${SHORTDRAMA_IMAGE:-}" SHORTDRAMA_PLATFORM="linux/amd64" docker compose config --quiet >/dev/null 2>&1; then
    pass "Docker Compose configuration renders without output"
  else
    error "Docker Compose configuration does not render; inspect it locally without printing runtime env values"
  fi
}

validate_runtime_env
validate_static_devtest_files
validate_migrations
validate_devtest_image_anchors

if [[ "$offline" == true ]]; then
  warn "offline mode: Docker daemon, host architecture, memory, disk, and port checks were intentionally not run"
else
  validate_host
fi

printf '\nSummary: %d error(s), %d blocked check(s), %d warning(s).\n' "$errors" "$blocked" "$warnings"
if (( errors > 0 )); then
  exit 1
fi
if (( blocked > 0 )); then
  exit 2
fi
exit 0
