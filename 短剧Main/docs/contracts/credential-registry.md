# 凭据登记表(短剧平台)

**为什么有这份文件**:DC 反馈"你或 kimi 自己建完的账密,我根本不知道去哪里找"。
这是真实的治理漏洞——凭据能用不等于能被找到。本表登记**每个账号是干什么的、
密码存在哪**,**不记录任何密码值**。新建任何账号/密钥,必须同一次提交更新本表,
否则视为交付不完整。

规则:

- **真源永远是 KMS**,`.env` 只是本机镜像(600 权限,不进 git)。
- 新建凭据的**同一次操作**里就要:写入 KMS(按 §命名规范)→ 镜像进 `.env` → 更新本表。
- 本表只写"在哪、干什么、谁能用",**任何情况下不写值**。

## 一、数据库账号(RDS `postgres-4a3018919997`,实例名 shortdrama-dev)

| 账号 | 用途 | 权限现状 | 密码位置 | 备注 |
| --- | --- | --- | --- | --- |
| `shortdrama_migrator` | **v0.2.0 测试环境 DDL/迁移专用** | Inherit,Login + 库级 CREATE;schema `app` 的属主 | KMS `shortdrama/test/migrator` + `.env` `POSTGRES_MIGRATOR_*` | 2026-07-25 Fable 建,DC 授权。不进应用运行配置 |
| `shortdrama_test` | v0.2.0 测试环境**应用运行时** | 无库级 CREATE;schema `app` 上有 USAGE+表增删改查(无 DDL);**是 `common` 与 `public` 的属主** | KMS `postgreSQL-dev` + `.env` `POSTGRES_RUNTIME_*` | ⚠️ 见下方风险条 |
| `shortdrama_app` | 库 `shortdrama` 与 `col_temp_shortdrama` 的**属主** | Normal | **未知**(DC 亦不知谁建) | 团队旧系统可能在用,勿重置密码 |
| `shortdrama_prod` | `prod` schema 的属主 | Normal | 疑在 KMS `shortdrama/production`(未核实) | `prod` schema 已废弃,见治理规范 §2 |
| `shortdrama_readonly` | **只读**:ETL plan、数据画像、排查看数 | 仅 SELECT(common/app/public 三个 schema);无 CREATE、无写、非超管、不绕 RLS;已设 DEFAULT PRIVILEGES 覆盖将来新建的表 | `.env` `POSTGRES_READONLY_*` | 2026-07-26 Fable 建,DC 授权。**关闭 G8 缺口** |
| `admin` | 实例超级用户,**仅 DBA 手动运维** | Super | KMS `shortdrama/test/superuser` + `.env` `POSTGRES_SUPERUSER*` | **2026-07-25 重置**(DC 授权):原 KMS `shortdrama/production-admin` 里的密码认证失败且来源不明。重置前确认 admin 零活动连接 |
| `socialkb_owner` / `socialkb_reader` | 社媒知识库(林夕线) | — | 未登记 | 非短剧平台运行配置 |
| `col_temp_app` / `colapi_app` | col 业务线 | — | 未登记 | 非本平台 |

### ⚠️ 风险条:运行账号拥有他人活数据的属主权

`shortdrama_test` 是 schema `common` 的**属主**,而 `common` 装着团队旧系统的
2071 条活资产。也就是说我们的应用运行账号对别人的生产数据有完整 DDL 权限。
应用侧的漏配兜底已修(commit 191f15d,schema 兜底不再指向 `common`),但
**权限本身仍在**。收敛动作:把 `common` 的属主改回他们自己的账号,或为我们
另建纯运行账号。此项需与震宇/林夕商定后执行,属高影响动作。

## 二、KMS 密钥

| 密钥名 | 装什么 | 状态 |
| --- | --- | --- |
| `shortdrama/test/migrator` | canonical `DATABASE_URL`（账号固定 `shortdrama_migrator`，`verify-full` + 绝对 CA 路径）；迁移窗口内保留旧 `Accounts` 字段作回滚锚，不被 `secret-init` 导出 | ✅ 符合命名规范；仅短命 DDL Job 可读，应用运行 Pod 不引用 |
| `shortdrama/test/superuser` | 重置后的 `admin` 超级用户 | ✅ 2026-07-25 建 |
| `postgreSQL-dev` | `shortdrama_test` 账号名+密码 | 命名不合规范,待收敛为 `shortdrama/test/postgres` |
| `shortdrama/production-admin` | 曾装 `admin` | ❌ **已失效**(密码认证失败),由 `shortdrama/test/superuser` 取代,待删除 |
| `shortdrama/production` | 旧测试站启动密钥:ARK_API_KEY / TOS_ACCESS_KEY / TOS_SECRET_KEY / POSTGRES_PASSWORD / MILVUS_PASSWORD | ⚠️ 旧名保留作迁移回滚锚点;新发版不再引用。2026-07-25 版本 `fix-postgres-password-20260725` 仍可回滚 |
| `shortdrama/test/runtime` | 测试站启动密钥:ARK_API_KEY / TOS_ACCESS_KEY / TOS_SECRET_KEY / POSTGRES_PASSWORD / MILVUS_PASSWORD;可选音频键 `SEED_AUDIO_API_KEY` | ✅ 2026-07-30 建于 KMS 项目 `shortdrama`,版本 `seed-audio-bootstrap-20260730`;只登记位置与键名,不记录值。需配套新版 `secret-init` 才会导出音频键 |
| `shortdrama-pwd-dev` | 未核实 | 待登记 |
| `shortdrama/dev/bytehouse` | ByteHouse dev 应用账号 `shortdrama_bh_app` 的 `username` / `password` | ✅ 2026-07-27 建；`Generic`、`Enable`、项目 `shortdrama`；仅 KMS 保存值 |
| `shortdrama/dev/bytehouse-readonly` | ByteHouse dev 只读账号 `shortdrama_bh_readonly` 的 `username` / `password` | ✅ 2026-07-27 建；`Generic`、`Enable`、项目 `shortdrama`；仅 KMS 保存值 |

命名规范见环境治理规范 §2:`shortdrama/{env}/{purpose}`。

## 三、待办

1. ✅ 已完成:migrator 获库级 CREATE、schema `app` 建成并跑完迁移 001→020
2. 核实并登记 `shortdrama-pwd-dev` 装的是哪个账号(`shortdrama/production` 已查清并登记)
3. KMS 密钥名已收敛到 `shortdrama/test/runtime`;旧名 `shortdrama/production` 在新 initContainer、IRSA 和测试站验收通过前只作回滚锚点,不删除
4. `postgreSQL-dev` 密码轮换(见治理规范 §4.1)
5. `common` 属主归位(风险条)

## 三·五、测试站应用凭据

| 项 | 值位置 |
| --- | --- |
| Day-0 管理员用户名/密码 | `.env` `TEST_ENV_ADMIN_USERNAME` / `TEST_ENV_ADMIN_PASSWORD`;另有 0600 文件 `.secrets/day0-admin-password.txt` |
| 角色 | `admin`(已核实 `app.users.role='admin'`) |

首次登录后请在界面改密;改完记得同步更新 `.env`。

## 三·六、ByteHouse dev 应用凭据（仅登记位置，不写值）

| 账号 | 用途 | 权限范围 | 密码位置 | 备注 |
| --- | --- | --- | --- | --- |
| `shortdrama_bh_app` | S55 建库/四域初始化后的 dev 应用写入 | 仅 dev 环境 `*.*`：`ALTER`、`CREATE`、`INSERT`、`SELECT`、`SHOW`；默认计算组 `shortdrama_dev_wh`；无 `DROP`、`TRUNCATE`、`PROCESS`、`KILL_QUERY`、`OPTIMIZE`，无账户或计算组管理权 | KMS `shortdrama/dev/bytehouse`（`username` / `password`） | 2026-07-27 建。按用户直接要求，未生成本地 `.env` 镜像；S55 只能由受控运行环境从 KMS 注入。 |
| `shortdrama_bh_readonly` | dev 只读应用/排查读取 | 仅 dev 环境 `*.*`：`SELECT`、`SHOW`；默认计算组 `shortdrama_dev_wh`；无写入、DDL、账户或计算组管理权 | KMS `shortdrama/dev/bytehouse-readonly`（`username` / `password`） | 2026-07-27 建。按用户直接要求，未生成本地 `.env` 镜像；S55 只能由受控运行环境从 KMS 注入。 |

test/prod 应用账号和凭据按裁决“等用到再建”，本次未创建。

## 四、纪律

- 任何人(含 kimi、含 subagent)新建账号或密钥,**必须**在同一次交付里更新本表。
- 密码值不进代码、文档、日志、memory、聊天记录。
- 读取 KMS 时,打印结构一律**递归掩码所有值**,不做按键名的白名单——
  2026-07-25 有过一次漏打印,原因就是白名单式掩码漏了嵌套字段。

## 火山 AK/SK 环境口径(2026-08-03 DC 拍板,R179)

- **dev**:用 DC 主账号 AK/SK(根 .env 既有 VOLCENGINE_* / DEV_* 键)——开发期低摩擦。
- **test / prod**:各走**独立 IAM user**(最小权限策略,按域收口:资产注册/BH/生成网关各自评估是否分 user);每个 IAM user 至多 2 把 Access Key,**第二把只用于轮换**(火山官方口径:新使用场景=新建 IAM 用户,不复用 AK)。
- 键位命名沿既有前缀族:DEV_/TEST_/PROD_;凭据值只进 .env/KMS,不落屏不进回执。
- 适用:S71 资产注册、S55 ByteHouse、多模型网关及后续一切火山面凭据。
