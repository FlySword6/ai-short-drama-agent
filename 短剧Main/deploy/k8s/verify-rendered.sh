#!/usr/bin/env bash
# Offline fail-closed checks for the final manifest produced by the CD
# application environment. This script never contacts a Kubernetes cluster.
set -euo pipefail

usage() {
  printf 'Usage: %s RENDERED_MANIFEST.yaml --namespace NS --alb-name NAME\n' "${0##*/}" >&2
  printf '  NS    one of: shortdrama, shortdrama-dev, shortdrama-prod\n' >&2
  printf '  NAME  one of: shortdrama-alb, shortdrama-dev-alb, shortdrama-prod-alb\n' >&2
}
fail() {
  printf 'BLOCK %s\n' "$*" >&2
  exit 1
}
pass() {
  printf 'PASS %s\n' "$*"
}

manifest=""
namespace=""
alb_name=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)
      namespace="${2:-}"
      shift 2
      ;;
    --alb-name)
      alb_name="${2:-}"
      shift 2
      ;;
    --*)
      usage
      fail "unknown argument: $1"
      ;;
    *)
      [[ -z "$manifest" ]] || { usage; fail "unexpected extra argument: $1"; }
      manifest="$1"
      shift
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
evidence_validator="${script_dir}/validate-evidence.mjs"
scope_validator="${script_dir}/validate-manifest-scope.mjs"

[[ -n "$manifest" ]] || { usage; exit 2; }
[[ "$namespace" =~ ^shortdrama(-dev|-prod)?$ ]] || { usage; fail "--namespace must be shortdrama, shortdrama-dev or shortdrama-prod"; }
[[ "$alb_name" =~ ^shortdrama(-dev|-prod)?-alb$ ]] || { usage; fail "--alb-name must be shortdrama-alb, shortdrama-dev-alb or shortdrama-prod-alb"; }
[[ -f "$manifest" && -r "$manifest" ]] || fail "rendered manifest is not readable"
[[ -s "$manifest" ]] || fail "rendered manifest is empty"
command -v node >/dev/null 2>&1 || fail "Node.js is required to validate release material"
[[ -f "$scope_validator" ]] || fail "manifest scope validator is missing"
node "$scope_validator" "$manifest" --namespace "$namespace" --alb-name "$alb_name" \
  || fail "rendered resource/namespace scope validation failed"

if rg -q 'REPLACE_WITH|\.invalid\b|v0\.1\.1-unset' "$manifest"; then
  fail "release placeholders remain"
fi
pass "release placeholders are cleared"

rg -q '^kind: Namespace$' "$manifest" || fail "Namespace is missing"
rg -q "^  name: ${namespace}\$" "$manifest" || fail "${namespace} namespace is missing"
namespaces="$(sed -n 's/^  namespace: \([A-Za-z0-9-]*\)$/\1/p' "$manifest" | sort -u)"
[[ "$namespaces" == "$namespace" ]] || fail "foreign namespace is mixed into the release"
pass "release namespace is isolated"

if rg -q '^kind: (Secret|StatefulSet|PersistentVolumeClaim)$' "$manifest"; then
  fail "forbidden secret or in-cluster database resource is present"
fi
if rg -q 'ARK_API_KEY:|TOS_ACCESS_KEY:|TOS_SECRET_KEY:|POSTGRES_PASSWORD:|MILVUS_PASSWORD:' "$manifest"; then
  fail "secret-key data fields are present"
fi
if rg -q 'shortdrama/production$' "$manifest"; then
  fail "retired KMS credential name shortdrama/production is present"
fi
rg -q '^\s*- shortdrama/(dev|test|prod)/[a-z-]+$' "$manifest" \
  || fail "KMS credential name matching shortdrama/(dev|test|prod)/<name> is missing"
rg -q '/shortdrama-kms-init' "$manifest" || fail "repository-built KMS init helper is missing"
rg -q 'audience: sts\.volcengine\.com' "$manifest" || fail "IRSA token audience is missing"
rg -q 'name: VOLCENGINE_OIDC_ROLE_TRN' "$manifest" || fail "IRSA role environment is missing"
rg -q 'name: VOLCENGINE_OIDC_TOKEN_FILE' "$manifest" || fail "IRSA token environment is missing"
pass "secret flow stays in KMS/IRSA"

if rg -q '^\s*image:\s*\S+:(latest|main|dev)(@|\s*$)' "$manifest"; then
  fail "mutable or environment-mixing image tag is present"
fi
image_count="$(rg -c '^\s*image:\s*\S+' "$manifest")"
[[ "$image_count" -eq 3 ]] || fail "expected app plus two secret-fetcher images"
app_image="$(sed -n 's/^[[:space:]]*image:[[:space:]]*\([^[:space:]]*\/app:v0\.1\.2-[0-9a-f]\{40\}@sha256:[0-9a-f]\{64\}\)[[:space:]]*$/\1/p' "$manifest")"
init_images="$(sed -n 's/^[[:space:]]*image:[[:space:]]*\([^[:space:]]*\/kms-secret-init:v0\.1\.2-[0-9a-f]\{40\}@sha256:[0-9a-f]\{64\}\)[[:space:]]*$/\1/p' "$manifest")"
[[ -n "$app_image" && "$(printf '%s\n' "$app_image" | wc -l | tr -d ' ')" -eq 1 ]] \
  || fail "app image must use v0.1.2-<full SHA>@sha256:<digest>"
[[ -n "$init_images" && "$(printf '%s\n' "$init_images" | wc -l | tr -d ' ')" -eq 2 ]] \
  || fail "both secret init images must use v0.1.2-<full SHA>@sha256:<digest>"
pass "app and both secret init images are tag-and-digest anchored"

release_commits="$(sed -n 's/.*shortdrama\.zhongwen\.com\/release-commit: \([0-9a-f]\{40\}\)$/\1/p' "$manifest")"
commit_count="$(printf '%s\n' "$release_commits" | sed '/^$/d' | wc -l | tr -d ' ')"
[[ "$commit_count" -eq 2 ]] || fail "release commit annotation is not a full SHA on Deployment and Pod"
release_commit="$(printf '%s\n' "$release_commits" | head -n 1)"
[[ "$(printf '%s\n' "$release_commits" | sort -u | wc -l | tr -d ' ')" -eq 1 ]] \
  || fail "Deployment and Pod release commit annotations disagree"
app_commit="$(printf '%s' "$app_image" | sed -n 's/.*\/app:v0\.1\.2-\([0-9a-f]\{40\}\)@sha256:.*/\1/p')"
init_commits="$(printf '%s\n' "$init_images" | sed -n 's/.*\/kms-secret-init:v0\.1\.2-\([0-9a-f]\{40\}\)@sha256:.*/\1/p')"
[[ "$app_commit" == "$release_commit" && "$(printf '%s\n' "$init_commits" | sort -u | wc -l | tr -d ' ')" -eq 1 && "$(printf '%s\n' "$init_commits" | head -n 1)" == "$release_commit" ]] \
  || fail "image commit tags do not match the release commit annotation"
alb_instance_id="$(sed -n 's/^  instanceID: \([ac]lb-[A-Za-z0-9-]*\)$/\1/p' "$manifest")"
[[ -n "$alb_instance_id" ]] || fail "existing ALB instance ID is not configured"
rg -q "ingressClassName: ${alb_name}\$" "$manifest" || fail "Ingress does not select ${alb_name}"
# 证书中心证书绑定在 ALBInstance listener(cert_center);prod 双入口 HTTP-80 + HTTPS-443
rg -q 'value: trn:iam::[0-9]+:role/[A-Za-z0-9+=,.@_/-]+$' "$manifest" \
  || fail "IRSA role TRN is not configured"
rds_host="$(sed -n 's/^  POSTGRES_HOST: \([A-Za-z0-9.-]*\)$/\1/p' "$manifest")"
[[ -n "$rds_host" ]] || fail "RDS private hostname is missing"
case "$rds_host" in
  localhost|*.localhost|127.*|0.0.0.0|*.invalid) fail "RDS host is a local/sentinel address" ;;
esac
rg -q '^  POSTGRES_SCHEMA: app$' "$manifest" || fail "database schema must be app (see docs/contracts/environment-governance.md §2: schema 名不与环境名耦合)"
rg -q '^  POSTGRES_SSL_MODE: verify-full$' "$manifest" || fail "RDS TLS must use verify-full"
rg -q '^  POSTGRES_SSL_ROOT_CERT: /etc/ssl/certs/volcengine-rds/ca\.pem$' "$manifest" \
  || fail "RDS CA path is missing"
ca_pem="$(sed -n '/^  ca\.pem: |$/,/^    -----END CERTIFICATE-----$/p' "$manifest" | sed '1d; s/^    //')"
[[ -n "$ca_pem" ]] || fail "RDS CA certificate is not populated"
ca_base64="$(printf '%s\n' "$ca_pem" | base64 | tr -d '\n')"
ca_validation="$(node "${script_dir}/validate-rds-ca.mjs" "$ca_base64")" \
  || fail "RDS CA certificate validation failed"
printf '%s\n' "$ca_validation"
ca_fingerprint="$(printf '%s\n' "$ca_validation" | sed -n 's/^RDS_CA_FINGERPRINT_SHA256=\([0-9a-f]\{64\}\)$/\1/p')"
[[ -n "$ca_fingerprint" ]] || fail "RDS CA fingerprint is missing"
rg -q '^  VKE_NETWORK_MODE: VPC-CNI$' "$manifest" \
  || fail "VCI ClusterIP release requires a VPC-CNI cluster"
vke_target="$(sed -n 's/^  VKE_TARGET_ID: \(c[a-z][A-Za-z0-9]*\)$/\1/p' "$manifest")"
[[ -n "$vke_target" ]] || fail "target VKE cluster ID is missing"
rg -q 'ingress\.vke\.volcengine\.com/loadbalancer-pass-through: "true"$' "$manifest" \
  || fail "ALB must register VCI Pod IPs directly"
domain="$(sed -n 's/^[[:space:]]*- host: \([A-Za-z0-9.-]*\)$/\1/p' "$manifest")"
[[ "$domain" != *.invalid ]] || fail "release Ingress domain is a sentinel value"
admin_usernames="$(sed -n 's/^  ADMIN_USERNAMES: "\{0,1\}\([a-z0-9][a-z0-9,._-]*\)"\{0,1\}$/\1/p' "$manifest")"
[[ -n "$admin_usernames" ]] || fail "at least one lowercase administrator username is required"
# 四条部署期证据回执挂在 ConfigMap 的 metadata.annotations 上,不在 data 里——
# data 的键会被 envFrom 原样灌进 Pod 环境变量,没填的占位符不该进运行时环境。
if rg -q '^\s*(RDS_PRIVATE_CONNECTIVITY|ADMIN_BOOTSTRAP|ALB_POD_DIRECT_ACCESS_PREFLIGHT|VCI_POD_SECURITY_GROUP_PREFLIGHT)_EVIDENCE:' "$manifest"; then
  fail "deployment evidence receipts must stay in metadata.annotations, not ConfigMap data"
fi
evidence_receipt() {
  sed -n "s|^[[:space:]]*shortdrama\.zhongwen\.com/${1}: \([^[:space:]]*\)\$|\1|p" "$manifest"
}
rds_receipt="$(evidence_receipt rds-private-connectivity-evidence)"
admin_receipt="$(evidence_receipt admin-bootstrap-evidence)"
alb_receipt="$(evidence_receipt alb-pod-direct-access-preflight-evidence)"
security_group_receipt="$(evidence_receipt vci-pod-security-group-preflight-evidence)"
[[ -f "$evidence_validator" ]] || fail "structured evidence validator is missing"
node "$evidence_validator" \
  --release-commit "$release_commit" \
  --target "$vke_target" \
  --rds-host "$rds_host" \
  --admin-usernames "$admin_usernames" \
  --alb-instance-id "$alb_instance_id" \
  --domain "$domain" \
  --namespace "$namespace" \
  --rds-ca-fingerprint "$ca_fingerprint" \
  --receipt "rds_private_connectivity=${rds_receipt}" \
  --receipt "admin_bootstrap=${admin_receipt}" \
  --receipt "alb_pod_direct_access_preflight=${alb_receipt}" \
  --receipt "vci_pod_security_group_preflight=${security_group_receipt}" \
  || fail "structured evidence receipt validation failed"
if [[ "$namespace" == "shortdrama" ]]; then
  rg -q '^  AI_GATEWAY_ENABLED: "true"$' "$manifest" \
    || fail "S56 test AI gateway must remain enabled"
  rg -q '^  AI_DAILY_CALL_LIMIT: "5000"$' "$manifest" \
    || fail "S56 test AI gateway daily call cap must remain 5000"
else
  rg -q '^  AI_GATEWAY_ENABLED: "false"$' "$manifest" \
    || fail "unapproved dev/prod AI gateway must remain disabled"
  rg -q '^  AI_DAILY_CALL_LIMIT: "200"$' "$manifest" \
    || fail "unapproved dev/prod AI daily call cap must remain 200"
fi
rg -q '^  NODE_ENV: "?production"?$' "$manifest" \
  || fail "VKE runtime must keep the production environment guard"
rg -q '^  AUTH_EMAIL_DELIVERY_MODE: "?dev_log"?$' "$manifest" \
  || fail "unwired email delivery must keep the production fail-closed pair"
# DC 2026-07-29 指名授权在测试环境开启真实付费生成(原话:「发版,开生成(生图生视频生音频还有
# LLM、agent 都开)」)。守卫不删,改口径:开关允许为 true,但**预算必须是有上限的正整数**——
# 无上限或缺失即失败,防止「开了闸忘了设上限」把额度烧穿。
rg -q '^  ALLOW_PAID_GENERATION: "(true|false)"$' "$manifest" \
  || fail "paid generation switch must be an explicit true/false"
rg -q '^  PAID_GENERATION_BUDGET_FEN: "[1-9][0-9]*"$' "$manifest" \
  || rg -q '^  PAID_GENERATION_BUDGET_FEN: "0"$' "$manifest" \
  || fail "paid generation budget must be an explicit non-negative integer (no unlimited)"
probe_path() {
  local probe="$1"
  awk -v probe="$probe" '
    $0 ~ "^[[:space:]]*" probe ":$" { found = 1; next }
    found && $1 == "path:" { print $2; exit }
  ' "$manifest"
}
[[ "$(probe_path startupProbe)" == "/api/v1/health" ]] \
  || fail "startup probe must use the process-only health endpoint"
[[ "$(probe_path readinessProbe)" == "/api/v1/ready" ]] \
  || fail "readiness probe must gate on DB/schema/migration readiness"
[[ "$(probe_path livenessProbe)" == "/api/v1/health" ]] \
  || fail "liveness probe must not restart the app for a database outage"
rg -q 'protocol: HTTP$' "$manifest" || fail "ALB listener is not HTTP-80 launch profile"
rg -q 'port: 80$' "$manifest" || fail "ALB HTTP listener is not on port 80"
rg -q 'loadbalancer-protocol: http$' "$manifest" || fail "Ingress does not select ALB HTTP-80"
# prod 双入口:HTTPS-443 监听 + 证书中心证书(cert_center);dev/test 不要求 HTTPS
if [[ "$namespace" == "shortdrama-prod" ]]; then
  rg -q 'protocol: HTTPS$' "$manifest" || fail "prod ALB missing HTTPS-443 listener"
  rg -q 'port: 443$' "$manifest" || fail "prod ALB HTTPS listener is not on 443"
  rg -q 'certificateID: cert-ba8e5c12729b478fbe6d0b895d31852a$' "$manifest" \
    || fail "prod ALB HTTPS listener misses the cert-center certificate"
  rg -q 'certificateSource: cert_center$' "$manifest" \
    || fail "prod ALB HTTPS listener certificate source is not the certificate center"
  rg -q 'name: shortdrama-https$' "$manifest" || fail "prod HTTPS Ingress is missing"
  rg -q 'loadbalancer-protocol: https$' "$manifest" \
    || fail "prod Ingress does not select ALB HTTPS-443"
fi
pass "commit, ALB HTTP-80+HTTPS-443, IRSA, TLS RDS and administrator anchors are configured"

printf 'PASS rendered VKE release manifest\n'
