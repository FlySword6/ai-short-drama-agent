# 漫剧资产管理 Agent

基于火山引擎 AgentKit / VeADK、VikingDB 和官方 Skills Sandbox 构建的漫剧资产管理 Agent。项目面向漫剧资产问答、长期记忆、资产入库、剧本拆解和外部 Skill 编排。

## 核心能力

- **知识库问答**：查询漫剧作品、角色、剧情、资产、标签和运营资料。
- **长期记忆**：使用 VikingDB LTM 保存用户身份、偏好和历史交代事项。
- **资产入库**：将附件或 TOS 资产路由到 MCP/Skill 编排后写入知识库。
- **剧本拆解**：输出角色、场景、道具和分镜结构化结果。
- **A2A / AgentKit 服务**：同时保留 AgentKit AgentServer 入口和 A2A 协议入口。

## 技术栈

| 组件 | 说明 |
| --- | --- |
| Python | 3.12 |
| 包管理 | uv |
| Agent 框架 | veadk-python[extensions] 0.5.40, google-adk 1.32.0 |
| 部署 | agentkit-sdk-python 0.2.0 |
| 协议 | A2A SDK >=0.3.7,<1.0.0 |
| 知识库 | VikingDB collection `role`, project `shortdrama` |
| 记忆库 | VikingDB LTM collection `role_mem` |

## 当前结构

```text
vikingdb/
├── agent.py                         # AgentKit AgentServer 入口
├── agent_a2a.py                     # A2A 协议入口
├── short_drama_agent/
│   ├── agent.py                     # ADK/VeADK Web loader
│   ├── config.py                    # 全局配置和 Agent 指令
│   ├── execute_skills.py            # 官方 Skills Sandbox 接入
│   ├── factory.py                   # root_agent 组装
│   ├── knowledge_assets.py          # 知识库检索、资产上传与入库
│   ├── mcp_safety.py                # MCP 入库安全包装
│   ├── memory.py                    # VikingDB 长期记忆
│   ├── processors.py                # 请求预处理与路由提示注入
│   ├── runtime_patches.py           # ADK/VeADK 运行时兼容补丁
│   ├── script_breakdown.py          # 剧本拆解 Sub-Agent
│   └── tool_diagnostics.py          # 工具挂载诊断
├── skills/
│   ├── ingest-to-kb/                # 知识库入库 Skill
│   └── script-asset-breakdown/      # 剧本/分镜拆解 Skill
├── tests/                           # 单元测试与协议测试
├── check_memory.py                  # 记忆库调试脚本
├── client.py                        # 云端 Agent 调用示例
├── agentkit.example.yaml             # 可提交的无敏感配置参考模板
├── agentkit.yaml                     # 仅本地/受控环境生成，Git 忽略，不能提交
├── requirements.txt                 # Docker/AgentKit 依赖入口
└── pyproject.toml                   # 本地 uv 依赖入口
```

## 本地开发

```bash
uv venv --python 3.12
uv sync
source .venv/bin/activate
```

需要在 `.env` 或运行环境中配置：

```bash
export VOLCENGINE_ACCESS_KEY=<access-key>
export VOLCENGINE_SECRET_KEY=<secret-key>
export DATABASE_VIKING_PROJECT=shortdrama
export DATABASE_VIKING_COLLECTION=role
export DATABASE_VIKINGMEM_COLLECTION=role_mem
export MODEL_AGENT_NAME=doubao-seed-2-0-pro-260215
```

`agentkit.example.yaml` 只用于说明字段。真实 `agentkit.yaml` 必须由凭据负责人在本地或
受控部署环境生成，且永远不能提交；其中的凭据应来自批准的密钥/IAM 机制，而不是写入
仓库文件。

可选外部工具配置：

```bash
export TOOL_MCP_ROUTER_URL=https://<router>/mcp
export TOOL_MCP_ROUTER_API_KEY=<api-key>
export AGENTKIT_TOOL_ID=<skills-sandbox-tool-id>
export SKILL_SPACE_ID=<skill-space-id>
```

## 运行

```bash
# AgentKit AgentServer，默认监听 8000
make run

# VeADK Web 调试
make web

# A2A 协议入口
uv run agent_a2a.py
```

本地安全边界：默认仅绑定 `127.0.0.1`，CORS 仅允许显式的本机 origin；不再提供
`/debug/tools` HTTP 端点。`A2A_HOST`、`AGENT_SERVER_HOST` 以及两个 CORS 环境变量也
只能配置为 loopback 地址。若需要生产访问，必须迁移到认证后的平台后端和受控 Worker，
不能直接部署此 test-agent。

本地兼容端点：

- `GET /.well-known/agent-card.json`：本地 A2A Agent Card。
- `GET /list-apps`、`GET /apps/{app_name}`：本地 AgentKit/ADK 探测兼容端点。

## 测试

```bash
make test
```

在线 OpenAI 兼容性检查默认跳过。如需调用真实服务：

```bash
RUN_REAL_OPENAI_COMPAT=1 \
OPENAI_COMPAT_BASE_URL=https://<endpoint> \
OPENAI_COMPAT_API_KEY=<api-key> \
uv run python -m unittest tests.test_openai_api_compat_online -v
```

## 部署

直接生成或部署此 `test-agent` 已被 `make config`、`make deploy` 和
`agenkit-cloud.sh` 明确阻止。它只能用于本地 loopback 开发；生产访问必须通过认证后
的平台后端和受控 Worker。待 P0 修复、凭据轮换和 staging 验收完成后，由平台/运维负责
人按受控流程生成本地 `agentkit.yaml`，不能恢复为仓库内的直连部署命令。

## 记忆库调试

```bash
uv run check_memory.py
uv run check_memory.py --search "关键词"
uv run check_memory.py --user 83770919
```
