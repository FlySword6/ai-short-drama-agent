# 短剧生产链路 Agent

这是一个 LLM 驱动的短剧生产链路编排 Agent，将剧本解析、资产匹配、镜头卡组装与画面生成编排成可幂等、可追溯的流水线：

```text
Script（LLM 拆解）→ Asset（LLM 语义匹配）→ Scene（LLM 生成提示词）→ ReviewGate → Generation（真实生图 API）→ ReviewGate → Asset 入库
```

每个 Skill 调用火山引擎 Ark API 进行真实的语义理解和图像生成，同时保留不可逾越的审批边界：任何不可逆操作（生成、入库）都必须先通过 `ReviewGate` 的人审放行。

## 快速开始

```bash
cd production-chain-agent
uv sync --python 3.12

# 设置 Ark API Key
export MODEL_AGENT_API_KEY="your-ark-api-key"

# 使用内置示例剧本运行完整链路（真实 LLM + 真实生图）
uv run python agent.py

# 自定义剧本和资产库存
uv run python agent.py \
  --project-id "my-project" \
  --title "夜雨追凶" \
  --episode 3 \
  --script "角色：陈默；场景：雨夜小巷；道具：断刃匕首；陈默低声说：这次我不会再失手。" \
  --inventory '[{"asset_id":"a1","name":"陈默","kind":"character","description":"男主角","aliases":["默"]}]' \
  --reviewer "director"

# 运行测试（使用 Mock LLM，无需 API Key）
uv run python -m unittest discover -s tests -v
```

## 架构

```
production_chain/
├── llm.py        # Ark API 客户端：chat_json + generate_image
├── models.py     # 不可变数据契约（frozen dataclass）
└── workflow.py    # 四个 Skill + ReviewGate + ProductionChainAgent
```

### 各 Skill 的真实能力

| Skill | 旧版（Mock） | 新版（真实 LLM） |
|-------|-------------|-----------------|
| ScriptSkill | 固定标记字符串匹配 | LLM 语义拆解角色/场景/道具，生成证据 |
| AssetSkill | 精确名称字典查找 | LLM 语义匹配（别名、描述、类型一致性） |
| SceneSkill | 标题+对白拼接 | LLM 生成专业镜头卡提示词（景别、运镜、光影） |
| GenerationSkill | 返回 cost=0 的空结果 | 调用 Ark 图片生成 API，返回真实图片 URL |

### 依赖注入

每个 Skill 接受可选的 `LLMClient` 参数，测试时可注入 Mock：

```python
agent = ProductionChainAgent.create(llm=my_mock_llm)
```

生产环境不传 `llm`，自动使用从环境变量读取 API Key 的默认客户端。

### AgentKit 部署

`agentkit_entry.py` 暴露两个工具供云端 LLM 调用：

- `run_production_chain_tool`：接收剧本文本和资产库存，执行完整链路
- `run_fixture_production_chain`：无参数，使用内置示例快速验证

```bash
uv run agentkit config --agent_name shortdrama_production_chain_agent \
  --entry_point agentkit_entry.py --launch_type cloud
uv run agentkit launch
```

部署时通过 AgentKit runtime 环境配置 `MODEL_AGENT_API_KEY` 或火山云 AK/SK；不要把任何凭据写入 `agentkit.yaml`、`.env` 或 Git。

## 边界与约束

- `ReviewGate` 是审批状态的独占者，任何 Skill 不可越权推进已审批状态
- 生成结果始终是候选版本，二次人审通过后才允许显式入库
- 所有 ID 通过 `stable_id(prefix, *parts)` 基于业务输入确定性生成，保证幂等
- LLM 返回的 ID 会与上游实际 ID 交叉校验，防止幻觉
# 最小生产链路 Agent

这是独立于 `../test-agent/` 的 fixture-only 最小实现，用于验证：

```text
Script → Asset → Scene → ReviewGate → Generation → ReviewGate → Asset promotion
```

它不连接模型、资产库或生成供应商，也不会调用付费服务。`agent.py` 只编排流程；状态由领域对象与 `ReviewGate` 裁决。生成结果默认只是候选版本，二次人审通过后才能被显式沉淀为资产。

```bash
cd production-chain-agent
uv sync --python 3.12
uv run python agent.py --dry-run
uv run python -m unittest discover -s tests -v
```

输出中的 `trace_id`、`script_version`、`revision` 与 `idempotency_key` 是跨阶段关联和防重复提交的最小字段。后续接入真实服务时，将各 skill 的 fixture 逻辑替换为受契约约束的 API adapter，保留这些边界。

## AgentKit 运行入口

`agentkit_entry.py` 使用火山云 `AgentkitAgentServerApp` 托管 VeADK Agent，并把 `run_fixture_production_chain` 作为 Agent 工具挂载。该工具只执行本地 fixture，不会调用生成模型或写入真实资产库；云端模型只负责按用户请求调用工具并解释回执。

```bash
uv sync --python 3.12
uv run agentkit config --agent_name shortdrama_production_chain_agent \
  --entry_point agentkit_entry.py --launch_type cloud
uv run agentkit launch
```

部署时通过 AgentKit runtime 环境配置 `MODEL_AGENT_API_KEY` 或火山云 AK/SK；不要把任何凭据写入 `agentkit.yaml`、`.env` 或 Git。真实资产检索、审批身份校验和生成 API 应作为下一阶段的受权限保护 adapter 接入。

本地运行必须使用项目环境，不要调用全局 `veadk`：`uv run veadk web`。裸 `veadk web` 会使用当前 shell 的全局 Python；它与项目锁定的 AgentKit/Google ADK 版本不一致时会启动失败。
