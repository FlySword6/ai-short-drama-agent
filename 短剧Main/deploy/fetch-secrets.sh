#!/usr/bin/env bash
# Render a local/offline or dev/test Compose env/export file from Volcengine
# KMS Secret Manager. Production VKE uses deploy/k8s/secret-init instead.
#
# The script never prints secret values. It writes atomically with mode 600 and
# exits before replacing the target when any required secret is absent.
set -euo pipefail

umask 077

readonly DEFAULT_REGION="cn-beijing"
readonly FORBIDDEN_PRODUCTION_SECRET="shortdrama/production"
readonly REQUIRED_SECRET_KEYS=(
  ARK_API_KEY
  TOS_ACCESS_KEY
  TOS_SECRET_KEY
  POSTGRES_PASSWORD
  MILVUS_PASSWORD
)
readonly OPTIONAL_REGISTRATION_SECRET_KEYS=(
  VOLCENGINE_ACCESS_KEY_ID
  VOLCENGINE_SECRET_ACCESS_KEY
  VOLCENGINE_SECURITY_TOKEN
)

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template_file="${SHORTDRAMA_ENV_TEMPLATE:-${repo_root}/.env.release.example}"
output_file="${SHORTDRAMA_ENV_OUTPUT:-}"
secret_name="${SHORTDRAMA_KMS_SECRET_NAME:-}"
region="${VOLCENGINE_REGION:-${DEFAULT_REGION}}"
ve_cli="${VE_CLI_BIN:-ve}"
from_env=false
secrets_only=false
require_irsa=false
secret_keys=()
secret_values=()
temp_file=""

usage() {
  cat <<'EOF'
Usage:
  ./deploy/fetch-secrets.sh [options]
  ./deploy/fetch-secrets.sh --from-env [options]

Options:
  --from-env           Read the five required secrets from the current process
                       environment. This is only for local/offline testing.
  --secrets-only       Write required secrets and any complete optional
                       registration credential bundle as Bash exports.
                       This is a dev/test compatibility output, not the
                       production Kubernetes initContainer path.
  --require-irsa       Fail before KMS access unless VKE IRSA role/token inputs
                       are present and the projected token file is readable;
                       this only tests compatibility.
  --template PATH      Non-secret env template. Default: .env.release.example.
  --output PATH        Required dev/test output path, unless
                       SHORTDRAMA_ENV_OUTPUT is set.
  --secret-name NAME   Required KMS dev/test secret name in KMS mode, unless
                       SHORTDRAMA_KMS_SECRET_NAME is set.
  --region REGION      Volcengine KMS region. Default: cn-beijing.
  -h, --help           Show this help.

KMS mode requires `ve` and `jq`. The caller must provide a verified temporary
credential chain for `ve`; `--require-irsa` validates the VKE IRSA inputs but
does not replace the required real-cluster CLI compatibility test. The generic
secret value must be a JSON object containing these non-empty string keys:
  ARK_API_KEY, TOS_ACCESS_KEY, TOS_SECRET_KEY, POSTGRES_PASSWORD,
  MILVUS_PASSWORD

Trusted-asset registration credentials are optional. When present,
VOLCENGINE_ACCESS_KEY_ID and VOLCENGINE_SECRET_ACCESS_KEY must be a complete
pair. VOLCENGINE_SECURITY_TOKEN is optional and only valid with that pair.

The script prints key names and status only; it never prints secret values.
It must not be used to fetch or materialize production credentials. Production
uses the repository-built Go initContainer under deploy/k8s/secret-init/.
EOF
}

fail() {
  printf 'ERROR %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$temp_file" && -e "$temp_file" ]]; then
    rm -f -- "$temp_file"
  fi
}
trap cleanup EXIT HUP INT TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-env)
      from_env=true
      shift
      ;;
    --secrets-only)
      secrets_only=true
      shift
      ;;
    --require-irsa)
      require_irsa=true
      shift
      ;;
    --template)
      [[ $# -ge 2 ]] || fail "--template requires a path"
      template_file="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || fail "--output requires a path"
      output_file="$2"
      shift 2
      ;;
    --secret-name)
      [[ $# -ge 2 ]] || fail "--secret-name requires a value"
      secret_name="$2"
      shift 2
      ;;
    --region)
      [[ $# -ge 2 ]] || fail "--region requires a value"
      region="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown option: $1"
      ;;
  esac
done

if [[ "$secrets_only" == false ]]; then
  [[ -f "$template_file" ]] || fail "env template not found: $template_file"
  [[ -r "$template_file" ]] || fail "env template is not readable: $template_file"
fi
[[ -n "$output_file" ]] || fail "output path must not be empty"
case "$output_file" in
  /opt|/opt/*) fail "dev/test helper refuses output under /opt" ;;
esac
output_dir="$(dirname "$output_file")"
[[ -d "$output_dir" ]] || fail "dev/test output directory must already exist"
canonical_output_dir="$(cd "$output_dir" && pwd -P)"
case "$canonical_output_dir" in
  /opt|/opt/*) fail "dev/test helper refuses output under /opt" ;;
esac
if [[ "$from_env" == true && "$require_irsa" == true ]]; then
  fail "--from-env and --require-irsa cannot be used together"
fi
if [[ "$from_env" == false && -z "$secret_name" ]]; then
  fail "--secret-name or SHORTDRAMA_KMS_SECRET_NAME is required in KMS dev/test mode"
fi
case "$secret_name" in
  "$FORBIDDEN_PRODUCTION_SECRET"|*/production|*/production/*|shortdrama/prod|shortdrama/prod/*)
    fail "dev/test helper refuses production KMS secret names"
    ;;
esac

validate_secret_value() {
  local key="$1" value="$2"
  [[ -n "$value" ]] || fail "required secret is absent or empty: $key"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "required secret contains a newline: $key"
}

load_secrets_from_env() {
  local key value
  for key in "${REQUIRED_SECRET_KEYS[@]}"; do
    value="$(printenv "$key" 2>/dev/null || true)"
    validate_secret_value "$key" "$value"
    secret_keys+=("$key")
    secret_values+=("$value")
  done
  load_optional_registration_secrets_from_env
}

load_secrets_from_kms() {
  local request response payload key value

  if [[ "$require_irsa" == true ]]; then
    [[ -n "${VOLCENGINE_OIDC_ROLE_TRN:-}" ]] || fail "VKE IRSA role TRN is not injected"
    [[ -n "${VOLCENGINE_OIDC_TOKEN_FILE:-}" ]] || fail "VKE IRSA token path is not injected"
    [[ -r "${VOLCENGINE_OIDC_TOKEN_FILE}" ]] || fail "VKE IRSA token file is not readable"
    [[ -s "${VOLCENGINE_OIDC_TOKEN_FILE}" ]] || fail "VKE IRSA token file is empty"
  fi

  command -v "$ve_cli" >/dev/null 2>&1 || fail "Volcengine CLI not found: $ve_cli"
  command -v jq >/dev/null 2>&1 || fail "jq is required to parse the KMS response"

  request="$(jq -cn --arg name "$secret_name" '{SecretName:$name}')"
  if ! response="$(VOLCENGINE_REGION="$region" "$ve_cli" kms GetSecretValue --body "$request" 2>/dev/null)"; then
    fail "KMS GetSecretValue failed for secret name '$secret_name' in region '$region'"
  fi

  if ! payload="$(printf '%s' "$response" | jq -er '.Result.SecretValue // .SecretValue // empty' 2>/dev/null)"; then
    fail "KMS response does not contain Result.SecretValue"
  fi
  if ! printf '%s' "$payload" | jq -e 'type == "object"' >/dev/null 2>&1; then
    fail "KMS SecretValue must be a JSON object"
  fi

  for key in "${REQUIRED_SECRET_KEYS[@]}"; do
    if ! value="$(printf '%s' "$payload" | jq -er --arg key "$key" '.[$key] | select(type == "string" and length > 0)' 2>/dev/null)"; then
      fail "required secret is absent, empty, or not a string: $key"
    fi
    validate_secret_value "$key" "$value"
    secret_keys+=("$key")
    secret_values+=("$value")
  done

  load_optional_registration_secrets_from_kms "$payload"

  unset response payload value
}

load_optional_registration_secrets_from_env() {
  local access_key secret_key security_token
  access_key="$(printenv VOLCENGINE_ACCESS_KEY_ID 2>/dev/null || true)"
  secret_key="$(printenv VOLCENGINE_SECRET_ACCESS_KEY 2>/dev/null || true)"
  security_token="$(printenv VOLCENGINE_SECURITY_TOKEN 2>/dev/null || true)"
  add_optional_registration_secrets "$access_key" "$secret_key" "$security_token"
}

load_optional_registration_secrets_from_kms() {
  local payload="$1" access_key secret_key security_token

  read_optional_kms_secret_value "$payload" "VOLCENGINE_ACCESS_KEY_ID"
  access_key="$optional_secret_value"
  read_optional_kms_secret_value "$payload" "VOLCENGINE_SECRET_ACCESS_KEY"
  secret_key="$optional_secret_value"
  read_optional_kms_secret_value "$payload" "VOLCENGINE_SECURITY_TOKEN"
  security_token="$optional_secret_value"

  add_optional_registration_secrets "$access_key" "$secret_key" "$security_token"
}

read_optional_kms_secret_value() {
  local payload="$1" key="$2"
  optional_secret_value=""

  if ! printf '%s' "$payload" | jq -e --arg key "$key" 'has($key)' >/dev/null 2>&1; then
    return 0
  fi
  if ! optional_secret_value="$(printf '%s' "$payload" | jq -er --arg key "$key" '.[$key] | select(type == "string" and length > 0)' 2>/dev/null)"; then
    fail "optional registration secret is empty or not a string: $key"
  fi
}

add_optional_registration_secrets() {
  local access_key="$1" secret_key="$2" security_token="$3"

  if [[ -z "$access_key" && -z "$secret_key" && -z "$security_token" ]]; then
    return 0
  fi
  if [[ -z "$access_key" || -z "$secret_key" ]]; then
    fail "optional registration credentials require both VOLCENGINE_ACCESS_KEY_ID and VOLCENGINE_SECRET_ACCESS_KEY"
  fi
  validate_secret_value "VOLCENGINE_ACCESS_KEY_ID" "$access_key"
  validate_secret_value "VOLCENGINE_SECRET_ACCESS_KEY" "$secret_key"
  if [[ -n "$security_token" ]]; then
    validate_secret_value "VOLCENGINE_SECURITY_TOKEN" "$security_token"
  fi

  secret_keys+=("${OPTIONAL_REGISTRATION_SECRET_KEYS[0]}" "${OPTIONAL_REGISTRATION_SECRET_KEYS[1]}")
  secret_values+=("$access_key" "$secret_key")
  if [[ -n "$security_token" ]]; then
    secret_keys+=("${OPTIONAL_REGISTRATION_SECRET_KEYS[2]}")
    secret_values+=("$security_token")
  fi
}

# Compose treats single-quoted env-file values literally. Escape backslashes
# first, then single quotes, following Docker's documented env-file grammar.
quote_compose_env_value() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\'/\\\'}"
  printf "'%s'" "$value"
}

secret_index_for_key() {
  local candidate="$1" index
  for ((index = 0; index < ${#secret_keys[@]}; index += 1)); do
    if [[ "${secret_keys[$index]}" == "$candidate" ]]; then
      printf '%s' "$index"
      return 0
    fi
  done
  return 1
}

render_env_file() {
  local output_dir line key index quoted
  local seen=()

  for ((index = 0; index < ${#secret_keys[@]}; index += 1)); do
    seen[$index]=0
  done

  output_dir="$(dirname "$output_file")"
  [[ -w "$output_dir" ]] || fail "output directory is not writable: $output_dir"
  temp_file="$(mktemp "${output_dir}/.devtest.env.XXXXXX")"

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]]; then
      key="${BASH_REMATCH[1]}"
      if index="$(secret_index_for_key "$key")"; then
        if [[ "${seen[$index]}" -ne 0 ]]; then
          fail "secret key appears more than once in env template: $key"
        fi
        quoted="$(quote_compose_env_value "${secret_values[$index]}")"
        printf '%s=%s\n' "$key" "$quoted" >>"$temp_file"
        seen[$index]=1
        continue
      fi
    fi
    printf '%s\n' "$line" >>"$temp_file"
  done <"$template_file"

  for key in "${REQUIRED_SECRET_KEYS[@]}"; do
    index="$(secret_index_for_key "$key")"
    [[ "${seen[$index]}" -eq 1 ]] || fail "env template is missing required secret key: $key"
  done
  for ((index = 0; index < ${#secret_keys[@]}; index += 1)); do
    [[ "${seen[$index]}" -eq 1 ]] || fail "env template is missing injected secret key: ${secret_keys[$index]}"
  done

  chmod 600 "$temp_file"
  mv -f -- "$temp_file" "$output_file"
  temp_file=""
  chmod 600 "$output_file"
}

render_secret_export_file() {
  local output_dir index

  output_dir="$(dirname "$output_file")"
  [[ -w "$output_dir" ]] || fail "output directory is not writable: $output_dir"
  temp_file="$(mktemp "${output_dir}/.devtest-secrets.sh.XXXXXX")"

  for ((index = 0; index < ${#secret_keys[@]}; index += 1)); do
    printf 'export %s=' "${secret_keys[$index]}" >>"$temp_file"
    printf '%q' "${secret_values[$index]}" >>"$temp_file"
    printf '\n' >>"$temp_file"
  done

  chmod 600 "$temp_file"
  mv -f -- "$temp_file" "$output_file"
  temp_file=""
  chmod 600 "$output_file"
}

if [[ "$from_env" == true ]]; then
  load_secrets_from_env
  source_label="process environment (--from-env)"
else
  load_secrets_from_kms
  source_label="Volcengine KMS Secret Manager"
fi

if [[ "$secrets_only" == true ]]; then
  render_secret_export_file
  output_kind="secret export file"
else
  render_env_file
  output_kind="dev/test env"
fi

printf 'OK %s rendered from %s\n' "$output_kind" "$source_label"
printf 'OK output file: %s (mode 600)\n' "$output_file"
printf 'OK required secret keys validated: %s\n' "${REQUIRED_SECRET_KEYS[*]}"
