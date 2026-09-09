"""A2A (Agent-to-Agent) multi-agent layer for the production chain.

Named ``sda2a`` (shortdrama A2A) to avoid collision with the
``a2a-sdk`` package (Google A2A SDK used by veadk).

Key components:
- :class:`AgentCard` / protocol helpers — agent discovery and messaging
- :class:`A2AClient` — sends tasks to sub-agents
- :class:`A2AAgentServer` — HTTP server for sub-agents
- :class:`SubAgentCluster` — manages all four sub-agent servers
- :class:`A2AOrchestrator` — coordinates the pipeline via A2A calls
"""

from .client import A2AClient
from .hub import HubManager
from .orchestrator import A2AOrchestrator
from .protocol import AgentCard, AgentSkill
from .server import A2AAgentServer
from .sub_agents import (
    AssetAgentServer,
    GenerationAgentServer,
    SceneAgentServer,
    ScriptAgentServer,
    SubAgentCluster,
)

__all__ = [
    "AgentCard",
    "AgentSkill",
    "A2AClient",
    "A2AAgentServer",
    "A2AOrchestrator",
    "AssetAgentServer",
    "GenerationAgentServer",
    "HubManager",
    "SceneAgentServer",
    "ScriptAgentServer",
    "SubAgentCluster",
]
