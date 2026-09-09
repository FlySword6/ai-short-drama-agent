# V0.1.1 火山持续交付 → CR → VKE 操作指南

本文是控制台操作合同，不代表已经创建资源或部署。目标链路固定为：

```text
GitHub dev
  -> npm ci + 四道门禁（npm test 在内）
  -> linux/amd64 镜像推送到 CR shortdrama-prod
  -> 独立 VKE namespace shortdrama-prod
  -> VCI Deployment + ClusterIP Service + ALB Ingress
  -> 公网 smoke 与人工主路径验收
```

只允许从已通过 PR 进入 `dev` 的完整 commit 构建 V0.1.1；禁止从 `main`、`integration/v011`
或任意 feature 分支直接发布。dev 代码分支不等于 dev 运行环境，仍禁止把 dev workload、
ConfigMap、Ingress、ServiceAccount 或 secret 复用到 `shortdrama-prod`。

> **修订 2026-07-26(S26 部署规范化)**：本指南是 **prod 流水线**的操作合同；当前唯一
> 在运行的线上环境是 **test**(`shortdrama-main-test.col.com`,namespace
> `shortdrama`)。清单已重构为 `deploy/k8s/base`(test 真源,全量实值)+
> `deploy/k8s/overlays/{test,dev,prod}`;渲染入口是 overlay,`deploy/k8s` 根目录
> 不再可渲染(有意防呆)。test 环境走同一链路:渲染 `overlays/test`,命名空间/ALB
> 参数用 `shortdrama`/`shortdrama-alb`,KMS 用 `shortdrama/test/runtime`。线上现状
> 与仓库的逐项差异、迁移顺序与回滚见 `docs/deploy/live-vs-repo-diff.md`。

## 1. 固定口径

| 项目 | 固定值 |
| --- | --- |
| GitHub 仓库 | `col-shortdrama/zhongwen-shortdrama-main` |
| 代码分支 | `dev` |
| Node 版本 | `22.19.0` |
| 构建上下文 / Dockerfile | 仓库根 / `./Dockerfile` |
| 目标平台 | `linux/amd64` |
| 镜像标签 | `v0.1.1-<完整 commit SHA>`，回执同时记录 digest |
| CR 生产隔离 | 目标实例内使用生产命名空间/仓库组 `shortdrama-prod`，不要复用 dev |
| VKE 部署资源 | 单独接入生产集群，namespace 固定 `shortdrama-prod` |
| KMS 通用凭据 | `shortdrama/prod/runtime`(test 环境为 `shortdrama/test/runtime`),地域 `cn-beijing` |
| 数据库 | RDS PostgreSQL 私网 endpoint；VKE 内不部署 PostgreSQL |
| 七层入口 | ALB Ingress；不部署 Caddy |

## 2. 一次性控制面准备

### 2.1 CR、VKE、VCI、ALB 与 RDS

1. 在镜像仓库 CR 中创建或选择生产隔离范围 `shortdrama-prod`，给持续交付构建身份
   最小推送权限，给 VKE 最小拉取权限。禁止覆盖已有 commit tag。
2. 目标生产 VKE 必须使用 **VPC-CNI**，安装并确认 `vci-virtual-kubelet` 正常；本仓 Pod
   template 使用 `vke.volcengine.com/burst-to-vci: enforce` 强制 VCI，Ingress 使用
   `loadbalancer-pass-through: "true"` 让 ALB 直接注册 Pod IP。Flannel 或关闭直通 Pod 与
   本包的 `ClusterIP` 拓扑不兼容，停止发布。
3. 安装并确认 `alb-ingress-controller`，准备一个已审批的 ALB，以及证书中心中与生产
   域名匹配的服务器证书。清单的 `ALBInstance/shortdrama-prod-alb` 只对接已有 ALB，
   只开放 HTTPS/443，不在本流水线购买实例或创建证书。
4. RDS 与 VKE/VCI 置于可私网互通的 VPC/子网，按 RDS 控制台实际规则放行 VCI Pod
   来源网段和 5432，开启 SSL、下载目标实例 CA。不要开放 RDS 公网入口来绕过网络配置。
5. 按 `deploy/k8s/README.md` 替换 ALB ID、证书 ID、域名、RDS 私网 endpoint、管理员
   用户名、RDS CA、目标 VKE cluster ID、IRSA role TRN、commit、两个镜像 tag/digest 与
   证据回执占位值。
   四份证据回执使用 `docs/validation/<file>.json@sha256:<digest>`，文件 schema、commit、
   24 小时 freshness、target 与检查专属字段均由仓内 validator 校验，并与最终 YAML 的
   RDS/admin/ALB/domain/namespace/CA 指纹交叉比对；占位值或伪路径未清零时不允许 apply。
6. `ADMIN_USERNAMES` 只把**已存在**的用户提升为管理员，不会创建用户。RDS 必须来自已验证
   的数据迁移，并在关闭注册前证明至少一个名单内用户可登录；把去敏迁移/登录回执写入
   `ADMIN_BOOTSTRAP_EVIDENCE`。空 RDS 或无可登录管理员时停止发布，不临时开放公网注册。
7. Namespace 本身不提供网络隔离，且火山官方当前明确 NetworkPolicy 暂不支持 VCI，不得
   把一份无效策略写成隔离证明。按目标 VPC-CNI 的 Pod/VCI 安全组、ALB 来源、RDS 白名单和
   目标服务出站控制，只开放应用所需端口。apply 前读取集群网络模式、controller 版本、
   Ingress 直通设置和安全组规则，形成不可变的 `alb_pod_direct_access_preflight` 与
   `vci_pod_security_group_preflight` 控制面快照；Pod ingress 仅允许官方 ALB/管控来源
   `100.64.0.0/10` 的 TCP/8000，完整规则数组内嵌在已哈希回执中。此时不声称工作负载探测
   已经通过。

### 2.2 VKE IRSA 与 KMS

1. 目标集群必须是托管版 Kubernetes 1.24+，在集群概览开启 IRSA OIDC。
2. 在 IAM 创建 OIDC 角色，信任关系只允许：
   - `oidc:aud = sts.volcengine.com`
   - `oidc:iss = <目标集群控制台显示的 Provider URL>`
   - `oidc:sub = system:serviceaccount:shortdrama-prod:shortdrama-runtime`
3. 只授予读取 `shortdrama/prod/*`(test 环境为 `shortdrama/test/*`)所需的 KMS 权限；精确 Action 与 Resource
   以目标账号 IAM 策略编辑器/API Explorer 可选项为准，本指南不猜字段。
4. KMS 通用凭据值必须是 JSON object，包含五个非空字符串：
   `ARK_API_KEY`、`TOS_ACCESS_KEY`、`TOS_SECRET_KEY`、`POSTGRES_PASSWORD`、
   `MILVUS_PASSWORD`。
5. 受控 init image 必须从本仓 `deploy/k8s/secret-init/` 构建，以非 root UID 10001 运行。
   helper 使用固定版本的官方 `volcengine-go-sdk` OIDC provider 和 KMS `GetSecretValue`，
   不包含 Bash、`jq`、`ve` 或长期 AK/SK。首次发布前仍须在目标 VCI 做一次不打印响应体的
   真实读取，验证 OIDC trust、IAM 最小权限、网络与目标 SDK 版本；失败即停止。

### 2.3 持续交付接入生产 VKE

进入 **持续交付 → 资源管理 → 部署资源 → 创建部署资源**：

1. 资源类型选择 VKE；
2. 选择生产火山账号、地域和目标集群；
3. 可见范围只给生产工作区；
4. 后续所有 K8s 部署任务显式选择 namespace `shortdrama-prod`。

不要让同一个部署任务通过变量在 dev/prod namespace 间切换；生产流水线只持有生产
部署资源，dev 使用另一条流水线和另一项部署资源。

## 3. 创建流水线

建议在生产工作区创建 `v011-dev-vke-release`，初期只允许手动触发。

### 阶段 A：GitHub 代码源

1. 代码源类型选择 GitHub，仓库 URL 指向
   `col-shortdrama/zhongwen-shortdrama-main`。
2. 分支精确填写 `dev`，不要使用 `main`、`integration/v011`、tag 通配符或 feature 分支。
3. Token/OAuth 使用持续交付的服务连接，不粘贴个人 token 到脚本或日志。
4. 将源提交 SHA 保存为 `GIT_COMMIT`；镜像 tag、Deployment annotation、应用版本、
   镜像构建参数 `GIT_SHA` 和发布回执必须引用同一值。前四项都是清单侧的声明，只有
   `GIT_SHA` 注入的值会随镜像走进容器，是唯一能在运行时自证的一份。

### 阶段 B：依赖安装与测试门禁

新增 Node 22.19.0 任务，在仓库根执行：

```bash
set -euo pipefail
test "$(node --version)" = "v22.19.0"
npm ci
npm run check:architecture
npm run typecheck
npm test
npm run build
deploy/tests/fetch-secrets.test.sh
(cd deploy/k8s/secret-init && go test ./...)
deploy/k8s/tests/manifests.test.sh
```

任一命令失败立即停止，不得进入镜像构建。`npm ci` 与 `npm test` 是最低硬门禁；
architecture、typecheck、build 四道合并门禁仍全部保留。

### 阶段 C：构建并推送 app 与 KMS init 镜像

添加官方“镜像构建推送至镜像仓库服务”任务：

1. Dockerfile：`./Dockerfile`；构建上下文：仓库根；
2. 平台：`linux/amd64`；构建参数：`NODE_VERSION=22.19.0`、`GIT_SHA=${GIT_COMMIT}`、
   `GIT_REF=dev`、`BUILD_TIME=<构建开始的 UTC ISO8601>`；
   `GIT_SHA` 必须是阶段 A 保存的同一完整 commit，镜像才能自报跑的是哪个提交
   （`/api/v1/health` 的 `sha` 字段）。传成分支名或镜像 tag 会让应用启动期直接
   报错——这是刻意的 fail-fast：错误的 sha 比没有 sha 更糟，会让审计得出错误结论。
   漏传只降级成 `sha=unknown`，构建不失败，因此**回执必须实测 health 返回的 sha**，
   不能只看流水线配置截图。
3. 选择目标 CR 的生产隔离范围 `shortdrama-prod`；
4. tag：`v0.1.1-${GIT_COMMIT}`，不使用 `latest`；
5. 认证使用服务连接，不使用个人 Docker 密码；
6. 保存完整镜像地址和 digest，并在最终清单使用
   `<repo>/app:v0.1.1-${GIT_COMMIT}@sha256:<digest>`。只有 tag、没有 digest，不算可追溯制品。

再添加同一官方镜像构建推送任务：构建上下文和 Dockerfile 都在
`deploy/k8s/secret-init/`，tag 同样是 `v0.1.1-${GIT_COMMIT}`；最终清单使用
`<repo>/secret-init:v0.1.1-${GIT_COMMIT}@sha256:<digest>`。该镜像由本仓 Go 源码和固定版本
官方 `volcengine-go-sdk` 产出，不能替换为公网“带 ve/jq”的未知镜像。构建回执必须同时
记录 app/init 的 tag、digest、完整 commit 与基础镜像 digest。

### 阶段 D：K8s YAML 应用与镜像升级

在持续交付中把本阶段拆成两个有硬依赖的任务：

1. `render-and-verify-production-yaml`：同时依赖阶段 C 的 app/init 两个镜像构建任务，
   导出最终 YAML 并执行 `deploy/k8s/verify-rendered.sh <final-production.yaml> --namespace shortdrama-prod --alb-name shortdrama-prod-alb`；
2. `apply-production-yaml`：只依赖上一个校验任务，校验非零退出时不得启动。

禁止把校验写成流水线外的口头/人工确认，也禁止让应用任务与校验任务并行。
持续交付控制台的任务依赖截图/导出配置是上线回执的一部分；本地运行该脚本不能替代这份证据。

首次部署：

1. 在持续交付创建 K8s YAML 应用/环境，资源内容渲染自 `deploy/k8s/overlays/prod`（kustomize 产物）；
2. 环境只绑定生产 VKE 部署资源和 namespace `shortdrama-prod`；
3. 在环境配置中替换 `deploy/k8s/README.md` 列出的全部占位值；RDS CA 以目标实例下载的
   PEM 做 base64 后写入 `rds-ca-configmap.yaml`，不使用自签或测试证书；
4. 用只读控制面查询和已审批的私网 runner 生成四份 preflight JSON 回执及 SHA-256；网络
   回执只证明 VPC-CNI/controller/直通设置与安全组规则已经就绪，不能伪造部署后探测结果；
5. 导出发布预览 YAML，运行
   `deploy/k8s/verify-rendered.sh <final-production.yaml> --namespace shortdrama-prod --alb-name shortdrama-prod-alb`；
6. 发布预览确认没有 `default`、`dev`、`Secret`、StatefulSet/PVC 或 Caddy；
7. 使用官方“应用部署”任务发布完整环境。

后续发布仍按同一原子流程：每个 release commit 都重建 app 与 init 两个镜像，更新两者
tag/digest 及 Deployment/Pod release annotation，再部署完整 YAML 应用。即使 helper 源码
没有变化，也不能只更新 app；否则“两个镜像来自同一审计快照”的校验必然失败。不要使用
只改一个 container 的 `kubernetes-update-image` 任务绕过完整清单预览与校验。

## 4. 发布、健康检查与公网验收

持续交付先等待 Deployment rollout；随后由只读检查任务记录：

```bash
kubectl -n shortdrama-prod rollout status deployment/shortdrama --timeout=10m
kubectl -n shortdrama-prod get deployment,service,ingress
kubectl -n shortdrama-prod get pods \
  -l app.kubernetes.io/name=shortdrama \
  -o custom-columns=NAME:.metadata.name,PHASE:.status.phase,READY:.status.containerStatuses[0].ready,IMAGE:.spec.containers[0].image
```

接着对实际 ALB 域名执行 `scripts/release-smoke.sh https://<production-host>`，再由人用
Chrome 登录走核心业务路径。以下事实必须分开写：

- Pod ready；
- app health 通过；
- `/api/v1/health` 返回的 `sha` 与本次 `GIT_COMMIT`、镜像 tag、Deployment annotation
  三者逐字相等。`sha=unknown` 说明构建参数漏传，该镜像不可追溯，按发布失败处理；
  三者不一致说明清单指向的制品与实际运行的不是同一个，立刻停止验收；
- RDS/TOS/Milvus/模型依赖各自可用；
- RDS 连接实际使用 TLS `verify-full`，CA 与 hostname 验证成功；
- ALB 公网可达；
- ALB→VCI Pod 正向探测通过，非 ALB 来源绕过探测被拒绝，必要 egress 探测通过；
- 迁移来的管理员可登录，且与 `ADMIN_USERNAMES`/回执一致；
- 核心业务路径通过。

任何一项都不能替代其他项。真实模型生成是付费动作，本流水线不自动触发。

## 5. 滚动升级与回滚

Deployment 固定 `replicas: 1`、`maxSurge: 1`、`maxUnavailable: 0`、
`revisionHistoryLimit: 10`。发布前保存上一 revision、完整 commit、镜像 tag/digest 和
init image digest。持续交付任务开启“失败自动回滚”；若需人工回滚：

```bash
kubectl -n shortdrama-prod rollout history deployment/shortdrama
kubectl -n shortdrama-prod rollout undo deployment/shortdrama --to-revision=<previous>
kubectl -n shortdrama-prod rollout status deployment/shortdrama --timeout=10m
```

回滚后重新执行 smoke。镜像回滚不会撤销已经完成的 PostgreSQL migration；数据库恢复
必须使用该 migration 的明确方案，禁止手工删 RDS 数据或篡改 `schema_migrations`。

## 6. 发布回执

每次运行至少保留：

- GitHub 仓库、精确分支 `dev`、完整 commit；
- `npm ci` 与四道门禁结果；
- app/init 镜像完整地址、同一 release commit tag、digest、架构；
- 部署后 `/api/v1/health` 实测返回的 `sha`（原样粘贴响应体），并与上一条的 tag 比对；
- VKE 部署资源、集群、namespace `shortdrama-prod`；
- RDS 私网连通、TLS CA/verify-full、管理员迁移/登录回执、IRSA/KMS init（仅状态与 key 名，绝不记录值）；
- apply 前 ALB/VCI 安全组 preflight，以及 apply 后 ALB 正向、绕过拒绝与必要 egress 结果；
- rollout revision、健康检查、ALB smoke、人工主路径；
- 上一 revision 与镜像 digest；
- 明确注明“未 push / 未部署 / 未付费”或实际获批动作及执行人。

## 7. 官方依据

- [持续交付：创建 GitHub 代码源](https://www.volcengine.com/docs/6461/1158272?lang=zh)
- [持续交付：接入 VKE 部署资源](https://www.volcengine.com/docs/6461/1155385?lang=zh)
- [持续交付：部署组件字段](https://www.volcengine.com/docs/6461/2384166)
- [持续交付：K8s YAML 应用部署](https://www.volcengine.com/docs/6461/1133957?lang=zh)
- [VKE：集群中使用 IRSA](https://www.volcengine.com/docs/6460/1324613)
- [VCI：指定资源规格](https://www.volcengine.com/docs/6460/1400008?lang=en)
- [VKE：通过 kubectl 创建 ALB Ingress](https://www.volcengine.com/docs/6460/1167729?lang=zh)
- [VKE：ALB Ingress 直通 Pod Annotation](https://www.volcengine.com/docs/6460/132415?lang=zh)
- [VKE：安全组配置最佳实践](https://www.volcengine.com/docs/6460/1168068?lang=zh)
- [VKE：NetworkPolicy 限制](https://www.volcengine.com/docs/6460/1111493?lang=zh)
- [RDS PostgreSQL：配置 SSL 加密](https://www.volcengine.com/docs/6438/1864761?lang=zh)
- [火山引擎官方 Go SDK（含 OIDC credentials provider）](https://github.com/volcengine/volcengine-go-sdk)
- [KMS：GetSecretValue API](https://api.volcengine.com/api-docs/view?action=GetSecretValue&serviceCode=kms&version=2021-02-18)
