/* ============================================================
   settings-page.tsx — 设置页（G 包改版：API 设置去开发化 / 默认生成参数真接口 / 版本预告附录二终稿）
   左侧导航：API 设置 / 默认生成参数 / AI 日志 / 版本预告。
   #151（2026-08-06）：「全局风格」「全局提示词」「提示词管理」三个本机保存面板已删——
   保存下去的内容不进任何一次真实生成（界面曾自述只存不注入），是给用户虚假期望的假控件；
   项目级替代在项目设置抽屉（画面与风格 / 提示词模板页签，docs/design/prd-v2/project.md §四）。
   旧版更新面板已删（Web 产品无此概念）；预告卡只挂在版本预告子页。
   S23：版本计划与预告内容入库（不再写死在本文件）——页面从接口读，
   读不到如实说「暂时加载不出来」并可重试，不回退写死的旧内容；
   类型/纯逻辑/接口归一在 ../release-plan.ts，Pi 面板轮播同源。
   呈现红线：无灰按钮+锁图标、无工作流内推销弹窗、不放空炮；
   未上线功能一律禁用置灰或写清「预计哪个版本、解决什么场景」（业务白话，
   不用片场词）。
   视图层为 Tailwind v4 + components/ui，本文件保持可被测试 import。
   settings.css 现仅保留 app.tsx 轮播条的样式（接线层 import 冻结，
   由该文件头注释说明）。
   注：p1-placeholders.test.ts 对本文件做禁词与呈现红线源码扫描，
   注释勿带禁词字面，也不要出现灰按钮/锁图标相关字样。
   ============================================================ */
import {
  CaretRight,
  FilmSlate,
  Key,
  Scroll,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import { useEffect, useState, type ComponentType } from "react";
import { ApiClientError, api } from "../api";
import { TIER_UNCONFIGURED_CODE, listCapabilityTiers } from "../capability-tiers";
import { workbenchFixedParameters } from "../components/version-modal";
import { demoProjects } from "../demo";
import { modelDisplayLabel, modelRawTitle, providerLabel, providerRawTitle, toolNameLabel, toolNameRawTitle } from "../display-labels";
import { businessErrorMessage } from "../error-copy";
import { isRecord } from "../generation-quotes";
import { navigate } from "../routing";
import {
  RELEASE_CATEGORY_LABEL,
  RELEASE_STATUS_LABEL,
  SETTINGS_INTRO,
  previewCardsOf,
  releaseWindow,
  type ReleaseCard,
  type ReleaseCategory,
  type ReleaseHistoryEntry,
  type ReleaseSection,
  type ReleaseStatus,
} from "../release-plan";
import type { GenerationDefaultMode, GenerationDefaultStrategy, GenerationMediaKind, Project } from "../types";
import { formatDateTime } from "../ui";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import {
  Badge,
  Card,
  EmptyState,
} from "../components/ui/primitives";

/* ---------- 版本预告数据(S23 起入库:类型/纯逻辑/接口归一见 ../release-plan.ts,内容一律接口读) ---------- */

/* ---------- API 设置：四项模型槽位（G1 去开发化：无环境变量名、无「状态未回读」占位） ---------- */

export interface ModelSlot {
  key: "image" | "video" | "llm" | "vector";
  label: string;
  note: string;
}

export const MODEL_SLOTS: ModelSlot[] = [
  { key: "image", label: "图片生成", note: "资产生图与素材主图" },
  { key: "video", label: "视频生成", note: "粗剪素材视频生成" },
  { key: "llm", label: "对话助手", note: "Pi 助手与文本链路" },
  { key: "vector", label: "语义检索", note: "资产语义检索索引" },
];

export const MODEL_SLOTS_SECRET_NOTE = "密钥由服务端管理，前端不展示明文";

/** admin/models 一行的视图形状（camelCase 直传，见 src/modules/admin/models/service.ts）。 */
export interface AdminModelView {
  id: string;
  displayName: string;
  mediaKind: "image" | "video" | "audio";
  configurationStatus: "configured" | "unconfigured";
}

/** 槽位 → 当前模型显示名：只认 configured 的真数据；查不到/非管理员/接口未就位都回落 null（UI 显示「由服务端管理」，不虚构）。 */
export function slotModelName(slot: ModelSlot, models: AdminModelView[] | null): string | null {
  if (!models || (slot.key !== "image" && slot.key !== "video")) return null;
  const configured = models.find((model) => model.mediaKind === slot.key && model.configurationStatus === "configured");
  return configured?.displayName ?? null;
}

/* ---------- S46-A：槽位「档位/开关」维状态行（与能力状态条同数据源,同屏消灭矛盾） ---------- */

export interface SlotDimLine {
  text: string;
  state: "ok" | "missing" | "unknown";
}

export const DIM_LINE_TONE: Record<SlotDimLine["state"], string> = {
  ok: "text-success",
  missing: "text-danger",
  unknown: "text-ink-3",
};

/** 档位读取结果 → 状态行：空表=「未配置」（裁决 4 报 Sol 的口径）,其他错误=「读取失败」,不虚构。 */
export function tierDimLine(result: PromiseSettledResult<{ tiers: readonly unknown[] }>): SlotDimLine {
  if (result.status === "fulfilled") return { text: `档位 已配 ${result.value.tiers.length} 档`, state: "ok" };
  const reason = result.reason;
  if (reason instanceof ApiClientError && reason.code === TIER_UNCONFIGURED_CODE) {
    return { text: "档位 未配置", state: "missing" };
  }
  return { text: "档位 读取失败", state: "unknown" };
}

/* ---------- AI 日志（S10 点亮：项目选择器 + 真分页表格，占位空态已摘） ----------
 * 后端合同：GET /api/v1/projects/:id/ai-audit-logs?page=&page_size= →
 * { items, page, page_size, total, has_more }，entry 含 provider/model/usage/created_at
 * （仓根 src/modules/assistant/routes.ts）。P0 在 api.ts 实现 aiAuditLogs(projectId, {page,page_size})
 * 并归一为 { items, page, pageSize, total, hasMore }（camelCase；usage 原样透传 snake，由页面侧再归一）；
 * 页面侧 mapper snake/camel 双吃，形状微调不黑屏。方法缺失 / 404 / 501 一律如实降级，不虚构数据。 */

/** token 用量（null=后端未回传该项；status=unknown 表示远端明确没给用量）。 */
export interface AiAuditUsage {
  status?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
}

/** 单条留痕的页面规范形（camelCase）。 */
export interface AiAuditLogEntry {
  id: string;
  /** 调用时间（ISO 串；缺失为空串，列显示「—」）。 */
  createdAt: string;
  role: string;
  toolName?: string | null;
  status?: string | null;
  provider?: string | null;
  model?: string | null;
  usage?: AiAuditUsage | null;
}

export interface AiAuditLogPage {
  items: AiAuditLogEntry[];
  total: number;
  hasMore: boolean;
}

export const AI_AUDIT_LOG_PAGE_SIZE = 20;

function auditText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function auditNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function aiAuditUsageFromUnknown(value: unknown): AiAuditUsage | null {
  if (!isRecord(value)) return null;
  return {
    status: auditText(value.status),
    inputTokens: auditNumber(value.input_tokens ?? value.inputTokens),
    outputTokens: auditNumber(value.output_tokens ?? value.outputTokens),
    totalTokens: auditNumber(value.total_tokens ?? value.totalTokens),
  };
}

/** wire → 页面规范形：snake/camel 双吃；缺 id 的脏行丢弃（返回 null）。 */
export function aiAuditEntryFromUnknown(value: unknown): AiAuditLogEntry | null {
  if (!isRecord(value)) return null;
  const id = auditText(value.id);
  if (!id) return null;
  return {
    id,
    createdAt: auditText(value.created_at ?? value.createdAt) ?? "",
    role: auditText(value.role) ?? "",
    toolName: auditText(value.tool_name ?? value.toolName),
    status: auditText(value.status),
    provider: auditText(value.provider),
    model: auditText(value.model),
    usage: aiAuditUsageFromUnknown(value.usage),
  };
}

/** 分页响应归一：缺 total 回 items.length；缺 hasMore 视为没有下一页（不多翻）。 */
export function aiAuditLogPageFromUnknown(value: unknown): AiAuditLogPage {
  const record = isRecord(value) ? value : {};
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items = rawItems
    .map((item) => aiAuditEntryFromUnknown(item))
    .filter((item): item is AiAuditLogEntry => item !== null);
  const total = auditNumber(record.total) ?? items.length;
  return { items, total, hasMore: (record.has_more ?? record.hasMore) === true };
}

/** demo 本地分页（与后端 page/page_size/has_more 同口径）。 */
export function sliceAuditLogPage(items: AiAuditLogEntry[], page: number, pageSize: number = AI_AUDIT_LOG_PAGE_SIZE): AiAuditLogPage {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const start = (safePage - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, hasMore: start + pageSize < items.length };
}

/** 动作列：工具调用显示中文动作名（未知工具不裸显 snake_case，原值进 title）。 */
export function auditActionLabel(entry: Pick<AiAuditLogEntry, "role" | "toolName">): string {
  if (entry.toolName) return `工具 · ${toolNameLabel(entry.toolName)}`;
  if (entry.role === "assistant") return "助手回复";
  if (entry.role === "user") return "用户输入";
  if (!entry.role || /^[\x20-\x7e]+$/.test(entry.role)) return "调用";
  return entry.role;
}

/** 动作列原值悬浮说明：仅未识别工具名给 title，其余不加噪音。 */
export function auditActionTitle(entry: Pick<AiAuditLogEntry, "role" | "toolName">): string | undefined {
  return entry.toolName ? toolNameRawTitle(entry.toolName) : undefined;
}

/** 状态后缀：只给非完成态加注（失败/已中止），完成态不加噪音。 */
export function auditStatusSuffix(status?: string | null): string {
  if (status === "failed") return "（失败）";
  if (status === "aborted") return "（已中止）";
  return "";
}

/** 用量列：未回传如实写，不编数；纯中文口径（tokens 这类英文单位不上屏）。 */
export function auditUsageText(usage: AiAuditUsage | null | undefined): string {
  if (!usage) return "—";
  if (usage.status === "unknown") return "未回传";
  if (usage.inputTokens != null && usage.outputTokens != null) return `输入 ${usage.inputTokens} · 输出 ${usage.outputTokens}`;
  if (usage.totalTokens != null) return `合计用量 ${usage.totalTokens}`;
  if (usage.inputTokens != null) return `输入 ${usage.inputTokens}`;
  if (usage.outputTokens != null) return `输出 ${usage.outputTokens}`;
  return "未回传";
}

/** demo 示例留痕（页面标注「示例数据」；形状=页面规范形，含 provider/model/usage/时间）。 */
export const DEMO_AI_AUDIT_LOGS: AiAuditLogEntry[] = [
  { id: "demo-log-1", createdAt: "2026-07-22T13:58:00.000Z", role: "assistant", toolName: null, status: "completed", provider: "ark", model: "doubao-seed-1.6", usage: { status: "ok", inputTokens: 812, outputTokens: 196, totalTokens: 1008 } },
  { id: "demo-log-2", createdAt: "2026-07-22T13:57:12.000Z", role: "assistant", toolName: "search_assets", status: "completed", provider: "ark", model: "doubao-seed-1.6", usage: { status: "ok", inputTokens: 640, outputTokens: 88, totalTokens: 728 } },
  { id: "demo-log-3", createdAt: "2026-07-22T13:55:40.000Z", role: "user", toolName: null, status: "completed", provider: null, model: null, usage: null },
  { id: "demo-log-4", createdAt: "2026-07-22T13:54:03.000Z", role: "assistant", toolName: "draft_episode_outline", status: "failed", provider: "ark", model: "doubao-seed-1.6", usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null } },
  { id: "demo-log-5", createdAt: "2026-07-22T13:51:26.000Z", role: "assistant", toolName: null, status: "completed", provider: "ark", model: "doubao-seed-1.6", usage: { status: "ok", inputTokens: 1550, outputTokens: 402, totalTokens: 1952 } },
];

/* ---------- 设置导航 ---------- */

export type SettingsSectionKey = "api" | "defaults" | "logs" | "releases";

const SETTINGS_NAV: Array<{ key: SettingsSectionKey; label: string; Icon: ComponentType<{ "aria-hidden"?: boolean | "true"; className?: string }> }> = [
  { key: "api", label: "API 设置", Icon: Key },
  { key: "defaults", label: "默认生成参数", Icon: SlidersHorizontal },
  { key: "logs", label: "AI 日志", Icon: Scroll },
  { key: "releases", label: "版本预告", Icon: FilmSlate },
];

/** ?section= 解析：缺省/未知一律回「默认生成参数」（S30 命令面板深链 `/settings?section=releases` 同源）。
    #151：全局风格/全局提示词/提示词管理三个本机保存面板已退役——
    保存不进任何真实生成，是虚假期望；项目级替代在项目设置抽屉（project.md §四）。 */
export function settingsSectionFromSearch(search: string): SettingsSectionKey {
  const value = new URLSearchParams(search).get("section");
  return SETTINGS_NAV.some((item) => item.key === value) ? (value as SettingsSectionKey) : "defaults";
}

/** 页签深链：默认页签（默认生成参数）省略 section 参数，保持 `/settings` 干净。 */
export function settingsSectionPath(section: SettingsSectionKey): string {
  return section === "defaults" ? "/settings" : `/settings?section=${section}`;
}

/** 顶部公共头描述：按当前页签给对应一句（S9-10）。 */
export const SETTINGS_SECTION_DESCRIPTION: Record<SettingsSectionKey, string> = {
  api: "图片、视频、对话、语义检索四个模型槽位，密钥由服务端管理。这里的自定义内容只存在这台设备的浏览器里。",
  defaults: "按项目保存默认生成方式，工作台生成时按这里执行。",
  logs: "每次 AI 调用的留痕回看。",
  releases: "每个版本解决什么痛点，接下来做什么。",
};

/* ---------- 设置页 ---------- */

export function SettingsPage(): React.JSX.Element {
  const section = settingsSectionFromSearch(window.location.search);

  return (
    <section className="mx-auto flex w-full max-w-[1200px] flex-col gap-5" aria-label="设置">
      <header className="flex flex-col gap-1">
        <h1 className="sr-only">设置</h1>
        <p className="text-sm text-ink-2">{SETTINGS_SECTION_DESCRIPTION[section]}</p>
      </header>
      <div className="grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="flex gap-0.5 overflow-x-auto rounded-lg border border-border-1 bg-surface-1 p-2 lg:sticky lg:top-4 lg:flex-col" aria-label="设置导航">
          {SETTINGS_NAV.map((item) => (
            <button
              type="button"
              key={item.key}
              className={cn(
                "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm text-ink-2 transition-colors hover:text-ink-1",
                section === item.key && "bg-surface-2 text-ink-1",
              )}
              aria-current={section === item.key ? "page" : undefined}
              onClick={() => navigate(settingsSectionPath(item.key))}
            >
              <item.Icon aria-hidden="true" className="size-[18px] shrink-0" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          {section === "api" ? <ApiSettingsPanel /> : null}
          {section === "defaults" ? <GenerationDefaultsPanel /> : null}
          {section === "logs" ? <AiLogPanel /> : null}
          {section === "releases" ? <ReleasesPanel /> : null}
        </div>
      </div>
    </section>
  );
}

/* ---------- 面板：API 设置（G1：槽位卡 + 真模型名 + 状态点，无环境变量名/无占位徽章） ---------- */

/** demo 模式示例模型（形状与 admin/models 一致）。 */
const DEMO_ADMIN_MODELS: AdminModelView[] = [
  { id: "demo-image", displayName: "Seedream 4.5", mediaKind: "image", configurationStatus: "configured" },
  { id: "demo-video", displayName: "Seedance 2.0", mediaKind: "video", configurationStatus: "configured" },
];

function isDemoMode(): boolean {
  try {
    return typeof window !== "undefined" && window.sessionStorage.getItem("shortdrama_v01_demo") === "1";
  } catch {
    return false;
  }
}

function ApiSettingsPanel(): React.JSX.Element {
  const [models, setModels] = useState<AdminModelView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  /* S46-A：槽位补「档位/开关」维状态——模型绿灯与档位红字曾分居两页互相矛盾,
     现在同屏说清（数据源与能力状态条一致：capability-tiers + config-status）。 */
  const [dimLines, setDimLines] = useState<Partial<Record<ModelSlot["key"], SlotDimLine>>>({});

  useEffect(() => {
    if (isDemoMode()) {
      setModels(DEMO_ADMIN_MODELS);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.adminModels()
      .then((items) => {
        if (cancelled) return;
        setModels(items);
        setLoading(false);
      })
      .catch(() => {
        // 非管理员/接口未就位/网络失败：槽位回落「由服务端管理」，不虚构配置状态
        if (!cancelled) {
          setModels(null);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [revision]);

  useEffect(() => {
    if (isDemoMode()) {
      setDimLines({
        image: { text: "档位 已配 1 档", state: "ok" },
        video: { text: "档位 已配 1 档", state: "ok" },
        llm: { text: "AI 辅助开关 已开启", state: "ok" },
      });
      return;
    }
    let cancelled = false;
    void Promise.allSettled([
      listCapabilityTiers("image", false),
      listCapabilityTiers("video", false),
      api.configStatus(),
    ]).then(([image, video, config]) => {
      if (cancelled) return;
      setDimLines({
        image: tierDimLine(image),
        video: tierDimLine(video),
        llm: config.status === "fulfilled"
          ? (config.value.aiGatewayEnabled === true
            ? { text: "AI 辅助开关 已开启", state: "ok" }
            : config.value.aiGatewayEnabled === false
              ? { text: "AI 辅助开关 未开启", state: "missing" }
              : { text: "AI 辅助开关 读取失败", state: "unknown" })
          : { text: "AI 辅助开关 读取失败", state: "unknown" },
      });
    });
    return () => { cancelled = true; };
  }, [revision]);

  return (
    <Card className="flex flex-col gap-3 p-4" aria-label="API 设置">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-ink-1 text-section-title">模型槽位</h2>
        <button
          type="button"
          className="rounded-sm px-1.5 py-0.5 text-xs text-accent-text outline-none transition-colors hover:bg-accent-subtle focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => setRevision((value) => value + 1)}
        >刷新</button>
      </div>
      <p className="text-xs text-ink-2">{MODEL_SLOTS_SECRET_NOTE}。</p>
      <div className="flex flex-col">
        {MODEL_SLOTS.map((slot) => {
          const modelName = slotModelName(slot, models);
          return (
            <div className="flex items-center justify-between gap-3 border-t border-dashed border-border-1 py-3 first:border-t-0 first:pt-0" key={slot.key}>
              <div className="flex min-w-0 flex-col gap-0.5">
                <strong className="text-sm text-ink-1">{slot.label}</strong>
                <span className="text-xs text-ink-2">{loading ? "读取中…" : (modelName ?? "由服务端管理")}</span>
                {dimLines[slot.key] ? (
                  <span className={cn("text-xs", DIM_LINE_TONE[dimLines[slot.key]!.state])}>{dimLines[slot.key]!.text}</span>
                ) : null}
                <span className="text-xs text-ink-4">{slot.note}</span>
              </div>
              {!loading && modelName ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-success">
                  <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />已配置
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ---------- 面板：默认生成参数（G5：接 generation-defaults 真接口，乐观锁冲突人话提示）
 * S5-2 去假可调：参数档位全站统一锁定（capability-tiers 初始档=现状），本页不再提供
 * 画幅/张数/时长编辑——后端不认的参数不给用户改。可编辑的只有「生成方式」（后端真认）。
 * 档位开放（多 active 档）后，这里与参数行同步出现档位选择。 ---------- */

const defaultsSelectClass = "rounded-sm border border-border-1 bg-surface-1 px-2 py-1 text-xs text-ink-1 outline-none transition-colors hover:border-border-2 focus-visible:ring-2 focus-visible:ring-accent";

/** 档位固定标签（与参数行同源：capability-tiers 初始档；多档开放前不渲染选择器）。 */
const DEFAULTS_TIER_LABEL: Record<GenerationMediaKind, string> = {
  image: "16:9 · 2K · 1 张",
  video: "9:16 · 720p · 4 秒",
  audio: "30 秒",
};

interface DefaultsForm {
  mode: GenerationDefaultMode;
  version: number;
}

function formFromStrategy(strategy: GenerationDefaultStrategy | null): DefaultsForm {
  return {
    mode: strategy?.mode ?? "material_to_prompt",
    version: strategy && Number.isFinite(strategy.version) && strategy.version > 0 ? strategy.version : 0,
  };
}

function GenerationDefaultsPanel(): React.JSX.Element {
  const demo = isDemoMode();
  const [projects, setProjects] = useState<Project[]>(demo ? demoProjects : []);
  const [projectId, setProjectId] = useState(demo ? (demoProjects[0]?.id ?? "") : "");
  const [kind, setKind] = useState<GenerationMediaKind>("image");
  const [form, setForm] = useState<DefaultsForm>(() => formFromStrategy(null));
  const [state, setState] = useState<"idle" | "loading" | "saving" | "saved" | "conflict" | "error">("idle");
  const [message, setMessage] = useState("");

  /* 项目列表（真栈）；demo 用 fixture */
  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    api.projects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list.items);
        setProjectId((current) => current || (list.items[0]?.id ?? ""));
      })
      .catch(() => { if (!cancelled) setMessage("项目列表读取失败，刷新页面重试"); });
    return () => { cancelled = true; };
  }, [demo]);

  /* 读默认策略（404=没存过 → 出厂默认，不打扰） */
  useEffect(() => {
    if (demo || !projectId) return;
    let cancelled = false;
    setState("loading");
    setMessage("");
    api.generationDefault(projectId, kind)
      .then((strategy) => {
        if (cancelled) return;
        setForm(formFromStrategy(strategy));
        setState("idle");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        if (reason instanceof ApiClientError && reason.status === 404) {
          setForm(formFromStrategy(null));
          setState("idle");
          return;
        }
        setState("error");
        setMessage("默认策略读取失败，请检查网络后重试");
      });
    return () => { cancelled = true; };
  }, [demo, projectId, kind]);

  async function save(): Promise<void> {
    if (demo) {
      setMessage("离线演示不写入默认策略");
      return;
    }
    if (!projectId || state === "saving") return;
    setState("saving");
    setMessage("");
    try {
      // 参数=当前锁定档（与生成链实际执行一致）；档位开放后这里才出现可选
      const next = await api.putGenerationDefault(projectId, kind, {
        mode: form.mode,
        model_key: "configured",
        parameters: workbenchFixedParameters(kind),
        expected_version: form.version,
      });
      setForm(formFromStrategy(next));
      setState("saved");
      setMessage(`已保存（v${next.version}），工作台生成时按此方式执行`);
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.status === 409) {
        const fresh = await api.generationDefault(projectId, kind).catch(() => null);
        if (fresh) setForm(formFromStrategy(fresh));
        setState("conflict");
        setMessage("默认策略已被其他人更新，已为你刷新到最新值，确认后再保存");
        return;
      }
      setState("error");
      setMessage(businessErrorMessage(reason, "保存失败，请重试"));
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-4" aria-label="默认生成参数">
      <h2 className="text-ink-1 text-section-title">默认生成参数</h2>
      <p className="text-xs text-ink-2">按项目保存：工作台生成时按这里的默认方式执行。参数档位全站统一锁定，档位开放后这里同步可选。</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
        <label className="inline-flex items-center gap-1.5">项目
          <select aria-label="选择项目" className={defaultsSelectClass} value={projectId} onChange={(event) => { setProjectId(event.target.value); setState("idle"); setMessage(""); }}>
            {projects.length === 0 ? <option value="">（无项目）</option> : null}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5">类型
          <select aria-label="媒体类型" className={defaultsSelectClass} value={kind} onChange={(event) => { setKind(event.target.value as GenerationMediaKind); setState("idle"); setMessage(""); }}>
            <option value="image">图片</option>
            <option value="video">视频</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2">
        <label className="inline-flex items-center gap-1.5">生成方式
          <select aria-label="生成方式" className={defaultsSelectClass} value={form.mode} onChange={(event) => setForm((value) => ({ ...value, mode: event.target.value as GenerationDefaultMode }))}>
            <option value="material_to_prompt">素材转提示词参考</option>
            <option value="direct_reference">直接引用</option>
          </select>
        </label>
        <span>档位 <span className="font-mono text-ink-1">{DEFAULTS_TIER_LABEL[kind]}</span></span>
        <span className="text-ink-4">更多档位即将开放</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" loading={state === "saving" || state === "loading"} onClick={() => void save()}>保存默认参数</Button>
        {message ? <span className={state === "error" || state === "conflict" ? "text-xs text-danger" : state === "saved" ? "text-xs text-success" : "text-xs text-ink-2"} role={state === "error" || state === "conflict" ? "alert" : "status"}>{message}</span> : null}
      </div>
    </Card>
  );
}

/* ---------- 面板：AI 日志（S10 点亮：真分页 + 如实降级；翻页按钮只在可翻时渲染） ---------- */

/** P0 在 api.ts 实现的留痕读取（实落签名 { page, page_size }，归一后 { items, total, hasMore }）；
    方法缺失时页面如实降级。 */
interface AiAuditLogsCapable {
  aiAuditLogs?: (projectId: string, query: { page?: number; page_size?: number }) => Promise<unknown>;
}

function AiLogPanel(): React.JSX.Element {
  const demo = isDemoMode();
  const [projects, setProjects] = useState<Project[]>(demo ? demoProjects : []);
  const [projectId, setProjectId] = useState(demo ? (demoProjects[0]?.id ?? "") : "");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AiAuditLogPage | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error" | "unavailable">("idle");
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);

  /* 项目列表（真栈）；demo 用 fixture */
  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    api.projects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list.items);
        setProjectId((current) => current || (list.items[0]?.id ?? ""));
      })
      .catch(() => {
        if (!cancelled) {
          setState("error");
          setMessage("项目列表读取失败，请检查网络后重试");
        }
      });
    return () => { cancelled = true; };
  }, [demo]);

  /* 留痕读取：demo 给示例数据；真栈走 api.aiAuditLogs（未就位/404/501 如实降级） */
  useEffect(() => {
    if (!projectId) {
      setData(null);
      return;
    }
    if (demo) {
      setData(sliceAuditLogPage(DEMO_AI_AUDIT_LOGS, page));
      setState("idle");
      setMessage("");
      return;
    }
    const client = api as unknown as AiAuditLogsCapable;
    if (typeof client.aiAuditLogs !== "function") {
      setData(null);
      setState("unavailable");
      setMessage("AI 日志暂不可用，请稍后再试。");
      return;
    }
    let cancelled = false;
    setState("loading");
    setMessage("");
    client.aiAuditLogs(projectId, { page, page_size: AI_AUDIT_LOG_PAGE_SIZE })
      .then((raw) => {
        if (cancelled) return;
        setData(aiAuditLogPageFromUnknown(raw));
        setState("idle");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setData(null);
        if (reason instanceof ApiClientError && (reason.status === 404 || reason.status === 501)) {
          setState("unavailable");
          setMessage("AI 日志服务升级中，请稍后再试。");
          return;
        }
        setState("error");
        setMessage(businessErrorMessage(reason, "AI 日志读取失败，请重试"));
      });
    return () => { cancelled = true; };
  }, [demo, projectId, page, revision]);

  const entries = data?.items ?? [];
  return (
    <Card className="flex flex-col gap-3 p-4" aria-label="AI 日志">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-ink-1 text-section-title">AI 调用留痕</h2>
        <div className="flex items-center gap-2">
          {demo ? <Badge tone="neutral" className="shrink-0">示例数据</Badge> : null}
          <button
            type="button"
            className="rounded-sm px-1.5 py-0.5 text-xs text-accent-text outline-none transition-colors hover:bg-accent-subtle focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => setRevision((value) => value + 1)}
          >刷新</button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
        <label className="inline-flex items-center gap-1.5">项目
          <select aria-label="选择项目" className={defaultsSelectClass} value={projectId} onChange={(event) => { setProjectId(event.target.value); setPage(1); setData(null); }}>
            {projects.length === 0 ? <option value="">（无项目）</option> : null}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        {data ? <span className="text-ink-4">共 {data.total} 条 · 第 {page} 页{state === "loading" ? " · 正在读取…" : ""}</span> : null}
      </div>
      {state === "unavailable" ? (
        <EmptyState title="AI 日志暂不可用" description={message} icon={<Scroll />} />
      ) : state === "error" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          <span>{message}</span>
          <button type="button" className="font-semibold underline underline-offset-2" onClick={() => setRevision((value) => value + 1)}>重试</button>
        </div>
      ) : !projectId ? (
        <EmptyState title="先选一个项目" description="AI 调用留痕按项目归档。" icon={<Scroll />} />
      ) : entries.length === 0 ? (
        state === "loading"
          ? <p className="text-xs text-ink-2">正在读取 AI 日志…</p>
          : <EmptyState title="还没有 AI 调用留痕" description="这个项目还没有产生助手调用记录。" icon={<Scroll />} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border-1 text-ink-4">
                <th className="py-2 pr-3 font-medium">时间</th>
                <th className="py-2 pr-3 font-medium">动作</th>
                <th className="py-2 pr-3 font-medium">服务商</th>
                <th className="py-2 pr-3 font-medium">模型</th>
                <th className="py-2 font-medium">用量</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-border-1 last:border-b-0">
                  <td className="whitespace-nowrap py-2 pr-3 font-mono text-ink-2">{entry.createdAt ? formatDateTime(entry.createdAt) : "—"}</td>
                  <td className="py-2 pr-3 text-ink-1" title={auditActionTitle(entry)}>{auditActionLabel(entry)}{auditStatusSuffix(entry.status)}</td>
                  <td className="py-2 pr-3 text-ink-2" title={providerRawTitle(entry.provider)}>{providerLabel(entry.provider)}</td>
                  <td className="py-2 pr-3 text-ink-2" title={modelRawTitle(entry.model)}>{modelDisplayLabel(entry.model)}</td>
                  <td className="whitespace-nowrap py-2 text-ink-2">{auditUsageText(entry.usage)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {projectId && data && (page > 1 || data.hasMore) ? (
        <div className="flex items-center justify-between gap-2">
          <span>{page > 1 ? <Button size="sm" variant="outline" onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</Button> : null}</span>
          <span>{data.hasMore ? <Button size="sm" variant="outline" onClick={() => setPage((value) => value + 1)}>下一页</Button> : null}</span>
        </div>
      ) : null}
      {demo ? <InlineNote>示例数据，用于演示界面；真实留痕随助手调用按项目归档。</InlineNote> : null}
    </Card>
  );
}

/* ---------- 面板：版本预告（板16 内容，文案已改业务白话） ---------- */

/** 预告状态 pill：已上线=绿 / 开发中=青 / 已定档=琥珀 / 规划中·远景=描边灰。 */
function ReleasePill({ status }: { status: ReleaseStatus }): React.JSX.Element {
  const tone = status === "live" ? "success" : status === "filming" ? "accent" : status === "scheduled" ? "warning" : "outline";
  return <Badge tone={tone} className="shrink-0">{RELEASE_STATUS_LABEL[status]}</Badge>;
}

/** 分类标签徽章色（S9-1）：新功能=青（accent）/ 优化=冷描边 / 修复=灰。
   现有 token 无蓝色，「优化」取体系内最冷静的描边样式呈现。 */
export const RELEASE_CATEGORY_BADGE_TONE: Record<ReleaseCategory, "accent" | "outline" | "neutral"> = {
  feature: "accent",
  improvement: "outline",
  fix: "neutral",
};

/** 预告卡统一视图（S9-2 视觉收敛：标题 14/600、正文 14/400 走灰度、轻卡小圆角，分类标签置右上）。 */
function ReleaseCardView({ card }: { card: ReleaseCard }): React.JSX.Element {
  return (
    <article className="flex flex-col gap-2 rounded-md border border-border-1 bg-surface-1 px-3.5 py-3" data-status={card.status} data-category={card.category}>
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-1">{card.title}</h3>
        <Badge tone={RELEASE_CATEGORY_BADGE_TONE[card.category]} className="shrink-0">{RELEASE_CATEGORY_LABEL[card.category]}</Badge>
      </header>
      <p className="flex-1 text-sm text-ink-2">{card.tagline}</p>
      {/* S24-A：reason 入库后上卡片——「为什么做」给用户一句交代；无则静默。 */}
      {card.reason ? <p className="text-xs text-ink-3">为什么做：{card.reason}</p> : null}
      <footer className="font-mono text-xs text-ink-4">{releaseWindow(card)}</footer>
    </article>
  );
}

/** S9-8：已上线段整体收进「版本历史」折叠区；预告主体从「开发中」起（来看接下来有什么，不看成绩单）。
   S23：段数据随内容入库改为接口读取,由 ReleasesPanel 取数后传入。
   S24-A：live 段可有多条（当前线上 + 上一版仍在架），版本历史按 entry.version 逐条匹配渲染。 */
function liveSectionsOf(sections: ReleaseSection[]): ReleaseSection[] {
  return sections.filter((section) => section.status === "live");
}

function upcomingSectionsOf(sections: ReleaseSection[]): ReleaseSection[] {
  return sections.filter((section) => section.status !== "live");
}

/** 页顶「版本历史」折叠块：默认收起，展开看已发布版本交付清单与已上线卡片。 */
function ReleaseHistory({ history, liveSections }: { history: ReleaseHistoryEntry[]; liveSections: ReleaseSection[] }): React.JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false);
  /* S24-A：按版本号索引 live 段——history 条目与同名 live 段配对渲染卡片（如 v0.2.0）；
     无匹配段（如 v0.1.x 无对应 history 条目）只列交付条目。 */
  const sectionByVersion = new Map(liveSections.map((section) => [section.version, section]));
  const liveCardCount = liveSections.reduce((sum, section) => sum + section.cards.length, 0);
  return (
    <section aria-label="版本历史" className="rounded-lg border border-border-1 bg-surface-1">
      <button
        type="button"
        aria-expanded={historyOpen}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        onClick={() => setHistoryOpen((value) => !value)}
      >
        <CaretRight aria-hidden="true" className={cn("size-4 shrink-0 text-ink-2 transition-transform duration-150", historyOpen && "rotate-90")} />
        <span className="text-sm font-semibold text-ink-1">版本历史</span>
        <span className="text-xs text-ink-2">已发布 {history.length} 个版本 · {liveCardCount} 项已上线</span>
      </button>
      {historyOpen ? (
        <div className="flex flex-col gap-5 border-t border-border-1 px-4 py-4">
          {history.map((entry) => {
            const liveSection = sectionByVersion.get(entry.version);
            return (
              <article className="flex flex-col gap-3" key={entry.version}>
                <header className="flex flex-wrap items-baseline gap-2">
                  <strong className="font-mono text-sm text-ink-1">{entry.version}</strong>
                  <span className="font-mono text-xs text-ink-4">{entry.date}</span>
                  <span className="text-xs text-ink-2">{entry.title}</span>
                </header>
                {liveSection ? (
                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                    {liveSection.cards.map((card) => <ReleaseCardView card={card} key={card.id} />)}
                  </div>
                ) : null}
                <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                  {entry.items.map((item) => (
                    <li key={item.label}><Badge tone={RELEASE_CATEGORY_BADGE_TONE[item.category]}>{item.label}</Badge></li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

/** S23：内容入库——面板从接口读版本计划;读不到如实说读不出来(可重试),
   不回退任何写死的旧内容;离线演示没有服务端,同样如实说明。 */
function ReleasesPanel(): React.JSX.Element {
  const demo = isDemoMode();
  const [data, setData] = useState<{ sections: ReleaseSection[]; history: ReleaseHistoryEntry[] } | null>(null);
  const [state, setState] = useState<"loading" | "error" | "idle">("loading");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    setState("loading");
    api.releasePlan()
      .then((plan) => {
        if (cancelled) return;
        setData(plan);
        setState("idle");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => { cancelled = true; };
  }, [demo, revision]);

  if (demo) {
    return <EmptyState title="离线演示不展示版本计划" description="版本计划保存在服务端，离线演示读取不到；登录正式环境即可看到。" icon={<FilmSlate />} />;
  }
  if (state === "error") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
        <span>版本计划暂时加载不出来，请稍后重试。</span>
        <button type="button" className="font-semibold underline underline-offset-2" onClick={() => setRevision((value) => value + 1)}>重试</button>
      </div>
    );
  }
  if (state === "loading" || !data) {
    return <p className="text-xs text-ink-2">正在读取版本计划…</p>;
  }
  const liveSections = liveSectionsOf(data.sections);
  /* R46:预告主体只放「新功能」类卡(优化/修复不上预告);过滤后无可见卡的段整段不出。 */
  const upcomingSections = upcomingSectionsOf(data.sections)
    .map((section) => ({ ...section, cards: previewCardsOf(section) }))
    .filter((section) => section.cards.length > 0);
  if (upcomingSections.length === 0 && data.history.length === 0) {
    return <EmptyState title="还没有版本计划" description="版本计划还没有内容，稍后再来看看。" icon={<FilmSlate />} />;
  }
  return (
    <div className="flex flex-col gap-8" aria-label="设置 · 版本预告">
      <p className="max-w-[720px] text-sm text-ink-2">{SETTINGS_INTRO}</p>
      {data.history.length > 0 ? <ReleaseHistory history={data.history} liveSections={liveSections} /> : null}
      {upcomingSections.map((section) => (
        <section className="relative flex flex-col gap-4 border-l border-border-1 pl-5" key={section.version} aria-label={`${section.title} · ${RELEASE_STATUS_LABEL[section.status]}`}>
          <span aria-hidden="true" className={cn("absolute -left-[4.5px] top-[7px] size-2 rounded-full", section.status === "filming" ? "bg-accent" : "bg-border-2")} />
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h2 className="text-sm font-semibold text-ink-1">{section.title}</h2>
            <ReleasePill status={section.status} />
            <p className="text-xs text-ink-2">{section.note}</p>
          </header>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
            {section.cards.map((card) => <ReleaseCardView card={card} key={card.id} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ---------- 局部复用：说明条（对齐旧 inline-note：surface-2 底 + 细描边） ---------- */

function InlineNote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2">{children}</p>;
}
