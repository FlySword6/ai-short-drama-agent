"""In-process task state machine for multi-turn production workflows."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
import os
from threading import Lock
from uuid import uuid4


_TERMINAL_STATES = {"completed", "failed", "cancelled"}


@dataclass
class TaskStep:
    """One observable step in a user-facing task plan."""

    step_id: str
    title: str
    state: str
    requires_confirmation: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Task:
    """A task with explicit states rather than an implicit LLM-only plan."""

    task_id: str
    workflow: str
    state: str
    card_id: str
    steps: list[TaskStep] = field(default_factory=list)
    error: str = ""

    def to_dict(self) -> dict:
        return {
            **asdict(self),
            "steps": [step.to_dict() for step in self.steps],
        }


class TaskStateMachine:
    """Coordinates the draft → confirm → generate lifecycle for an asset task."""

    def __init__(
        self,
        redis_url: str | None = None,
        redis_password: str | None = None,
        redis_username: str | None = None,
    ) -> None:
        self._tasks: dict[str, Task] = {}
        self._task_id_by_card_id: dict[str, str] = {}
        self._lock = Lock()
        self._redis = None
        if redis_url:
            try:
                import redis

                self._redis = redis.Redis.from_url(
                    redis_url,
                    decode_responses=True,
                    password=redis_password or None,
                    username=redis_username or None,
                )
                self._redis.ping()
            except Exception as exc:
                raise RuntimeError(
                    "TASK_REDIS_URL connection failed "
                    f"({exc.__class__.__name__}): {exc}"
                ) from exc

    @classmethod
    def from_environment(cls) -> "TaskStateMachine":
        """Select Redis persistence when ``TASK_REDIS_URL`` is configured."""

        return cls(
            os.getenv("TASK_REDIS_URL", "").strip() or None,
            os.getenv("TASK_REDIS_PASSWORD", "").strip() or None,
            os.getenv("TASK_REDIS_USERNAME", "").strip() or None,
        )

    def create_asset_task(self, card_id: str) -> Task:
        """Create a task that pauses before any billable image generation."""

        with self._lock:
            task = Task(
                task_id=f"task_{uuid4().hex[:12]}",
                workflow="asset_generation",
                state="awaiting_confirmation",
                card_id=card_id,
                steps=[
                    TaskStep("draft_card", "生成资产卡", "completed"),
                    TaskStep(
                        "confirm_card", "用户确认资产卡", "awaiting_confirmation",
                        requires_confirmation=True,
                    ),
                    TaskStep("generate_asset", "生成资产图片", "pending"),
                ],
            )
            self._save_task(task)
            self._save_card_mapping(card_id, task.task_id)
            return task

    def begin_asset_generation(self, card_id: str) -> Task:
        """Advance only a user-confirmed task into its generation step."""

        with self._lock:
            return self._transition_for_card(card_id, self._begin_generation)

    def complete_asset_generation(self, card_id: str) -> Task:
        """Mark a successfully generated asset task complete."""

        with self._lock:
            return self._transition_for_card(card_id, self._complete_generation)

    def fail_asset_generation(self, card_id: str, error: str) -> Task:
        """Record a terminal failure so a user can create a corrected new card."""

        with self._lock:
            return self._transition_for_card(
                card_id, lambda task: self._fail_generation(task, error),
            )

    def get_task(self, task_id: str) -> Task:
        with self._lock:
            try:
                return self._load_task(task_id)
            except KeyError as exc:
                raise ValueError("task not found") from exc

    def _get_task_for_card(self, card_id: str) -> Task:
        task_id = self._load_card_mapping(card_id)
        if task_id is None:
            raise ValueError("asset task not found; create an asset card first")
        return self._load_task(task_id)

    def _transition_for_card(self, card_id: str, operation) -> Task:
        """Serialize transitions for one card across multiple AgentKit workers."""

        if self._redis is None:
            task = self._get_task_for_card(card_id)
            operation(task)
            self._save_task(task)
            return task

        with self._redis.lock(f"shortdrama:task:lock:{card_id}", timeout=15, blocking_timeout=5):
            task = self._get_task_for_card(card_id)
            operation(task)
            self._save_task(task)
            return task

    @staticmethod
    def _begin_generation(task: Task) -> None:
        if task.state == "completed":
            return
        if task.state != "awaiting_confirmation":
            raise ValueError(f"task cannot be confirmed from {task.state}")
        task.steps[1].state = "completed"
        task.steps[2].state = "running"
        task.state = "running"

    @staticmethod
    def _complete_generation(task: Task) -> None:
        if task.state == "completed":
            return
        if task.state != "running":
            raise ValueError(f"task cannot complete from {task.state}")
        task.steps[2].state = "completed"
        task.state = "completed"

    @staticmethod
    def _fail_generation(task: Task, error: str) -> None:
        if task.state not in _TERMINAL_STATES:
            task.steps[2].state = "failed"
            task.state = "failed"
            task.error = error

    def _save_task(self, task: Task) -> None:
        if self._redis is None:
            self._tasks[task.task_id] = task
            return
        self._redis.set(f"shortdrama:task:{task.task_id}", json.dumps(task.to_dict()))

    def _load_task(self, task_id: str) -> Task:
        if self._redis is None:
            try:
                return self._tasks[task_id]
            except KeyError as exc:
                raise ValueError("task not found") from exc
        raw = self._redis.get(f"shortdrama:task:{task_id}")
        if raw is None:
            raise ValueError("task not found")
        data = json.loads(raw)
        data["steps"] = [TaskStep(**step) for step in data["steps"]]
        return Task(**data)

    def _save_card_mapping(self, card_id: str, task_id: str) -> None:
        if self._redis is None:
            self._task_id_by_card_id[card_id] = task_id
            return
        self._redis.set(f"shortdrama:task:card:{card_id}", task_id)

    def _load_card_mapping(self, card_id: str) -> str | None:
        if self._redis is None:
            return self._task_id_by_card_id.get(card_id)
        return self._redis.get(f"shortdrama:task:card:{card_id}")
