/* ============================================================
   lite-project-config-page.tsx — Lite 项目生成配置（任务 E 真页面，替换占位 stub）
   props 契约 = PageRuntimeProps & { projectId }，app.tsx 挂载不变。

   口径（对齐 settings-page.tsx GenerationDefaultsPanel 与档体系铁律）：
   - 数据源：api.generationDefault(projectId, kind)（404=未配置过 → 出厂默认展示，
     不报错）+ listCapabilityTiers(kind)（只渲染 active 档；档外组合不给选——
     模型/尺寸/清晰度/比例的可选值全部由 generation-dimensions 引擎从 active 档推导）；
   - 出厂默认（2026-08-19）：视频未配置时过滤快乐马预览档、取最便宜非预览 active 档
     （dev=seedance 2.0/720p/9:16，与分镜详情 pickLiteDefaultTier 同口径）；图片/音频
     沿用首个 active 档。
   - 维度渲染（修订二，2026-08-17 二次裁定）：全部维度一律下拉——单值也是下拉
     （不做固定标签，该形态只在生成分镜的维度 popover 保留）；图/视频同口径按
     「模型 → 下游维度」级联收窄（改上游时下游自动落到该模型真实存在的 active 档）；
     某维度零选项仍是说明态（图=不可用禁存 / 视频=按默认执行），不虚构选项；
   - 保存：api.putGenerationDefault(projectId, kind, { mode, model_key, parameters,
*     expected_version })；parameters 形——图片 { size, ratio, prompt_template_id }、
*     视频 { resolution, ratio, duration_seconds, prompt_template_id, shots_per_segment }，模板键名固定
     prompt_template_id（null=系统默认；docs/design/prd-v2/lite-model-defaults.md §4.3）；
     shots_per_segment（v11）：每段分镜拆几个镜头，1-12 整数或 null=自由（与后端
     STORYBOARD_SHOTS_PER_SEGMENT_MAX=12 对齐；docs/lite-oneclick-generate-episode.md v0.7）；
   - mode 不在 Lite 表单暴露：沿用已存策略的 mode，未配置过按面板出厂值
     material_to_prompt（照 formFromStrategy）；
   - 乐观锁：新建 expected_version=0；409 → 重新 GET 刷新表单并提示
     「配置已被其他人更新，已为你刷新」；保存成功 notify 成功态；
   - 提示词模板（修订三 2026-08-17）：系统默认呈只读文本框；点 tab 仅预览，面板内 [设为默认]
     切换生效项（生效 = 策略引用，随基础配置保存落库）；新建/编辑/复制新建/软删；
     内容 ≤5000 字符、实时字数、超长禁存（disabled 给原因）；
   - 加载骨架屏、错误 ErrorState 带 retry，均照 useResource 模式（src/ui.tsx:289）。

   骨架（docs/design/prd-v2/lite-ui-rework.md §4.6）：
   - 页头（用户裁定 2026-08-16，同日二次裁定）：整行不渲染——标题/副标题删（媒体 tab
     已达意）；`‹ 返回` 也删，返回职责全归壳项目条（〈 全部项目 / 制作 / 资产 常驻）；
   - 媒体类型 tab（图片配置/视频配置/音频配置）持久化 ?kind=，三卡常驻挂载（切换不丢未保存编辑）；
   - 音频卡（2026-08-18 用户裁定：可选模型+音频参数）：维度=模型/音质(sample_rate)/格式(format)/时长
     （四级级联，全部落在真实原子档上；时长是档冻参数 original_duration_seconds，弹窗 B 展示回落
     duration_seconds ?? original_duration_seconds）；音色栏已删（2026-08-18 用户裁定：暂时不需要音色），
     音频默认策略 parameters 不再含 speaker_id，由后端/供应商默认音色兜底；
     音频无提示词模板/风格概念 → 模板配置子 tab 与风格配置面板不渲染；
   - 每卡一个保存（保存图片配置/保存视频配置/保存音频配置），保存态 = 已保存(vN) ✓ 本项目生成时按此
     默认执行 / 未配置 · 按出厂默认执行（#151 红线：必须说「会生效」）；
   - 高度模型（修订二，2026-08-17）：整页满屏适配视口高（lite 根容器 h-dvh overflow-hidden，
     全链 flex + min-h-0 分配高度），不出页面滚动条；只有模板/风格的文本区（textarea 与
     只读内容展示/列表区）在自身盒内滚动。两层 tab 缩小：媒体 tab 小一号，卡内
     基础/模板 子 tab 更小一号。
   ============================================================ */
import { ImageSquare, SpeakerHigh, VideoCamera } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { ApiClientError, api } from "../../api";
import type {
  GenerationDefaultMode,
  GenerationDefaultStrategy,
  GenerationMediaKind,
  JsonRecord,
  ProjectStyle,
  PromptTemplate,
} from "../../types";
import { Button } from "../../components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Card, Input, Select, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from "../../components/ui/primitives";
import { EmptyState, ErrorState, useResource } from "../../ui";
import {
  FALLBACK_TIERS,
  activeTiers,
  isPreviewTier,
  listCapabilityTiers,
  type CapabilityTier,
} from "../../capability-tiers";
import { cheapestActiveTier } from "./lite-generation";
import {
  listGenerationDimensions,
  tierDimensionValue,
  type GenerationDimensionKey,
} from "../../generation-dimensions";
import { humanErrorMessage } from "../batch-generate-drawer";
import {
  PROMPT_TEMPLATE_CONTENT_MAX,
  PROMPT_TEMPLATE_NAME_MAX,
  promptTemplateIdOf,
} from "../../lite-prompt-templates";
import {
  PROJECT_STYLE_CONTENT_MAX,
  PROJECT_STYLE_NAME_MAX,
} from "../../lite-project-styles";
import type { PageRuntimeProps } from "../global-pages";
import { LiteConfirmDialog, type LiteConfirmState } from "./lite-confirm-dialog";

/** 档未声明视频时长维度时的执行兜底（当前登记档全部声明 duration_seconds=4s，兜底与其同值）。 */
const VIDEO_DURATION_FALLBACK = 4;

/** 档未声明对应维度时的执行兜底（与 capability-tiers 初始档/workbenchFixedParameters 同值，不虚构新组合）。 */
const VIDEO_RESOLUTION_FALLBACK = "720p";
const VIDEO_RATIO_FALLBACK = "9:16";

/** v11：每段分镜「分镜 Shot 数」上限；与后端 STORYBOARD_SHOTS_PER_SEGMENT_MAX=12 对齐（前端不能 import 后端常量）。 */
const STORYBOARD_SHOTS_PER_SEGMENT_MAX = 12;

/** Lite 配置图/视频/音频三种媒介（音频=默认档，mode 恒 text_to_speech；音色栏已删）。 */
type LiteConfigKind = "image" | "video" | "audio";

/** 各媒介在 Lite 表单暴露的档维度（其余维度——数量等——Lite 不给选；
    音频暴露模型/音质/格式/时长四级级联，全部落在真实原子档上，时长=档冻参数 original_duration_seconds）。 */
const FORM_DIMENSION_KEYS: Record<LiteConfigKind, readonly GenerationDimensionKey[]> = {
  image: ["model_label", "aspect_ratio", "resolution"],
  video: ["model_label", "resolution", "aspect_ratio", "duration_seconds"],
  audio: ["model_label", "sample_rate", "format", "duration_seconds"],
};

const DIMENSION_FIELD_LABEL: Partial<Record<GenerationDimensionKey, Partial<Record<LiteConfigKind, string>>>> = {
  model_label: { image: "模型", video: "模型", audio: "模型" },
  resolution: { image: "清晰度", video: "清晰度" },
  aspect_ratio: { image: "画幅", video: "比例" },
  duration_seconds: { video: "时长", audio: "时长" },
  sample_rate: { audio: "音质" },
  format: { audio: "格式" },
};

interface KindConfigData {
  tiers: CapabilityTier[];
  /** null = 从未配置过（404），按出厂默认展示。 */
  strategy: GenerationDefaultStrategy | null;
  /** 本项目自建模板库（仅本媒介；系统默认不入库）。 */
  library: PromptTemplate[];
  /** 本项目本媒介的风格库（含默认；空数组 = 无任何风格，默认无风格）。 */
  styles: ProjectStyle[];
  /** 平台默认模板内容（只读；代码常量经后端 /generation/default-prompt-templates 暴露）。 */
  systemDefault: string;
}
/** 模板库编辑器状态（新建/编辑/复制新建共用一个弹窗；source 只在 edit 时存在）。 */
interface TemplateEditorState {
  mode: "create" | "edit" | "copy";
  source?: PromptTemplate;
  name: string;
  content: string;
}

/** 风格库内联编辑器状态（新建/编辑共用一个面板；source 只在 edit 时存在）。 */
interface StyleEditorState {
  source?: ProjectStyle;
  name: string;
  content: string;
}

/** 卡内子 tab：基础配置（生成维度 + 风格配置）| 模板配置（提示词模板库）。?section= 持久化，双面板常驻挂载。 */
type ConfigSection = "base" | "template";

/** 按 FORM_DIMENSION_KEYS 顺序逐级收窄（修订二：图/视频同口径）：改上游维度时，
    下游可选值 = 与当前档上游全等的 active 档实际声明值；零选项返回 undefined（说明态）。 */
function cascadingDimensions(tiers: readonly CapabilityTier[], kind: LiteConfigKind, tier: CapabilityTier | null) {
  const active = activeTiers(tiers);
  const all = listGenerationDimensions(tiers, kind, tier);
  return FORM_DIMENSION_KEYS[kind].map((key, index) => {
    const dimension = all.find((item) => item.key === key);
    if (!dimension || !tier) return dimension;
    const upstream = FORM_DIMENSION_KEYS[kind].slice(0, index);
    const candidates = active.filter((candidate) => upstream.every((upstreamKey) =>
      tierDimensionValue(candidate, upstreamKey) === tierDimensionValue(tier, upstreamKey),
    ));
    const values = new Set(candidates.map((candidate) => tierDimensionValue(candidate, key)));
    const selected = tierDimensionValue(tier, key);
    const options = dimension.options
      .filter((option) => values.has(option.value))
      .map((option) => ({ ...option, feasible: true, selected: option.value === selected }));
    if (options.length === 0) return undefined;
    return { ...dimension, options, single: options.length === 1 };
  });
}

/** 读某媒介的档 + 已存默认策略 + 自建模板库 + 系统默认模板；404 不算错（未配置过），
    其余错误原样抛给错误态。模板库/系统默认读不到按空回落（页面照常可用，引用按系统默认）。 */
async function loadKindConfig(projectId: string, kind: LiteConfigKind, demoMode: boolean): Promise<KindConfigData> {
  const { tiers } = await listCapabilityTiers(kind, demoMode);
  if (demoMode) return { tiers, strategy: null, library: [], styles: [], systemDefault: "" };
  if (kind === "audio") {
    // 音频无提示词模板/风格库/系统默认模板概念（TTS 文本直接合成），只读档 + 默认策略。
    const strategy = await api.generationDefault(projectId, "audio").catch((reason) => {
      if (reason instanceof ApiClientError && reason.status === 404) return null;
      throw reason;
    });
    return { tiers, strategy, library: [], styles: [], systemDefault: "" };
  }
  const strategy = await api.generationDefault(projectId, kind).catch((reason) => {
    if (reason instanceof ApiClientError && reason.status === 404) return null;
    throw reason;
  });
  const [library, defaults, styles] = await Promise.all([
    api.promptTemplates(projectId, kind).catch(() => ({ items: [] })),
    api.defaultPromptTemplates().catch(() => ({ image: "", video: "" })),
    api.projectStyles(projectId, kind).catch(() => ({ items: [] })),
  ]);
  return {
    tiers,
    strategy,
    library: library.items,
    styles: styles.items,
    systemDefault: kind === "image" ? defaults.image : defaults.video,
  };
}

/** 由已存策略反查当前档：model_key 存的是档 id（FABLE-007 后档 wire 不再暴露真实 model id，
    tier_id 是唯一公开选择键），再按尺寸/清晰度（视频再比例同时长）核对；查不到回落首个 active 档。 */
function tierFromStrategy(tiers: readonly CapabilityTier[], kind: GenerationMediaKind, strategy: GenerationDefaultStrategy | null): CapabilityTier | null {
  const active = activeTiers(tiers);
  if (active.length === 0) return null;
  if (!strategy) {
    /* 2026-08-19：未配置按「出厂默认」展示——视频过滤快乐马预览档（锁定档不入配置表单，
       且无参考图不可提交），取最便宜非预览 active 档（dev=seedance 2.0/720p/9:16）；
       与分镜详情 pickLiteDefaultTier(active, null) 同口径，两处默认一致。 */
    const pool = kind === "video" ? active.filter((tier) => !isPreviewTier(tier)) : active;
    if (pool.length === 0) return active[0]!;
    return cheapestActiveTier(pool) ?? pool[0]!;
  }
  const sameTier = active.filter((tier) => tier.tier_id === strategy.model_key);
  const size = typeof strategy.parameters.size === "string" ? strategy.parameters.size : null;
  const resolution = typeof strategy.parameters.resolution === "string" ? strategy.parameters.resolution : size;
  const ratio = typeof strategy.parameters.ratio === "string" ? strategy.parameters.ratio : null;
  const duration = typeof strategy.parameters.duration_seconds === "number" && Number.isFinite(strategy.parameters.duration_seconds)
    ? strategy.parameters.duration_seconds
    : null;
  const exact = sameTier.find((tier) => {
    if (resolution !== null && tierDimensionValue(tier, "resolution") !== resolution) return false;
    if (kind === "image" && ratio !== null && tierDimensionValue(tier, "aspect_ratio") !== ratio) return false;
    if (kind === "video" && ratio !== null && tierDimensionValue(tier, "aspect_ratio") !== ratio) return false;
    /* 时长只在档声明了该维度时才参与过滤（未声明的档不被误杀）；保存值恒来自档声明。 */
    if (kind === "video" && duration !== null) {
      const declared = tierDimensionValue(tier, "duration_seconds");
      if (declared !== undefined && Number(declared) !== duration) return false;
    }
    return true;
  });
  return exact ?? sameTier[0] ?? active[0]!;
}

/** 已存策略的乐观锁版本（照 formFromStrategy：缺省/非正整数按 0=新建）。 */
function versionOf(strategy: GenerationDefaultStrategy | null): number {
  return strategy && Number.isFinite(strategy.version) && strategy.version > 0 ? strategy.version : 0;
}

type SaveState = "idle" | "saving" | "saved" | "conflict" | "error";

/** 卡头无标题/说明（用户裁定 2026-08-16：媒体 tab 已达意）；title 只作 aria-label，供读屏与测试定位。 */
const KIND_META: Record<LiteConfigKind, { title: string }> = {
  image: { title: "图片生成配置" },
  video: { title: "视频生成配置" },
  audio: { title: "音频生成配置" },
};

function LiteGenerationConfigCard({ projectId, kind, section, onSelectSection, demoMode, notify }: {
  projectId: string;
  kind: LiteConfigKind;
  section: ConfigSection;
  onSelectSection: (section: ConfigSection) => void;
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
}): React.JSX.Element {
  const meta = KIND_META[kind];
  const { data, loading, error, retry } = useResource<KindConfigData>(
    () => loadKindConfig(projectId, kind, demoMode),
    { tiers: [...FALLBACK_TIERS[kind]], strategy: null, library: [], styles: [], systemDefault: "" },
    demoMode,
    [projectId, kind],
  );

  /* ---------- 表单状态（data 到位/刷新时整体水合；retry 会放弃未保存编辑，与完整版面同口径） ---------- */
  const [tier, setTier] = useState<CapabilityTier | null>(null);
  const [library, setLibrary] = useState<PromptTemplate[]>([]);
  /** 生效模板 id：null=系统默认；单选自建模板后保存为引用（生成期客户端解析内容）。 */
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  /** v11：每个分镜(Segment)拆几个镜头；1-12 整数或 null=自由（由 AI 按剧情内容自然决定）。 */
  const [shotsPerSegment, setShotsPerSegment] = useState<number | null>(null);
  /** 修订三 Q5（2026-08-17）：模板「查看」与「生效」解耦——本状态 = 正在预览的模板 tab
      （"system" | 模板 id）；生效项仍由 selectedTemplateId 单独持有，面板 [设为默认] 切换。 */
  const [viewTemplateTab, setViewTemplateTab] = useState<string>("system");
  const [systemDefault, setSystemDefault] = useState("");
  const [missingTemplateNote, setMissingTemplateNote] = useState("");
  const [mode, setMode] = useState<GenerationDefaultMode>("material_to_prompt");
  const [version, setVersion] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState("");

  /* ---------- 模板库编辑器（新建/编辑/复制新建 共用一个内联面板；删除走 confirm 软删） ---------- */
  const [editor, setEditor] = useState<TemplateEditorState | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);

  /* ---------- 风格库（基础配置子面板；D1 2026-08-17 修订：不锁定——默认行可编辑/可换设/可取消/可删，
     默认可为空；设/换/取消/删除均即时动作并同事务同步服务端镜像列，不进卡保存/乐观锁） ---------- */
  const [styles, setStyles] = useState<ProjectStyle[]>([]);
  const [styleEditor, setStyleEditor] = useState<StyleEditorState | null>(null);
  const [styleBusy, setStyleBusy] = useState(false);
  /** v1.9 十.11：删除(模板/风格)自定义二次确认弹窗状态。 */
  const [confirmState, setConfirmState] = useState<LiteConfirmState | null>(null);

  useEffect(() => {
    if (!data) return;
    hydrate(data);
    // 保存态（§4.6 保存口径）：已配置过 → 已保存(vN) ✓ …；从未配置（404）→ 未配置 · 按出厂默认执行。
    const version = versionOf(data.strategy);
    if (version > 0) {
      setSaveState("saved");
      setSaveMessage(`已保存(v${version}) ✓ 本项目生成时按此默认执行`);
    } else {
      setSaveState("idle");
      setSaveMessage("未配置 · 按出厂默认执行");
    }
    // hydrate 定义在渲染域内，只随 data 变化重跑（retry/换项目）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  function hydrate(data: KindConfigData): void {
    setTier(tierFromStrategy(data.tiers, kind, data.strategy));
    setLibrary(data.library);
    setStyles(data.styles);
    setSystemDefault(data.systemDefault);
    const id = promptTemplateIdOf(data.strategy);
    const referenced = id !== null
      && data.library.some((template) => template.id === id && template.media_kind === kind);
    if (id !== null && !referenced) {
      // 引用模板已被软删/跨项目 → 回落系统默认并提示（保存后即固定为系统默认）。
      setSelectedTemplateId(null);
      setViewTemplateTab("system");
      setMissingTemplateNote("引用模板已不存在（可能已被删除），本次按系统默认执行；保存后即固定为系统默认。");
    } else {
      setSelectedTemplateId(id);
      setViewTemplateTab(id ?? "system");
      setMissingTemplateNote("");
    }
    setMode(data.strategy?.mode ?? (kind === "audio" ? "text_to_speech" : "material_to_prompt"));
    setVersion(versionOf(data.strategy));
    /* v11：每段 Shot 数 1-12 整数生效，其余（缺省/越界/非法）= null=自由；与后端 resolveShotsPerSegment 同口径。 */
    const rawShots = data.strategy?.parameters?.shots_per_segment;
    setShotsPerSegment(
      typeof rawShots === "number" && Number.isInteger(rawShots) && rawShots >= 1 && rawShots <= STORYBOARD_SHOTS_PER_SEGMENT_MAX
        ? rawShots
        : null,
    );
  }

  const tiers = data?.tiers ?? [];
  /* 修订二：图/视频同口径级联（原视频走全量值域+组合置灰的双口径废除）。 */
  const dimensions = cascadingDimensions(tiers, kind, tier);
  const missingImageDimension = kind === "image" && tier
    ? FORM_DIMENSION_KEYS.image.find((key) => tierDimensionValue(tier, key) === undefined)
    : undefined;
  const saveDisabledReason = !tier
    ? "当前没有可用的生成参数选项，由管理员开放后才能保存"
    : missingImageDimension
      ? `当前模型没有可用的${DIMENSION_FIELD_LABEL[missingImageDimension]?.image ?? "生成参数"}选项，请改选模型`
      : "";

  function pickDimension(key: GenerationDimensionKey, rawValue: string): void {
    const dimension = dimensions.find((item) => item?.key === key);
    const option = dimension?.options.find((item) => String(item.value) === rawValue);
    if (!option || !option.feasible || !tier) return;
    /* 级联选档：与当前档上游全等 + 命中所选值的 active 档，取 tier_id 字典序首个（确定性）。 */
    const index = FORM_DIMENSION_KEYS[kind].indexOf(key);
    const upstream = FORM_DIMENSION_KEYS[kind].slice(0, index);
    const next = activeTiers(tiers)
      .filter((candidate) => tierDimensionValue(candidate, key) === option.value
        && upstream.every((upstreamKey) => tierDimensionValue(candidate, upstreamKey) === tierDimensionValue(tier, upstreamKey)))
      .sort((left, right) => left.tier_id.localeCompare(right.tier_id))[0];
    if (next) {
      setTier(next);
      setSaveState("idle");
      setSaveMessage("");
    }
  }

  /** v11：「分镜 Shot 数」输入解析：空→null（自由）；1-12 整数 clamp；非数字忽略。 */
  function parseShotsInput(raw: string): number | null {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return null;
    return Math.min(STORYBOARD_SHOTS_PER_SEGMENT_MAX, Math.max(1, Math.round(value)));
  }

  function buildParameters(): JsonRecord {
    if (kind === "audio") {
      // 音频默认策略：model_key=存档档 id、mode=text_to_speech；音色栏已删（2026-08-18 用户裁定），
      // parameters 不再含 speaker_id，由后端/供应商默认音色兜底；
      // 音频无提示词模板/风格概念（TTS 文本直接合成）。
      return {
        prompt_template_id: null,
      };
    }
    if (kind === "image") {
      const size = tierDimensionValue(tier!, "resolution");
      const ratio = tierDimensionValue(tier!, "aspect_ratio");
      if (typeof size !== "string" || typeof ratio !== "string") {
        throw new Error("当前模型的画幅或清晰度不可用，请改选模型");
      }
      return {
        size,
        ratio,
        prompt_template_id: selectedTemplateId,
      };
    }
    return {
      resolution: String(tierDimensionValue(tier!, "resolution") ?? VIDEO_RESOLUTION_FALLBACK),
      ratio: String(tierDimensionValue(tier!, "aspect_ratio") ?? VIDEO_RATIO_FALLBACK),
      /* 时长与档同口径：存的就是当前档的声明值，分镜页整档透传时逐键相等，不会出现「配 5 秒出 4 秒」。 */
      duration_seconds: Number(tierDimensionValue(tier!, "duration_seconds") ?? VIDEO_DURATION_FALLBACK),
      prompt_template_id: selectedTemplateId,
      /* v11：每段分镜拆几个镜头；null=自由（由 AI 按剧情内容自然决定）。 */
      shots_per_segment: shotsPerSegment,
    };
  }

  async function save(): Promise<void> {
    if (demoMode) {
      notify("离线演示不写入生成配置", "info");
      return;
    }
    if (!tier || saveState === "saving") return;
    setSaveState("saving");
    setSaveMessage("");
    try {
      const next = await api.putGenerationDefault(projectId, kind, {
        mode,
        model_key: tier.tier_id,
        parameters: buildParameters(),
        expected_version: version,
      });
      setMode(next.mode);
      setVersion(versionOf(next));
      setSaveState("saved");
      setSaveMessage(`已保存(v${next.version}) ✓ 本项目生成时按此默认执行`);
      notify(kind === "image" ? "图片生成配置已保存" : kind === "audio" ? "音频生成配置已保存" : "视频生成配置已保存", "success");
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.status === 409) {
        const fresh = await api.generationDefault(projectId, kind).catch(() => null);
        if (fresh) hydrate({ tiers, strategy: fresh, library, styles, systemDefault });
        setSaveState("conflict");
        setSaveMessage("配置已被其他人更新，已为你刷新到最新值；确认后再保存");
        notify("配置已被其他人更新，已为你刷新", "info");
        return;
      }
      setSaveState("error");
      setSaveMessage(humanErrorMessage(reason, "保存失败，请重试"));
    }
  }

  /* ---------- 模板库 CRUD（新建/编辑/复制新建/软删；模板表只存自建，系统默认是代码常量） ---------- */

  function openCreate(): void {
    setEditor({ mode: "create", name: "", content: "" });
  }

  function openEdit(template: PromptTemplate): void {
    setEditor({ mode: "edit", source: template, name: template.name, content: template.content });
  }

  function openCopy(template: PromptTemplate): void {
    setEditor({ mode: "copy", source: template, name: `${template.name}（副本）`, content: template.content });
  }

  const editorValid = editor !== null
    && editor.name.trim().length > 0
    && editor.name.trim().length <= PROMPT_TEMPLATE_NAME_MAX
    && editor.content.trim().length > 0
    && editor.content.trim().length <= PROMPT_TEMPLATE_CONTENT_MAX;

  async function submitEditor(): Promise<void> {
    if (!editor || templateBusy || demoMode) return;
    /* 模板只属于 image/video；audio 无提示词模板概念（JSX 已不渲染该子 tab，此守卫同时收窄 kind 类型）。 */
    if (kind === "audio") return;
    const name = editor.name.trim();
    const content = editor.content.trim();
    if (!name || name.length > PROMPT_TEMPLATE_NAME_MAX || !content || content.length > PROMPT_TEMPLATE_CONTENT_MAX) return;
    setTemplateBusy(true);
    try {
      if (editor.mode === "edit" && editor.source) {
        const updated = await api.updatePromptTemplate(projectId, editor.source.id, { media_kind: kind, name, content });
        setLibrary((current) => current.map((template) => (template.id === updated.id ? updated : template)));
        setViewTemplateTab(updated.id);
        setSelectedTemplateId(updated.id);
        setSaveState("idle");
        setSaveMessage("");
        setMissingTemplateNote("");
        notify("模板已更新", "success");
      } else {
        const created = await api.createPromptTemplate(projectId, { media_kind: kind, name, content });
        setLibrary((current) => [...current, created]);
        setSelectedTemplateId(created.id);
        setViewTemplateTab(created.id);
        setMissingTemplateNote("");
        notify("模板已创建并选中", "success");
      }
      setEditor(null);
    } catch (reason) {
      notify(humanErrorMessage(reason, "模板保存失败，请重试"), "error");
    } finally {
      setTemplateBusy(false);
    }
  }

  function removeTemplate(template: PromptTemplate): void {
    if (demoMode || templateBusy) return;
    setConfirmState({
      title: `删除模板「${template.name}」？`,
      description: "删除后，引用它的生成会回落系统默认；当前没有恢复入口，需要时请重新创建模板。",
      onConfirm: () => void (async () => {
        setTemplateBusy(true);
        try {
          await api.deletePromptTemplate(projectId, template.id);
          setLibrary((current) => current.filter((item) => item.id !== template.id));
          /* 修订三 Q5：被删模板若正在预览，回落系统默认面板（生效项回落原逻辑不变）。 */
          if (viewTemplateTab === template.id) setViewTemplateTab("system");
          if (selectedTemplateId === template.id) {
            setSelectedTemplateId(null);
            setMissingTemplateNote(`模板「${template.name}」已删除，本次按系统默认执行。`);
          }
          notify("模板已删除", "success");
          setConfirmState(null);
        } catch (reason) {
          notify(humanErrorMessage(reason, "删除失败，请重试"), "error");
        } finally {
          setTemplateBusy(false);
        }
      })(),
    });
  }

  /* ---------- 风格库 CRUD（即时动作，不进卡保存/乐观锁；D1：默认不锁定，可换设/可取消） ---------- */

  function openStyleCreate(): void {
    setStyleEditor({ name: "", content: "" });
  }

  function openStyleEdit(style: ProjectStyle): void {
    setStyleEditor({ source: style, name: style.name, content: style.content });
  }

  const styleEditorValid = styleEditor !== null
    && styleEditor.name.trim().length > 0
    && styleEditor.name.trim().length <= PROJECT_STYLE_NAME_MAX
    && styleEditor.content.trim().length > 0
    && styleEditor.content.trim().length <= PROJECT_STYLE_CONTENT_MAX;

  async function submitStyleEditor(): Promise<void> {
    if (!styleEditor || styleBusy || demoMode) return;
    /* 风格只属于 image/video；audio 无风格概念（JSX 已不渲染该面板，此守卫同时收窄 kind 类型）。 */
    if (kind === "audio") return;
    const name = styleEditor.name.trim();
    const content = styleEditor.content.trim();
    if (!name || name.length > PROJECT_STYLE_NAME_MAX || !content || content.length > PROJECT_STYLE_CONTENT_MAX) return;
    setStyleBusy(true);
    try {
      if (styleEditor.source) {
        const updated = await api.updateProjectStyle(projectId, styleEditor.source.id, { media_kind: kind, name, content });
        setStyles((current) => current.map((style) => (style.id === updated.id ? updated : style)));
        notify("风格已更新", "success");
      } else {
        const created = await api.createProjectStyle(projectId, { media_kind: kind, name, content });
        setStyles((current) => [...current, created]);
        notify("风格已添加", "success");
      }
      setStyleEditor(null);
    } catch (reason) {
      notify(humanErrorMessage(reason, "风格保存失败，请重试"), "error");
    } finally {
      setStyleBusy(false);
    }
  }

  function removeStyle(style: ProjectStyle): void {
    if (demoMode || styleBusy) return;
    setConfirmState({
      title: `删除风格「${style.name}」？`,
      description: "删除后不影响已生成内容；若它是默认风格，将同时取消默认（之后生成不注入风格）。",
      onConfirm: () => void (async () => {
        setStyleBusy(true);
        try {
          await api.deleteProjectStyle(projectId, style.id);
          setStyles((current) => current.filter((item) => item.id !== style.id));
          notify("风格已删除", "success");
          setConfirmState(null);
        } catch (reason) {
          notify(humanErrorMessage(reason, "删除失败，请重试"), "error");
        } finally {
          setStyleBusy(false);
        }
      })(),
    });
  }

  /** 设/换默认（可逆）：同事务旧默认让位 + 镜像更新；再点其它风格即换设。 */
  async function setStyleDefault(style: ProjectStyle): Promise<void> {
    if (demoMode || styleBusy) return;
    if (!window.confirm(`把「${style.name}」设为默认风格？本项目该媒介生成时会自动注入这条风格描述。之后可随时换设其它风格，或取消默认回到空态。`)) return;
    setStyleBusy(true);
    try {
      const updated = await api.setDefaultProjectStyle(projectId, style.id);
      setStyles((current) => current.map((item) => (item.id === updated.id ? updated : { ...item, is_default: false })));
      notify("默认风格已设置", "success");
    } catch (reason) {
      notify(humanErrorMessage(reason, "设置默认风格失败，请重试"), "error");
    } finally {
      setStyleBusy(false);
    }
  }

  /** 取消默认（可逆，D1：默认可为空）：镜像清空，该媒介生成不再注入风格；可再设回。 */
  async function clearStyleDefault(style: ProjectStyle): Promise<void> {
    if (demoMode || styleBusy) return;
    if (!window.confirm(`取消「${style.name}」的默认风格？之后本项目该媒介生成不再注入风格（可再设回）。`)) return;
    setStyleBusy(true);
    try {
      const updated = await api.clearDefaultProjectStyle(projectId, style.id);
      setStyles((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      notify("已取消默认风格", "success");
    } catch (reason) {
      notify(humanErrorMessage(reason, "取消默认风格失败，请重试"), "error");
    } finally {
      setStyleBusy(false);
    }
  }

  /* ---------- 模板库 tab 呈现（修订三 Q5 2026-08-17：查看/生效解耦——点 tab 仅预览，
     面板内 [设为默认] 才切换生效；生效项 = selectedTemplateId，随基础配置保存落库） ---------- */
  /** 当前预览的模板 tab（编辑器在弹窗里，不再占用 tab）。 */
  const templateTabValue = viewTemplateTab;

  /** 点模板 tab = 仅预览（修订三 Q5，撤销「点 tab 即选中生效」）；[+ 新建模板] tab 打开弹窗编辑器。 */
  function selectTemplateTab(value: string): void {
    if (value === "new") {
      if (editor === null) openCreate();
      return;
    }
    setEditor(null);
    setViewTemplateTab(value);
  }

  /** [设为默认]（修订三 Q5）：切换生效模板引用（系统默认 = null）；清保存文案提示有待保存变更，
      落库走基础配置保存（strategy PUT prompt_template_id），不新设保存通道。 */
  function activateTemplate(templateId: string | null): void {
    setSelectedTemplateId(templateId);
    setSaveState("idle");
    setSaveMessage("");
  }

  /** 系统默认只读 → 「复制新建」出自建副本（预设名 + 平台默认内容）。 */
  function openCopySystemDefault(): void {
    if (!systemDefault) return;
    setEditor({ mode: "copy", name: "平台默认模板（副本）", content: systemDefault });
  }
  return (
    /* 修订三 Q1（2026-08-17）：卡是 flex 行内子项，必须 w-full 才撑满容器——否则宽度收缩到内容自然宽
       （维度下拉行宽），与模板配置面板满宽不一致。 */
    <Card className="flex h-full min-h-0 w-full flex-col gap-3 p-4" aria-label={meta.title}>
      {loading ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label={`正在读取${meta.title}`}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-20 w-full" />
          <p className="text-xs text-ink-2" role="status">正在读取配置…</p>
        </div>
      ) : error ? (
        <ErrorState message={humanErrorMessage(error, "配置读取失败，请重试")} onRetry={retry} />
      ) : activeTiers(tiers).length === 0 ? (
        <EmptyState
          title="当前没有可用的生成参数选项"
          description="这里显示本项目可用的生成模型与参数选项。全部参数选项暂不可用（被标记为实验或退役）。下一步：联系统筹或管理员开放后再来配置。"
        />
      ) : (
        <>
          {/* 卡内子 tab（?section= 持久化，见 LiteProjectConfigPage）；双面板常驻挂载，hidden 切可见性不丢未保存编辑。
              修订二：子 tab 比媒体 tab 更小一号（px-2 py-0.5 text-[11px]）；全链 flex+min-h-0 满屏分配高度。 */}
          <Tabs value={section} onValueChange={(value) => onSelectSection(value as ConfigSection)} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="w-fit p-0.5" aria-label={`${meta.title}内容分类`}>
              <TabsTrigger value="base" className="gap-1 px-2 py-0.5 text-[11px]">基础配置</TabsTrigger>
              {/* 音频卡无提示词模板概念（TTS 文本直接合成），模板配置子 tab 不渲染。 */}
              {kind !== "audio" ? <TabsTrigger value="template" className="gap-1 px-2 py-0.5 text-[11px]">模板配置</TabsTrigger> : null}
            </TabsList>
            <div className={section === "base" ? "mt-2 flex min-h-0 flex-1 flex-col gap-3" : "mt-2 hidden"}>
          {/* 修订三 Q1（2026-08-17）：维度行改 grid 等分满宽（auto-fit 1fr），与模板配置面板撑满一致；
              原 flex-wrap 自然宽右侧留白。label 上、控件下，下拉 w-full 吃满列宽；零选项说明态同样落格。 */}
          <div className="grid shrink-0 gap-3 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]">
            {FORM_DIMENSION_KEYS[kind].map((key) => {
              const dimension = dimensions.find((item) => item?.key === key);
              const label = DIMENSION_FIELD_LABEL[key]?.[kind] ?? dimension?.label ?? key;
              if (!dimension) {
                /* 零选项说明态（铁律：先有档再有界面，不虚构下拉选项）——
                   该模型未声明该维度：图片/音频=不可用+禁存；视频=按默认执行（档外执行兜底）。 */
                if (kind === "image" || kind === "audio") {
                  return (
                    <div key={key} className="flex min-w-0 flex-col gap-1 text-xs">
                      <span className="text-ink-2">{label}</span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="rounded-sm border border-border-1 bg-surface-2 px-2 py-2 text-ink-4">不可用</span>
                        <span className="text-ink-4">当前模型没有可用选项，请改选模型</span>
                      </span>
                    </div>
                  );
                }
                const fixed = key === "aspect_ratio" ? VIDEO_RATIO_FALLBACK : VIDEO_RESOLUTION_FALLBACK;
                return (
                  <div key={key} className="flex min-w-0 flex-col gap-1 text-xs">
                    <span className="text-ink-2">{label}</span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="rounded-sm border border-border-1 bg-surface-2 px-2 py-2 text-ink-1">{fixed}</span>
                      <span className="text-ink-4">当前参数选项未声明，按默认执行</span>
                    </span>
                  </div>
                );
              }
              /* 修订二（2026-08-17）：单值也是下拉；修订三 Q1：下拉 w-full 吃满列宽随卡伸缩。 */
              const selected = dimension.options.find((item) => item.selected);
              return (
                <div key={key} className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs text-ink-2">{label}</span>
                  <Select
                    className="w-full"
                    aria-label={`${meta.title}${label}`}
                    value={selected ? String(selected.value) : ""}
                    onChange={(event) => pickDimension(key, event.target.value)}
                  >
                    {dimension.options.map((option) => (
                      <option
                        key={String(option.value)}
                        value={String(option.value)}
                        disabled={!option.feasible}
                      >{option.label}{option.feasible ? "" : "（与当前其他参数无可用组合）"}</option>
                    ))}
                  </Select>
                </div>
              );
            })}
          </div>
          {/* 风格配置面板仅图/视频渲染——音频无风格注入概念（TTS 文本直接合成）。 */}
          {kind !== "audio" ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <span className="shrink-0 text-xs font-medium text-ink-2">风格配置</span>
              <p className="shrink-0 text-xs text-ink-4">风格是一段画面基调描述，生成时按默认风格自动注入提示词；可配多条，默认可随时换设或取消（取消后不注入）。</p>
              <div className="flex shrink-0 items-center justify-between gap-2">
                <span className="text-xs text-ink-3">{styles.length === 0 ? "还没有配置风格" : `${styles.length} 条风格`}</span>
                {/* 修订三·补二（2026-08-17 用户反馈）：行级动作全部上底色——accent(teal)=设默认/添加、
                    secondary(灰底)=编辑/复制新建/取消、warning-soft(琥珀底)=取消默认、danger-soft(红底)=删除；
                    页上不再有无底描边/透明按钮，一眼分得清动作。保存按钮仍唯一 primary。 */}
                <Button variant="accent" size="sm" disabled={styleBusy} onClick={openStyleCreate}>+ 添加风格</Button>
              </div>
              {styles.length === 0 ? (
                <EmptyState
                  title="还没有配置风格"
                  description="风格是一段生成基调描述，配图/视频会按默认风格自动注入提示词。下一步：点「+ 添加风格」添加，再把其中一个设为默认；默认可随时换设或取消。"
                />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1.5">
                  {styles.map((style) => (
                    <div key={style.id} className="flex shrink-0 items-start justify-between gap-2 rounded-sm border border-border-1 bg-surface-2 p-2">
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-ink-1">
                          {style.name}
                          {style.is_default ? <span className="rounded-sm bg-accent-subtle px-1.5 py-0.5 text-xs text-accent-text">默认</span> : null}
                        </span>
                        <span className="text-xs whitespace-pre-wrap break-words text-ink-3">{style.content}</span>
                      </span>
                      <span className="flex shrink-0 flex-col gap-1">
                        <Button variant="secondary" size="sm" disabled={styleBusy} onClick={() => openStyleEdit(style)}>编辑</Button>
                        {style.is_default ? (
                          <Button variant="warning-soft" size="sm" disabled={styleBusy} onClick={() => void clearStyleDefault(style)}>取消默认</Button>
                        ) : (
                          <Button variant="accent" size="sm" disabled={styleBusy} onClick={() => void setStyleDefault(style)}>设为默认</Button>
                        )}
                        <Button variant="danger-soft" size="sm" disabled={styleBusy} onClick={() => void removeStyle(style)}>删除</Button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {/* 修订三·补三（2026-08-17 用户反馈）：新建/编辑风格改弹窗——内联编辑器与列表抢高度，
                  小视口下文本区被压扁；弹窗有独立空间、列表上下文仍在（见 §4.1.4 Q7）。 */}
            </div>
            ) : null}
            </div>
            <div className={section === "template" ? "mt-2 flex min-h-0 flex-1 flex-col gap-2" : "mt-2 hidden"}>
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <span className="shrink-0 text-xs font-medium text-ink-2">提示词模板</span>
            <p className="shrink-0 text-xs text-ink-4">每次生成时按生效模板（带「生效中」徽标）自动拼入提示词；点模板 tab 仅预览内容，点面板内「设为默认」切换生效项，随「基础配置」保存落库。系统默认只读，自建模板内容 ≤5000 字符。</p>
            {kind === "video" ? (
              <label className="flex shrink-0 flex-wrap items-center gap-2 rounded-sm border border-border-1 p-2 text-xs">
                <span className="font-medium text-ink-2">分镜 Shot 数</span>
                <Input
                  type="number"
                  min={1}
                  max={STORYBOARD_SHOTS_PER_SEGMENT_MAX}
                  className="w-20 text-xs"
                  value={shotsPerSegment === null ? "" : String(shotsPerSegment)}
                  placeholder="自由"
                  aria-label="分镜 Shot 数"
                  onChange={(event) => setShotsPerSegment(parseShotsInput(event.target.value))}
                />
                <span className="text-ink-4">每段分镜拆几个镜头；留空=由 AI 按剧情内容自然决定（1-{STORYBOARD_SHOTS_PER_SEGMENT_MAX}），随「基础配置」保存落库。</span>
              </label>
            ) : null}
            <Tabs value={templateTabValue} onValueChange={selectTemplateTab} className="flex min-h-0 flex-1 flex-col">
              <TabsList className="flex-wrap shrink-0 p-0.5" aria-label={`${meta.title}提示词模板`}>
                {/* 修订三 Q2（2026-08-17）：模板库 tab 缩小一档，与卡内子 tab 同档（text-[11px] px-2 py-0.5）。 */}
                <TabsTrigger value="system" className="gap-1 px-2 py-0.5 text-[11px]">系统默认</TabsTrigger>
                {library.map((template) => (
                  <TabsTrigger key={template.id} value={template.id} className="max-w-40 gap-1 truncate px-2 py-0.5 text-[11px]">{template.name}</TabsTrigger>
                ))}
                <TabsTrigger value="new" className="gap-1 px-2 py-0.5 text-[11px]" disabled={templateBusy}>+ 新建模板</TabsTrigger>
              </TabsList>
              <TabsContent value="system" className="mt-2 flex min-h-0 flex-1 flex-col">
                {/* 修订三 Q4（2026-08-17）：系统默认改只读文本框形态（与新建模板编辑器同构：readOnly Input/Textarea）；
                    高度链 TabsContent flex-1 min-h-0 → 超长内容仅文本框内部滚动，不再压卡底保存行。 */}
                <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-sm border border-border-1 p-3" role="group" aria-label="系统默认模板（只读）">
                  <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs font-medium text-ink-2">
                    系统默认模板
                    {selectedTemplateId === null ? <span className="rounded-sm bg-accent-subtle px-1.5 py-0.5 text-xs text-accent-text">生效中</span> : null}
                  </span>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-ink-2">模板名称</span>
                    <Input className="text-xs" value="系统默认" readOnly aria-label="模板名称（只读）" />
                    <span className="text-xs text-ink-4">平台默认模板只读、随版本更新；要修改请「复制新建」后编辑副本。</span>
                  </label>
                  <label className="flex min-h-0 flex-1 flex-col gap-1">
                    <span className="text-xs font-medium text-ink-2">模板内容</span>
                    <Textarea
                      value={systemDefault || "（平台默认模板，随版本更新）"}
                      readOnly
                      className="min-h-0 flex-1 text-xs"
                      aria-label="模板内容（只读）"
                    />
                  </label>
                  <div className="flex shrink-0 items-center gap-2">
                    {selectedTemplateId !== null ? (
                      <Button variant="accent" size="sm" disabled={templateBusy} onClick={() => activateTemplate(null)}>设为默认</Button>
                    ) : null}
                    <Button variant="secondary" size="sm" disabled={editor !== null || templateBusy} onClick={openCopySystemDefault}>复制新建</Button>
                  </div>
                </div>
              </TabsContent>
              {library.map((template) => {
                /* 修订三 Q5：生效项 = selectedTemplateId（与保存引用同源）；非生效面板显 [设为默认]，生效面板显「生效中」徽标。 */
                const isActive = selectedTemplateId === template.id;
                return (
                  <TabsContent key={template.id} value={template.id} className="mt-2 flex min-h-0 flex-1 flex-col">
                    <div className="flex min-h-0 flex-1 items-start justify-between gap-2 rounded-sm border border-border-1 p-2">
                      <span className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
                        <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs font-medium text-ink-1">
                          {template.name}
                          {isActive ? <span className="rounded-sm bg-accent-subtle px-1.5 py-0.5 text-xs text-accent-text">生效中</span> : null}
                        </span>
                        <span className="min-h-0 flex-1 overflow-y-auto text-xs whitespace-pre-wrap break-words text-ink-3">{template.content}</span>
                      </span>
                      <span className="flex shrink-0 flex-col gap-1">
                        {!isActive ? (
                          <Button variant="accent" size="sm" disabled={templateBusy} onClick={() => activateTemplate(template.id)}>设为默认</Button>
                        ) : null}
                        <Button variant="secondary" size="sm" disabled={editor !== null || templateBusy} onClick={() => openEdit(template)}>编辑</Button>
                        <Button variant="secondary" size="sm" disabled={editor !== null || templateBusy} onClick={() => openCopy(template)}>复制新建</Button>
                        <Button variant="danger-soft" size="sm" disabled={templateBusy} onClick={() => void removeTemplate(template)}>删除</Button>
                      </span>
                    </div>
                  </TabsContent>
                );
              })}
              {/* 修订三·补三：[+ 新建模板] 的编辑器同改弹窗（与风格编辑器同一形态，单一约定）。 */}
            </Tabs>
            {missingTemplateNote ? <p className="shrink-0 text-xs text-warning" role="status">{missingTemplateNote}</p> : null}
          </div>
            </div>
          </Tabs>
          {/* 修订三 Q3（2026-08-17）：卡底保存行仅「基础配置」子 tab 渲染——模板配置面板没有可保存状态
              （维度不在场、模板引用已即时标记生效待保存），悬空保存按钮误导；模板引用随基础配置保存落库。 */}
          {section === "base" ? (
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <Button
                variant="primary"
                loading={saveState === "saving"}
                disabled={saveDisabledReason !== ""}
                title={saveDisabledReason || undefined}
                onClick={() => void save()}
              >保存{kind === "image" ? "图片" : kind === "audio" ? "音频" : "视频"}配置</Button>
              {saveDisabledReason ? <span className="text-xs text-ink-4">{saveDisabledReason}</span> : null}
              {saveMessage ? (
                <span
                  className={saveState === "error" || saveState === "conflict" ? "text-xs text-danger" : saveState === "saved" ? "text-xs text-success" : "text-xs text-ink-2"}
                  role={saveState === "error" || saveState === "conflict" ? "alert" : "status"}
                >{saveMessage}</span>
              ) : null}
            </div>
          ) : null}
      {styleEditor ? (
        <Dialog open onOpenChange={(open) => { if (!open && !styleBusy) setStyleEditor(null); }}>
          <DialogContent size="medium" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>{styleEditor.source ? "编辑风格" : "新建风格"}</DialogTitle>
              <DialogDescription>风格是一段画面基调描述；保存后入风格库，可再设为默认注入生成。</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <div className="flex flex-col gap-3" role="group" aria-label="风格编辑器">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-ink-2">风格名称</span>
                  <Input
                    className="text-xs"
                    value={styleEditor.name}
                    maxLength={PROJECT_STYLE_NAME_MAX}
                    aria-label="风格名称"
                    onChange={(event) => setStyleEditor({ ...styleEditor, name: event.target.value })}
                  />
                  <span className="text-xs text-ink-4">1-{PROJECT_STYLE_NAME_MAX} 字符，同媒介内不可重名。</span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium text-ink-2">风格内容</span>
                    <span className={styleEditor.content.length > PROJECT_STYLE_CONTENT_MAX ? "text-xs text-danger" : "text-xs text-ink-4"}>
                      {styleEditor.content.length}/{PROJECT_STYLE_CONTENT_MAX}
                    </span>
                  </span>
                  <Textarea
                    value={styleEditor.content}
                    rows={8}
                    className="text-xs"
                    aria-label="风格内容"
                    aria-invalid={styleEditor.content.length > PROJECT_STYLE_CONTENT_MAX}
                    placeholder="如：港风霓虹，暖色调，胶片颗粒，大景别，电影级质感"
                    onChange={(event) => setStyleEditor({ ...styleEditor, content: event.target.value })}
                  />
                </label>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" size="sm" disabled={styleBusy} onClick={() => setStyleEditor(null)}>取消</Button>
              <Button variant="primary" size="sm" loading={styleBusy} disabled={!styleEditorValid} onClick={() => void submitStyleEditor()}>
                {styleEditor.source ? "保存修改" : "创建风格"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {editor ? (
        <Dialog open onOpenChange={(open) => { if (!open && !templateBusy) setEditor(null); }}>
          <DialogContent size="medium" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>{editor.mode === "edit" ? "编辑模板" : editor.mode === "copy" ? "复制新建模板" : "新建模板"}</DialogTitle>
              <DialogDescription>模板在生成时自动拼入提示词；创建/保存后即生效，随「基础配置」保存落库。</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <div className="flex flex-col gap-3" role="group" aria-label="模板编辑器">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-ink-2">模板名称</span>
                  <Input
                    className="text-xs"
                    value={editor.name}
                    maxLength={PROMPT_TEMPLATE_NAME_MAX}
                    aria-label="模板名称"
                    onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                  />
                  <span className="text-xs text-ink-4">1-{PROMPT_TEMPLATE_NAME_MAX} 字符，同媒介内不可重名。</span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium text-ink-2">模板内容</span>
                    <span className={editor.content.length > PROMPT_TEMPLATE_CONTENT_MAX ? "text-xs text-danger" : "text-xs text-ink-4"}>
                      {editor.content.length}/{PROMPT_TEMPLATE_CONTENT_MAX}
                    </span>
                  </span>
                  <Textarea
                    value={editor.content}
                    rows={8}
                    className="text-xs"
                    aria-label="模板内容"
                    aria-invalid={editor.content.length > PROMPT_TEMPLATE_CONTENT_MAX}
                    placeholder="如：写实电影质感，角色形象与资产库一致；不要文字水印、不要变形手指"
                    onChange={(event) => setEditor({ ...editor, content: event.target.value })}
                  />
                </label>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" size="sm" disabled={templateBusy} onClick={() => setEditor(null)}>取消</Button>
              <Button variant="primary" size="sm" loading={templateBusy} disabled={!editorValid} onClick={() => void submitEditor()}>
                {editor.mode === "edit" ? "保存修改" : editor.mode === "copy" ? "创建副本" : "创建模板"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
        </>
      )}
      {/* v1.9 十.11：删除(模板/风格)自定义二次确认（取代浏览器原生 confirm） */}
      <LiteConfirmDialog state={confirmState} busy={templateBusy || styleBusy} onClose={() => setConfirmState(null)} />
    </Card>
  );
}

/** 媒体类型 tab 持久化：读写 URL query `kind`（同 `asset_tab` 模式，不用 localStorage）。 */
function readKindFromUrl(): LiteConfigKind {
  const kind = new URLSearchParams(window.location.search).get("kind");
  return kind === "video" ? "video" : kind === "audio" ? "audio" : "image";
}

/** 卡内子 tab 持久化：读写 URL query `section`（与 `kind` 正交；两卡共用同一子 tab）。 */
function readSectionFromUrl(): ConfigSection {
  return new URLSearchParams(window.location.search).get("section") === "template" ? "template" : "base";
}

export function LiteProjectConfigPage({ demoMode, notify, projectId }: PageRuntimeProps & { projectId: string }): React.JSX.Element {
  /* 页头无标题/副标题（用户裁定 2026-08-16）→ 不再取项目名，页面加载少一次 GET /projects/:id。 */
  const [kind, setKind] = useState<LiteConfigKind>(() => readKindFromUrl());
  const [section, setSection] = useState<ConfigSection>(() => readSectionFromUrl());

  function selectKind(next: LiteConfigKind): void {
    setKind(next);
    const url = new URL(window.location.href);
    if (next === "image") url.searchParams.delete("kind");
    else url.searchParams.set("kind", next);
    // replaceState：不触发导航/重新挂载，只更新地址栏。
    window.history.replaceState(null, "", url.toString());
  }
  /** 卡内子 tab：?section= 持久化，与 ?kind= 正交（各自独立 replaceState，互不清除）。 */
  function selectSection(next: ConfigSection): void {
    setSection(next);
    const url = new URL(window.location.href);
    if (next === "base") url.searchParams.delete("section");
    else url.searchParams.set("section", next);
    window.history.replaceState(null, "", url.toString());
  }

  return (
    /* 追加裁定（2026-08-17）：宽度也随屏幕伸缩——撤销 R2-8 的 1440/1920px 上限，容器 w-full 满宽（仅留页边距）；
       高度链不变：整页满屏、无页面滚动，只有模板/风格文本区在自身盒内滚动（§4.1.3）。 */
    <section className="flex h-full min-h-0 w-full flex-1 flex-col gap-3 px-4 py-2">
      {/* 媒体 tab（修订二：小一号）；Tabs 根接管 flex 高度链。 */}
      <Tabs value={kind} onValueChange={(value) => selectKind(value as LiteConfigKind)} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0 p-0.5" aria-label="配置媒体类型">
          <TabsTrigger value="image" className="gap-1 px-2.5 text-xs"><ImageSquare aria-hidden="true" className="size-3.5" />图片配置</TabsTrigger>
          <TabsTrigger value="video" className="gap-1 px-2.5 text-xs"><VideoCamera aria-hidden="true" className="size-3.5" />视频配置</TabsTrigger>
          <TabsTrigger value="audio" className="gap-1 px-2.5 text-xs"><SpeakerHigh aria-hidden="true" className="size-3.5" />音频配置</TabsTrigger>
        </TabsList>
        {/* 三卡常驻挂载（未保存编辑切换不丢），仅切可见性；卡内基础/模板子面板同样常驻（hidden 切可见性）。
            修订二（2026-08-17）：卡容器也吃满屏高度（flex-1 + min-h-0），高度逐层下传到文本区。 */}
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4">
          <div className={kind === "image" ? "flex min-h-0 flex-1" : "hidden"}>
            <LiteGenerationConfigCard projectId={projectId} kind="image" section={section} onSelectSection={selectSection} demoMode={demoMode} notify={notify} />
          </div>
          <div className={kind === "video" ? "flex min-h-0 flex-1" : "hidden"}>
            <LiteGenerationConfigCard projectId={projectId} kind="video" section={section} onSelectSection={selectSection} demoMode={demoMode} notify={notify} />
          </div>
          <div className={kind === "audio" ? "flex min-h-0 flex-1" : "hidden"}>
            <LiteGenerationConfigCard projectId={projectId} kind="audio" section={section} onSelectSection={selectSection} demoMode={demoMode} notify={notify} />
          </div>
        </div>
      </Tabs>
    </section>
  );
}
