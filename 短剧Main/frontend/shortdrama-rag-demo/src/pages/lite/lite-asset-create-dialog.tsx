/* ============================================================
   lite-asset-create-dialog.tsx — Lite 素材页弹窗 A（新建资产）

   口径（第二阶段,按 v1.3 Lite 契约 T10.5）:
   - 左侧基本信息:名称(必填)/描述/备注三个通用字段,所有类型通用。
     落点:name → asset.name、描述 → asset.intro、备注 → metadata.lite.note。
   - 右侧首图区(可选):三选项 [上传首图] [AI 生成] [跳过]。
     纯上传类型(光线/摄影/视频参考)只显示 [上传首图] 和 [跳过]。
     三个都是真实路径:
     - 跳过:仅 liteCreateAsset → 关闭 + 刷新。
     - 上传首图:liteCreateAsset 拿 first_variant_id → uploadAssetMedia(
       asset_entity_id, file, { assetVariantId: first_variant_id, isPrimary: true })
       (首图自动主图 T10.7)→ 关闭 + 刷新。
     - AI 生成:liteCreateAsset 拿 asset_entity_id + first_variant_id → 复用
       add-image-dialog 同款三步链路(estimate → confirm → submit,
       target_asset_entity_id = 新资产 id;参考图可选)。结果图由后端渲染层
       归属第一个变体并自动主图(T10.5)。AI 流程与 add-image-dialog 同一实现
       (同一批 api/capability-tiers 助手),不新建第二套实现。
   - 保存:先 liteCreateAsset,再按所选路径补图;成功后关闭弹窗 + 刷新列表。
   - 校验:名称必填;上传路径需选图;AI 路径需提示词与可用档位。
   ============================================================ */
import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash, Upload } from "@phosphor-icons/react";
import { ApiClientError, api, type TieredGenerationSubmissionInput } from "../../api";
import type { MediaVersion } from "../../types";
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
  FALLBACK_IMAGE_TIER,
  activeTiers,
  listCapabilityTiers,
  tierModelLabel,
  tierSubmitInput,
  type CapabilityTier,
} from "../../capability-tiers";
import type { GenerationDefaultStrategy } from "../../types";
import { assembleAssetImagePrompt, effectivePromptTemplate } from "../../lite-prompt-templates";
import { cheapestActiveTier, pickLiteDefaultTier } from "./lite-generation";
import { humanErrorMessage } from "../batch-generate-drawer";
import type { PageRuntimeProps } from "../global-pages";
import { newId } from "../../uuid";

/** 资产类型选项:五类可解析 + 三类纯上传参考通道。 */
const ASSET_KIND_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "character", label: "角色" },
  { value: "scene", label: "场景" },
  { value: "prop", label: "道具" },
  { value: "costume", label: "服装" },
  { value: "audio", label: "音频" },
  { value: "light_ref", label: "光线参考" },
  { value: "photo_ref", label: "摄影参考" },
  { value: "video_ref", label: "视频参考" },
];

/** 纯上传参考类型:只显示「上传首图」与「跳过」,没有「AI 生成」。 */
const UPLOAD_ONLY_KINDS: ReadonlySet<string> = new Set(["light_ref", "photo_ref", "video_ref"]);

/** 提示词拼接与弹窗 B 同一函数(assembleAssetImagePrompt),保证两弹窗拼接一致。 */

/** 首图路径:跳过 / 上传首图 / AI 生成。 */
type ImageAction = "skip" | "upload" | "ai";

/** 参考图本地项(生成时上传到服务端,拿 media_id 做 reference_media_ids)。 */
interface LocalRefImage {
  id: string;
  file: File;
  previewUrl: string;
}

/** Lite 提交体 = 后端 generationInputShape 的窄子集(不带 prompt)。 */
type LiteSubmissionInput = Omit<TieredGenerationSubmissionInput, "prompt"> & {
  supplement_prompt?: string;
};

export interface LiteAssetCreateDialogProps {
  projectId: string;
  /** 默认类型(从当前 tab 带入);null 表示「全部」tab,弹窗里自选。 */
  defaultKind: string | null;
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  onClose: () => void;
  onCreated: () => void;
}

export function LiteAssetCreateDialog({
  projectId,
  defaultKind,
  demoMode,
  notify,
  onClose,
  onCreated,
}: LiteAssetCreateDialogProps): React.JSX.Element {
  const initialKind = defaultKind && ASSET_KIND_OPTIONS.some((opt) => opt.value === defaultKind)
    ? defaultKind
    : "character";
  const [name, setName] = useState("");
  const [assetKind, setAssetKind] = useState(initialKind);
  const [intro, setIntro] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  // --- 首图路径与上传状态 ---
  const [imageAction, setImageAction] = useState<ImageAction>("skip");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  /** 上传首图预览（URL.createObjectURL，刷新即失效；换图/移除/卸载时 revoke）。 */
  const [selectedPreviewUrl, setSelectedPreviewUrl] = useState<string | null>(null);

  // --- AI 生成状态(复用 add-image-dialog 同款链路) ---
  const [referenceImages, setReferenceImages] = useState<LocalRefImage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [optimizingPrompt, setOptimizingPrompt] = useState(false);
  const [availableTiers, setAvailableTiers] = useState<CapabilityTier[]>([]);
  const [selectedTier, setSelectedTier] = useState<CapabilityTier | null>(null);
  /** 项目设定里的提示词模板,切到 AI 路径时用于预填。 */
  const [defaultTemplate, setDefaultTemplate] = useState("");
  const [tierLoading, setTierLoading] = useState(true);
  /** 档位列表来自 DEMO 回落(后端未配置图片生成模型),非演示模式下不能真正提交。 */
  const [tiersFromFallback, setTiersFromFallback] = useState(false);

  // 切换 defaultKind 时同步更新类型选择(例如用户在弹窗打开后切了 tab)。
  useEffect(() => {
    if (defaultKind && ASSET_KIND_OPTIONS.some((opt) => opt.value === defaultKind)) {
      setAssetKind(defaultKind);
    }
  }, [defaultKind]);

  const isUploadOnly = UPLOAD_ONLY_KINDS.has(assetKind);
  const trimmedName = name.trim();
  const busy = saving || optimizingPrompt;
  /** 非演示模式 + 档位来自回落 → 不能真正提交生成请求(后端没有这些档位)。 */
  const cannotGenerate = !demoMode && tiersFromFallback;
  const isAiMode = imageAction === "ai" && !isUploadOnly;
  /** 按所选路径校验可保存:跳过恒可;上传需选图;AI 需提示词 + 可用档位。 */
  const modeReady = imageAction === "upload"
    ? !!selectedFile
    : isAiMode
      ? !!(prompt.trim() && selectedTier && !cannotGenerate && !tierLoading)
      : true;
  const canSave = trimmedName.length > 0 && !busy && modeReady;

  // 纯上传类型无 AI 通道:切类型时若正停在 AI 路径则回落到「跳过」。
  useEffect(() => {
    if (isUploadOnly && imageAction === "ai") setImageAction("skip");
  }, [isUploadOnly, imageAction]);

  // --- 档(tier)选择器:与 add-image-dialog 同款(新建场景无资产可预填信息)。 ---
  const loadTier = useCallback(async () => {
    setTierLoading(true);
    try {
      const { tiers } = await listCapabilityTiers("image", demoMode);
      const active = activeTiers(tiers);
      setAvailableTiers(active);
      setTiersFromFallback(false);
      let strat: GenerationDefaultStrategy | null = null;
      if (!demoMode) {
        try {
          strat = await api.generationDefault(projectId, "image");
        } catch (reason) {
          if (!(reason instanceof ApiClientError && reason.status === 404)) throw reason;
        }
      }
      const defaultTier = pickLiteDefaultTier(active, strat) ?? FALLBACK_IMAGE_TIER;
      setSelectedTier(defaultTier);
      // 捕获项目设定的提示词模板:生效模板内容 = 配置页选中模板经模板库解析
      // (§4.3,引用键 prompt_template_id → 内容;id 缺失/软删回落系统默认=空)。
      const library = await api.promptTemplates(projectId, "image").catch(() => ({ items: [] }));
      setDefaultTemplate(effectivePromptTemplate(strat, library.items, "image").content);
    } catch {
      // 档位接口未配置/不可达 → 回落演示档位,保证 UI 可选;但非演示模式下不能真正提交
      const demoActive = activeTiers([...DEMO_IMAGE_TIERS]);
      setAvailableTiers(demoActive);
      setSelectedTier(demoActive[0] ?? FALLBACK_IMAGE_TIER);
      setTiersFromFallback(true);
    } finally {
      setTierLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, demoMode]);
  useEffect(() => { void loadTier(); }, [loadTier]);

  // 清理参考图 object URLs
  useEffect(() => {
    return () => {
      if (selectedPreviewUrl) URL.revokeObjectURL(selectedPreviewUrl);
      for (const ref of referenceImages) URL.revokeObjectURL(ref.previewUrl);
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

  /** 上传首图：换图/清空时 revoke 旧预览，避免 object URL 泄漏。 */
  function handleSelectUploadFile(files: FileList | null): void {
    const file = files?.[0] ?? null;
    if (selectedPreviewUrl) URL.revokeObjectURL(selectedPreviewUrl);
    setSelectedFile(file);
    setSelectedPreviewUrl(file ? URL.createObjectURL(file) : null);
  }

  function handleRemoveUploadFile(): void {
    if (selectedPreviewUrl) URL.revokeObjectURL(selectedPreviewUrl);
    setSelectedFile(null);
    setSelectedPreviewUrl(null);
  }

  function handleRemoveReference(id: string): void {
    setReferenceImages((prev) => {
      const target = prev.find((r) => r.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((r) => r.id !== id);
    });
  }

  /** 切到 AI 路径:首次进入时按 v1.4 七.3 拼接合同预填提示词(与弹窗 B 同一函数)。 */
  function handleSelectAi(): void {
    setImageAction("ai");
    if (!prompt.trim()) {
      setPrompt(assembleAssetImagePrompt({
        template: defaultTemplate,
        name,
        intro,
        notes: note,
      }));
    }
  }

  // --- AI 提示词优化(与 add-image-dialog 同款) ---
  async function handleOptimizePrompt(): Promise<void> {
    setOptimizingPrompt(true);
    try {
      // 生产意图 = 名称（独立传）+ 画面描述；当前提示词(含项目模板预填段)作为 supplement 传入,
      // 服务端返回 = AI 提示词原文 + supplement 原样追加到末尾(无标签),
      // 避免 AI 优化结果整体覆盖时丢掉项目配置的图片模板段。
      const optimized = await api.draftPrompt({ mediaKind: "image", name: name.trim() || undefined, description: intro.trim() || name.trim(), supplement: prompt, projectId });
      if (optimized.autoPrompt) {
        // 覆盖语义:保留项目模板段(生成期契约走 supplement_prompt),旧资产信息段被 AI 输出替换,不再叠加
        setPrompt([defaultTemplate.trim(), optimized.autoPrompt].filter(Boolean).join("\n"));
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

  /** AI 生成三步链路(上传参考图 → estimate → confirm → submit),与 add-image-dialog 同款。 */
  async function runAiGeneration(assetEntityId: string, tier: CapabilityTier): Promise<void> {
    // 上传参考图,收集 media_ids
    const refIds: string[] = [];
    for (const ref of referenceImages) {
      const media: MediaVersion = await api.uploadAssetMedia(assetEntityId, ref.file, { isPrimary: false });
      refIds.push(media.id);
    }

    // 三步链路:estimate → confirm → submit
    const { parameters, quantity } = tierSubmitInput(tier);
    const input: LiteSubmissionInput = {
      media_kind: "image",
      tier_id: tier.tier_id,
      project_id: projectId,
      target_asset_entity_id: assetEntityId,
      parameters,
      quantity,
      client_idempotency_key: newId(),
      supplement_prompt: prompt.trim(),
      reference_media_ids: refIds,
    };

    const quote = await api.quoteGeneration(input as TieredGenerationSubmissionInput);
    // v1.9 十.7:Lite 自动确认并入 submit,不再单独调 confirm
    await api.createGeneration(input as TieredGenerationSubmissionInput, quote.generation_quote_id, true);
  }

  async function handleSave(): Promise<void> {
    if (!trimmedName) {
      notify("资产名称不能为空", "error");
      return;
    }
    if (imageAction === "upload" && !selectedFile) {
      notify("请先选择一张图片", "error");
      return;
    }
    if (isAiMode) {
      if (!prompt.trim()) {
        notify("提示词不能为空", "error");
        return;
      }
      if (!selectedTier) {
        notify("当前没有可用的图片生成档位,请到配置页设置", "error");
        return;
      }
      if (cannotGenerate) {
        notify("当前环境未配置图片生成模型,请联系管理员到配置页启用", "error");
        return;
      }
    }
    if (demoMode) {
      const hint = imageAction === "upload"
        ? "演示模式:资产已创建,首图演示不落库"
        : isAiMode
          ? "演示模式:资产已创建,AI 生成演示不落库"
          : "演示模式:资产已创建(演示不落库)";
      notify(hint, "success");
      onCreated();
      return;
    }
    setSaving(true);
    try {
      const created = await api.liteCreateAsset(projectId, {
        name: trimmedName,
        asset_kind: assetKind,
        intro: intro.trim() || undefined,
        note: note.trim() || undefined,
      });
      if (imageAction === "upload" && selectedFile) {
        // 首图自动主图:isPrimary=true + 挂服务端自动建的第一个变体
        await api.uploadAssetMedia(created.asset_entity_id, selectedFile, {
          assetVariantId: created.first_variant_id,
          isPrimary: true,
        });
      } else if (isAiMode && selectedTier) {
        await runAiGeneration(created.asset_entity_id, selectedTier);
      }
      notify("资产已创建", "success");
      onCreated();
    } catch (reason) {
      notify(humanErrorMessage(reason, "创建失败,请稍后重试"), "error");
    } finally {
      setSaving(false);
    }
  }

  // --- 模型 / 比例 / 清晰度三级级联选择器(v1.4 七.3 决策 2) ---
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

  /** 切模型 → 选该模型下项目默认档(比例/清晰度随之收敛)。 */
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

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>新建资产</DialogTitle>
          <DialogDescription>填写基本信息创建资产,首图可一并上传/生成或稍后添加。</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-6">
          <div className="flex flex-col gap-6 md:flex-row">
            {/* 左侧:基本信息 */}
            <div className="flex flex-1 flex-col gap-4">
              <Field label="类型">
                <select
                  className="w-full rounded-md border border-border-1 bg-surface-1 px-3 py-2 text-sm text-ink-1"
                  value={assetKind}
                  onChange={(event) => setAssetKind(event.target.value)}
                >
                  {ASSET_KIND_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="名称">
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="给这个资产起个名字"
                  maxLength={80}
                />
              </Field>
              <Field label="描述">
                <Textarea
                  value={intro}
                  onChange={(event) => setIntro(event.target.value)}
                  placeholder="一句话描述这个资产的外观或用途"
                  rows={3}
                  maxLength={500}
                />
              </Field>
              <Field label="备注">
                <Textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="内部备注,只在素材页显示(落 metadata.lite.note)"
                  rows={2}
                  maxLength={2000}
                />
              </Field>
            </div>

            {/* 右侧:首图路径选择 */}
            <div className="flex w-full flex-col gap-3 md:w-56">
              <h4 className="text-xs font-medium text-ink-3">首图(可选)</h4>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className={`rounded-md border px-3 py-1.5 text-left text-sm transition-colors ${
                    imageAction === "upload"
                      ? "border-accent bg-accent-subtle text-accent-text"
                      : "border-border-1 bg-surface-1 text-ink-1 hover:border-border-2 hover:bg-surface-2"
                  }`}
                  onClick={() => setImageAction("upload")}
                >上传首图</button>
                {!isUploadOnly ? (
                  <button
                    type="button"
                    className={`rounded-md border px-3 py-1.5 text-left text-sm transition-colors ${
                      imageAction === "ai"
                        ? "border-accent bg-accent-subtle text-accent-text"
                        : "border-border-1 bg-surface-1 text-ink-1 hover:border-border-2 hover:bg-surface-2"
                    }`}
                    onClick={handleSelectAi}
                  >AI 生成</button>
                ) : null}
                <button
                  type="button"
                  className={`rounded-md border px-3 py-1.5 text-left text-sm transition-colors ${
                    imageAction === "skip"
                      ? "border-accent bg-accent-subtle text-accent-text"
                      : "border-border-1 bg-surface-1 text-ink-1 hover:border-border-2 hover:bg-surface-2"
                  }`}
                  onClick={() => setImageAction("skip")}
                >跳过</button>
              </div>

              {/* 上传路径:选择文件 + 预览 + 移除 */}
              {imageAction === "upload" && (
                <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-border-1 p-2">
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={(e) => handleSelectUploadFile(e.target.files)}
                    />
                    <span className="inline-flex h-8 items-center gap-1 rounded-md border border-border-1 bg-surface-1 px-3 text-sm text-ink-2 hover:bg-surface-well">
                      <Upload className="size-3.5" /> 选择文件
                    </span>
                  </label>
                  {selectedPreviewUrl ? (
                    <div className="flex flex-col gap-1.5">
                      <div className="relative overflow-hidden rounded-md border border-border-1">
                        <img src={selectedPreviewUrl} alt="首图预览" className="aspect-square w-full object-cover" />
                        <button
                          type="button"
                          className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-surface-1/90 text-ink-3 shadow-sm ring-1 ring-border-1 hover:bg-error hover:text-white"
                          onClick={handleRemoveUploadFile}
                          aria-label="移除所选图片"
                        >
                          <Trash className="size-3" />
                        </button>
                      </div>
                      <p className="truncate text-xs text-ink-3" title={selectedFile?.name}>{selectedFile?.name}</p>
                    </div>
                  ) : (
                    <p className="text-xs text-ink-4">支持 jpg / png / webp,最大 10MB</p>
                  )}
                </div>
              )}
              {isAiMode && (
                <p className="text-xs text-ink-4">创建后按提示词生成首图,参考图可选。</p>
              )}
              {imageAction === "skip" && (
                <p className="text-xs text-ink-4">创建后可在详情页补充首图</p>
              )}
            </div>
          </div>

          {/* AI 生成面板(全宽,切到 AI 路径时显示;与 add-image-dialog 同款交互) */}
          {isAiMode && (
            <div className="flex flex-col gap-4 rounded-md bg-surface-well/30 p-3">
              {cannotGenerate && (
                <div className="rounded-md border border-border-1 bg-surface-well/50 px-3 py-2 text-sm text-ink-3">
                  当前环境未配置图片生成模型,以下为示例选项。请联系管理员到配置页添加图片生成模型后再生成。
                </div>
              )}
              {/* 参考图区(多图上传,非槽位制) */}
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

              {/* 提示词区 */}
              <Field label="提示词">
                <div className="flex flex-col gap-1.5">
                  <Textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={4}
                    maxLength={2000}
                    placeholder="项目模板 + 类型模板 + 基本信息已预填,可在此补充修改"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 self-start text-xs"
                    loading={optimizingPrompt}
                    onClick={() => void handleOptimizePrompt()}
                  >✨ AI 优化提示词</Button>
                </div>
              </Field>

              {/* 模型 / 比例 / 清晰度三级级联选择器(v1.4 七.3 决策 2) */}
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
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" loading={saving} disabled={!canSave} onClick={() => void handleSave()}>
            创建资产
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
