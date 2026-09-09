import { ArrowClockwise, CaretDown, CaretUp, CheckCircle, Copy, Plus, Spinner, WarningCircle, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { newId } from "../../uuid";
import {
  generationIntentApi,
  type GenerationAttempt,
  type GenerationAttemptStatus,
  type GenerationControlPackage,
  type GenerationReference,
  type GenerationTask,
  type GenerationTaskStatus,
  type GenerationTaskView,
  type GenerationWorkbench,
} from "./api";

type Draft = Omit<GenerationControlPackage, "id" | "project_id" | "version">;

const initialDraft = (): Draft => ({
  references: [],
  final_prompt: "",
  model: "",
  parameters: {},
  no_bgm: true,
  model_availability: { status: "unavailable", checked_at: new Date().toISOString(), reason: "请先选择已验证可用的模型" },
  estimated_cost_fen: 0,
});

// ─── Generation task status surface ──────────────────────────────────────────

interface TaskStatusProps {
  projectId: string;
  task: GenerationTask;
  attempt: GenerationAttempt | null;
  onRefresh: () => void;
}

const IN_PROGRESS_STATUSES: GenerationAttemptStatus[] = [
  "created", "submitting", "provider_queued", "provider_running",
  "provider_succeeded", "copying_to_tos",
];

function attemptStatusLabel(status: GenerationAttemptStatus): string {
  switch (status) {
    case "created": return "等待执行";
    case "submitting": return "正在提交";
    case "provider_queued": return "供应商队列中";
    case "provider_running": return "供应商生成中";
    case "provider_succeeded": return "供应商完成";
    case "copying_to_tos": return "正在保存媒体";
    case "succeeded": return "生成成功";
    case "failed": return "生成失败";
    case "unknown_outcome": return "提交状态未知（需人工确认）";
    default: return status;
  }
}

function taskStatusLabel(status: GenerationTaskStatus): string {
  switch (status) {
    case "created": return "已创建";
    case "running": return "执行中";
    case "succeeded": return "成功";
    case "failed": return "失败";
    default: return status;
  }
}

export function GenerationTaskStatusPanel({ projectId, task, attempt, onRefresh }: TaskStatusProps): React.JSX.Element {
  const [polling, setPolling] = useState(false);
  const [pollError, setPollError] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shouldPoll = attempt !== null && IN_PROGRESS_STATUSES.includes(attempt.status);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");

  const poll = useCallback(async () => {
    if (!shouldPoll) return;
    setPolling(true);
    setPollError("");
    try {
      await generationIntentApi.getTaskStatus(projectId, task.id);
      onRefresh();
    } catch (reason) {
      setPollError(reason instanceof Error ? reason.message : "刷新失败");
    } finally {
      setPolling(false);
    }
  }, [projectId, task.id, shouldPoll, onRefresh]);

  useEffect(() => {
    if (!shouldPoll) return;
    timerRef.current = setTimeout(() => { void poll(); }, 4_000);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [shouldPoll, poll, attempt?.status, attempt?.updated_at]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const isSucceeded = task.status === "succeeded";
  const isFailed = task.status === "failed";
  const isUnknown = attempt?.status === "unknown_outcome";

  return (
    <div className={`mt-4 rounded-sm border p-4 ${
      isSucceeded ? "border-success/30 bg-success/5" :
      isFailed ? "border-danger/30 bg-danger/5" :
      isUnknown ? "border-warning/30 bg-warning/5" :
      "border-agent/30 bg-agent/5"
    }`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isSucceeded
            ? <CheckCircle className="text-success" />
            : isFailed
            ? <WarningCircle className="text-danger" />
            : polling
            ? <Spinner className="animate-spin text-agent" />
            : <ArrowClockwise className="text-agent" />}
          <strong className="text-sm text-ink-1">
            生成任务 · {taskStatusLabel(task.status)}
          </strong>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onRefresh} icon={<ArrowClockwise />}>
          刷新
        </Button>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <div><dt className="text-ink-3">供应商</dt><dd className="text-ink-1">{task.provider}</dd></div>
        <div><dt className="text-ink-3">任务 ID</dt><dd><button type="button" className="inline-flex items-center gap-1 rounded-sm font-mono text-[11px] text-ink-2 outline-none transition-colors hover:text-accent-text focus-visible:ring-2 focus-visible:ring-accent" title="复制任务 ID" onClick={() => { void navigator.clipboard?.writeText(task.id).then(() => { setCopied(true); setCopyError(""); }).catch(() => setCopyError("复制失败，请手动选择复制")); }}>{copied ? "已复制" : task.id}<Copy aria-hidden="true" className="size-3 shrink-0" /></button>{copyError && <p className="mt-1 text-xs text-warning">{copyError}</p>}</dd></div>
        <div><dt className="text-ink-3">模型</dt><dd className="text-ink-1 truncate font-mono text-xs">{task.model}</dd></div>
        <div><dt className="text-ink-3">禁用背景音乐</dt><dd className="text-ink-1">{task.no_bgm ? "是" : "否"}</dd></div>
        <div><dt className="text-ink-3">预计费用</dt><dd className="text-ink-1">{task.estimated_cost_fen} 分</dd></div>
        <div><dt className="text-ink-3">创建时间</dt><dd className="text-ink-1">{new Date(task.created_at).toLocaleString()}</dd></div>
      </dl>

      {attempt && (
        <div className="mt-3 rounded-sm border border-border-1 bg-surface-1 p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">当前尝试 #{attempt.attempt_no}</p>
          <p className="mt-1 text-sm text-ink-1">{attemptStatusLabel(attempt.status)}</p>
          {attempt.provider_task_id && (
            <p className="mt-1 font-mono text-xs text-ink-3">
              供应商任务：{attempt.provider_task_id}
            </p>
          )}
          {attempt.error_message && (
            <p className="mt-2 text-sm text-danger">
              {attempt.error_code ? `[${attempt.error_code}] ` : ""}{attempt.error_message}
            </p>
          )}
          {isUnknown && (
            <div className="mt-2 rounded-sm bg-warning/10 p-2 text-sm text-warning">
              提交状态未知：当前无法确认供应商是否已接受该任务，请联系管理员确认后再重新提交，以避免重复扣费。
            </div>
          )}
          {attempt.tos_media.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold text-ink-3">已保存媒体 ({attempt.tos_media.length})</p>
              <ul className="mt-1 space-y-1">
                {attempt.tos_media.map((item) => (
                  <li key={item.provider_result_key} className="text-xs">
                    <a href={item.storage_url} target="_blank" rel="noopener noreferrer" className="text-agent underline">
                      {item.object_key}
                    </a>
                    {item.duration_seconds != null && <span className="ml-2 text-ink-3">{item.duration_seconds}s</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pollError && <p className="mt-2 text-xs text-warning">{pollError}</p>}
        </div>
      )}
    </div>
  );
}

// ─── Workbench ────────────────────────────────────────────────────────────────

export function GenerationControlWorkbench({ projectId }: { projectId: string }): React.JSX.Element {
  const [state, setState] = useState<GenerationWorkbench | null>(null);
  const [taskView, setTaskView] = useState<GenerationTaskView | null>(null);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef(newId());
  const confirmKey = useRef(newId());

  const load = useCallback(async () => {
    setError("");
    try {
      const next = await generationIntentApi.workbench(projectId);
      setState(next);
      setDraft(next.control_package ? draftFrom(next.control_package) : initialDraft());
    } catch (reason) {
      setError(message(reason));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const set = <K extends keyof Draft>(field: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [field]: value }));

  function updateReference(index: number, patch: Partial<GenerationReference>): void {
    set("references", draft.references.map((reference, current) =>
      current === index ? { ...reference, ...patch } : reference,
    ));
  }

  function moveReference(index: number, offset: number): void {
    const destination = index + offset;
    if (destination < 0 || destination >= draft.references.length) return;
    const references = [...draft.references];
    const [reference] = references.splice(index, 1);
    references.splice(destination, 0, reference!);
    set("references", references.map((item, position) => ({ ...item, position })));
  }

  function addReference(): void {
    set("references", [
      ...draft.references,
      {
        reference_id: newId(),
        reference_version_id: "",
        label: "",
        reason: "",
        position: draft.references.length,
        capability_snapshot: { version: "", captured_at: new Date().toISOString(), capabilities: [] },
      },
    ]);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const saved = await generationIntentApi.saveControlPackage(projectId, {
        ...draft,
        parameters: normalizeParameters(draft.parameters),
      });
      setState((current) => ({
        control_package: saved.control_package,
        pending_intent: current?.pending_intent ?? null,
      }));
      setDraft(draftFrom(saved.control_package));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createPendingIntent(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const result = await generationIntentApi.createPendingIntent(projectId, key.current);
      if (result.outcome === "created") key.current = newId();
      setState((current) => ({
        control_package: current?.control_package ?? null,
        pending_intent: result.pending_intent,
      }));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function confirmIntent(): Promise<void> {
    if (!state?.pending_intent) return;
    setBusy(true);
    setError("");
    try {
      const view = await generationIntentApi.confirmIntent(
        projectId,
        state.pending_intent.id,
        confirmKey.current,
      );
      // Rotate the confirm key only after a successful confirm to prevent
      // duplicate clicks from creating two tasks.
      confirmKey.current = newId();
      setTaskView(view);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  const refreshTask = useCallback(async () => {
    if (!taskView) return;
    try {
      const next = await generationIntentApi.getTaskStatus(projectId, taskView.task.id);
      setTaskView(next);
    } catch (reason) {
      setError(message(reason));
    }
  }, [projectId, taskView]);

  const unavailable = draft.model_availability.status === "unavailable";

  return (
    <section aria-label="生成控制包" className="mt-6 rounded-md border border-border-1 bg-surface-1 p-5">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border-1 pb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-agent">Traceable generation</p>
          <h2 className="mt-1 text-xl font-semibold text-ink-1">参考控制包与待确认生成</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            保存后锁定每个参考的精确版本、采用原因和能力快照。创建的仅是待确认意图，不会发送供应商请求、上传输入、预留资源或扣费。
            确认后由后台工作器执行 Seedance 2.5 生成，禁用背景音乐，保留对话/旁白/环境音效。
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void load()} icon={<ArrowClockwise />}>
          刷新并恢复
        </Button>
      </header>

      {error ? (
        <p role="alert" className="mt-4 flex items-center gap-2 rounded-sm bg-danger/10 p-3 text-sm text-danger">
          <WarningCircle />{error}
        </p>
      ) : null}

      {state === null ? (
        <p className="mt-5 text-sm text-ink-2">正在恢复控制包…</p>
      ) : (
        <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <label className="block text-sm font-medium text-ink-1">
              最终提示词
              <textarea
                value={draft.final_prompt}
                disabled={busy}
                onChange={(event) => set("final_prompt", event.target.value)}
                className="mt-1 min-h-28 w-full rounded-sm border border-border-2 bg-surface-0 p-3 font-mono text-sm"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium text-ink-1">
                模型
                <input
                  value={draft.model}
                  disabled={busy}
                  onChange={(event) => set("model", event.target.value)}
                  className="mt-1 min-h-10 w-full rounded-sm border border-border-2 bg-surface-0 px-3"
                />
              </label>
              <label className="text-sm font-medium text-ink-1">
                预计费用（分）
                <input
                  type="number"
                  min="0"
                  value={draft.estimated_cost_fen}
                  disabled={busy}
                  onChange={(event) => set("estimated_cost_fen", Number(event.target.value))}
                  className="mt-1 min-h-10 w-full rounded-sm border border-border-2 bg-surface-0 px-3"
                />
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium text-ink-1">
                模型能力状态
                <select
                  value={draft.model_availability.status}
                  disabled={busy}
                  onChange={(event) =>
                    set("model_availability", {
                      ...draft.model_availability,
                      status: event.target.value as "available" | "unavailable",
                      checked_at: new Date().toISOString(),
                    })
                  }
                  className="mt-1 min-h-10 w-full rounded-sm border border-border-2 bg-surface-0 px-3"
                >
                  <option value="available">可用</option>
                  <option value="unavailable">不可用</option>
                </select>
              </label>
              <label className="text-sm font-medium text-ink-1">
                不可用说明
                <input
                  value={draft.model_availability.reason ?? ""}
                  disabled={busy}
                  onChange={(event) =>
                    set("model_availability", {
                      ...draft.model_availability,
                      reason: event.target.value || undefined,
                    })
                  }
                  className="mt-1 min-h-10 w-full rounded-sm border border-border-2 bg-surface-0 px-3"
                />
              </label>
            </div>

            {unavailable ? (
              <p role="status" className="rounded-sm bg-warning/10 p-3 text-sm text-warning">
                当前模型不可用：{draft.model_availability.reason ?? "请刷新能力快照"}。不能创建待确认意图。
              </p>
            ) : null}

            <label className="flex items-center gap-3 rounded-sm border border-border-1 p-3 text-sm text-ink-1">
              <input
                type="checkbox"
                checked={draft.no_bgm}
                disabled={busy}
                onChange={(event) => set("no_bgm", event.target.checked)}
              />
              禁用背景音乐（默认开启；关闭无需再次确认）
            </label>

            <label className="block text-sm font-medium text-ink-1">
              最终参数（JSON）
              <textarea
                value={JSON.stringify(draft.parameters, null, 2)}
                disabled={busy}
                onChange={(event) => {
                  try {
                    set("parameters", JSON.parse(event.target.value) as Record<string, unknown>);
                  } catch {
                    // Keep the previous valid value until JSON is complete.
                  }
                }}
                className="mt-1 min-h-24 w-full rounded-sm border border-border-2 bg-surface-0 p-3 font-mono text-sm"
              />
            </label>

            <div className="flex flex-wrap gap-3">
              <Button type="button" disabled={busy} onClick={() => void save()}>
                {busy ? "保存中…" : "保存控制包"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy || unavailable || !state.control_package}
                onClick={() => void createPendingIntent()}
              >
                {busy ? "处理中…" : "创建待确认意图"}
              </Button>
            </div>
          </div>

          <aside className="rounded-sm border border-border-1 bg-surface-0 p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-ink-1">有序参考</h3>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={addReference} icon={<Plus />}>
                添加
              </Button>
            </div>
            <p className="mt-1 text-xs text-ink-2">每项必须锁定到不可变版本。</p>
            <ol className="mt-4 space-y-3">
              {draft.references.map((reference, index) => (
                <li key={reference.reference_id} className="rounded-sm border border-border-1 p-3">
                  <div className="mb-2 flex justify-between gap-1">
                    <strong className="text-sm text-ink-1">#{index + 1}</strong>
                    <span className="flex gap-1">
                      <button
                        type="button"
                        aria-label="上移参考"
                        disabled={busy || index === 0}
                        onClick={() => moveReference(index, -1)}
                        className="rounded p-1 hover:bg-surface-1 disabled:opacity-30"
                      >
                        <CaretUp size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label="下移参考"
                        disabled={busy || index === draft.references.length - 1}
                        onClick={() => moveReference(index, 1)}
                        className="rounded p-1 hover:bg-surface-1 disabled:opacity-30"
                      >
                        <CaretDown size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label="删除参考"
                        disabled={busy}
                        onClick={() =>
                          set(
                            "references",
                            draft.references.filter((_, i) => i !== index).map((r, pos) => ({ ...r, position: pos })),
                          )
                        }
                        className="rounded p-1 text-danger hover:bg-danger/10 disabled:opacity-30"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  </div>
                  <label className="block text-xs font-medium text-ink-2">
                    参考版本 ID
                    <input
                      value={reference.reference_version_id}
                      disabled={busy}
                      onChange={(event) => updateReference(index, { reference_version_id: event.target.value })}
                      className="mt-0.5 w-full rounded border border-border-2 bg-surface-1 px-2 py-1 font-mono text-xs"
                      placeholder="UUID"
                    />
                  </label>
                  <label className="mt-1 block text-xs font-medium text-ink-2">
                    标签
                    <input
                      value={reference.label}
                      disabled={busy}
                      onChange={(event) => updateReference(index, { label: event.target.value })}
                      className="mt-0.5 w-full rounded border border-border-2 bg-surface-1 px-2 py-1 text-xs"
                    />
                  </label>
                  <label className="mt-1 block text-xs font-medium text-ink-2">
                    采用原因
                    <textarea
                      value={reference.reason}
                      disabled={busy}
                      onChange={(event) => updateReference(index, { reason: event.target.value })}
                      className="mt-0.5 min-h-12 w-full rounded border border-border-2 bg-surface-1 px-2 py-1 text-xs"
                    />
                  </label>
                </li>
              ))}
            </ol>
          </aside>

          {/* Pending intent review */}
          {state.pending_intent ? (
            <div className="lg:col-span-2 rounded-sm border border-agent/30 bg-agent/5 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <strong className="text-sm text-ink-1">待确认意图（需人工确认后生成）</strong>
                  <p className="mt-1 text-sm text-ink-2">
                    控制包 v{state.pending_intent.control_package_version} · {state.pending_intent.model}
                    {" · "}禁用背景音乐：{state.pending_intent.no_bgm ? "是" : "否"}
                    {" · "}预计费用：{state.pending_intent.estimated_cost_fen} 分
                  </p>
                  <p className="mt-1 text-xs text-ink-3">
                    这是您审阅的最后一步。确认后后台工作器将向 Seedance 2.5 提交付费请求，
                    生成原生音频（对话/旁白/音效，无背景音乐）。
                  </p>
                </div>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void confirmIntent()}
                >
                  {busy ? "确认中…" : "✓ 确认并启动生成"}
                </Button>
              </div>
            </div>
          ) : null}

          {/* Generation task status */}
          {taskView ? (
            <div className="lg:col-span-2">
              <GenerationTaskStatusPanel
                projectId={projectId}
                task={taskView.task}
                attempt={taskView.latest_attempt}
                onRefresh={() => void refreshTask()}
              />
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function draftFrom(controlPackage: GenerationControlPackage): Draft {
  const { id: _id, project_id: _projectId, version: _version, ...draft } = controlPackage;
  return {
    ...draft,
    references: controlPackage.references.map((reference) => ({
      ...reference,
      capability_snapshot: {
        ...reference.capability_snapshot,
        capabilities: [...reference.capability_snapshot.capabilities],
      },
    })),
    parameters: { ...controlPackage.parameters },
  };
}

function normalizeParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  return { ...parameters };
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "生成控制包操作失败，请刷新后重试";
}
