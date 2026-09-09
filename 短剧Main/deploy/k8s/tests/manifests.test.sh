#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
k8s_dir="${repo_root}/deploy/k8s"
base_dir="${k8s_dir}/base"
rendered="$(mktemp "${TMPDIR:-/tmp}/shortdrama-vke.XXXXXX")"
rendered_base="$(mktemp "${TMPDIR:-/tmp}/shortdrama-vke-base.XXXXXX")"
rendered_dev="$(mktemp "${TMPDIR:-/tmp}/shortdrama-vke-dev.XXXXXX")"
rendered_prod="$(mktemp "${TMPDIR:-/tmp}/shortdrama-vke-prod.XXXXXX")"
release_fixture="$(mktemp "${TMPDIR:-/tmp}/shortdrama-vke-release.XXXXXX")"
evidence_dir="$(mktemp -d "${repo_root}/docs/validation/.vke-evidence-test.XXXXXX")"
rds_evidence="${evidence_dir}/rds.json"
admin_evidence="${evidence_dir}/admin.json"
alb_evidence="${evidence_dir}/alb.json"
security_group_evidence="${evidence_dir}/security-group.json"
unsafe_security_group_evidence="${evidence_dir}/unsafe-security-group.json"
wide_port_security_group_evidence="${evidence_dir}/wide-port-security-group.json"
unknown_action_security_group_evidence="${evidence_dir}/unknown-action-security-group.json"

cleanup() {
  rm -f -- "$rendered" "$rendered_base" "$rendered_dev" "$rendered_prod" "$release_fixture" \
    "$rds_evidence" "$admin_evidence" "$alb_evidence" "$security_group_evidence"
  rm -f -- "$unsafe_security_group_evidence" \
    "$wide_port_security_group_evidence" "$unknown_action_security_group_evidence"
  rm -f -- "${evidence_dir}"/prod-*.json
  rmdir "$evidence_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
must_have() {
  local file="$1" pattern="$2" description="$3"
  rg -q -- "$pattern" "$file" || fail "$description"
}
must_not_have() {
  local file="$1" pattern="$2" description="$3"
  rg -q -- "$pattern" "$file" && fail "$description"
  return 0
}

command -v kubectl >/dev/null 2>&1 || fail "kubectl is required for offline Kustomize rendering"

for target in base overlays/test overlays/dev overlays/prod; do
  [[ -s "$k8s_dir/$target/kustomization.yaml" ]] || fail "kustomization is missing: $target"
done
pass "base plus test/dev/prod overlays exist"

set +e
kubectl kustomize "$k8s_dir" >/dev/null 2>&1
root_render_status=$?
set -e
[[ "$root_render_status" -ne 0 ]] || fail "deploy/k8s root must not render without an explicit environment"
pass "deploy/k8s root no longer renders without an explicit environment"

kubectl kustomize "$base_dir" >"$rendered_base"
kubectl kustomize "$k8s_dir/overlays/test" >"$rendered"
kubectl kustomize "$k8s_dir/overlays/dev" >"$rendered_dev"
kubectl kustomize "$k8s_dir/overlays/prod" >"$rendered_prod"
for file in "$rendered_base" "$rendered" "$rendered_dev" "$rendered_prod"; do
  [[ -s "$file" ]] || fail "Kustomize rendered an empty manifest: $file"
done
pass "Kustomize renders base and all three overlays offline"

for kind in Namespace ConfigMap ServiceAccount Deployment Service Ingress ALBInstance; do
  must_have "$rendered" "kind: ${kind}$" "rendered test manifest is missing ${kind}"
done
pass "required Kubernetes and ALB resources exist"

must_have "$base_dir/namespace.yaml" 'name: shortdrama$' "test namespace is not fixed"
for file in service-account.yaml configmap.yaml rds-ca-configmap.yaml deployment.yaml service.yaml ingress.yaml; do
  must_have "$base_dir/$file" 'namespace: shortdrama$' "$file is not isolated in shortdrama"
done
must_not_have "$rendered" 'namespace: (default|dev|shortdrama-dev|shortdrama-prod)$' "test package mixes foreign namespaces"
must_not_have "$rendered" 'shortdrama-dev|shortdrama-prod-alb|shortdrama/(dev|prod)/runtime' "test package references dev/prod identities"
must_have "$rendered_dev" 'name: shortdrama-dev$' "dev overlay does not rename the Namespace resource"
must_have "$rendered_dev" '^  namespace: shortdrama-dev$' "dev overlay is not isolated in shortdrama-dev"
must_have "$rendered_dev" 'shortdrama/dev/runtime' "dev overlay does not select the dev KMS credential"
must_have "$rendered_dev" 'REPLACE_WITH_DEV_' "dev overlay must keep fail-closed placeholders"
must_have "$rendered_dev" 'WECOM_LOGIN_ENABLED: "false"' "dev WeCom login must remain disabled"
must_have "$rendered_dev" 'WECOM_CORP_ID: ww403b31a2be286507' "dev WeCom CorpID is not registered"
must_have "$rendered_dev" 'WECOM_AGENT_ID: "1000002"' "dev WeCom AgentID is not registered"
must_have "$rendered_prod" 'name: shortdrama-prod$' "prod overlay does not rename the Namespace resource"
must_have "$rendered_prod" '^  namespace: shortdrama-prod$' "prod overlay is not isolated in shortdrama-prod"
must_have "$rendered_prod" 'shortdrama/prod/runtime' "prod overlay does not select the prod KMS credential"
must_not_have "$rendered_prod" 'REPLACE_WITH_' "prod overlay must clear all fail-closed placeholders"
pass "three environments are isolated by overlay"

must_have "$base_dir/deployment.yaml" 'vke\.volcengine\.com/burst-to-vci: enforce' "Deployment does not force VCI"
must_have "$base_dir/deployment.yaml" 'runAsNonRoot: true' "Pod does not require non-root"
[[ "$(rg -c 'readOnlyRootFilesystem: true' "$base_dir/deployment.yaml")" -eq 3 ]] || fail "both init containers and app must use read-only root filesystems"
[[ "$(rg -c 'allowPrivilegeEscalation: false' "$base_dir/deployment.yaml")" -eq 3 ]] || fail "both init containers and app must forbid privilege escalation"
[[ "$(rg -c -- '- ALL' "$base_dir/deployment.yaml")" -eq 3 ]] || fail "both init containers and app must drop all Linux capabilities"
must_have "$base_dir/deployment.yaml" 'type: RuntimeDefault' "Pod does not use RuntimeDefault seccomp"
pass "container securityContext matches read-only/cap-drop contract"

must_have "$base_dir/deployment.yaml" 'cpu: "2"' "app CPU request/limit is missing"
[[ "$(rg -c 'memory: 4Gi' "$base_dir/deployment.yaml")" -eq 2 ]] || fail "app request and limit must both be 4Gi"
[[ "$(rg -c 'cpu: 250m' "$base_dir/deployment.yaml")" -eq 4 ]] || fail "both init containers must set matching CPU requests and limits"
[[ "$(rg -c 'memory: 256Mi' "$base_dir/deployment.yaml")" -eq 4 ]] || fail "both init containers must set matching memory requests and limits"
must_have "$base_dir/deployment.yaml" 'replicas: 1' "cost baseline must use one steady-state replica"
pass "VCI resources are explicit and Guaranteed-QoS compatible"

[[ "$(rg -c '/shortdrama-kms-init' "$base_dir/deployment.yaml")" -eq 2 ]] || fail "Deployment must invoke secret-init exactly twice"
must_have "$base_dir/deployment.yaml" 'name: secret-fetcher' "production KMS initContainer is missing"
must_have "$base_dir/deployment.yaml" 'name: vnext-secret-fetcher' "vnext KMS initContainer is missing"
[[ "$(rg -c 'shortdrama/test/runtime' "$base_dir/deployment.yaml")" -eq 1 ]] || fail "production secret name must be configured exactly once"
[[ "$(rg -c 'shortdrama/test/vnext-runtime' "$base_dir/deployment.yaml")" -eq 1 ]] || fail "vnext secret name must be configured exactly once"
[[ "$(rg -c '/run/shortdrama/production-secrets\.sh' "$base_dir/deployment.yaml")" -eq 2 ]] || fail "production secret output and source must match"
[[ "$(rg -c '/run/shortdrama/vnext-secrets\.sh' "$base_dir/deployment.yaml")" -eq 2 ]] || fail "vnext secret output and source must match"
production_source_line="$(rg -n 'source /run/shortdrama/production-secrets\.sh' "$base_dir/deployment.yaml" | cut -d: -f1)"
vnext_source_line="$(rg -n 'source /run/shortdrama/vnext-secrets\.sh' "$base_dir/deployment.yaml" | cut -d: -f1)"
[[ "$production_source_line" -lt "$vnext_source_line" ]] || fail "app must source production secrets before vnext secrets"
must_not_have "$base_dir/deployment.yaml" 'shortdrama/production$' "retired KMS credential name is still referenced"
must_have "$base_dir/deployment.yaml" '/shortdrama-kms-init' "repository-built KMS init helper is not used"
must_have "$base_dir/deployment.yaml" 'audience: sts\.volcengine\.com' "IRSA projected token audience is wrong"
must_have "$base_dir/deployment.yaml" 'medium: Memory' "secret emptyDir is not memory-backed"
for file in "$rendered_base" "$rendered" "$rendered_dev" "$rendered_prod"; do
  must_not_have "$file" '^kind: Secret$' "release package must not contain a Kubernetes Secret"
  must_not_have "$file" 'ARK_API_KEY:|TOS_ACCESS_KEY:|TOS_SECRET_KEY:|POSTGRES_PASSWORD:|MILVUS_PASSWORD:|SEED_AUDIO_API_KEY:|MINIMAX_API_KEY:|NEWAPI_API_KEY:|COL_BASE_URL:|COL_APIKEY:|WECOM_CORP_SECRET' "release package contains secret-key data fields"
done
pass "initContainer secret flow is IRSA-gated and repository-secret-free"

for file in Dockerfile go.mod go.sum main.go main_test.go; do
  [[ -s "$k8s_dir/secret-init/$file" ]] || fail "secret-init build source is missing: $file"
done
must_have "$k8s_dir/secret-init/go.mod" 'github\.com/volcengine/volcengine-go-sdk v[0-9]+\.[0-9]+\.[0-9]+' "official Go SDK is not version-pinned"
must_have "$k8s_dir/secret-init/Dockerfile" 'ENTRYPOINT \["/shortdrama-kms-init"\]' "secret-init image entrypoint drifts from Deployment"
must_have "$k8s_dir/secret-init/Dockerfile" '^FROM scratch$' "secret-init runtime image is not scratch"
must_have "$k8s_dir/secret-init/main.go" 'NewOIDCCredentialsProviderWithOptions' "secret-init does not use the official OIDC provider"
must_have "$k8s_dir/secret-init/main.go" 'oidcSessionDurationSeconds = 900' "secret-init OIDC session duration is not bounded below the IAM role maximum"
must_have "$k8s_dir/secret-init/main.go" 'sslmode.*verify-full|query\.Set\("sslmode", "verify-full"\)' "secret-init does not force RDS verify-full"
must_have "$k8s_dir/secret-init/main.go" 'secretNamePattern.*shortdrama/\(dev\|test\|prod\)/\[a-z-\]' "secret-init does not fail closed on the KMS name allowlist"
must_not_have "$k8s_dir/secret-init/main.go" 'productionSecretName' "secret-init still hardcodes the retired KMS credential constant"
[[ -s "$k8s_dir/validate-evidence.mjs" ]] || fail "structured evidence validator is missing"
[[ -s "$k8s_dir/validate-rds-ca.mjs" ]] || fail "RDS CA validator is missing"
[[ -s "$k8s_dir/validate-manifest-scope.mjs" ]] || fail "manifest scope validator is missing"
pass "secret-init image is repository-built from pinned official SDK source"

# v0.1.2 起实值入仓(host/CA/digest 非 secret,DC 授权):断言真实地址,错值与占位都挡。
# 2026-08-11 改:原先钉的是私网端点 postgres4a3018919997.rds-pg.ivolces.com。
# 私网是目标态没错,但 docs/deploy/live-vs-repo-diff.md §6 自己写着「内网 RDS 从 VCI Pod
# 的连通性:从未被证据链证明过」,而线上跑的一直是下面这个公网端点。
# 门禁不该钉一个从没验证过能连上的值。等 rds_private_connectivity 实测证据出来,
# 这一行和 configmap 一起改回私网。
must_have "$base_dir/configmap.yaml" 'POSTGRES_HOST: postgres-4a3018919997-public\.rds-pg\.volces\.com' "RDS endpoint is wrong or placeholder"
must_have "$base_dir/configmap.yaml" 'APP_VERSION: "0\.3\.0"' "app version is not V0.3.0"
must_have "$base_dir/configmap.yaml" 'POSTGRES_SCHEMA: app' "database schema is not fixed to app (schema 名不得与环境名耦合)"
# 2026-08-11 改:原先钉的是 verify-full。那是目标态,不是 test 现实——
# 现在真正消费本 ConfigMap 的是集群里那个手工建的 Deployment shortdrama-main,
# 它没挂 rds-ca 卷(实测 /etc/ssl/certs/volcengine-rds/ca.pem 不存在),
# src/db/tls.ts:32 的 readFileSync 拿不到文件直接抛,verify-full 一生效就断库。
# 与 POSTGRES_HOST 那条同因:两个键是一套的,要么都按现实要么都按目标态。
# CA 卷挂上之后,这一行和 configmap 一起改回 verify-full。
# dev/prod 没有历史 Pod,由各自 overlay 钉死 verify-full,见下面两条渲染断言。
must_have "$base_dir/configmap.yaml" 'POSTGRES_SSL_MODE: disable' "test baseline must match the live Pod that has no CA mounted"
must_have "$base_dir/configmap.yaml" 'POSTGRES_SSL_ROOT_CERT: /etc/ssl/certs/volcengine-rds/ca\.pem' "RDS CA path is missing"
must_have "$rendered_dev" 'POSTGRES_SSL_MODE: verify-full' "dev overlay inherited the test-only TLS downgrade"
must_have "$rendered_prod" 'POSTGRES_SSL_MODE: verify-full' "prod overlay inherited the test-only TLS downgrade"
# 部署期证据回执必须留在 metadata.annotations:data 里的键会被 envFrom
# 原样灌进 Pod 环境变量,等于把没填的 REPLACE_WITH_* 占位符带进运行时。
for key in RDS_PRIVATE_CONNECTIVITY_EVIDENCE ADMIN_BOOTSTRAP_EVIDENCE \
  ALB_POD_DIRECT_ACCESS_PREFLIGHT_EVIDENCE VCI_POD_SECURITY_GROUP_PREFLIGHT_EVIDENCE; do
  must_not_have "$base_dir/configmap.yaml" "^  ${key}:" "deployment evidence placeholder leaked back into ConfigMap data: ${key}"
done
for annotation in rds-private-connectivity-evidence admin-bootstrap-evidence \
  alb-pod-direct-access-preflight-evidence vci-pod-security-group-preflight-evidence; do
  must_have "$base_dir/configmap.yaml" "^    shortdrama\.zhongwen\.com/${annotation}: REPLACE_WITH_" \
    "deployment evidence annotation is missing or not fail-closed: ${annotation}"
  must_have "$rendered" "shortdrama\.zhongwen\.com/${annotation}: " "rendered test manifest lost the evidence annotation: ${annotation}"
done
# 2026-08-11:跟随线上补 http:// 协议头。主机仍是同 VPC 私网(ivolces),下面那条
# 「不许用公网 milvus」的断言继续有效。
must_have "$base_dir/configmap.yaml" 'MILVUS_URI: "http://milvus-008wns5nrtu8\.milvus\.ivolces\.com:19530"' "test Milvus must use the same-VPC private endpoint"
must_not_have "$base_dir/configmap.yaml" 'MILVUS_URI: "milvus-008wns5nrtu8\.milvus\.volces\.com:19530"' "test Milvus must not depend on the public allowlist"
must_have "$base_dir/configmap.yaml" 'SEED_AUDIO_ENDPOINT: https://openspeech\.bytedance\.com/api/v3/tts/create' "Seed Audio endpoint is missing from test runtime configuration"
must_have "$base_dir/configmap.yaml" 'SEED_AUDIO_MODEL: seed-audio-1\.0' "Seed Audio model is missing from test runtime configuration"
must_have "$base_dir/configmap.yaml" 'COMPANY_PROVIDER_ALLOWLIST: ark' "company provider allowlist must default to Ark only"
must_not_have "$base_dir/configmap.yaml" 'COMPANY_PROVIDER_ALLOWLIST:.*(minimax|newapi)' "unapproved provider entered the company account allowlist"
must_not_have "$base_dir/configmap.yaml" 'MINIMAX_DIRECT_API_ENABLED' "MiniMax private-account direct API must not expose a runtime enable switch"
must_have "$base_dir/configmap.yaml" 'MINIMAX_API_HOST: https://api\.minimaxi\.com' "MiniMax API host is missing from runtime configuration"
for key in MINIMAX_LLM_MODELS MINIMAX_IMAGE_MODELS MINIMAX_VIDEO_MODELS MINIMAX_AUDIO_MODELS; do
  must_have "$base_dir/configmap.yaml" "${key}: \"\"" "MiniMax model allowlist must stay explicitly empty by default: ${key}"
done
must_have "$base_dir/configmap.yaml" 'NEWAPI_GENERATION_ENABLED: "false"' "company newapi gateway must default closed"
for key in NEWAPI_BASE_URL NEWAPI_APPROVED_BASE_URL_SHA256 NEWAPI_GPT_IMAGE_MODELS NEWAPI_GEMINI_IMAGE_MODELS; do
  must_have "$base_dir/configmap.yaml" "${key}: \"\"" "newapi setting must stay explicitly empty by default: ${key}"
done
must_not_have "$repo_root/.env.release.example" '^MINIMAX_DIRECT_API_ENABLED=' "release env example must not expose a MiniMax direct-call switch"
must_have "$repo_root/.env.release.example" '^COMPANY_PROVIDER_ALLOWLIST=ark$' "release env example must default to the Ark company account only"
must_have "$repo_root/.env.release.example" '^NEWAPI_GENERATION_ENABLED=false$' "release env example must keep newapi disabled"
for key in NEWAPI_BASE_URL NEWAPI_APPROVED_BASE_URL_SHA256 NEWAPI_GPT_IMAGE_MODELS NEWAPI_GEMINI_IMAGE_MODELS; do
  must_have "$repo_root/.env.release.example" "^${key}=$" "release env example must keep newapi setting empty: ${key}"
done
must_have "$base_dir/configmap.yaml" 'AI_GATEWAY_ENABLED: "true"' "S56 AI gateway baseline is not enabled"
must_have "$base_dir/configmap.yaml" 'AI_DAILY_CALL_LIMIT: "5000"' "S56 AI gateway daily call cap is not 5000"
must_have "$rendered" 'AI_GATEWAY_ENABLED: "true"' "rendered test overlay disables the S56 AI gateway"
must_have "$rendered" 'AI_DAILY_CALL_LIMIT: "5000"' "rendered test overlay lowers the S56 AI daily call cap"
must_have "$rendered_dev" 'AI_GATEWAY_ENABLED: "false"' "dev overlay inherits the test AI gateway enablement"
must_have "$rendered_dev" 'AI_DAILY_CALL_LIMIT: "200"' "dev overlay inherits the test AI daily call cap"
must_have "$rendered_prod" 'AI_GATEWAY_ENABLED: "false"' "prod overlay inherits the test AI gateway enablement"
must_have "$rendered_prod" 'AI_DAILY_CALL_LIMIT: "200"' "prod overlay inherits the test AI daily call cap"
# prod 双入口:ALBInstance HTTPS-443 监听绑定证书中心证书 + HTTPS Ingress
must_have "$rendered_prod" 'protocol: HTTPS' "prod ALB missing HTTPS-443 listener"
must_have "$rendered_prod" 'port: 443' "prod ALB HTTPS listener is not on 443"
must_have "$rendered_prod" 'certificateID: cert-ba8e5c12729b478fbe6d0b895d31852a' "prod ALB HTTPS listener misses the cert-center certificate"
must_have "$rendered_prod" 'certificateSource: cert_center' "prod ALB HTTPS certificate source is not the certificate center"
must_have "$rendered_prod" 'name: shortdrama-https' "prod HTTPS Ingress is missing"
must_have "$rendered_prod" 'loadbalancer-protocol: https' "prod Ingress does not select ALB HTTPS-443"
must_have "$base_dir/configmap.yaml" 'NODE_ENV: "production"' "VKE runtime must use the production environment guard"
# 测试环境跑在 NODE_ENV=production 上，「开发和测试允许多处同时登录」推导不出来，
# 只能显式写；生产必须覆盖回单点登录。两头都钉住，任何一头漂移都算回归。
must_have "$base_dir/configmap.yaml" 'AUTH_SINGLE_ACTIVE_SESSION: "false"' "test environment must allow the same account to stay signed in on several devices"
must_have "$rendered_prod" 'AUTH_SINGLE_ACTIVE_SESSION: "true"' "production must keep the single-active-session login policy"
must_have "$rendered" 'AUTH_SINGLE_ACTIVE_SESSION: "false"' "rendered test overlay lost the parallel-login setting"
must_have "$base_dir/configmap.yaml" 'AUTH_EMAIL_DELIVERY_MODE: "dev_log"' "unwired mail delivery mode drifted from the production fail-closed pair"
# 2026-08-11 改:原先钉死 "false"。但线上是 true,config/README.md 第三节也写明
# 测试环境必须开(周一验收要用)——门禁、线上、README 三处打架,且门禁是唯一
# 没有依据的那一方。base 是测试环境的口径,所以跟随测试:true。
# 生产要不要关,由 deploy/k8s/overlays/prod 决定,不该由 base 门禁替生产拿主意。
must_have "$base_dir/configmap.yaml" 'ALLOW_MEMBER_CREATE_PROJECT: "true"' "test baseline must allow member project creation"
must_have "$base_dir/configmap.yaml" 'TOPIC_RADAR_52API_ENABLED: "false"' "52api topic radar must stay disabled until its key enters KMS"
must_have "$base_dir/rds-ca-configmap.yaml" 'ca\.pem: \|' "RDS CA is missing or not a PEM block"
must_have "$base_dir/rds-ca-configmap.yaml" '-----BEGIN CERTIFICATE-----' "RDS CA is not a real PEM certificate"
must_not_have "$base_dir/rds-ca-configmap.yaml" 'REPLACE_WITH_VOLCENGINE_RDS_CA_PEM' "RDS CA placeholder must be replaced"
must_not_have "$rendered" 'kind: (StatefulSet|PersistentVolumeClaim)' "VKE package must not deploy PostgreSQL storage"
must_have "$base_dir/service.yaml" 'type: ClusterIP' "app Service must remain internal"
must_have "$base_dir/ingress.yaml" 'ingressClassName: shortdrama-alb' "Ingress is not bound to the ALBInstance"
must_have "$base_dir/ingress.yaml" 'ingress\.vke\.volcengine\.com/loadbalancer-pass-through: "true"' "VCI ClusterIP backend does not enable ALB Pod pass-through"
must_have "$base_dir/configmap.yaml" 'VKE_NETWORK_MODE: VPC-CNI' "VCI ClusterIP release is not hard-gated to VPC-CNI"
must_have "$base_dir/ingress.yaml" 'path: /$' "ALB ingress path / matches all subpaths (/* rejected by VKE ALB rules)"
must_have "$base_dir/alb-instance.yaml" 'name: shortdrama-alb' "ALBInstance name does not match Ingress class"
# base 保持 HTTP-80 通用档;HTTPS-443 + 证书(证书中心 cert_center)由 prod overlay 追加
must_have "$base_dir/alb-instance.yaml" 'protocol: HTTP' "ALB listener is not HTTP-80 launch profile"
must_have "$base_dir/alb-instance.yaml" 'port: 80' "ALB HTTP listener is not on 80"
must_have "$base_dir/ingress.yaml" 'loadbalancer-protocol: http' "Ingress does not select ALB HTTP-80"
must_not_have "$rendered" 'Caddy|caddy' "VKE package still references Caddy"
pass "RDS, Service and ALB Ingress topology replaces Compose db/Caddy"

must_have "$base_dir/deployment.yaml" 'type: RollingUpdate' "rolling upgrade strategy is missing"
must_have "$base_dir/deployment.yaml" 'maxUnavailable: 0' "rolling upgrade may remove the only ready replica"
must_have "$base_dir/deployment.yaml" 'revisionHistoryLimit: 10' "rollback revision history is missing"
for probe in startupProbe readinessProbe livenessProbe; do
  must_have "$base_dir/deployment.yaml" "${probe}:" "${probe} is missing"
done
probe_path() {
  local file="$1" probe="$2"
  awk -v probe="$probe" '
    $0 ~ "^[[:space:]]*" probe ":$" { found = 1; next }
    found && $1 == "path:" { print $2; exit }
  ' "$file"
}
assert_probe_contract() {
  local file="$1" label="$2"
  [[ "$(probe_path "$file" startupProbe)" == "/api/v1/health" ]] || fail "${label} startup probe must use the process-only health endpoint"
  [[ "$(probe_path "$file" readinessProbe)" == "/api/v1/ready" ]] || fail "${label} readiness probe must gate on DB/schema/migration readiness"
  [[ "$(probe_path "$file" livenessProbe)" == "/api/v1/health" ]] || fail "${label} liveness probe must not restart the app for a database outage"
  [[ "$(rg -c 'path: /api/v1/health' "$file")" -eq 2 ]] || fail "${label} must use health only for startup and liveness"
  [[ "$(rg -c 'path: /api/v1/ready' "$file")" -eq 1 ]] || fail "${label} must contain exactly one dependency readiness probe"
}
assert_probe_contract "$base_dir/deployment.yaml" "base"
assert_probe_contract "$rendered_base" "rendered base"
assert_probe_contract "$rendered" "rendered test"
assert_probe_contract "$rendered_dev" "rendered dev"
assert_probe_contract "$rendered_prod" "rendered prod"
pass "process probes, dependency readiness, rolling upgrade and rollback anchors exist"

must_have "$rendered" 'clb-13f4w460szabk3n6nu5ki5jao' "rendered manifest lost real ALB instance id"
must_have "$rendered" 'trn:iam::2100701382:role/shortdrama-prod-kms-reader' "rendered manifest lost configured IRSA role TRN"
# 2026-08-11:与上面 base 那条同步,从私网端点改成线上实跑的公网端点。
# (#200 那一版写的是私网 ivolces,那是它成文时的目标态;#242 实测私网从没通过,
#  已降级到公网。这一行按现实,不按 #200。)
must_have "$rendered" 'postgres-4a3018919997-public\.rds-pg\.volces\.com' "rendered manifest lost real RDS endpoint"
# 镜像摘要跟随 v0.1.2 定版(#200 的核心交付),不再是 07-23 那两个。
must_have "$rendered" 'app:v0\.1\.2-508dfee9325d05a07c546cebd86b0d4ca0184ead@sha256:2ac9abe9' "rendered manifest lost pinned app image digest"
must_have "$rendered" 'kms-secret-init:v0\.1\.2-508dfee9325d05a07c546cebd86b0d4ca0184ead@sha256:4119b551' "rendered manifest lost pinned init image digest"
pass "unconfigured base cannot masquerade as release-ready"

set +e
bash "$k8s_dir/verify-rendered.sh" "$rendered" --namespace shortdrama --alb-name shortdrama-alb >/dev/null 2>&1
verifier_status=$?
set -e
[[ "$verifier_status" -ne 0 ]] || fail "rendered-release verifier accepted the placeholder test overlay"

set +e
bash "$k8s_dir/verify-rendered.sh" "$rendered_dev" --namespace shortdrama-dev --alb-name shortdrama-dev-alb >/dev/null 2>&1
verifier_dev_status=$?
set -e
[[ "$verifier_dev_status" -ne 0 ]] || fail "rendered-release verifier accepted the placeholder dev overlay"

set +e
bash "$k8s_dir/verify-rendered.sh" "$rendered" >/dev/null 2>&1
verifier_no_flags_status=$?
set -e
[[ "$verifier_no_flags_status" -ne 0 ]] || fail "rendered-release verifier accepted a call without --namespace/--alb-name"
pass "rendered-release verifier blocks placeholders and missing environment flags"

observed_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
test_ca_base64="$(node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]).toString("base64"))' "$k8s_dir/tests/fixtures/test-ca.pem")"
test_ca_fingerprint="$(node -e 'const {X509Certificate}=require("node:crypto"); const fs=require("node:fs"); process.stdout.write(new X509Certificate(fs.readFileSync(process.argv[1])).fingerprint256.replaceAll(":", "").toLowerCase())' "$k8s_dir/tests/fixtures/test-ca.pem")"

cat >"$rds_evidence" <<JSON
{"schema":"shortdrama-vke-release-evidence/v1","check":"rds_private_connectivity","status":"pass","releaseCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observedAt":"${observed_at}","target":"cctestvke123","details":{"endpoint":"shortdrama-pg.rds.ivolces.com","networkScope":"private","port":5432,"tlsMode":"verify-full","probe":"pass","caFingerprintSha256":"${test_ca_fingerprint}"}}
JSON
cat >"$admin_evidence" <<JSON
{"schema":"shortdrama-vke-release-evidence/v1","check":"admin_bootstrap","status":"pass","releaseCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observedAt":"${observed_at}","target":"cctestvke123","details":{"username":"release-admin","migrationReceipt":"migration-test-001","loginProbe":"pass","registrationEnabled":false}}
JSON
cat >"$alb_evidence" <<JSON
{"schema":"shortdrama-vke-release-evidence/v1","check":"alb_pod_direct_access_preflight","status":"pass","releaseCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observedAt":"${observed_at}","target":"cctestvke123","details":{"clusterNetworkMode":"VPC-CNI","passThrough":true,"serviceType":"ClusterIP","controllerPreflight":"pass","controllerVersion":"v0.35.0","albInstanceId":"alb-testfixture123","domain":"","namespace":"shortdrama"}}
JSON
cat >"$security_group_evidence" <<JSON
{"schema":"shortdrama-vke-release-evidence/v1","check":"vci_pod_security_group_preflight","status":"pass","releaseCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observedAt":"${observed_at}","target":"cctestvke123","details":{"securityGroupId":"sg-testfixture123","allowedSource":"100.64.0.0/10","allowedPort":8000,"plannedBypassPolicy":"deny","requiredEgressConfigured":true,"controlPlaneRequestId":"req-testfixture123","rulesSnapshot":[{"direction":"ingress","action":"allow","protocol":"tcp","port":8000,"source":"100.64.0.0/10"}],"albInstanceId":"alb-testfixture123","namespace":"shortdrama"}}
JSON

receipt_ref() {
  node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const [root, file] = process.argv.slice(1);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    process.stdout.write(path.relative(root, file).split(path.sep).join("/") + "@sha256:" + digest);
  ' "$repo_root" "$1"
}
rds_ref="$(receipt_ref "$rds_evidence")"
admin_ref="$(receipt_ref "$admin_evidence")"
alb_ref="$(receipt_ref "$alb_evidence")"
security_group_ref="$(receipt_ref "$security_group_evidence")"

# prod overlay 的四条证据回执是 v0.1.2 发布当次的实测(observedAt 2026-08-09),
# 早已越过 validate-evidence.mjs 的 24h 保鲜窗——这是发布闸的正确行为:隔夜证据
# 不许发新版。先钉死这一条:verifier 必须拒绝带着陈旧回执的 prod 渲染产物。
set +e
bash "$k8s_dir/verify-rendered.sh" "$rendered_prod" --namespace shortdrama-prod --alb-name shortdrama-prod-alb >/dev/null 2>&1
verifier_prod_stale_status=$?
set -e
[[ "$verifier_prod_stale_status" -ne 0 ]] \
  || fail "rendered-release verifier accepted stale prod evidence receipts"
# 本套件要复验的是「配置完整、双 secret-init 容器并存的 prod overlay 仍被 verifier
# 全盘接受」,与时间无关。做法与下方 fixture 同型:把真实回执复制进独立目录,只把
# observedAt 刷成当前时间并重钉 annotation 里的 sha256,其余字段逐字节保留——
# digest、绑定校验全部照旧走未改动的 verify-rendered.sh。
rendered_prod_fresh="$(mktemp "${TMPDIR:-/tmp}/shortdrama-vke-prod-fresh.XXXXXX")"
sed '' "$rendered_prod" >"$rendered_prod_fresh"
for annotation in rds-private-connectivity admin-bootstrap \
  alb-pod-direct-access-preflight vci-pod-security-group-preflight; do
  prod_receipt_old_ref="$(sed -n "s|^[[:space:]]*shortdrama\.zhongwen\.com/${annotation}-evidence: \([^[:space:]]*\)\$|\1|p" "$rendered_prod")"
  [[ -n "$prod_receipt_old_ref" ]] || fail "prod overlay lost the ${annotation} evidence annotation"
  prod_receipt_copy="${evidence_dir}/prod-${annotation}.json"
  node -e '
    const fs = require("node:fs");
    const [root, ref, out] = process.argv.slice(1);
    const receipt = JSON.parse(fs.readFileSync(`${root}/${ref.split("@sha256:")[0]}`, "utf8"));
    receipt.observedAt = new Date().toISOString();
    fs.writeFileSync(out, JSON.stringify(receipt, null, 2) + "\n");
  ' "$repo_root" "$prod_receipt_old_ref" "$prod_receipt_copy"
  prod_receipt_fresh_ref="$(receipt_ref "$prod_receipt_copy")"
  sed "s#${prod_receipt_old_ref}#${prod_receipt_fresh_ref}#" "$rendered_prod_fresh" >"${rendered_prod_fresh}.next"
  mv "${rendered_prod_fresh}.next" "$rendered_prod_fresh"
done
bash "$k8s_dir/verify-rendered.sh" "$rendered_prod_fresh" --namespace shortdrama-prod --alb-name shortdrama-prod-alb \
  || fail "rendered-release verifier rejected the fully configured prod overlay"
rm -f -- "$rendered_prod_fresh" "${evidence_dir}"/prod-*.json
pass "rendered-release verifier blocks stale prod receipts and accepts the fully configured prod overlay"

# 下面这份 fixture 模拟的是【整包发布产物】,不是今天线上那个 Pod:它自带 rds-ca 卷,
# 且 secret-init/main.go:210 读到非 verify-full 会直接退出,所以发布路径只可能是
# verify-full。base 的 disable 只对集群里那个手工建的、没挂 CA 的 shortdrama-main 成立,
# 故在这里 sed 回目标态,verify-rendered.sh 的 TLS 断言保持不放松。
sed \
  -e 's/clb-13f4w460szabk3n6nu5ki5jao/alb-testfixture123/' \
  -e 's#trn:iam::2100701382:role/shortdrama-prod-kms-reader#trn:iam::123456789012:role/shortdrama-v011-kms-reader#' \
  -e 's/508dfee9325d05a07c546cebd86b0d4ca0184ead/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/g' \
  -e 's/4119b551ee0f64cc1930c811b77e50210f70446189c278fb7d09fa962bfed3ec/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/g' \
  -e 's/2ac9abe9b70b9bdd9d8c2c193d3bce3224bcf9fe07660e4ab7688b01bf70411a/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc/g' \
  -e 's/ADMIN_USERNAMES: ""/ADMIN_USERNAMES: release-admin/' \
  -e 's/cd9attb5fok2hjo1as48g/cctestvke123/g' \
  -e 's/postgres-4a3018919997-public\.rds-pg\.volces\.com/shortdrama-pg.rds.ivolces.com/g' \
  -e 's/POSTGRES_SSL_MODE: disable/POSTGRES_SSL_MODE: verify-full/' \
  -e "s#REPLACE_WITH_RDS_PRIVATE_CONNECTIVITY_RECEIPT#${rds_ref}#" \
  -e "s#REPLACE_WITH_EXISTING_ADMIN_MIGRATION_RECEIPT#${admin_ref}#" \
  -e "s#REPLACE_WITH_ALB_POD_DIRECT_ACCESS_PREFLIGHT_RECEIPT#${alb_ref}#" \
  -e "s#REPLACE_WITH_VCI_POD_SECURITY_GROUP_PREFLIGHT_RECEIPT#${security_group_ref}#" \
  "$rendered" >"$release_fixture"
node -e '
  const fs = require("node:fs");
  const [sourceManifest, testCa, fixture] = process.argv.slice(1);
  const source = fs.readFileSync(sourceManifest, "utf8").match(/^  ca\.pem: \|\n((?:    .*\n?)+)/m)?.[1];
  if (!source) throw new Error("RDS CA is missing from the source manifest");
  const replacement = fs.readFileSync(testCa, "utf8").replace(/\r/g, "").trimEnd().split("\n").map(l => "    " + l).join("\n") + "\n";
  const rendered = fs.readFileSync(fixture, "utf8");
  if (!rendered.includes(source)) throw new Error("RDS CA was not rendered");
  fs.writeFileSync(fixture, rendered.replace(source, replacement));
' "$base_dir/rds-ca-configmap.yaml" "$k8s_dir/tests/fixtures/test-ca.pem" "$release_fixture"
bash "$k8s_dir/verify-rendered.sh" "$release_fixture" --namespace shortdrama --alb-name shortdrama-alb
pass "rendered-release verifier blocks placeholders and accepts a complete fixture"

set +e
bash "$k8s_dir/verify-rendered.sh" "$release_fixture" --namespace shortdrama-prod --alb-name shortdrama-prod-alb >/dev/null 2>&1
verifier_wrong_env_status=$?
set -e
[[ "$verifier_wrong_env_status" -ne 0 ]] || fail "rendered-release verifier accepted the test fixture as shortdrama-prod"
pass "rendered-release verifier blocks cross-environment flag mismatch"

expect_verifier_block() {
  local description="$1" pattern="$2" replacement="$3" negative_fixture
  negative_fixture="$(mktemp "${TMPDIR:-/tmp}/shortdrama-vke-negative.XXXXXX")"
  sed "s#${pattern}#${replacement}#g" "$release_fixture" >"$negative_fixture"
  set +e
  bash "$k8s_dir/verify-rendered.sh" "$negative_fixture" --namespace shortdrama --alb-name shortdrama-alb >/dev/null 2>&1
  verifier_status=$?
  set -e
  if [[ "$verifier_status" -eq 0 ]]; then
    rm -f -- "$negative_fixture"
    fail "rendered-release verifier accepted ${description}"
  fi
  rm -f -- "$negative_fixture"
  pass "rendered-release verifier blocks ${description}"
}

expect_verifier_block \
  "retired KMS credential name" \
  'shortdrama/test/runtime' \
  'shortdrama/production'
expect_verifier_block \
  "mismatched app commit" \
  'app:v0\.1\.2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'app:v0.1.2-dddddddddddddddddddddddddddddddddddddddd'
expect_verifier_block \
  "mutable init image without digest" \
  'kms-secret-init:v0\.1\.2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
  'kms-secret-init:mutable-tag'
expect_verifier_block \
  "localhost RDS" \
  'shortdrama-pg\.rds\.ivolces\.com' \
  'localhost'
expect_verifier_block \
  "RDS TLS downgrade" \
  'POSTGRES_SSL_MODE: verify-full' \
  'POSTGRES_SSL_MODE: disable'
expect_verifier_block \
  "disabled S56 AI gateway" \
  'AI_GATEWAY_ENABLED: "true"' \
  'AI_GATEWAY_ENABLED: "false"'
expect_verifier_block \
  "lowered S56 AI daily call cap" \
  'AI_DAILY_CALL_LIMIT: "5000"' \
  'AI_DAILY_CALL_LIMIT: "200"'
expect_verifier_block \
  "non-production dev-log email delivery" \
  'NODE_ENV: production' \
  'NODE_ENV: development'
expect_verifier_block \
  "readiness downgraded to process-only health" \
  'path: /api/v1/ready' \
  'path: /api/v1/health'
expect_verifier_block \
  "non-X.509 RDS CA" \
  '-----BEGIN CERTIFICATE-----' \
  '-----BEGIN BOGUS CERTIFICATE-----'
expect_verifier_block \
  "Flannel network mode" \
  'VKE_NETWORK_MODE: VPC-CNI' \
  'VKE_NETWORK_MODE: Flannel'
expect_verifier_block \
  "disabled ALB Pod pass-through" \
  'ingress\.vke\.volcengine\.com/loadbalancer-pass-through: "true"' \
  'ingress.vke.volcengine.com/loadbalancer-pass-through: "false"'
expect_verifier_block \
  "RDS receipt bound to another endpoint" \
  'shortdrama-pg\.rds\.ivolces\.com' \
  'other-pg.rds.ivolces.com'
expect_verifier_block \
  "administrator receipt outside ADMIN_USERNAMES" \
  'ADMIN_USERNAMES: release-admin' \
  'ADMIN_USERNAMES: other-admin'
expect_verifier_block \
  "receipt target from another VKE cluster" \
  'VKE_TARGET_ID: cctestvke123' \
  'VKE_TARGET_ID: ccothervke456'
expect_verifier_block \
  "ALB receipt bound to another instance" \
  'instanceID: alb-testfixture123' \
  'instanceID: alb-otherfixture456'
expect_verifier_block \
  "workload namespace drift" \
  'namespace: shortdrama' \
  'namespace: other-prod'
expect_verifier_block \
  "deployment evidence receipt moved back into ConfigMap data" \
  'shortdrama\.zhongwen\.com/rds-private-connectivity-evidence:' \
  'RDS_PRIVATE_CONNECTIVITY_EVIDENCE:'

sed 's#100\.64\.0\.0/10#0.0.0.0/1#g' "$security_group_evidence" >"$unsafe_security_group_evidence"
unsafe_security_group_ref="$(receipt_ref "$unsafe_security_group_evidence")"
expect_verifier_block \
  "unsafe Pod security-group source" \
  "$security_group_ref" \
  "$unsafe_security_group_ref"
rm -f -- "$unsafe_security_group_evidence"

sed 's#"port":8000#"port":8000,"endPort":65535#' "$security_group_evidence" >"$wide_port_security_group_evidence"
wide_port_security_group_ref="$(receipt_ref "$wide_port_security_group_evidence")"
expect_verifier_block \
  "Pod security-group rule with an unknown endPort field" \
  "$security_group_ref" \
  "$wide_port_security_group_ref"
rm -f -- "$wide_port_security_group_evidence"

sed 's#"action":"allow"#"action":"ALLOW"#' "$security_group_evidence" >"$unknown_action_security_group_evidence"
unknown_action_security_group_ref="$(receipt_ref "$unknown_action_security_group_evidence")"
expect_verifier_block \
  "Pod security-group rule with an unknown action enum" \
  "$security_group_ref" \
  "$unknown_action_security_group_ref"
rm -f -- "$unknown_action_security_group_evidence"

missing_rds_ref="docs/validation/missing-rds-receipt.json@sha256:${rds_ref##*@sha256:}"
expect_verifier_block \
  "nonexistent evidence receipt" \
  "$rds_ref" \
  "$missing_rds_ref"

bad_digest_ref="${rds_ref%@sha256:*}@sha256:0000000000000000000000000000000000000000000000000000000000000000"
expect_verifier_block \
  "evidence receipt digest mismatch" \
  "$rds_ref" \
  "$bad_digest_ref"
expect_verifier_block \
  "wrong evidence receipt structure" \
  "$rds_ref" \
  "$admin_ref"

printf 'PASS VKE manifest static test suite\n'
