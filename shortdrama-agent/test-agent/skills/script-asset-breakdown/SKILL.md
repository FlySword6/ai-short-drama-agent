---
name: script-asset-breakdown
description: |
  将漫剧/短剧文本拆解为结构化制作资产，支持剧本拆解、分镜拆解、道具任务场景拆解。
  当请求包含足够的项目/镜头上下文，或用户明确要求入库时，必须调用 MCP tools：
  listProjects/createProject、lookupProjectShotId/createProjectShot、ingestStoryboardDecomposition。
  当用户要求创建图片/生图任务时，必须调用 createShotImage/listShotImages/refreshShotImage。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - "mcp*:*"
  - "MCP*:*"
  - "server-api*:*"
  - "ServerAPI*:*"
  - "listProjects"
  - "createProject"
  - "lookupProjectShotId"
  - "createProjectShot"
  - "ingestStoryboardDecomposition"
  - "listProjectPrompts"
  - "createProjectPrompt"
  - "createShotImage"
  - "listShotImages"
  - "refreshShotImage"
metadata:
  short-description: 将剧本文本拆成角色、场景、道具与分镜资产，并可直接入库分镜系统
---

# 剧本资产拆解助手

将用户提供的剧本、梗概、对白、分场内容拆解成可直接用于制作的结构化 JSON；当请求包含足够的项目/镜头上下文，或用户明确要求“入库 / 同步 / 保存分镜资产”时，要先用项目主表工具准备真实 `project_id`，再用镜头主表工具准备每个 `project_shot_id`，最后调用 `ingestStoryboardDecomposition` 持久化资产与分镜。若用户继续要求“生成图片 / 创建生图任务 / 资产生图”，必须使用真实 `project_id` 调用 `createShotImage` 创建图片生成任务，再用 `listShotImages` 和必要时 `refreshShotImage` 检查任务状态。当前 MCP OpenAPI 已提供 `listProjects` / `createProject`、`lookupProjectShotId` / `createProjectShot`、`createShotImage` / `listShotImages` / `refreshShotImage`。

## MCP 工具要求

本 skill 必须能调用后端 MCP tools 才能完成入库。若运行时没有提供以下任一工具，不要输出“已入库”，必须直接返回缺失工具错误：

- `listProjects`
- `createProject`
- `lookupProjectShotId`
- `createProjectShot`
- `ingestStoryboardDecomposition`
- 生图相关：`listProjectPrompts`、`createProjectPrompt`、`createShotImage`、`listShotImages`、`refreshShotImage`

调用工具时优先使用宿主暴露的精确工具名；如果宿主为 MCP 工具添加了命名空间前缀，使用实际可见的完整工具名，例如 `server-api:listProjects` 或 `mcp__server_api__listProjects`。

## 触发条件

- 剧本拆解 / 资产拆解 / 角色、场景、道具抽取
- 分镜拆解 / 镜头拆解 / `video_prompt` / 视频生成提示词
- 道具任务拆解 / 场景任务拆解 / 道具与场景制作清单
- 分镜资产入库 / `storyboard_ingestions` / `ingestStoryboardDecomposition`
- 创建生图任务 / 资产生图 / 图片生成 / `createShotImage` / `listShotImages` / `refreshShotImage`

## 工作流

1. 先判断任务模式：
   - `script_breakdown`：输出角色、场景、道具、分镜全量结果
   - `storyboard_breakdown`：只输出分镜结果
   - `prop_scene_task_breakdown`：只输出道具/场景制作任务结果
2. 如果用户提供了角色、场景、道具实体池，必须严格复用这些名称，禁止新增实体名。
3. 按 [reference.md](references/reference.md) 的规则拆解。
4. 若当前模式是 `script_breakdown` 或 `storyboard_breakdown`，并且满足以下任一条件，则视为“需要入库”：
   - 用户明确要求入库、同步、保存、落库
   - 请求中已经提供 `project_name`
   - 请求中已经提供 `project_id`
   - 请求中已经提供 `project_shot_id`，或提供了从 `shot_no` 到 `project_shot_id` 的完整映射
5. 需要入库时，优先按“面向用户的业务字段”收集上下文：
   - 优先向用户索要 `project_name`
   - 若项目下存在多集或多镜头歧义，再索要 `episode_no` 与 `shot_no`
   - 不要默认向普通用户索要 `project_id`、`project_shot_id` 这类后端 UUID
   - 若运行时、宿主应用或上游系统已经注入了真实 `project_id` / `project_shot_id`，直接复用
   - 若未注入真实 `project_id`，则按以下顺序准备：
     1. 优先调用 `listProjects(project_name, limit=2)` 查询项目主表
     2. 若命中唯一项目，使用返回行中的真实 `id` / `project_id`
     3. 若未命中，调用 `createProject`，请求体至少包含 `project_name`，可附带 `status` 与 `metadata`
     4. 创建后优先使用返回对象中的 `id` / `project_id`；若返回体未明确给出 ID，则再次调用 `listProjects(project_name, limit=2)` 获取真实 ID
   - 若项目查询命中多个结果，应继续向用户确认项目名称，不要随机选择
   - 若未注入真实 `project_shot_id`，则对每个待入库镜头按以下顺序准备：
     1. 调用 `lookupProjectShotId(project_id, episode_no, shot_no)` 查询镜头主表中的真实 `project_shot_id`
     2. 若未命中，调用 `createProjectShot`，请求体包含 `project_id`、`episode_no`、`shot_no`，可附带 `shot_name`、`status` 与 `metadata`
     3. 创建后优先使用返回对象中的 `id` / `project_shot_id`；若返回体未明确给出 ID，则再次调用 `lookupProjectShotId(project_id, episode_no, shot_no)` 获取真实 ID
   - `createProjectPrompt` 和 `createProjectShotGeneration` 不是项目/镜头主数据创建工具，不用于准备 `project_id` / `project_shot_id`
6. 最终输出必须严格匹配 [schemas.json](references/schemas.json) 根 schema，只返回 JSON，不要解释，不要 Markdown。
7. 当具备入库所需上下文时：
   - 先完成 `project_id` 和全部 `project_shot_id` 的 lookup
   - 再在输出 JSON 中构造 `storyboard_ingestion_request`
   - 然后调用 MCP tool `ingestStoryboardDecomposition`，参数必须与 `storyboard_ingestion_request` 完全一致
   - 若工具调用成功，最终仍只返回符合 schema 的 JSON，不在 JSON 外补充说明
   - 若工具不可用或返回错误，直接返回简洁错误信息，不要谎称已入库
8. 当用户明确要求“创建图片 / 生图 / 生成资产图”时：
   - 先确保已具备真实 `project_id`；未提供时按 `listProjects` / `createProject` 流程准备
   - 先调用 `listProjectPrompts(project_id, limit=200)` 检查项目下是否已有资产提示词；如用户限定资产类型，再加 `prompt_type`
   - 如果本轮刚完成入库，优先根据 `ingestStoryboardDecomposition` 返回结果中的项目提示词 ID 组装 `projectPromptIds`
   - 如果 `listProjectPrompts` 没有返回任何资产提示词，不要直接调用 `createShotImage`；应先确认 `storyboard_ingestion_request.assets` 已包含角色/场景/道具资产提示词，并通过 `ingestStoryboardDecomposition` 持久化，或对缺失资产调用 `createProjectPrompt` 创建项目资产提示词
   - 只有在拿到项目提示词后，才用真实 `projectPromptIds` 或已确认存在的 `promptTypes` 创建生图任务
   - 构造 `shot_image_generation_request`，字段必须使用 OpenAPI 的驼峰命名：`projectId`、`projectName`、`projectPromptIds`、`promptTypes`、`overwrite`、`model`、`size`、`n`、`resolution`、`generationParams`、`createdBy`、`metadata`
   - 调用 MCP tool `createShotImage`，参数必须与 `shot_image_generation_request` 完全一致
   - 若 `createShotImage` 返回 `asset_prompts_not_found`，表示没有项目资产提示词匹配本次请求；不要重试同一个 payload，应先 `listProjectPrompts`，再创建或入库项目提示词后重试
   - 创建后调用 `listShotImages(projectId, limit=50, offset=0)` 检查任务；如果需要刷新单个任务，使用返回行里的真实 `image_generation_id` 调用 `refreshShotImage`
   - `createProjectShotGeneration` 不是图片生图任务创建工具；不要用它替代 `createShotImage`

## 关键约束

- 有台词必须保留原文，不可改写、概括或意译。
- 分镜必须按剧情顺序输出，`shot_no` 从 1 开始连续递增。
- 同一物理场景、同一时间段、同一环境状态的连续镜头必须复用同一个 `scene_continuity_key`，并保持 `scene_anchor` 一致。
- `video_prompt` 必须是可直接用于生成视频的自然中文提示词；若包含实体，必须使用 `[@名称]` 引用。
- 若用户未提供足够文本，本轮不要进入 JSON 输出模式；直接用一句话索要剧本正文、梗概或分场文本。
- 若用户未要求入库，且当前也没有足够的项目上下文，可以只返回拆解 JSON，不强制包含 `storyboard_ingestion_request`。
- 面向普通用户时，优先使用 `project_name`、`episode_no`、`shot_no` 交流；`project_id`、`project_shot_id` 属于系统内部参数，不应默认让用户手填。
- 当未显式提供 `project_id` 时，先用 `listProjects(project_name)` 查询，未命中再用 `createProject` 创建。
- 当未显式提供 `project_shot_id` 时，先用 `lookupProjectShotId(project_id, episode_no, shot_no)` 查询，未命中再用 `createProjectShot` 创建。
- `createProjectPrompt` 只创建资产提示词记录，不能替代 `createProject`；但当生图前缺少资产提示词时，可用它创建 `prompt_type` 为角色/场景/道具类别、`prompt_text` 为资产提示词的项目提示词。
- `createProjectShotGeneration` 只创建镜头生成记录，不能替代 `createProjectShot`。
- `createShotImage` 才是项目资产图片生成任务创建工具，路径为 `POST /api/projects/shot-images`，请求体必填 `projectId`。
- `createShotImage` 使用 OpenAPI 驼峰字段；不要把 `projectId` 写成 `project_id`，也不要传 `project_shot_id`、`prompt_text`、`generation_type` 这类分镜入库字段。
- 调用 `createShotImage` 前必须先确认存在项目资产提示词；`asset_prompts_not_found` 表示匹配不到 project prompt，不是图片模型问题。
- `projectPromptIds` 只能使用后端返回的真实项目提示词 ID；拿不到真实 ID 时，可以用已确认存在的 `promptTypes` 限定资产类型，或省略让接口按项目全部资产提示词创建。
- `listShotImages` 查询参数使用 `projectId`、`projectPromptId`、`promptType`、`status`、`apimartTaskId`、`limit`、`offset`。
- `refreshShotImage` 的路径参数是返回行中的真实 `image_generation_id`，不是 `project_id`、`project_shot_id` 或 APIMart task id。
- `storyboard_ingestion_request.shots[*].project_shot_id` 必须是真实后端 ID，不能用 `shot_${project_name}_${shot_no}` 或其他自造占位值。
- 一旦输出 `storyboard_ingestion_request`，字段名必须严格对齐 MCP tool 入口参数：
  - 顶层：`project_id`、`project_name`、`episode_no`、`user_id`、`user_name`、`created_by`、`decomposition_run_id`、`assets`、`shots`、`metadata`
  - 资产：`asset_key`、`asset_name`、`shot_no`、`prompt_text`、`negative_prompt`、`model_name`、`status`、`metadata`
  - 分镜：`project_shot_id`、`shot_no`、`parent_generation_id`、`revision_no`、`revision_reason`、`prompt_text`、`negative_prompt`、`input_image_urls`、`input_reference_urls`、`input_storyboard_urls`、`generation_params`、`status`、`metadata`、`generation_type`、`created_by`、`asset_keys`
- 一旦输出 `shot_image_generation_request`，字段名必须严格对齐 MCP tool `createShotImage` 的入口参数：
  - `projectId`、`projectName`、`projectPromptIds`、`promptTypes`、`overwrite`、`model`、`size`、`n`、`resolution`、`generationParams`、`createdBy`、`metadata`
- `storyboards[*].video_prompt` 应作为 `storyboard_ingestion_request.shots[*].prompt_text` 的首选来源。
- `storyboard_ingestion_request.shots[*].asset_keys` 必须引用当前输出里实际生成的资产 key；不要引用不存在的资产。
- `prop_scene_task_breakdown` 模式不调用 `ingestStoryboardDecomposition`，除非用户另行明确要求你把任务单映射到其他外部系统。
