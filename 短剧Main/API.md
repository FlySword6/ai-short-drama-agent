# 中文短剧 RAG 入库 API

这是 `zhongwen-shortdrama-main` 的接口契约文件，供 Dashboard、CLI 和 Agent 调用方对接。服务默认监听 `http://127.0.0.1:8000`，在线 OpenAPI 页面为 `/docs`。

## 通用约定

- API 前缀：`/api/v1`
- 成功响应：JSON
- 参数校验或业务错误：HTTP `4xx/5xx`，响应格式为 `{ "detail": ... }`
- 所有时间字段和耗时字段由服务端生成
- `.env`、数据库密码、模型密钥等敏感配置不属于接口参数，也不应提交到仓库

## 1. 健康检查

```http
GET /api/v1/health
```

响应示例：

```json
{
  "status": "ok",
  "app_name": "Shortdrama Agent",
  "version": "0.2.1",
  "sha": "c28feea8a35ad9299fe811568cd91a95713e1e5c"
}
```

`sha` 是构建该镜像的 git commit，用来回答"线上跑的是哪个提交"。它由 Dockerfile 的
`GIT_SHA` 构建参数注入，不是配置项：没注入时返回 `"unknown"`，而不是留空或省略字段。
本端点未鉴权公开，因此只放制品身份，不放主机名、分支名等运行环境信息。

## 2. 统一上传并入库

```http
POST /api/v1/asset-ingest/upload
Content-Type: multipart/form-data
```

表单字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `file` | 是 | `.xlsx` / `.xlsm`，或 `.jpg` / `.jpeg` / `.png` / `.webp` / `.bmp` |
| `source_project_name` | 否 | 项目名；不传时由文件名推断 |
| `batch_size` | 否 | Excel 每批模型调用行数，整数 `1-20`，默认 `5`；图片上传忽略 |
| `asset_kind_hint` | 否 | 图片视觉识别的资产类型提示 |

Excel 响应：

```json
{
  "mode": "excel",
  "count": 1,
  "items": [],
  "uploaded_file_path": "runtime/uploads/example.xlsx",
  "uploaded_file_deleted": true
}
```

图片响应：

```json
{
  "mode": "image",
  "count": 1,
  "items": [],
  "uploaded_file_path": null,
  "uploaded_file_deleted": false
}
```

图片入库完成后，向量同步会在后台任务中执行，避免上传接口一直等待 Milvus 和 embedding 服务。

## 3. Excel 专用上传

```http
POST /api/v1/asset-ingest/excel/upload
Content-Type: multipart/form-data
```

字段与统一上传接口相同，但 `file` 只接受 `.xlsx` / `.xlsm`。该接口用于兼容只处理 Excel 的旧调用方，推荐新调用方使用统一上传接口。

## 4. JSON 资产批量入库

```http
POST /api/v1/asset-ingest/json/assets
Content-Type: application/json
```

请求体：

```json
{
  "source_project_id": "00000000-0000-0000-0000-000000000000",
  "source_project_name": "天尊",
  "assets": [
    {
      "asset_kind": "character",
      "name": "叶逍遥",
      "display_name": "叶逍遥",
      "intro": "男主，天资卓绝，性格坚韧。",
      "appearance": "青年男性，五官清俊，气质沉稳。",
      "age_value": 20,
      "gender": "男",
      "height_cm": 180,
      "hair_description": "黑色长发",
      "outfit_description": "青色古装",
      "category": "角色",
      "style_tags": ["古装", "仙侠"],
      "approved": true,
      "reuse_scope": "needs_review",
      "status": "pending_review",
      "source_file_url": "https://example.com/ye-xiaoyao.png",
      "metadata": {
        "source": "external_json"
      }
    }
  ]
}
```

约束：

- `assets` 必须是非空数组；每个资产至少需要 `asset_kind` 和 `name`
- `style_tags` 默认 `[]`
- `metadata` 默认 `{}`
- `reuse_scope` 默认 `needs_review`
- `status` 默认 `pending_review`
- `source_project_id` 传入后优先使用已有项目；否则使用 `source_project_name` 查找或创建项目

响应：

```json
{
  "count": 1,
  "items": []
}
```

## 5. 资产语义检索

```http
POST /api/v1/asset-search/semantic
Content-Type: application/json
```

请求体：

```json
{
  "query": "老奸巨猾的某市龙头",
  "limit": 5
}
```

字段约束：

- `query`：必填，非空字符串
- `limit`：可选，整数 `1-50`，默认 `10`

响应：

```json
{
  "count": 1,
  "items": [
    {
      "score": 0.91,
      "source_table": "asset_entities",
      "source_id": "asset-id",
      "asset_kind": "character",
      "name": "角色名",
      "display_name": "角色展示名",
      "parent_entity_id": null,
      "parent_entity_name": null,
      "intro": "简介",
      "appearance": "外观",
      "description": null,
      "usage_context": null,
      "visual_prompt": null,
      "source_file_url": null,
      "metadata": {},
      "vector_text": "用于生成向量的文本"
    }
  ]
}
```

## 6. 抽卡任务

抽卡任务是一件缺失参考的工单：这一镜（或这一场）缺哪件资产、要什么样子、派给谁去做。
当前只支持开单、列单、看单、改单；领单、交单、验收的状态转换尚未开放。

```http
POST /api/v1/projects/:project_id/casting-tasks
Content-Type: application/json
```

请求体：

```json
{
  "scene_id": "scene-uuid",
  "shot_id": "shot-uuid",
  "lane": "character",
  "title": "镜 5 缺女主转身参考",
  "brief": "要半身、正面、古装造型",
  "assignee_user_id": "user-uuid"
}
```

字段约束：

- `scene_id` / `shot_id`：都可选。场级单只传 `scene_id`，镜级单再加 `shot_id`，两个都不传是挂在项目上的纯补图单。镜头必须属于当前项目；同时传了场时，镜头还必须属于那一场——但镜头本身可以没有场（`shots.scene_id` 可空），这种镜头开单时不传 `scene_id` 即可
- `lane`：必填，取值来自参考栏词表（`reference_lane_vocabulary`）；未知或已停用返回 `422`
- `title`：必填，一句话说明要什么样子；`brief` 可选，详细要求
- `assignee_user_id`：可选，就是一个普通用户 ID，不要求是项目成员——谁被派了抽卡任务谁就是抽卡师，系统里不另设角色；缺省表示待认领。用户不存在返回 `400`
- `target_asset_entity_id` / `target_asset_variant_id`：可选，给已有资产补图/补变体时传；传变体必须同时传所属资产

开单要求项目写权限（所有者或编辑者），成功返回 `201` 与任务实体，初始 `status` 恒为 `open`。

```http
GET /api/v1/projects/:project_id/casting-tasks?status=open&assignee_user_id=<uuid>&shot_id=<uuid>
GET /api/v1/casting-tasks/:id
PATCH /api/v1/casting-tasks/:id
```

- 列表支持 `status` / `assignee_user_id` / `shot_id` 三个过滤条件，可组合
- 读要求项目成员身份；非项目成员返回 `403`
- 改单只接受 `title` / `brief` / `assignee_user_id`（`assignee_user_id` 传 `null` 表示改回待认领），要求项目写权限

## 调用示例

```powershell
curl.exe http://127.0.0.1:8000/api/v1/health

curl.exe -X POST "http://127.0.0.1:8000/api/v1/asset-search/semantic" `
  -H "Content-Type: application/json" `
  -d '{"query":"古装女主","limit":5}'
```

接口实现位于 `src/http/routes.ts`。修改接口后，应同步更新本文件，并运行：

```powershell
npm run typecheck
npm run build
```
