import asyncio
import unittest

from google.adk.events.event import Event
from google.adk.sessions.session import Session
from google.genai import types

from short_drama_agent import memory as memory_module
from short_drama_agent.memory import make_after_agent_execution


class FakeInvocationContext:
    def __init__(self, session):
        self.session = session


class FakeCallbackContext:
    def __init__(self, session):
        self._invocation_context = FakeInvocationContext(session)


class RecordingLongTermMemory:
    def __init__(self):
        self.saved_sessions = []

    async def add_session_to_memory(self, session):
        self.saved_sessions.append(session)


def user_event(text: str) -> Event:
    return Event(
        author="user",
        content=types.Content(role="user", parts=[types.Part(text=text)]),
    )


class LongTermMemoryCallbackTest(unittest.TestCase):
    def setUp(self):
        memory_module._saved_event_counts.clear()

    def test_after_agent_callback_saves_new_events_from_existing_session(self):
        session = Session(
            id="session-1",
            appName="short_drama_asset_agent",
            userId="user-1",
            events=[user_event("你好")],
        )
        long_term_memory = RecordingLongTermMemory()
        callback = make_after_agent_execution(long_term_memory)

        asyncio.run(callback(FakeCallbackContext(session)))
        session.events.append(user_event("我叫林小满"))
        asyncio.run(callback(FakeCallbackContext(session)))

        self.assertEqual(len(long_term_memory.saved_sessions), 2)
        self.assertEqual(
            long_term_memory.saved_sessions[0].events[0].content.parts[0].text,
            "你好",
        )
        self.assertEqual(
            long_term_memory.saved_sessions[1].events[0].content.parts[0].text,
            "我叫林小满",
        )


if __name__ == "__main__":
    unittest.main()
