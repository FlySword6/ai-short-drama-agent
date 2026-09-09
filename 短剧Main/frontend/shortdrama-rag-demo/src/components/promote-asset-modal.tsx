/* ============================================================
   promote-asset-modal.tsx — W5-1 生成图一键入资产库（转为参考资产）
   提交链（严格按序；任一步失败给人话错误 + 重试，已完成步骤不重跑，
   不允许半截状态假装成功）：
     a. fetch(media.storage_url) 取产物图 blob（跨域失败给可操作提示）
     b. 包成 File（${name || "reference"}.jpg）
     c. ingestJsonAssets 登记 asset_entity（kind=keyframe/scene）
     d. uploadAssetMedia 挂图（isPrimary，后端 sharp 只收图片 ≤10MB）
   只支持图片类产物：视频产物不出入口（后端 media 上传只收图片）。
   视图层：Tailwind utility + ui 原语（Dialog/Field/Input/Select/Textarea）；
   本模块不 import 任何 CSS，保证 node:test 可直接 import。
   ============================================================ */
import { FolderPlus } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { ApiClientError, api } from "../api";
import { fetchReadableImage } from "../asset-media";
import { humanErrorMessage } from "../pages/batch-generate-drawer";
import { ASSET_KIND_OPTIONS, AssetKindSelectOptions } from "./asset-shared";
import type { JsonAssetIngestItem, JsonRecord, Shot } from "../types";
import type { PageRuntimeProps } from "../pages/global-pages";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Field, Input, Select, Textarea } from "./ui/primitives";
/* ============================================================
   纯逻辑（src/promote-asset.test.ts 直接断言）
   ============================================================ */

/** 入库所需的最小媒体形状：MediaResult 与 MediaVersion 都结构兼容。 */
export interface PromoteSourceMedia {
  id?: string;
  media_kind?: string;
  format?: string | null;
  storage_url?: string | null;
  thumbnail_url?: string | null;
}

/* S16 条 4①：资产类型=创作词表完整可选集（与资产中心同源 ASSET_KIND_OPTIONS，R9）——
   DC 实测：从道具组进入的道具产物只剩「关键帧」可选。类型不再按 usage_mode 出单值，
   默认档由入口上下文（来源参考组的 kinds）预填。
   历史口径：S10 四-2 曾把「场景」从选项去掉、收敛单值 keyframe；S16 DC 拍板推翻——
   转参考资产的类型应跟随产物语义（道具产物=prop），给完整词表。
   S88b：PROMOTE_KIND_OPTIONS 别名导出已删（第二真源风险），消费方直接用 ASSET_KIND_OPTIONS。 */
export type PromoteAssetKind = string;

/** 无入口上下文时的默认：产物图最常见的复用方式是 i2v 首帧参考（词表主值 keyword=关键帧）。 */
export const DEFAULT_PROMOTE_KIND: PromoteAssetKind = "keyword";

/** 词表校验：主值/别名命中归一到主值（keyframe→keyword、clothing→costume）；未知值回落默认（R9——新类型进词表即自动可选，不改码）。 */
export function resolvePromoteKind(value: string): PromoteAssetKind {
  const hit = ASSET_KIND_OPTIONS.find((option) => option.value === value || option.aliases.includes(value));
  return hit?.value ?? DEFAULT_PROMOTE_KIND;
}

/**
 * 入口上下文（来源参考组 kinds）→ 默认类型：道具组产物默认 prop、光影组默认 lighting…
 * 词表外的 kind（如新参考组）回落默认，不硬炸。
 */
export function promoteDefaultKind(laneKinds: readonly string[] | null | undefined): PromoteAssetKind {
  const first = laneKinds?.find((kind) => ASSET_KIND_OPTIONS.some((option) => option.value === kind));
  return first ?? DEFAULT_PROMOTE_KIND;
}

/** 后端 sharp 只收这些图片格式（与 uploadAssetMedia 合同一致）。 */
const IMAGE_FORMATS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "tiff", "bmp"]);

/** 图片类产物判定：media_kind=image，或 format 为图片扩展名；视频产物恒为 false。 */
export function isImageMedia(media: PromoteSourceMedia | null | undefined): boolean {
  if (!media) return false;
  if (media.media_kind) return media.media_kind === "image";
  const format = (media.format || "").trim().toLowerCase().replace(/^\./, "");
  return IMAGE_FORMATS.has(format);
}

export type PromoteEntryState = "ready" | "demo" | "hidden";

/**
 * 「转为参考资产」入口显隐（板14：media 缺失时隐藏而不是报错）：
 * - 非图片产物（视频）不出按钮；无 storage_url 直接隐藏入口。
 * - demoMode 下演示数据常无真实 URL：图片入口照渲染（"demo"），点击只提示不写库。
 */
export function promoteEntryState(media: PromoteSourceMedia | null | undefined, demoMode: boolean): PromoteEntryState {
  if (!isImageMedia(media)) return "hidden";
  if (demoMode) return "demo";
  return media?.storage_url?.trim() ? "ready" : "hidden";
}

export const PROMOTE_PROMPT_SUMMARY_MAX = 200;

/** 提示词摘要：压平空白为单空格，超过 maxLength 截断并加省略号。 */
export function summarizePrompt(prompt: string, maxLength = PROMOTE_PROMPT_SUMMARY_MAX): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat;
  return `${flat.slice(0, maxLength - 1).trimEnd()}…`;
}

/** 资产名称预填：素材标题，缺省回落「素材 #N」。 */
export function defaultPromoteName(shot: Pick<Shot, "title" | "shot_no"> | null | undefined): string {
  const title = shot?.title?.trim();
  if (title) return title;
  const shotNo = shot?.shot_no?.trim();
  return shotNo ? `素材 #${shotNo}` : "素材图";
}

/** 上传文件名：${name || "reference"}.jpg（真实格式由后端 sharp 嗅探）。 */
export function promoteFileName(name: string): string {
  return `${name.trim() || "reference"}.jpg`;
}

/** 后端 uploadAssetMedia 的 10MB 上限。 */
export const PROMOTE_MAX_FILE_BYTES = 10 * 1024 * 1024;

export function buildPromoteIngestItem(input: {
  kind: PromoteAssetKind;
  name: string;
  intro: string;
  sourceUrl: string;
  generationRequestId?: string | null;
  shotId?: string | null;
}): JsonAssetIngestItem {
  const metadata: JsonRecord = { origin: "generation_result" };
  if (input.generationRequestId) metadata.generation_request_id = input.generationRequestId;
  if (input.shotId) metadata.shot_id = input.shotId;
  return {
    asset_kind: input.kind,
    name: input.name,
    intro: input.intro || null,
    source_file_url: input.sourceUrl,
    metadata,
  };
}

/* ============================================================
   组件：转为参考资产弹窗
   ============================================================ */

export interface PromoteResult {
  assetId: string;
  name: string;
  kind: PromoteAssetKind;
}

interface PromoteToAssetModalProps {
  projectId: string;
  shot: Shot;
  /** 待入库的图片产物（必须带 storage_url；入口侧已按 promoteEntryState 过滤）。 */
  media: PromoteSourceMedia;
  /** 本产物的提示词原文；打开时截断预填为简介，可手改（人工确认原则）。
      条 4②：只传「生成这张图的提示词」——历史产物拿不到就传空，绝不传别栏残留。 */
  promptSummary: string;
  /** 入口上下文预填类型（来源参考组 kinds 解析；缺省 keyframe）。 */
  defaultKind?: PromoteAssetKind;
  /** 来源参考组名（展示用，如「道具」——让类型预填有来路）。 */
  sourceLaneLabel?: string | null;
  generationRequestId?: string | null;
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  onClose: () => void;
  /** 成功回调：页面 toast「已入资产库，下次生成可 @ 引用」并关闭弹窗。 */
  onPromoted: (result: PromoteResult) => void;
}

type SubmitStep = "fetch" | "ingest" | "upload";

export function PromoteToAssetModal({
  projectId,
  shot,
  media,
  promptSummary,
  defaultKind,
  sourceLaneLabel,
  generationRequestId,
  demoMode,
  notify,
  onClose,
  onPromoted,
}: PromoteToAssetModalProps): React.JSX.Element {
  /* 条 4②：表单 state 按入口上下文（media 维度 key 重挂载）隔离初始化——
     名称/类型/简介全部只从本次入口 props 派生，切入口必重置，无跨组残留。 */
  const [name, setName] = useState(() => defaultPromoteName(shot));
  const [kind, setKind] = useState<PromoteAssetKind>(() => resolvePromoteKind(defaultKind ?? DEFAULT_PROMOTE_KIND));
  const [intro, setIntro] = useState(() => summarizePrompt(promptSummary));
  const [busyStep, setBusyStep] = useState<SubmitStep | "">("");
  const [error, setError] = useState("");
  // 断点续传：已完成的步骤（取图/登记实体）在重试时不重跑，避免重复建资产实体。
  const doneRef = useRef<{ file?: File; assetId?: string }>({});
  const busy = busyStep !== "";
  const url = media.storage_url?.trim() ?? "";

  async function submit(): Promise<void> {
    if (busy) return;
    if (demoMode) {
      notify("离线演示不会写入资产库。", "info");
      return;
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("请先填写资产名称。");
      return;
    }
    if (!url) {
      setError("产物图地址缺失，无法入库。请重新生成后再试。");
      return;
    }
    setError("");
    try {
      let file = doneRef.current.file;
      if (!file) {
        setBusyStep("fetch");
        file = await fetchResultFile(url, trimmedName);
        doneRef.current.file = file;
      }
      let assetId = doneRef.current.assetId;
      if (!assetId) {
        setBusyStep("ingest");
        const ingested = await api.ingestJsonAssets(
          [buildPromoteIngestItem({
            kind,
            name: trimmedName,
            intro: intro.trim(),
            sourceUrl: url,
            generationRequestId,
            shotId: shot.id,
          })],
          { source_project_id: projectId },
        );
        assetId = ingested.items[0]?.id ?? "";
        if (!assetId) throw new ApiClientError("资产库已受理但响应缺少新资产编号，请重试", { code: "invalid_response" });
        doneRef.current.assetId = assetId;
      }
      setBusyStep("upload");
      await api.uploadAssetMedia(assetId, file, { title: trimmedName, isPrimary: true });
      setBusyStep("");
      onPromoted({ assetId, name: trimmedName, kind });
    } catch (reason) {
      setBusyStep("");
      setError(humanErrorMessage(reason, "转为参考资产失败，请重试"));
    }
  }

  const stepLabel = busyStep === "fetch"
    ? "正在读取产物图…"
    : busyStep === "ingest"
      ? "正在登记资产…"
      : busyStep === "upload"
        ? "正在挂图…"
        : "";
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent size="small">
        <DialogHeader>
          <DialogTitle>转为参考资产</DialogTitle>
          <DialogDescription>把这张生成图登记进资产库，下次生成可 @ 引用。</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {url ? <img className="max-h-[220px] w-full rounded-md border border-border-1 bg-surface-well object-contain" src={url} alt={`待入库产物图 · ${name.trim() || "未命名"}`} /> : null}
          <Field label="资产名称">
            <Input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="资产类型" hint={sourceLaneLabel ? `已按来源组「${sourceLaneLabel}」预填，可改` : undefined}>
            <Select value={kind} disabled={busy} onChange={(event) => setKind(resolvePromoteKind(event.target.value))}>
              <AssetKindSelectOptions />
            </Select>
          </Field>
          <Field label="简介（已按生成提示词预填，可修改）">
            <Textarea rows={4} value={intro} disabled={busy} onChange={(event) => setIntro(event.target.value)} />
          </Field>
          {error ? <div className="rounded-md border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}（已完成的步骤不会重复提交，可直接重试）</div> : null}
        </DialogBody>
        <DialogFooter>
          <span className="mr-auto text-xs text-ink-2">入库后可在生成时 @ 引用作参考</span>
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" icon={<FolderPlus />} loading={busy} onClick={() => void submit()}>
            {busy ? stepLabel : error ? "重试入库" : "确认入库"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 步骤 a/b：跨域取产物图并包成 File；跨域、超大、非图片都给人话错误。 */
async function fetchResultFile(url: string, name: string): Promise<File> {
  let response: Response;
  try {
    // 登录保护的本站图片代理：不依赖浏览器跨域配置，也不暴露开放带宽入口。
    response = await fetchReadableImage(url);
  } catch {
    throw new Error("产物图暂时无法读取，请稍后重试。");
  }
  if (!response.ok) throw new Error("产物图暂时无法读取，请稍后重试。");
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    throw new Error("产物图读取中断，请重试。");
  }
  if (blob.size > PROMOTE_MAX_FILE_BYTES) throw new Error("产物图超过 10MB，资产库无法接收。");
  if (blob.type && !blob.type.startsWith("image/")) throw new Error("产物不是可入库的图片格式。");
  return new File([blob], promoteFileName(name), { type: blob.type || "image/jpeg" });
}
