/**
 * 拆解质量评测的计分。纯函数,不碰网络也不碰磁盘,单测直接钉住。
 *
 * 四类指标(定义先于测量,见 outputs/breakdown-eval-report-*.md 的口径章):
 *   稳定性  同一集连跑 N 次的成功率,以及成功那几次之间场/镜/角色数的离散程度;
 *   准确率  拆出来的角色/场景/道具里,金标里真有的占比;
 *   召回率  金标里的角色/场景/道具,被拆出来的占比;
 *   耗时成本 端到端耗时、token 用量、按公开单价折算的钱。
 */
import type { EvalModelSpec, EvalRunRecord, GoldAssetEpisode, GoldSceneEpisode } from "./types.js";

const SLUGLINE_PREFIX = /^(int\.?\/ext\.?|i\/e\.?|int\.?|ext\.?)\s+/u;
const TIME_SUFFIX =
  /\s*[-–—]\s*(day|night|dawn|dusk|evening|morning|afternoon|continuous|later|moments later|same time|sunset|sunrise)\s*$/u;

/** 归一到可比对的形状:大小写、标点、全半角、场次标记行的前后缀都不算差异。 */
export function normalizeName(raw: string): string {
  let value = raw.normalize("NFKC").toLowerCase();
  value = value.replace(/[（(][^）)]*[）)]/gu, " ");
  value = value.replace(/[’‘]/gu, "'").replace(/[“”]/gu, '"');
  value = value.replace(/\s+/gu, " ").trim();
  value = value.replace(SLUGLINE_PREFIX, "");
  let previous = "";
  while (previous !== value) {
    previous = value;
    value = value.replace(TIME_SUFFIX, "").trim();
  }
  value = value.replace(/[.,:;!?"']/gu, "").replace(/\s+/gu, " ").trim();
  return value;
}

/**
 * 一个名字的所有可比对写法。金标里中英并写(`GRANDMA（外婆）`)时,
 * 括号里那半也要能对上——模型输出中文名不该算错。
 */
export function nameVariants(raw: string): string[] {
  const variants = new Set<string>();
  const main = normalizeName(raw);
  if (main) variants.add(main);
  for (const matched of raw.matchAll(/[（(]([^）)]*)[）)]/gu)) {
    const inner = normalizeName(matched[1] ?? "");
    if (inner) variants.add(inner);
  }
  return [...variants];
}

export interface MatchTarget {
  items: Array<{ id: string; name: string; aliases?: string[]; evidenceQuotes?: string[] }>;
  excluded: Array<{ name: string; kind: string }>;
  disputed: Array<{ id: string; item: string; kind: string }>;
}

export interface MatchResult {
  precision: number;
  recall: number;
  predictedCount: number;
  goldCount: number;
  matchedGoldIds: string[];
  missedGoldIds: string[];
  falsePositives: string[];
  /** 命中「两种读法都立得住」的条目:不进分子也不进分母。 */
  disputedHits: string[];
  /** 命中金标明确排除的条目:算误报,并单独点名,因为这是最能说明问题的一类错。 */
  excludedHits: string[];
}

function keysOf(item: { name: string; aliases?: string[] }): string[] {
  return [item.name, ...(item.aliases ?? [])].flatMap(nameVariants);
}

/** 场景名允许「词全包含」:模型写 `police station`,金标写 `police station lobby`,算同一处景。 */
function looseEqual(a: string, b: string, loose: boolean): boolean {
  if (a === b) return true;
  if (!loose || !a || !b) return false;
  const left = new Set(a.split(" "));
  const right = new Set(b.split(" "));
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  return smaller.size > 0 && [...smaller].every((token) => larger.has(token));
}

/**
 * 证据引文认亲。金标里道具名标成了中文(`盖尸白布`),模型吐的是剧本原文里的英文词
 * (`sheet`)——两边说的是同一件东西,不该判成一漏一错。判据:这个词以整词形式
 * 出现在该条目的证据引文里。只认整词、至少三个字符,免得碎片乱认。
 */
function evidenceMentions(quotes: string[] | undefined, term: string): boolean {
  if (!quotes || term.length < 3) return false;
  const needle = term.replace(/'s\b/gu, "").trim();
  if (needle.length < 3) return false;
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}])`, "u");
  return quotes.some((quote) => pattern.test(normalizeName(quote)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function matchNames(
  predicted: string[],
  gold: MatchTarget,
  options: { loose?: boolean } = {},
): MatchResult {
  const loose = options.loose ?? false;
  const goldKeys = gold.items.map((item) => ({
    id: item.id,
    keys: keysOf(item),
    quotes: item.evidenceQuotes,
  }));
  const disputedKeys = gold.disputed.map((item) => ({ id: item.id, keys: nameVariants(item.item) }));
  const excludedKeys = gold.excluded.map((item) => ({ name: item.name, keys: nameVariants(item.name) }));

  const matchedGoldIds = new Set<string>();
  const falsePositives: string[] = [];
  const disputedHits: string[] = [];
  const excludedHits: string[] = [];
  let scored = 0;
  let hits = 0;

  for (const raw of predicted) {
    const variants = nameVariants(raw);
    const hit = goldKeys.find((item) =>
      item.keys.some((key) => variants.some((variant) => looseEqual(variant, key, loose))))
      ?? goldKeys.find((item) =>
        !matchedGoldIds.has(item.id)
        && variants.some((variant) => evidenceMentions(item.quotes, variant)));
    if (hit) {
      matchedGoldIds.add(hit.id);
      scored += 1;
      hits += 1;
      continue;
    }
    const disputed = disputedKeys.find((item) =>
      item.keys.some((key) => variants.some((variant) => looseEqual(variant, key, loose))));
    if (disputed) {
      disputedHits.push(raw);
      continue;
    }
    const excluded = excludedKeys.find((item) =>
      item.keys.some((key) => variants.some((variant) => looseEqual(variant, key, loose))));
    if (excluded) excludedHits.push(raw);
    falsePositives.push(raw);
    scored += 1;
  }

  return {
    precision: scored === 0 ? 0 : hits / scored,
    recall: gold.items.length === 0 ? 1 : matchedGoldIds.size / gold.items.length,
    predictedCount: predicted.length,
    goldCount: gold.items.length,
    matchedGoldIds: [...matchedGoldIds],
    missedGoldIds: gold.items.map((item) => item.id).filter((id) => !matchedGoldIds.has(id)),
    falsePositives,
    disputedHits,
    excludedHits,
  };
}

export interface Dispersion {
  mean: number | null;
  stdev: number | null;
  /** 变异系数 = 标准差 / 均值。只有一次运行时无从谈起,报 null。 */
  cv: number | null;
  min: number | null;
  max: number | null;
}

export function dispersion(values: number[]): Dispersion {
  if (values.length === 0) return { mean: null, stdev: null, cv: null, min: null, max: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const stdev = Math.sqrt(variance);
  return {
    mean,
    stdev,
    cv: values.length < 2 ? null : (mean === 0 ? 0 : stdev / mean),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** 几次运行拆出来的集合有多像:两两 Jaccard 的平均值。只有一次运行时报 null。 */
export function setStability(runs: string[][]): number | null {
  if (runs.length < 2) return null;
  const sets = runs.map((run) => new Set(run.map(normalizeName)));
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const left = sets[i]!;
      const right = sets[j]!;
      const intersection = [...left].filter((value) => right.has(value)).length;
      const union = new Set([...left, ...right]).size;
      total += union === 0 ? 1 : intersection / union;
      pairs += 1;
    }
  }
  return total / pairs;
}

export interface EpisodeModelScore {
  episodeId: string;
  modelId: string;
  attempts: number;
  successes: number;
  successRate: number;
  failureReasons: string[];
  failureKinds: Record<string, number>;
  rejectedToolCalls: number;
  scenes: Dispersion;
  shots: Dispersion;
  characters: Dispersion;
  goldScenes: number;
  goldShots: number;
  /** 场数与金标完全一致的运行次数。按次算,不拿几次的均值去和整数比。 */
  sceneExactRuns: number;
  characterSetStability: number | null;
  /** 逐次打分后取平均。只算成功的那几次——失败的运行没有可评的产物。 */
  precision: { character: number; location: number; prop: number; overall: number } | null;
  recall: { character: number; location: number; prop: number; overall: number } | null;
  excludedHits: string[];
  missedGold: string[];
  durationMsMean: number | null;
  inputTokensMean: number | null;
  outputTokensMean: number | null;
}

export interface ModelSummary {
  modelId: string;
  model: string;
  channel: string;
  attempts: number;
  successes: number;
  successRate: number;
  failureKinds: Record<string, number>;
  precision: { character: number; location: number; prop: number; overall: number } | null;
  recall: { character: number; location: number; prop: number; overall: number } | null;
  sceneCountExactRate: number | null;
  sceneCountMae: number | null;
  shotCountRatio: number | null;
  characterSetStability: number | null;
  rejectedToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMsMean: number | null;
  costYuan: number | null;
  costSource: string | null;
}

export interface EvalReportData {
  perEpisode: EpisodeModelScore[];
  perModel: ModelSummary[];
}

export interface GoldBundle {
  asset: Map<string, GoldAssetEpisode>;
  scene: Map<string, GoldSceneEpisode>;
}

function countKinds(runs: EvalRunRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of runs) {
    if (record.ok || !record.failureKind) continue;
    counts[record.failureKind] = (counts[record.failureKind] ?? 0) + 1;
  }
  return counts;
}

function averageOrNull(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function draftNames(record: EvalRunRecord): { character: string[]; location: string[]; prop: string[] } {
  const candidates = record.draft.assetCandidates;
  return {
    character: (candidates?.characters ?? []).map((item) => item.name),
    location: (candidates?.scenes ?? []).map((item) => item.name),
    prop: (candidates?.props ?? []).map((item) => item.name),
  };
}

function goldTarget(gold: GoldAssetEpisode, kind: "character" | "location" | "prop"): MatchTarget {
  return {
    items: gold.assets[kind].map((item) => ({
      ...item,
      evidenceQuotes: (item.evidence ?? []).map((entry) => entry.quote),
    })),
    excluded: gold.excluded.filter((item) => item.kind === kind),
    disputed: gold.disputed.filter((item) => item.kind === kind),
  };
}

export function scoreAll(input: {
  records: EvalRunRecord[];
  gold: GoldBundle;
  models: EvalModelSpec[];
}): EvalReportData {
  const perEpisode: EpisodeModelScore[] = [];
  const episodeIds = [...new Set(input.records.map((record) => record.episodeId))].sort();

  for (const spec of input.models) {
    for (const episodeId of episodeIds) {
      const runs = input.records
        .filter((record) => record.modelId === spec.id && record.episodeId === episodeId)
        .sort((left, right) => left.attempt - right.attempt);
      if (runs.length === 0) continue;
      const ok = runs.filter((record) => record.ok);
      const assetGold = input.gold.asset.get(episodeId);
      const sceneGold = input.gold.scene.get(episodeId);

      const matched = ok.map((record) => {
        const names = draftNames(record);
        return {
          character: matchNames(names.character, goldTarget(assetGold!, "character")),
          location: matchNames(names.location, goldTarget(assetGold!, "location"), { loose: true }),
          prop: matchNames(names.prop, goldTarget(assetGold!, "prop")),
        };
      });

      const overall = (pick: (result: MatchResult) => number) =>
        averageOrNull(matched.flatMap((entry) => [pick(entry.character), pick(entry.location), pick(entry.prop)]));

      perEpisode.push({
        episodeId,
        modelId: spec.id,
        attempts: runs.length,
        successes: ok.length,
        successRate: ok.length / runs.length,
        failureReasons: runs.filter((record) => !record.ok).map((record) => record.failureReason ?? "未知"),
        failureKinds: countKinds(runs),
        rejectedToolCalls: runs.reduce((sum, record) => sum + record.rejectedToolCalls, 0),
        scenes: dispersion(ok.map((record) => record.draft.sceneDivisions?.length ?? 0)),
        shots: dispersion(ok.map((record) => record.draft.shotCandidates?.length ?? 0)),
        characters: dispersion(ok.map((record) => record.draft.assetCandidates?.characters.length ?? 0)),
        goldScenes: sceneGold?.counts.scenes ?? 0,
        goldShots: sceneGold?.counts.shots ?? 0,
        sceneExactRuns: sceneGold
          ? ok.filter((record) => (record.draft.sceneDivisions?.length ?? 0) === sceneGold.counts.scenes).length
          : 0,
        characterSetStability: setStability(ok.map((record) => draftNames(record).character)),
        precision: matched.length === 0 ? null : {
          character: averageOrNull(matched.map((entry) => entry.character.precision))!,
          location: averageOrNull(matched.map((entry) => entry.location.precision))!,
          prop: averageOrNull(matched.map((entry) => entry.prop.precision))!,
          overall: overall((result) => result.precision)!,
        },
        recall: matched.length === 0 ? null : {
          character: averageOrNull(matched.map((entry) => entry.character.recall))!,
          location: averageOrNull(matched.map((entry) => entry.location.recall))!,
          prop: averageOrNull(matched.map((entry) => entry.prop.recall))!,
          overall: overall((result) => result.recall)!,
        },
        excludedHits: [...new Set(matched.flatMap((entry) =>
          [...entry.character.excludedHits, ...entry.location.excludedHits, ...entry.prop.excludedHits]))],
        missedGold: [...new Set(matched.flatMap((entry) =>
          [...entry.character.missedGoldIds, ...entry.location.missedGoldIds, ...entry.prop.missedGoldIds]))],
        durationMsMean: averageOrNull(runs.map((record) => record.durationMs)),
        inputTokensMean: averageOrNull(runs.map((record) => record.inputTokens)),
        outputTokensMean: averageOrNull(runs.map((record) => record.outputTokens)),
      });
    }
  }

  const perModel = input.models.map((spec) => {
    const rows = perEpisode.filter((row) => row.modelId === spec.id);
    const runs = input.records.filter((record) => record.modelId === spec.id);
    const scored = rows.filter((row) => row.precision !== null);
    const withScenes = rows.filter((row) => row.scenes.mean !== null && row.goldScenes > 0);
    const inputTokens = runs.reduce((sum, record) => sum + record.inputTokens, 0);
    const outputTokens = runs.reduce((sum, record) => sum + record.outputTokens, 0);
    const price = spec.pricePerMillion;
    return {
      modelId: spec.id,
      model: spec.model,
      channel: spec.channel,
      attempts: runs.length,
      successes: runs.filter((record) => record.ok).length,
      successRate: runs.length === 0 ? 0 : runs.filter((record) => record.ok).length / runs.length,
      failureKinds: countKinds(runs),
      precision: scored.length === 0 ? null : {
        character: averageOrNull(scored.map((row) => row.precision!.character))!,
        location: averageOrNull(scored.map((row) => row.precision!.location))!,
        prop: averageOrNull(scored.map((row) => row.precision!.prop))!,
        overall: averageOrNull(scored.map((row) => row.precision!.overall))!,
      },
      recall: scored.length === 0 ? null : {
        character: averageOrNull(scored.map((row) => row.recall!.character))!,
        location: averageOrNull(scored.map((row) => row.recall!.location))!,
        prop: averageOrNull(scored.map((row) => row.recall!.prop))!,
        overall: averageOrNull(scored.map((row) => row.recall!.overall))!,
      },
      sceneCountExactRate: withScenes.length === 0 ? null
        : withScenes.reduce((sum, row) => sum + row.sceneExactRuns, 0)
          / withScenes.reduce((sum, row) => sum + row.successes, 0),
      sceneCountMae: averageOrNull(withScenes.map((row) => Math.abs(row.scenes.mean! - row.goldScenes))),
      shotCountRatio: averageOrNull(rows
        .filter((row) => row.shots.mean !== null && row.goldShots > 0)
        .map((row) => row.shots.mean! / row.goldShots)),
      characterSetStability: averageOrNull(rows
        .map((row) => row.characterSetStability)
        .filter((value): value is number => value !== null)),
      rejectedToolCalls: runs.reduce((sum, record) => sum + record.rejectedToolCalls, 0),
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      durationMsMean: averageOrNull(runs.map((record) => record.durationMs)),
      costYuan: price.input === null || price.output === null ? null
        : (inputTokens * price.input + outputTokens * price.output) / 1_000_000,
      costSource: price.source,
    };
  });

  return { perEpisode, perModel };
}
