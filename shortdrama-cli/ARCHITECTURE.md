# Shortdrama CLI 架构说明

发布标签与发版分支是不可变发布快照而不是长期开发主线；任何仅存在于发布快照的提交都必须经正式 Issue 逐项判定，并以适配当前架构的 PR 回流 `main`，不得把发版分支整体合回主干。

## 2026-07 职责优化结论

参考《Manhua Production shortdrama-cli Interface Design》（2026-07-07），`shortdrama-cli` 的生产职责应收缩为轻量命令代理：

```text
WorkBuddy / Human
  -> shortdrama-cli
  -> Business Server API
  -> AgentKit
  -> MCP Gateway / Cloud Storage / Third-party APIs
```

CLI always do：

- 解析结构化命令和参数。
- 管理本地 profile / session token。
- 上传本地文件到业务服务端。
- 调用业务服务端 API。
- 轮询服务端 task。
- 下载结果到用户指定路径。
- 输出 human / JSON。
- 维护最小离线摘要。

CLI never do：

- 不本地执行 AI 推理。
- 不直接调用 AgentKit invoke / task API。
- 不直接调用第三方模型 API。
- 不直连 PostgreSQL / Supabase 数据库。
- 不硬编码模型清单。
- 不保存完整项目数据、完整剧本、完整分镜内容或生成结果正文。
- 不在配置、日志、JSON、错误信息中输出 token、第三方 key 或私有链接。

当前仓内 `agents/`、`providers/mock.py`、`pipeline` 命令仅保留为本地 mock 回归和离线演示路径；新的生产命令应优先走 `server_api/`。

## 优化后的包结构

```text
src/shortdrama_cli/
  cli/
    app.py             # 根 Typer 应用，挂载十一个命令组
    common.py          # 跨命令共用的参数类型、客户端构造、退出码映射
    runtime.py         # 进程级执行设置（--debug）
    v030/              # 冻结的 v0.3 命令面，一个业务域一个模块
      __init__.py      # 只做再导出，外部 import 入口不变
      _helpers.py      # 跨域共用的路径拼装、写操作分发、参数解析
      auth.py  project.py  script.py  asset.py  prep.py
      generation.py  queue.py  review.py  delivery.py
      reference.py       # 参考控制包接线（issue #11）
      reference_test.py  # 抽卡工作台参考测试（issue #12）

  api/
    client.py          # HTTP transport（urllib）与超时口径
    errors.py          # ApiConfigurationError / ApiRequestError，退出码的来源
    tls.py             # 发行版自带 CA bundle 与 HTTPS 探测

  server_api/
    client.py          # 业务服务端 HTTP client

  output/
    formatter.py       # human/json 稳定输出

  i18n.py              # 默认中文，--lang en / SHORTDRAMA_LANG=en 切英文

  agents/              # 本地 mock/dev-only 业务单元
  providers/           # 本地 mock/dev-only provider 或未来隔离 adapter
  storage/             # 本地 runs/ 产物与 manifest
  schemas/             # 本地校验契约
```

生产命令调用方向：

```text
CLI Command
  -> validation / output formatter
  -> BusinessServerClient
  -> Business Server
  -> AgentKit / MCP Gateway
```

本地 mock 回归调用方向：

```text
CLI Command
  -> PipelineRunner
  -> local mock agents/providers
  -> local runs/ artifacts
```

两条路径不能混用：生产命令不得导入本地 mock Agent；mock pipeline 不得伪装成云端真源。

## `create image` 生产契约

第一条按新架构落地的命令是：

```bash
shortdrama-cli create image (--scene-id <id> | --prompt <text> | --prompt-file <path>) [options]
```

关键规则：

- `--scene-id` / `--prompt` / `--prompt-file` 必须且只能提供一种。
- 必须提供 `--project`，直到 active project profile 实现。
- `--size` 与 `--resolution` 互斥。
- `--variants >= 1`。
- `--reference-weight` 必须在 `0..1`。
- `--accept` 必须绑定 scene。
- 参数中出现第三方 API key 形态时拒绝。
- `--dry-run --json` 输出稳定 payload，不提交服务端任务。
- 非 dry-run 只调用业务服务端 API，不调用 AgentKit。

服务端 payload 最小形态：

```json
{
  "action": "generate_image",
  "project_id": "proj_abc123",
  "scene_id": "3",
  "prompt": null,
  "style": "动漫",
  "model": null,
  "model_preference": "quality",
  "cost_mode": "standard",
  "scene_complexity": "auto",
  "reference_assets": ["asset_role_hero"],
  "reference_weight": 0.75,
  "aspect_ratio": "9:16",
  "variants": 4,
  "bind_to_scene": true,
  "accept": false
}
```

human 输出保持稳定：

```text
image_generation=submitted task=task_img_abc123 project=proj_abc123 scene=3 variants=4
```

JSON 错误保持稳定：

```json
{
  "status": "failed",
  "error": {
    "code": "invalid_reference_weight",
    "message": "--reference-weight 必须在 0 到 1 之间。",
    "retryable": false
  }
}
```

## 目标

`shortdrama-cli` 是一套独立的、面向短剧生产流程的 orchestration 命令行工具。它不依赖上层 `zhongwen-shortdrama` demo 代码；上层项目只作为业务参考，不作为实现依赖。

CLI 的定位是开发入口、批处理入口和调试入口。它负责解析命令、编排步骤、调用在线业务 API、记录运行快照；它不拥有业务主数据，也不绕过权限直接调用模型或媒体 provider。

CLI 需要支持：

- 剧本拆解
- 角色拆解
- 分镜拆解
- 图片生成
- 视频生成
- 从剧本输入到生成产物的一键流水线执行

## 核心决策

采用第二种架构方案：

```text
skills/               # WorkBuddy 安装的短剧生产 skill，负责把用户意图编排成 CLI 调用
agents/               # shortdrama-cli 自己的业务 Agent
gateways/             # 访问受权限控制的在线业务 API
repositories/         # 读写本地运行快照和输出快照
```

在这个架构里，`Agent` 指的是 `shortdrama-cli` 内部的业务执行单元。它不是云厂商 SDK 类型，也不直接绑定火山云 AgentKit。

WorkBuddy 自身的 agent 不主动调用 `shortdrama-cli`。WorkBuddy 通过安装 **WorkBuddy Skill** 获得短剧生产能力，由 skill 负责解析用户意图、选择 CLI 命令、传入参数并追踪结果。`shortdrama-cli` 是 skill 调用的本地执行入口，不是 WorkBuddy 内置 agent 的直接依赖。

火山云 AgentKit 不由 CLI 直接作为主执行面接入；CLI 通过受权限控制的在线业务 API 间接触达 AgentKit 能力。需要本地开发或 mock 时，可以在 service client / gateway 层替换实现。

```text
CLI Command
  -> Orchestrator
  -> Service Client
  -> Gateway
  -> Online Business API
  -> AgentKit / Media Service
```

这样可以保证 CLI 的业务流程稳定，不会因为 AgentKit SDK 形态、鉴权方式或运行时行为变化而影响核心架构。

## 包结构（2026-07 优化之前的旧稿，仅作历史参考）

> 下面这棵树描述的是 2026-07 职责优化之前的设想，里面的 `breakdown.py`、`generate.py`、
> `skills/workbuddy_shortdrama.py` 等文件在仓里都不存在。**现役结构以本文开头的
> 「优化后的包结构」为准**，这一节保留是为了让读旧文档的人知道当时怎么想的。

```text
shortdrama-cli/
  pyproject.toml
  README.md
  ARCHITECTURE.md
  src/shortdrama_cli/
    __init__.py
    main.py

    skills/
      workbuddy_shortdrama.py

    cli/
      app.py
      breakdown.py
      generate.py
      pipeline.py

    agents/
      base.py
      script_breakdown.py
      character_breakdown.py
      storyboard_breakdown.py
      planner.py
      runner.py

    use_cases/
      image_generation.py
      video_generation.py

    service_clients/
      script_service.py
      asset_service.py
      image_generation_service.py
      video_generation_service.py

    gateways/
      auth.py
      script_api.py
      asset_api.py
      image_generation_api.py
      video_generation_api.py
      agentkit_api.py

    repositories/
      run_snapshot_repository.py
      output_snapshot_repository.py
      local_index_repository.py

    providers/
      base.py
      mock.py
      openai.py
      volcengine.py
      agentkit.py

    domain/
      script.py
      character.py
      storyboard.py
      generation.py
      run.py

    storage/
      workspace.py
      artifacts.py
      manifest.py

    prompts/
      script_breakdown.md
      character_breakdown.md
      storyboard_breakdown.md
      image_prompt.md
      video_prompt.md

    schemas/
      script_breakdown.py
      character_breakdown.py
      storyboard_breakdown.py
      generation.py

  tests/
    fixtures/
      sample_script.md
    test_cli_breakdown.py
    test_cli_generate.py
    test_pipeline.py
```

## Agent 边界

业务 Agent 暴露稳定的工作流级能力：

```python
class Agent:
    """shortdrama-cli 拥有的业务执行单元。"""

    def run(self, input, context):
        """产出经过校验的结构化结果和产物元数据。"""
```

示例：

- `ScriptBreakdownAgent`：把剧本拆成集、场、剧情节拍、台词引用等结构。
- `CharacterBreakdownAgent`：提取角色档案、人物关系、外观、声音和连续性备注。
- `StoryboardBreakdownAgent`：把剧本或场次拆成镜头、景别、机位运动、时长和视觉提示词。

Agent 不应该知道 provider 专属请求体、鉴权细节、网络重试策略或 SDK 对象类型。

图片生成和视频生成在 CLI 内部不命名为 `ImageAgent` / `VideoAgent`，也不直接触碰 provider。它们作为 orchestration use case / service client 组合存在：

- `ImageGenerationUseCase`：编排 CLI 参数、运行快照和 image generation service client。
- `VideoGenerationUseCase`：编排 CLI 参数、运行快照和 video generation service client。
- `ImageGenerationServiceClient`：提交图片生成请求、查询生成状态、读取媒体产物。
- `VideoGenerationServiceClient`：提交视频生成请求、查询生成状态、读取媒体产物。

Service client 通过 `gateways/` 访问受权限控制的在线业务 API。如果图片或视频生成需要提示词编排、知识检索、参考素材选择等智能步骤，这些能力由在线业务 API 或 **AgentKit Agent** 承担；CLI 只负责 orchestration、状态追踪和本地快照。

## Gateway / Repository 边界

Gateway 负责访问受权限控制的在线业务 API：

```python
class ImageGenerationGateway:
    def submit(self, request):
        ...

    def get_result(self, task_id: str):
        ...

class AssetGateway:
    def create_asset(self, media):
        ...
```

Repository 只负责本地快照和索引：

```python
class RunSnapshotRepository:
    def save(self, snapshot):
        ...

    def load(self, run_id: str):
        ...
```

边界规则：

- `gateways/` 可以访问在线业务 API，并必须遵守鉴权、项目身份、权限边界和审计要求。
- `repositories/` 不访问在线业务 API；它只读写 `run-manifest.json`、输出 JSON 和本地索引。
- `providers/` 只用于本地 mock、开发替身或低层适配，不作为生产业务入口。
- CLI 不直接调用图片、视频或 AgentKit provider；生产路径必须经过 service client -> gateway -> 在线业务 API。

## Provider 边界

Provider 只作为本地开发和测试替身，不是生产业务主路径。

剧本拆解、角色拆解和分镜拆解在业务层都由 **业务 Agent** 承担；底层执行来源由 **拆解 Provider** 决定。默认演进路径：

```text
mock -> local_llm -> agentkit
```

- `mock`：用于 contract tests、离线开发和演示。
- `local_llm`：开发和质量验证阶段直连 LLM API，快速迭代 prompt、schema 和拆解质量。
- `agentkit`：仅作为本地开发替身或在线业务 API 背后的平台能力，不由 CLI 生产路径直接调用。

不要把 **业务 Agent** 直接等同于 **AgentKit Agent**。AgentKit 是在线业务 API 背后的平台能力之一，不是 CLI 的业务边界。

## CLI 命令

CLI 命令是 skill 和人工调试共用的执行入口。WorkBuddy 场景下，调用链应是：

```text
WorkBuddy
  -> WorkBuddy Skill
  -> shortdrama-cli command
  -> CLI command handler
  -> orchestrator / use case
  -> service client
  -> gateway
  -> online business API
```

WorkBuddy 自身不直接编排 `shortdrama-cli`；编排逻辑放在安装到 WorkBuddy 的 skill 中。

第一版命令面：

```bash
shortdrama-cli breakdown script --input script.md --out runs/ep01
shortdrama-cli breakdown characters --input script.md --out runs/ep01
shortdrama-cli breakdown storyboard --input script.md --out runs/ep01

shortdrama-cli generate image --prompt prompt.txt --out runs/ep01
shortdrama-cli generate video --prompt prompt.txt --duration 5 --out runs/ep01

shortdrama-cli pipeline run --input script.md --out runs/ep01 --provider mock
```

命令处理层应该保持很薄：只解析参数、创建 run context、调用 orchestration use case，并把错误映射为退出码。

## Pipeline 模型

`PipelineRunner` / Orchestrator 把用户目标转成有序任务：

```text
ScriptInput
  -> ScriptBreakdownTask
  -> CharacterBreakdownTask
  -> StoryboardBreakdownTask
  -> ImageGenerationTask[]
  -> VideoGenerationTask[]
  -> ExportArtifactsTask
```

每个任务都先写出结构化结果，再进入下一个任务。这样流水线可以恢复、调试和局部重跑。

## 运行目录

每次运行写入一个独立输出目录：

```text
runs/ep01/
  input/
    script.md
  output/
    script-breakdown.json
    characters.json
    storyboard.json
    images.json
    videos.json
  assets/
    images/
    videos/
  logs/
    agent.log
  run-manifest.json
```

`run-manifest.json` 是单次 CLI 运行的快照文件，记录：

- run id
- 执行模式
- 输入文件
- 任务状态
- 产物路径
- 错误信息
- 重试或恢复元数据

`run-manifest.json` 同时保存当前状态和关键事件历史：

- `tasks[]`：保存每个任务的当前状态，供 `status`、`resume` 和人工排查使用。
- `events[]`：追加记录关键事件，例如 submitted、polling、timeout、resumed、succeeded、failed。

这里不采用完整 event sourcing；`events[]` 只作为轻量审计与恢复辅助。

重要边界：

- `run-manifest.json` 和各类输出 JSON 是运行快照，不是业务主数据源。
- 剧本、资产、生成任务、媒体产物等主数据归在线业务 API 所有。
- CLI 可以缓存、导出、重放和调试快照，但不能把快照当作线上状态的权威来源。

## 数据契约

所有 Agent 输出都必须通过本地 schema 校验后再写入产物。

第一版最小契约：

- `ScriptBreakdown`：项目标题、集、场、剧情节拍、台词引用。
- `CharacterBreakdown`：角色 id、姓名、角色定位、外观、声音、人物关系、连续性备注。
- `Storyboard`：场次 id、镜头 id、镜头类型、景别、机位运动、视觉提示词、时长。
- `ImageGenerationRequest`：提示词、参考素材、画幅比例、风格控制、seed。
- `VideoGenerationRequest`：提示词、参考图片或视频、时长、画幅比例、运动控制。
- `Artifact`：id、类型、本地路径或远程 uri、来源任务 id、元数据。

## 安全与隔离

默认执行模式是 `mock`。

真实在线业务 API 必须通过 CLI 参数或配置显式启用：

```bash
shortdrama-cli create image --project proj_abc123 --scene-id 3 --wait --json
```

mock 模式不能要求任何凭证。在线 API 配置应该从环境变量或本地配置文件读取，且不能提交到仓库。

## 第一阶段里程碑

第一阶段先用 mock gateways / repositories 验证架构，不接真实在线服务：

```bash
shortdrama-cli pipeline run --provider mock --input tests/fixtures/sample_script.md --out runs/mock-ep01
```

完成标准：

- 生成剧本拆解 JSON。
- 生成角色拆解 JSON。
- 生成分镜 JSON。
- 生成 mock 图片产物记录。
- 生成 mock 视频产物记录。
- 生成 `run-manifest.json`。
- 有 CLI contract tests 覆盖命令行为和输出文件。
