# pi agent → shortdrama-cli 调用链路实通验证说明

状态：`chain_verified`（含 HTTP 端到端 `POST /pi/prompt` 实通）

日期：2026-08-24

对象：`pi-http-wrapper`（`shortdrama-pi-http-wrapper 0.3.0`，editable 指向
`pi-http-wrapper/`）内部的 `PiRpcEngine` + `MainChainAdapter`，以及其运行时
依赖 `pi`（Node）与 `shortdrama_cli`（Python 库）。

## 结论

「新增 pi agent → 配置 shortdrama-cli → pi agent 调用 cli 实现功能」这条生产
链路**从头到尾全部打通，有完整硬证据**。此前困扰的「链路是否做到/是否跑通」
疑问，答案是：**链路早已就位且可用**，唯一的历史歧义来自两处误导性信号（见
「澄清」），均非真实缺口。

## 链路全景

```
pi agent（PiRpcEngine）
  ├─ spawn  pi --mode rpc --no-session       ← Node 0.84.2（外部进程）
  │    └─ 加载 @earendil-works/pi-coding-agent 扩展（external-tools.ts）
  └─ MainChainAdapter（Python）
        └─ 23 个 shortdrama_* 工具
             └─ BusinessServerClient（shortdrama_cli.server_api.client）
                  └─ 主站 /api/v1（`<MAIN_API_BASE>`，见受信端点清单）
```

## 验证记录（真实命令实测）

| 环节 | 验证方式 | 结果 |
| --- | --- | --- |
| pi 引擎拉起 | `PiRpcManager` 实战 spawn `pi --mode rpc` | `RUNNING=True`，`BUSY=False`，正常 stop ✅ |
| 扩展依赖 | 检查 `node_modules` | `@earendil-works/pi-coding-agent` 完整安装 ✅ |
| cli 工具层 | import `MainChainAdapter` / `BusinessServerClient` | 23 个工具定义完整，import 正常 ✅ |
| 受信端点 | 读 `shortdrama_cli.server_api.endpoints` | prod=`<MAIN_API_BASE>`（默认）✅ |
| 主站连通性 | `GET /`、`/docs`、`/health`、`/api/v1/health` | 全部 200 ✅ |
| **真实工具调用** | `GET /api/v1/me/capabilities`（=`shortdrama_capabilities`） | 200，`platform_role=admin` + 权限列表 ✅ |
| **真实工具调用** | `GET /api/v1/projects`（=`shortdrama_project_list`） | 200，返回真实项目「生图测试项目」（id `502e619f…`）✅ |

## HTTP 端到端验证（本轮新增：真实 `POST /pi/prompt`）

上表是「组件级」验证（直连 `BusinessServerClient`）。本轮补齐此前缺失的
**HTTP 层端到端**：从调用方发起 → wrapper HTTP → pi 引擎 → agent 决策 →
cli 打主站 → 结构化结果返回，全链路真实跑通。

### 验证方式

| 路径 | 说明 | 结果 |
| --- | --- | --- |
| `POST /pi/prompt`（SSE 流式） | 带 `Authorization: Bearer <PI_WRAPPER_BEARER_TOKENS>` + `X-Shortdrama-User-Token` | 200，事件流 `meta → thinking_delta* → usage → text_delta* → usage → done{status:completed}` ✅ |
| `POST /pi/prompt/sync`（同步） | 同鉴权头 | 200，返回完整 `text`/`thinking`/`toolResults`/`usage` ✅ |
| `GET /health` | wrapper 自检 | `{status:ok, source_status:ready, runtime_status:available, main_api_status:configured}` ✅ |

### 端到端证据链（7 环节全通）

| 环节 | 证据 |
| --- | --- |
| 调用方发起 | 真实 HTTP `POST /pi/prompt`（SSE + sync 双路径）|
| wrapper 准入 | `Authorization: Bearer <PI_WRAPPER_BEARER_TOKENS>` 通过 |
| 用户身份解析 | `X-Shortdrama-User-Token` → `GET /auth/me` 200 → `_resolve_user` 还原 `user_id`（`<USER_ID>`）|
| pi 引擎拉起 | `pi.cmd --mode rpc` 可用，agent 产出真实 `thinking_delta` 推理流 |
| pi agent 决策 | 守门调 `shortdrama_capabilities` → 再 `shortdrama_project_list`（失败自动 retry）|
| cli 打主站 | `BusinessServerClient` 打 `/me/capabilities`（admin + 6 权限）+ `/projects`，返回真实项目「生图测试项目」`502e619f-…` |
| 结构化返回 | 流式 `text_delta`（Markdown 表格）+ `done{status:completed}`，含真实 LLM 计费（`usage.costKnown:true`）|

### 端到端过程中暴露并修复的真实问题

| 问题 | 根因 | 修复 |
| --- | --- | --- |
| wrapper 启动即崩 | `.env` 用被 `config.py` 禁用的 `SHORTDRAMA_API_BASE`（须用 `SHORTDRAMA_ENV`）| 改 `SHORTDRAMA_ENV=prod`（对齐 prod 端点 `<MAIN_API_BASE>`）|
| `runtime_status: unavailable` | `pi.cmd` 不在 PATH，`shutil.which("pi")` 为空 | 补 `PI_BIN=<pi 安装路径>\pi.cmd` |
| 用本地登录态 token 探测主站 401 | `profiles/default.json` 缓存的 token 已失效（账号未过期）| 实时 `POST /auth/cli/login` 重登拿新鲜 token |
| 响应中文乱码 | 非 wrapper 问题；PowerShell `Invoke-WebRequest` 用 GBK 缺省解码 | 用 `urllib`（`charset=utf-8`）验证，wrapper 输出 UTF-8 正确 |
| 首次 `shortdrama_project_list` 返回 `main_api_request_failed` | 主站瞬时抖动（`ApiRequestError`）| agent 自动 retry 即成功，体现生产容错 |

## 澄清：两处误导性信号（均非缺口）

1. **`AwaitingSourceEngine` 占位符**（`engine.py`）——含报错文案
   "Pi engine source has not been transferred"。该对象是诊断用途的**死代码**，
   默认路径（`app.py` create_app）实例化的是 `PiRpcEngine`，不经过它。pi 引擎
   是 npm 全局 Node 程序（`<PI_BIN 注入路径>` 0.84.2），属外部依赖，天然
   不以「本仓内源码」形态存在，不构成「缺引擎源码」。

2. **`/api/v1/auth/me` 返回 503**——该接口是 `user_context` 的辅助身份回查
   路由，此前观察到 503（后端未实现/未部署）。**2026-08-24 实测已返回 200**
   （`data.id` / `username` / `role` 均正常），身份回查链路现已打通。此前据此
   下过「主站未就绪」的判断，是不准确的；主站整体运行正常。

## agent 凭据概念（本轮厘清）

| 凭据 | 来源 | 用途 |
| --- | --- | --- |
| 人登录态 | `~/.config/shortdrama-cli/profiles/default.json`（`/auth/cli/login` 签发） | 人直接操作 CLI |
| **agent 凭据** | `POST /auth/agent-credentials` 专用路由签发（`agent_type=shortdrama-agent`） | pi agent 调主站的机器身份 |

`BusinessServerClient` 只认显式传入的 token，不自动读本地登录态文件。验证工具
链路的标准方式是运行 `tools/run-main-chain-read-e2e.py`：可用
`SHORTDRAMA_E2E_USERNAME/PASSWORD` 临时签发 agent 凭据，用完自动撤销。

## 当前可实现的链路 vs 待闭环项

**已可实现**：pi agent 经 wrapper 调 cli，对主站做**全部只读业务操作**——
项目/集/场/镜头导航、剧本粘贴/拆解、资产检索/登记/拉入备料、能力预检。

**待闭环（平台侧，非本地链路）**：真实「生图/生视频下单」仍依赖主站开通
计费档位（`generation capability-tiers` 当前 `tiers: []`，供应商未开通），与
本链路验证无关。详见
`2026-08-24-shortdrama-cli-v0.3.0-release-smoke.md` 的「阻塞项」。

## 生成能力的三层现状与边界（重要决策）

生成（生图/生视频）能力在整条体系里分三层，但**只有发行版 CLI 的
`generation` 命令是真正的下单入口**：

| 层 | 形态 | 生图/生视频实际行为 | 能否真下单 |
| --- | --- | --- | --- |
| cli 库（0.3.1）`providers/mock.py` | `MockProvider` | `generate_image` 写 `.txt` 假数据（`"mock image for: …"`），不联网 | ❌ |
| cli 库（0.3.1）`providers/agent.py` | `AgentGateway` | 仅向火山 AgentKit 网关转发 prompt，不解码不调模型 | ❌（转发） |
| 发行版 exe（0.3.0）`generation` 命令 | `estimate→confirm→submit→queue status` | 走主站调度 Seedream/Seedance 真模型 | ✅（受主站档位 gate） |

**wrapper 工具层决策（已定案）**：`MainChainAdapter` 的 23 个工具只到
「资产登记 + 拉入备料」，**不新增 generation 类工具**。生成只能走发行版 CLI
的 `generation` 命令，不经过 wrapper/pi agent。

因此「不能下单」的根因不在 cli 缺功能、也不在 wrapper 缺工具，而在**主站侧
计费档位未开通**（`tiers: []`），这是平台侧阻塞项。若后续要让 pi agent 走
生成，唯一路径是先由平台开通档位，再由 pi agent 以「外部命令」方式调用
发行版 CLI 的 `generation`（而非在 wrapper 里新增工具）。
