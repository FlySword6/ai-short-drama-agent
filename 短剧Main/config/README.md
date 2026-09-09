# 环境配置分层约定

立于 2026-08-09。起因：一线同事在测试环境点「新建项目」被拒，根因是
`ALLOW_MEMBER_CREATE_PROJECT` 代码默认 `"false"` 且集群从未注入这个键——
运维查集群查不到它，不看代码就不知道它存在，更不知道它是关着的。

## 一、三层各管什么（边界，别混）

| 层 | 放什么 | 存在哪 | 判据 |
|---|---|---|---|
| **代码兜底**（code default） | 只放「没配也不会改变产品行为」的技术缺省，如超时秒数、重试次数、日志级别 | `src/config/env.ts` 的 `.default(...)` | **产品开关不许有默认值**。见第二节 |
| **环境配置**（environment config，非密） | 每个环境不同、但不是密钥的事实：开关、模型名、清单、阈值 | 本目录 `env.<环境>.json`；部署时展开成容器 env | 值可以进 git，任何人可读 |
| **环境密钥**（environment secret） | 口令、Token、AK/SK、连接串里的密码 | 只在部署平台的密钥管理里；本目录只登记**键名** | **值绝不进 git**，本目录任何文件不许出现值 |

**运行期状态**（数据库里的档位激活、账号积分）不属于配置，不要试图用 env 表达它。
它的对账靠 `/api/v1/ready` 体检和受控脚本。

## 二、为什么产品开关不许有默认值

现在 `ALLOW_MEMBER_CREATE_PROJECT: z.string().default("false")` 导致两种情况**结果一样**：

| 情况 | 应该的结果 | 现在的结果 |
|---|---|---|
| 部署漏配了这个键 | 启动失败，点名缺哪个键 | 静默按 false 跑，功能默默关着 |
| 有意配成 false | 静默按 false 跑 | 同上，不可区分 |

**判据：「没配」和「配成 false」必须是两种不同结果。** 前者是部署事故，后者是产品决定。
不可区分就意味着一线同事看到「未开通权限」时，没人能判断是漏配还是有意为之。

九个产品开关（`src/config/env.ts` 实查）：

```
DEBUG                                默认 false
AUTH_REGISTRATION_ENABLED            默认 true
ALLOW_MEMBER_CREATE_PROJECT          默认 false   ← 2026-08-09 踩坑源
ALLOW_PAID_GENERATION                默认 false
NEWAPI_GENERATION_ENABLED            默认 false
SUCHUANG_GENERATION_ENABLED          默认 false
SEEDANCE_ASSET_REGISTRATION_ENABLED  默认 false
AI_GATEWAY_ENABLED                   默认 false
TOPIC_RADAR_52API_ENABLED            默认 false
```

## 三、开发 / 测试 / 生产的策略差异

| 维度 | 开发（dev） | 测试（test-env） | 生产（production） |
|---|---|---|---|
| `.env` 文件 | 读本机 `.env` | **不读文件**，全部由集群注入 | **不读文件**，全部由集群注入 |
| 业务同事能否建项目 | 开 | **开**（周一验收必须） | 按运营口径，默认关 |
| 付费生成 | 关（除显式实验） | 开，但有预算硬顶 | 开 |
| 错误降级/兜底 | **不许降级**，要暴露问题 | **不许降级** | 允许兜底 |
| 缺键时的行为 | 启动失败并点名 | 启动失败并点名 | 启动失败并点名 |

`NODE_ENV=production` 时 `resolveCompatibleEnvPaths` 返回空数组（`src/config/env.ts:566`），
即**不读任何 .env 文件**——这是对的，测试与生产都靠平台注入，别退回读文件。

## 四、怎么用本目录

```
config/
  README.md              本文件
  env.dev.json           开发环境的非密配置
  env.test-env.json      测试环境的非密配置
  env.production.json    生产环境的非密配置（仅登记，不代表已生效）
```

每份 JSON 两个区块：

- `required` —— 该环境**必须**存在的键。缺一个就该启动失败。
- `secrets` —— 该环境需要的密钥**键名清单**（只有名字，没有值）。

校验命令：

```bash
npx tsx scripts/check-env-config.mts --target test-env
```

它做三件事：核对 `required` 是否齐、核对 `secrets` 列的键是否存在（不读值）、
报出「代码声明了但三份清单都没提」的孤儿键。

## 五、局限

- 本目录只解决「说清楚该配什么」。**把值真正注入集群仍然是部署动作**，本目录不碰集群。
- `env.production.json` 只是登记，2026-08-09 立此文件时**生产环境未做任何改动**。
