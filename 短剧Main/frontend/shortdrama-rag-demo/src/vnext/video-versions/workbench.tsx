import { ArrowClockwise, CheckCircle, FilmStrip, GitBranch, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/primitives";
import { newId } from "../../uuid";
import { generationIntentApi, type GenerationControlPackage, type GenerationTaskView, type PendingGenerationIntent } from "../generation/api";
import { GenerationTaskStatusPanel } from "../generation/workbench";
import { videoVersionApi, type VideoChangeDraft, type VideoChangeType, type VideoVersion } from "./api";

// ─── Change draft editor state ────────────────────────────────────────────────

interface DraftEditor {
  origin: VideoVersion;
  changeType: "modify" | "extend";
  finalPrompt: string;
  model: string;
  parametersText: string;
  noBgm: boolean;
  estimatedCostFen: number;
  availability: "available" | "unavailable";
  availabilityReason: string;
}

interface DraftReview {
  draft: VideoChangeDraft;
  intent: PendingGenerationIntent;
  controlPackage: GenerationControlPackage | null;
}

function editorFrom(origin: VideoVersion, changeType: "modify" | "extend"): DraftEditor {
  return {
    origin,
    changeType,
    finalPrompt: origin.prompt,
    model: origin.model,
    parametersText: JSON.stringify(origin.parameters, null, 2),
    noBgm: true,
    estimatedCostFen: origin.estimated_cost_fen,
    availability: "unavailable",
    availabilityReason: "请确认模型能力后切换为可用",
  };
}

const CHANGE_TYPE_LABELS: Record<VideoChangeType, string> = { register: "首版注册", modify: "修改", extend: "续写" };

export function VideoVersionWorkbench({ projectId }: { projectId: string }): React.JSX.Element {
  const [versions, setVersions] = useState<VideoVersion[] | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [registerTaskId, setRegisterTaskId] = useState("");
  const [editor, setEditor] = useState<DraftEditor | null>(null);
  const [review, setReview] = useState<DraftReview | null>(null);
  const [taskView, setTaskView] = useState<GenerationTaskView | null>(null);
  const draftKey = useRef(newId());
  const confirmKey = useRef(newId());

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const { items } = await videoVersionApi.listVersions(projectId);
      setVersions(items);
    } catch (reason) {
      setLoadError(message(reason));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  async function register(): Promise<void> {
    const taskId = registerTaskId.trim();
    if (!taskId || busy) return;
    setBusy(true);
    setError("");
    try {
      await videoVersionApi.attachVersion(projectId, taskId);
      setRegisterTaskId("");
      await load();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createDraft(): Promise<void> {
    if (!editor || busy) return;
    let parameters: Record<string, unknown>;
    try {
      parameters = JSON.parse(editor.parametersText) as Record<string, unknown>;
    } catch {
      setError("最终参数不是合法 JSON，请修正后再创建草稿");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await videoVersionApi.createChangeDraft(projectId, editor.origin.id, {
        change_type: editor.changeType,
        client_idempotency_key: draftKey.current,
        references: [{
          reference_id: editor.origin.id,
          reference_version_id: editor.origin.id,
          label: `原视频段 v${editor.origin.version_no}`,
          reason: "修改或续写的来源",
          position: 0,
          capability_snapshot: {
            version: "vnext-video-version",
            captured_at: new Date().toISOString(),
            capabilities: ["video-reference"],
          },
        }],
        final_prompt: editor.finalPrompt,
        model: editor.model,
        parameters,
        no_bgm: editor.noBgm,
        model_availability: {
          status: editor.availability,
          checked_at: new Date().toISOString(),
          ...(editor.availability === "unavailable" && editor.availabilityReason.trim()
            ? { reason: editor.availabilityReason.trim() }
            : {}),
        },
        estimated_cost_fen: editor.estimatedCostFen,
      });
      if (result.outcome === "created") draftKey.current = newId();
      setEditor(null);
      setReview({ draft: result.draft, intent: result.pending_intent, controlPackage: result.control_package });
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    if (!review || busy) return;
    setBusy(true);
    setError("");
    try {
      const view = await generationIntentApi.confirmIntent(projectId, review.intent.id, confirmKey.current);
      // Rotate the confirm key only after a successful confirm: one confirmed
      // click creates exactly one paid task; duplicate clicks replay it.
      confirmKey.current = newId();
      setReview(null);
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
      setTaskView(await generationIntentApi.getTaskStatus(projectId, taskView.task.id));
    } catch (reason) {
      setError(message(reason));
    }
  }, [projectId, taskView]);

  async function saveNewVersion(): Promise<void> {
    if (!taskView || busy) return;
    setBusy(true);
    setError("");
    try {
      await videoVersionApi.attachVersion(projectId, taskView.task.id);
      setTaskView(null);
      await load();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  const chains = groupChains(versions ?? []);

  return (
    <section aria-label="视频段版本" className="mt-6 rounded-md border border-border-1 bg-surface-1 p-5">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border-1 pb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-agent">Immutable video versions</p>
          <h2 className="mt-1 text-xl font-semibold text-ink-1">视频段版本链</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            已保存的视频段保持不可变：修改或续写会生成新的待确认意图，人工确认后才创建一次付费任务；
            成功后把结果保存为新版本，原版本的媒体和元数据不会被覆盖。失败任务不会产生新版本，也不会自动重试。
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

      {versions === null && !loadError ? (
        <LoadingState label="正在恢复视频段版本链" />
      ) : loadError && versions === null ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : (
        <div className="mt-5 space-y-5">
          <form
            className="flex flex-wrap items-end gap-3 rounded-sm border border-border-1 bg-surface-0 p-4"
            onSubmit={(event) => { event.preventDefault(); void register(); }}
          >
            <label className="min-w-64 flex-1 text-sm font-medium text-ink-1">
              从成功的生成任务注册视频段
              <input
                value={registerTaskId}
                disabled={busy}
                onChange={(event) => setRegisterTaskId(event.target.value)}
                placeholder="生成任务 ID（在上方生成任务卡片点『任务 ID』可复制）"
                className="mt-1 min-h-10 w-full rounded-sm border border-border-2 bg-surface-1 px-3 font-mono text-xs"
              />
            </label>
            <Button type="submit" disabled={busy || !registerTaskId.trim()} icon={<FilmStrip />}>
              {busy ? "注册中…" : "注册为视频段"}
            </Button>
          </form>

          {editor ? (
            <div className="rounded-sm border border-agent/30 bg-agent/5 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <strong className="text-sm text-ink-1">
                    {editor.changeType === "modify" ? "修改" : "续写"}草稿 · 基于 v{editor.origin.version_no}（{CHANGE_TYPE_LABELS[editor.origin.change_type]}）
                  </strong>
                  <p className="mt-1 text-xs text-ink-2">
                    已预填原版本的实际输入，可调整后创建草稿。创建草稿不会调用供应商；确认后才创建一次付费任务。
                  </p>
                </div>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditor(null)}>取消</Button>
              </div>
              <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="space-y-3">
                  <label className="block text-sm font-medium text-ink-1">
                    最终提示词
                    <textarea
                      value={editor.finalPrompt}
                      disabled={busy}
                      onChange={(event) => setEditor({ ...editor, finalPrompt: event.target.value })}
                      className="mt-1 min-h-24 w-full rounded-sm border border-border-2 bg-surface-0 p-3 font-mono text-sm"
                    />
                  </label>
                  <label className="block text-sm font-medium text-ink-1">
                    最终参数（JSON）
                    <textarea
                      value={editor.parametersText}
                      disabled={busy}
                      onChange={(event) => setEditor({ ...editor, parametersText: event.target.value })}
                      className="mt-1 min-h-20 w-full rounded-sm border border-border-2 bg-surface-0 p-3 font-mono text-sm"
                    />
                  </label>
                </div>
                <div className="space-y-3">
                  <label className="block text-sm font-medium text-ink-1">
                    模型
                    <input
                      value={editor.model}
                      disabled={busy}
                      onChange={(event) => setEditor({ ...editor, model: event.target.value })}
                      className="mt-1 min-h-10 w-full rounded-sm border border-border-2 bg-surface-0 px-3"
                    />
                  </label>
                  <label className="block text-sm font-medium text-ink-1">
                    预计费用（分）
                    <input
                      type="number"
                      min="0"
                      value={editor.estimatedCostFen}
                      disabled={busy}
                      onChange={(event) => setEditor({ ...editor, estimatedCostFen: Number(event.target.value) })}
                      className="mt-1 min-h-10 w-full rounded-sm border border-border-2 bg-surface-0 px-3"
                    />
                  </label>
                  <label className="block text-sm font-medium text-ink-1">
                    模型能力状态
                    <select
                      value={editor.availability}
                      disabled={busy}
                      onChange={(event) => setEditor({ ...editor, availability: event.target.value as "available" | "unavailable" })}
                      className="mt-1 min-h-10 w-full rounded-sm border border-border-2 bg-surface-0 px-3"
                    >
                      <option value="available">可用</option>
                      <option value="unavailable">不可用</option>
                    </select>
                  </label>
                  {editor.availability === "unavailable" ? (
                    <label className="block text-sm font-medium text-ink-1">
                      不可用说明
                      <input
                        value={editor.availabilityReason}
                        disabled={busy}
                        onChange={(event) => setEditor({ ...editor, availabilityReason: event.target.value })}
                        className="mt-1 min-h-10 w-full rounded-sm border border-border-2 bg-surface-0 px-3"
                      />
                    </label>
                  ) : null}
                  <label className="flex items-center gap-2 text-sm text-ink-1">
                    <input
                      type="checkbox"
                      checked={editor.noBgm}
                      disabled={busy}
                      onChange={(event) => setEditor({ ...editor, noBgm: event.target.checked })}
                    />
                    禁用背景音乐
                  </label>
                  <Button
                    type="button"
                    disabled={busy || editor.availability === "unavailable"}
                    onClick={() => void createDraft()}
                  >
                    {busy ? "创建中…" : `创建${editor.changeType === "modify" ? "修改" : "续写"}草稿`}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {review ? (
            <div className="rounded-sm border border-agent/30 bg-agent/5 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <strong className="text-sm text-ink-1">
                    待确认{review.draft.change_type === "modify" ? "修改" : "续写"}意图（需人工确认后生成）
                  </strong>
                  <p className="mt-1 text-sm text-ink-2">
                    控制包 v{review.intent.control_package_version} · {review.intent.model}
                    {" · "}禁用背景音乐：{review.intent.no_bgm ? "是" : "否"}
                    {" · "}预计费用：{review.intent.estimated_cost_fen} 分
                    {" · "}参考：{review.intent.references.length} 项
                  </p>
                  <p className="mt-1 text-sm text-ink-2">
                    模型能力：{review.controlPackage
                      ? review.controlPackage.model_availability.status === "available" ? "可用" : `不可用（${review.controlPackage.model_availability.reason ?? "请刷新能力快照"}）`
                      : `见控制包 v${review.intent.control_package_version} 能力快照`}
                  </p>
                  <p className="mt-2 rounded-sm bg-surface-0 p-2 font-mono text-xs text-ink-2">{review.intent.final_prompt}</p>
                  <p className="mt-1 text-xs text-ink-3">
                    这是您审阅的最后一步。确认后后台工作器将提交一次付费请求；不会自动重试，失败只记录失败尝试，不影响原版本。
                  </p>
                </div>
                <Button type="button" disabled={busy} onClick={() => void confirm()}>
                  {busy ? "确认中…" : "✓ 确认并启动生成"}
                </Button>
              </div>
            </div>
          ) : null}

          {taskView ? (
            <div>
              <GenerationTaskStatusPanel
                projectId={projectId}
                task={taskView.task}
                attempt={taskView.latest_attempt}
                onRefresh={() => void refreshTask()}
              />
              {taskView.task.status === "succeeded" ? (
                <div className="mt-3 flex items-center gap-3 rounded-sm border border-success/30 bg-success/5 p-3">
                  <CheckCircle className="text-success" />
                  <p className="flex-1 text-sm text-ink-1">生成成功。把结果保存为新版本后，版本链即可在刷新后完整恢复。</p>
                  <Button type="button" disabled={busy} onClick={() => void saveNewVersion()} icon={<GitBranch />}>
                    {busy ? "保存中…" : "保存为新版本"}
                  </Button>
                </div>
              ) : null}
              {taskView.task.status === "failed" ? (
                <p role="status" className="mt-3 rounded-sm bg-warning/10 p-3 text-sm text-warning">
                  任务失败：只记录了失败的尝试，没有产生新版本，原版本保持不变。系统不会自动付费重试；请回到版本链重新发起修改或续写。
                </p>
              ) : null}
            </div>
          ) : null}

          {chains.length === 0 ? (
            <EmptyState
              title="还没有已保存的视频段"
              description="从上方输入一个已成功的生成任务 ID 注册版本 1；之后可以在其上发起修改或续写。"
              icon={<FilmStrip />}
            />
          ) : (
            <ol className="space-y-4">
              {chains.map((chain) => (
                <li key={chain[0]!.chain_id} className="rounded-sm border border-border-1 bg-surface-0 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">
                    版本链 {chain[0]!.chain_id.slice(0, 8)}… · 共 {chain.length} 版
                  </p>
                  <ol className="mt-3 space-y-3">
                    {chain.map((version) => (
                      <li key={version.id} className="rounded-sm border border-border-1 bg-surface-1 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-ink-1">
                              v{version.version_no} · {CHANGE_TYPE_LABELS[version.change_type]}
                              {version.origin_version_id ? <span className="ml-2 text-xs font-normal text-ink-3">基于 v{version.version_no - 1}</span> : null}
                            </p>
                            <p className="mt-1 truncate font-mono text-xs text-ink-2" title={version.prompt}>{version.prompt}</p>
                            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                              <div><dt className="text-ink-3">模型</dt><dd className="truncate text-ink-1">{version.model}</dd></div>
                              <div><dt className="text-ink-3">供应商</dt><dd className="text-ink-1">{version.provider}</dd></div>
                              <div><dt className="text-ink-3">预计费用</dt><dd className="text-ink-1">{version.estimated_cost_fen} 分</dd></div>
                              <div><dt className="text-ink-3">实际费用</dt><dd className="text-ink-1">{version.actual_cost_fen !== null ? `${version.actual_cost_fen} 分` : "未回报"}</dd></div>
                            </dl>
                            <p className="mt-1 text-xs text-ink-3">
                              控制包 v{version.control_package_version} · 任务 {version.source_task_id.slice(0, 8)}… · {new Date(version.created_at).toLocaleString("zh-CN")}
                            </p>
                            {version.tos_media.length > 0 ? (
                              <ul className="mt-2 space-y-1">
                                {version.tos_media.map((item) => (
                                  <li key={item.provider_result_key} className="text-xs">
                                    <a href={item.storage_url} target="_blank" rel="noopener noreferrer" className="text-agent underline">
                                      {item.object_key}
                                    </a>
                                    {item.duration_seconds != null ? <span className="ml-2 text-ink-3">{item.duration_seconds}s</span> : null}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => { setReview(null); setEditor(editorFrom(version, "modify")); }}>
                              发起修改
                            </Button>
                            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => { setReview(null); setEditor(editorFrom(version, "extend")); }}>
                              发起续写
                            </Button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function groupChains(versions: VideoVersion[]): VideoVersion[][] {
  const byChain = new Map<string, VideoVersion[]>();
  for (const version of versions) {
    const chain = byChain.get(version.chain_id) ?? [];
    chain.push(version);
    byChain.set(version.chain_id, chain);
  }
  return [...byChain.values()].map((chain) => [...chain].sort((left, right) => left.version_no - right.version_no));
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "视频段版本操作失败，请刷新后重试";
}
