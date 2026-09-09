import type { AiCompletionRequest, AiProviderCompletion } from "../ai/types.js";
import { parseJsonValue } from "../../shared/json.js";
import { sanitizeSearchQueryTokenTexts } from "./queryTokenizer.js";
import type { HybridSearchLexicalTokenizer, HybridSearchLexicalTokenizerInput } from "./hybridSearchService.js";

export const ASSET_SEARCH_TOKENIZE_MAX_TOKENS = 500;

export interface AssetSearchTokenCompletionGateway {
  completeValidated<T>(
    input: AiCompletionRequest,
    validate: (completion: AiProviderCompletion) => T | Promise<T>,
  ): Promise<T>;
}

export class LlmSearchQueryTokenizer implements HybridSearchLexicalTokenizer {
  constructor(private readonly gateway: AssetSearchTokenCompletionGateway) {}

  tokenize(input: HybridSearchLexicalTokenizerInput): Promise<string[]> {
    return this.gateway.completeValidated({
      actorId: input.actorId,
      purpose: "asset_search_tokenize",
      system: assetSearchTokenizeSystem(),
      prompt: assetSearchTokenizePrompt(input.query),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      maxTokens: ASSET_SEARCH_TOKENIZE_MAX_TOKENS,
    }, (completion) => parseAssetSearchTokens(completion.content));
  }
}

export function assetSearchTokenizeSystem(): string {
  return "你是短剧素材检索 query 的检索短语抽取助手。只输出严格 JSON 数组，不输出 Markdown，不输出解释。";
}

export function assetSearchTokenizePrompt(query: string): string {
  return [
    "任务：把下面这条短剧素材检索 query 拆成适合 PostgreSQL 词法召回的中文 token/短语。",
    "",
    "要求：",
    "1. 只根据 query 本身抽取，不要补充 query 没写的信息。",
    "2. 优先输出强区分短语和属性组合，例如：棒球夹克、打手头目、黑裤、街头痞气、太极八卦擂台、废弃医院病房。",
    "3. 减少泛词，例如：找、一位、角色、素材、图片、气质、感觉、年轻、黑、白、长发、短发；只有它们和具体对象组成短语时才保留。",
    "4. 按区分度从高到低输出 token，优先保留能排除相似混淆资产的短语；通常输出 6 到 14 个，信息不足时允许更少。",
    "5. 每个 token 最长 32 个字符。",
    "6. 只输出严格 JSON 字符串数组，例如：[\"棒球夹克\",\"打手头目\",\"黑裤\"]。",
    "",
    `query：${query}`,
  ].join("\n");
}

export function parseAssetSearchTokens(content: string): string[] {
  const parsed = parseJsonValue(content);
  const rawTokens = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { tokens?: unknown }).tokens)
      ? (parsed as { tokens: unknown[] }).tokens
      : [];
  return sanitizeSearchQueryTokenTexts(
    rawTokens.filter((value): value is string => typeof value === "string"),
  );
}
