import { desc, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { modelCapabilities } from "../../db/schema.js";

/**
 * 模型能力真源的读取侧。产品拍板「max output token 不能固定,要随模型支持的
 * 最大输出 token 动态走」——这个文件就是「动态」的那一半:把迁移 059 建的
 * model_capabilities 表读成调用方能直接用的 token 数。
 *
 * 写入侧在 scripts/sync-model-capabilities.mts(手动/定时运维脚本)。
 * 为什么读写分开:arkcli 是外部命令,不能进请求链路。
 */

export type ModelCapabilityDataSource = "provider_api" | "manual";

export interface ModelCapabilityRecord {
  modelName: string;
  modelVersion: string;
  /** 调用时真正传给供应商的 ID = 模型名-版本号。 */
  callableModelId: string;
  provider: string;
  contextWindowTokens: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number;
  maxReasoningTokens: number | null;
  rateLimitRpm: number | null;
  rateLimitTpm: number | null;
  dataSource: ModelCapabilityDataSource;
}

export interface ModelCapabilityStore {
  listCapabilities(): Promise<readonly ModelCapabilityRecord[]>;
}

/**
 * 表里查不到这个模型时的行为:用一个保守但可用的默认值,不拒绝、不返回 0。
 *
 * 为什么不拒绝:登记表是运维数据,同步器没跑或新模型刚上线都会造成缺行。
 * 让缺行直接 400/503 等于把一张运维表变成生产可用性的单点——一个还没同步的
 * 模型会让整条业务链路不可用,而它本来只是「不知道能开多大」。
 *
 * 为什么不返回 0 或 undefined:那会把「不知道」静默变成「不许输出」,调用方
 * 拿到 0 会在适配器层报一个跟真实原因无关的参数错。
 *
 * 为什么取 4096:这是改造前两个供应商适配器各自的硬顶(ark 4096、col 4096),
 * 也就是改造前实际跑通过的最大值。用它当兜底,最坏情况退回改造前的能力,
 * 不会比现状更差,也不会凭空给出一个没验证过的大值。
 */
export const CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS = 4_096;

/** 默认缓存 5 分钟:运维同步完最多 5 分钟生效,不用重启服务。 */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;

/**
 * 按 1k = 1024 换算。为什么钉死这个口径:供应商文档把 1024k 与 1m 当同一个值
 * 用(deepseek-v4-flash-ga 的上下文窗口两处都出现过),说明它按二进制算。
 * 换算口径只在这一处,库里只落已换算的整数。
 */
export function parseTokenLimit(value: string | number | null | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const matched = /^(\d+)\s*([km])?$/iu.exec(value.trim());
  if (!matched) return undefined;
  const magnitude = Number(matched[1]);
  if (!Number.isSafeInteger(magnitude) || magnitude <= 0) return undefined;
  const unit = matched[2]?.toLowerCase();
  const multiplier = unit === "k" ? 1_024 : unit === "m" ? 1_024 * 1_024 : 1;
  return magnitude * multiplier;
}

/** 供应商响应缺容量、缺版本号时抛这个,同步器据此跳过并记录,而不是写脏数据。 */
export class ArkModelCapabilityParseError extends Error {
  constructor(readonly modelName: string, readonly reason: string) {
    super(`模型 ${modelName} 的容量无法解析: ${reason}`);
    this.name = "ArkModelCapabilityParseError";
  }
}

interface ArkModelPayload {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  primary_version?: unknown;
  limits?: unknown;
  rate_limit?: unknown;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 解析 `arkcli models get <name>` 的单模型 JSON。
 *
 * 调用 ID 优先用响应自带的 `id`,缺失时才用「模型名-版本号」拼:官方示例代码
 * 里传的就是这个拼法,但供应商已经算好的值比我们拼的更可信。
 */
export function parseArkModelCapability(payload: ArkModelPayload): ModelCapabilityRecord {
  const modelName = optionalTrimmed(payload.name);
  if (!modelName) throw new ArkModelCapabilityParseError("(未知)", "响应里没有 name");

  const limits = optionalRecord(payload.limits);
  if (!limits) throw new ArkModelCapabilityParseError(modelName, "响应里没有 limits 结构");

  const maxOutputTokens = parseTokenLimit(limits.max_completion_token_length as string | number | undefined);
  if (maxOutputTokens === undefined) {
    throw new ArkModelCapabilityParseError(modelName, "limits.max_completion_token_length 缺失或无法解析");
  }

  const modelVersion = optionalTrimmed(payload.primary_version) ?? optionalTrimmed(payload.version);
  if (!modelVersion) {
    throw new ArkModelCapabilityParseError(modelName, "缺 primary_version,拼不出调用 ID");
  }

  const defaultRateLimit = optionalRecord(optionalRecord(payload.rate_limit)?.default_rate_limit);
  return {
    modelName,
    modelVersion,
    callableModelId: optionalTrimmed(payload.id) ?? `${modelName}-${modelVersion}`,
    provider: "ark",
    contextWindowTokens: parseTokenLimit(limits.context_window as string | undefined) ?? null,
    maxInputTokens: parseTokenLimit(limits.max_input_token_length as string | undefined) ?? null,
    maxOutputTokens,
    maxReasoningTokens: parseTokenLimit(limits.max_reasoning_token_length as string | undefined) ?? null,
    rateLimitRpm: parseTokenLimit(defaultRateLimit?.rpm as number | undefined) ?? null,
    rateLimitTpm: parseTokenLimit(defaultRateLimit?.tpm as number | undefined) ?? null,
    dataSource: "provider_api",
  };
}

/**
 * 阶段输出预算:结构化任务单次要多少输出 token。
 *
 * 为什么不直接把模型上限整档给满(拿到 384k 不传 384k):
 *   1. **超时与失败成本**:输出上限同时是「这次调用最坏要跑多久」的上界。
 *      整档 384k 的一次拆解可以跑十几分钟,失败重试的代价按整档算,
 *      而一场戏 20+ 个结构化镜头实际只需要一万多 token。
 *   2. **输出预算不能挤掉输入预算**:上下文窗口是输入+输出共享的。剧本拆解
 *      的输入(一整场戏 + 已批资产 + 候选名单)本身不小,把输出顶到跟窗口
 *      同量级会在长剧本上直接撞窗口。
 *   3. **上限决定风险敞口**:计费按实际输出走,但上限是给失控输出设的一道
 *      不依赖模型自觉的闸。
 *
 * 取值规则就一条:取 32768 与模型上限里的小者。
 *   - 32768 是按需定的:一场戏 20+ 个结构化镜头,远超原来卡死的 2048,
 *     又只占大模型能力的个位数百分比——余量就是那部分没要的容量。
 *   - 模型上限低于 32768 时按上限全给:此时没有余量可留,而这恰好等于
 *     改造前适配器硬顶允许的最大值,不会比现状更差。
 */
const STAGE_TARGET_OUTPUT_TOKENS = 32_768;

export function stageOutputBudget(modelMaxOutputTokens: number): number {
  if (!Number.isInteger(modelMaxOutputTokens) || modelMaxOutputTokens <= 0) {
    return Math.min(STAGE_TARGET_OUTPUT_TOKENS, CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS);
  }
  return Math.min(STAGE_TARGET_OUTPUT_TOKENS, modelMaxOutputTokens);
}

export interface ResolvedModelCapability {
  maxOutputTokens: number;
  /** registry = 表里查到的模型真实能力;fallback = 没查到走的保守默认。 */
  source: "registry" | "fallback";
  record?: ModelCapabilityRecord;
}

export interface ModelCapabilityLookupOptions {
  ttlMs?: number;
  now?: () => number;
}

/**
 * 带进程内缓存的容量查询。缓存是必需的而不是优化:网关每次 complete 都要问
 * 一次上限,不缓存就是每个 AI 调用多一次查库。
 */
export class ModelCapabilityLookup {
  private cache: Map<string, ModelCapabilityRecord> | undefined;
  private loadedAt = 0;
  private inflight: Promise<Map<string, ModelCapabilityRecord>> | undefined;

  constructor(
    private readonly store: ModelCapabilityStore,
    private readonly options: ModelCapabilityLookupOptions = {},
  ) {}

  async resolve(callableModelId: string): Promise<ResolvedModelCapability> {
    const record = (await this.snapshot()).get(callableModelId);
    if (!record) return { maxOutputTokens: CONSERVATIVE_FALLBACK_MAX_OUTPUT_TOKENS, source: "fallback" };
    return { maxOutputTokens: record.maxOutputTokens, source: "registry", record };
  }

  async maxOutputTokens(callableModelId: string): Promise<number> {
    return (await this.resolve(callableModelId)).maxOutputTokens;
  }

  /** 运维同步完想立刻生效时调用;正常路径靠 TTL 自然过期。 */
  invalidate(): void {
    this.cache = undefined;
    this.loadedAt = 0;
  }

  private async snapshot(): Promise<Map<string, ModelCapabilityRecord>> {
    const now = (this.options.now ?? Date.now)();
    const ttl = this.options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    if (this.cache && now - this.loadedAt <= ttl) return this.cache;
    // 并发的首次查询共用同一次加载,避免冷启动瞬间打出 N 次同样的查库。
    this.inflight ??= this.load(now);
    try {
      return await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }

  private async load(now: number): Promise<Map<string, ModelCapabilityRecord>> {
    try {
      const rows = await this.store.listCapabilities();
      const next = new Map(rows.map((row) => [row.callableModelId, row] as const));
      this.cache = next;
      this.loadedAt = now;
      return next;
    } catch {
      // 登记表读不到不该让业务调用崩掉:这只是「不知道能开多大」,
      // 兜底值仍然是一个能真正发出请求的正数。旧缓存优先于空表。
      return this.cache ?? new Map();
    }
  }
}

export class DrizzleModelCapabilityStore implements ModelCapabilityStore {
  constructor(private readonly db: Database) {}

  async listCapabilities(): Promise<readonly ModelCapabilityRecord[]> {
    const rows = await this.db.select({
      modelName: modelCapabilities.modelName,
      modelVersion: modelCapabilities.modelVersion,
      callableModelId: modelCapabilities.callableModelId,
      provider: modelCapabilities.provider,
      contextWindowTokens: modelCapabilities.contextWindowTokens,
      maxInputTokens: modelCapabilities.maxInputTokens,
      maxOutputTokens: modelCapabilities.maxOutputTokens,
      maxReasoningTokens: modelCapabilities.maxReasoningTokens,
      rateLimitRpm: modelCapabilities.rateLimitRpm,
      rateLimitTpm: modelCapabilities.rateLimitTpm,
      dataSource: modelCapabilities.dataSource,
    }).from(modelCapabilities).orderBy(desc(modelCapabilities.syncedAt));
    return rows.map((row) => ({
      ...row,
      dataSource: row.dataSource === "manual" ? "manual" : "provider_api",
    }));
  }

  /** 同步器用:按调用 ID upsert 一行。容量变化是事实更新,不是改价格。 */
  async upsert(record: ModelCapabilityRecord, id: string, now: Date): Promise<"inserted" | "updated"> {
    const existing = await this.db.select({ id: modelCapabilities.id })
      .from(modelCapabilities)
      .where(eq(modelCapabilities.callableModelId, record.callableModelId))
      .limit(1);
    const values = {
      modelName: record.modelName,
      modelVersion: record.modelVersion,
      callableModelId: record.callableModelId,
      provider: record.provider,
      contextWindowTokens: record.contextWindowTokens,
      maxInputTokens: record.maxInputTokens,
      maxOutputTokens: record.maxOutputTokens,
      maxReasoningTokens: record.maxReasoningTokens,
      rateLimitRpm: record.rateLimitRpm,
      rateLimitTpm: record.rateLimitTpm,
      dataSource: record.dataSource,
      syncedAt: now,
      updatedAt: now,
    };
    const found = existing[0];
    if (found) {
      await this.db.update(modelCapabilities).set(values).where(eq(modelCapabilities.id, found.id));
      return "updated";
    }
    await this.db.insert(modelCapabilities).values({ ...values, id, createdAt: now });
    return "inserted";
  }
}
