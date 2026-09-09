# 配置与密钥管理合同（V0.1.1）

Dario 2026-07-21 裁决：生产 config 固定在 VKE 清单，密钥走火山云 KMS 与 IRSA
initContainer，不落主机 env 文件。

## 一、固定位置（定死，不再变）

| 环境 | 位置 | 说明 |
| --- | --- | --- |
| 本地开发 / dev/test Compose | 仓库根 `.env` | Compose 默认读取；已在 `.gitignore`。`SHORTDRAMA_ENV_FILE` 仅作 dev/test 临时覆盖 |
| 生产非 secret | `deploy/k8s/configmap.yaml` 的 `ConfigMap/shortdrama-runtime` | 由持续交付渲染进 `shortdrama-prod`；不得另建主机 production.env |
| 生产 secret | KMS `shortdrama/prod/runtime` → `/run/shortdrama/production-secrets.sh` | initContainer 通过 IRSA 读取，0600 写入 `medium: Memory` 的 `emptyDir`，应用只读挂载 |
| 变量 schema | `src/config/env.ts` | 加变量必须同步相关本地 example，以及生产 `configmap.yaml` 或 KMS 必需/可选密钥清单；缺一视为集成缺陷 |

`.env.example` 与 `.env.release.example` 都只服务本地开发、离线检查或 dev/test Compose，
不是生产配置真源。

历史遗留：`/tmp/shortdrama-release-verify.env` 已废弃，内容迁入本机 `.env`（2026-07-21）。

## 二、secret 与非 secret 分离

**启动必需 secret（5 个）**：`ARK_API_KEY`、`TOS_ACCESS_KEY`、`TOS_SECRET_KEY`、`POSTGRES_PASSWORD`、`MILVUS_PASSWORD`。

**Seedance 素材注册可选 secret（0 或 2/3 个）**：`VOLCENGINE_ACCESS_KEY_ID` 与
`VOLCENGINE_SECRET_ACCESS_KEY` 必须成对出现；`VOLCENGINE_SECURITY_TOKEN` 仅在该对存在时可选。
三者均不存在时，生产启动与原五项密钥行为完全不变；只出现半套或空值时 initContainer
必须失败，不能带着不完整授权继续启动。

**供应商可选 secret**：`SEED_AUDIO_API_KEY`、`MINIMAX_API_KEY`、`NEWAPI_API_KEY`，
以及公司文字网关成对的 `COL_BASE_URL` / `COL_APIKEY`。不存在时不影响五项
启动必需 secret；存在时必须是非空安全字符串。MiniMax 还要求 ConfigMap 中对应
`MINIMAX_*_MODELS` 显式 allowlist，只有 key 而没有模型 allowlist 时保持不可用。
FABLE-007 的本地真实 provider smoke 还要求
`FABLE007_DEV_{ARK,MINIMAX,SEED_AUDIO}_CREDENTIAL_SHA256` 命中独立批准的 dev
凭据指纹，并同时通过 `NODE_ENV=development` 与 dev 数据库身份指纹门；这些哈希不是
凭据，test/prod 必须保持为空。

**企业微信登录可选 secret**：`WECOM_CORP_SECRET`。`WECOM_LOGIN_ENABLED=false` 时可以不存在；开启时必须与非 secret 的 `WECOM_CORP_ID`、`WECOM_AGENT_ID`、HTTPS `WECOM_CALLBACK_URL` 同时有效，否则应用启动失败。生产值只能作为 KMS `shortdrama/prod/runtime` 的可选键经 IRSA initContainer 注入内存卷，不得进入 ConfigMap、Kubernetes Secret、镜像层、前端变量、文档、Issue、截图或日志。

环境隔离固定为：集群 dev 使用 `shortdrama/dev/runtime`，test 使用
`shortdrama/test/runtime`，prod 使用 `shortdrama/prod/runtime`；三者各自保存对应企业微信
自建应用的 `WECOM_CORP_SECRET`，不得跨环境复用，尤其不得把 prod CorpSecret 用于本地、dev
或 test。本地开发不接 KMS，只能使用 Git 忽略的 `.env` 和独立开发凭据。实际写入 KMS 必须
由对应环境的授权管理员执行，代码交付本身不授权写入、部署或开启登录开关。

企业微信非 secret 配置固定为 `WECOM_LOGIN_ENABLED`、`WECOM_CORP_ID`、`WECOM_AGENT_ID`、`WECOM_CALLBACK_URL`、`WECOM_STATE_TTL_SECONDS`。默认关闭，state TTL 默认 300 秒；变量必须同步 `src/config/env.ts`、本地 example 与生产 ConfigMap 登记。前端不得把构建变量当作能力真值，运行时只读服务端 `/api/v1/auth/wecom/status`。

其余全部为非 secret 配置（模型 ID、桶名、endpoint、开关、阈值），可进文档与聊天，不可进仓库的只有 secret。

## 三、生产密钥托管（火山云凭据管理）

选型：火山引擎 **KMS → 凭据管理（Secret Manager）**，对标 AWS Secrets Manager / Parameter Store。
依据：官方产品文档（KMS 产品概述 volcengine.com/docs/6476/71298）。要点：

- 凭据类型用「通用凭据」，一个凭据存一组 KV（本项目 5 个启动必需 secret 存一个凭据
  `shortdrama/prod/runtime`；Seedance 注册 AK/SK 与 `WECOM_CORP_SECRET` 仅在对应能力启用时追加到同一组 KV）；
- 生产 initContainer 使用仓内 `deploy/k8s/secret-init/` 构建的 helper，通过官方 Go SDK 的
  OIDC provider 与 VKE IRSA 临时身份调用 KMS `GetSecretValue`；
- helper 只读取固定凭据名，始终校验五项必需 secret；可选的注册 AK/SK 只有完整成对时才随
  同一份 0600 Bash export 文件写入，临时 token 也只在该对存在时写入；可选供应商键
  以及 `WECOM_CORP_SECRET` 仅在存在且通过校验时写入；企业微信开关开启但配置或密钥缺失时
  失败并阻止应用容器启动；
- Pod 不从 ConfigMap、Kubernetes Secret、清单、日志或镜像层取得 AK/SK；可选注册 AK/SK 仅由
  KMS initContainer 写入内存卷并由应用进程 source，不进入仓库或镜像；
- TOS AK/SK 后续可升级为 KMS「IAM 凭据管理」自动轮换（2026-07-21 手工轮换先行，自动轮换列入 v0.1.2 运维项）；
- `deploy/fetch-secrets.sh` 仅保留为本地/offline 与 dev/test Compose 兼容工具，不属于生产
  VKE secret 注入路径。

生产 secret 路径固定为：IRSA 投射 OIDC token → KMS `shortdrama/prod/runtime` →
initContainer 校验五项必需值及可选注册凭据的一致性 →
`/run/shortdrama/production-secrets.sh` → app 容器 source 后启动。
任何一步失败都必须 fail-closed，不得回退到主机环境中的 AK/SK、主机 env 文件或人工创建 Secret。

## 四、本地规则

- 本地 `.env` 手工维护，不接 KMS（避免每人开 KMS 权限）；
- secret 值不进聊天、不进 commit、不进日志；SDK 报错堆栈含 key 的问题已有先例（TOS 泄漏事件），
  排查日志前先确认脱敏；
- dev/test Compose 可以用 `.env.release.example` 检查变量兼容性，但不得据此声称生产配置、
  KMS 身份或 RDS 私网连通已验证。
