/* ============================================================
   lite-asset-add-image-dialog.tsx — Lite 素材页弹窗 B(给变体加图/加音频)

   口径(第三版,按用户反馈重构):
   - 两个 tab:[📷/🎵 本地上传] [🤖 AI 生成]
   - 纯上传类型(light_ref/photo_ref/video_ref):只显示上传 tab
   - 音频资产(asset_kind=audio):本地上传(2026-08-18 用户裁定) + AI 生成(文本)
   - mode = "add_image":预填资产信息(给已有变体加图)
   - mode = "new_variant":首变体(资产无任何变体)预填资产名称/描述/备注,已有变体时空白(v2.4 裁定)
   - 参考图:多图上传区(非槽位制),缩略图展示 + 删除
   - AI 生成:模型/比例选择器 + 提示词(可 AI 优化) + 参考图
     - 生成流程:上传参考图 → estimate → confirm → submit
   - 音频 AI:模型 + 音质/格式/时长三级级联(全落真实原子档) + 语速/音调/响度滑块(自由参数不进档);
     音色栏已删(2026-08-18 用户裁定:暂时不需要音色),提交体不含 speaker_id,由后端/供应商默认音色兜底
     - 音频文本同样可 AI 优化对白(2026-08-18 用户裁定):文本为空→从资产名/描述起草,
       有文本→润色语气/停顿;走后端 draftPrompt mediaKind=audio 对白写手分支
   - 不展示已有版本列表(详情页底轨已有)
   ============================================================ */
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash, Upload } from "@phosphor-icons/react";
import { ApiClientError, api, type LiteAssetDetail, type TieredGenerationSubmissionInput } from "../../api";
import { Button } from "../../components/ui/button";
import { Field, Input, Textarea } from "../../components/ui/primitives";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  DEMO_IMAGE_TIERS,
  FALLBACK_AUDIO_TIER,
  FALLBACK_IMAGE_TIER,
  FALLBACK_TIERS,
  activeTiers,
  listCapabilityTiers,
  tierModelLabel,
  tierSubmitInput,
  type CapabilityTier,
} from "../../capability-tiers";
import type { GenerationDefaultStrategy, GenerationMediaKind, MediaVersion } from "../../types";
import { assembleAssetImagePrompt, effectivePromptTemplate } from "../../lite-prompt-templates";
import { cheapestActiveTier, pickLiteDefaultTier } from "./lite-generation";
import { humanErrorMessage } from "../batch-generate-drawer";
import type { PageRuntimeProps } from "../global-pages";
import { newId } from "../../uuid";

/** Lite 提交体 = 后端 generationInputShape 的窄子集(不带 prompt)。 */
type LiteSubmissionInput = Omit<TieredGenerationSubmissionInput, "prompt"> & {
  supplement_prompt?: string;
};

export interface LiteAssetAddImageDialogProps {
  projectId: string;
  assetEntityId: string;
  /** 默认打开哪个 tab(从空状态引导卡或详情页 [+新建资产] 带入)。 */
  defaultSource: "upload" | "ai";
  /** 弹窗模式:add_image = 给已有变体加图(预填);new_variant = 新建变体(首变体预填,已有变体空白)。 */
  mode?: "add_image" | "new_variant";
  /** 资产当前无任何变体(=本次 new_variant 创建的是第一个变体,v2.4 裁定:首变体预填资产信息)。add_image 模式忽略。 */
  noExistingVariant?: boolean;
  /** add_image 模式下当前选中的变体 id(上传图落到该变体);new_variant 模式用返回的变体 id,可忽略。 */
  variantId?: string;
  /** 资产详情(预填用);父组件已加载,直接传入。 */
  asset: LiteAssetDetail | null;
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  onClose: () => void;
  onCompleted: () => void;
}

/** 纯上传参考类型:只显示上传 tab,不显示 AI 生成 tab。 */
const UPLOAD_ONLY_KINDS: ReadonlySet<string> = new Set(["light_ref", "photo_ref", "video_ref"]);

/** 本地上传音频扩展名白名单(与后端 inspectUploadedAudio 的 magic-byte 白名单同口径)。 */
const AUDIO_UPLOAD_EXTENSIONS = /\.(mp3|wav|ogg|aac|flac)$/i;

type TabSource = "upload" | "ai";

/** 参考图本地项(生成时上传到服务端,拿 media_id 做 reference_media_ids)。 */
interface LocalRefImage {
  id: string;
  file: File;
  previewUrl: string;
}

/** 上传区本地项(缩略图卡片,预览 + 文件名 + 大小)。 */
interface LocalUploadFile {
  id: string;
  file: File;
  previewUrl: string;
}

/** 文件大小格式化:1KB 以下按 B,1MB 以下按 KB,其余按 MB。 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function LiteAssetAddImageDialog({
  projectId,
  assetEntityId,
  defaultSource,
  mode = "add_image",
  variantId,
  noExistingVariant = false,
  asset,
  demoMode,
  notify,
  onClose,
  onCompleted,
}: LiteAssetAddImageDialogProps): React.JSX.Element {
  const isUploadOnly = asset ? UPLOAD_ONLY_KINDS.has(asset.asset_kind) : false;
  /** 音频资产（asset_kind=audio）：无参考图概念；本地上传与 AI 生成（文本）均可。 */
  const isAudio = asset?.asset_kind === "audio";
  /** 弹窗媒体类型：图片路径保持原逻辑，音频走参数化分支。 */
  const kind: GenerationMediaKind = isAudio ? "audio" : "image";
  /** 本地上传 tab 全媒体开放：图片收 jpg/png/webp（≤10MB），音频收 mp3/wav/ogg/aac/flac（≤20MB）。 */
  const hasUploadTab = true;
  const initialTab: TabSource = hasUploadTab ? (isUploadOnly ? "upload" : defaultSource) : "ai";
  const [tab, setTab] = useState<TabSource>(initialTab);
  const isNewVariant = mode === "new_variant";

  // 切换 defaultSource 时同步(例如用户从空状态点"上传"后弹窗已打开又点"生成")
  useEffect(() => {
    if (!isUploadOnly) setTab(defaultSource);
  }, [defaultSource, isUploadOnly]);

  // --- 共享:资产信息(add_image 恒预填;new_variant 仅首变体即资产无任何变体时预填,v2.4 裁定) ---
  const shouldPrefill = !isNewVariant || noExistingVariant === true;
  const initialNote = shouldPrefill && asset?.metadata_lite && typeof (asset.metadata_lite as Record<string, unknown>).note === "string"
    ? (asset.metadata_lite as Record<string, unknown>).note as string
    : "";
  const [name, setName] = useState(shouldPrefill ? asset?.name ?? "" : "");
  const [intro, setIntro] = useState(shouldPrefill ? asset?.intro ?? "" : "");
  const [note, setNote] = useState(initialNote);
  /** 进入弹窗时的初始备注:syncNewVariantNote 只回写被用户改动的值,避免非首变体(初始空白)覆盖资产已有备注。 */
  const initialNoteRef = useRef(initialNote);

  // --- 上传状态 ---
  const [uploading, setUploading] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<LocalUploadFile[]>([]);

  // --- AI 生成状态 ---
  const [referenceImages, setReferenceImages] = useState<LocalRefImage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [optimizingPrompt, setOptimizingPrompt] = useState(false);
  // --- v1.9 十.3a：提交后弹窗留驻，轮询任务终态；失败留弹窗可重试 ---
  const [genTaskId, setGenTaskId] = useState<string | null>(null);
  const [genPhase, setGenPhase] = useState<"idle" | "running" | "succeeded" | "failed">("idle");
  const [genError, setGenError] = useState<string | null>(null);

  // --- 档(tier)选择器 ---
  const [availableTiers, setAvailableTiers] = useState<CapabilityTier[]>([]);
  const [selectedTier, setSelectedTier] = useState<CapabilityTier | null>(null);
  const [, setStrategy] = useState<GenerationDefaultStrategy | null>(null);
  const [tierLoading, setTierLoading] = useState(true);
  /** 档位列表来自 DEMO 回落(后端未配置图片生成模型),非演示模式下不能真正提交。 */
  const [tiersFromFallback, setTiersFromFallback] = useState(false);
  /** 语速/音调/响度(自由参数,不进档;0=中性,直传 wire speech_rate/pitch_rate/loudness_rate)。 */
  const [speechRate, setSpeechRate] = useState(0);
  const [pitchRate, setPitchRate] = useState(0);
  const [loudnessRate, setLoudnessRate] = useState(0);
  /** 已存音频默认策略(配置页保存的默认档;图片策略继续走本地 setStrategy)。 */
  const strategyRef = useRef<GenerationDefaultStrategy | null>(null);
  /** 预填时的项目图片模板段(切 AI 路径时固定):AI 优化提示词时保留它、覆盖旧资产信息段,不叠加。 */
  const templateRef = useRef("");
  const loadTier = useCallback(async () => {
    setTierLoading(true);
    try {
      const { tiers } = await listCapabilityTiers(kind, demoMode);
      const active = activeTiers(tiers);
      setAvailableTiers(active);
      setTiersFromFallback(false);
      let strat: GenerationDefaultStrategy | null = null;
      if (!demoMode) {
        try {
          strat = await api.generationDefault(projectId, kind);
        } catch (reason) {
          if (!(reason instanceof ApiClientError && reason.status === 404)) throw reason;
        }
        setStrategy(strat);
        strategyRef.current = strat;
      }
      const defaultTier = pickLiteDefaultTier(active, strat)
        ?? (isAudio ? (active[0] ?? FALLBACK_AUDIO_TIER) : FALLBACK_IMAGE_TIER);
      setSelectedTier(defaultTier);
      // 预填提示词(add_image 恒预填;new_variant 仅首变体即 noExistingVariant 时预填,v2.5 裁定):
      // 图片走项目默认风格模板 + 资产名称/描述/备注;音频文本无模板概念,由用户输入,不预填。
      if (shouldPrefill && !isAudio) {
        const library = await api.promptTemplates(projectId, "image").catch(() => ({ items: [] }));
        const template = effectivePromptTemplate(strat, library.items, "image").content;
        templateRef.current = template;
        setPrompt(assembleAssetImagePrompt({
          template,
          name,
          intro,
          notes: note,
        }));
      }
    } catch {
      // 档位接口未配置/不可达 → 回落演示档位,保证 UI 可选;但非演示模式下不能真正提交
      const demoActive = isAudio
        ? activeTiers([...FALLBACK_TIERS.audio])
        : activeTiers([...DEMO_IMAGE_TIERS]);
      setAvailableTiers(demoActive);
      setSelectedTier(demoActive[0] ?? (isAudio ? FALLBACK_AUDIO_TIER : FALLBACK_IMAGE_TIER));
      setTiersFromFallback(true);
    } finally {
      setTierLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, demoMode, shouldPrefill, isAudio, kind]);
  useEffect(() => { void loadTier(); }, [loadTier]);

  // 清理参考图 / 上传区缩略图 object URLs
  useEffect(() => {
    return () => {
      for (const ref of referenceImages) URL.revokeObjectURL(ref.previewUrl);
      for (const item of uploadFiles) URL.revokeObjectURL(item.previewUrl);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- 参考图操作 ---
  function handleAddReferenceFiles(files: FileList | null): void {
    if (!files || files.length === 0) return;
    const newRefs: LocalRefImage[] = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .map((file) => ({ id: newId(), file, previewUrl: URL.createObjectURL(file) }));
    setReferenceImages((prev) => [...prev, ...newRefs]);
  }

  function handleRemoveReference(id: string): void {
    setReferenceImages((prev) => {
      const target = prev.find((r) => r.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((r) => r.id !== id);
    });
  }

  // --- 上传区操作(多选,每文件一张缩略图卡片,逐个删除) ---
  function handleAddUploadFiles(files: FileList | null): void {
    if (!files || files.length === 0) return;
    const newFiles: LocalUploadFile[] = Array.from(files)
      .filter((f) => isAudio
        ? f.type.startsWith("audio/") || AUDIO_UPLOAD_EXTENSIONS.test(f.name)
        : f.type.startsWith("image/"))
      .map((file) => ({ id: newId(), file, previewUrl: URL.createObjectURL(file) }));
    setUploadFiles((prev) => [...prev, ...newFiles]);
  }

  function handleRemoveUploadFile(id: string): void {
    setUploadFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((f) => f.id !== id);
    });
  }

  // --- 上传处理 ---
  async function handleUpload(): Promise<void> {
    if (uploadFiles.length === 0) {
      notify(isAudio ? "请先选择音频文件" : "请先选择图片", "error");
      return;
    }
    if (isNewVariant && !name.trim()) {
      notify("请输入变体名称", "error");
      return;
    }
    setUploading(true);
    try {
      if (!demoMode) {
        // 如果资产还没有主图,第一批上传图自动设为主图
        const willBePrimary = !asset?.has_primary;
        // new_variant 模式:先创建变体,再把图挂到返回的变体上;
        // add_image 模式:复用传入的 variantId(当前选中变体);契约 v1.3.1 六.3:资产无任何变体时先自动创建第一个变体,首图落第一个变体
        let targetVariantId: string | undefined;
        if (isNewVariant) {
          const variant = await api.createAssetVariant(assetEntityId, { name: name.trim(), description: intro.trim() || undefined });
          await syncNewVariantNote();
          targetVariantId = variant.id;
        } else {
          await syncAssetInfo();
          targetVariantId = variantId ?? (await ensureFirstVariantId());
        }
        for (const item of uploadFiles) {
          await api.uploadAssetMedia(assetEntityId, item.file, { isPrimary: willBePrimary, assetVariantId: targetVariantId, mediaKind: isAudio ? "audio" : "image" });
        }
      }
      notify(isAudio ? "音频已上传" : "图片已上传", "success");
      onCompleted();
    } catch (reason) {
      notify(humanErrorMessage(reason, "上传失败,请重试"), "error");
    } finally {
      setUploading(false);
    }
  }

  /** 资产无任何变体时先创建第一个变体(契约 v1.3.1 六.3,与后端 ensureFirstVariant 同口径:name=资产名,variant_kind=look,is_primary=true)。 */
  async function ensureFirstVariantId(): Promise<string> {
    const variant = await api.createAssetVariant(assetEntityId, {
      name: name.trim() || asset?.name?.trim() || "默认",
      variant_kind: "look",
      is_primary: true,
    });
    return variant.id;
  }

  // --- AI 提示词优化 ---
  async function handleOptimizePrompt(): Promise<void> {
    setOptimizingPrompt(true);
    try {
      // 生产意图 = 名称（独立传）+ 画面描述；当前提示词(含项目模板预填段)作为 supplement 传入,
      // 服务端返回 = AI 提示词原文 + supplement 原样追加到末尾(无标签),
      // 避免 AI 优化结果整体覆盖时丢掉项目配置的图片模板段。
      const optimized = await api.draftPrompt({ mediaKind: "image", name: name.trim() || undefined, description: intro.trim() || name.trim(), supplement: prompt, projectId });
      if (optimized.autoPrompt) {
        // 覆盖语义:保留项目模板段(生成期契约走 supplement_prompt),旧资产信息段被 AI 输出替换,不再叠加
        setPrompt([templateRef.current.trim(), optimized.autoPrompt].filter(Boolean).join("\n"));
        notify("提示词已优化", "success");
      } else {
        notify("AI 返回为空,请手动编辑", "error");
      }
    } catch (reason) {
      notify(humanErrorMessage(reason, "AI 优化提示词失败,可能 AI 网关未开启"), "error");
    } finally {
      setOptimizingPrompt(false);
    }
  }

  // --- AI 对白优化(音频):与图片「AI 优化提示词」对齐,走 draftPrompt mediaKind=audio 对白写手分支。
  // 语义:文本为空 → 从资产名称/描述(生产意图)起草可直接合成的对白原文;
  // 文本非空 → 作为对白初稿(supplement)传入,AI 润色语气/停顿/口语自然度。
  // 音频无项目模板概念,templateRef 不参与;结果整体覆盖当前对白文本。 ---
  async function handleOptimizeDialogue(): Promise<void> {
    setOptimizingPrompt(true);
    try {
      const optimized = await api.draftPrompt({ mediaKind: "audio", name: name.trim() || undefined, description: intro.trim() || name.trim(), supplement: prompt, projectId });
      if (optimized.autoPrompt) {
        setPrompt(optimized.autoPrompt);
        notify("对白已优化", "success");
      } else {
        notify("AI 返回为空,请手动编辑", "error");
      }
    } catch (reason) {
      notify(humanErrorMessage(reason, "AI 优化对白失败,可能 AI 网关未开启"), "error");
    } finally {
      setOptimizingPrompt(false);
    }
  }

  // --- AI 生成处理(上传参考图 → estimate → confirm → submit;音频无参考图概念) ---
  async function handleGenerate(): Promise<void> {
    if (!prompt.trim()) {
      notify(isAudio ? "音频文本不能为空" : "提示词不能为空", "error");
      return;
    }
    if (isNewVariant && !name.trim()) {
      notify("请输入变体名称", "error");
      return;
    }
    if (!selectedTier) {
      notify(isAudio ? "当前没有可用的音频生成档位,请到配置页设置" : "当前没有可用的图片生成档位,请到配置页设置", "error");
      return;
    }
    if (cannotGenerate) {
      notify(isAudio ? "当前环境未配置音频生成模型,请联系管理员到配置页启用" : "当前环境未配置图片生成模型,请联系管理员到配置页启用", "error");
      return;
    }
    setGenerating(true);
    setGenPhase("idle");
    setGenError(null);
    try {
      if (!demoMode) {
        // v1.9 十.10：从哪个变体发起，产物就归属哪个变体。
        // new_variant 模式:先创建变体并记住 id;add_image 模式:用当前选中变体(无则建第一个)。
        let targetVariantId: string | undefined;
        if (isNewVariant) {
          const variant = await api.createAssetVariant(assetEntityId, { name: name.trim(), description: intro.trim() || undefined });
          await syncNewVariantNote();
          targetVariantId = variant.id;
        } else {
          await syncAssetInfo();
          // 契约 v1.3.1 六.3:无任何变体时先建第一个变体,生成图归属第一个变体
          targetVariantId = variantId ?? (await ensureFirstVariantId());
        }

        // 上传参考图,收集 media_ids(图片专用;音频全用途参考集合只收图片/视频,不带)
        const refIds: string[] = [];
        if (!isAudio) {
          for (const ref of referenceImages) {
            const media: MediaVersion = await api.uploadAssetMedia(assetEntityId, ref.file, { isPrimary: false });
            refIds.push(media.id);
          }
        }

        // 三步链路:estimate → confirm → submit(v1.9 十.7:Lite 自动确认并入 submit)
        const { parameters, quantity } = tierSubmitInput(selectedTier);
        const input: LiteSubmissionInput = {
          media_kind: kind,
          tier_id: selectedTier.tier_id,
          project_id: projectId,
          target_asset_entity_id: assetEntityId,
          ...(targetVariantId ? { target_asset_variant_id: targetVariantId } : {}),
          // 音频:档冻参数 + 语速/音调/响度自由参数(非 0 才带,不进档);图片:档参数原样
          // (音色栏已删:提交体不含 speaker_id,由后端/供应商默认音色兜底)
          parameters: isAudio ? {
            ...parameters,
            ...(speechRate !== 0 ? { speech_rate: speechRate } : {}),
            ...(loudnessRate !== 0 ? { loudness_rate: loudnessRate } : {}),
            ...(pitchRate !== 0 ? { pitch_rate: pitchRate } : {}),
          } : parameters,
          quantity,
          client_idempotency_key: newId(),
          supplement_prompt: prompt.trim(),
          // 音频全用途参考集合只收图片/视频,音频恒空数组;图片传参考图 media_ids
          reference_media_ids: isAudio ? [] : refIds,
        };

        const quote = await api.quoteGeneration(input as TieredGenerationSubmissionInput);
        const task = await api.createGeneration(input as TieredGenerationSubmissionInput, quote.generation_quote_id, true);
        // 提交成功≠生成完成:弹窗留驻,转生成中态轮询终态(十.3a)
        setGenTaskId(task.generation_request_id);
        setGenPhase("running");
      } else {
        notify(isAudio ? "音频生成中,完成后将自动刷新" : "图片生成中,完成后将自动刷新", "success");
        onCompleted();
      }
    } catch (reason) {
      notify(humanErrorMessage(reason, isAudio ? "生成失败,请重试" : "生成失败,请重试"), "error");
    } finally {
      setGenerating(false);
    }
  }

  /** v1.9 十.3a：轮询任务终态;成功才关弹窗刷新,失败留弹窗。 */
  useEffect(() => {
    if (!genTaskId || genPhase !== "running" || demoMode) return;
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const task = await api.generation(genTaskId);
        if (!active) return;
        if (task.status === "succeeded") {
          setGenPhase("succeeded");
          notify(isAudio ? "音频生成完成" : "图片生成完成", "success");
          onCompleted();
        } else if (task.status === "failed" || task.status === "cancelled") {
          setGenPhase("failed");
          setGenError(task.display_reason ?? (isAudio ? "生成失败,可重试" : "生成失败,可重试"));
        }
        // 轮询失败不打断,等下一拍
      } catch {
        // 轮询失败不打断,等下一拍
      }
    }, 4000);
    return () => { active = false; window.clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genTaskId, genPhase, demoMode]);

  /** 同步资产信息修改到后端(只在用户改过时才调)。 */
  async function syncAssetInfo(): Promise<void> {
    if (!asset) return;
    const patch: { name?: string; intro?: string | null; note?: string | null } = {};
    if (name.trim() !== asset.name) patch.name = name.trim();
    if (intro.trim() !== (asset.intro ?? "")) patch.intro = intro.trim() || null;
    const originalNote = typeof asset.metadata_lite?.note === "string" ? asset.metadata_lite.note : "";
    if (note.trim() !== originalNote) patch.note = note.trim() || null;
    if (Object.keys(patch).length > 0) {
      await api.liteUpdateAsset(projectId, assetEntityId, patch);
    }
  }

  /** new_variant 模式:备注同为资产级字段 metadata.lite.note(§4.4.3)——createAssetVariant
   *  契约无 note 字段,走 add_image 同款资产备注路径,不扩变体契约。
   *  只回写被用户改动的值(对比弹窗初始备注),避免非首变体(初始空白)把资产已有备注清空。 */
  async function syncNewVariantNote(): Promise<void> {
    if (!asset) return;
    if (note.trim() !== initialNoteRef.current.trim()) {
      await api.liteUpdateAsset(projectId, assetEntityId, { note: note.trim() || null });
    }
  }

  const busy = uploading || generating || optimizingPrompt;
  /** 非演示模式 + 档位来自回落 → 不能真正提交生成请求(后端没有这些档位)。 */
  const cannotGenerate = !demoMode && tiersFromFallback;

  // --- 模型 / 比例 / 清晰度三级级联选择器(v1.4 七.3 决策 2,从 selectedTier 派生) ---
  const selectedModel = selectedTier ? tierModelLabel(selectedTier) : "";
  const selectedRatio = typeof selectedTier?.params.aspect_ratio === "string" ? selectedTier.params.aspect_ratio : "";
  /** 清晰度:档登记键 resolution,兼容读法 size(与 lite-generation.ts tierResolutionOf 同款)。 */
  const selectedResolution = (() => {
    const dim = selectedTier?.params.resolution;
    return typeof dim === "string" ? dim : typeof selectedTier?.params.size === "string" ? selectedTier.params.size : "";
  })();

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of availableTiers) {
      const label = tierModelLabel(t);
      if (!seen.has(label)) { seen.add(label); out.push(label); }
    }
    return out;
  }, [availableTiers]);

  const ratioOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of availableTiers) {
      if (tierModelLabel(t) !== selectedModel) continue;
      const r = typeof t.params.aspect_ratio === "string" ? t.params.aspect_ratio : "";
      if (r && !seen.has(r)) { seen.add(r); out.push(r); }
    }
    return out;
  }, [availableTiers, selectedModel]);

  /** 切模型 → 选该模型下项目默认档(比例/清晰度随之收敛,resolveLiteTier 同款口径)。 */
  function handleModelChange(model: string): void {
    const tier = pickLiteDefaultTier(availableTiers.filter((t) => tierModelLabel(t) === model), null);
    if (tier) setSelectedTier(tier);
  }

  /** 切比例 → 当前模型内匹配档;清晰度收敛到最便宜,可再经第三级改(七.3)。 */
  function handleRatioChange(ratio: string): void {
    const matching = availableTiers.filter((t) =>
      tierModelLabel(t) === selectedModel && t.params.aspect_ratio === ratio,
    );
    const best = cheapestActiveTier(matching);
    if (best) setSelectedTier(best);
  }

  /** 清晰度选项 = 当前模型同比例下真实存在 active 档的分辨率全集(七.3 第三级)。 */
  const resolutionOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of availableTiers) {
      if (tierModelLabel(t) !== selectedModel || t.params.aspect_ratio !== selectedRatio) continue;
      const r = typeof t.params.resolution === "string" ? t.params.resolution
        : typeof t.params.size === "string" ? t.params.size : "";
      if (r && !seen.has(r)) { seen.add(r); out.push(r); }
    }
    return out;
  }, [availableTiers, selectedModel, selectedRatio]);

  /** 切清晰度 → 精确定位档(v1.4:不再恒取最便宜档)。 */
  function handleResolutionChange(resolution: string): void {
    const matching = availableTiers.filter((t) => {
      if (tierModelLabel(t) !== selectedModel || t.params.aspect_ratio !== selectedRatio) return false;
      const r = typeof t.params.resolution === "string" ? t.params.resolution
        : typeof t.params.size === "string" ? t.params.size : "";
      return r === resolution;
    });
    const best = cheapestActiveTier(matching);
    if (best) setSelectedTier(best);
  }

  // --- 音频参数三级级联:音质(sample_rate)/格式(format)/时长(duration_seconds)(2026-08-18 用户裁定) ---
  /** 音质:档登记键 sample_rate(数字,Hz);无则 NaN → 下拉显示「—」。 */
  const selectedSampleRate = typeof selectedTier?.params.sample_rate === "number" ? selectedTier.params.sample_rate : NaN;
  const selectedFormat = typeof selectedTier?.params.format === "string" ? selectedTier.params.format : "";
  /** 时长:档登记键 duration_seconds,兼容读法 original_duration_seconds(与 generation-dimensions 同款回落)。 */
  const selectedDurationSeconds = typeof selectedTier?.params.duration_seconds === "number"
    ? selectedTier.params.duration_seconds
    : typeof selectedTier?.params.original_duration_seconds === "number" ? selectedTier.params.original_duration_seconds : NaN;

  /** 音质选项 = 当前模型下真实存在 active 档的 sample_rate 全集(升序)。 */
  const sampleRateOptions = useMemo(() => {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const t of availableTiers) {
      if (tierModelLabel(t) !== selectedModel) continue;
      const sr = typeof t.params.sample_rate === "number" ? t.params.sample_rate : NaN;
      if (Number.isFinite(sr) && !seen.has(sr)) { seen.add(sr); out.push(sr); }
    }
    return out.sort((a, b) => a - b);
  }, [availableTiers, selectedModel]);

  /** 格式选项 = 当前模型 + 音质下真实存在 active 档的 format 全集。 */
  const audioFormatOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of availableTiers) {
      if (tierModelLabel(t) !== selectedModel) continue;
      const sr = typeof t.params.sample_rate === "number" ? t.params.sample_rate : NaN;
      if (sr !== selectedSampleRate) continue;
      const fmt = typeof t.params.format === "string" ? t.params.format : "";
      if (fmt && !seen.has(fmt)) { seen.add(fmt); out.push(fmt); }
    }
    return out;
  }, [availableTiers, selectedModel, selectedSampleRate]);

  /** 时长选项 = 当前模型 + 音质 + 格式下真实存在 active 档的秒数全集(升序)。 */
  const durationOptions = useMemo(() => {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const t of availableTiers) {
      if (tierModelLabel(t) !== selectedModel) continue;
      const sr = typeof t.params.sample_rate === "number" ? t.params.sample_rate : NaN;
      if (sr !== selectedSampleRate || t.params.format !== selectedFormat) continue;
      const dur = typeof t.params.duration_seconds === "number" ? t.params.duration_seconds
        : typeof t.params.original_duration_seconds === "number" ? t.params.original_duration_seconds : NaN;
      if (Number.isFinite(dur) && !seen.has(dur)) { seen.add(dur); out.push(dur); }
    }
    return out.sort((a, b) => a - b);
  }, [availableTiers, selectedModel, selectedSampleRate, selectedFormat]);

  /** 切音质 → 当前模型内匹配档,格式/时长收敛到最便宜,可再经后续级改。 */
  function handleSampleRateChange(sampleRate: string): void {
    const matching = availableTiers.filter((t) => {
      if (tierModelLabel(t) !== selectedModel) return false;
      const sr = typeof t.params.sample_rate === "number" ? t.params.sample_rate : NaN;
      return sr === Number(sampleRate);
    });
    const best = cheapestActiveTier(matching);
    if (best) setSelectedTier(best);
  }

  /** 切格式 → 当前模型 + 音质内匹配档。 */
  function handleAudioFormatChange(format: string): void {
    const matching = availableTiers.filter((t) => {
      if (tierModelLabel(t) !== selectedModel) return false;
      const sr = typeof t.params.sample_rate === "number" ? t.params.sample_rate : NaN;
      return sr === selectedSampleRate && t.params.format === format;
    });
    const best = cheapestActiveTier(matching);
    if (best) setSelectedTier(best);
  }

  /** 切时长 → 当前模型 + 音质 + 格式内匹配档。 */
  function handleDurationChange(duration: string): void {
    const matching = availableTiers.filter((t) => {
      if (tierModelLabel(t) !== selectedModel) return false;
      const sr = typeof t.params.sample_rate === "number" ? t.params.sample_rate : NaN;
      if (sr !== selectedSampleRate || t.params.format !== selectedFormat) return false;
      const dur = typeof t.params.duration_seconds === "number" ? t.params.duration_seconds
        : typeof t.params.original_duration_seconds === "number" ? t.params.original_duration_seconds : NaN;
      return dur === Number(duration);
    });
    const best = cheapestActiveTier(matching);
    if (best) setSelectedTier(best);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>{isNewVariant ? "新建变体" : isAudio ? "给变体加音频" : "给变体加图"}</DialogTitle>
          <DialogDescription>
            {isNewVariant
              ? isAudio
                ? "填写变体信息,输入文本用 AI 合成音频。"
                : "填写变体信息,上传或 AI 生成图片。"
              : isUploadOnly
                ? "上传参考图(纯上传类型不支持 AI 生成)"
                : isAudio
                  ? "输入对白/旁白文本,用 AI 合成音频。新音频默认为候选版本,可在详情页设为主音频。"
                  : "上传图片或使用 AI 生成。新图片默认为候选版本,可在详情页设为主图。"}
          </DialogDescription>
        </DialogHeader>

        {/* tab 条 */}
        <div className="flex gap-1 border-b border-border-1 px-4">
          {hasUploadTab && (
            <button
              className={`border-b-2 px-4 py-2 text-sm transition-colors ${
                tab === "upload" ? "border-accent text-accent" : "border-transparent text-ink-3 hover:text-ink-1"
              }`}
              onClick={() => setTab("upload")}
            >{isAudio ? "🎵 本地上传" : "📷 本地上传"}</button>
          )}
          {!isUploadOnly && (
            <button
              className={`border-b-2 px-4 py-2 text-sm transition-colors ${
                tab === "ai" ? "border-accent text-accent" : "border-transparent text-ink-3 hover:text-ink-1"
              }`}
              onClick={() => setTab("ai")}
            >🤖 AI 生成</button>
          )}
        </div>

        <DialogBody className="flex flex-col gap-4">
          {/* 资产信息(两 tab 共享) */}
          <div className="flex flex-col gap-3 rounded-md bg-surface-well/30 p-3">
            <div className="flex gap-3">
              <Field label="名称" className="flex-1">
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={isNewVariant ? "输入变体名称" : undefined} />
              </Field>
              <Field label="备注" className="flex-1">
                <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
              </Field>
            </div>
            <Field label="描述">
              <Textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={2} maxLength={500} />
            </Field>
          </div>

          {tab === "upload" ? (
            /* 上传区:缩略图卡片(预览 + 文件名 + 大小 + 右上角删除),多选逐张卡片 */
            <div className="flex flex-col gap-3 rounded-lg border-2 border-dashed border-border-1 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-ink-3">
                  {uploadFiles.length > 0
                    ? isAudio ? `已选择 ${uploadFiles.length} 个音频` : `已选择 ${uploadFiles.length} 张图片`
                    : isAudio ? "拖拽音频到这里,或点击选择文件" : "拖拽图片到这里,或点击选择文件"}
                </p>
                <label className="cursor-pointer shrink-0">
                  <input
                    type="file"
                    accept={isAudio ? "audio/*" : "image/jpeg,image/png,image/webp"}
                    multiple
                    className="hidden"
                    onChange={(e) => handleAddUploadFiles(e.target.files)}
                  />
                  <span className="inline-flex h-8 items-center gap-1 rounded-md border border-border-1 bg-surface-1 px-3 text-sm text-ink-2 hover:bg-surface-well">
                    <Upload className="size-3.5" /> 选择文件
                  </span>
                </label>
              </div>
              <p className="text-xs text-ink-4">
                {isAudio ? "支持 mp3 / wav / ogg / aac / flac,最大 20MB,可多选" : "支持 jpg / png / webp,最大 10MB,可多选"}
              </p>
              {uploadFiles.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {uploadFiles.map((item) => (
                    <div key={item.id} className={`rounded-md border border-border-1 bg-surface-1 p-2 ${isAudio ? "w-72" : "w-40"}`}>
                      <div className="group relative">
                        {isAudio ? (
                          <audio controls preload="metadata" className="h-10 w-full" src={item.previewUrl} />
                        ) : (
                          <img
                            src={item.previewUrl}
                            alt={item.file.name}
                            className="h-20 w-full rounded-md border border-border-1 object-cover"
                          />
                        )}
                        <button
                          className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-surface-1 text-ink-3 shadow-sm ring-1 ring-border-1 hover:bg-error hover:text-white"
                          type="button"
                          aria-label={isAudio ? "移除音频" : "移除图片"}
                          onClick={() => handleRemoveUploadFile(item.id)}
                        >
                          <Trash className="size-3" />
                        </button>
                      </div>
                      <div className="mt-2 truncate text-xs text-ink-2" title={item.file.name}>{item.file.name}</div>
                      <div className="text-[11px] text-ink-4">{formatFileSize(item.file.size)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* AI 生成区 */
            <div className="flex flex-col gap-4">
              {cannotGenerate && (
                <div className="rounded-md border border-border-1 bg-surface-well/50 px-3 py-2 text-sm text-ink-3">
                  {isAudio
                    ? "当前环境未配置音频生成模型,以下为示例选项。请联系管理员到配置页添加音频生成模型后再生成。"
                    : "当前环境未配置图片生成模型,以下为示例选项。请联系管理员到配置页添加图片生成模型后再生成。"}
                </div>
              )}
              {/* 参考图区(多图上传,非槽位制;音频无参考图概念) */}
              {!isAudio && (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium text-ink-2">参考图</span>
                    <label className="cursor-pointer">
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        multiple
                        className="hidden"
                        onChange={(e) => handleAddReferenceFiles(e.target.files)}
                      />
                      <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border-1 bg-surface-1 px-2.5 text-xs text-ink-2 hover:bg-surface-well">
                        <Upload className="size-3.5" /> 上传参考图
                      </span>
                    </label>
                  </div>
                  {referenceImages.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {referenceImages.map((ref) => (
                        <div key={ref.id} className="group relative">
                          <img
                            src={ref.previewUrl}
                            alt="参考图"
                            className="h-20 w-20 rounded-md border border-border-1 object-cover"
                          />
                          <button
                            className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-surface-1 text-ink-3 shadow-sm ring-1 ring-border-1 hover:bg-error hover:text-white"
                            type="button"
                            onClick={() => handleRemoveReference(ref.id)}
                          >
                            <Trash className="size-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-ink-4">不上传参考图时按提示词生成;多张参考图综合脸部、服装、姿态。</p>
                  )}
                </div>
              )}

              {/* 提示词区(音频=要合成的对白/旁白文本) */}
              <Field label={isAudio ? "音频文本" : "提示词"}>
                <div className="flex flex-col gap-1.5">
                  <Textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={5}
                    maxLength={2000}
                    placeholder={isAudio
                      ? "输入要合成的对白 / 旁白原文,可含角色语气提示"
                      : isNewVariant ? "输入生成提示词,或点下方 AI 优化自动生成" : "项目模板 + 类型模板 + 资产信息已预填,可在此补充修改"}
                  />
                  {!isAudio ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 self-start text-xs"
                      loading={optimizingPrompt}
                      onClick={() => void handleOptimizePrompt()}
                    >✨ AI 优化提示词</Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 self-start text-xs"
                      loading={optimizingPrompt}
                      onClick={() => void handleOptimizeDialogue()}
                    >✨ AI 优化对白</Button>
                  )}
                </div>
              </Field>

              {isAudio ? (
                /* 音频模式:档(模型)下拉 + 音质/格式/时长三级级联 + 语速/音调/响度滑块;无参考图/比例/清晰度概念;音色栏已删(2026-08-18 用户裁定) */
                <div className="flex flex-col gap-3 rounded-md border border-border-1 bg-surface-well/30 p-3">
                  <Field label="模型">
                    <select
                      className="h-9 w-full rounded-md border border-border-1 bg-surface-1 px-3 text-sm text-ink-1"
                      value={selectedModel}
                      disabled={tierLoading || modelOptions.length === 0}
                      onChange={(e) => handleModelChange(e.target.value)}
                    >
                      {tierLoading ? (
                        <option value="">加载中…</option>
                      ) : modelOptions.length === 0 ? (
                        <option value="">暂无可用模型</option>
                      ) : modelOptions.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </Field>
                  <div className="flex items-end gap-3">
                    <Field label="音质" className="w-24 shrink-0">
                      <select
                        className="h-9 w-full rounded-md border border-border-1 bg-surface-1 px-3 text-sm text-ink-1"
                        value={Number.isFinite(selectedSampleRate) ? String(selectedSampleRate) : ""}
                        disabled={tierLoading || sampleRateOptions.length === 0}
                        onChange={(e) => handleSampleRateChange(e.target.value)}
                      >
                        {sampleRateOptions.length === 0 ? (
                          <option value="">—</option>
                        ) : sampleRateOptions.map((sr) => (
                          <option key={sr} value={String(sr)}>{sr / 1000}kHz</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="格式" className="w-24 shrink-0">
                      <select
                        className="h-9 w-full rounded-md border border-border-1 bg-surface-1 px-3 text-sm text-ink-1"
                        value={selectedFormat}
                        disabled={tierLoading || audioFormatOptions.length === 0}
                        onChange={(e) => handleAudioFormatChange(e.target.value)}
                      >
                        {audioFormatOptions.length === 0 ? (
                          <option value="">—</option>
                        ) : audioFormatOptions.map((fmt) => (
                          <option key={fmt} value={fmt}>{fmt.toUpperCase()}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="时长" className="w-28 shrink-0">
                      <select
                        className="h-9 w-full rounded-md border border-border-1 bg-surface-1 px-3 text-sm text-ink-1"
                        value={Number.isFinite(selectedDurationSeconds) ? String(selectedDurationSeconds) : ""}
                        disabled={tierLoading || durationOptions.length === 0}
                        onChange={(e) => handleDurationChange(e.target.value)}
                      >
                        {durationOptions.length === 0 ? (
                          <option value="">—</option>
                        ) : durationOptions.map((dur) => (
                          <option key={dur} value={String(dur)}>{dur} 秒</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  {/* 语速/音调/响度:自由参数,不进档(档是原子;直传 wire speech_rate/pitch_rate/loudness_rate,0=中性不提交) */}
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="语速">
                      <div className="flex flex-col gap-1">
                        <input
                          type="range"
                          min={-50}
                          max={100}
                          step={1}
                          value={speechRate}
                          onChange={(e) => setSpeechRate(Number(e.target.value))}
                          className="w-full accent-accent"
                        />
                        <span className="text-xs text-ink-4">{speechRate > 0 ? `+${speechRate}` : speechRate}</span>
                      </div>
                    </Field>
                    <Field label="音调">
                      <div className="flex flex-col gap-1">
                        <input
                          type="range"
                          min={-12}
                          max={12}
                          step={1}
                          value={pitchRate}
                          onChange={(e) => setPitchRate(Number(e.target.value))}
                          className="w-full accent-accent"
                        />
                        <span className="text-xs text-ink-4">{pitchRate > 0 ? `+${pitchRate}` : pitchRate}</span>
                      </div>
                    </Field>
                    <Field label="响度">
                      <div className="flex flex-col gap-1">
                        <input
                          type="range"
                          min={-50}
                          max={100}
                          step={1}
                          value={loudnessRate}
                          onChange={(e) => setLoudnessRate(Number(e.target.value))}
                          className="w-full accent-accent"
                        />
                        <span className="text-xs text-ink-4">{loudnessRate > 0 ? `+${loudnessRate}` : loudnessRate}</span>
                      </div>
                    </Field>
                  </div>
                </div>
              ) : (
                /* 模型 / 比例 / 清晰度三级级联选择器(v1.4 七.3 决策 2) */
                <div className="flex items-end gap-3">
                  <Field label="模型" className="flex-1">
                    <select
                      className="h-9 w-full rounded-md border border-border-1 bg-surface-1 px-3 text-sm text-ink-1"
                      value={selectedModel}
                      disabled={tierLoading || modelOptions.length === 0}
                      onChange={(e) => handleModelChange(e.target.value)}
                    >
                      {tierLoading ? (
                        <option value="">加载中…</option>
                      ) : modelOptions.length === 0 ? (
                        <option value="">暂无可用模型</option>
                      ) : modelOptions.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="比例" className="w-24 shrink-0">
                    <select
                      className="h-9 w-full rounded-md border border-border-1 bg-surface-1 px-3 text-sm text-ink-1"
                      value={selectedRatio}
                      disabled={tierLoading || ratioOptions.length === 0}
                      onChange={(e) => handleRatioChange(e.target.value)}
                    >
                      {ratioOptions.length === 0 ? (
                        <option value="">—</option>
                      ) : ratioOptions.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="清晰度" className="w-28 shrink-0">
                    <select
                      className="h-9 w-full rounded-md border border-border-1 bg-surface-1 px-3 text-sm text-ink-1"
                      value={selectedResolution}
                      disabled={tierLoading || resolutionOptions.length === 0}
                      onChange={(e) => handleResolutionChange(e.target.value)}
                    >
                      {resolutionOptions.length === 0 ? (
                        <option value="">—</option>
                      ) : resolutionOptions.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy || genPhase === "running"}>取消</Button>
          {tab === "upload" ? (
            <Button variant="primary" loading={uploading} disabled={uploadFiles.length === 0} onClick={() => void handleUpload()}>
              {isAudio ? "上传音频" : "上传图片"}
            </Button>
          ) : genPhase === "running" ? (
            <Button variant="primary" loading disabled>已提交,生成中…</Button>
          ) : genPhase === "failed" ? (
            <Button variant="primary" onClick={() => void handleGenerate()}>重试</Button>
          ) : (
            <Button
              variant="primary"
              loading={generating || tierLoading}
              disabled={tierLoading || !prompt.trim() || cannotGenerate}
              onClick={() => void handleGenerate()}
            >
              {isAudio ? "合成并保存" : "生成并保存"}
            </Button>
          )}
          {genPhase === "failed" && genError ? (
            <span className="mr-auto text-xs text-error">{genError}</span>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
