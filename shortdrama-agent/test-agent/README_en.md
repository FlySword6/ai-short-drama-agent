# Short Drama Asset Agent

An AgentKit / VeADK project for short-drama asset management. It combines VikingDB knowledge retrieval, VikingDB long-term memory, asset ingestion, script breakdown, and official Skills Sandbox execution.

## Capabilities

- Answer questions about short-drama works, roles, plots, assets, tags, and operations data.
- Store user identity, preferences, and historical instructions in VikingDB LTM.
- Route asset ingestion requests through MCP/Skills orchestration.
- Break scripts into structured roles, scenes, props, and shots.
- Serve both AgentKit AgentServer and A2A protocol entrypoints.

## Stack

| Area | Tooling |
| --- | --- |
| Python | 3.12 |
| Package manager | uv |
| Agent runtime | veadk-python[extensions] 0.5.40, google-adk 1.32.0 |
| Deployment | agentkit-sdk-python 0.2.0 |
| Protocol | a2a-sdk >=0.3.7,<1.0.0 |
| Knowledge base | VikingDB collection `role`, project `shortdrama` |
| Long-term memory | VikingDB LTM collection `role_mem` |

## Structure

```text
vikingdb/
├── agent.py                         # AgentKit AgentServer entrypoint
├── agent_a2a.py                     # A2A entrypoint
├── short_drama_agent/
│   ├── agent.py                     # ADK/VeADK Web loader
│   ├── config.py                    # Config and agent instructions
│   ├── execute_skills.py            # Official Skills Sandbox integration
│   ├── factory.py                   # root_agent assembly
│   ├── knowledge_assets.py          # Knowledge retrieval and asset ingestion
│   ├── mcp_safety.py                # Safe MCP ingestion wrapper
│   ├── memory.py                    # VikingDB long-term memory
│   ├── processors.py                # Request preprocessing and routing hints
│   ├── runtime_patches.py           # ADK/VeADK compatibility patches
│   ├── script_breakdown.py          # Script breakdown sub-agent
│   └── tool_diagnostics.py          # Tool diagnostics
├── skills/
├── tests/
├── check_memory.py
├── client.py
├── agentkit.example.yaml
├── agentkit.yaml                    # generated locally/controlled only; ignored by Git
├── requirements.txt
└── pyproject.toml
```

## Development

```bash
uv venv --python 3.12
uv sync
source .venv/bin/activate
```

Required environment variables:

```bash
export VOLCENGINE_ACCESS_KEY=<access-key>
export VOLCENGINE_SECRET_KEY=<secret-key>
export DATABASE_VIKING_PROJECT=shortdrama
export DATABASE_VIKING_COLLECTION=role
export DATABASE_VIKINGMEM_COLLECTION=role_mem
export MODEL_AGENT_NAME=doubao-seed-2-0-pro-260215
```

`agentkit.example.yaml` is a field reference only. A credential owner must
generate the real `agentkit.yaml` locally or in a controlled deployment
environment; it must never be committed and must obtain credentials from the
approved secret/IAM mechanism.

Optional external tool configuration:

```bash
export TOOL_MCP_ROUTER_URL=https://<router>/mcp
export TOOL_MCP_ROUTER_API_KEY=<api-key>
export AGENTKIT_TOOL_ID=<skills-sandbox-tool-id>
export SKILL_SPACE_ID=<skill-space-id>
```

## Run

```bash
make run          # AgentKit AgentServer on port 8000
make web          # VeADK Web
uv run agent_a2a.py
```

## Local security boundary

The harness binds to `127.0.0.1` by default and accepts only explicit
loopback CORS origins. The `/debug/tools` HTTP route has been removed.
`A2A_HOST`, `AGENT_SERVER_HOST`, and the CORS environment variables may only
use loopback addresses. Production access must be moved behind the
authenticated platform backend and controlled workers; do not deploy this
test-agent directly.

## Test

```bash
make test
```

The online OpenAI-compatible API checks are opt-in:

```bash
RUN_REAL_OPENAI_COMPAT=1 \
OPENAI_COMPAT_BASE_URL=https://<endpoint> \
OPENAI_COMPAT_API_KEY=<api-key> \
uv run python -m unittest tests.test_openai_api_compat_online -v
```

## Deploy

Direct generation or deployment of this `test-agent` is deliberately blocked
by `make config`, `make deploy`, and `agenkit-cloud.sh`. It is for loopback
development only. Production access must go through the authenticated platform
backend and controlled workers. After P0 closure, credential rotation, and
staging evidence, the platform/operations owner may generate a local ignored
`agentkit.yaml` through the controlled process; do not restore a repository
direct-deploy command.
