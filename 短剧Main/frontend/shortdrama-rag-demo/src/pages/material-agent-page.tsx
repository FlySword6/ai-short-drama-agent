/* ============================================================
   material-agent-page.tsx — 素材智能体（板08，项目作用域）
   W7 IA：入库/检索已拆成可复用面板（MaterialIngestPanel / MaterialSearchPanel），
   整迁进资产中心四页签中的「素材入库」「语义检索」；后端状态卡并入语义检索
   页签顶部，Pi 说明卡并入素材入库页签底部。本文件仍导出 MaterialAgentPage
   组合壳，兼容独立路由（/projects/:id/material-agent 由重定向接管）。
   纯函数与 demo fixture 集中在头部，供 src/material-agent.test.ts 覆盖；
   视图层为 Tailwind v4 + components/ui，本文件保持可被测试 import；
   material-agent.css 已清空为迁移占位（app.tsx 的 import 行接线层冻结）。
   ============================================================ */
import {
  ArrowCounterClockwise,
  CheckCircle,
  CloudArrowUp,
  CloudCheck,
  CloudSlash,
  FileArrowUp,
  MagicWand,
  MagnifyingGlass,
  Question,
  Robot,
  Trash,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { assetImageValidationError, formatFileSize } from "../asset-media";
import { ASSET_UPLOAD_FILE_ACCEPT, audioTraitListFromInput, isAudioUploadFile } from "../asset-upload-tracker";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/primitives";
import { demoCommonAssets, demoPersonalAssets, demoProjects } from "../demo";
import { AUDIO_INGEST_CATEGORIES } from "../types";
import type { Asset, AssetSearchMode, AssetSearchResult, AudioIngestCategory } from "../types";
import {
  AssetThumb,
  assetKindLabel,
  assetKindRawTitle,
  assetName,
} from "../ui";
import { humanErrorMessage } from "./batch-generate-drawer";
import type { PageRuntimeProps } from "./global-pages";
import { AssetKindSelectOptions } from "../components/asset-shared";

/* ---------- 纯逻辑：检索 mode → 标注文案（不写死，随 mode 字段自适应） ---------- */

export interface SearchModeAnnotation {
  /** 结果数旁的命中标注：结构化命中 / 语义命中 / 检索命中（mode 缺省默认）。 */
  label: string;
  /** 降级时的一句解释；非降级为空串。 */
  hint: string;
  /** true = 向量服务降级（展示重试入口）。 */
  degraded: boolean;
}

export function searchModeAnnotation(mode: AssetSearchMode | undefined): SearchModeAnnotation {
  if (mode === "structured_fallback") {
    return { label: "结构化命中", hint: "向量服务不可用，已回退结构化检索", degraded: true };
  }
  if (mode === "hybrid") {
    return { label: "语义命中", hint: "", degraded: false };
  }
  return { label: "检索命中", hint: "", degraded: false };
}

/* ---------- 纯逻辑：文件名 → 项目名提取 ---------- */

/** 去掉路径与扩展名，压缩空白；提不出名字时返回空串（调用方回退到手动输入）。 */
export function projectNameFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  return stem.replace(/\s+/g, " ").trim();
}

/* ---------- 纯逻辑：入库文件类型判定 ---------- */

export type IngestFileKind = "excel" | "image" | "video" | "audio" | "unsupported";

const EXCEL_EXTENSIONS = new Set(["xlsx", "xlsm"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "bmp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv"]);

export function ingestFileKind(fileName: string, mimeType = ""): IngestFileKind {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (EXCEL_EXTENSIONS.has(extension)) return "excel";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (isAudioUploadFile(fileName, mimeType)) return "audio";
  return "unsupported";
}

/* ---------- 纯逻辑：入库批次结果聚合 ---------- */

export interface IngestFileOutcome {
  fileName: string;
  ok: boolean;
  kind?: IngestFileKind;
  submittedForParsing?: boolean;
  /** 本文件写入的资产条数（失败为 0）。 */
  count: number;
  /** 本文件写入的资产 id（撤销入库用）。 */
  assetIds: string[];
  /** 失败时的人话错误。 */
  error: string;
}

export interface IngestBatchSummary {
  filesTotal: number;
  filesSucceeded: number;
  filesFailed: number;
  filesSubmittedForParsing: number;
  assetsIngested: number;
  /** 全批次写入的资产 id（撤销 = 逐条 deleteAsset）。 */
  assetIds: string[];
}

export function summarizeIngestBatch(outcomes: IngestFileOutcome[]): IngestBatchSummary {
  const succeeded = outcomes.filter((outcome) => outcome.ok);
  const submittedForParsing = succeeded.filter((outcome) => outcome.submittedForParsing);
  return {
    filesTotal: outcomes.length,
    filesSucceeded: succeeded.length,
    filesFailed: outcomes.length - succeeded.length,
    filesSubmittedForParsing: submittedForParsing.length,
    assetsIngested: succeeded
      .filter((outcome) => !outcome.submittedForParsing)
      .reduce((total, outcome) => total + outcome.count, 0),
    assetIds: succeeded.flatMap((outcome) => outcome.assetIds),
  };
}

/** 结果卡主文案：全成报写入资产数；有失败时如实报 N 成功 M 失败。 */
export function ingestBatchMessage(summary: IngestBatchSummary): string {
  if (summary.filesSubmittedForParsing > 0 && summary.assetsIngested === 0 && summary.filesFailed === 0) {
    return `已提交 ${summary.filesSubmittedForParsing} 个视频解析任务`;
  }
  if (summary.filesFailed === 0) return `已写入 ${summary.assetsIngested} 条资产`;
  if (summary.filesSubmittedForParsing > 0) {
    return `${summary.filesSucceeded} 个文件成功、${summary.filesFailed} 个失败，已写入 ${summary.assetsIngested} 条资产，另提交 ${summary.filesSubmittedForParsing} 个视频解析任务`;
  }
  return `${summary.filesSucceeded} 个文件成功、${summary.filesFailed} 个失败，已写入 ${summary.assetsIngested} 条资产`;
}

/* ---------- 纯逻辑：后端状态卡（依据最近一次 semanticSearch 如实展示） ---------- */

export type VectorServiceStatus =
  | { state: "untested" }
  | { state: "configured" }
  | { state: "degraded"; reason?: string }
  | { state: "unreachable"; message: string };

export function vectorStatusFromSearch(result: AssetSearchResult): VectorServiceStatus {
  if (result.mode === "hybrid") return { state: "configured" };
  if (result.mode === "structured_fallback") return { state: "degraded", reason: result.degraded_reason };
  // 后端未回传 mode：不虚构状态，保持未探测口径之外的"已应答但未标注"。
  return { state: "untested" };
}

export function vectorStatusFromError(message: string): VectorServiceStatus {
  return { state: "unreachable", message };
}

export function vectorStatusView(status: VectorServiceStatus): { title: string; detail: string } {
  switch (status.state) {
    case "configured":
      return { title: "向量服务已配置", detail: "最近一次检索为语义混合检索，向量链路工作正常。" };
    case "degraded":
      return { title: "向量服务降级中", detail: status.reason || "向量服务不可用，检索已回退结构化匹配。" };
    case "unreachable":
      return { title: "探测失败", detail: status.message };
    default:
      return { title: "未探测", detail: "发起一次语义检索后，此处显示向量服务的真实状态。" };
  }
}

/* ---------- demo fixture：本地检索结果 / 入库模拟（不调用服务端） ---------- */

const DEMO_MATERIAL_POOL: Asset[] = [...demoPersonalAssets, ...demoCommonAssets];

/** 离线演示检索：本地 fixture 按名称/说明/标签做朴素包含匹配，mode 缺省（页面标注「示例数据」）。 */
export function demoMaterialSearchResult(query: string): AssetSearchResult {
  const term = query.trim().toLowerCase();
  const items = term
    ? DEMO_MATERIAL_POOL.filter((asset) =>
        [asset.display_name, asset.name, asset.intro, asset.description, ...(asset.style_tags ?? [])]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(term)))
    : DEMO_MATERIAL_POOL;
  return { items, count: items.length };
}

/** 离线演示入库模拟计数：Excel 按资产表批量，图片/视频/音频按单条资产档案。 */
export function demoIngestCount(fileName: string): number {
  return ingestFileKind(fileName) === "excel" ? 6 : 1;
}

function ingestFileKindLabel(kind: IngestFileKind): string {
  if (kind === "excel") return "资产表";
  if (kind === "image") return "图片";
  if (kind === "video") return "视频";
  if (kind === "audio") return "音频";
  return "未知文件";
}

function ingestItemSucceeded(status: IngestQueueItem["status"]): boolean {
  return status === "done" || status === "submitted";
}

/* ---------- 入库队列 ---------- */

interface IngestQueueItem {
  key: string;
  file: File;
  kind: IngestFileKind;
  status: "queued" | "uploading" | "done" | "submitted" | "failed";
  count: number;
  assetIds: string[];
  error: string;
}

function queueItemFromFile(file: File): IngestQueueItem {
  return {
    key: `${file.name}-${file.size}-${file.lastModified}`,
    file,
    kind: ingestFileKind(file.name, file.type),
    status: "queued",
    count: 0,
    assetIds: [],
    error: "",
  };
}

/** 后端状态卡四态视图：Badge 色调 + 图标着色（如实，不虚构）。 */
const BACKEND_STATE_VIEW: Record<VectorServiceStatus["state"], { tone: "neutral" | "success" | "warning" | "danger"; iconClass: string }> = {
  untested: { tone: "neutral", iconClass: "text-ink-2" },
  configured: { tone: "success", iconClass: "text-success" },
  degraded: { tone: "warning", iconClass: "text-warning" },
  unreachable: { tone: "danger", iconClass: "text-danger" },
};

/* ---------- 后端状态卡 / Pi 说明卡（各内嵌一个页签，单屏至多一处） ---------- */

export function BackendStatusCard({ demoMode, status, onProbeAgain }: {
  demoMode: boolean;
  status: VectorServiceStatus;
  onProbeAgain: () => void;
}): React.JSX.Element {
  const statusView = vectorStatusView(status);
  const stateView = BACKEND_STATE_VIEW[status.state];
  return (
    <Card className="flex gap-3 p-4" aria-label="后端状态">
      {status.state === "configured" ? <CloudCheck aria-hidden="true" className={cn("mt-0.5 size-6 shrink-0", stateView.iconClass)} />
        : status.state === "untested" ? <Question aria-hidden="true" className={cn("mt-0.5 size-6 shrink-0", stateView.iconClass)} />
        : <CloudSlash aria-hidden="true" className={cn("mt-0.5 size-6 shrink-0", stateView.iconClass)} />}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm text-ink-1">后端状态</strong>
          <Badge tone={demoMode ? "neutral" : stateView.tone}>{demoMode ? "离线演示" : statusView.title}</Badge>
        </div>
        <p className="text-xs text-ink-2">{demoMode ? "离线演示不探测后端；登录已启动的服务后，此处显示向量服务真实状态。" : statusView.detail}</p>
        {!demoMode && (status.state === "degraded" || status.state === "unreachable") ? (
          <button type="button" className="self-start text-xs text-accent-text transition-colors hover:text-accent-hover" onClick={onProbeAgain}>重新探测</button>
        ) : null}
      </div>
    </Card>
  );
}

function PiIntroCard(): React.JSX.Element {
  return (
    <Card className="flex gap-3 p-4" aria-label="Pi 能力说明">
      <Robot aria-hidden="true" className="mt-0.5 size-6 shrink-0 text-agent-text" />
      <div className="flex min-w-0 flex-col gap-1">
        <strong className="text-sm text-ink-1">Pi · 素材智能体</strong>
        <p className="text-xs text-ink-2">我可以帮你上传资产表、图片、参考视频或音频；音频按音色或背景音乐信息入库，还能排查入库失败的原因。</p>
        <span className="text-xs text-ink-4">对话式协助请使用全局 AI 工作区，本页为操作台。</span>
      </div>
    </Card>
  );
}

/**
 * 向量服务状态自探测卡（资产中心「实验室」页底）：
 * 「语义检索」页签撤并后，后端状态诊断迁到这里；挂载即探测一次（1 条检索），
 * 降级/不可达时可手动重探。探测词无业务含义，只验证链路。
 */
export function VectorStatusProbe({ demoMode }: Pick<PageRuntimeProps, "demoMode">): React.JSX.Element {
  const [status, setStatus] = useState<VectorServiceStatus>({ state: "untested" });
  const probe = (): void => {
    if (demoMode) return;
    api.semanticSearch("链路探测", 1)
      .then((result) => setStatus(vectorStatusFromSearch(result)))
      .catch((reason: unknown) => setStatus(vectorStatusFromError(humanErrorMessage(reason, "探测失败，请重试"))));
  };
  // 仅挂载时自动探测一次；之后手动重探（不轮询）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { probe(); }, []);
  return <BackendStatusCard demoMode={demoMode} status={status} onProbeAgain={probe} />;
}

/* ---------- 素材入库面板（资产中心「素材入库」页签 + 独立页共用） ---------- */

export function MaterialIngestPanel({ demoMode, notify }: Pick<PageRuntimeProps, "demoMode" | "notify">): React.JSX.Element {
  const [queue, setQueue] = useState<IngestQueueItem[]>([]);
  const [sourceProjectName, setSourceProjectName] = useState("");
  const [kindHint, setKindHint] = useState("");
  const [audioCategory, setAudioCategory] = useState<AudioIngestCategory | "">("");
  const [audioDescription, setAudioDescription] = useState("");
  const [audioVoiceTraits, setAudioVoiceTraits] = useState("");
  const [audioSpeakingStyle, setAudioSpeakingStyle] = useState("");
  const [audioMusicTraits, setAudioMusicTraits] = useState("");
  const [audioTempo, setAudioTempo] = useState("");
  const [audioUsageScene, setAudioUsageScene] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [batch, setBatch] = useState<IngestBatchSummary | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function addFiles(files: Iterable<File>): void {
    const accepted: IngestQueueItem[] = [];
    for (const file of files) {
      const kind = ingestFileKind(file.name, file.type);
      if (kind === "unsupported") {
        notify(`「${file.name}」不支持：仅接受 .xlsx/.xlsm 资产表、jpg/png/webp/bmp 图片、mp4/mov/webm 视频或 mp3/wav/ogg/opus 音频`, "error");
        continue;
      }
      if (kind === "image") {
        const validationError = assetImageValidationError(file);
        if (validationError) {
          notify(`「${file.name}」${validationError}`, "error");
          continue;
        }
      }
      accepted.push(queueItemFromFile(file));
    }
    if (accepted.length === 0) return;
    setBatch(null);
    setQueue((current) => {
      const existing = new Set(current.map((item) => item.key));
      return [...current, ...accepted.filter((item) => !existing.has(item.key))];
    });
  }

  function patchQueueItem(key: string, patch: Partial<IngestQueueItem>): void {
    setQueue((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  /** 单文件上传（真实调用）；视频返回解析任务，音频同步创建资产。 */
  async function uploadOne(item: IngestQueueItem, effectiveProjectName: string): Promise<{ count: number; assetIds: string[]; submittedForParsing?: boolean }> {
    if (item.kind === "audio") {
      if (!audioCategory) throw new Error("请选择音频分类");
      const submission = await api.uploadAudioAsset(item.file, {
        name: projectNameFromFileName(item.file.name) || item.file.name,
        category: audioCategory,
        description: audioDescription.trim() || undefined,
        sourceProjectName: effectiveProjectName || undefined,
        voiceTraits: audioTraitListFromInput(audioVoiceTraits),
        speakingStyle: audioSpeakingStyle,
        musicTraits: audioTraitListFromInput(audioMusicTraits),
        tempo: audioTempo,
        usageScene: audioUsageScene,
      });
      return { count: 1, assetIds: [submission.assetId] };
    }
    if (item.kind === "video") {
      const submission = await api.uploadVideoAsset(item.file, {
        name: projectNameFromFileName(item.file.name) || item.file.name,
        sourceProjectName: effectiveProjectName || undefined,
      });
      return { count: 0, assetIds: [submission.assetId], submittedForParsing: true };
    }
    const result = await api.uploadAsset(item.file, {
      sourceProjectName: effectiveProjectName || undefined,
      // assetKindHint 只对 Excel 资产表生效；图片由服务端逐张识别字段。
      assetKindHint: item.kind === "excel" && kindHint ? kindHint : undefined,
    });
    return { count: result.count, assetIds: result.items.map((asset) => asset.id) };
  }

  /** 开始入库：多文件排队逐个上传（一次一个）。 */
  async function startIngest(): Promise<void> {
    const pending = queue.filter((item) => item.status === "queued");
    if (pending.length === 0 || running) return;
    if (pending.some((item) => item.kind === "audio") && !audioCategory) {
      notify("请选择音频分类", "error");
      return;
    }
    const effectiveProjectName = sourceProjectName.trim();
    if (demoMode) {
      setRunning(true);
      setProgress({ done: 0, total: pending.length });
      const outcomes: IngestFileOutcome[] = [];
      for (const item of pending) {
        const count = demoIngestCount(item.file.name);
        const submittedForParsing = item.kind === "video";
        patchQueueItem(item.key, { status: submittedForParsing ? "submitted" : "done", count: submittedForParsing ? 0 : count, assetIds: [] });
        outcomes.push({ fileName: item.file.name, kind: item.kind, ok: true, submittedForParsing, count: submittedForParsing ? 0 : count, assetIds: [], error: "" });
        setProgress((current) => ({ ...current, done: current.done + 1 }));
      }
      setRunning(false);
      setBatch(summarizeIngestBatch(outcomes));
      notify("离线演示不实际上传，入库结果为本地模拟，未写入资产库", "info");
      return;
    }
    setRunning(true);
    setProgress({ done: 0, total: pending.length });
    const outcomes: IngestFileOutcome[] = [];
    for (const item of pending) {
      patchQueueItem(item.key, { status: "uploading", error: "" });
      try {
        const { count, assetIds, submittedForParsing } = await uploadOne(item, effectiveProjectName);
        patchQueueItem(item.key, { status: submittedForParsing ? "submitted" : "done", count, assetIds });
        outcomes.push({ fileName: item.file.name, kind: item.kind, ok: true, submittedForParsing, count, assetIds, error: "" });
      } catch (reason) {
        const message = humanErrorMessage(reason, "入库失败，请重试");
        patchQueueItem(item.key, { status: "failed", error: message });
        outcomes.push({ fileName: item.file.name, kind: item.kind, ok: false, count: 0, assetIds: [], error: message });
      }
      setProgress((current) => ({ ...current, done: current.done + 1 }));
    }
    setRunning(false);
    const summary = summarizeIngestBatch(outcomes);
    setBatch(summary);
    if (summary.filesFailed === 0) notify(ingestBatchMessage(summary), "success");
    else notify(ingestBatchMessage(summary), "error");
  }

  /** 失败单文件重试（真实模式）。 */
  async function retryItem(item: IngestQueueItem): Promise<void> {
    if (running || item.status !== "failed") return;
    if (item.kind === "audio" && !audioCategory) {
      notify("请选择音频分类", "error");
      return;
    }
    const effectiveProjectName = sourceProjectName.trim();
    patchQueueItem(item.key, { status: "uploading", error: "" });
    try {
      const { count, assetIds, submittedForParsing } = await uploadOne(item, effectiveProjectName);
      patchQueueItem(item.key, { status: submittedForParsing ? "submitted" : "done", count, assetIds });
      notify(submittedForParsing ? `「${item.file.name}」已提交视频解析任务` : `「${item.file.name}」已入库 ${count} 条资产`, "success");
    } catch (reason) {
      patchQueueItem(item.key, { status: "failed", error: humanErrorMessage(reason, "入库失败，请重试") });
    }
  }

  /** 撤销入库：确认后逐条 deleteAsset 本批写入的资产 id。 */
  async function revokeBatch(): Promise<void> {
    if (!batch || revoking) return;
    if (demoMode) {
      setConfirmRevoke(false);
      setBatch(null);
      setQueue((current) => current.filter((item) => !ingestItemSucceeded(item.status)));
      notify("离线演示不执行撤销（本批为本地模拟，未写入资产库）", "info");
      return;
    }
    setRevoking(true);
    let revoked = 0;
    let failed = 0;
    for (const assetId of batch.assetIds) {
      try {
        await api.deleteAsset(assetId);
        revoked += 1;
      } catch {
        failed += 1;
      }
    }
    setRevoking(false);
    setConfirmRevoke(false);
    if (failed === 0) {
      setBatch(null);
      setQueue((current) => current.filter((item) => !ingestItemSucceeded(item.status)));
      notify(`已撤销本批 ${revoked} 条资产入库`, "success");
    } else {
      setBatch({ ...batch, assetIds: [] });
      notify(`撤销完成：${revoked} 条已撤销，${failed} 条撤销失败（可在个人资产页手动移入回收站）`, "error");
    }
  }

  const queuedCount = queue.filter((item) => item.status === "queued").length;
  const queueNeedsAudioCategory = queue.some((item) => item.kind === "audio" && (item.status === "queued" || item.status === "failed"));
  const ingestDisabled = queuedCount === 0 || (queueNeedsAudioCategory && !audioCategory);

  return (
    <div className="flex flex-col gap-4" aria-label="素材入库">
      <button
        type="button"
        className={cn(
          "flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-ink-2 transition-colors",
          dragOver ? "border-accent bg-accent-subtle" : "border-border-2 bg-surface-1 hover:border-accent/40",
        )}
        onClick={() => fileInput.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => { event.preventDefault(); setDragOver(false); addFiles(event.dataTransfer.files); }}
      >
        <CloudArrowUp aria-hidden="true" className="size-6 text-accent-text" />
        <strong className="text-base text-ink-1">拖拽资产表、图片、视频或音频到这里，或点击选择</strong>
        <span className="text-xs">支持 .xlsx / .xlsm 资产表，jpg / png / webp / bmp 图片，mp4 / mov / webm 视频，mp3 / wav / ogg / opus 音频；多文件排队逐个上传</span>
      </button>
      <input
        ref={fileInput}
        className="sr-only"
        type="file"
        accept={ASSET_UPLOAD_FILE_ACCEPT}
        multiple
        onChange={(event) => { addFiles(event.target.files ?? []); event.target.value = ""; }}
      />

      {queue.length > 0 ? (
        <div className="flex flex-col divide-y divide-border-1 overflow-hidden rounded-lg border border-border-1 bg-surface-1" aria-label="入库队列">
          {queue.map((item) => (
            <div className="flex items-center gap-3 px-4 py-3" key={item.key}>
              <FileArrowUp aria-hidden="true" className="size-[18px] shrink-0 text-ink-2" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="truncate text-sm text-ink-1">{item.file.name}</strong>
                <span className="text-xs text-ink-2">{formatFileSize(item.file.size)} · {ingestFileKindLabel(item.kind)}</span>
                {item.status === "failed" ? <span className="text-xs text-danger" role="alert">{item.error}</span> : null}
                {item.status === "done" ? <span className="text-xs text-success">已写入 {item.count} 条资产</span> : null}
                {item.status === "submitted" ? <span className="text-xs text-warning">已提交视频解析任务，等待后台处理完成</span> : null}
              </div>
              <span className="flex items-center text-xs text-ink-2">
                {item.status === "queued" ? "排队中" : null}
                {item.status === "uploading" ? "上传中…" : null}
                {item.status === "submitted" ? "视频解析排队" : null}
                {item.status === "done" ? <CheckCircle aria-label="完成" className="size-[18px] text-success" /> : null}
                {item.status === "submitted" ? <CheckCircle aria-label="已提交解析" className="size-[18px] text-warning" /> : null}
                {item.status === "failed" ? <XCircle aria-label="失败" className="size-[18px] text-danger" /> : null}
              </span>
              {item.status === "failed" && !demoMode ? (
                <Button icon={<ArrowCounterClockwise />} onClick={() => void retryItem(item)}>重试</Button>
              ) : null}
              {item.status === "queued" && !running ? (
                <Button size="icon" variant="ghost" icon={<X />} aria-label={`移除「${item.file.name}」`} onClick={() => setQueue((current) => current.filter((entry) => entry.key !== item.key))} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="项目名（来源标注）" className="min-w-[220px] flex-1">
          <Input
            value={sourceProjectName}
            onChange={(event) => setSourceProjectName(event.target.value)}
            placeholder="不填则从首个文件名自动提取"
          />
        </Field>
        <Field label="资产类型（仅 Excel 生效）" className="min-w-[220px] flex-1">
          <Select value={kindHint} onChange={(event) => setKindHint(event.target.value)}>
            <option value="">自动识别</option>
            <AssetKindSelectOptions />
          </Select>
        </Field>
        {queueNeedsAudioCategory ? (
          <Field label="音频分类" className="min-w-[180px] flex-1">
            <Select value={audioCategory} onChange={(event) => setAudioCategory(event.target.value as AudioIngestCategory | "")}>
              <option value="">请选择</option>
              {AUDIO_INGEST_CATEGORIES.map((category) => <option value={category} key={category}>{category}</option>)}
            </Select>
          </Field>
        ) : null}
        {queueNeedsAudioCategory ? (
          <Field label="音频描述（可选）" className="min-w-[260px] flex-[1.5]">
            <Input value={audioDescription} onChange={(event) => setAudioDescription(event.target.value)} placeholder="一句话说明用途或听感" />
          </Field>
        ) : null}
        {queueNeedsAudioCategory && audioCategory === "音色" ? (
          <>
            <Field label="音色标签（可选）" className="min-w-[220px] flex-1">
              <Input value={audioVoiceTraits} onChange={(event) => setAudioVoiceTraits(event.target.value)} placeholder="低沉、克制、沙哑" />
            </Field>
            <Field label="说话方式（可选）" className="min-w-[180px] flex-1">
              <Input value={audioSpeakingStyle} onChange={(event) => setAudioSpeakingStyle(event.target.value)} placeholder="旁白、对白、独白" />
            </Field>
          </>
        ) : null}
        {queueNeedsAudioCategory && audioCategory === "背景音乐" ? (
          <>
            <Field label="音乐标签（可选）" className="min-w-[220px] flex-1">
              <Input value={audioMusicTraits} onChange={(event) => setAudioMusicTraits(event.target.value)} placeholder="悬疑、压抑、都市感" />
            </Field>
            <Field label="节奏（可选）" className="min-w-[140px] flex-1">
              <Input value={audioTempo} onChange={(event) => setAudioTempo(event.target.value)} placeholder="慢、中、快" />
            </Field>
            <Field label="使用场景（可选）" className="min-w-[180px] flex-1">
              <Input value={audioUsageScene} onChange={(event) => setAudioUsageScene(event.target.value)} placeholder="开场、转场、反转" />
            </Field>
          </>
        ) : null}
        <Button
          variant="primary"
          icon={<CloudArrowUp />}
          loading={running}
          disabled={ingestDisabled}
          className="shrink-0"
          onClick={() => void startIngest()}
        >
          {running ? `入库中 ${progress.done}/${progress.total}` : `开始入库${queuedCount > 0 ? `（${queuedCount} 个文件）` : ""}`}
        </Button>
      </div>

      {batch ? (
        <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/10 p-4" role="status">
          <CheckCircle aria-hidden="true" className="size-6 shrink-0 text-success" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-sm text-ink-1">{ingestBatchMessage(batch)}</strong>
            <p className="text-xs text-ink-2">{batch.filesSubmittedForParsing > 0
              ? "视频还在后台解析，完成后才会写入检索文本；可稍后到检索页验证。"
              : batch.filesFailed > 0
                ? "失败文件可在上方队列中逐个重试。"
                : demoMode ? "本地模拟结果，未写入资产库。" : "撤销会逐条删除本批写入的资产。"}</p>
          </div>
          <Button variant="danger" icon={<Trash />} onClick={() => setConfirmRevoke(true)}>撤销</Button>
        </div>
      ) : null}

      {/* Pi 说明卡：W7 IA 并入「素材入库」页签底部。 */}
      <PiIntroCard />

      <Dialog open={confirmRevoke && batch !== null} onOpenChange={(open) => { if (!open && !revoking) setConfirmRevoke(false); }}>
        <DialogContent size="small">
          <DialogHeader>
            <DialogTitle>撤销入库</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {batch ? (
              <div className="flex items-start gap-3">
                <WarningCircle className="size-6 shrink-0 text-danger" aria-hidden="true" />
                <div className="flex flex-col gap-1">
                  <strong className="text-sm text-ink-1">撤销本批写入的 {batch.assetIds.length} 条资产</strong>
                  <p className="text-xs text-ink-2">将逐条从资产库移入回收站；已被项目引用的资产由服务端校验后可能撤销失败，失败条数会如实回报。</p>
                </div>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setConfirmRevoke(false)}>取消</Button>
            <Button variant="danger" icon={<Trash />} loading={revoking} onClick={() => void revokeBatch()}>确认撤销</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------- 语义检索面板（资产中心「语义检索」页签；后端状态卡并入顶部） ---------- */

export function MaterialSearchPanel({ demoMode }: Pick<PageRuntimeProps, "demoMode">): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [searchPhase, setSearchPhase] = useState<"idle" | "loading" | "error" | "done">("idle");
  const [searchResult, setSearchResult] = useState<AssetSearchResult | null>(null);
  const [searchError, setSearchError] = useState("");
  const [vectorStatus, setVectorStatus] = useState<VectorServiceStatus>({ state: "untested" });

  async function runSearch(term: string): Promise<void> {
    const trimmed = term.trim();
    if (!trimmed) return;
    setAppliedQuery(trimmed);
    setSearchPhase("loading");
    setSearchError("");
    if (demoMode) {
      setSearchResult(demoMaterialSearchResult(trimmed));
      setSearchPhase("done");
      return;
    }
    try {
      /* S13-1：用户检索切混合检索单框（服务端融合，无 mode/degraded 概念）；
         下方「链路探测」按钮仍探旧 semantic 链路健康（那是它的职责），两处不混。 */
      const result = await api.assetSearch(trimmed, { pageSize: 24 });
      setSearchResult({ items: result.items, count: result.count });
      setSearchPhase("done");
      setVectorStatus({ state: "untested" });
    } catch (reason) {
      const message = humanErrorMessage(reason, "语义检索失败，请重试");
      setSearchError(message);
      setSearchPhase("error");
      setVectorStatus(vectorStatusFromError(message));
    }
  }

  /** 后端状态卡的「重新探测」：重跑最近一次查询（已在检索页签内，无需切页签）。 */
  function probeAgain(): void {
    if (appliedQuery) void runSearch(appliedQuery);
  }

  const annotation = searchModeAnnotation(searchResult?.mode);

  return (
    <div className="flex flex-col gap-4" aria-label="语义检索">
      <BackendStatusCard demoMode={demoMode} status={vectorStatus} onProbeAgain={probeAgain} />

      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void runSearch(query); }}>
        <label className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border-1 bg-surface-0 px-3 transition-colors focus-within:border-accent">
          <MagicWand aria-hidden="true" className="size-4 shrink-0 text-ink-2" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="雨夜巷口，冷色调，适合追逐戏"
            aria-label="语义检索描述"
            className="w-full min-w-0 bg-transparent text-sm text-ink-1 outline-none placeholder:text-ink-4"
          />
        </label>
        <Button variant="primary" icon={<MagnifyingGlass />} type="submit" loading={searchPhase === "loading"}>检索</Button>
      </form>

      {searchPhase === "idle" ? (
        <Card>
          <EmptyState
            title="用一句话找素材"
            description="描述场景、色调、情绪或用途，例如：雨夜巷口，冷色调，适合追逐戏。"
            icon={<MagicWand />}
          />
        </Card>
      ) : null}
      {searchPhase === "loading" ? <LoadingState label="正在检索素材" onRetry={() => void runSearch(appliedQuery)} /> : null}
      {searchPhase === "error" ? <ErrorState message={searchError} onRetry={() => void runSearch(appliedQuery)} /> : null}
      {searchPhase === "done" && searchResult ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2" role="status">
            <Badge tone={demoMode ? "neutral" : annotation.degraded ? "warning" : "accent"}>{demoMode ? "示例数据" : annotation.label}</Badge>
            <span>{searchResult.count} 条结果 · 「{appliedQuery}」</span>
            {!demoMode && annotation.degraded ? (
              <>
                <span className="text-warning">{searchResult.degraded_reason || annotation.hint}</span>
                <button type="button" className="text-accent-text transition-colors hover:text-accent-hover" onClick={() => void runSearch(appliedQuery)}>重试</button>
              </>
            ) : null}
          </div>
          {searchResult.items.length === 0 ? (
            <Card>
              <EmptyState
                title="没有命中的素材"
                description="换个描述试试；也可以先到「素材入库」页签把资产表、图片、视频或音频入库。"
                icon={<MagnifyingGlass />}
              />
            </Card>
          ) : (
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
              {searchResult.items.map((asset) => (
                <article className="overflow-hidden rounded-lg border border-border-1 bg-surface-1 transition-colors hover:border-accent/30" key={asset.id}>
                  <div className="bg-surface-well [&_.asset-thumb-image]:h-[140px] [&_.asset-thumb-placeholder]:h-[140px]">
                    <AssetThumb asset={asset} />
                  </div>
                  <div className="flex flex-col gap-2 p-3">
                    <h2 className="truncate text-ink-1 text-section-title">{assetName(asset)}</h2>
                    <span className="text-xs text-ink-2" title={assetKindRawTitle(asset.asset_kind)}>{assetKindLabel(asset.asset_kind)}</span>
                    <div className="flex flex-wrap gap-1">
                      {(asset.style_tags ?? []).slice(0, 3).map((tag) => <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2" key={tag}>{tag}</span>)}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

/* ---------- 独立页组合壳（/projects/:id/material-agent；重定向接管后兜底） ---------- */

export function MaterialAgentPage({ demoMode, notify, projectId }: PageRuntimeProps & { projectId: string }): React.JSX.Element {
  const [tab, setTab] = useState<"ingest" | "search">("ingest");
  const [projectTitle, setProjectTitle] = useState("");

  /* 项目上下文：只取项目名做页头展示，失败静默降级为不显示（不挡主流程）。 */
  useEffect(() => {
    if (demoMode) {
      setProjectTitle(demoProjects.find((project) => project.id === projectId)?.name ?? "");
      return;
    }
    let active = true;
    api.project(projectId)
      .then((project) => { if (active) setProjectTitle(project.name); })
      .catch(() => { /* 页头上下文缺失不影响入库/检索 */ });
    return () => { active = false; };
  }, [demoMode, projectId]);

  return (
    <section className="mx-auto flex w-full max-w-[1920px] flex-col gap-5" aria-label="素材智能体">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-page-title text-ink-1">素材智能体</h1>
          <p className="text-sm text-ink-2">{projectTitle ? `项目「${projectTitle}」· 资产表/图片/视频/音频批量入库，一句话检索素材` : "资产表/图片/视频/音频批量入库，一句话检索素材"}</p>
        </div>
      </header>
      {/* forceMount：子页签切换不卸载，入库队列/检索结果常驻（与资产中心页签同策略）。 */}
      <Tabs value={tab} onValueChange={(value) => setTab(value as "ingest" | "search")}>
        <TabsList aria-label="素材智能体页签">
          <TabsTrigger value="ingest">素材入库</TabsTrigger>
          <TabsTrigger value="search">语义检索</TabsTrigger>
        </TabsList>
        <TabsContent value="ingest" forceMount className="mt-4">
          <MaterialIngestPanel demoMode={demoMode} notify={notify} />
        </TabsContent>
        <TabsContent value="search" forceMount className="mt-4">
          <MaterialSearchPanel demoMode={demoMode} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
