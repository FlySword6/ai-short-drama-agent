import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

from pi_http_wrapper.rpc_manager import PiRpcManager

RESPONDER_SOURCE = """
import json
import sys

for line in sys.stdin:
    command = json.loads(line)
    print(json.dumps({
        "type": "response",
        "id": command["id"],
        "command": command["type"],
        "success": True,
    }), flush=True)
    print(json.dumps({"type": "agent_start"}), flush=True)
"""

SLEEPER_SOURCE = """
import time
time.sleep(60)
"""


def _write_fake_executable(directory: Path, source: str) -> Path:
    """Create a fake ``pi`` executable that works on the current platform.

    On POSIX this is a shebang script; on Windows it is a ``.cmd`` shim that
    invokes the current interpreter, mirroring how npm installs ``pi.cmd``.
    """
    body = source.lstrip()
    if sys.platform == "win32":
        script = directory / "fake_pi.py"
        script.write_text(body, encoding="utf-8")
        shim = directory / "fake-pi.cmd"
        shim.write_text(
            f'@echo off\r\n"{sys.executable}" "{script}" %*\r\n',
            encoding="utf-8",
        )
        return shim
    executable = directory / "fake-pi"
    executable.write_text("#!/usr/bin/env python3\n" + body, encoding="utf-8")
    executable.chmod(0o755)
    return executable


class RpcManagerLifecycleTests(unittest.TestCase):
    def test_stop_then_start_clears_busy_and_joins_old_reader(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = _write_fake_executable(Path(temporary), RESPONDER_SOURCE)
            manager = PiRpcManager(bin_path=str(executable))
            manager.start()
            response = manager.send_command({"type": "prompt", "message": "hello"})
            self.assertTrue(response["success"])
            deadline = time.monotonic() + 1
            while not manager.is_agent_busy() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(manager.is_agent_busy())

            manager.stop()
            self.assertFalse(manager.running)
            self.assertFalse(manager.is_agent_busy())
            self.assertIsNone(manager._reader_thread)

            manager.start()
            self.assertTrue(manager.running)
            self.assertFalse(manager.is_agent_busy())
            manager.stop()

    def test_old_reader_events_cannot_change_restarted_process_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = _write_fake_executable(Path(temporary), SLEEPER_SOURCE)
            manager = PiRpcManager(bin_path=str(executable))
            manager.start()
            old_process = manager._proc
            old_generation = manager._generation
            self.assertIsNotNone(old_process)

            manager.stop()
            manager.start()
            new_process = manager._proc
            new_generation = manager._generation
            self.assertIsNotNone(new_process)
            self.assertNotEqual(old_generation, new_generation)

            # This simulates an old stdout reader finally dispatching after a
            # rapid stop/start.  It must not clear the new process's busy bit.
            manager._dispatch_line(
                json.dumps({"type": "agent_start"}),
                process=new_process,
                generation=new_generation,
            )
            self.assertTrue(manager.is_agent_busy())
            manager._dispatch_line(
                json.dumps({"type": "agent_settled"}),
                process=old_process,
                generation=old_generation,
            )
            self.assertTrue(manager.running)
            self.assertTrue(manager.is_agent_busy())
            manager.stop()
