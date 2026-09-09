"""Pi JSONL RPC process manager adapted from a captured upstream server.

Original source captured from a private deployment; the original repository and
source-level author were unavailable. Adapted and vendored into pi-http-wrapper.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from queue import Queue
from typing import Any

_WINDOWS_SHIM_SUFFIXES = (".cmd", ".bat")


def _resolve_command(bin_path: str, extra_args: list[str]) -> list[str]:
    """Build the argv list for ``pi --mode rpc``, handling Windows npm shims.

    On Windows a globally installed npm CLI (such as ``pi``) ships three shims:
    an extensionless POSIX script, ``pi.cmd`` and ``pi.ps1``.  Only the
    ``.cmd`` one is suitable for ``subprocess.Popen`` (via ``cmd.exe``); the
    raw ``pi`` file and ``pi.ps1`` fail with WinError 193 / parse errors.
    """
    resolved = shutil.which(bin_path) or bin_path
    if sys.platform == "win32":
        lowered = resolved.lower()
        if not lowered.endswith(_WINDOWS_SHIM_SUFFIXES):
            # ``pi`` (POSIX shim) or ``pi.ps1``: prefer the adjacent ``pi.cmd``.
            stem = resolved[: -len(".ps1")] if lowered.endswith(".ps1") else resolved
            candidate = stem + ".cmd"
            if os.path.exists(candidate):
                resolved = candidate
        command = [resolved, "--mode", "rpc", "--no-session", *extra_args]
        return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", *command]
    return [resolved, "--mode", "rpc", "--no-session", *extra_args]


class PiRpcManager:
    """Own one serialized ``pi --mode rpc`` subprocess."""

    def __init__(
        self,
        *,
        bin_path: str = "pi",
        extra_args: list[str] | None = None,
        environment: dict[str, str] | None = None,
    ) -> None:
        self._bin = bin_path
        self._extra_args = list(extra_args or [])
        self._environment = environment
        self._proc: subprocess.Popen[str] | None = None
        self._write_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._cmd_id = 0
        self._pending_responses: dict[str, threading.Event] = {}
        self._response_data: dict[str, dict[str, Any]] = {}
        self._subscribers: list[Queue[dict[str, Any]]] = []
        self._reader_thread: threading.Thread | None = None
        self._running = False
        self._agent_busy = threading.Event()
        # A reader belongs to exactly one subprocess lifetime.  ``stop`` can
        # return before a blocked stdout reader observes EOF, so generation
        # checks prevent that old reader from changing a replacement process.
        self._generation = 0

    @property
    def running(self) -> bool:
        with self._state_lock:
            return self._running

    def start(self) -> None:
        with self._state_lock:
            if self._running:
                return
            command = _resolve_command(self._bin, self._extra_args)
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                # Inherit stderr so systemd/journald drains it. A PIPE without a
                # reader can fill and deadlock the Pi subprocess.
                stderr=None,
                text=True, encoding="utf-8",
                bufsize=1,
                env=self._environment,
            )
            self._generation += 1
            generation = self._generation
            self._proc = process
            self._running = True
            self._agent_busy.clear()
            reader = threading.Thread(target=self._read_loop, args=(process, generation), daemon=True)
            self._reader_thread = reader
            reader.start()

    def stop(self) -> None:
        with self._state_lock:
            # Invalidate the reader before ending its process.  This matters
            # when a caller immediately starts the next --no-session turn.
            self._generation += 1
            self._running = False
            self._agent_busy.clear()
            process = self._proc
            reader = self._reader_thread
            self._proc = None
            self._reader_thread = None
            pending_events = list(self._pending_responses.values())
            self._pending_responses.clear()
            self._response_data.clear()
            self._subscribers.clear()
        for event in pending_events:
            event.set()
        if process is None:
            return
        try:
            if sys.platform == "win32":
                # On Windows the pi shim runs as cmd.exe -> node.exe; terminate()
                # would only end cmd.exe and leave the node child alive.
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                    capture_output=True,
                    check=False,
                )
            else:
                process.terminate()
            process.wait(timeout=5)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            process.kill()
            process.wait()
        if reader is not None and reader is not threading.current_thread():
            reader.join(timeout=5)
        for stream in (process.stdin, process.stdout):
            if stream is not None and not stream.closed:
                stream.close()

    def restart(self, *, extra_args: list[str] | None = None) -> None:
        self.stop()
        if extra_args is not None:
            self._extra_args = list(extra_args)
        time.sleep(0.1)
        self.start()

    def _next_id(self) -> str:
        with self._state_lock:
            self._cmd_id += 1
            return f"cmd-{self._cmd_id}"

    def send_command(
        self,
        command: dict[str, Any],
        *,
        wait_response: bool = True,
        timeout: float = 30,
    ) -> dict[str, Any] | None:
        command_id = str(command.get("id") or self._next_id())
        wire_command = {**command, "id": command_id}
        response_event = threading.Event()
        with self._state_lock:
            if not self._running or self._proc is None or self._proc.stdin is None:
                raise RuntimeError("Pi RPC process is not running")
            process = self._proc
            self._pending_responses[command_id] = response_event
        try:
            with self._write_lock:
                with self._state_lock:
                    if not self._running or self._proc is not process or process.stdin is None:
                        raise RuntimeError("Pi RPC process is not running")
                    stdin = process.stdin
                stdin.write(json.dumps(wire_command, ensure_ascii=False) + "\n")
                stdin.flush()
        except (BrokenPipeError, OSError) as error:
            with self._state_lock:
                self._pending_responses.pop(command_id, None)
            raise RuntimeError("Pi RPC process closed its input") from error
        if not wait_response:
            with self._state_lock:
                self._pending_responses.pop(command_id, None)
            return None
        if not response_event.wait(timeout=timeout):
            with self._state_lock:
                self._pending_responses.pop(command_id, None)
            raise TimeoutError(f"Pi command {command.get('type')} timed out")
        with self._state_lock:
            response = self._response_data.pop(command_id, None)
        if response is None:
            raise RuntimeError("Pi RPC process exited before returning a command response")
        return response

    def subscribe(self) -> Queue[dict[str, Any]]:
        queue: Queue[dict[str, Any]] = Queue()
        with self._state_lock:
            self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: Queue[dict[str, Any]]) -> None:
        with self._state_lock:
            try:
                self._subscribers.remove(queue)
            except ValueError:
                pass

    def is_agent_busy(self) -> bool:
        return self._agent_busy.is_set()

    def _read_loop(self, process: subprocess.Popen[str], generation: int) -> None:
        if process.stdout is None:
            return
        while True:
            with self._state_lock:
                if generation != self._generation or self._proc is not process or not self._running:
                    return
            line = process.stdout.readline()
            if not line:
                break
            self._dispatch_line(line.rstrip("\r\n"), process=process, generation=generation)
        with self._state_lock:
            if generation != self._generation or self._proc is not process:
                return
            self._running = False
            self._agent_busy.clear()
            for event in self._pending_responses.values():
                event.set()
            subscribers = list(self._subscribers)
        for queue in subscribers:
            queue.put_nowait({"type": "runtime_exited"})

    def _dispatch_line(
        self,
        line: str,
        *,
        process: subprocess.Popen[str] | None = None,
        generation: int | None = None,
    ) -> None:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            return
        with self._state_lock:
            if generation is not None and (
                generation != self._generation or (process is not None and self._proc is not process)
            ):
                return
            if payload.get("type") == "agent_start":
                self._agent_busy.set()
            elif payload.get("type") in {"agent_end", "agent_settled"}:
                self._agent_busy.clear()
            if payload.get("type") == "response":
                command_id = payload.get("id")
                response_event = self._pending_responses.pop(command_id, None)
                if command_id and response_event:
                    self._response_data[command_id] = payload
                    response_event.set()
                    return
            subscribers = list(self._subscribers)
        for queue in subscribers:
            queue.put_nowait(payload)

