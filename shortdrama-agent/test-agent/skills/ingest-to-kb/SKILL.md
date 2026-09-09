---
name: ingest-to-kb
description: 将文件导入 AgentKit 知识库。当用户需要入库知识库、上传文件到火山知识库、同步到 AgentKit 知识库时使用此 skill。
---

# 知识库入库助手

调用 MCP 服务 `ingest_to_agentkit_kb_mcp` 将文件导入 AgentKit 知识库。

本项目默认目标知识库必须固定为：

- `kb_id` / `resourceID`：必须由 MCP 服务端环境变量或用户显式提供
- 项目级 VikingDB 配置：`project=shortdrama`，`collection_name=role`

如果 MCP 服务端没有默认 `kb_id` / `resourceID`，不要反复尝试入库；先向用户索要知识库 ID 或要求修复 MCP 服务端配置。

## 触发条件

用户表达以下意图时激活：

- 入库 / 导入 / 上传 / 同步 到知识库
- 提到"火山知识库"或"AgentKit 知识库"

## 执行流程

按以下决策链依次执行：

### 1. 检查文件信息

当前对话中**必须存在**可识别的文件信息，否则终止并回复：

> 我没有看到可入库的文件，请先上传文件或提供可入库的文件信息。

### 2. 确定文件来源（按优先级）

| 优先级 | 来源              | 处理方式                   |
| ------ | ----------------- | -------------------------- |
| 1      | `tos_path`        | 直接入库                   |
| 2      | `file_url`        | 直接入库                   |
| 3      | `file_ref`        | 直接入库                   |
| 4      | `local_file_path` | 需先上传到 TOS（见步骤 3） |

### 3. 上传本地文件（仅当只有 `local_file_path` 时）

1. 调用 `create_tos_upload_credential` 获取上传凭证
2. 使用返回的 `upload_url`、`method`、`upload_headers` 对本地文件执行 HTTP `PUT` 上传
3. 上传成功后，取响应中的 `tos_path`
4. 进入步骤 4

若当前环境**无法读取文件字节或无法执行 HTTP 上传**，终止并回复：

> 我看到了本地文件路径，但当前环境无法直接读取或上传这个文件；请提供可访问文件地址，或让我在可访问该文件的环境里继续执行。

### 4. 调用入库

调用实际可用的入库工具（优先匹配 `viking-ingest-mcp_ingest_to_viking_kb`，或服务端暴露的 `ingest_to_agentkit_kb`），参数规则：

**必传：**

- `file_name` — 文件名
- `kb_id` 或 `resourceID` — 知识库 ID。只有在服务端已确认配置默认知识库时才可省略；否则必须先向用户索要。
- 至少一个文件来源字段（`tos_path` / `file_url` / `file_ref`）

**有则透传：**
`file_size`、`operator`、`tags`、`remark`、`local_file_path`

**若工具 schema 支持以下字段，必须显式传入：**

- `project`: `shortdrama`
- `collection_name`: `role`

**禁止行为：**

- 不要在没有 `kb_id` 且服务端默认知识库未知时调用入库工具。
- 不要把 `"请使用 MCP 服务端默认值或用户提供的知识库 ID"`、`"kb_demo_001"` 等占位文本当作真实 `kb_id` 传入。
- 不要把 `role_mem` 作为入库 collection；它只用于长期记忆。
- 不要在收到 Viking 参数错误后改文件名、重传 TOS 或反复调用同一入库工具。

**若服务端返回缺少 `kb_id`、缺少 `resourceID`、`collection_name or resourceID not found`、或 Viking `code=1000005`，终止并回复：**

> 请告诉我要导入的知识库 ID。

如果用户不知道知识库 ID，则回复：

> 当前 MCP 入库服务没有配置默认知识库，Viking 返回 collection_name/resourceID 不存在。请先在 MCP 服务端配置默认 kb_id/resourceID，或提供要导入的知识库 ID。

### 5. 反馈结果

| 返回 status      | 回复话术                                             |
| ---------------- | ---------------------------------------------------- |
| `processing`     | 已接收文件，正在导入知识库，我拿到结果后会继续反馈。 |
| `failed`         | 直接展示工具返回的 `message`                         |
| `ok` / `success` | 文件已成功提交到知识库。                             |

若失败信息包含 `collection_name or resourceID not found` 或 `VIKING_REQUEST_FAILED`，明确说明这是目标知识库配置问题，不是文件上传或文件格式问题。

## 工具参考

MCP 服务：`ingest_to_agentkit_kb_mcp`

| 工具                                                              | 用途                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `create_tos_upload_credential`                                    | 获取 TOS 上传凭证（`upload_url`、`method`、`upload_headers`） |
| `ingest_to_agentkit_kb` / `viking-ingest-mcp_ingest_to_viking_kb` | 提交文件入库                                                  |

## 调用示例

已确认服务端存在默认知识库时的最小参数：

```json
{
  "file_name": "demo.pdf",
  "tos_path": "your-bucket/agentkit-ingest/req_xxx-demo.pdf",
  "project": "shortdrama",
  "collection_name": "role"
}
```

用户提供真实知识库 ID 时的完整参数：

```json
{
  "file_name": "demo.pdf",
  "file_size": 102400,
  "tos_path": "your-bucket/agentkit-ingest/req_xxx-demo.pdf",
  "kb_id": "<用户提供的真实知识库 ID>",
  "project": "shortdrama",
  "collection_name": "role",
  "operator": "lin.helson",
  "tags": ["产品", "手册"],
  "remark": "来自 WorkBuddy 对话"
}
```
