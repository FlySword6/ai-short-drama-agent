#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="${repo_root}/deploy/fetch-secrets.sh"
fixture="${repo_root}/deploy/tests/fixtures/fake-ve.sh"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/shortdrama-fetch-secrets.XXXXXX")"

cleanup() {
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT HUP INT TERM

pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

assert_log_has_no_values() {
  local log_file="$1" value
  shift
  for value in "$@"; do
    grep -Fq -- "$value" "$log_file" && fail "command log contains a secret value"
  done
  return 0
}

bash -n "$script"
"$script" --help >/dev/null
pass "syntax and help"

if env \
  ARK_API_KEY=test \
  TOS_ACCESS_KEY=test \
  TOS_SECRET_KEY=test \
  POSTGRES_PASSWORD=test \
  MILVUS_PASSWORD=test \
  "$script" --from-env >/dev/null 2>&1; then
  fail "dev/test helper accepted an implicit output path"
fi
pass "dev/test helper requires an explicit output path"

if VE_CLI_BIN="$fixture" \
  "$script" --output "${temp_dir}/implicit-secret.env" >/dev/null 2>&1; then
  fail "dev/test KMS mode accepted an implicit secret name"
fi
[[ ! -e "${temp_dir}/implicit-secret.env" ]] || fail "implicit KMS mode created an output file"
pass "dev/test KMS mode requires an explicit secret name"

if VE_CLI_BIN="$fixture" \
  "$script" --secret-name shortdrama/production \
  --output "${temp_dir}/forbidden-production-secret.env" >/dev/null 2>&1; then
  fail "dev/test helper accepted the production KMS secret name"
fi
[[ ! -e "${temp_dir}/forbidden-production-secret.env" ]] || fail "production secret attempt created an output file"
pass "dev/test helper rejects the production KMS secret name"

if VE_CLI_BIN="$fixture" \
  "$script" --secret-name shortdrama/prod/runtime \
  --output "${temp_dir}/forbidden-prod-runtime-secret.env" >/dev/null 2>&1; then
  fail "dev/test helper accepted the prod runtime KMS secret name"
fi
[[ ! -e "${temp_dir}/forbidden-prod-runtime-secret.env" ]] || fail "prod runtime secret attempt created an output file"
pass "dev/test helper rejects the prod runtime KMS secret name"

if env \
  ARK_API_KEY=test \
  TOS_ACCESS_KEY=test \
  TOS_SECRET_KEY=test \
  POSTGRES_PASSWORD=test \
  MILVUS_PASSWORD=test \
  "$script" --from-env --output /opt/shortdrama/production.env >/dev/null 2>&1; then
  fail "dev/test helper accepted an /opt output path"
fi
pass "dev/test helper rejects host production output paths"

from_env_output="${temp_dir}/from-env.env"
from_env_log="${temp_dir}/from-env.log"
env \
  ARK_API_KEY='ark-$literal' \
  TOS_ACCESS_KEY='tos#ak' \
  TOS_SECRET_KEY='tos"sk' \
  POSTGRES_PASSWORD="db'pass" \
  MILVUS_PASSWORD='milvus\pass' \
  "$script" --from-env --output "$from_env_output" >"$from_env_log" 2>&1

[[ "$(file_mode "$from_env_output")" == "600" ]] || fail "from-env output mode is not 600"
grep -Fq "ARK_API_KEY='ark-\$literal'" "$from_env_output" || fail "dollar value is not single-quoted"
grep -Fq "TOS_ACCESS_KEY='tos#ak'" "$from_env_output" || fail "hash value was not preserved"
grep -Fq "TOS_SECRET_KEY='tos\"sk'" "$from_env_output" || fail "double quote value was not preserved"
grep -Fq "POSTGRES_PASSWORD='db\\'pass'" "$from_env_output" || fail "single quote value was not escaped"
grep -Fq "MILVUS_PASSWORD='milvus\\\\pass'" "$from_env_output" || fail "backslash value was not escaped"
assert_log_has_no_values "$from_env_log" 'ark-$literal' 'tos#ak' 'tos"sk' "db'pass" 'milvus\pass'
pass "from-env render, quoting, mode, and log redaction"

shell_output="${temp_dir}/from-env-secrets.sh"
shell_log="${temp_dir}/from-env-secrets.log"
env \
  ARK_API_KEY='ark-$literal' \
  TOS_ACCESS_KEY='tos#ak' \
  TOS_SECRET_KEY='tos"sk' \
  POSTGRES_PASSWORD="db'pass" \
  MILVUS_PASSWORD='milvus\pass' \
  "$script" --from-env --secrets-only --output "$shell_output" >"$shell_log" 2>&1
(
  # shellcheck disable=SC1090
  source "$shell_output"
  [[ "$ARK_API_KEY" == 'ark-$literal' ]]
  [[ "$TOS_ACCESS_KEY" == 'tos#ak' ]]
  [[ "$TOS_SECRET_KEY" == 'tos"sk' ]]
  [[ "$POSTGRES_PASSWORD" == "db'pass" ]]
  [[ "$MILVUS_PASSWORD" == 'milvus\pass' ]]
) || fail "secrets-only export did not preserve shell metacharacters"
assert_log_has_no_values "$shell_log" 'ark-$literal' 'tos#ak' 'tos"sk' "db'pass" 'milvus\pass'
pass "secrets-only Bash quoting preserves shell metacharacters"

registration_output="${temp_dir}/optional-output.sh"
registration_log="${temp_dir}/optional-output.log"
env \
  ARK_API_KEY='ark-$literal' \
  TOS_ACCESS_KEY='tos#ak' \
  TOS_SECRET_KEY='tos"sk' \
  POSTGRES_PASSWORD="db'pass" \
  MILVUS_PASSWORD='milvus\pass' \
  VOLCENGINE_ACCESS_KEY_ID='registration-access' \
  VOLCENGINE_SECRET_ACCESS_KEY='registration-secret' \
  VOLCENGINE_SECURITY_TOKEN='registration-session' \
  "$script" --from-env --secrets-only --output "$registration_output" >"$registration_log" 2>&1
[[ "$(wc -l <"$registration_output" | tr -d ' ')" == "8" ]] || fail "complete registration credentials were not exported"
(
  unset VOLCENGINE_ACCESS_KEY_ID VOLCENGINE_SECRET_ACCESS_KEY VOLCENGINE_SECURITY_TOKEN
  # shellcheck disable=SC1090
  source "$registration_output"
  [[ "$VOLCENGINE_ACCESS_KEY_ID" == 'registration-access' ]]
  [[ "$VOLCENGINE_SECRET_ACCESS_KEY" == 'registration-secret' ]]
  [[ "$VOLCENGINE_SECURITY_TOKEN" == 'registration-session' ]]
) || fail "complete registration credentials cannot be sourced safely"
assert_log_has_no_values "$registration_log" 'registration-access' 'registration-secret' 'registration-session'
pass "complete optional registration credentials are exported without log disclosure"

partial_registration_output="${temp_dir}/partial-registration-secrets.sh"
printf 'KEEP=existing\n' >"$partial_registration_output"
if env -u VOLCENGINE_SECRET_ACCESS_KEY -u VOLCENGINE_SECURITY_TOKEN \
  ARK_API_KEY=test \
  TOS_ACCESS_KEY=test \
  TOS_SECRET_KEY=test \
  POSTGRES_PASSWORD=test \
  MILVUS_PASSWORD=test \
  VOLCENGINE_ACCESS_KEY_ID='registration-access' \
  "$script" --from-env --secrets-only --output "$partial_registration_output" >/dev/null 2>&1; then
  fail "incomplete optional registration credentials did not fail"
fi
grep -Fxq 'KEEP=existing' "$partial_registration_output" || fail "incomplete registration credentials replaced existing output"
pass "incomplete optional registration credentials fail without replacing output"

kms_output="${temp_dir}/kms.env"
kms_log="${temp_dir}/kms.log"
VE_CLI_BIN="$fixture" "$script" --secret-name shortdrama/v011/devtest --output "$kms_output" >"$kms_log" 2>&1
[[ "$(file_mode "$kms_output")" == "600" ]] || fail "KMS output mode is not 600"
grep -Fq "ARK_API_KEY='kms-ark'" "$kms_output" || fail "KMS payload was not rendered"
assert_log_has_no_values "$kms_log" 'kms-ark' 'kms-tos-ak' 'kms-tos-sk' 'kms-db' 'kms-milvus'
pass "KMS response parsing and log redaction"

irsa_token="${temp_dir}/irsa-token"
printf 'test-oidc-token\n' >"$irsa_token"
irsa_output="${temp_dir}/irsa-secrets.sh"
irsa_log="${temp_dir}/irsa.log"
VOLCENGINE_OIDC_ROLE_TRN='trn:iam::000000000000:role/test-only' \
VOLCENGINE_OIDC_TOKEN_FILE="$irsa_token" \
VE_CLI_BIN="$fixture" \
  "$script" --require-irsa --secrets-only --secret-name shortdrama/v011/devtest \
  --output "$irsa_output" >"$irsa_log" 2>&1
[[ "$(file_mode "$irsa_output")" == "600" ]] || fail "IRSA secret export mode is not 600"
[[ "$(wc -l <"$irsa_output" | tr -d ' ')" == "5" ]] || fail "IRSA secret export does not contain exactly five lines"
(
  # shellcheck disable=SC1090
  source "$irsa_output"
  [[ "$ARK_API_KEY" == 'kms-ark' ]]
  [[ "$TOS_ACCESS_KEY" == 'kms-tos-ak' ]]
  [[ "$TOS_SECRET_KEY" == 'kms-tos-sk' ]]
  [[ "$POSTGRES_PASSWORD" == 'kms-db' ]]
  [[ "$MILVUS_PASSWORD" == 'kms-milvus' ]]
) || fail "IRSA secret export cannot be sourced safely"
assert_log_has_no_values "$irsa_log" 'kms-ark' 'kms-tos-ak' 'kms-tos-sk' 'kms-db' 'kms-milvus'
pass "IRSA precondition, secrets-only render, mode, and log redaction"

if VOLCENGINE_OIDC_ROLE_TRN='trn:iam::000000000000:role/test-only' \
  VOLCENGINE_OIDC_TOKEN_FILE="${temp_dir}/missing-token" \
  VE_CLI_BIN="$fixture" \
  "$script" --require-irsa --secrets-only --output "${temp_dir}/missing-irsa.env" >/dev/null 2>&1; then
  fail "missing IRSA token did not fail"
fi
[[ ! -e "${temp_dir}/missing-irsa.env" ]] || fail "missing IRSA token created an output file"
pass "missing IRSA token fails closed"

if env \
  ARK_API_KEY=test \
  TOS_ACCESS_KEY=test \
  TOS_SECRET_KEY=test \
  POSTGRES_PASSWORD=test \
  MILVUS_PASSWORD=test \
  "$script" --from-env --require-irsa --secrets-only --output "${temp_dir}/invalid-mode.env" >/dev/null 2>&1; then
  fail "incompatible --from-env and --require-irsa modes did not fail"
fi
pass "IRSA dev/test compatibility guard cannot be bypassed by from-env mode"

atomic_output="${temp_dir}/atomic.env"
printf 'KEEP=existing\n' >"$atomic_output"
if env -u MILVUS_PASSWORD \
  ARK_API_KEY=test \
  TOS_ACCESS_KEY=test \
  TOS_SECRET_KEY=test \
  POSTGRES_PASSWORD=test \
  "$script" --from-env --output "$atomic_output" >/dev/null 2>&1; then
  fail "missing from-env secret did not fail"
fi
grep -Fxq 'KEEP=existing' "$atomic_output" || fail "failed render replaced the existing output"
pass "missing from-env secret fails without replacing output"

if FAKE_VE_MODE=missing VE_CLI_BIN="$fixture" \
  "$script" --secret-name shortdrama/v011/devtest \
  --output "${temp_dir}/kms-missing.env" >/dev/null 2>&1; then
  fail "missing KMS secret did not fail"
fi
[[ ! -e "${temp_dir}/kms-missing.env" ]] || fail "failed KMS render created an output file"
pass "missing KMS secret fails closed"

printf 'PASS fetch-secrets test suite\n'
