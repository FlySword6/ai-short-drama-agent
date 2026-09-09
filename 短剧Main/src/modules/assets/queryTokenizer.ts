import { createRequire } from "node:module";

export interface SearchQueryToken {
  text: string;
  source: "jieba" | "fallback" | "llm";
}

export interface SearchQueryTokenizerOptions {
  maxTokens?: number;
}

interface JiebaSegmenter {
  cutForSearch?: (text: string) => string[];
  cut?: (text: string) => string[];
}

interface JiebaConstructor {
  new (): JiebaSegmenter;
  withDict?: (dict: Uint8Array) => JiebaSegmenter;
}

interface JiebaModule {
  Jieba?: JiebaConstructor;
  default?: unknown;
  cutForSearch?: (text: string) => string[];
  cut?: (text: string) => string[];
}

interface JiebaDictModule {
  dict?: Uint8Array;
}

const optionalRequire = createRequire(import.meta.url);
let cachedJieba: JiebaSegmenter | null | undefined;

const DEFAULT_MAX_TOKENS = 16;
const TOKEN_BOUNDARY = /[\s,，.。:：;；!！?？、/\\()[\]{}<>《》"'“”‘’|]+/u;
const STOP_WORDS = new Set([
  "找",
  "找一位",
  "找一个",
  "一位",
  "一个",
  "一种",
  "需要",
  "帮我",
  "给我",
  "用于",
  "可以",
  "相关",
  "中的",
  "里面",
  "题材",
  "素材",
  "资产",
  "图片",
  "图像",
  "参考",
  "参考图",
  "角色",
]);

const USEFUL_SINGLE_CJK = new Set(["男", "女", "红", "黑", "白", "灰", "蓝", "绿", "紫", "金"]);

const DOMAIN_TERMS = [
  "女总裁",
  "男主角",
  "女主角",
  "红长发",
  "黑长发",
  "白衬衫",
  "灰色西装",
  "黑色西装",
  "短裙",
  "长裙",
  "战损版",
  "天尊版",
  "心魔版",
  "少年版",
  "老年版",
  "白衣版",
  "黑衣版",
  "古装版",
  "现代版",
  "都市",
  "豪门",
  "古风",
  "仙侠",
  "玄幻",
  "神魔",
  "科幻",
  "赛博朋克",
  "太空",
  "机甲",
  "机器人",
  "外星",
  "妖兽",
  "宠物",
  "道具",
  "武器",
  "法宝",
  "场景",
  "客厅",
  "卧室",
  "地下",
  "休闲",
  "办公室",
  "会议室",
  "运镜",
  "镜头",
  "光影",
  "暖光",
  "冷光",
  "冷傲",
  "强势",
  "温柔",
  "霸气",
  "阴冷",
  "宏大",
  "震撼",
];

export function tokenizeSearchQuery(
  query: string,
  options: SearchQueryTokenizerOptions = {},
): SearchQueryToken[] {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (!normalized) return [];
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const jieba = loadJieba();
  const rawTokens = jieba
    ? [...domainTermTokens(normalized), ...tokenizeWithJieba(jieba, normalized)]
    : fallbackTokens(normalized);
  return dedupeAndRankTokens(rawTokens, jieba ? "jieba" : "fallback", maxTokens);
}

export function sanitizeSearchQueryTokenTexts(
  rawTokens: string[],
  options: SearchQueryTokenizerOptions = {},
): string[] {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const rawToken of rawTokens) {
    const token = normalizeToken(rawToken);
    if (!isUsefulToken(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= Math.max(1, maxTokens)) break;
  }
  return tokens;
}

function loadJieba(): JiebaSegmenter | null {
  if (cachedJieba !== undefined) return cachedJieba;
  try {
    const loaded = optionalRequire("@node-rs/jieba") as JiebaModule;
    const dictModule = optionalRequire("@node-rs/jieba/dict") as JiebaDictModule;
    cachedJieba = resolveJiebaSegmenter(loaded, dictModule.dict);
  } catch {
    cachedJieba = null;
  }
  return cachedJieba;
}

function resolveJiebaSegmenter(loaded: JiebaModule, dict?: Uint8Array): JiebaSegmenter | null {
  if (loaded.Jieba) {
    return dict && loaded.Jieba.withDict
      ? loaded.Jieba.withDict(mergeJiebaDict(dict))
      : new loaded.Jieba();
  }
  const moduleValue: unknown = loaded;
  if (hasSegmentMethods(moduleValue)) return moduleValue;
  const defaultExport = loaded.default;
  if (hasSegmentMethods(defaultExport)) return defaultExport;
  if (defaultExport && typeof defaultExport === "object" && "Jieba" in defaultExport) {
    const nested = defaultExport as JiebaModule;
    if (nested.Jieba) {
      return dict && nested.Jieba.withDict
        ? nested.Jieba.withDict(mergeJiebaDict(dict))
        : new nested.Jieba();
    }
  }
  return null;
}

function mergeJiebaDict(defaultDict: Uint8Array): Uint8Array {
  const customDict = `\n${DOMAIN_TERMS.map((term) => `${term} 2000000`).join("\n")}\n`;
  return Buffer.concat([Buffer.from(defaultDict), Buffer.from(customDict, "utf8")]);
}

function hasSegmentMethods(value: unknown): value is JiebaSegmenter {
  if (!value || typeof value !== "object") return false;
  const candidate = value as JiebaSegmenter;
  return typeof candidate.cutForSearch === "function" || typeof candidate.cut === "function";
}

function tokenizeWithJieba(jieba: JiebaSegmenter, query: string): string[] {
  const cut = jieba.cutForSearch ?? jieba.cut;
  if (!cut) return fallbackTokens(query);
  try {
    return cut.call(jieba, query);
  } catch {
    return fallbackTokens(query);
  }
}

function fallbackTokens(query: string): string[] {
  const tokens: string[] = [];
  tokens.push(...domainTermTokens(query));
  for (const part of query.split(TOKEN_BOUNDARY)) {
    const compact = part.replace(/(?:一位|一个|一种|题材|气质|风格|感觉|整体|左右|配|穿|带|的|和|与|或|及|并且|中|里|上|下)/gu, " ");
    for (const segment of compact.split(/\s+/u)) {
      if (!segment) continue;
      tokens.push(segment);
      if (/^[\u3400-\u9fff]{5,}$/u.test(segment)) tokens.push(...cjkNgrams(segment));
    }
  }
  return tokens;
}

function domainTermTokens(query: string): string[] {
  return DOMAIN_TERMS.filter((term) => query.includes(term));
}

function cjkNgrams(value: string): string[] {
  const chars = [...value];
  const grams: string[] = [];
  for (const size of [4, 3, 2]) {
    for (let index = 0; index <= chars.length - size; index += 1) {
      grams.push(chars.slice(index, index + size).join(""));
    }
  }
  return grams;
}

function dedupeAndRankTokens(rawTokens: string[], source: SearchQueryToken["source"], maxTokens: number): SearchQueryToken[] {
  const seen = new Map<string, { token: string; score: number; firstIndex: number }>();
  rawTokens.forEach((rawToken, index) => {
    const token = normalizeToken(rawToken);
    if (!isUsefulToken(token)) return;
    const score = tokenScore(token);
    const current = seen.get(token);
    if (!current || score > current.score) {
      seen.set(token, { token, score, firstIndex: current?.firstIndex ?? index });
    }
  });
  return [...seen.values()]
    .sort((left, right) => right.score - left.score || left.firstIndex - right.firstIndex || left.token.localeCompare(right.token))
    .slice(0, Math.max(1, maxTokens))
    .map(({ token }) => ({ text: token, source }));
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}\u3400-\u9fff]+|[^\p{L}\p{N}\u3400-\u9fff]+$/gu, "");
}

function isUsefulToken(token: string): boolean {
  if (!token || STOP_WORDS.has(token)) return false;
  if (/^\d+$/u.test(token)) return false;
  if (/^[a-z0-9_-]{2,}$/u.test(token)) return true;
  if (/^[\u3400-\u9fff]$/u.test(token)) return USEFUL_SINGLE_CJK.has(token);
  return [...token].length >= 2;
}

function tokenScore(token: string): number {
  const length = [...token].length;
  const domainBoost = DOMAIN_TERMS.includes(token) ? 20 : 0;
  const cjkBoost = /[\u3400-\u9fff]/u.test(token) ? 5 : 0;
  return domainBoost + cjkBoost + Math.min(length, 8);
}
