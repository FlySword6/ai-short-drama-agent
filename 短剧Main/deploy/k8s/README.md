# VKE / VCI 发布包(base + overlays)

本目录是 `dev` 的 VKE 发布底稿,不会自行连接集群、创建付费资源或部署。
结构(2026-07-26,S26 重构):

- **`base/` = test 环境真源**(`shortdrama-main-test.col.com`,命名空间
  `shortdrama`),携带全部实值——内网 RDS endpoint、既有 CLB、真实镜像 digest;
  只留四份部署前证据占位。
- **`overlays/test`**:渲染当前线上环境,只注入 `environment: test` 标签,不改值。
- **`overlays/dev`**:骨架,环境实值以 `REPLACE_WITH_*` 占位 fail-closed;dev 主战场
  仍是 docker compose。
- **`overlays/prod`**:**不再是骨架**。#289 合入后本目录没有 `REPLACE_WITH_*` 占位,
  RDS/Milvus/ALB/443 证书都是 prod 专属实值。

> **2026-08-12 更正**:上面两条原写「test 是当前唯一在运行的线上环境」「prod 独立
> 实例未开通、全部实值以占位 fail-closed」,都已过期。生产实测在跑本应用
> (`http://101.126.6.208/api/v1/health` 返回 `Shortdrama Prod` 0.3.0),prod overlay
> 也已填满实值。
>
> 但**别把这条读成「prod 是从这套清单部署的」**——那件事没有核实,本机到不了生产
> 集群的 API。同样没闭合的还有「prod 实例是否真的与 test 隔离」,口径以
> `docs/contracts/environment-governance.md` 为准。
- 渲染入口是 overlay:`kubectl kustomize deploy/k8s/overlays/test`。根目录没有
  kustomization,直接 `kubectl kustomize deploy/k8s` 会失败,这是有意的防呆。

拓扑:一个 VCI `Deployment`、一个 `ClusterIP` `Service`、一个 ALB `Ingress`。
PostgreSQL 不进集群,应用直连 RDS;ALB Ingress 取代 Compose 里的 Caddy。
**线上与仓库的差异逐项处置和迁移顺序见
[`docs/deploy/live-vs-repo-diff.md`](../../docs/deploy/live-vs-repo-diff.md)——
集群侧任何变更先读它。**

## 资源与成本口径

- 常态 `replicas: 1`,滚动发布时允许临时增加 1 个 Pod,`maxUnavailable: 0`。
- app 的初始规格为 `2 CPU / 4 GiB`,initContainer 为 `250m / 256 MiB`,每个容器的
  request 与 limit 相等,形成 Guaranteed QoS。VCI 规格计算优先看 limit,故这里不再
  硬编码 `preferred-instance-types`,避免无监控证据时锁死更贵的整机规格。
- 该规格只是保守起点,不是容量结论。首轮真实压测和 VMP 指标必须记录启动迁移、
  100 MB 上传、Sharp 解码及生成 worker 的 CPU、RSS、OOM 和延迟,再调整规格或副本数。
- Pod 使用官方 VCI 注解 `vke.volcengine.com/burst-to-vci: enforce`。集群需先安装并
  正常运行 `vci-virtual-kubelet`。

## 发布前必须更新

base 已携带 test 实值;每次发布要更新的是:

| 文件 | 值 | 说明 |
| --- | --- | --- |
| `base/configmap.yaml` | `metadata.annotations` 下四条 `shortdrama.zhongwen.com/*-evidence` | RDS 私网、既有管理员迁移/登录,以及 ALB 直通 Pod、VCI Pod 安全组的部署前控制面回执;格式固定为 `docs/validation/<file>.json@sha256:<digest>`。**放 annotations 不放 `data`**:`data` 的键会被 `envFrom` 原样灌进 Pod 环境变量,没填的 `REPLACE_WITH_*` 占位符不该进运行时环境。`verify-rendered.sh` 从 annotations 读,并对退回 `data` 的写法 fail-closed |
| `base/deployment.yaml` | 两个 image 的 tag 与 `@sha256` digest | app 与 secret-init 同一完整 commit 的制品,禁浮动 tag |
| `base/deployment.yaml` | `shortdrama.zhongwen.com/release-commit`(Deployment 与 Pod template 两处) | 与镜像 tag 引用同一完整 commit SHA |
| `base/configmap.yaml` | 其余实值(RDS endpoint、VKE_TARGET_ID、Milvus 等) | 随基础设施变更而更新;当前值即线上 test 实值 |

`APP_COMMIT_SHA` **刻意不在上表、也不进 ConfigMap**。它由镜像构建参数 `GIT_SHA` 注入
(见根 `Dockerfile`),随制品走,清单侧改不动。理由是 `APP_VERSION` 的前车之鉴:那是
ConfigMap 里的人工值,和镜像里 `package.json` 的真实版本长期不一致,`/api/v1/health`
报的版本号因此不可信。把 sha 放进 ConfigMap 等于再造一个能和制品对不上的字段——
它唯一的用处就是**独立于清单**地证明"这个进程来自哪个提交",配置化就一文不值了。

dev/prod overlay 开通前必须替换的占位:`REPLACE_WITH_{DEV,PROD}_RDS_HOST`、
`REPLACE_WITH_{DEV,PROD}_DB_USER`、`REPLACE_WITH_{DEV,PROD}_MILVUS_URI`、
`REPLACE_WITH_{DEV,PROD}_IRSA_ROLE_TRN`、`REPLACE_WITH_{DEV,PROD}_ALB_INSTANCE_ID`,
prod 另有 `REPLACE_WITH_PROD_VKE_CLUSTER_ID`。渲染产物含任何占位都会被
`verify-rendered.sh` 拒绝。

`ADMIN_USERNAMES` 默认留空、注册默认关闭;上线前由负责人填写实际小写管理员用户名,
不允许放密码、invite code 或其他 secret。`DATABASE_URL` 保持空值;init helper 使用
`POSTGRES_HOST/PORT/DB/USER/PASSWORD` 安全组装连接串,并强制加入
`uselibpqcompat=true&sslmode=verify-full&sslrootcert=...`。缺 CA、私网连通回执或既有管理员
迁移/登录回执时,最终清单校验必须失败。注册关闭且 `ADMIN_USERNAMES` 只授予既有用户管理
权限,**不会创建用户**;因此新空 RDS 不能直接上线,本版只接受已迁移且已验证可登录的管理员。
四份 JSON 回执必须使用 `shortdrama-vke-release-evidence/v1` schema、匹配本次完整 commit、
`status=pass`,并包含各检查的结构化字段;`validate-evidence.mjs` 会验证文件位于仓内、非
symlink、SHA-256 一致、24 小时内生成及字段语义,还会把四份回执的 target、RDS endpoint、
管理员、ALB ID、域名、namespace 与 RDS CA 指纹逐项绑定到最终 YAML。另一套环境的真回执、
任意非空字符串或不存在的“回执路径”都不能通过。

通用 envelope 为 `schema/check/status/releaseCommit/observedAt/target/details`。四种 `check`
及必填 `details` 如下(回执不得含密码、token、连接串或响应体):

| `check` | `details` 必填证明 |
| --- | --- |
| `rds_private_connectivity` | 与 `POSTGRES_HOST` 相同的 `endpoint`、`networkScope=private`、`port=5432`、`tlsMode=verify-full`、`probe=pass`、与清单证书相同的 `caFingerprintSha256` |
| `admin_bootstrap` | 小写 `username`、`migrationReceipt`、`loginProbe=pass`、`registrationEnabled=false` |
| `alb_pod_direct_access_preflight` | `clusterNetworkMode=VPC-CNI`、`passThrough=true`、`serviceType=ClusterIP`、`controllerPreflight=pass`、`controllerVersion`,及与清单一致的 `albInstanceId/domain/namespace` |
| `vci_pod_security_group_preflight` | `securityGroupId`、`allowedSource=100.64.0.0/10`、`allowedPort=8000`、`plannedBypassPolicy=deny`、`requiredEgressConfigured=true`、`controlPlaneRequestId`,及与清单一致的 `albInstanceId/namespace`;`rulesSnapshot` 必须且只能有一条 exact-key 的 TCP/8000 ingress allow,未知字段、规则或枚举均拒绝 |

后两份是**部署前控制面快照**,不冒充运行时探测,因此不会形成“先部署才能拿回执、没回执
又不能部署”的循环。apply 后仍必须真正验证 ALB→Pod 成功、非 ALB 来源被拒绝和必要 egress
成功;这些 post-deploy 结果进入发布回执,不能回填成 preflight。

## KMS initContainer 与 IRSA

`secret-fetcher` 读取 `--secret-name` 参数指定的 KMS 凭据,运行仓内
`deploy/k8s/secret-init/` 构建出的 `/shortdrama-kms-init`。密钥名是必填参数,
白名单 `^shortdrama/(dev|test|prod)/[a-z-]+$`(命名合同见
`docs/contracts/environment-governance.md` §2);base 用 `shortdrama/test/runtime`,
dev/prod overlay 各自改写。白名单外的名字(含已退役的 `shortdrama/production`)
在发起 KMS 请求前即被拒绝——fail-closed 语义保留,只是不再把环境名焊死。
helper 使用官方 `volcengine-go-sdk` 的 OIDC credentials provider 和 KMS
`GetSecretValue`,把五项 secret(`ARK_API_KEY`、`TOS_ACCESS_KEY`、`TOS_SECRET_KEY`、
`POSTGRES_PASSWORD`、`MILVUS_PASSWORD`)、存在时才启用的可选
`SEED_AUDIO_API_KEY` / `MINIMAX_API_KEY` / `NEWAPI_API_KEY` / `WECOM_CORP_SECRET`、成对的
`COL_BASE_URL` / `COL_APIKEY`,以及派生的 TLS `DATABASE_URL` 原子写入内存型 `emptyDir`
的 `production-secrets.sh`(0600)。app 只读挂载该目录,启动时 source 后
`exec node dist/server.js`。仓库不创建 Kubernetes `Secret`,也不保存 secret 值;
provider endpoint/model allowlist 是非敏感配置,由 ConfigMap 提供。

同一 init image 另有两条窄模式，均按 secret-name 后缀分流且只导出登记键：

- `*/vnext-runtime`：要求并仅导出 `VNEXT_DATABASE_URL` 与
  `VNEXT_STORYBOARD_IMAGE_API_KEY`；
- `*/migrator`：只供短命 DDL Job，要求并仅导出 canonical `DATABASE_URL`。URL
  必须使用 `postgresql`、账号 `shortdrama_migrator`、远端地址、唯一的
  `sslmode=verify-full` 与唯一的绝对 `sslrootcert`；未知或重复 query 参数一律拒绝。

两种模式都不读取应用 runtime 密码，也不把 legacy KMS 字段写入 shell 文件。
`COMPANY_PROVIDER_ALLOWLIST` 另行控制哪些公司账户可以产生真实调用,当前为 `ark,col`
(Ark 含图片/视频/豆包语音适配器，COL 只承载文字 AI);key 或模型 ID 本身不会放权。MiniMax 直连没有运行时启用
开关,保留 key/allowlist 也不会注册供应商。newapi 除加入公司账户白名单外,还必须命中
独立批准的规范化 base URL SHA-256,URL 或 hash 任一漂移都不会发送公司 key。

### 企业微信密钥接线

- 本地开发不接 KMS；开发者只可在 Git 忽略的本机 `.env` 中使用独立的开发凭据，禁止使用
  prod CorpSecret。
- 集群 dev、test、prod 分别使用 `shortdrama/dev/runtime`、`shortdrama/test/runtime`、
  `shortdrama/prod/runtime`。需要启用企业微信登录时，由对应环境的授权管理员把该环境独立的
  `WECOM_CORP_SECRET` 追加到已有通用凭据；三个环境不得复用 prod CorpSecret。
- `WECOM_CORP_ID`、`WECOM_AGENT_ID`、`WECOM_CALLBACK_URL`、
  `WECOM_STATE_TTL_SECONDS` 和 `WECOM_LOGIN_ENABLED` 是非 secret，只能通过对应环境的
  ConfigMap/部署配置登记。CorpSecret 不得进入 ConfigMap、Kubernetes Secret、镜像参数、
  发布回执或日志。
- 接线顺序固定为：先保持 `WECOM_LOGIN_ENABLED=false`，准备 HTTPS callback、应用可见范围和
  测试成员；再由管理员写入对应 KMS 凭据并部署含本 helper 的 init 镜像；最后在同一次受控
  环境变更中开启开关并确认应用启动。helper 会拒绝空值、换行和 NUL；开关开启但
  CorpSecret 或任一非密配置缺失时，`src/config/env.ts` 的启动校验会终止应用。
- 仓库内测试只使用假值且不访问 KMS 或企业微信。实际 KMS 写入、部署、开关变更和真实登录
  验收均是独立的高风险动作，必须逐项取得授权并在目标环境读回结果。

IRSA 使用火山官方的手工注入字段,因而不依赖 webhook:

- ServiceAccount:`<环境命名空间>/shortdrama-runtime`(test 环境为
  `shortdrama/shortdrama-runtime`);
- projected token audience:`sts.volcengine.com`;
- `VOLCENGINE_OIDC_ROLE_TRN` 与 `VOLCENGINE_OIDC_TOKEN_FILE`;
- IAM trust 的 `oidc:sub` 必须精确为
  `system:serviceaccount:<环境命名空间>:shortdrama-runtime`。**命名空间变更必须
  同步改 trust**,否则 initContainer 认证失败(迁移步骤见 live-vs-repo-diff §2)。

init image 由 `deploy/k8s/secret-init/Dockerfile` 构建,最终层为 scratch、UID 10001;不含
shell、`jq`、`ve` 或长期 AK/SK。Go module 固定官方 SDK 版本,单元测试覆盖 Bash 转义、
TLS URL、密钥名白名单和失败原子性。源码可重复构建不替代云端证明:每次 secret-init 代码
变更都要重建镜像才生效;首次上线前仍必须在目标 VKE/VCI 执行一次不打印响应体的真实
`GetSecretValue`,确认 OIDC trust、IAM 最小权限、VCI 网络和目标 SDK 版本共同可用;
失败即停止,不能回退到长期 AK/SK。

## 安全、健康与回滚

- Pod 固定 UID/GID 10001、`runAsNonRoot`、`RuntimeDefault` seccomp;两个容器均
  `readOnlyRootFilesystem`、禁止提权并 drop `ALL` capabilities。
- 公网入口为 ALB 公网 IP 双监听:HTTP/80(保留) + HTTPS/443;HTTPS 证书绑定在
  ALBInstance listener,来源固定为证书中心(cert_center),不能为了跳过证书配置改回明文登录。
  多环境共用同一 base,HTTPS listener 与证书只由 prod overlay 追加(HTTP/HTTPS 各一个 Ingress
  共享同一 ALBInstance)。
- `/app/runtime`、`/tmp` 和凭据目录都是有上限的 `emptyDir`;RDS 是唯一数据库事实源。
- RDS 连接固定 `verify-full` 并挂载目标实例 CA。私网只解决路由,不替代 TLS;证书主机名
  不匹配、CA 缺失或 SSL 未开启都应让 Pod 启动失败。
- 该 `ClusterIP + VCI` 拓扑硬限定 VPC-CNI;Ingress 固定
  `loadbalancer-pass-through: "true"`,让 ALB 直接注册 Pod IP。Flannel 或未启用直通 Pod
  时,ClusterIP 后端不可作为这份发布包的可达证明,必须停止而不是临时改 NodePort。
- Namespace 只隔离对象名,不等于网络隔离。火山官方当前明确 Kubernetes NetworkPolicy
  暂不支持 VCI,因此本包不伪造无效策略。入口边界必须通过 VPC-CNI Pod/VCI 安全组最小化
  为 ALB 到应用端口;RDS 5432、DNS、KMS/TOS/Ark/Milvus egress 则结合安全组、RDS 白名单
  与目标服务控制。apply 前分别形成 `ALB_POD_DIRECT_ACCESS_PREFLIGHT_EVIDENCE` 和
  `VCI_POD_SECURITY_GROUP_PREFLIGHT_EVIDENCE`;apply 后再实测其他 namespace/VPC 对象不能
  绕过 ALB 访问应用,并把正反向结果写入本次发布回执。
- `validate-manifest-scope.mjs` 核对 8 个资源的 kind/name/namespace:7 个 namespaced
  资源必须落在 `--namespace` 指定的命名空间(test=`shortdrama`),`Namespace` 资源本身
  不得携带 namespace;集群级 `ALBInstance` 名称由 `--alb-name` 指定
  (test=`shortdrama-alb`),容忍 kustomize namespace transformer 给它盖上的冗余
  namespace 字段(API server 会忽略)。安全组规则快照直接内嵌在已做 path+SHA-256 的
  preflight 回执中,不接受任意摘要占位。
- startup/liveness 检查不触库的 `/api/v1/health`;readiness 检查
  `/api/v1/ready`,依次验证 RDS 连通、目标 schema 存在和数据库迁移头与镜像严格相等。
  因此发布顺序固定为**先备份并补齐目标 schema migration,再替换应用镜像**;迁移未追平
  时 Pod 必须保持 NotReady,不得接管流量。TOS/Milvus/模型闭环仍由发布后主路径验收证明。
- 当前 base 仍锚定 `c28feea8...` 旧制品,该 app 镜像不含 `/api/v1/ready`;因此本次探针
  修正**不可单独 apply**。正式发布必须在迁移追平后,把 app/init 镜像、digest 和 release
  annotation 原子更新为包含 `/ready` 的同一 release commit。回退到不含 `/ready` 的旧镜像
  时必须回滚完整 Deployment revision(或发布前完整备份),不得只执行 image-only 回退,
  否则新 readinessProbe 会令旧 Pod 永久 NotReady。
- apply 后核对运行中的进程到底来自哪个提交。清单侧的 annotation 与镜像 tag 都是"声明",
  只有 health 返回的 `sha` 来自镜像内部,三者必须逐字相等:

  ```bash
  kubectl -n shortdrama exec deployment/shortdrama -- \
    node -e "fetch('http://127.0.0.1:8000/api/v1/health').then(r=>r.text()).then(console.log)"
  ```

  `sha` 为 `unknown` 说明构建时漏传 `GIT_SHA`,该镜像无法追溯,按发布失败处理;与
  annotation 不一致说明清单指向的制品和实际在跑的不是一个,立刻停止验收。老镜像
  (`c28feea8...` 及更早)没有这个字段,响应里没有 `sha` 即属此类。
- `revisionHistoryLimit: 10`,镜像 tag、digest 和 commit 是回滚锚点。发布前先记录当前
  revision 与镜像(test 环境示例):

  ```bash
  kubectl -n shortdrama rollout history deployment/shortdrama
  kubectl -n shortdrama get deployment shortdrama \
    -o jsonpath='{.metadata.annotations.shortdrama\.zhongwen\.com/release-commit}{"\n"}{.spec.template.spec.containers[0].image}{"\n"}'
  ```

  新 revision 未通过 smoke 时,使用持续交付的自动回滚或人工执行:

  ```bash
  kubectl -n shortdrama rollout undo deployment/shortdrama --to-revision=<previous>
  kubectl -n shortdrama rollout status deployment/shortdrama --timeout=10m
  ```

  镜像回滚不撤销数据库 migration;禁止手工删除 RDS 数据或修改 `schema_migrations`。
- 每个 release commit 都原子重建 app 与 init 两个镜像,并让两者的 tag、Deployment/Pod
  annotation 指向同一完整 commit。即使 helper 源码未变,也不走 app-only 捷径;否则最终
  清单校验无法证明两个制品来自同一审计快照。

## 本地静态检查

```bash
# 渲染当前线上 test 环境(base 单独也可渲染,等价于不带环境标签的 test)
kubectl kustomize deploy/k8s/overlays/test >/tmp/shortdrama-test.yaml
(cd deploy/k8s/secret-init && go test ./...)
deploy/k8s/tests/manifests.test.sh
deploy/tests/fetch-secrets.test.sh
# 对替换占位后的最终 YAML 运行(命名空间/ALB 名按环境给):
deploy/k8s/verify-rendered.sh /tmp/shortdrama-test.yaml --namespace shortdrama --alb-name shortdrama-alb
```

这些命令不访问集群。真正 apply 前必须在目标工作区确认占位值已全部消失,并由拥有
VKE/ALB/IAM/KMS 权限的人复核上下文与 namespace;本工作包没有执行 apply。

## 官方依据

- [VKE 使用 IRSA](https://www.volcengine.com/docs/6460/1324613)
- [VCI 指定资源与强制调度](https://www.volcengine.com/docs/6460/1400008?lang=en)
- [VCI Pod 规格计算](https://www.volcengine.com/docs/6460/1346564)
- [VKE 通过 kubectl 创建 ALB Ingress](https://www.volcengine.com/docs/6460/1167729?lang=zh)
- [ALB Ingress 直通 Pod Annotation](https://www.volcengine.com/docs/6460/132415?lang=zh)
- [VKE 安全组配置最佳实践](https://www.volcengine.com/docs/6460/1168068?lang=zh)
- [VKE NetworkPolicy 限制](https://www.volcengine.com/docs/6460/1111493?lang=zh)
- [VKE Ingress 类型概览](https://www.volcengine.com/docs/6460/100991?lang=en)
- [RDS PostgreSQL 配置 SSL 加密](https://www.volcengine.com/docs/6438/1864761?lang=zh)
- [火山引擎官方 Go SDK](https://github.com/volcengine/volcengine-go-sdk)
