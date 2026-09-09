import { Background, Controls, ReactFlow, type Edge, type Node, type NodeChange, applyNodeChanges } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowClockwise, Plus, Sparkle, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { navigate, vnextProjectPath } from "../routing";
import { newId } from "../uuid";
import { Button } from "../components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/primitives";
import { type VnextGraphDocument, vnextApi, VnextApiError, type VnextLegacyAsset, type VnextProject } from "./api";
import { VnextCanvasSync, type VnextCanvasView, type VnextSaveStatus } from "./canvas-sync";
import { ScriptWorkbench } from "./script/workbench";
import { GenerationControlWorkbench } from "./generation/workbench";
import { VideoVersionWorkbench } from "./video-versions/workbench";

const EMPTY_DOCUMENT: VnextGraphDocument = { schema_version: 1, nodes: [], edges: [] };
const AGENT_FACT_REFRESH_MS = 3_000;

export function VnextProjectsPage(): React.JSX.Element {
  const [projects, setProjects] = useState<VnextProject[] | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const load = useCallback(() => {
    setError("");
    void vnextApi.listProjects().then(({ items, next_cursor }) => {
      setProjects(items);
      setNextCursor(next_cursor);
    }).catch((reason: unknown) => setError(message(reason)));
  }, []);
  useEffect(load, [load]);

  async function loadMore(): Promise<void> {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const page = await vnextApi.listProjects({ cursor: nextCursor });
      setProjects((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoadingMore(false);
    }
  }

  async function create(): Promise<void> {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError("");
    try {
      const project = await vnextApi.createProject(name.trim());
      navigate(vnextProjectPath(project.id));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setCreating(false);
    }
  }

  if (projects === null && !error) return <LoadingState label="正在读取 vNext 项目" />;
  if (error && projects === null) return <ErrorState message={error} onRetry={load} />;
  return <section className="mx-auto flex max-w-[1180px] flex-col gap-8 py-6">
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border-1 pb-6">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-agent">vNext Studio</p><h1 className="mt-2 text-3xl font-semibold text-ink-1">持续画布项目</h1><p className="mt-2 max-w-xl text-sm text-ink-2">独立于 Lite 的项目事实与画布修订。直接操作和 Agent 增量将写入同一份 GraphDocument。</p></div>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void create(); }}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="输入新项目名称" className="min-h-10 w-60 rounded-sm border border-border-2 bg-surface-1 px-3 text-sm" /><Button type="submit" disabled={creating || !name.trim()} icon={<Plus />}>{creating ? "正在创建" : "创建 vNext 项目"}</Button></form>
    </header>
    {error ? <p role="alert" className="rounded-sm bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}
    {projects?.length === 0 ? <EmptyState title="还没有 vNext 项目" description="创建项目后会打开一张可持续恢复的创作画布。" icon={<Sparkle />} /> : <>
      <div className="grid gap-3 md:grid-cols-2">{projects?.map((project) => <button type="button" key={project.id} onClick={() => navigate(vnextProjectPath(project.id))} className="rounded-md border border-border-1 bg-surface-1 p-5 text-left transition hover:border-agent"><strong className="text-base text-ink-1">{project.name}</strong><p className="mt-2 text-xs text-ink-2">持续画布 · 最近更新 {new Date(project.updated_at).toLocaleString("zh-CN")}</p></button>)}</div>
      {nextCursor ? <div className="flex justify-center"><Button variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在加载" : "加载更多"}</Button></div> : null}
    </>}
    <LegacyLibrary />
  </section>;
}

function LegacyLibrary(): React.JSX.Element {
  const [assets, setAssets] = useState<VnextLegacyAsset[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    void vnextApi.legacyLibrary().then(({ items }) => setAssets(items)).catch((reason: unknown) => setError(message(reason)));
  }, []);
  useEffect(load, [load]);
  async function retry(assetId: string): Promise<void> {
    setError("");
    try {
      const { asset } = await vnextApi.retryLegacyRegistration(assetId);
      setAssets((current) => current?.map((item) => item.id === asset.id ? asset : item) ?? current);
    } catch (reason) { setError(message(reason)); }
  }
  return <section className="rounded-md border border-border-1 bg-surface-1 p-5">
    <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-agent">旧系统素材库</p><h2 className="mt-2 text-xl font-semibold text-ink-1">已导入的非真人参考素材</h2><p className="mt-1 text-sm text-ink-2">快照素材独立于 vNext 项目，不会自动挂载到任何项目。</p></div>
    {error ? <div className="mt-4 flex flex-wrap items-center gap-3 rounded-sm bg-danger/10 px-3 py-2 text-sm text-danger"><span role="alert">{error}</span><Button variant="secondary" size="sm" onClick={load}>重新读取</Button></div> : null}
    {assets === null && !error ? <p className="mt-4 text-sm text-ink-2">正在读取素材库…</p> : assets?.length === 0 ? <p className="mt-4 text-sm text-ink-2">尚未导入快照素材。</p> : <ul className="mt-4 divide-y divide-border-1">{assets?.map((asset) => <li key={asset.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><strong className="text-sm text-ink-1">{asset.name}</strong><p className="mt-1 text-xs text-ink-2">{legacyKindLabel(asset.asset_kind)} · {legacyMediaLabel(asset.media_kind)} · 审核{legacyReviewLabel(asset.review_status)} · 注册{legacyRegistrationLabel(asset.registration_status)}</p>{asset.registration_failure_reason ? <p className="mt-1 text-xs text-danger">{legacyFailureReason(asset)}</p> : null}</div>{asset.registration_status === "failed" || asset.registration_status === "processing" || asset.registration_status === "unknown" ? <Button variant="secondary" size="sm" icon={<ArrowClockwise />} onClick={() => void retry(asset.id)}>恢复登记</Button> : null}</li>)}</ul>}
  </section>;
}

const LEGACY_KIND_LABELS: Record<VnextLegacyAsset["asset_kind"], string> = { character: "角色", scene: "场景", prop: "道具" };
const LEGACY_MEDIA_LABELS: Record<VnextLegacyAsset["media_kind"], string> = { image: "图片", video: "视频", audio: "音频" };
const LEGACY_REVIEW_LABELS: Record<VnextLegacyAsset["review_status"], string> = { approved: "已通过", pending_review: "待复核", rejected: "已拒绝" };
const LEGACY_REGISTRATION_LABELS: Record<VnextLegacyAsset["registration_status"], string> = { not_required: "无需登记", pending: "处理中", active: "已完成", processing: "处理中", failed: "失败", unknown: "结果不明确" };

function legacyKindLabel(kind: VnextLegacyAsset["asset_kind"]): string {
  return LEGACY_KIND_LABELS[kind];
}

function legacyMediaLabel(mediaKind: VnextLegacyAsset["media_kind"]): string {
  return LEGACY_MEDIA_LABELS[mediaKind];
}

function legacyReviewLabel(reviewStatus: VnextLegacyAsset["review_status"]): string {
  return LEGACY_REVIEW_LABELS[reviewStatus];
}

function legacyRegistrationLabel(registrationStatus: VnextLegacyAsset["registration_status"]): string {
  return LEGACY_REGISTRATION_LABELS[registrationStatus];
}

function legacyFailureReason(asset: VnextLegacyAsset): string {
  if (asset.registration_failure_code === "snapshot_registration_unavailable") return "火山素材登记未开启，未发送任何外部请求";
  if (asset.registration_failure_code === "ASSET_REGISTRY_REJECTED") return "火山素材登记被拒绝，请人工复核后重试";
  if (asset.registration_failure_code === "ASSET_REGISTRY_PROCESSING_FAILED") return "火山素材登记处理失败，请稍后重试或人工复核";
  if (asset.registration_failure_code === "ASSET_REGISTRY_NOT_FOUND") return "火山素材库中未找到目标素材，登记结果仍不明确";
  if (asset.registration_failure_code === "ASSET_REGISTRY_QUERY_LIMIT_REACHED") return "火山素材列表超过受控查询上限，请人工复核";
  if (asset.registration_failure_code === "ASSET_REGISTRY_INVALID_REQUEST") return asset.registration_failure_reason ?? "火山素材登记参数无效，未发送外部请求";
  if (asset.registration_failure_code === "ASSET_REGISTRY_UNAVAILABLE") return "火山素材登记服务暂时不可用，登记结果不明确";
  return asset.registration_failure_reason ?? "火山素材登记失败，请人工复核";
}

/**
 * 持续画布(#345 修 3/4,复审 P1-4/P1-5):所有保存语义收敛在 VnextCanvasSync——
 * 串行写入、409 增量重放、未确认成功的编辑保留 dirty/error 并显式重试;
 * 页面只渲染 sync 发出的事实,「Agent 状态」只来自服务端 last_write。
 */
export function VnextCanvasPage({ projectId }: { projectId: string }): React.JSX.Element {
  const [view, setView] = useState<VnextCanvasView | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [saveStatus, setSaveStatus] = useState<VnextSaveStatus>("synced");
  const saveTimer = useRef<number | null>(null);
  const syncRef = useRef<VnextCanvasSync | null>(null);
  if (syncRef.current === null) {
    syncRef.current = new VnextCanvasSync({
      loadDocument: () => vnextApi.graph(projectId),
      saveDocument: (expectedRevision, document) => vnextApi.saveGraph(projectId, expectedRevision, document),
      isConflict: (reason) => reason instanceof VnextApiError && reason.status === 409,
      describeError: message,
      onView: setView,
      onStatus: setSaveStatus,
      onError: (text) => setError(text ?? ""),
    });
  }
  const sync = syncRef.current;

  const load = useCallback(() => {
    setError("");
    setLoadError("");
    sync.open().catch((reason: unknown) => setLoadError(message(reason)));
  }, [sync]);
  useEffect(() => {
    load();
    // 轻量轮询真实 GraphDocument revision：Agent 在页面打开期间写入后，
    // 「最近写入」和画布事实会自动前进。VnextCanvasSync 会与保存串行，
    // 并把本地 dirty 增量重放到新事实上，不允许轮询覆盖用户编辑。
    const refreshTimer = window.setInterval(() => {
      void sync.open().catch(() => undefined);
    }, AGENT_FACT_REFRESH_MS);
    return () => {
      window.clearInterval(refreshTimer);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [load, sync]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void sync.flush(); }, 450);
  }, [sync]);

  const applyLocalDocument = useCallback((document: VnextGraphDocument) => {
    sync.localChange(document);
    scheduleSave();
  }, [scheduleSave, sync]);

  const nodes = useMemo<Node[]>(() => (view?.document.nodes ?? []).map((node) => ({ id: node.id, type: "default", position: node.position, data: { label: node.label } })), [view]);
  const edges = useMemo<Edge[]>(() => (view?.document.edges ?? []).map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, label: edge.label })), [view]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const current = sync.currentDocument;
    if (!current) return;
    const changed = applyNodeChanges(changes, nodes);
    const positions = new Map(changed.map((item) => [item.id, item.position]));
    let moved = false;
    // 只有位置真正变化才算编辑:React Flow 的 dimensions/select 等内部事件
    // 不得触碰 draft,否则会把画布永久卡在「有未保存更改」。
    const document = { ...current, nodes: current.nodes.map((node) => {
      const next = positions.get(node.id);
      if (!next || (next.x === node.position.x && next.y === node.position.y)) return node;
      moved = true;
      return { ...node, position: next };
    }) };
    if (!moved) return;
    sync.localChange(document);
    if (changes.some((change) => change.type === "position" && change.dragging === false)) scheduleSave();
  }, [nodes, scheduleSave, sync]);

  function addScene(): void {
    const current = sync.currentDocument;
    if (!current) return;
    const id = newId();
    const document = { ...current, nodes: [...current.nodes, { id, kind: "scene" as const, label: "新场景", position: { x: 140 + current.nodes.length * 35, y: 120 + current.nodes.length * 26 } }] };
    applyLocalDocument(document);
  }

  if (view === null && !loadError) return <LoadingState label="正在恢复持续画布" />;
  if (loadError && view === null) return <ErrorState message={loadError} onRetry={load} />;
  const document = view?.document ?? EMPTY_DOCUMENT;
  const lastWrite = view?.lastWrite ?? null;
  const writeFact = lastWrite
    ? `${lastWrite.kind === "agent" ? "Agent" : "人类"} · 写入于 ${new Date(lastWrite.at).toLocaleString("zh-CN")}`
    : "画布尚无写入";
  const syncLabel = saveStatus === "saving" ? "保存中" : saveStatus === "dirty" ? "有未保存更改" : saveStatus === "error" ? "保存失败" : "已同步";
  return <><ScriptWorkbench projectId={projectId} /><GenerationControlWorkbench projectId={projectId} /><VideoVersionWorkbench projectId={projectId} /><section className="flex h-[calc(100dvh-8rem)] min-h-[640px] flex-col overflow-hidden rounded-md border border-border-1 bg-[#101419] text-white">
    <header className="flex items-center justify-between gap-4 border-b border-white/10 bg-[#171d24] px-5 py-3"><div><p className="text-xs uppercase tracking-[0.18em] text-cyan-300">vNext Canvas</p><strong className="text-sm">修订 {view?.revision ?? 0} · {syncLabel}</strong></div><div className="flex items-center gap-3"><span aria-live="polite" className="text-xs text-slate-300">最近写入：{writeFact}</span><Button variant="secondary" size="sm" onClick={addScene} icon={<Plus />}>添加场景</Button><Button variant="ghost" size="icon" aria-label="重新读取画布" onClick={load} icon={<ArrowClockwise />} /></div></header>
    {error ? <div role="alert" className="flex items-center gap-2 bg-danger/20 px-4 py-2 text-sm text-red-200"><WarningCircle />{error}{saveStatus === "error" ? <button type="button" className="ml-auto underline" onClick={() => void sync.retry()}>重试保存</button> : null}<button type="button" className={`underline${saveStatus === "error" ? "" : " ml-auto"}`} onClick={load}>刷新事实</button></div> : null}
    {document.nodes.length === 0 ? <div className="flex flex-1 items-center justify-center"><EmptyState title="从一张空画布开始" description="添加场景，拖动节点；位置和稳定 ID 会保存为项目修订。" action={<Button onClick={addScene} icon={<Plus />}>添加第一个场景</Button>} icon={<Sparkle />} /></div> : <div className="min-h-0 flex-1"><ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} fitView><Background /><Controls /></ReactFlow></div>}
  </section></>;
}

function message(reason: unknown): string {
  return reason instanceof VnextApiError ? reason.message : "vNext 服务暂时不可用，请重试";
}
