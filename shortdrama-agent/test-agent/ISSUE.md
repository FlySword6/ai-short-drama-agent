---
type: ops-note
title: AgentKit 使用已知问题与规避说明
status: active
owner: zw-sd-zhaochenyi
updated: 2026-07-02 (新增问题八、九)
source_quality: team_observed
routes:
  - agentkit
  - infra
  - ops
citations:
  - https://www.volcengine.com/docs/86681/2155817
---

# AgentKit 使用已知问题与规避说明

> 记录团队在使用火山引擎 AgentKit（智能工坊）过程中遇到的已知问题、限制与临时规避方法。  
> 更新时间：2026-07-01 | 来源：团队实际使用反馈

---

## 问题一：veADK 版本只能手动更新

**现象**  
AgentKit 目前不支持 veADK 版本的自动升级，需要手动更新。

**完整部署流程（veADK + AgentKit 创建 Agent + 部署）**  
官方文档：https://www.volcengine.com/docs/86681/2155817

核心步骤概览：

1. 安装 `uv` 工具并创建虚拟环境
2. `uv pip install -U veadk-python` 安装/更新 VeADK
3. `veadk create` 生成 Agent 项目模板
4. 编写 `agent.py`（配置记忆、知识库、工具等组件）
5. 配置 `.env` 环境变量（AK/SK、各组件参数）
6. 本地调试：`veadk web` → 浏览器访问 http://127.0.0.1:8000
7. 初始化部署项目：`agentkit init --from-agent ./agent.py`
8. 发布：`agentkit launch`
9. 登录 AgentKit 控制台，复制镜像地址
10. **手动**进入 Agent 运行时详情页面，更新镜像地址完成版本升级

**注意**  
每次 veADK 有新版本，步骤 2 更新依赖后，必须重新走步骤 7-10，手动将新镜像地址更新到运行时详情页。目前没有自动同步机制。

---

## 问题二：智能工坊「创建 Skill」功能不稳定，经常无产出物

**现象**  
在 AgentKit 智能工坊页面，通过「Skill」标签页输入描述或上传参考文件创建 Skill 时，经常没有产出物，界面无明确报错。

**截图参考**  
AgentKit 智能工坊 → Skill 创建入口（界面上方有 Skill / Agent 切换 Tab）

**当前状态**  
已知平台侧问题，暂无官方修复时间表。

**规避方法**

- 不依赖智能工坊自动生成 Skill，改为手动编写 Skill 代码
- 可参考官方 [agentkit-samples](https://github.com/volcengine/agentkit-samples) 示例手工构建

---

## 问题三：Agent 集成 Skills 仅支持华北 2（北京）地域

**现象**  
在 Agent 代码中集成 AgentKit Skills 空间中的 Skill 时，**当前仅华北 2（北京）地域支持该功能**。

**官方文档注意说明**

> 本文以 VeADK 为例，展示如何在 Agent 代码中集成 Skills 空间中的 Skill。  
> **注意：当前仅华北 2（北京）地域支持该功能。**

**影响**  
若 Agent 运行时部署在其他地域（如华东、华南），则无法使用 Skills 集成功能。

**规避方法**  
确保 Agent 运行时创建在 **华北 2（北京）** 地域。

---

## 问题四：批量上传评测集偶发「系统错误」

**现象**  
在评测集页面批量上传数据时，偶尔出现执行失败弹窗：

```
执行结果
成功 2 条，失败 24 条

存在以下原因导致执行失败，请自行纠正后重试
• 系统错误
```

弹窗仅显示"系统错误"，无具体原因说明。

**当前状态**  
已知平台侧偶发问题，无其他提示信息。

**规避方法**

- 点击「已知晓」关闭弹窗后重试
- 如多次失败，减少单批上传数量后再试
- 仍失败则提工单（参见问题七获取 ID 方法）

---

## 问题五：记忆库选型

**结论**  
**使用 Viking 类型记忆库，暂时不要用 Mem0。**

**说明**

- Viking 类型稳定性更好，与团队当前 Agent 架构兼容
- Mem0 类型当前存在不稳定情况，团队暂不使用

**代码示例**

```python
# 使用 Viking 作为长期记忆（推荐）
long_term_memory = LongTermMemory(backend="viking", index=memory_name)

# Mem0 暂时不用
# long_term_memory = LongTermMemory(backend="mem0", ...)
```

---

## 问题六：MCP 工具集添加工具时报「内部错误」

**现象**  
在 AgentKit MCP 工具集（Toolset）详情页点击「添加工具」，选择 MCP 服务并尝试加载工具列表时，出现错误提示：

```
错误提示
内部错误。

logid: 20260630163007FC6FA6DBF385ACDDC14
service: agentkit
error: 内部错误，请重试。如果多次尝试失败，请提交工单。
```

**截图说明**

- 「添加工具」面板左侧可正常搜索/选择 MCP 服务（如 `asset_mcp_service`、`mcp_service_3mcke6d0` 等）
- 右侧工具列表加载时触发内部错误，工具无法展示或添加

**当前状态**  
已知平台侧问题。错误信息中包含 `logid`，可用于提工单时辅助定位。

**规避方法**

1. 刷新页面重试
2. 多次失败后，复制「复制详情」中的完整错误信息（含 logid）提交工单

---

## 问题七：评测集执行失败提工单时，页面无 ID 显示

**现象**  
评测集详情页面**不直接显示评测集 ID 和空间 ID**，提工单时需要这两个值。

**获取方法**

**方法 A：从 URL 获取**  
在评测集详情页的浏览器地址栏中，ID 通常在 URL 最后的参数中：

```
https://console.volcengine.com/agentkit/.../evaluation/<评测集ID>?workspaceId=<空间ID>
```

**方法 B：通过开发者工具（F12）获取**

1. 打开评测集详情页
2. 按 `F12` 打开浏览器开发者工具
3. 切换到「Network」标签 → 筛选「Fetch/XHR」
4. 找到请求名含 `ListEvaluationSetItems` 或 `GetOpeningRecommend` 的请求
5. 点击该请求 → 查看「Response」标签
6. 在响应 JSON 中找到：
   ```json
   {
     "Id": "75901052909641730S8",
     "WorkspaceId": "75900993165235297S0"
   }
   ```

**截图说明**  
开发者工具 Network 面板的 Response 区域，高亮标注了 `Id` 和 `WorkspaceId` 字段位置。

---

## 问题八：Agent 集成 Skills 调用报 FileNotFoundError

**现象**
使用 Agent 集成 skills 时，无法正常调用 skill，报错如下：

```json
{
  "id": "call_ogd0hq74z2hi0beg8ucnzo7x",
  "name": "execute_skills",
  "response": {
    "result": "Execution failed: Code execution error, FileNotFoundError"
  }
}
```

**当前状态**
已知问题，正在排查中。

**规避方法**
暂无有效规避方法，建议提工单跟进。

---

## 问题九：Agent 集成 MCP 工具集调用报错

**现象**
使用 Agent 集成 MCP 工具集，工具集内的 MCP tool 无法正常调用，报错如下：

```json
{
  "id": "call_rfhvirnkxgbasu8cami93exp",
  "name": "viking-ingest-mcp_ingest_to_viking_kb",
  "response": {
    "content": [
      {
        "type": "text",
        "text": "expected exactly one server, got 0"
      }
    ],
    "isError": true
  }
}
```

**当前状态**
已知问题，正在排查中。

**规避方法**
暂无有效规避方法，建议提工单跟进。

---

## 汇总速查表

| #   | 问题                              | 严重程度 | 状态     | 规避方法                    |
| --- | --------------------------------- | -------- | -------- | --------------------------- |
| 1   | veADK 版本只能手动更新            | 低       | 已知限制 | 手动更新镜像到运行时详情页  |
| 2   | 智能工坊创建 Skill 无产出物       | 中       | 已知 Bug | 改为手动编写 Skill 代码     |
| 3   | Skills 集成仅支持华北 2 地域      | 中       | 已知限制 | Agent 运行时部署在华北 2    |
| 4   | 批量上传评测集偶发系统错误        | 低       | 已知 Bug | 重试或减少批量大小          |
| 5   | 记忆库选型                        | —        | 团队决策 | 用 Viking，暂不用 Mem0      |
| 6   | MCP 工具集添加工具报内部错误      | 中       | 已知 Bug | 重试 + 提工单（附 logid）   |
| 7   | 评测集提工单时无 ID 显示          | 低       | 已知缺陷 | F12 Network 或 URL 末尾获取 |
| 8   | Agent 集成 Skills 报 FileNotFound | 高       | 已知 Bug | 提工单跟进                  |
| 9   | Agent 集成 MCP 工具集无法调用     | 高       | 已知 Bug | 提工单跟进                  |

---

_本文档由团队使用过程中持续归纳，发现新问题请在此补充。_
