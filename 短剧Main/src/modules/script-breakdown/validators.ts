import type {
  ApprovedAssetSummary,
  AssetCandidateKind,
  DraftValidation,
  ScriptBreakdownDraft,
  ShotCandidate,
  UnmatchedAsset,
  DuplicateCoverage,
  ValidationIssue,
} from "./types.js";
import { SHOTS_TOTAL_MAX } from "./schemas.js";

/**
 * 运行级校验合同:结构完整性(硬,不过就是整次运行失败)+ 供人检查的警告
 * (软,不阻断草稿)。
 *
 * 填充过程中工作台已经逐格把过关,但**续跑时接进来的草稿不会再过一遍
 * 工作台**——所以这里是最后一道闸,不是装饰。
 */

export interface RunValidationInput {
  draft: Required<Pick<ScriptBreakdownDraft, "sceneDivisions" | "assetCandidates" | "shotCandidates">>;
  lineCount: number;
  approvedAssets: ApprovedAssetSummary[];
  targetDurationSec: number | null;
}

export interface RunValidationResult {
  /** 结构完整性问题:非空则运行失败,不进 draft。 */
  hardIssues: ValidationIssue[];
  /** 草稿随附的校验结果:警告供人检查,不阻断。 */
  validation: DraftValidation;
}

const DURATION_DEVIATION_RATIO = 0.2;
const MAX_UNMATCHED_LISTED = 50;
const MAX_DUPLICATE_LISTED = 50;
const MAX_UNCOVERED_LISTED = 20;

export function validateRunDraft(input: RunValidationInput): RunValidationResult {
  const hardIssues: ValidationIssue[] = [];
  const warningIssues: ValidationIssue[] = [];
  const { sceneDivisions, assetCandidates, shotCandidates } = input.draft;

  // —— 硬校验:全局镜号连续、候选 ID 唯一、场引用合法、行引用不出场界。
  const seenCandidateIds = new Set<string>();
  for (const shot of shotCandidates) {
    if (seenCandidateIds.has(shot.candidateId)) {
      hardIssues.push({ code: "candidate_id_duplicate", message: `分镜候选 "${shot.candidateId}" 重复` });
    }
    seenCandidateIds.add(shot.candidateId);
  }
  for (const [index, shot] of shotCandidates.entries()) {
    if (shot.shotNo !== index + 1) {
      hardIssues.push({ code: "shot_no_not_continuous", message: `第 ${index + 1} 个镜头的 shot_no 是 ${shot.shotNo}` });
      break;
    }
  }
  if (shotCandidates.length > SHOTS_TOTAL_MAX) {
    hardIssues.push({ code: "shots_total_exceeded", message: `分镜总数 ${shotCandidates.length} 超过上限 ${SHOTS_TOTAL_MAX}` });
  }
  const sceneByIndex = new Map(sceneDivisions.map((scene) => [scene.sceneIndex, scene]));
  for (const shot of shotCandidates) {
    const scene = sceneByIndex.get(shot.sceneIndex);
    if (!scene) {
      hardIssues.push({ code: "scene_index_unknown", message: `镜头 ${shot.candidateId} 引用了不存在的场 ${shot.sceneIndex}` });
      continue;
    }
    if (shot.lineIndices.some((line) => line < scene.startLineIndex || line > scene.endLineIndex)) {
      hardIssues.push({ code: "line_index_out_of_scene", message: `镜头 ${shot.candidateId} 的行引用超出场 ${shot.sceneIndex} 的范围` });
    }
  }

  // —— 软校验:供人检查的警告。
  const shotCountByScene = new Map<number, number>();
  for (const shot of shotCandidates) {
    shotCountByScene.set(shot.sceneIndex, (shotCountByScene.get(shot.sceneIndex) ?? 0) + 1);
  }
  for (const scene of sceneDivisions) {
    if (!shotCountByScene.has(scene.sceneIndex)) {
      warningIssues.push({ code: "scene_without_shots", message: `场 ${scene.sceneIndex} 没有任何分镜,确认前请人工检查` });
    }
  }

  const coveredLines = new Set<number>();
  for (const shot of shotCandidates) for (const line of shot.lineIndices) coveredLines.add(line);
  const uncovered: number[] = [];
  for (let lineIndex = 0; lineIndex < input.lineCount; lineIndex += 1) {
    if (!coveredLines.has(lineIndex)) uncovered.push(lineIndex);
  }
  if (uncovered.length > 0) {
    const listed = uncovered.slice(0, MAX_UNCOVERED_LISTED).join(", ");
    warningIssues.push({
      code: "lines_without_shots",
      message: `${uncovered.length} 行剧本未被任何分镜覆盖(行号:${listed}${uncovered.length > MAX_UNCOVERED_LISTED ? " …" : ""})`,
    });
  }

  const duplicateCoverage = collectDuplicateCoverage(shotCandidates);
  if (duplicateCoverage.length > 0) {
    warningIssues.push({
      code: "duplicate_line_coverage",
      message: `${duplicateCoverage.length} 行被相邻分镜重复引用,请人工确认是否有意为之`,
    });
  }

  const unmatchedAssets = collectUnmatchedAssets(shotCandidates, assetCandidates, input.approvedAssets);
  if (unmatchedAssets.length > 0) {
    warningIssues.push({
      code: "unmatched_asset_names",
      message: `${unmatchedAssets.length} 个资产名称不在本次候选或已通过项目资产中,确认时不会绑定正式资产`,
    });
  }

  const totalDurationSec = shotCandidates.reduce((sum, shot) => sum + shot.durationSec, 0);
  if (input.targetDurationSec && shotCandidates.length > 0) {
    const deviation = Math.abs(totalDurationSec - input.targetDurationSec) / input.targetDurationSec;
    if (deviation > DURATION_DEVIATION_RATIO) {
      warningIssues.push({
        code: "duration_deviation",
        message: `分镜总时长 ${totalDurationSec} 秒,偏离目标 ${input.targetDurationSec} 秒超过 ${Math.round(DURATION_DEVIATION_RATIO * 100)}%`,
      });
    }
  }

  const hasWarnings = warningIssues.length > 0;
  return {
    hardIssues,
    validation: {
      status: hasWarnings ? "pass_with_warnings" : "pass",
      issues: warningIssues,
      unmatchedAssets,
      duplicateCoverage,
      shotCount: shotCandidates.length,
      totalDurationSec,
    },
  };
}

export function collectUnmatchedAssets(
  shotCandidates: ShotCandidate[],
  assetCandidates: ScriptBreakdownDraft["assetCandidates"],
  approvedAssets: ApprovedAssetSummary[],
): UnmatchedAsset[] {
  const known: Record<AssetCandidateKind, Set<string>> = {
    character: new Set(assetCandidates?.characters?.map((item) => item.name) ?? []),
    scene: new Set(assetCandidates?.scenes?.map((item) => item.name) ?? []),
    prop: new Set(assetCandidates?.props?.map((item) => item.name) ?? []),
    costume: new Set(assetCandidates?.costumes?.map((item) => item.name) ?? []),
    audio: new Set(assetCandidates?.audios?.map((item) => item.name) ?? []),
  };
  for (const asset of approvedAssets) {
    if (
      asset.assetKind === "character" || asset.assetKind === "scene" || asset.assetKind === "prop"
      || asset.assetKind === "costume" || asset.assetKind === "audio"
    ) {
      known[asset.assetKind].add(asset.name);
    }
  }
  const unmatched = new Map<string, UnmatchedAsset>();
  const record = (kind: AssetCandidateKind, name: string, candidateId: string) => {
    if (known[kind].has(name)) return;
    const key = `${kind}:${name}`;
    const entry = unmatched.get(key) ?? { kind, name, shotCandidateIds: [] };
    if (entry.shotCandidateIds.length < MAX_UNMATCHED_LISTED) entry.shotCandidateIds.push(candidateId);
    unmatched.set(key, entry);
  };
  for (const shot of shotCandidates) {
    for (const name of shot.characterNames) record("character", name, shot.candidateId);
    for (const name of shot.sceneNames) record("scene", name, shot.candidateId);
    for (const name of shot.propNames) record("prop", name, shot.candidateId);
    for (const name of shot.costumeNames ?? []) record("costume", name, shot.candidateId);
  }
  return [...unmatched.values()];
}

export function collectDuplicateCoverage(shotCandidates: ShotCandidate[]): DuplicateCoverage[] {
  const byLine = new Map<number, string[]>();
  for (const shot of shotCandidates) {
    for (const lineIndex of shot.lineIndices) {
      const list = byLine.get(lineIndex) ?? [];
      list.push(shot.candidateId);
      byLine.set(lineIndex, list);
    }
  }
  const duplicates: DuplicateCoverage[] = [];
  for (const [lineIndex, shotCandidateIds] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    if (shotCandidateIds.length > 1 && duplicates.length < MAX_DUPLICATE_LISTED) {
      duplicates.push({ lineIndex, shotCandidateIds });
    }
  }
  return duplicates;
}
