"""Run manifest domain model used as the single-run source of truth."""

from datetime import datetime, timezone
from enum import Enum
import sys
from uuid import uuid4

from pydantic import BaseModel, Field


if sys.version_info >= (3, 11):
    from enum import StrEnum
else:
    # Python 3.10 compatibility for the string semantics provided by StrEnum.
    class StrEnum(str, Enum):
        def __str__(self) -> str:
            return str(self.value)


class TaskStatus(StrEnum):
    """Task lifecycle states stored in the manifest."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class RunTask(BaseModel):
    """Current state for one pipeline task."""

    name: str
    status: TaskStatus = TaskStatus.PENDING
    artifact_path: str | None = None
    error: str | None = None


class RunEvent(BaseModel):
    """Append-only event for lightweight audit and resume diagnostics."""

    task: str
    event: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    detail: str | None = None


class RunManifest(BaseModel):
    """Manifest persisted at `run-manifest.json` for status and recovery."""

    run_id: str
    provider: str
    input_file: str
    tasks: list[RunTask]
    events: list[RunEvent] = Field(default_factory=list)

    @classmethod
    def new(cls, provider: str, input_file: str, tasks: list[RunTask]) -> "RunManifest":
        return cls(run_id=f"run-{uuid4().hex[:12]}", provider=provider, input_file=input_file, tasks=tasks)

    def mark_succeeded(self, task_name: str, artifact_path: str) -> None:
        for task in self.tasks:
            if task.name == task_name:
                task.status = TaskStatus.SUCCEEDED
                task.artifact_path = artifact_path
                self.events.append(RunEvent(task=task_name, event="succeeded", detail=artifact_path))
                return
        raise ValueError(f"Unknown task: {task_name}")
