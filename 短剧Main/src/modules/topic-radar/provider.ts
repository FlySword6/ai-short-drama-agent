import { AppError } from "../../shared/errors.js";
import { isRecord } from "../../shared/json.js";
import type {
  TopicRadarItem,
  TopicRadarProvider,
  TopicRadarProviderResult,
  TopicRadarRanking,
} from "./types.js";

const ENDPOINT = "https://www.52api.cn/api/hg_top";
const DEFAULT_TIMEOUT_MS = 10_000;
const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_FIELD_NAME = /(?:^|[_-])(?:key|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|cookie|signature|sign|ak|sk)(?:$|[_-])/i;
const SENSITIVE_ASSIGNMENT = /\b(key|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|cookie|signature|sign|ak|sk)\b\s*([:=])\s*([^\s,;&]+)/gi;

export interface FiftyTwoApiTopicRadarConfiguration {
  enabled: boolean;
  apiKey?: string;
  timeoutMs?: number;
}

export type TopicRadarFetch = typeof fetch;

export class FiftyTwoApiTopicRadarProvider implements TopicRadarProvider {
  private readonly fetchImpl: TopicRadarFetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly configuration: FiftyTwoApiTopicRadarConfiguration,
    options: { fetchImpl?: TopicRadarFetch } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = normalizeTimeout(configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  assertReady(): void {
    if (!this.configuration.enabled || !nonEmpty(this.configuration.apiKey)) {
      throw new AppError(503, "topic_radar_not_configured", "选题雷达尚未配置，未发送任何上游请求");
    }
  }

  async fetchRankings(): Promise<{ rankDate: string | null; rankings: TopicRadarRanking[]; rawPayload: unknown }> {
    const { payload, data } = await this.fetch({ type: "top" });
    const records = extractArray(data, ["lists", "list", "rank_list", "rankList", "data", "result"]);
    if (!records) throw invalidResponse();

    const rankings = records.map(normalizeRanking).filter((value): value is TopicRadarRanking => value !== null);
    if (records.length > 0 && rankings.length === 0) throw invalidResponse();
    return {
      rankDate: extractRankDate(payload, data),
      rankings,
      rawPayload: redactProviderPayload(payload),
    };
  }

  async fetchRankingPage(input: {
    rankingId: string;
    subRankingId?: string;
    page: number;
  }): Promise<TopicRadarProviderResult> {
    const { payload, data } = await this.fetch({
      type: "list",
      cell_id: input.rankingId,
      ...(input.subRankingId ? { sub_cell_id: input.subRankingId } : {}),
      page: String(input.page),
    });
    const records = extractArray(data, ["lists", "list", "items", "rank_list", "rankList", "data", "result"]);
    if (!records) throw invalidResponse();

    const items = records
      .map(normalizeItem)
      .filter((value): value is TopicRadarItem & { rawItem: unknown } => value !== null);
    if (records.length > 0 && items.length === 0) throw invalidResponse();
    return {
      rankDate: extractRankDate(payload, data),
      items,
      rawPayload: redactProviderPayload(payload),
    };
  }

  private async fetch(parameters: Record<string, string>): Promise<{ payload: Record<string, unknown>; data: unknown }> {
    this.assertReady();
    const url = new URL(ENDPOINT);
    url.searchParams.set("key", nonEmpty(this.configuration.apiKey)!);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw unavailable();
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw invalidResponse();
    }
    if (!response.ok || !isRecord(payload) || (numericValue(payload.code) ?? 0) >= 400) throw unavailable();
    return { payload, data: parsePossiblyJson(payload.data) ?? payload };
  }
}

function extractArray(value: unknown, keys: readonly string[]): Record<string, unknown>[] | null {
  const parsed = parsePossiblyJson(value);
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (!isRecord(parsed)) return null;
  for (const key of keys) {
    const candidate = parsePossiblyJson(parsed[key]);
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return null;
}

function normalizeRanking(value: Record<string, unknown>): TopicRadarRanking | null {
  const id = firstText(value, ["cell_id", "cellId", "id"]);
  const name = firstText(value, ["name", "title", "cell_name", "cellName"]);
  if (!id || !name) return null;
  const children = extractArray(value, ["sub_lists", "sub_list", "sub_rankings", "sub_cells", "children"]) ?? [];
  return {
    id,
    name,
    subRankings: children.map((child) => {
      const childId = firstText(child, ["sub_cell_id", "subCellId", "cell_id", "id"]);
      const childName = firstText(child, ["sub_cell_name", "subCellName", "name", "title", "cell_name", "cellName"]);
      return childId && childName ? { id: childId, name: childName } : null;
    }).filter((child): child is { id: string; name: string } => child !== null),
  };
}

function normalizeItem(value: Record<string, unknown>, index: number): (TopicRadarItem & { rawItem: unknown }) | null {
  const title = firstText(value, ["title", "name", "drama_name", "dramaName", "book_name", "bookName"]);
  if (!title) return null;
  return {
    rank: firstInteger(value, ["rank", "ranking", "rank_no", "rankNo", "position"]) ?? index + 1,
    title: title.slice(0, 512),
    heat: firstDisplayText(value, ["heat", "hot", "hot_value", "hotValue", "score"]),
    link: firstHttpUrl(value, ["url", "link", "detail_url", "detailUrl", "share_url", "shareUrl"]),
    rawItem: redactProviderPayload(value),
  };
}

function extractRankDate(payload: Record<string, unknown>, data: unknown): string | null {
  const value = firstText(payload, ["rank_date", "rankDate", "date", "update_date", "updateDate"])
    ?? (isRecord(data) ? firstText(data, ["rank_date", "rankDate", "date", "update_date", "updateDate"]) : null);
  return value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

function parsePossiblyJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function firstText(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if ((typeof value === "string" || typeof value === "number") && String(value).trim()) return String(value).trim();
  }
  return null;
}

function firstDisplayText(record: Record<string, unknown>, keys: readonly string[]): string | null {
  const value = firstText(record, keys);
  return value?.slice(0, 128) ?? null;
}

function firstInteger(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = numericValue(record[key]);
    if (value !== null && Number.isInteger(value) && value >= 0) return value;
  }
  return null;
}

function firstHttpUrl(record: Record<string, unknown>, keys: readonly string[]): string | null {
  const value = firstText(record, keys);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    for (const name of url.searchParams.keys()) if (isSensitiveFieldName(name)) url.searchParams.set(name, REDACTED_VALUE);
    return url.toString();
  } catch {
    return null;
  }
}

function redactProviderPayload(value: unknown, depth = 0): unknown {
  if (depth > 32) return "[TRUNCATED]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((entry) => redactProviderPayload(entry, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    isSensitiveFieldName(key) ? REDACTED_VALUE : redactProviderPayload(entry, depth + 1),
  ]));
}

function redactSensitiveText(value: string): string {
  const replaced = value.replace(SENSITIVE_ASSIGNMENT, (_match, key: string, separator: string) => `${key}${separator}${REDACTED_VALUE}`);
  try {
    const url = new URL(replaced);
    for (const name of url.searchParams.keys()) if (isSensitiveFieldName(name)) url.searchParams.set(name, REDACTED_VALUE);
    return url.toString();
  } catch {
    return replaced;
  }
}

function isSensitiveFieldName(value: string): boolean {
  return SENSITIVE_FIELD_NAME.test(value);
}

function numericValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function nonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeTimeout(value: number): number {
  return Number.isInteger(value) && value >= 1_000 && value <= 60_000 ? value : DEFAULT_TIMEOUT_MS;
}

function unavailable(): AppError {
  return new AppError(502, "topic_radar_upstream_unavailable", "选题榜单暂时不可用，请稍后再试", true);
}

function invalidResponse(): AppError {
  return new AppError(502, "topic_radar_invalid_upstream_response", "选题榜单暂时读不出来，请稍后再试", true);
}
