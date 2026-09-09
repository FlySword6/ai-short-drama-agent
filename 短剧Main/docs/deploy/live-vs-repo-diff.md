# 线上 vs 仓库清单差异与迁移方案(S26,2026-07-26)

**这份文档是本包最重要的交付物。** Fable 按它执行集群侧变更;本包执行人只做仓库侧
改造,未触碰任何集群/云资源。

- 线上实况来源:Fable 2026-07-26 实读(S26 任务包)+ `docs/contracts/environment-governance.md`
  §6/§7 + Git 提交 `2f7cf7ef` 中的历史流水线对接单。该对接单现已整份退役，只能追溯
  当时证据，不能提供现行操作指令。精确的线上 26 个 env 键值没有
  落盘存档,apply 前由 Fable 再读一次逐键核对(见 §4)。
- 仓库口径来源:本分支 `feature/v011-s26` 的 `deploy/k8s/base/`(= test 环境真源)
  与 `deploy/k8s/overlays/`。

## 0. 一页结论

1. **命名空间:改仓库,不改线上。** 线上实际跑 `shortdrama`;仓库旧清单写的
   `shortdrama-prod` 从来没被 apply 过。改线上命名空间等于重建全部资源,没有理由做;
   仓库 base 已对齐 `shortdrama`。
2. **线上 26 个内联 env 收进版本管理。** 非敏感键进 `base/configmap.yaml`(实值,
   含内网 RDS endpoint);五把敏感钥匙进 KMS `shortdrama/test/runtime`,由
   secret-init initContainer 注入,**值不进仓库**。
3. **数据库地址回切内网**(`postgres4a3018919997.rds-pg.ivolces.com`)。公网端点是
   排障期临时态;回切以 `rds_private_connectivity` 部署前证据实测通过为闸门,不通则
   暂缓并记待办,不硬切。

## 1. 逐项差异表

处置三选一:**以线上为准**(仓库改)/ **以仓库为准**(线上改)/ **需迁移**(两侧
都有动作,按 §2 顺序执行)。

| # | 项 | 线上实况 | 仓库 base(改造后) | 处置 | 说明与风险 |
| --- | --- | --- | --- | --- | --- |
| 1 | 命名空间 | `shortdrama` | `shortdrama`(旧仓库写 `shortdrama-prod`,从未被 apply) | 以线上为准 | 同名 apply 只更新 Namespace labels,不重建任何资源。`shortdrama-prod` 保留给未来 prod overlay。 |
| 2 | 配置来源 | 26 个 env 直接写在 Deployment | `ConfigMap/shortdrama-runtime` + 两容器 `envFrom` | 需迁移 | apply 后内联 env 被 ConfigMap 引用取代。 |
| 3 | 敏感值 | 明文 env 值写在 Deployment | KMS `shortdrama/test/runtime` 五键(ARK_API_KEY/TOS_ACCESS_KEY/TOS_SECRET_KEY/POSTGRES_PASSWORD/MILVUS_PASSWORD),initContainer 注入内存 emptyDir | 需迁移 | 仓库只留键名与来源;值由 Fable 组装,见 §2 步骤 2。 |
| 4 | `POSTGRES_HOST` | **公网端点**(排障临时态) | 内网 `postgres4a3018919997.rds-pg.ivolces.com` | 以仓库为准 | 回切闸门:`rds_private_connectivity` 证据实测内网 5432 + verify-full 通过;不通则本次不回切,公网入口保留并记待办。 |
| 5 | `POSTGRES_SCHEMA` | `app`(环境治理合同 §2 定名,废弃 `prod`) | `app` | 以仓库为准 | 若线上 26 键中仍有 `prod`,apply 时一并以仓库为准;`v0.1.2-release-runbook.md` 旧口径已修正。 |
| 6 | `POSTGRES_USER` | `shortdrama_test` | `shortdrama_test` | 无差异 | 环境治理合同 G1 已收敛。 |
| 7 | KMS 密钥名 | 无 initContainer,不读 KMS(仓库旧稿写死 `shortdrama/production`) | `shortdrama/test/runtime`,命名合同 `shortdrama/{env}/{purpose}` | 需迁移 | **先建后切**:新名建好、新 init 镜像跑通、登录验证前,旧名 `shortdrama/production`、`postgreSQL-dev` 一律不删不改。 |
| 8 | initContainer | 无 | `secret-fetcher`(secret-init 镜像,IRSA 读 KMS) | 需迁移 | **需要重建 secret-init 镜像**:`--secret-name` 改为必填参数+白名单,旧镜像焊死 `shortdrama/production` 且拒绝其他名字,读不了新密钥。app 镜像无需重建(未动 `src/`)。 |
| 9 | ALBInstance | 震宇流水线自建,对象名未存档;复用既有 CLB `clb-13f4w460szabk3n6nu5ki5jao` | `shortdrama-alb`(旧仓库写 `shortdrama-prod-alb`,从未 apply) | 以线上为准 | 集群级对象。apply 前 `kubectl get albinstances -A` 核对:无同名对象、无其他对象已绑定同一 instanceID,避免两个控制器条目抢同一个 CLB。`blockCascadeDeletion: true` 保证删对象不级联删 CLB。 |
| 10 | IngressClass / 入口 | CLB 公网 IP + HTTP/80(DC 拍板档) | `ingressClassName: shortdrama-alb`,HTTP/80,无 host,`/*` 全匹配,pass-through | 以线上为准 | 仓库已对齐现档;HTTPS/域名是后续切换项,不在本包。 |
| 11 | `APP_NAME` | 未存档 | `Shortdrama Test`(旧仓库写 `Shortdrama Production`) | 以仓库为准 | 命名诚实:它服务的是 test。 |
| 12 | 新增配置键 | 无 | `ALLOW_MEMBER_CREATE_PROJECT=false`、`DOUBAO_VISION_MODEL=""`、`TOPIC_RADAR_52API_*`(关/空/10000)、`PI_REMOTE_API_URL/PI_REMOTE_MODEL`(空) | 以仓库为准 | 消费方代码已存在,缺省行为=关闭,补齐不改变运行行为。两个敏感键(TOPIC_RADAR_52API_KEY、PI_REMOTE_API_TOKEN)不在 KMS 五键合同内,启用前须先扩展密钥清单,见 §5 决策项 2。 |
| 13 | IRSA role trust | role `shortdrama-prod-kms-reader` 已存在(trust 按旧稿应为 `system:serviceaccount:shortdrama-prod:shortdrama-runtime`) | 引用同一 TRN,但 SA 在 `shortdrama` 命名空间 | 需迁移 | **命名空间改了,OIDC `oidc:sub` 必须跟着改**,否则 initContainer 认证必失败。两条路见 §2 步骤 1。 |
| 14 | RDS CA | 无独立 ConfigMap | `ConfigMap/shortdrama-rds-ca`(真实 CA,公开信任材料) | 需迁移 | 随 apply 创建;挂载进 Pod 供 verify-full。 |
| 15 | 四份部署前证据 | 无 | 4 个 `REPLACE_WITH_*_RECEIPT` 占位,fail-closed | 需迁移 | Fable 按 `deploy/k8s/README.md` 证据合同生成并回填;占位未清零 `verify-rendered.sh` 必拒。 |
| 16 | 镜像 tag/digest | v0.1.2(`c28feea…`,digest 见 deployment) | 同左,已写实值 | 无差异 | base 即线上当前运行制品;下次发布整批更新(见 §3)。 |
| 17 | Namespace 环境标签 | 未存档 | `app.kubernetes.io/environment: test`(overlays/test 注入) | 以仓库为准 | 纯标签,无运行影响。 |
| 18 | `POSTGRES_SSL_MODE` | Pod 里没有任何 CA(只挂 `/etc/localtime`,集群无 `ConfigMap/shortdrama-rds-ca`) | `disable`(2026-08-11 由 verify-full 降级) | 以线上为准 | 与 #4 同一套,不能一个按现实一个按目标态。`src/db/tls.ts:32` 是 `readFileSync`,拿不到 CA 直接抛,verify-full 一生效即断库。恢复闸门:先落地 #14(apply CA ConfigMap + 给 `shortdrama-main` 加 `rds-ca` 卷挂载),再改回 verify-full。注意 `secret-init/main.go:210` 对非 verify-full fail-closed,整包 apply 在恢复前起不来;dev/prod overlay 已各自钉死 verify-full,不继承本降级。 |

## 2. 迁移顺序(Fable 执行,全部是集群/云操作)

每步失败即停,回滚办法见 §3。**前置:本包 secret-init 代码改动必须先构建推送新
init 镜像(步骤 0),否则步骤 3 起必败。**

0. **快照与重建 init 镜像**
   - `kubectl -n shortdrama get deployment shortdrama -o yaml > 回滚锚点.yaml`;
     `kubectl get albinstances -A -o yaml`、`kubectl -n shortdrama get ingress,configmap,serviceaccount -o yaml` 各存一份。
   - 从本分支构建并推送 `secret-init` 新镜像(app 镜像不动),tag 用本分支合入后的
     完整 commit SHA,记录 digest。
1. **IAM:让 IRSA trust 匹配新命名空间。** 二选一:
   - (a) 把 `shortdrama-prod-kms-reader` trust 的 `oidc:sub` 改为
     `system:serviceaccount:shortdrama:shortdrama-runtime`;或
   - (b) 新建 `shortdrama-test-kms-reader`(trust 同上),把 `base/deployment.yaml`
     的 TRN 一起换掉——更干净,顺手把"prod"字样也从 IAM 名里摘掉。
   - 同时把该 role 的 KMS 权限范围收窄/确认到 `shortdrama/test/*`。
2. **KMS:建 `shortdrama/test/runtime`,五键齐全且非空。** 值来源建议:
   `POSTGRES_PASSWORD` 取 `postgreSQL-dev`(= `shortdrama_test` 账号在用的那个,
   环境治理合同 G2 证明 `shortdrama/production` 里的 PG 值认证失败);其余四键取
   `shortdrama/production` 现值并逐一验真。**旧密钥名一律保留。**
3. **生成四份部署前证据**(`deploy/k8s/README.md` 证据合同),其中
   `rds_private_connectivity` 同时是差异项 #4 内网回切的闸门:实测不通过就保持
   公网端点、把 configmap 的 `POSTGRES_HOST` 临时改回公网值再往下走,并把内网连通
   记为独立待办。
4. **回填并渲染校验。**
   ```bash
   # 填 base/configmap.yaml 的 4 个证据占位、base/deployment.yaml 的新 init 镜像 digest
   kubectl kustomize deploy/k8s/overlays/test > /tmp/final-test.yaml
   deploy/k8s/verify-rendered.sh /tmp/final-test.yaml --namespace shortdrama --alb-name shortdrama-alb
   ```
5. **apply + 滚动重启 + 验收。**
   ```bash
   kubectl apply -f /tmp/final-test.yaml
   kubectl -n shortdrama rollout status deployment/shortdrama --timeout=10m
   ```
   验收口径:`/api/v1/ready` 返回 200 → 管理员登录 → 免费链路冒烟
   (项目/资产/检索)。initContainer 日志只确认"读取成功",**绝不打印响应体**。
6. **观察期通过后收尾**:旧 KMS 名(`shortdrama/production`、`postgreSQL-dev`)
   标记废弃但不删;内网回切成功的,关闭 RDS 公网入口;`docs/contracts/`
   里过时口径按 §5 决策项 1 走合同修订流程。

## 3. 回滚办法

| 场景 | 回滚 |
| --- | --- |
| apply 后 Pod 起不来/ready 失败 | `kubectl apply -f 回滚锚点.yaml`(恢复内联 env、无 initContainer 的旧 Deployment)或 `kubectl -n shortdrama rollout undo deployment/shortdrama`;新建的 ConfigMap/SA/ALBInstance 是惰性对象,留着无害,也可整份 `kubectl delete -f` 时只挑这三个删。 |
| initContainer 读 KMS 失败 | 先查 IAM trust(步骤 1)与 KMS 五键;回滚同上。旧密钥名未动,旧链路随时可回。 |
| 内网回切后连不上库 | configmap 改回公网端点重新 apply(纯配置回滚);RDS 安全组/公网入口在确认前不收紧。 |
| ALBInstance 冲突 | 删新建的 `shortdrama-alb` 对象即可;`blockCascadeDeletion: true` 保证不带走 CLB。 |
| 数据库 migration | 本包不碰迁移;镜像/配置回滚均不撤销已执行 migration。 |

## 4. 线上 26 env 键位映射(收编去向)

线上精确的 26 个键没有落盘存档,Fable apply 前用 `kubectl -n shortdrama get
deployment shortdrama -o jsonpath='{.spec.template.spec.containers[0].env}'`
再读一次,按下表逐键对号;**出现下表没有的键,先停下来回写本文档再继续**:

| 去向 | 键 |
| --- | --- |
| 进 `base/configmap.yaml`(非敏感,实值) | 现有 51 键:APP_NAME/APP_VERSION/DEBUG/HOST/PORT/SESSION_TTL_HOURS/AUTH_*/ADMIN_USERNAMES/ALLOW_MEMBER_CREATE_PROJECT/GENERATION_*/ALLOW_PAID_GENERATION/PAID_GENERATION_*/DATABASE_URL(空)/POSTGRES_*/VKE_*/ARK_*/DOUBAO_*/SEEDANCE_*/AI_GATEWAY_*/AI_DAILY_CALL_LIMIT/TOPIC_RADAR_52API_*/PI_REMOTE_*/TOS_*/MILVUS_URI/MILVUS_USER/MILVUS_COLLECTION_* + 4 个证据占位键 |
| 进 KMS `shortdrama/test/runtime`(值不进仓库) | ARK_API_KEY、TOS_ACCESS_KEY、TOS_SECRET_KEY、POSTGRES_PASSWORD、MILVUS_PASSWORD |
| 不进 env(由 Deployment 结构承载) | 镜像 tag/digest、release-commit annotation、IRSA TRN/token 路径 |
| 应消失 | 任何内联在 Deployment 里的明文敏感值(apply 后被 initContainer 注入取代) |

## 5. 决策项(超本包边界,报 Fable,均未自行改动)

1. **合同文档口径过时**:`docs/contracts/v0.1.1/architecture.md`、`config-and-secrets.md`
   L11/L38 仍写 `shortdrama-prod` 命名空间、`shortdrama/production` KMS、
   `deploy/k8s/configmap.yaml` 旧路径;`environment-governance.md` §6 G2 写的是过渡方案
   `postgreSQL-dev`,与本包落定的 `shortdrama/{env}/{purpose}` 新钥名需要一次合同
   修订对齐。`docs/contracts/` 不在本包边界,未动。
2. **KMS 五键合同的扩展**:`TOPIC_RADAR_52API_KEY`、`PI_REMOTE_API_TOKEN` 是敏感键
   但不在五键内;启用选题雷达/Pi 远程编排前,须先决定密钥清单扩展方式(第六、七键
   或独立 purpose 密钥),改 secret-init 校验清单并重建镜像。
3. **`scripts/bootstrap-production-admin.ts` 命名撒谎**(服务 test):改名/通用化
   涉及 `scripts/` 与调用方,不在本包边界。
4. **`scripts/release-amd64.sh` 等脚本 echo 里的 production 措辞**、
   `test/dev-environment.test.ts` 里引用旧部署口径的注释:分别属 S21/S23 或应用
   测试地盘,未动。
5. **云侧实名保留项**(改名=云资源操作,本包不动,只登记):CR registry
   `shortdrama-prod-cn-beijing.cr.volces.com`、IRSA role 现名、KMS 管理员凭据
   `shortdrama/production-admin`(合同目标名 `shortdrama/{env}/admin`,runbook 已加
   内联注;改名须同步 DC 改密流程,建议在下个 KMS 操作窗口一并做)、Pod 内文件路径
   `/run/shortdrama/production-secrets.sh`(改它要联动 deployment 两处 source/挂载,
   收益低风险高,建议保留或在下次镜像重建窗口顺手改)。
6. **dev/prod overlay 骨架的已知形态差异**:两个 overlay 用 kustomize `namespace:`
   字段重命名,会给集群级 `ALBInstance` 盖上 `metadata.namespace`(API server 忽略,
   `validate-manifest-scope.mjs` 已容忍)。骨架阶段无害;dev/prod 真要开通时若在意
   对象形态,改为按环境复制 base 再改,不用 namespace transformer。

## 6. 尚未验证(必须如实知道)

- 线上精确 26 键、live ALBInstance/Ingress 对象名、IAM trust 现状:本包无集群权限,
  全部由 Fable 按 §2 步骤 0 实读核对。
- 内网 RDS 从 VCI Pod 的连通性:从未被证据链证明过(这正是公网临时态的由来),
  步骤 3 是第一次实测。
- dev/prod overlay 是骨架:全部 `REPLACE_WITH_*` 占位,渲染即被 fail-closed 拒绝,
  不代表任何已开通环境。
