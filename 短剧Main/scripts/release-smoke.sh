#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:${SHORTDRAMA_HTTP_PORT:-80}}"

health="$(curl --fail --silent --show-error --max-time 10 "${base_url}/api/v1/health")"
printf '%s\n' "$health"

case "$health" in
  *'"status":"ok"'*) ;;
  *) echo "health endpoint did not return status=ok" >&2; exit 1 ;;
esac

# 制品身份核对。SHORTDRAMA_EXPECTED_SHA 给了就必须逐字相等——发布回执要证明"清单
# 指向的制品"和"实际在跑的进程"是同一个,靠人眼看响应体不算证明。
# 本地构建拿不到 sha 是合法的(显示 unknown),所以未给期望值时只告警不失败。
actual_sha="$(printf '%s' "$health" | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p')"
if [[ -z "$actual_sha" ]]; then
  echo "health response has no sha field; image predates commit-sha injection" >&2
  exit 1
fi

expected_sha="${SHORTDRAMA_EXPECTED_SHA:-}"
if [[ -n "$expected_sha" ]]; then
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "commit sha mismatch: expected ${expected_sha}, health reports ${actual_sha}" >&2
    exit 1
  fi
  echo "commit sha verified: ${actual_sha}"
elif [[ "$actual_sha" == "unknown" ]]; then
  echo "WARNING: image carries no commit sha (built without GIT_SHA); not traceable to a commit" >&2
else
  echo "commit sha reported: ${actual_sha} (no SHORTDRAMA_EXPECTED_SHA to verify against)"
fi

# Authentication must still protect private API paths even when the reverse
# proxy is reachable from the public IP.
status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "${base_url}/api/v1/auth/me")"
if [[ "$status" != "401" ]]; then
  echo "expected unauthenticated /api/v1/auth/me to return 401, got ${status}" >&2
  exit 1
fi

echo "release smoke passed: health is reachable and private API requires login"
