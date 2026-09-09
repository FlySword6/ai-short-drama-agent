"""ADK/VeADK loader entrypoint for the `short_drama_agent` package.

`veadk web` / `adk web` expects an agent directory like:

    <agents_dir>/short_drama_agent/agent.py

with a module-level `root_agent`. The project's canonical runtime entrypoint
already lives at the repository root (`agent.py`), so this file simply re-exports
those public objects for the web loader.
"""

from agent import (  # noqa: F401
    agent_server_app,
    kb,
    long_term_memory,
    root_agent,
    runner,
    short_term_memory,
)
