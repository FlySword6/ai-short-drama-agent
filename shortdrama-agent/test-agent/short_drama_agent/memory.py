import os

from google.adk.agents.callback_context import CallbackContext
from veadk.memory.long_term_memory import LongTermMemory
from veadk.memory.long_term_memory_backends.vikingdb_memory_backend import (
    VikingDBLTMBackend,
)
from veadk.utils.logger import get_logger

logger = get_logger(__name__)

_saved_event_counts: dict[str, int] = {}


class RaceTolerantVikingDBLTMBackend(VikingDBLTMBackend):
    """Treat duplicated collection creation as success during concurrent starts."""

    def _create_collection(self) -> None:
        try:
            return super()._create_collection()
        except Exception as e:
            msg = str(e)
            if "already exist" in msg:
                logger.warning(
                    f"Memory collection '{self.index}' already exists "
                    f"(likely created by a concurrent replica), skip create: {msg}"
                )
                return None
            raise


def create_long_term_memory() -> LongTermMemory:
    kb_collection = os.getenv("DATABASE_VIKING_COLLECTION", "role")
    mem_collection = os.getenv(
        "DATABASE_VIKINGMEM_COLLECTION", f"{kb_collection}_mem"
    )
    if mem_collection == kb_collection:
        logger.warning(
            f"Memory collection name '{mem_collection}' collides with knowledge "
            f"base collection '{kb_collection}', force renaming to "
            f"'{kb_collection}_mem'."
        )
        mem_collection = f"{kb_collection}_mem"
    logger.info(
        f"VikingDB long-term memory collection: {mem_collection} "
        f"(kb collection: {kb_collection})"
    )

    long_term_memory = LongTermMemory(
        backend=RaceTolerantVikingDBLTMBackend(index=mem_collection),
    )

    if not isinstance(long_term_memory.backend, str):
        long_term_memory.backend = "viking"
    logger.info(
        f"LongTermMemory backend type: {type(long_term_memory.backend).__name__}, "
        f"value: {long_term_memory.backend!r}"
    )
    return long_term_memory


def make_after_agent_execution(long_term_memory: LongTermMemory):
    async def after_agent_execution(callback_context: CallbackContext):
        session = callback_context._invocation_context.session
        session_id = getattr(session, "id", "") or ""
        events = list(getattr(session, "events", []) or [])
        saved_event_count = _saved_event_counts.get(session_id, 0) if session_id else 0
        if saved_event_count >= len(events):
            logger.debug(
                f"Session {session_id} has no new events to save to LTM, skip."
            )
            return

        new_events = events[saved_event_count:]
        session_to_save = session.model_copy(update={"events": new_events})
        try:
            await long_term_memory.add_session_to_memory(session_to_save)
            if session_id:
                _saved_event_counts[session_id] = len(events)
            logger.info(
                f"Saved {len(new_events)} new events from session {session_id} "
                "to long-term memory."
            )
        except Exception as e:
            logger.warning(
                f"Failed to save session to long-term memory (ignored, "
                f"main conversation unaffected): {e}"
            )

    return after_agent_execution
