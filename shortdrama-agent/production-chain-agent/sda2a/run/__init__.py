"""Standalone deployment entry points for the A2A multi-agent system.

Each module can be run independently:

- ``python -m sda2a.run.hub`` — start the A2A Hub server
- ``python -m sda2a.run.agent --type script`` — start a single sub-agent
- ``python -m sda2a.run.orchestrator`` — run the orchestrator via Hub discovery
- ``python -m sda2a.run.all`` — start everything locally for testing
"""
