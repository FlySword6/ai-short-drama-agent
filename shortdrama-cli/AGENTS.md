# shortdrama-cli Agent 入口

本文件约束 `shortdrama-cli/` 子项目内的实现、测试和交付。根仓入口只描述项目定位；CLI 相关细则以本文件为准。

## 项目边界

`shortdrama-cli` 是一套独立的 Python CLI 项目，不依赖上层 `zhongwen-shortdrama` demo 代码。上层项目只作为业务参考，不作为实现依赖。

实现以 `ARCHITECTURE.md` 为准。当前目标架构是薄 CLI / 厚业务服务端 / AgentKit 云端执行：CLI 负责参数解析、登录/session、上传、调用业务服务端、轮询任务、下载结果和格式化输出；AI 推理、AgentKit invoke、模型选择、成本/积分判断、MCP Gateway 调用都必须留在业务服务端或 AgentKit 层。

现有本地 mock pipeline 仅作为开发回归和离线演示路径，不代表生产职责边界。

## 技术选型

- 语言与运行时：Python 3.11+。
- 包管理与构建：`uv` + `pyproject.toml`，通过 `[project.scripts]` 暴露 `shortdrama` 命令。
- CLI 框架：`Typer`，命令层只做参数解析、run context 创建、错误到退出码映射。
- CLI 文案：默认显示中文；通过 `--lang en` 或 `SHORTDRAMA_LANG=en` 支持英文显示。
- 数据契约：`Pydantic v2`，所有 Agent 输出写入前必须通过本地 schema 校验。
- 测试：`pytest` + `typer.testing.CliRunner`，优先覆盖 CLI contract、输出文件和 manifest。
- 控制台输出：`rich`，仅用于人类可读状态，不进入核心业务契约。
- 存储：本地 JSON 文件 + `run-manifest.json`，每次运行写入独立 `runs/<id>/` 目录。
- 远程数据交互：只能通过 `server_api/` 的业务服务端 API client 层完成；旧 `api/` 仅保留 runs 兼容路径。
- Provider：默认 `mock`，真实 OpenAI / 火山云 / AgentKit 能力只能通过 `providers/` 适配器接入。
- 配置：环境变量或本地配置文件读取，凭证不得提交；mock 模式不能要求任何凭证。
- 打包：先作为标准 Python CLI 包交付；mock pipeline 稳定后可用 PyInstaller / shiv / pex 追加单文件可执行产物。

## 开发完成标准

任何模块开发、行为调整或 bug 修复，都必须同步完成对应测试用例的开发和编写。只有相关测试通过后，才可以认定任务完成。

- 新增 CLI 命令或参数：必须补 `typer.testing.CliRunner` contract test，覆盖退出码、关键输出和产物文件。
- 新增 / 修改 CLI 文案：必须同步更新 `i18n.py`，并补默认中文与英文切换测试。
- 新增 / 修改 Agent、Provider、Schema、Storage 或 Pipeline 行为：必须补最近层级的 pytest，覆盖成功路径和关键失败 / 边界路径。
- 新增 / 修改 API 交互：必须补 API client contract test，断言 URL、HTTP method、headers 和 JSON body；不得依赖真实网络或真实服务。
- 修改 manifest、输出 JSON 或运行目录结构：必须断言实际文件内容和 `run-manifest.json` 状态。
- 未能运行测试时，不能标记为完成；必须明确说明阻塞原因和缺失验证。
- 最小完成命令：在 `shortdrama-cli/` 下运行 `make test` 或 `uv run pytest -q` 并通过。

## 代码边界

- `agents/` 暴露业务执行单元，不知道 provider 专属请求体、鉴权、网络重试或 SDK 类型。
- `providers/` 是外部能力适配层。AgentKit、OpenAI、火山云 SDK 对象不能泄漏到 `agents/`、`domain/`、`storage/` 或 `cli/`。
- `server_api/` 是业务服务端交互层。CLI 禁止直连 PostgreSQL / Supabase 数据库，禁止直连 AgentKit invoke/task API，禁止直连第三方模型 API；所有生产数据读取、写入和 AI 生成必须通过业务服务端 API。
- `output/` 负责 human/json 输出稳定性；所有 WorkBuddy/自动化路径必须支持 `--json`。
- `schemas/` 保存本地结构化契约。所有输出写入前必须通过 schema 校验。
- `storage/` 负责运行目录、产物 JSON 和 `run-manifest.json`。
- `cli/` 保持薄层，只解析参数、调用业务流程、映射错误和退出码。

## 安全约束

- 禁止在 `shortdrama-cli` 中新增 `psycopg`、`asyncpg`、`sqlalchemy`、Supabase database client 或任何直连数据库依赖。
- 禁止读取或要求 `DATABASE_URL`、PostgreSQL 用户名 / 密码等数据库凭证。
- API token 只能来自显式 CLI 参数、环境变量或后续安全登录机制；不得写入 `runs/`、日志、manifest、fixture 或测试快照。
- API 层只处理后端 API 契约，不承载业务 Agent、Provider SDK 或本地文件存储职责。
- 本地只允许缓存 active project id、项目名、最近任务摘要、scene/asset 最小索引和下载路径映射；不得缓存完整项目数据、完整剧本、完整分镜内容或生成结果正文。

## 验证命令

```bash
make test
```

等价于：

```bash
uv run pytest -q
```
