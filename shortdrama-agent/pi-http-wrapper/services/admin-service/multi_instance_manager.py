#!/usr/bin/env python3
"""
Multi-Instance Pi RPC Process Manager

Manages multiple `pi --mode rpc` subprocesses, one per user.
Each instance is identified by (agent_id, user_id) key.

Core capabilities:
- discover_users(): scan DATA_ROOT for tenant directories
- start_instance(agent_id, user_id): launch a user's pi RPC process
- send_prompt(session_key, message): send a prompt via stdin
- subscribe(session_key, callback): subscribe to event stream
- stop_instance(): gracefully stop a process
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time
import uuid
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Callable, Optional

# ── Configuration ──────────────────────────────────────────────────────────

DATA_ROOT = os.environ.get("PI_DATA_ROOT", "/var/lib/pi-http-wrapper/data")
PI_BIN = os.environ.get("PI_BIN", "pi")

# ── Instance State ─────────────────────────────────────────────────────────


class PiInstance:
    """Represents a single user's pi RPC process and its state."""

    def __init__(self, agent_id: str, user_id: str):
        self.agent_id = agent_id
        self.user_id = user_id
        self.session_key = f"{agent_id}/{user_id}"
        self.user_dir = Path(DATA_ROOT) / agent_id / user_id
        self.run_script = self.user_dir / "run-pi.sh"
        self.workspace = self.user_dir / "workspace"
        self.session_dir = self.user_dir / ".pi" / "agent" / "sessions"

        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._cmd_id = 0
        self._pending_responses: dict[str, threading.Event] = {}
        self._response_data: dict[str, dict] = {}
        self._subscribers: list[Queue] = []
        self._reader_thread: threading.Thread | None = None
        self._running = False
        self._agent_busy = threading.Event()

        # Status tracking
        self.status: str = "stopped"  # stopped | starting | ready | busy | error
        self.started_at: float | None = None
        self.error_message: str | None = None

    # ── Lifecycle ──────────────────────────────────────────────────────

    def start(self) -> bool:
        """Spawn the pi RPC subprocess for this user."""
        if self._running:
            return True

        if not self.run_script.exists():
            self.error_message = f"run-pi.sh not found: {self.run_script}"
            self.status = "error"
            return False

        if not self.run_script.stat().st_mode & 0o100:
            os.chmod(self.run_script, 0o755)

        self.status = "starting"

        try:
            cmd = [str(self.run_script), "--mode", "rpc"]
            self._proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                cwd=str(self.workspace) if self.workspace.exists() else None,
            )
            self._running = True
            self.started_at = time.time()
            self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
            self._reader_thread.start()

            # Wait briefly and check if process is alive
            time.sleep(0.5)
            if self._proc.poll() is not None:
                stderr_out = self._proc.stderr.read() if self._proc.stderr else ""
                self.error_message = f"Process exited immediately: {stderr_out[:500]}"
                self.status = "error"
                self._running = False
                return False

            self.status = "ready"
            self.error_message = None
            return True

        except Exception as e:
            self.error_message = str(e)
            self.status = "error"
            self._running = False
            return False

    def stop(self, timeout: float = 5.0):
        """Gracefully stop this user's pi process."""
        self._running = False
        if self._proc:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=timeout)
            except (subprocess.TimeoutExpired, ProcessLookupError):
                try:
                    self._proc.kill()
                    self._proc.wait(timeout=2)
                except Exception:
                    pass
            self._proc = None
        self.status = "stopped"
        self._agent_busy.clear()
        # Wake up any pending waiters
        for evt in self._pending_responses.values():
            evt.set()
        self._pending_responses.clear()
        self._response_data.clear()

    def restart(self) -> bool:
        """Restart the instance."""
        self.stop()
        time.sleep(0.5)
        return self.start()

    # ── Command Submission ─────────────────────────────────────────────

    def _next_id(self) -> str:
        self._cmd_id += 1
        return f"cmd-{self._cmd_id}"

    def send_command(self, cmd: dict, wait_response: bool = True, timeout: float = 30) -> dict | None:
        """Send a JSON command to the pi RPC process via stdin."""
        if not self._running or not self._proc or self._proc.poll() is not None:
            self.status = "error"
            self.error_message = "Process is not running"
            raise RuntimeError(f"Instance {self.session_key} is not running")

        cmd_id = cmd.get("id") or self._next_id()
        cmd["id"] = cmd_id

        event = threading.Event()
        self._pending_responses[cmd_id] = event

        with self._lock:
            line = json.dumps(cmd, ensure_ascii=False) + "\n"
            try:
                self._proc.stdin.write(line)
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError) as e:
                self._pending_responses.pop(cmd_id, None)
                self.status = "error"
                self.error_message = f"Write failed: {e}"
                self._running = False
                raise RuntimeError(f"Instance {self.session_key} pipe broken: {e}")

        if not wait_response:
            self._pending_responses.pop(cmd_id, None)
            return None

        if not event.wait(timeout=timeout):
            self._pending_responses.pop(cmd_id, None)
            raise TimeoutError(f"Command {cmd.get('type')} timed out for {self.session_key}")

        result = self._response_data.pop(cmd_id, None)
        return result

    def subscribe(self) -> Queue:
        """Create a new subscriber queue for this instance's events."""
        q: Queue = Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: Queue):
        """Remove a subscriber queue."""
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    def is_agent_busy(self) -> bool:
        return self._agent_busy.is_set()

    def to_dict(self) -> dict:
        """Serializable status dict."""
        uptime = (time.time() - self.started_at) if self.started_at else 0
        return {
            "session_key": self.session_key,
            "agent_id": self.agent_id,
            "user_id": self.user_id,
            "status": self.status,
            "agent_busy": self.is_agent_busy(),
            "pid": self._proc.pid if self._proc else None,
            "uptime_seconds": round(uptime, 1),
            "error": self.error_message,
        }

    # ── Internal: Reader Loop ──────────────────────────────────────────

    def _read_loop(self):
        """Read stdout lines from pi, dispatch events and responses."""
        buffer = ""
        while self._running and self._proc and self._proc.stdout:
            try:
                chunk = self._proc.stdout.read(1)
                if not chunk:
                    break
                buffer += chunk
                if chunk == "\n":
                    line = buffer.rstrip("\r\n")
                    buffer = ""
                    if line:
                        self._dispatch_line(line)
            except (ValueError, OSError):
                break

        self._running = False
        if self.status not in ("stopped", "error"):
            self.status = "stopped"

    def _dispatch_line(self, line: str):
        """Parse a JSON line and route it."""
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            return

        # Track agent busy state
        if obj.get("type") == "agent_start":
            self._agent_busy.set()
            self.status = "busy"
        elif obj.get("type") in ("agent_end", "agent_settled"):
            self._agent_busy.clear()
            self.status = "ready"

        # Check if this is a command response
        if obj.get("type") == "response":
            cmd_id = obj.get("id")
            if cmd_id and cmd_id in self._pending_responses:
                self._response_data[cmd_id] = obj
                self._pending_responses[cmd_id].set()
                return

        # Add session_key to event for routing
        obj["_session_key"] = self.session_key

        # Broadcast to subscribers
        for q in self._subscribers:
            try:
                q.put_nowait(obj)
            except Exception:
                pass


# ── Multi-Instance Manager ─────────────────────────────────────────────────


class MultiInstanceManager:
    """
    Manages multiple PiInstance objects, keyed by "agent_id/user_id".
    """

    def __init__(self, data_root: str = DATA_ROOT):
        self.data_root = Path(data_root)
        self._instances: dict[str, PiInstance] = {}
        self._lock = threading.Lock()

    # ── Discovery ──────────────────────────────────────────────────────

    def discover_users(self) -> list[dict]:
        """
        Scan data_root for all tenant directories.
        Returns list of {agent_id, user_id, has_config, has_workspace}.
        """
        users = []
        if not self.data_root.exists():
            return users

        for agent_dir in sorted(self.data_root.iterdir()):
            if not agent_dir.is_dir() or agent_dir.name == "shared":
                continue
            agent_id = agent_dir.name
            for user_dir in sorted(agent_dir.iterdir()):
                if not user_dir.is_dir():
                    continue
                user_id = user_dir.name
                config_file = user_dir / "config.json"
                workspace = user_dir / "workspace"
                users.append({
                    "agent_id": agent_id,
                    "user_id": user_id,
                    "has_config": config_file.exists(),
                    "has_workspace": workspace.exists() and workspace.is_dir(),
                })
        return users

    # ── Instance Management ────────────────────────────────────────────

    def get_or_create_instance(self, agent_id: str, user_id: str) -> PiInstance:
        """Get existing instance or create a new one (without starting)."""
        key = f"{agent_id}/{user_id}"
        with self._lock:
            if key not in self._instances:
                self._instances[key] = PiInstance(agent_id, user_id)
            return self._instances[key]

    def get_instance(self, agent_id: str, user_id: str) -> PiInstance | None:
        """Get a running instance, or None."""
        key = f"{agent_id}/{user_id}"
        with self._lock:
            return self._instances.get(key)

    def start_instance(self, agent_id: str, user_id: str) -> dict:
        """Start a user's pi RPC process. Returns status dict."""
        inst = self.get_or_create_instance(agent_id, user_id)
        success = inst.start()
        return {"success": success, "instance": inst.to_dict()}

    def stop_instance(self, agent_id: str, user_id: str) -> dict:
        """Stop a user's pi RPC process."""
        inst = self.get_instance(agent_id, user_id)
        if inst is None:
            return {"success": False, "error": f"Instance {agent_id}/{user_id} not found"}
        inst.stop()
        with self._lock:
            key = f"{agent_id}/{user_id}"
            self._instances.pop(key, None)
        return {"success": True, "instance": inst.to_dict()}

    def list_instances(self) -> list[dict]:
        """List all tracked instances (running or stopped)."""
        with self._lock:
            return [inst.to_dict() for inst in self._instances.values()]

    def stop_all(self) -> dict:
        """Stop all running instances."""
        keys = list(self._instances.keys())
        stopped = []
        errors = []
        for key in keys:
            inst = self._instances.get(key)
            if inst:
                try:
                    inst.stop()
                    stopped.append(key)
                except Exception as e:
                    errors.append({"key": key, "error": str(e)})
        with self._lock:
            self._instances.clear()
        return {"success": len(errors) == 0, "stopped": stopped, "errors": errors}

    # ── Convenience ────────────────────────────────────────────────────

    def send_prompt(self, agent_id: str, user_id: str, message: str,
                    images: list[dict] | None = None,
                    timeout: float = 10) -> dict:
        """Send a prompt command to a specific user's instance."""
        inst = self.get_instance(agent_id, user_id)
        if inst is None:
            return {"success": False, "error": f"Instance {agent_id}/{user_id} not found"}
        if not inst._running:
            return {"success": False, "error": f"Instance {agent_id}/{user_id} is not running"}

        cmd: dict = {"type": "prompt", "message": message}
        if images:
            cmd["images"] = images

        try:
            response = inst.send_command(cmd, wait_response=True, timeout=timeout)
            if response and response.get("success"):
                return {"success": True, "instance": inst.to_dict()}
            else:
                error = response.get("error", "Unknown error") if response else "No response"
                return {"success": False, "error": error}
        except TimeoutError:
            return {"success": False, "error": "Prompt acceptance timed out"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def send_steer(self, agent_id: str, user_id: str, message: str) -> dict:
        """Queue a steering message."""
        inst = self.get_instance(agent_id, user_id)
        if inst is None or not inst._running:
            return {"success": False, "error": "Instance not found or not running"}
        try:
            resp = inst.send_command({"type": "steer", "message": message})
            if resp and resp.get("success"):
                return {"success": True, "status": "queued"}
            return {"success": False, "error": resp.get("error", "Unknown") if resp else "No response"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def send_abort(self, agent_id: str, user_id: str) -> dict:
        """Abort current operation."""
        inst = self.get_instance(agent_id, user_id)
        if inst is None or not inst._running:
            return {"success": False, "error": "Instance not found or not running"}
        try:
            resp = inst.send_command({"type": "abort"})
            if resp and resp.get("success"):
                return {"success": True, "status": "aborted"}
            return {"success": False, "error": resp.get("error", "Unknown") if resp else "No response"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def send_bash(self, agent_id: str, user_id: str, command: str) -> dict:
        """Execute bash in instance workspace."""
        inst = self.get_instance(agent_id, user_id)
        if inst is None or not inst._running:
            return {"success": False, "error": "Instance not found or not running"}
        try:
            resp = inst.send_command({"type": "bash", "command": command})
            if resp and resp.get("success"):
                return {"success": True, "data": resp.get("data", {})}
            return {"success": False, "error": resp.get("error", "Unknown") if resp else "No response"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def subscribe(self, agent_id: str, user_id: str) -> tuple[Queue, str] | None:
        """Subscribe to an instance's events. Returns (queue, error) or None."""
        inst = self.get_instance(agent_id, user_id)
        if inst is None:
            return None
        if not inst._running:
            return None
        return (inst.subscribe(), "")

    def unsubscribe(self, agent_id: str, user_id: str, q: Queue):
        """Unsubscribe from instance events."""
        inst = self.get_instance(agent_id, user_id)
        if inst:
            inst.unsubscribe(q)

    def get_state(self, agent_id: str, user_id: str) -> dict:
        """Get full state of an instance."""
        inst = self.get_instance(agent_id, user_id)
        if inst is None:
            return {"success": False, "error": "Instance not found"}
        if not inst._running:
            return {"success": False, "error": "Instance not running"}
        try:
            resp = inst.send_command({"type": "get_state"})
            if resp and resp.get("success"):
                return {"success": True, "data": resp.get("data", {})}
            return {"success": False, "error": resp.get("error", "Unknown") if resp else "No response"}
        except Exception as e:
            return {"success": False, "error": str(e)}
