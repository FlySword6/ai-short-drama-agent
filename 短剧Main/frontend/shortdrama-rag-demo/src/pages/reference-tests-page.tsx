/* ============================================================
   reference-tests-page.tsx — W5-B 测试域（板07「参考测试」）整页
   职责：小成本试模式×模型 → 满意批次设为默认策略；本页不绕过报价确认链，
   「生成测试」严格一次人工点击一个任务，超阈值再追加一次费用复核。
   W7 IA：双用法——独立页（路由带 projectId）行为不变；资产中心「参考测试」
   页签内嵌时不传 projectId，由项目选择门（api.projects，默认最近更新项目）
   先定项目再进同一测试域，主体逻辑零改动。
   纯函数与 demo fixture 集中在本文件头部，供 src/reference-tests.test.ts 覆盖；
   视图层为 Tailwind v4 + components/ui（Dialog 弹窗、Badge/Card/Skeleton、
   LoadingState/ErrorState/EmptyState），本文件保持可被测试 import
   （与 settings-page.tsx 同一约定：tsx 单测环境无法加载 CSS）。
   reference-tests.css 已清空为迁移占位（app.tsx 的 import 行接线层冻结）。
   ============================================================ */
import {
  ArrowClockwise,
  CheckCircle,
  Clock,
  CurrencyCny,
  Eye,
  FilmStrip,
  Flask,
  ImageSquare,
  Info,
  PencilSimple,
  Plus,
  SpinnerGap,
  Trash,
  VideoCamera,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DependencyList } from "react";
import { ApiClientError, api, type GenerationQuoteWithTier, type SimpleEstimate, type TieredGenerationSubmissionInput } from "../api";
import { newId } from "../uuid";
import { FALLBACK_IMAGE_TIER, FALLBACK_VIDEO_TIER, activeTiers, listCapabilityTiers, resolveSelectedTier, tierLabel, tierSubmitInput, type CapabilityTier } from "../capability-tiers";
import { refIsImageReference } from "../asset-media";
import { VectorStatusProbe } from "./material-agent-page";
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
  Skeleton,
  Textarea,
} from "../components/ui/primitives";
import { demoProjectAssets, demoProjects } from "../demo";
import { formatCost, formatQuoteExpiry, quoteIsExpired } from "../generation-quotes";
import { navigate } from "../routing";
import type {
  GenerationDefaultStrategy,
  GenerationSubmissionInput,
  GenerationTask,
  ListData,
  Page,
  Project,
  ProjectAssetRef,
  ProjectReferenceTestResult,
  ReferenceTest,
  ReferenceTestInput,
  ReferenceTestMediaKind,
  ReferenceTestMode,
} from "../types";
import {
  formatDateTime,
  useResource,
} from "../ui";
import { humanErrorMessage } from "./batch-generate-drawer";
import { businessErrorMessage } from "../error-copy";
import { CapabilityStatusBar } from "../components/capability-status";
import { platformRoleForCopy } from "../capabilities-state";
import type { PageRuntimeProps } from "./global-pages";

/* ---------- 模式与媒体文案（板07 用词唯一出口） ---------- */

export interface ReferenceTestModeCopy {
  /** 模式卡/结果卡上的模式名。 */
  name: string;
  /** 模式卡副文案：一句话说清这条链路怎么对待参考素材。 */
  summary: string;
}

export const REFERENCE_TEST_MODE_CARDS: Record<ReferenceTestMode, ReferenceTestModeCopy> = {
  direct_reference: {
    name: "直接@素材生成模式",
    summary: "生成时保留@参考图，参考素材直接进画面。",
  },
  material_to_prompt: {
    name: "素材转提示词参考模式",
    summary: "先解析参考素材为镜头光线提示词，再按提示词生成。",
  },
};

export function referenceTestModeCopy(mode: ReferenceTestMode): ReferenceTestModeCopy {
  return REFERENCE_TEST_MODE_CARDS[mode];
}

/** 媒体类型名词（结果卡 pill / 按钮文案）。 */
export function mediaKindNoun(kind: ReferenceTestMediaKind): string {
  return kind === "image" ? "图片" : "视频";
}

/** 新建弹窗「生成目标」选项文案。 */
export function mediaKindGoal(kind: ReferenceTestMediaKind): string {
  return kind === "image" ? "生图片" : "生视频";
}

/** 测试卡运行按钮：付费动作，文案带生成目标（板07）。 */
export function runButtonLabel(kind: ReferenceTestMediaKind): string {
  return `生成测试${mediaKindNoun(kind)}`;
}

/** model_key 展示：注册表当前只有服务端配置模型真实可用。 */
export function modelKeyLabel(modelKey: string): string {
  if (modelKey === "configured") return "当前配置模型";
  return modelKey || "未选模型";
}

/* ---------- 模型注册表 ----------
   复刻自 workbench-page.tsx 的 IMAGE_MODEL_CARDS / VIDEO_MODEL_CARDS（同源写法，
   该文件不可改，此处自备一份）：模型能力登记接口就绪前，只有「当前配置模型」
   （火山方舟，型号以服务端配置为准）真实可用（model_key="configured"），
   其余为禁用态，文案只说用户能做的事（找管理员配置），不写工程核实状态。 */
export const REFERENCE_TEST_IMAGE_MODEL_CARDS = [
  { key: "configured", name: "当前配置模型", note: "火山方舟 · 型号以服务端配置为准", available: true },
  { key: "gpt-image-2", name: "GPT Image 2", note: "管理员配置后可用", available: false },
  { key: "gemini-image", name: "Gemini 图像模型", note: "管理员配置后可用", available: false },
  { key: "seedream-5-pro", name: "Seedream 5 Pro", note: "管理员配置后可用", available: false },
] as const;

export const REFERENCE_TEST_VIDEO_MODEL_CARDS = [
  { key: "configured", name: "当前配置模型", note: "火山方舟 · 型号以服务端配置为准", available: true },
  { key: "seedance-2-0", name: "Seedance 2.0", note: "管理员配置后可用", available: false },
  { key: "happyhorse-1-1", name: "HappyHorse 1.1", note: "管理员配置后可用", available: false },
] as const;

/* ---------- 常量 ---------- */

/** 参考素材多选上限（与生成链 reference_media_ids 上限一致）。 */
export const REFERENCE_MEDIA_LIMIT = 9;
export const REFERENCE_TESTS_PAGE_SIZE = 24;
export const REFERENCE_TEST_RESULTS_PAGE_SIZE = 12;
/** 生成测试轮询节奏：3s 一次，约 5 分钟（100 次）后停止等待，任务仍在服务端执行。 */
export const RUN_POLL_INTERVAL_MS = 3_000;
export const RUN_MAX_POLLS = 100;
/** 连续多次查询任务状态失败视为断网，停止轮询并明示。 */
const RUN_POLL_MAX_FAILURES = 5;

/* ---------- 判定与组装（纯函数） ---------- */

/** 结果卡序号：#01 起，两位数补齐。 */
export function formatResultOrdinal(index: number): string {
  const value = Math.max(1, Math.trunc(index));
  return `#${String(value).padStart(2, "0")}`;
}

/**
 * 「当前默认」判定：同媒体类型的生成默认策略，其来源生成请求正是该结果挂的请求。
 * 策略按 media_kind 各存一份；source_generation_request_id 为空不算默认。
 */
export function resultIsCurrentDefault(
  strategies: GenerationDefaultStrategy[],
  result: Pick<ProjectReferenceTestResult, "mediaKind" | "generationRequestId">,
): boolean {
  const strategy = strategies.find((item) => item.media_kind === result.mediaKind);
  return Boolean(strategy?.source_generation_request_id)
    && strategy?.source_generation_request_id === result.generationRequestId;
}

/**
 * 「设为默认」的乐观锁版本：取同媒体类型已持久化策略的 version；
 * 该类型还没有持久化策略时回 0（安全默认，服务端据此创建）。
 */
export function defaultStrategyVersion(
  strategies: GenerationDefaultStrategy[],
  mediaKind: ReferenceTestMediaKind,
): number {
  return strategies.find((item) => item.media_kind === mediaKind)?.version ?? 0;
}

/** 板14 冲突态辅助：乐观锁 409（版本冲突/终态冲突）。 */
export function isConflictError(reason: unknown): boolean {
  return reason instanceof ApiClientError && reason.status === 409;
}

/**
 * 测试域生成入参：项目级生成（episode/scene/shot 均为空），
 * client_idempotency_key 由调用方用 newId() 生成后传入（可测）。
 * 不改动测试对象本身。
 * 带 tier（生产唯一路径）：档是原子的,参数整档取,tier_id 全链必填（不一致 422）;
 * 测试记录上的 mode/modelKey/parameters 是策略登记信息,不进提交参数（档外组合界面不给选）。
 * 不带 tier（兼容旧调用/纯函数测试）：parameters 合并测试配置 + { mode, model_key },quantity 恒 1。
 */
export function buildTestGenerationInput(
  test: Pick<ReferenceTest, "mediaKind" | "mode" | "modelKey" | "prompt" | "parameters" | "referenceMediaIds">,
  projectId: string,
  idempotencyKey: string,
): GenerationSubmissionInput & { tier_id?: string };
export function buildTestGenerationInput(
  test: Pick<ReferenceTest, "mediaKind" | "mode" | "modelKey" | "prompt" | "parameters" | "referenceMediaIds">,
  projectId: string,
  idempotencyKey: string,
  tier: CapabilityTier,
): TieredGenerationSubmissionInput;
export function buildTestGenerationInput(
  test: Pick<ReferenceTest, "mediaKind" | "mode" | "modelKey" | "prompt" | "parameters" | "referenceMediaIds">,
  projectId: string,
  idempotencyKey: string,
  tier?: CapabilityTier,
): GenerationSubmissionInput & { tier_id?: string } {
  const base = {
    media_kind: test.mediaKind,
    project_id: projectId,
    episode_id: null,
    scene_id: null,
    shot_id: null,
    prompt: test.prompt,
    reference_media_ids: [...test.referenceMediaIds],
    client_idempotency_key: idempotencyKey,
  };
  if (tier) {
    const { parameters, quantity } = tierSubmitInput(tier);
    return { ...base, tier_id: tier.tier_id, parameters, quantity };
  }
  return {
    ...base,
    parameters: { ...test.parameters, mode: test.mode, model_key: test.modelKey },
    quantity: 1,
  };
}

/* ---------- demo fixture（离线演示整页渲染；写操作一律 toast 不调用） ---------- */

const DEMO_RT_TS = "2026-07-18T09:30:00.000Z";

/** ≥2 个测试：两模式 × 两媒体类型都铺到。 */
export const demoReferenceTests: ReferenceTest[] = [
  {
    id: "demo-rt-1",
    projectId: "demo-project-2",
    name: "夜戏雨巷·定妆直出",
    mediaKind: "image",
    mode: "direct_reference",
    modelKey: "configured",
    prompt: "雨夜巷口，青瓦反光，任天野钦差官服半身像，电影级写实。",
    parameters: { ratio: "16:9", size: "2K" },
    referenceMediaIds: ["demo-media-ren", "demo-media-harbor"],
    createdByUserId: "demo-user",
    version: 2,
    createdAt: DEMO_RT_TS,
    updatedAt: DEMO_RT_TS,
  },
  {
    id: "demo-rt-2",
    projectId: "demo-project-2",
    name: "官服细节·素材转提示词",
    mediaKind: "image",
    mode: "material_to_prompt",
    modelKey: "configured",
    prompt: "",
    parameters: { ratio: "16:9", size: "2K" },
    referenceMediaIds: ["demo-media-costume"],
    createdByUserId: "demo-user",
    version: 1,
    createdAt: DEMO_RT_TS,
    updatedAt: DEMO_RT_TS,
  },
  {
    id: "demo-rt-3",
    projectId: "demo-project-2",
    name: "女主转身·镜头光线提示词",
    mediaKind: "video",
    mode: "material_to_prompt",
    modelKey: "configured",
    prompt: "镜头稳定推进，女主回身，衣袂摆动，保持人物与服装一致。",
    parameters: { ratio: "9:16", resolution: "720p", duration_seconds: 4 },
    referenceMediaIds: ["demo-media-lin"],
    createdByUserId: "demo-user",
    version: 1,
    createdAt: DEMO_RT_TS,
    updatedAt: DEMO_RT_TS,
  },
];

/** 4 条结果：两模式 × 两媒体类型全覆盖；rtr-1 是「当前默认」（见 demoReferenceTestDefaults）。 */
export const demoReferenceTestResults: ProjectReferenceTestResult[] = [
  {
    id: "demo-rtr-1",
    referenceTestId: "demo-rt-1",
    referenceTestName: "夜戏雨巷·定妆直出",
    generationRequestId: "demo-req-rt-01",
    mediaResultId: "demo-mr-01",
    mediaKind: "image",
    mode: "direct_reference",
    modelKey: "configured",
    parameters: { ratio: "16:9", size: "2K", mode: "direct_reference", model_key: "configured" },
    createdByUserId: "demo-user",
    createdAt: "2026-07-18T10:05:00.000Z",
    mediaResult: { storageUrl: null, persistenceStatus: "persisted", mimeType: "image/png", widthPx: 2048, heightPx: 1152, durationSeconds: null },
  },
  {
    id: "demo-rtr-2",
    referenceTestId: "demo-rt-2",
    referenceTestName: "官服细节·素材转提示词",
    generationRequestId: "demo-req-rt-02",
    mediaResultId: "demo-mr-02",
    mediaKind: "image",
    mode: "material_to_prompt",
    modelKey: "configured",
    parameters: { ratio: "16:9", size: "2K", mode: "material_to_prompt", model_key: "configured" },
    createdByUserId: "demo-user",
    createdAt: "2026-07-18T10:20:00.000Z",
    mediaResult: { storageUrl: null, persistenceStatus: "persisted", mimeType: "image/png", widthPx: 2048, heightPx: 1152, durationSeconds: null },
  },
  {
    id: "demo-rtr-3",
    referenceTestId: "demo-rt-3",
    referenceTestName: "女主转身·镜头光线提示词",
    generationRequestId: "demo-req-rt-03",
    mediaResultId: "demo-mr-03",
    mediaKind: "video",
    mode: "material_to_prompt",
    modelKey: "configured",
    parameters: { ratio: "9:16", resolution: "720p", duration_seconds: 4, mode: "material_to_prompt", model_key: "configured" },
    createdByUserId: "demo-user",
    createdAt: "2026-07-18T10:40:00.000Z",
    mediaResult: { storageUrl: null, persistenceStatus: "persisted", mimeType: "video/mp4", widthPx: 720, heightPx: 1280, durationSeconds: 4 },
  },
  {
    id: "demo-rtr-4",
    referenceTestId: "demo-rt-3",
    referenceTestName: "女主转身·镜头光线提示词",
    generationRequestId: "demo-req-rt-04",
    mediaResultId: "demo-mr-04",
    mediaKind: "video",
    mode: "direct_reference",
    modelKey: "configured",
    parameters: { ratio: "9:16", resolution: "720p", duration_seconds: 4, mode: "direct_reference", model_key: "configured" },
    createdByUserId: "demo-user",
    createdAt: "2026-07-18T11:05:00.000Z",
    mediaResult: { storageUrl: null, persistenceStatus: "persisted", mimeType: "video/mp4", widthPx: 720, heightPx: 1280, durationSeconds: 4 },
  },
];

/** 默认策略 fixture：图片策略的源头正是 rtr-1 的生成请求 → rtr-1 即「当前默认」；视频暂无策略（version=0 路径）。 */
export const demoReferenceTestDefaults: GenerationDefaultStrategy[] = [
  {
    id: "demo-strategy-image",
    project_id: "demo-project-2",
    media_kind: "image",
    mode: "direct_reference",
    model_key: "configured",
    parameters: { ratio: "16:9", size: "2K" },
    source_generation_request_id: "demo-req-rt-01",
    version: 3,
    created_at: DEMO_RT_TS,
    updated_at: DEMO_RT_TS,
  },
];

/* ---------- 页面局部类型 ---------- */

type QuoteFlowStatus = "ready" | "confirming" | "submitting" | "failed" | "expired";

interface PendingTestQuote {
  quote: GenerationQuoteWithTier;
  test: ReferenceTest;
  input: TieredGenerationSubmissionInput;
  status: QuoteFlowStatus;
  error?: string;
}

/** 每张测试卡的运行相位；failed 只留错误展示，不算占用。 */
interface TestRunState {
  phase: "quoting" | "submitting" | "polling" | "attaching" | "failed";
  requestId?: string;
  error?: string;
}

type EditorState =
  | { kind: "create"; mediaKind: ReferenceTestMediaKind }
  | { kind: "edit"; test: ReferenceTest }
  | null;

const CONFLICT_TOAST = "已被他人修改，已刷新";
const DEMO_WRITE_TOAST = "离线演示不提交";

function runPhaseLabel(phase: TestRunState["phase"]): string {
  if (phase === "quoting") return "报价中…";
  if (phase === "submitting") return "提交中…";
  if (phase === "polling") return "生成中…";
  if (phase === "attaching") return "挂载结果…";
  return "失败";
}

/* ---------- 页面（双用法：独立页带 projectId；资产中心内嵌自择项目） ---------- */

/**
 * 独立用法：路由 /projects/:id/reference-tests 传入 projectId，原行为不变；
 * 内嵌用法（资产中心「实验室」页签）：不传 projectId，先由项目选择门定项目，
 * 再进同一个 ReferenceTestsDomain，测试域主体逻辑零改动。
 * 页底挂向量服务状态自探测卡（「语义检索」页签撤并后诊断迁此）。
 */
export function ReferenceTestsPage({ projectId, ...runtime }: PageRuntimeProps & { projectId?: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      {projectId ? <ReferenceTestsDomain {...runtime} projectId={projectId} /> : <ReferenceTestsProjectGate {...runtime} />}
      <VectorStatusProbe demoMode={runtime.demoMode} />
    </div>
  );
}

/** 默认项目：updated_at 最新者；时间戳缺失保持列表顺序取首个；空列表回空串（调用方走引导空态）。 */
export function mostRecentProjectId(projects: Project[]): string {
  let best = "";
  let bestStamp = "";
  for (const project of projects) {
    const stamp = project.updated_at ?? "";
    if (!best || stamp > bestStamp) {
      best = project.id;
      bestStamp = stamp;
    }
  }
  return best;
}

/** 内嵌项目选择门：api.projects 列表 + 默认最近更新项目；一个项目都没有时引导空态「先选一个项目」。
    深链 ?project=（旧 /projects/:id/reference-tests 301 带过来）预选项目，切换时 replace 同步回 URL。 */
function ReferenceTestsProjectGate({ demoMode, notify, user, capabilities }: PageRuntimeProps): React.JSX.Element {
  const { data, loading, error, retry } = useResource<ListData<Project>>(
    () => api.projects(),
    { items: demoProjects, count: demoProjects.length },
    demoMode,
    [],
  );
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(window.location.search).get("project") ?? "");
  const projects = data?.items ?? [];
  const effectiveId = projects.some((project) => project.id === selectedId) ? selectedId : mostRecentProjectId(projects);

  /** 切换项目：本地态生效 + ?project= 深链同步（replace，不把每次切换堆进历史）。 */
  function chooseProject(id: string): void {
    setSelectedId(id);
    const params = new URLSearchParams(window.location.search);
    params.set("project", id);
    navigate(`${window.location.pathname}?${params.toString()}`, { replace: true });
  }

  if (loading) return <LoadingState label="正在读取项目列表" onRetry={retry} />;
  if (error) return <ErrorState message={humanErrorMessage(error, "项目列表读取失败，请重试")} onRetry={retry} />;
  if (projects.length === 0) {
    return (
      <Card>
        <EmptyState
          title="先选一个项目"
          description="参考测试挂在项目下：先到项目管理创建一部剧，再回来对比模式与模型。"
          action={<Button variant="primary" icon={<Plus />} onClick={() => navigate("/projects")}>新建项目</Button>}
          mascot="search"
        />
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-ink-2">测试项目</span>
        <Select className="w-64" aria-label="选择参考测试项目" value={effectiveId} onChange={(event) => chooseProject(event.target.value)}>
          {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
        </Select>
      </div>
      {/* key：换项目即重置测试域本地态（选中测试/运行相位/轮询随卸载清理），避免跨项目串数据。 */}
      <ReferenceTestsDomain key={effectiveId} projectId={effectiveId} demoMode={demoMode} notify={notify} user={user} capabilities={capabilities} />
    </div>
  );
}

function ReferenceTestsDomain({ projectId, demoMode, notify, capabilities }: PageRuntimeProps & { projectId: string }): React.JSX.Element {
  const tests = usePagedList<ReferenceTest>(
    useCallback((page) => api.referenceTests(projectId, page, REFERENCE_TESTS_PAGE_SIZE), [projectId]),
    demoReferenceTests,
    demoMode,
    [projectId],
  );
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  // 名称快照：测试列表分页后当前测试可能不在已加载页里，结果区标题用快照兜底。
  const [selectedTestName, setSelectedTestName] = useState("");
  const results = usePagedList<ProjectReferenceTestResult>(
    useCallback(
      (page) => selectedTestId
        ? api.referenceTestResults(projectId, selectedTestId, page, REFERENCE_TEST_RESULTS_PAGE_SIZE)
        : api.projectReferenceTestResults(projectId, page, REFERENCE_TEST_RESULTS_PAGE_SIZE),
      [projectId, selectedTestId],
    ),
    // demo 模式本地过滤到单测试，和真实接口行为对齐。
    selectedTestId ? demoReferenceTestResults.filter((item) => item.referenceTestId === selectedTestId) : demoReferenceTestResults,
    demoMode,
    [projectId, selectedTestId],
  );
  const defaults = useResource<ListData<GenerationDefaultStrategy>>(
    () => api.generationDefaults(projectId),
    { items: demoReferenceTestDefaults, count: demoReferenceTestDefaults.length },
    demoMode,
    [projectId],
  );
  const assets = useResource<ListData<ProjectAssetRef>>(
    () => api.projectAssets(projectId),
    { items: demoProjectAssets, count: demoProjectAssets.length },
    demoMode,
    [projectId],
  );

  const [editor, setEditor] = useState<EditorState>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [deleting, setDeleting] = useState<ReferenceTest | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [detailResult, setDetailResult] = useState<ProjectReferenceTestResult | null>(null);
  const [settingDefaultId, setSettingDefaultId] = useState("");
  const [pendingQuote, setPendingQuote] = useState<PendingTestQuote | null>(null);
  /* 提交档（capability-tiers 接口真源，S10 第一节）：两类测试各取该媒型首个 active 档;
     裁决 4：读取失败不回落本地档——按媒型分别记错（S46-A,一类失败不拖死另一类）,
     错误展示收敛到「AI 能力状态」条,不再就地拼红字。 */
  const [tierMap, setTierMap] = useState<{ image: CapabilityTier | null; video: CapabilityTier | null }>({ image: null, video: null });
  const [tierErrors, setTierErrors] = useState<{ image: string; video: string }>({ image: "", video: "" });
  const [tierRevision, setTierRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setTierErrors({ image: "", video: "" });
    void Promise.all((["image", "video"] as const).map(async (kind) => {
      try {
        const result = await listCapabilityTiers(kind, demoMode);
        return [kind, { tier: resolveSelectedTier(activeTiers(result.tiers), null), error: "" }] as const;
      } catch (reason) {
        return [kind, { tier: null, error: businessErrorMessage(reason, "生成档位读取失败") }] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setTierMap({ image: entries[0]![1].tier, video: entries[1]![1].tier });
      setTierErrors({ image: entries[0]![1].error, video: entries[1]![1].error });
    });
    return () => { cancelled = true; };
  }, [demoMode, tierRevision]);
  /* 估价预览（任务 3·simpleEstimate 无项目上下文）：参考测试无分镜/资产目标,
     全链估价（submissionEstimateSchema 要 shot_id 或 target_asset_entity_id）在本页不适用——
     运行前看价走简单估价（只看价,不创建报价/任务）;demo 按初始档 fixture 档价推导。 */
  const [estimateMap, setEstimateMap] = useState<{ image: SimpleEstimate | null; video: SimpleEstimate | null }>({ image: null, video: null });
  useEffect(() => {
    if (demoMode) return;
    let cancelled = false;
    const entries = (["image", "video"] as const).map(async (kind) => {
      const tier = tierMap[kind];
      if (!tier) return [kind, null] as const;
      try {
        const { parameters, quantity } = tierSubmitInput(tier);
        const estimate = await api.simpleEstimate({ media_kind: kind, tier_id: tier.tier_id, parameters, quantity });
        return [kind, estimate] as const;
      } catch {
        return [kind, null] as const;
      }
    });
    void Promise.all(entries).then((rows) => {
      if (cancelled) return;
      setEstimateMap({
        image: rows.find(([kind]) => kind === "image")?.[1] ?? null,
        video: rows.find(([kind]) => kind === "video")?.[1] ?? null,
      });
    });
    return () => { cancelled = true; };
  }, [demoMode, tierMap]);
  const [runStates, setRunStates] = useState<Record<string, TestRunState>>({});
  const pollCancelRef = useRef(new Map<string, () => void>());

  // 页面切换/组件卸载：清掉所有轮询 interval，回调不再落地。
  useEffect(() => {
    const cancels = pollCancelRef.current;
    return () => {
      for (const cancel of cancels.values()) cancel();
      cancels.clear();
    };
  }, []);

  const trackRun = useCallback((testId: string, state: TestRunState | null) => {
    setRunStates((current) => {
      const next = { ...current };
      if (state) next[testId] = state;
      else delete next[testId];
      return next;
    });
  }, []);

  /** 板14 冲突态：409 后整体重拉，告诉用户已刷新。 */
  const reloadAfterConflict = useCallback(() => {
    tests.retry();
    results.retry();
    defaults.retry();
    notify(CONFLICT_TOAST, "info");
  }, [tests.retry, results.retry, defaults.retry, notify]);

  /* ----- 生成测试：报价 → （超阈值）人工复核 → 确认 → 创建 → 轮询 → 挂载 ----- */

  /** 确认卡结算：confirm 冻结报价并创建唯一任务；重复确认由服务端幂等保护。 */
  async function settleTestQuote(pending: PendingTestQuote): Promise<GenerationTask> {
    const confirmed = await api.confirmGenerationQuote(pending.quote.generation_quote_id);
    if (confirmed.status === "consumed") {
      if (confirmed.generation_request_id) {
        notify("这次确认已经提交过，不会重复扣费", "info");
        return api.generation(confirmed.generation_request_id);
      }
      throw new Error("报价已被消费但未返回任务信息，请刷新后核对生成记录");
    }
    return api.createGeneration(pending.input, pending.quote.generation_quote_id);
  }

  function cancelRunPolling(testId: string): void {
    pollCancelRef.current.get(testId)?.();
    pollCancelRef.current.delete(testId);
  }

  /** 任务 succeeded 后：把已持久化产物挂为测试结果（attach 只关联，不重新调用供应商）。 */
  async function attachRunResult(test: ReferenceTest, task: GenerationTask): Promise<void> {
    const media = task.media_results?.[0];
    if (!media?.id) {
      trackRun(test.id, {
        phase: "failed",
        requestId: task.generation_request_id,
        error: "任务已完成，但响应未携带已持久化产物，无法挂为测试结果。请稍后到生成记录核对。",
      });
      return;
    }
    trackRun(test.id, { phase: "attaching", requestId: task.generation_request_id });
    try {
      await api.attachReferenceTestResult(projectId, test.id, {
        generation_request_id: task.generation_request_id,
        media_result_id: media.id,
      });
      trackRun(test.id, null);
      notify(`「${test.name}」测试批次已生成，结果已挂入结果区`, "success");
      results.retry();
    } catch (reason) {
      trackRun(test.id, {
        phase: "failed",
        requestId: task.generation_request_id,
        error: `产物已生成，但挂载测试结果失败：${businessErrorMessage(reason)}`,
      });
    }
  }

  /** 轮询任务到终态；3s 一次，约 5 分钟停止等待；组件卸载时统一清理。 */
  function startRunPolling(test: ReferenceTest, requestId: string): void {
    cancelRunPolling(test.id);
    let active = true;
    let attempts = 0;
    let failures = 0;
    const finish = (): void => {
      active = false;
      window.clearInterval(timer);
      pollCancelRef.current.delete(test.id);
    };
    const timer = window.setInterval(() => {
      if (!active) return;
      attempts += 1;
      void api.generation(requestId).then((task) => {
        if (!active) return;
        failures = 0;
        if (task.status === "succeeded") {
          finish();
          void attachRunResult(test, task);
          return;
        }
        if (task.status === "failed") {
          finish();
          /* 多模型接缝(FABLE-007):失败原因只读脱敏 display_reason,error-copy 双保险兜底 */
          const message = businessErrorMessage(task.display_reason, "服务没有返回具体原因，请稍后重试");
          trackRun(test.id, { phase: "failed", requestId, error: message });
          notify(`「${test.name}」测试${mediaKindNoun(test.mediaKind)}生成失败：${message}`, "error");
          return;
        }
        if (attempts >= RUN_MAX_POLLS) {
          finish();
          trackRun(test.id, {
            phase: "failed",
            requestId,
            error: "等待约 5 分钟仍未完成，任务仍在服务端执行，可稍后刷新结果区查看。",
          });
          return;
        }
        trackRun(test.id, { phase: "polling", requestId });
      }).catch(() => {
        if (!active) return;
        failures += 1;
        if (failures >= RUN_POLL_MAX_FAILURES) {
          finish();
          trackRun(test.id, {
            phase: "failed",
            requestId,
            error: "连续多次查询任务状态失败，可能已断网。任务仍在服务端执行，网络恢复后可刷新查看。",
          });
        }
      });
    }, RUN_POLL_INTERVAL_MS);
    pollCancelRef.current.set(test.id, () => {
      active = false;
      window.clearInterval(timer);
    });
    trackRun(test.id, { phase: "polling", requestId });
  }

  /**
   * 一次人工点击 → 一个任务：后台自动完成报价与提交；
   * 只有服务端标记 requires_manual_review 时才弹费用复核（PRD 8.7）。
   */
  async function runTestGeneration(test: ReferenceTest): Promise<void> {
    if (demoMode) {
      notify(DEMO_WRITE_TOAST, "info");
      return;
    }
    const running = runStates[test.id];
    if ((running && running.phase !== "failed") || pendingQuote) return;
    if (!test.prompt.trim()) {
      notify(`「${test.name}」还没有提示词，请先编辑补充再生成`, "error");
      return;
    }
    const submitTier = tierMap[test.mediaKind];
    if (!submitTier) {
      const tierError = tierErrors[test.mediaKind];
      notify(tierError ? `生成档位读取失败：${tierError}` : "生成档位未加载，请稍后重试", "error");
      if (tierError) setTierRevision((value) => value + 1);
      return;
    }
    trackRun(test.id, { phase: "quoting" });
    const input = buildTestGenerationInput(test, projectId, newId(), submitTier);
    try {
      const quote = await api.quoteGeneration(input);
      const pending: PendingTestQuote = {
        quote,
        test,
        input,
        status: quoteIsExpired(quote) ? "expired" : "ready",
      };
      if (quote.requires_manual_review === true) {
        // 交给费用复核弹窗：按钮释放，后续确认才提交付费任务。
        trackRun(test.id, null);
        setPendingQuote(pending);
        return;
      }
      trackRun(test.id, { phase: "submitting" });
      const task = await settleTestQuote(pending);
      trackRun(test.id, null);
      notify(`「${test.name}」测试${mediaKindNoun(test.mediaKind)}任务已提交`, "success");
      startRunPolling(test, task.generation_request_id);
    } catch (reason) {
      trackRun(test.id, { phase: "failed", error: businessErrorMessage(reason, "生成提交失败，请稍后重试") });
    }
  }

  /** 复核弹窗确认：沿用冻结报价链，过期则要求重新获取。 */
  async function confirmPendingQuote(): Promise<void> {
    const pending = pendingQuote;
    if (!pending || ["confirming", "submitting"].includes(pending.status)) return;
    if (quoteIsExpired(pending.quote)) {
      setPendingQuote({ ...pending, status: "expired", error: "费用确认已过期，请重新获取。" });
      return;
    }
    setPendingQuote({ ...pending, status: "submitting", error: "" });
    try {
      const task = await settleTestQuote(pending);
      setPendingQuote(null);
      notify(`「${pending.test.name}」测试${mediaKindNoun(pending.test.mediaKind)}任务已提交`, "success");
      startRunPolling(pending.test, task.generation_request_id);
    } catch (reason) {
      const message = businessErrorMessage(reason, "确认费用失败，请稍后重试");
      const expired = reason instanceof ApiClientError
        && ["GENERATION_QUOTE_EXPIRED", "quote_stale", "GENERATION_QUOTE_CONFLICT"].includes(reason.code);
      setPendingQuote((current) => current?.quote.generation_quote_id === pending.quote.generation_quote_id
        ? { ...current, status: expired ? "expired" : "failed", error: message }
        : current);
    }
  }

  async function refreshPendingQuote(): Promise<void> {
    const pending = pendingQuote;
    if (!pending || ["confirming", "submitting"].includes(pending.status)) return;
    setPendingQuote({ ...pending, status: "confirming", error: "" });
    try {
      const quote = await api.quoteGeneration(pending.input);
      setPendingQuote({ ...pending, quote, status: quoteIsExpired(quote) ? "expired" : "ready", error: "" });
    } catch (reason) {
      setPendingQuote({ ...pending, status: "failed", error: businessErrorMessage(reason, "重新获取报价失败，请稍后重试") });
    }
  }

  /* ----- 测试增删改（乐观锁） ----- */

  async function submitEditor(draft: ReferenceTestInput): Promise<void> {
    if (demoMode) {
      notify(DEMO_WRITE_TOAST, "info");
      return;
    }
    if (!editor) return;
    setEditorBusy(true);
    try {
      if (editor.kind === "create") {
        await api.createReferenceTest(projectId, draft);
        notify(`已新建${mediaKindNoun(draft.mediaKind)}测试「${draft.name}」`, "success");
      } else {
        await api.updateReferenceTest(projectId, editor.test.id, draft, editor.test.version);
        notify(`「${draft.name}」已保存`, "success");
      }
      setEditor(null);
      tests.retry();
    } catch (reason) {
      if (isConflictError(reason)) {
        setEditor(null);
        reloadAfterConflict();
      } else {
        notify(humanErrorMessage(reason, "保存失败，请稍后重试"), "error");
      }
    } finally {
      setEditorBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    const test = deleting;
    if (!test) return;
    if (demoMode) {
      notify(DEMO_WRITE_TOAST, "info");
      return;
    }
    setDeleteBusy(true);
    try {
      await api.deleteReferenceTest(projectId, test.id, test.version);
      notify(`已删除测试「${test.name}」`, "success");
      setDeleting(null);
      if (selectedTestId === test.id) {
        setSelectedTestId(null);
        setSelectedTestName("");
      }
      tests.retry();
      results.retry();
    } catch (reason) {
      if (isConflictError(reason)) {
        setDeleting(null);
        reloadAfterConflict();
      } else {
        notify(humanErrorMessage(reason, "删除失败，请稍后重试"), "error");
      }
    } finally {
      setDeleteBusy(false);
    }
  }

  /* ----- 设为默认（乐观锁版本来自生成默认策略，不是测试的） ----- */

  async function setResultDefault(result: ProjectReferenceTestResult): Promise<void> {
    if (demoMode) {
      notify(DEMO_WRITE_TOAST, "info");
      return;
    }
    if (settingDefaultId) return;
    setSettingDefaultId(result.id);
    try {
      // 实时重取策略，拿到最新 version 再回传，降低 409 概率。
      const strategies = (await api.generationDefaults(projectId)).items;
      const expectedVersion = defaultStrategyVersion(strategies, result.mediaKind);
      const strategy = await api.setReferenceTestResultDefault(projectId, result.referenceTestId, result.id, expectedVersion);
      defaults.setData((current) => {
        const base = current?.items ?? strategies;
        const items = base.filter((item) => item.media_kind !== strategy.media_kind);
        return { items: [...items, strategy], count: items.length + 1 };
      });
      notify(`已把该批次设为${mediaKindNoun(result.mediaKind)}默认策略，后续生产默认沿用`, "success");
    } catch (reason) {
      if (isConflictError(reason)) reloadAfterConflict();
      else notify(humanErrorMessage(reason, "设为默认失败，请稍后重试"), "error");
    } finally {
      setSettingDefaultId("");
    }
  }

  /* ----- 渲染 ----- */

  const strategies = defaults.data?.items ?? [];
  // 名称优先取列表里的最新值，分页未加载到时用点击时的快照。
  const selectedLabel = selectedTestId
    ? tests.items.find((test) => test.id === selectedTestId)?.name ?? selectedTestName
    : "";

  function selectTest(test: ReferenceTest | null): void {
    setSelectedTestId(test?.id ?? null);
    setSelectedTestName(test?.name ?? "");
  }

  return (
    <section className="mx-auto flex w-full max-w-[1200px] flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-page-title text-ink-1">参考测试</h1>
          <p className="text-sm text-ink-2">小成本试模式×模型，满意后设为默认策略；量产不再反复选参。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" icon={<Plus />} onClick={() => setEditor({ kind: "create", mediaKind: "image" })}>新增图片测试</Button>
          <Button variant="primary" icon={<Plus />} onClick={() => setEditor({ kind: "create", mediaKind: "video" })}>新增视频测试</Button>
        </div>
      </header>

      {/* 档位与估价预览行：数据源=capability-tiers 接口（合同 §4）;
          估价=简单估价（simpleEstimate,无项目上下文,只看价不创建报价）。
          裁决 4：档位读取失败如实显示+重试,不回落本地档。 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2">
        {(["image", "video"] as const).map((kind) => {
          const tier = tierMap[kind];
          const estimate = estimateMap[kind];
          const estimateText = demoMode
            ? formatCost(demoTierEstimateFen(kind))
            : estimate ? formatCost(estimate.estimated_cost_fen) : "—";
          return (
            <span key={kind}>{mediaKindNoun(kind)}档位 <span className="font-mono text-ink-1">{tier ? tierLabel(tier) : tierErrors[kind] ? "读取失败" : "读取中…"}</span>
              {tier ? <span className="text-ink-4" title="简单估价（无项目上下文），只看价不创建任务"> · 预计 {estimateText}/次</span> : null}
            </span>
          );
        })}
        {/* S46-A：档错误态收敛到「AI 能力状态」条（按媒型各一条,角色感知）;
            重试同时重拉本页提交档（onRetry）与状态条三维。 */}
        {(["image", "video"] as const).map((kind) => (tierErrors[kind] ? (
          <CapabilityStatusBar
            key={kind}
            className="w-full"
            kind={kind}
            role={platformRoleForCopy(capabilities)}
            demoMode={demoMode}
            onRetry={() => setTierRevision((value) => value + 1)}
          />
        ) : null))}
      </div>

      {/* ---------- 测试列表 ---------- */}
      <section className="flex flex-col gap-3" aria-label="测试列表">
        {tests.loading ? (
          <LoadingState label="正在读取参考测试" onRetry={tests.retry} />
        ) : tests.error ? (
          <ErrorState message={tests.error} onRetry={tests.retry} />
        ) : tests.items.length === 0 ? (
          <Card>
            <EmptyState
              title="还没有参考测试"
              description="先建一个小成本测试，对比模式与模型的效果，满意后把批次设为默认策略。"
              icon={<Flask />}
              action={<div className="flex gap-2"><Button variant="primary" icon={<Plus />} onClick={() => setEditor({ kind: "create", mediaKind: "image" })}>新增图片测试</Button><Button variant="primary" icon={<Plus />} onClick={() => setEditor({ kind: "create", mediaKind: "video" })}>新增视频测试</Button></div>}
            />
          </Card>
        ) : (
          <>
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
              {tests.items.map((test) => {
                const modeCopy = referenceTestModeCopy(test.mode);
                const run = runStates[test.id];
                const runBusy = Boolean(run && run.phase !== "failed") || pendingQuote?.test.id === test.id;
                const filtered = selectedTestId === test.id;
                return (
                  <Card key={test.id} className={cn("flex flex-col gap-3 px-4 py-3", filtered && "border-accent")}>
                    <div className="flex items-start justify-between gap-2">
                      <strong className="text-sm font-semibold text-ink-1">{test.name}</strong>
                      <Badge tone={test.mediaKind === "image" ? "accent" : "warning"} className="shrink-0">{mediaKindNoun(test.mediaKind)}</Badge>
                    </div>
                    <p className="text-xs text-ink-2">{modeCopy.name}</p>
                    <dl className="m-0 flex flex-wrap gap-x-4 gap-y-2 text-xs">
                      <div className="flex gap-1"><dt className="text-ink-4">模型</dt><dd className="m-0 text-ink-1">{modelKeyLabel(test.modelKey)}</dd></div>
                      <div className="flex gap-1"><dt className="text-ink-4">参考素材</dt><dd className="m-0 text-ink-1">{test.referenceMediaIds.length} 项</dd></div>
                      <div className="flex gap-1"><dt className="text-ink-4">更新</dt><dd className="m-0 text-ink-1">{formatDateTime(test.updatedAt)}</dd></div>
                    </dl>
                    {run && run.phase !== "failed" ? (
                      <p className="flex items-center gap-1 text-xs text-accent-text" role="status"><SpinnerGap className="size-3.5 animate-spin" aria-hidden="true" />{runPhaseLabel(run.phase)}</p>
                    ) : null}
                    {run?.phase === "failed" && run.error ? (
                      <p className="flex items-start gap-1 text-xs text-danger" role="alert"><WarningCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />{run.error}</p>
                    ) : null}
                    <footer className="mt-auto flex flex-wrap items-center gap-2">
                      <Button
                        variant="primary"
                        icon={test.mediaKind === "image" ? <ImageSquare /> : <VideoCamera />}
                        loading={Boolean(run && run.phase !== "failed")}
                        disabled={runBusy}
                        title="付费动作：一次点击只创建一个任务"
                        onClick={() => void runTestGeneration(test)}
                      >{runButtonLabel(test.mediaKind)}</Button>
                      <Button
                        icon={<FilmStrip />}
                        variant={filtered ? "accent" : "secondary"}
                        onClick={() => selectTest(filtered ? null : test)}
                      >{filtered ? "查看全部" : "结果"}</Button>
                      <Button size="icon" variant="ghost" icon={<PencilSimple />} aria-label="编辑测试" title="编辑测试" onClick={() => setEditor({ kind: "edit", test })} />
                      <Button size="icon" variant="ghost" icon={<Trash />} aria-label="删除测试" title="删除测试" onClick={() => setDeleting(test)} />
                    </footer>
                  </Card>
                );
              })}
            </div>
            {tests.hasNext ? (
              <div className="flex justify-center pt-2">
                <Button icon={<ArrowClockwise />} loading={tests.loadingMore} onClick={tests.loadMore}>加载更多测试</Button>
              </div>
            ) : null}
            {tests.loadMoreError ? <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{tests.loadMoreError}</p> : null}
          </>
        )}
      </section>

      {/* ---------- 结果区：全部测试批次 / 单测试批次 ---------- */}
      <section className="flex flex-col gap-3" aria-label="测试批次结果">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-ink-1 text-section-title">{selectedTestId ? `「${selectedLabel}」的测试批次` : "全部测试批次"}</h2>
            <p className="text-xs text-ink-2">满意批次「设为默认」后，后续生产默认沿用其模式、模型与参数。</p>
          </div>
          {selectedTestId ? <Button icon={<ArrowClockwise />} onClick={() => selectTest(null)}>返回全部批次</Button> : null}
        </header>
        {defaults.error ? (
          <p className="flex items-center gap-1 rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2" role="alert">
            <Info className="size-3.5 shrink-0" aria-hidden="true" />默认策略读取失败，「当前默认」标记暂不可用。{demoMode ? "" : <button type="button" className="text-accent-text underline underline-offset-4" onClick={defaults.retry}>重试</button>}
          </p>
        ) : null}
        {results.loading ? (
          <LoadingState label="正在读取测试批次" onRetry={results.retry} />
        ) : results.error ? (
          <ErrorState message={results.error} onRetry={results.retry} />
        ) : results.items.length === 0 ? (
          <Card>
            <EmptyState
              title={selectedTestId ? "该测试还没有批次" : "还没有测试批次"}
              description="点测试卡上的「生成测试图片 / 生成测试视频」，跑出的产物会自动挂到这里。"
              icon={<Flask />}
            />
          </Card>
        ) : (
          <>
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
              {results.items.map((result, index) => {
                const isDefault = !defaults.error && resultIsCurrentDefault(strategies, result);
                return (
                  <Card key={result.id} className={cn("flex flex-col overflow-hidden", isDefault && "border-accent")}>
                    <ResultThumb result={result} />
                    <div className="flex flex-col gap-2 px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-ink-2">{formatResultOrdinal(index + 1)}</span>
                        <Badge tone={result.mediaKind === "image" ? "accent" : "warning"}>{mediaKindNoun(result.mediaKind)}</Badge>
                        {isDefault ? <Badge tone="accent">当前默认</Badge> : null}
                      </div>
                      <p className="truncate text-sm font-semibold text-ink-1" title={result.referenceTestName}>{result.referenceTestName}</p>
                      <p className="text-xs text-ink-2">{referenceTestModeCopy(result.mode).name} · 模型：{modelKeyLabel(result.modelKey)}</p>
                      <p className="text-xs text-ink-4">{isDefault ? "后续生产默认沿用该批次配置" : "选中后作为后续生产默认"}</p>
                      <footer className="mt-1 flex flex-wrap items-center gap-2">
                        {isDefault ? (
                          <Button icon={<CheckCircle />} disabled>当前默认</Button>
                        ) : (
                          <Button
                            variant="primary"
                            icon={<CheckCircle />}
                            loading={settingDefaultId === result.id}
                            disabled={Boolean(settingDefaultId)}
                            onClick={() => void setResultDefault(result)}
                          >设为默认</Button>
                        )}
                        <Button icon={<Eye />} onClick={() => setDetailResult(result)}>查看详情</Button>
                      </footer>
                    </div>
                  </Card>
                );
              })}
            </div>
            {results.hasNext ? (
              <div className="flex justify-center pt-2">
                <Button icon={<ArrowClockwise />} loading={results.loadingMore} onClick={results.loadMore}>加载更多批次</Button>
              </div>
            ) : null}
            {results.loadMoreError ? <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{results.loadMoreError}</p> : null}
          </>
        )}
      </section>

      {/* ---------- 弹窗层 ---------- */}
      {editor ? (
        <TestEditorModal
          editor={editor}
          busy={editorBusy}
          assets={assets.data?.items ?? []}
          assetsLoading={assets.loading}
          onSubmit={(draft) => void submitEditor(draft)}
          onClose={() => !editorBusy && setEditor(null)}
        />
      ) : null}
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && !deleteBusy) setDeleting(null); }}>
        <DialogContent size="small">
          <DialogHeader>
            <DialogTitle>删除测试</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {deleting ? (
              <div className="flex flex-col gap-1">
                <p className="text-sm text-ink-1">确定删除测试「{deleting.name}」吗？删除后该测试从列表移除，不能再编辑或运行。</p>
                <p className="text-xs text-ink-2">已挂到结果区的测试批次仍会保留记录。</p>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button disabled={deleteBusy} onClick={() => setDeleting(null)}>取消</Button>
            <Button variant="danger" icon={<Trash />} loading={deleteBusy} onClick={() => void confirmDelete()}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {pendingQuote ? (
        <TestQuoteModal
          pending={pendingQuote}
          tierLabelText={tierMap[pendingQuote.test.mediaKind] ? tierLabel(tierMap[pendingQuote.test.mediaKind]!) : ""}
          onClose={() => {
            if (!["confirming", "submitting"].includes(pendingQuote.status)) setPendingQuote(null);
          }}
          onConfirm={() => void confirmPendingQuote()}
          onRefresh={() => void refreshPendingQuote()}
        />
      ) : null}
      {detailResult ? <ResultDetailModal result={detailResult} onClose={() => setDetailResult(null)} /> : null}
    </section>
  );
}

/* ---------- 结果卡缩略 ---------- */

function ResultThumb({ result }: { result: ProjectReferenceTestResult }): React.JSX.Element {
  const url = result.mediaResult?.storageUrl ?? "";
  if (url && result.mediaKind === "video") {
    return <div className="flex aspect-video items-center justify-center overflow-hidden bg-surface-well"><video preload="metadata" src={url} className="h-full w-full object-cover" /></div>;
  }
  if (url) {
    return <div className="flex aspect-video items-center justify-center overflow-hidden bg-surface-well"><img src={url} alt={`${result.referenceTestName} 批次产物`} loading="lazy" className="h-full w-full object-cover" /></div>;
  }
  const Icon = result.mediaKind === "image" ? ImageSquare : VideoCamera;
  return (
    <div className="flex aspect-video flex-col items-center justify-center gap-1 overflow-hidden bg-surface-well/60 text-xs text-ink-4">
      <Icon aria-hidden="true" className="size-6 opacity-50" />
      <span>{result.mediaResult ? "预览不可用（离线演示不生成真实产物）" : "产物未回传预览"}</span>
    </div>
  );
}

/* ---------- 新建 / 编辑弹窗 ---------- */

/** demo 估价预览：初始档 fixture 档价 × 时长/张数（1 积分 = 1 分,恒等读取）。 */
function demoTierEstimateFen(kind: ReferenceTestMediaKind): number {
  const tier = kind === "image" ? FALLBACK_IMAGE_TIER : FALLBACK_VIDEO_TIER;
  const units = tier.price.unit === "per_second"
    ? (typeof tier.params.duration_seconds === "number" ? tier.params.duration_seconds : 1)
    : (typeof tier.params.quantity === "number" ? tier.params.quantity : 1);
  return tier.price.points * units;
}

interface TestDraft {
  name: string;
  mediaKind: ReferenceTestMediaKind;
  mode: ReferenceTestMode;
  modelKey: string;
  prompt: string;
  referenceMediaIds: string[];
}

function draftFromEditor(editor: Exclude<EditorState, null>): TestDraft {
  if (editor.kind === "edit") {
    const test = editor.test;
    return {
      name: test.name,
      mediaKind: test.mediaKind,
      mode: test.mode,
      modelKey: test.modelKey,
      prompt: test.prompt,
      referenceMediaIds: [...test.referenceMediaIds],
    };
  }
  return {
    name: "",
    mediaKind: editor.mediaKind,
    mode: "direct_reference",
    modelKey: "configured",
    prompt: "",
    referenceMediaIds: [],
  };
}

function TestEditorModal({ editor, busy, assets, assetsLoading, onSubmit, onClose }: {
  editor: Exclude<EditorState, null>;
  busy: boolean;
  assets: ProjectAssetRef[];
  assetsLoading: boolean;
  onSubmit: (draft: ReferenceTestInput) => void;
  onClose: () => void;
}): React.JSX.Element {
  const editing = editor.kind === "edit" ? editor.test : null;
  const [draft, setDraft] = useState<TestDraft>(() => draftFromEditor(editor));
  const [error, setError] = useState("");

  /** 参考素材选择器：读项目资产，3D（glb/model_3d）等不可作生成参考的由 refIsImageReference 滤掉。 */
  const referenceOptions = assets
    .filter(refIsImageReference)
    .map((ref) => {
      const mediaId = ref.asset_media_id ?? ref.version_snapshot?.media?.id ?? null;
      if (!mediaId) return null;
      const asset = ref.asset ?? ref.snapshot ?? ref.version_snapshot?.entity ?? null;
      const name = asset?.display_name || asset?.name || "未命名资产";
      const url = asset?.thumbnail_url || asset?.storage_url || asset?.source_file_url || "";
      return { mediaId, name, url };
    })
    .filter((item): item is { mediaId: string; name: string; url: string } => Boolean(item));
  const models = draft.mediaKind === "image" ? REFERENCE_TEST_IMAGE_MODEL_CARDS : REFERENCE_TEST_VIDEO_MODEL_CARDS;
  const atReferenceLimit = draft.referenceMediaIds.length >= REFERENCE_MEDIA_LIMIT;

  function toggleReference(mediaId: string): void {
    setDraft((current) => {
      if (current.referenceMediaIds.includes(mediaId)) {
        return { ...current, referenceMediaIds: current.referenceMediaIds.filter((id) => id !== mediaId) };
      }
      if (current.referenceMediaIds.length >= REFERENCE_MEDIA_LIMIT) return current;
      return { ...current, referenceMediaIds: [...current.referenceMediaIds, mediaId] };
    });
  }

  function submit(): void {
    const name = draft.name.trim();
    if (!name) {
      setError("请先填写测试名称");
      return;
    }
    setError("");
    onSubmit({
      name,
      mediaKind: draft.mediaKind,
      mode: draft.mode,
      modelKey: draft.modelKey,
      prompt: draft.prompt.trim(),
      parameters: editing?.parameters ? { ...editing.parameters } : {},
      referenceMediaIds: [...draft.referenceMediaIds],
    });
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="large">
        <DialogHeader>
          <DialogTitle>{editing ? `编辑测试「${editing.name}」` : `新增${mediaKindNoun(draft.mediaKind)}测试`}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <Field label="名称 *">
            <Input
              value={draft.name}
              disabled={busy}
              placeholder="例如：夜戏雨巷·定妆直出"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-2">生成目标</span>
            {/* 四-1（S10）：入口「新增图片测试/新增视频测试」已承诺 mediaKind,类型即锁定——
                不可改选,显示为说明行（动作名承诺了对象类型的,类型即锁定）。 */}
            <p className="self-start rounded-md border border-border-1 bg-surface-2 px-3 py-1.5 text-sm text-ink-1">
              {mediaKindGoal(draft.mediaKind)}
              <span className="ml-2 text-xs text-ink-4">类型随入口锁定，不可改选</span>
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-2">模式</span>
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]" role="radiogroup" aria-label="生成模式">
              {(Object.keys(REFERENCE_TEST_MODE_CARDS) as ReferenceTestMode[]).map((mode) => {
                const copy = referenceTestModeCopy(mode);
                const selected = draft.mode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={cn(
                      "flex flex-col gap-1 rounded-md border p-3 text-left transition-colors",
                      selected ? "border-accent bg-accent-subtle ring-1 ring-accent/60" : "border-border-1 bg-surface-2 hover:border-border-2",
                    )}
                    disabled={busy}
                    onClick={() => setDraft({ ...draft, mode })}
                  >
                    <strong className={cn("text-xs font-semibold", selected && "text-accent-text")}>{copy.name}</strong>
                    <span className="text-[11px] leading-relaxed text-ink-2">{copy.summary}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-2">模型</span>
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
              {models.map((model) => (
                <button
                  key={model.key}
                  type="button"
                  className={cn(
                    "flex flex-col gap-1 rounded-md border border-border-1 bg-surface-2 p-3 text-left transition-colors",
                    model.available ? "hover:border-border-2" : "cursor-not-allowed opacity-75",
                    draft.modelKey === model.key && "border-accent bg-accent-subtle",
                  )}
                  aria-pressed={draft.modelKey === model.key}
                  data-availability={model.available ? "configured" : "unconfigured"}
                  disabled={!model.available || busy}
                  title={model.available ? undefined : `${model.name}：${model.note}，暂不可提交`}
                  onClick={() => model.available && setDraft({ ...draft, modelKey: model.key })}
                >
                  <strong className={cn("text-xs font-semibold", draft.modelKey === model.key ? "text-accent-text" : !model.available && "text-ink-3")}>{model.name}</strong>
                  <span className="text-[11px] text-ink-2">{model.note}</span>
                </button>
              ))}
            </div>
          </div>
          <Field label="提示词（可手写）">
            <Textarea
              value={draft.prompt}
              disabled={busy}
              rows={4}
              placeholder={draft.mediaKind === "image" ? "描述画面、风格与一致性要求…" : "填写镜头运动、人物动作和环境变化…"}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-2">参考素材（{draft.referenceMediaIds.length} / {REFERENCE_MEDIA_LIMIT} 已选 · 仅图片类可选）</span>
            {assetsLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : referenceOptions.length === 0 ? (
              <p className="rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2">项目还没有可用参考图，可以先到项目资产引入；3D 素模等不可作生成参考的素材不会出现在这里。</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {referenceOptions.map((item) => {
                  const selected = draft.referenceMediaIds.includes(item.mediaId);
                  const disabled = busy || (!selected && atReferenceLimit);
                  return (
                    <button
                      key={item.mediaId}
                      type="button"
                      className={cn(
                        "relative size-[72px] overflow-hidden rounded-md border bg-surface-well transition-opacity",
                        selected ? "border-accent" : "border-border-1 opacity-60 hover:opacity-90",
                        disabled && "cursor-not-allowed",
                      )}
                      aria-pressed={selected}
                      disabled={disabled}
                      title={selected ? `${item.name} · 点击取消` : disabled ? `${item.name} · 最多选 ${REFERENCE_MEDIA_LIMIT} 项` : `${item.name} · 点击选用`}
                      onClick={() => toggleReference(item.mediaId)}
                    >
                      {item.url ? <img src={item.url} alt={item.name} className="h-full w-full object-cover" /> : <span className="flex h-full w-full items-center justify-center p-1 text-center text-[11px] text-ink-2">{item.name}</span>}
                      {selected ? <span className="absolute bottom-0.5 right-0.5 flex rounded-full bg-surface-well/60 text-accent"><CheckCircle className="size-4" aria-hidden="true" /></span> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <p className="rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2">保存后，生成工作台默认使用所选模式与模型（把该测试的满意批次「设为默认」后生效）。</p>
          {error ? <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</div> : null}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" icon={<CheckCircle />} loading={busy} onClick={submit}>{editing ? "保存修改" : "保存测试"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- 费用复核弹窗（超阈值才出现） ---------- */

function TestQuoteModal({ pending, tierLabelText, onClose, onConfirm, onRefresh }: {
  pending: PendingTestQuote;
  /** 提交链当前选中档标签（含档价）；为空时回落读报价里的 tier_id。 */
  tierLabelText: string;
  onClose: () => void;
  onConfirm: () => void;
  onRefresh: () => void;
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const expired = pending.status === "expired" || quoteIsExpired(pending.quote, now);
  const busy = pending.status === "confirming" || pending.status === "submitting";
  const mediaLabel = pending.test.mediaKind === "image" ? "1 张测试图片" : "1 段测试视频";
  const actionLabel = expired
    ? "重新获取费用"
    : pending.status === "failed"
      ? "再次提交"
      : "确认费用并生成";
  /* 确认卡显示档位与价格（合同 §4）：档位标签（含档价）或报价透传的 tier_id。
     多模型接缝:price_snapshot 不再带真实 model,显示只读 tier_id/档标签。 */
  const tierText = tierLabelText
    || (pending.quote.tier_id ?? "");
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="small">
        <DialogHeader>
          <DialogTitle>本次费用超出复核阈值</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-md border border-border-1 bg-surface-0 px-3 py-2">
            {pending.test.mediaKind === "image" ? <ImageSquare className="size-5 text-accent-text" aria-hidden="true" /> : <VideoCamera className="size-5 text-accent-text" aria-hidden="true" />}
            <div className="flex flex-col">
              <span className="text-xs text-ink-4">本次将生成</span>
              <strong className="text-sm text-ink-1">{mediaLabel}</strong>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-border-1 bg-surface-0 px-3 py-2">
            <CurrencyCny className="size-5 text-accent-text" aria-hidden="true" />
            <div className="flex flex-col">
              <span className="text-xs text-ink-4">预估费用</span>
              <strong className="font-mono text-sm text-ink-1">{formatCost(pending.quote.estimated_cost_fen)}</strong>
            </div>
          </div>
          <dl className="m-0 flex flex-col gap-2 rounded-md border border-border-1 bg-surface-0 px-3 py-2 text-xs">
            {tierText ? (
              <div className="flex items-baseline justify-between gap-3"><dt className="shrink-0 text-ink-4">档位</dt><dd className="m-0 text-right font-mono text-ink-1">{tierText}</dd></div>
            ) : null}
            {typeof pending.quote.price_snapshot?.unit_price_fen === "number" ? (
              <div className="flex items-baseline justify-between gap-3"><dt className="shrink-0 text-ink-4">单价明细</dt><dd className="m-0 text-right text-ink-1">{formatCost(pending.quote.price_snapshot.unit_price_fen)} / {billingUnitLabel(pending.quote.price_snapshot.billing_unit)} × {pending.quote.price_snapshot.billable_units ?? 1}</dd></div>
            ) : null}
            <div className="flex items-baseline justify-between gap-3"><dt className="shrink-0 text-ink-4">有效时间</dt><dd className="m-0 text-right text-ink-1">{formatQuoteExpiry(pending.quote.expires_at)}</dd></div>
            <div className="flex items-baseline justify-between gap-3"><dt className="shrink-0 text-ink-4">报价状态</dt><dd className="m-0 text-right text-ink-1">{expired ? "已过期" : pending.status === "failed" ? "提交失败" : busy ? "正在处理" : "等待确认"}</dd></div>
          </dl>
          <p className="text-xs leading-relaxed text-ink-2">
            {pending.quote.notice || "这是预估费用，不是云平台实际账单。"}
            后台自动报价，超阈值再追加一次费用复核；确认后才会提交付费任务。
          </p>
          {pending.error ? <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{pending.error}</div> : null}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" icon={expired ? <Clock /> : <CheckCircle />} loading={busy} onClick={expired ? onRefresh : onConfirm}>{actionLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 计费单位展示（与 workbench-page.tsx 的 billingUnitLabel 同口径;音频万字符不丢）。 */
function billingUnitLabel(unit?: "request" | "image" | "second" | "ten_thousand_characters"): string {
  if (unit === "image") return "张";
  if (unit === "second") return "秒";
  if (unit === "ten_thousand_characters") return "万字符";
  return "次";
}

/* ---------- 结果详情弹窗 ---------- */

function ResultDetailModal({ result, onClose }: { result: ProjectReferenceTestResult; onClose: () => void }): React.JSX.Element {
  const media = result.mediaResult;
  const url = media?.storageUrl ?? "";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="medium">
        <DialogHeader>
          <DialogTitle>{`批次详情 · ${result.referenceTestName}`}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-md bg-surface-well">
            {url && result.mediaKind === "video" ? <video controls preload="metadata" src={url} className="max-h-80 w-full object-contain" /> : null}
            {url && result.mediaKind === "image" ? <img src={url} alt={`${result.referenceTestName} 批次产物`} className="max-h-80 w-full object-contain" /> : null}
            {!url ? (
              <div className="flex flex-col items-center gap-1 p-6 text-xs text-ink-4">
                {result.mediaKind === "image" ? <ImageSquare aria-hidden="true" className="size-8" /> : <VideoCamera aria-hidden="true" className="size-8" />}
                <span>暂无可用预览（产物未回传地址或离线演示）</span>
              </div>
            ) : null}
          </div>
          <dl className="m-0 grid gap-x-4 gap-y-2 text-xs [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
          </dl>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- 分页读取 hook（首页四态 + hasNext 加载更多） ---------- */

interface PagedList<T> {
  items: T[];
  hasNext: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  loadMoreError: string;
  retry: () => void;
  loadMore: () => void;
}

function usePagedList<T>(
  fetchPage: (page: number) => Promise<Page<T>>,
  demoItems: T[],
  demoMode: boolean,
  dependencies: DependencyList,
): PagedList<T> {
  const [items, setItems] = useState<T[]>(demoMode ? demoItems : []);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(!demoMode);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [loadMoreError, setLoadMoreError] = useState("");
  const [revision, setRevision] = useState(0);
  const fetchPageRef = useRef(fetchPage);
  fetchPageRef.current = fetchPage;
  const pageRef = useRef(1);
  const moreInflightRef = useRef(false);

  useEffect(() => {
    let active = true;
    if (demoMode) {
      setItems(demoItems);
      setHasNext(false);
      setLoading(false);
      setError("");
      setLoadMoreError("");
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    setLoadMoreError("");
    fetchPageRef.current(1).then((page) => {
      if (!active) return;
      pageRef.current = 1;
      setItems(page.items);
      setHasNext(page.hasNext);
    }).catch((reason: unknown) => {
      if (active) setError(humanErrorMessage(reason, "读取失败"));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
    // 调用方经 dependencies 控制重载键（projectId / 过滤条件）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, revision, ...dependencies]);

  const retry = useCallback(() => setRevision((value) => value + 1), []);

  const loadMore = useCallback(() => {
    if (demoMode || moreInflightRef.current) return;
    moreInflightRef.current = true;
    setLoadingMore(true);
    setLoadMoreError("");
    const nextPage = pageRef.current + 1;
    fetchPageRef.current(nextPage).then((page) => {
      pageRef.current = nextPage;
      setItems((current) => [...current, ...page.items]);
      setHasNext(page.hasNext);
    }).catch((reason: unknown) => {
      setLoadMoreError(humanErrorMessage(reason, "加载更多失败，请重试"));
    }).finally(() => {
      moreInflightRef.current = false;
      setLoadingMore(false);
    });
  }, [demoMode]);

  return { items, hasNext, loading, loadingMore, error, loadMoreError, retry, loadMore };
}
