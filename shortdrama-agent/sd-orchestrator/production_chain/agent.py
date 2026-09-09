"""ADK web loader adapter for the orchestrator application.

``adk web`` discovers ``production_chain`` as an application package and
requires this module to expose ``root_agent``.  The deployable runtime remains
``app.py``; this adapter only makes the same root agent available to ADK's
local development loader.
"""

from app import root_agent

__all__ = ["root_agent"]
