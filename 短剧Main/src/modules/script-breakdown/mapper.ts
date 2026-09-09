import type {
  ApprovedAssetSummary,
  ConfirmMapping,
  MappedScene,
  MappedShot,
  SceneDivision,
  ScriptBreakdownDraft,
  ScriptLine,
  ShotCandidate,
} from "./types.js";
import { collectUnmatchedAssets } from "./validators.js";

/**
 * 草稿 → 正式 scenes/shots 的确定性映射。只在人工确认时调用;映射本身不
 * 做任何"智能"修补,校验早已在草稿阶段完成。
 */

export interface MapDraftInput {
  runId: string;
  episodeId: string;
  draft: Required<Pick<ScriptBreakdownDraft, "sceneDivisions" | "assetCandidates" | "shotCandidates">>;
  scriptLines: ScriptLine[];
  approvedAssets: ApprovedAssetSummary[];
}

export function sceneCandidateId(sceneIndex: number): string {
  return `scene_${sceneIndex}`;
}

export function mapDraftToFormal(input: MapDraftInput): ConfirmMapping {
  const linesByIndex = new Map(input.scriptLines.map((line) => [line.lineIndex, line.text]));
  const scenes: MappedScene[] = [...input.draft.sceneDivisions]
    .sort((a, b) => a.sceneIndex - b.sceneIndex)
    .map((scene) => mapScene(scene, input.runId, input.episodeId));
  const approvedByKindAndName = indexApprovedAssets(input.approvedAssets);
  const shots: MappedShot[] = [...input.draft.shotCandidates]
    .sort((a, b) => a.shotNo - b.shotNo)
    .map((shot) => mapShot(shot, linesByIndex, approvedByKindAndName, input.runId, input.episodeId));
  const unmatchedAssets = collectUnmatchedAssets(input.draft.shotCandidates, input.draft.assetCandidates, input.approvedAssets);
  return { scenes, shots, assetCandidates: input.draft.assetCandidates, unmatchedAssets };
}

function mapScene(scene: SceneDivision, runId: string, episodeId: string): MappedScene {
  return {
    candidateId: sceneCandidateId(scene.sceneIndex),
    episodeId,
    sceneNo: scene.sceneIndex + 1,
    name: scene.name,
    description: scene.summary,
    sortOrder: scene.sceneIndex,
    sourceBreakdownRunId: runId,
    sourceCandidateId: sceneCandidateId(scene.sceneIndex),
  };
}

function mapShot(
  shot: ShotCandidate,
  linesByIndex: Map<number, string>,
  approvedByKindAndName: Map<string, ApprovedAssetSummary>,
  runId: string,
  episodeId: string,
): MappedShot {
  const scriptText = shot.lineIndices
    .map((lineIndex) => linesByIndex.get(lineIndex))
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n");
  const snapshots = collectReferenceSnapshots(shot, approvedByKindAndName);
  return {
    candidateId: shot.candidateId,
    sceneCandidateId: sceneCandidateId(shot.sceneIndex),
    episodeId,
    shotCode: `G${String(shot.shotNo).padStart(2, "0")}`,
    title: null,
    scriptText: scriptText.length > 0 ? scriptText : null,
    breakdownElements: shot.elements,
    directorPrompt: shot.directorPrompt,
    imagePrompt: shot.imagePrompt,
    videoPrompt: shot.videoPrompt,
    storyboardDetail: shot.storyboardDetail ?? null,
    durationSeconds: shot.durationSec,
    sortOrder: shot.shotNo,
    referenceAssetNames: {
      characters: shot.characterNames,
      scenes: shot.sceneNames,
      props: shot.propNames,
      costumes: shot.costumeNames,
    },
    referenceAssetSnapshots: snapshots,
    sourceBreakdownRunId: runId,
    sourceCandidateId: shot.candidateId,
  };
}

function indexApprovedAssets(assets: ApprovedAssetSummary[]): Map<string, ApprovedAssetSummary> {
  const map = new Map<string, ApprovedAssetSummary>();
  const ambiguous = new Set<string>();
  for (const asset of assets) {
    const key = `${asset.assetKind}:${asset.name}`;
    if (ambiguous.has(key)) continue;
    if (map.has(key)) {
      map.delete(key);
      ambiguous.add(key);
      continue;
    }
    map.set(key, asset);
  }
  return map;
}

/**
 * 只绑定名称精确匹配的已通过项目资产;AI 候选资产留在候选区,不跟随
 * 分镜确认自动升为正式资产。未匹配项由调用方汇总报告,不静默模糊绑定。
 */
function collectReferenceSnapshots(
  shot: ShotCandidate,
  approvedByKindAndName: Map<string, ApprovedAssetSummary>,
): Array<Record<string, unknown>> {
  const snapshots: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const kinds: Array<["character" | "scene" | "prop" | "costume", string[]]> = [
    ["character", shot.characterNames],
    ["scene", shot.sceneNames],
    ["prop", shot.propNames],
    ["costume", shot.costumeNames],
  ];
  for (const [kind, names] of kinds) {
    for (const name of names) {
      const asset = approvedByKindAndName.get(`${kind}:${name}`);
      if (!asset || seen.has(asset.assetEntityId)) continue;
      seen.add(asset.assetEntityId);
      snapshots.push({
        asset_entity_id: asset.assetEntityId,
        name: asset.name,
        asset_kind: asset.assetKind,
        matched_by: "exact_name",
      });
    }
  }
  return snapshots;
}
