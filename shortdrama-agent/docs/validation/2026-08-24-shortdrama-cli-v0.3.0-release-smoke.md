# shortdrama-cli v0.3.0 发行版功能冒烟回执

状态：`smoke_passed_pending_platform_tiers`

日期：2026-08-24

对象：`<HOME>\.shortdrama\versions\0.3.0\shortdrama-cli\shortdrama-cli.exe`
（PyInstaller one-folder 发行版，内嵌 `_internal\python311.dll` +
`base_library.zip` + `skills/shortdrama-cli/` Skill 包）

站点：`<MAIN_API_BASE>`（主站根，CLI 自动拼接 `/api/v1`）

账号：`<TEST_ACCOUNT>`（`role=admin`，`ui_mode=full`）

## 结论

发行版 CLI 功能**正常**。登录认证、只读查询、Skill 包装载、模型目录与能力
档位查询全部可用；唯一未闭环的是「真实生图/生视频下单」——根因在**主站侧
当前没有可用的计费档位（tiers 为空、供应商未开通）**，不在本地发行版。

## 验证记录

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 版本自检 | `shortdrama-cli.exe --version` | `0.3.0` ✅ |
| 命令清单 | `shortdrama-cli.exe --help` | doctor/auth/project/asset/script/prep/generation/queue/review/delivery 齐全 ✅ |
| 无认证诊断 | `doctor --api-base <MAIN_API_BASE>` | `skill_installed: true`，`authenticated: false` ✅ |
| 登录 | `auth login --username <TEST_ACCOUNT>`（密码走 `SHORTDRAMA_PASSWORD`） | `authenticated: true`，`role=admin`，`expires_at 2026-08-31` ✅ |
| 认证诊断 | `doctor --require-auth --api-base …` | 通过 ✅ |
| 项目查询 | `project list --api-base …` | 返回 1 个项目（「生图测试项目」，generation_config 含 image 9:16/1K、video 720p）✅ |
| 模型目录 | `generation models --api-base …` | 12 个模型，仅 Seedream 5 Pro（图）、Seedance 2.0（视频）标记 available ⚠️ |
| 能力档位 | `generation capability-tiers --media-type image|video` | `tiers: []` 空；parameter_models 多为 `provider_not_enabled` / `unconfigured` ❌ |

## 生图/生视频链路（当前唯一可用的完整路径）

付费生成严格执行四阶段，禁止自动确认/提交（SKILL.md 第 23 行硬约束）：

```
generation estimate --payload '{…}'   → 估价（简单成本预览 / 正式估价两种）
    ↓ 人工审阅报价
generation confirm --quote-id <id>     → 确认
    ↓ 人工确认
generation submit --payload '{…}'      → 提交，主站调度真实模型
queue status …                          → 轮询到终态（scripts/poll_status.py）
download_result …                       → 下载成品（scripts/download_result.py）
```

`--payload` 由调用方（agent/程序）构造，CLI 不解释、不内置 schema；字段口径以
`generation capability-tiers` 返回的 `parameter_models` 为准。因当前 `tiers`
为空，正式估价暂无任何可选档位可下单。

## 与代码库内 0.3.1 库的区别（澄清）

| | `.venv` 内 `shortdrama_cli` 0.3.1（库） | 本发行版 0.3.0（exe） |
| --- | --- | --- |
| 形态 | 纯 Python 库，供 `pi-http-wrapper` `import` | PyInstaller 打包完整应用 + Skill 包 |
| 生图生视频 | 仅 `MockProvider`（写 `.txt` 假数据，不联网） | `generation` 全套命令 + 原子脚本，打主站真模型 |
| 用途 | wrapper 主站回查（`BusinessServerClient`） | 真实业务交付工具 |

两者是**两套独立安装**，互不覆盖；发行版运行时读自己的 session，不读 `.venv`
的 token。

## 阻塞项（平台侧，非本地）

1. 主站 `generation capability-tiers` 返回 `tiers: []`，`image`/`video` 的
   `parameter_models` 多为 `provider_not_enabled`（公司账户未开通）或
   `unconfigured`（模型 ID 未配置）——真实下单前需平台侧开通档位。
2. 若后续走 wrapper 端到端（对应交付卡「链路实通」），仍需：ECS 真实 `pi`
   更新到位 + 用户隔离（`feat/user-isolation`）合入主仓后 ECS 拉新代码。
