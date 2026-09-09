---
name: shortdrama-cli
description: 使用官方 Python `shortdrama-cli` 操作中文在线短剧生产系统。用于登录业务服务端、创建与管理项目、导入和拆解剧本、管理素材与分镜、生成或编辑图片/视频/音频、轮询和下载任务结果、合成导出。用户明确要求查询、搜索、检索、查找已有资产或索要资产候选时，可使用 `asset search`。用户提到 shortdrama、短剧 CLI、剧本拆解、分镜、生图、生视频、TTS、字幕、渲染、任务进度或短剧生产自动化时使用。只允许调用 `zhongwen-shortdrama-cli` Python 项目的 `shortdrama-cli`/`shortdrama` 命令，绝不调用 `shortdrama-cli-go` 或旧 monolith 中的 CLI。
---

# Shortdrama CLI（`shortdrama-cli`）

把本 skill 作为 Python CLI 的操作地图。子命令和选项以本机
`shortdrama-cli --help`、`shortdrama-cli <命令> --help` 为权威来源；若文档与实际帮助不一致，以实际帮助为准并修订本 skill。

## 硬边界

- 只使用 `zhongwen-shortdrama-cli`（Python 3.11+、Typer、uv）。不要进入或调用 `shortdrama-cli-go`、`zhongwen-shortdrama/shortdrama-cli` 或旧 monolith。
- 所有生产能力只通过业务服务端 API。不要直连数据库、AgentKit、火山引擎或第三方模型 API。
- 不把 token、密码、第三方 API key 写入参数回显、运行产物或配置。优先使用登录 session 或 `SHORTDRAMA_API_TOKEN`。
- 先查看 [能力矩阵](./references/capability-matrix.md)。只调用矩阵中标记为真实 API 的命令。
- 默认对 Agent 调用加 `--json`。业务后端地址由 shortdrama-cli 内置的受信端点清单决定：用 `--env` 或 `SHORTDRAMA_ENV` 选择环境名（prod/test/dev），不接受 URL。
- 删除、归档、取消、重置和修复等操作必须保留 CLI 的 `--yes` 确认门。
- 每次执行 CLI 命令前，先向用户展示即将执行的命令（token/密钥脱敏）；执行后，提取并展示关键返回字段（status、task_id、results[]、result_url 等），不要静默执行或多步连跑后才一次性汇报。

## 运行入口

优先使用已安装命令：

```bash
shortdrama-cli --help
```

在源码仓开发时使用：

```bash
uv run shortdrama-cli --help
```

排查真实业务 API 调用时，可在根命令后加 `--debug`。诊断信息写入标准错误，
只包含请求方法、脱敏 URL、请求字段名、响应状态、耗时和响应顶层字段名；不会输出 token、
密码、剧本、提示词或完整响应正文：

```bash
shortdrama-cli --debug create image --project PROJECT_ID --scene-id SCENE_ID --model "Seedream 5.0 Pro" --json
```

命令不可用时，读取 [安装与更新](./references/install.md)，不要自行猜测包名或下载地址。

## 标准工作流

### 1. 诊断、登录、选项目

```bash
shortdrama-cli doctor --json
shortdrama-cli auth login --username "$SHORTDRAMA_USERNAME" --json
shortdrama-cli auth status --json
shortdrama-cli project list --json
```

用户要求新项目时才创建；已有项目则复用其 `project_id`。详见
[auth/project](./commands/auth-project.md)。

### 2. 导入或拆解剧本

导入前先阅读剧本全文，向用户简要说明内容结构（比如"文件内含3集"或"单篇短篇"），
由用户决定使用哪个导入命令。模型不自行判断形态、不替用户选路径。

生产路径优先使用 `script analyze`，它通过业务服务端创建剧本并触发资产、分镜拆解：

```bash
shortdrama-cli script analyze \
  --project PROJECT_ID \
  --file ./episode.md \
  --wait \
  --json
```

其他可用命令（由用户按需选择）：

| 命令 | 用途 |
|---|---|
| `script import` | 仅导入剧本，不触发拆解 |
| `script import-episodes` | 多集剧本自动拆分为多集记录 |
| `breakdown-assets` | 对已有剧集单独拆解角色、场景、道具 |

剧本生产流程必须通过业务服务端 API 完成。详见
[剧本与云端流程](./commands/script-pipeline.md)。

拆解完成后必须把结果原样展示给用户确认，详见 [剧本与云端流程](./commands/script-pipeline.md) 的「拆解结果展示与确认」。

由用户决定是否充分，不由模型自行判断「缺失」或「不完整」。用户确认前，不进入下一步。

### 3. 提交生成

#### 生成产物确认门（通用）

所有生成类操作（`create image` / `create video` / `create audio`、`script analyze` 拆解结果）完成后：

1. 先把结果展示给用户（图片/视频下载到本地后展示，拆解结果列表展示）；
2. 等待用户明确确认后才继续下一步（入库、生视频、合成等）；
3. 用户不满意时，根据反馈调整参数重新生成，不要自作主张推进。

未经过确认门，不执行后续入库或生成操作。

#### 参数映射

把用户已确认的意图映射为结构化参数；不要偷偷补充剧情、风格、镜头或模型。只有用户要求优化提示词时，才读取
[创作质量门](./references/creative-quality.md)。

生图或生视频前必须先查询服务端当前启用的对应类型模型：

```bash
shortdrama-cli model search \
  --type image \
  --json

shortdrama-cli model search \
  --type video \
  --json
```

把返回的 `matches[]`（至少包含 `modelName`、`model`、`modality`）展示给用户，并等待用户明确选择。生成命令的 `--model` 必须使用所选条目的 `modelName`，不能使用展示名称或自行猜测模型。若用户已指定 `modelName`，仍先查询并确认它存在于对应类型的启用列表中；若列表为空或指定键不存在，停止生成并如实说明。

图生视频如果使用的是用户直接上传的参考素材（图片、音频或视频），先明确询问是否需要入素材库；`asset ingest` 仍以可访问的 HTTPS 素材 URL 为入口。

#### 生图前资产查重（必执行）

批量生成角色/场景图片前，必须先执行资产查重：

1. 查询当前剧集已有的角色资产（通过 `asset search` 或 `scene list`）；若 `asset`/`scene` 命令不可用（mock），则回顾当前 session 内已生成的角色列表；
2. 列出「已有图片的角色」和「缺失图片的角色」两张清单，展示给用户；
3. 只为缺失图片的角色生成，跳过已有的；
4. 用户可手动覆盖（强制重新生成某个角色）。

#### 按需资产检索

`asset search` 是只读的按需能力。**只有用户明确要求查询、搜索、检索、查找已有资产或索要候选时**才调用（生图前查重除外）；创建项目、导入剧本、素材入库、生成图片/视频，或用户仅提到角色、场景、道具名称时，均不得自动检索。若用户只说"复用已有资产"但未要求检索，也不能自行调用，应先询问是否需要查询候选。

确认需要查询后，只使用用户给出的需求作为检索词，不自行扩写剧情、角色设定或视觉要求：

```bash
shortdrama-cli asset search \
  --asset-api-base "$SHORTDRAMA_ASSET_API_BASE" \
  --query "用户描述的角色、场景或道具" \
  --limit 10 \
  --json
```

`asset search` 的返回是候选而不是选择结果。展示 `items[]` 中的 `asset_id`、名称、类型和相关度，并等待用户选定；零命中时如实报告缺口。不要将服务端原始 `metadata`、检索调试信息或本地路径转述给用户。

#### WorkBuddy 图片展示

当检索结果包含有效的 HTTPS `source_file_url` 时，WorkBuddy 必须直接在每个候选下以内联 Markdown 图片展示，格式为：

```markdown
![资产名称](https://cdn.example.com/asset.png)
```

将示例 URL 替换为 CLI 返回的原始 `source_file_url`；不要下载到缓存，不要用 `Read` 读取图片，不要调用 `present_files`，也不要把图片包装为文件卡片或解释渲染失败原因。若 `source_file_url` 缺失或不是可访问的 HTTPS URL，如实标注“无可展示预览图”，不要伪造图片或改用其他地址。

若需要将用户直接上传的素材入库：

1. 用户确认入库后，从生成响应或用户提供的素材中读取真实、可访问的 HTTPS URL；当前不要调用 `asset upload`，它尚未接入真实 API；
2. 仅在拿到真实 URL 后调用 `asset ingest`，并指定对应的 `--type image|audio|video`；没有 URL 时说明当前结果无法自动入库；
3. 轮询或等待到素材状态变成 `active`；
4. 只有在 `active` 之后，才把该参考素材用于后续 `create video`。

```bash
shortdrama-cli create image \
  --project PROJECT_ID \
  --scene-id SCENE_ID \
  --model "Seedream 5.0 Pro" \
  --timeout 600 \
  --wait \
  --json
```

所有 CLI 网络请求与等待操作的默认超时均为 1,200 秒（20 分钟）；任务完成状态应通过任务 ID
轮询，不应将 HTTP 请求超时与任务轮询上限混为一谈。

图生视频时使用已存在的图片 URL/引用：

```bash
shortdrama-cli create video \
  --project PROJECT_ID \
  --scene-id SCENE_ID \
  --image IMAGE_URL \
  --model MODEL_KEY \
  --prompt "用户原始要求" \
  --json
```

详见 [生成与编辑](./commands/create-edit.md)。

若已有公网 HTTPS 图片、视频或音频需要进入素材库，使用真实 API 入库：

```bash
shortdrama-cli asset ingest \
  --url "https://cdn.example.com/characters/hero.png" \
  --name "女主正面" \
  --type image --wait \
  --json
```

`asset ingest` 是异步入库；只有返回的 `status` 为 `active` 才表示审核通过。未使用 `--wait` 时，保留 `task_id` 并运行 `shortdrama-cli asset status TASK_ID --json` 查询；`submitting` 或 `processing` 不能当作完成。

### 4. 轮询、下载、验收

#### 生成产物的本地化展示

图片或视频生成成功后：

1. 将 `result_url` 的内容下载到本地工作目录；
2. 通过当前平台可用的方式把本地文件展示给用户（如在 WorkBuddy 中使用 `present_files`），不要只给 URL 链接；
3. 下载失败时明确告知用户原因，并提供 URL 作为 fallback。

---

若提交响应未到终态，提取 `task_id`，再让 CLI 轮询：

```bash
shortdrama-cli task get TASK_ID \
  --wait \
  --json
```

任务成功后，若真实响应提供结果 URL，直接向用户展示。只有 CLI 明确返回本地路径且文件存在，才能报告本地下载完成。详见
[任务与交付](./commands/task-delivery.md)。

#### 产物入库

每次生成工具（`create image` / `create video` / `create audio`）产出结果并经用户确认后：

1. 主动询问是否将该产物入库（`asset ingest`）；
2. 从生成响应中读取真实 URL；没有 URL 时说明无法自动入库，保存本地文件并告知用户；
3. 入库后等待终态，只有 `active` 才算审核通过（`submitting`/`processing` 只报告处理中，`failed` 报告失败原因）；
4. 视频和音频产物同理，不要只对图片做入库。

注意：当前 `asset ingest` 为 mock 契约，实际入库能力上线前，至少要把产物保存到本地工作目录并记录路径，以便后续手动入库。

### 5. 最终回报

最终只报告可验证内容：

- 项目 ID、剧本 ID、任务 ID；
- CLI 返回的终态；
- 本地文件绝对路径（附原始 URL 作为备用）；
- 图片生成回报必须包含提示词原文和本地文件路径；
- 使用的 API 地址与任务状态；
- 未完成项或当前版本尚未接入真实 API 的能力。

生成过程中不要把 `submitted` 当作 `succeeded`。

## 文档地图

| 主题 | 文件 |
|---|---|
| 安装、源码运行与版本核对 | [references/install.md](./references/install.md) |
| 真实 API 能力矩阵 | [references/capability-matrix.md](./references/capability-matrix.md) |
| 登录、会话与项目 | [commands/auth-project.md](./commands/auth-project.md) |
| 剧本、拆解与本地 pipeline | [commands/script-pipeline.md](./commands/script-pipeline.md) |
| 素材与分镜 | [commands/asset-scene.md](./commands/asset-scene.md) |
| 模型查询与 Schema | [commands/model.md](./commands/model.md) |
| 图片、视频、音频生成与编辑 | [commands/create-edit.md](./commands/create-edit.md) |
| 任务、结果、字幕与渲染交付 | [commands/task-delivery.md](./commands/task-delivery.md) |
| doctor、config、runs | [commands/maintenance.md](./commands/maintenance.md) |
| 云端剧本到生成案例 | [examples/workflows/cloud-script-to-generation.md](./examples/workflows/cloud-script-to-generation.md) |
| 轮询与回报案例 | [examples/workflows/poll-and-report.md](./examples/workflows/poll-and-report.md) |
| 提示词、分镜与剪辑质量门 | [references/creative-quality.md](./references/creative-quality.md) |
| 资料来源与证据边界 | [references/sources.md](./references/sources.md) |
