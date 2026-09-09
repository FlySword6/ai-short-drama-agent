import {
  ASSETS_PER_KIND_MAX,
  SCENES_MAX,
} from "../schemas.js";
import { validateRunDraft } from "../validators.js";
import type {
  ApprovedAssetSummary,
  AssetCandidates,
  AudioCandidateKind,
  CharacterAgeStage,
  DraftValidation,
  PrelinkedCharacterAsset,
  SceneDivision,
  ScriptBreakdownDraft,
  ScriptLine,
  ShotCandidate,
} from "../types.js";

/**
 * 拆解填充工作台。
 *
 * 这是「agent 往框架里填」的框架那一半:每个方法对应一次工具调用,当场判
 * 这一格合不合法。合法就落进草稿并给一句人话;不合法就拒绝并说清该怎么改。
 *
 * 为什么编号由这里分配而不是让模型给:场号、镜号、候选 ID 全是可以从填充
 * 顺序确定性算出来的,让模型报只会多出一整类「编号对不上」的失败,而这类
 * 失败它自己也修不好。模型只负责它真正知道的事——内容。
 */

export interface WorkspaceContext {
  scriptLines: ScriptLine[];
  approvedAssets: ApprovedAssetSummary[];
  targetDurationSec: number | null;
}

export interface FillProgress {
  hasStoryOutline: boolean;
  sceneCount: number;
  characterCount: number;
  locationCount: number;
  propCount: number;
  costumeCount: number;
  audioCount: number;
  shotCount: number;
  nextSceneStartLineIndex: number | null;
}

export type FillOutcome =
  | { status: "accepted"; description: string; progress: FillProgress }
  | { status: "rejected"; description: string; reason: string; progress: FillProgress };

export interface StoryOutlineInput {
  summary: string;
}

export interface SceneInput {
  name?: string | null;
  summary: string;
  startLineIndex: number;
  endLineIndex: number;
}

export interface AssetInput {
  name: string;
  description?: string | null;
}

export interface CharacterInput extends AssetInput {
  gender?: string | null;
  ageValue?: number | null;
  ageStage?: CharacterAgeStage | null;
  appearance?: string | null;
  personalityTags?: string[];
}

export interface CostumeInput extends AssetInput {
  wearerNames?: string[];
  style?: string | null;
  color?: string | null;
  material?: string | null;
  occasion?: string | null;
}

export interface AudioInput extends AssetInput {
  audioKind: AudioCandidateKind;
  speakerNames?: string[];
  sceneContext?: string | null;
  emotion?: string | null;
  durationHint?: string | null;
  transcriptSnippet?: string | null;
  soundCueText?: string | null;
}


const STORY_SUMMARY_MAX = 2_000;
const SCENE_SUMMARY_MAX = 500;
const ASSET_NAME_MAX = 80;
const ASSET_DESCRIPTION_MAX = 500;

export class BreakdownWorkspace {
  private storySummary: string | undefined;
  private readonly scenes: SceneDivision[] = [];
  private readonly characters: AssetCandidates["characters"] = [];
  private readonly locations: AssetCandidates["scenes"] = [];
  private readonly props: AssetCandidates["props"] = [];
  private readonly costumes: AssetCandidates["costumes"] = [];
  private readonly audios: AssetCandidates["audios"] = [];
  private readonly shots: ShotCandidate[] = [];

  constructor(private readonly context: WorkspaceContext, restored?: ScriptBreakdownDraft) {
    if (!restored) return;
    this.storySummary = restored.storySummary;
    this.scenes.push(...(restored.sceneDivisions ?? []));
    this.characters.push(...(restored.assetCandidates?.characters ?? []));
    this.locations.push(...(restored.assetCandidates?.scenes ?? []));
    this.props.push(...(restored.assetCandidates?.props ?? []));
    this.costumes.push(...(restored.assetCandidates?.costumes ?? []));
    this.audios.push(...(restored.assetCandidates?.audios ?? []));
    this.shots.push(...(restored.shotCandidates ?? []));
  }

  get draft(): ScriptBreakdownDraft {
    return {
      ...(this.storySummary === undefined ? {} : { storySummary: this.storySummary }),
      ...(this.scenes.length > 0 ? { sceneDivisions: [...this.scenes] } : {}),
      ...(this.hasAnyAsset() ? {
        assetCandidates: {
          characters: [...this.characters],
          scenes: [...this.locations],
          props: [...this.props],
          costumes: [...this.costumes],
          audios: [...this.audios],
        },
      } : {}),
      ...(this.shots.length > 0 ? { shotCandidates: [...this.shots] } : {}),
    };
  }

  get progress(): FillProgress {
    const covered = this.scenes.at(-1)?.endLineIndex ?? -1;
    const nextStart = covered + 1;
    return {
      hasStoryOutline: this.storySummary !== undefined,
      sceneCount: this.scenes.length,
      characterCount: this.characters.length,
      locationCount: this.locations.length,
      propCount: this.props.length,
      costumeCount: this.costumes.length,
      audioCount: this.audios.length,
      shotCount: this.shots.length,
      nextSceneStartLineIndex: nextStart >= this.context.scriptLines.length ? null : nextStart,
    };
  }

  setStoryOutline(input: StoryOutlineInput): FillOutcome {
    const summary = input.summary?.trim() ?? "";
    if (!summary) return this.reject("整理故事梗概", "梗概不能为空。");
    if (summary.length > STORY_SUMMARY_MAX) {
      return this.reject("整理故事梗概", `梗概最多 ${STORY_SUMMARY_MAX} 字,现在有 ${summary.length} 字,请压缩后重写。`);
    }
    this.storySummary = summary;
    return this.accept("已写好这一集的故事梗概");
  }

  addScene(input: SceneInput): FillOutcome {
    const sceneIndex = this.scenes.length;
    const label = `拆出第 ${sceneIndex + 1} 场`;
    const summary = input.summary?.trim() ?? "";
    if (!summary) return this.reject(label, "这一场要写一句内容概括。");
    if (summary.length > SCENE_SUMMARY_MAX) {
      return this.reject(label, `场次概括最多 ${SCENE_SUMMARY_MAX} 字,请压缩后重写。`);
    }
    if (this.scenes.length >= SCENES_MAX) {
      return this.reject(label, `一集最多 ${SCENES_MAX} 场,已经填满,请先合并已有场次。`);
    }
    const expectedStart = this.progress.nextSceneStartLineIndex;
    if (expectedStart === null) {
      return this.reject(label, "剧本所有内容都已经归入场次,不需要再加场了。");
    }
    if (input.startLineIndex !== expectedStart) {
      return this.reject(
        label,
        `场次必须按顺序把剧本铺满:这一场要从第 ${expectedStart} 行开始,收到的是第 ${input.startLineIndex} 行。`,
      );
    }
    if (input.endLineIndex < input.startLineIndex) {
      return this.reject(label, `结束行 ${input.endLineIndex} 在起始行 ${input.startLineIndex} 之前,请检查行号。`);
    }
    const lastLine = this.context.scriptLines.length - 1;
    if (input.endLineIndex > lastLine) {
      return this.reject(label, `剧本只有 ${this.context.scriptLines.length} 行(最后一行是第 ${lastLine} 行),这一场结束行超出了范围。`);
    }
    const name = input.name?.trim() || null;
    this.scenes.push({
      sceneIndex,
      name,
      summary,
      startLineIndex: input.startLineIndex,
      endLineIndex: input.endLineIndex,
    });
    return this.accept(`已拆出第 ${sceneIndex + 1} 场${name ? `「${name}」` : ""}:${summary}`);
  }

  addCharacter(input: CharacterInput): FillOutcome {
    const checked = this.checkAssetInput("角色", input, this.characters.length);
    if (checked.rejection) return checked.rejection;
    this.characters.push({
      candidateId: `char_${serial(this.characters.length + 1)}`,
      name: checked.name,
      description: checked.description,
      gender: trimmedOrNull(input.gender),
      ageValue: Number.isInteger(input.ageValue) ? input.ageValue as number : null,
      ageStage: input.ageStage ?? null,
      appearance: trimmedOrNull(input.appearance),
      personalityTags: (input.personalityTags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 12),
      prelinkedAsset: this.prelinkedCharacter(checked.name),
    });
    return this.accept(`已认出角色「${checked.name}」`);
  }

  addLocation(input: AssetInput): FillOutcome {
    const checked = this.checkAssetInput("场景", input, this.locations.length);
    if (checked.rejection) return checked.rejection;
    this.locations.push({
      candidateId: `scene_${serial(this.locations.length + 1)}`,
      name: checked.name,
      description: checked.description,
    });
    return this.accept(`已认出场景「${checked.name}」`);
  }

  addProp(input: AssetInput): FillOutcome {
    const checked = this.checkAssetInput("道具", input, this.props.length);
    if (checked.rejection) return checked.rejection;
    this.props.push({
      candidateId: `prop_${serial(this.props.length + 1)}`,
      name: checked.name,
      description: checked.description,
    });
    return this.accept(`已认出道具「${checked.name}」`);
  }

  addCostume(input: CostumeInput): FillOutcome {
    const checked = this.checkAssetInput("服装", input, this.costumes.length);
    if (checked.rejection) return checked.rejection;
    this.costumes.push({
      candidateId: `costume_${serial(this.costumes.length + 1)}`,
      name: checked.name,
      description: checked.description,
      wearerNames: (input.wearerNames ?? []).map((name) => name.trim()).filter(Boolean),
      style: trimmedOrNull(input.style),
      color: trimmedOrNull(input.color),
      material: trimmedOrNull(input.material),
      occasion: trimmedOrNull(input.occasion),
    });
    return this.accept(`已认出服装「${checked.name}」`);
  }

  addAudio(input: AudioInput): FillOutcome {
    const checked = this.checkAssetInput("音频", input, this.audios.length);
    if (checked.rejection) return checked.rejection;
    this.audios.push({
      candidateId: `audio_${serial(this.audios.length + 1)}`,
      name: checked.name,
      description: checked.description,
      audioKind: input.audioKind,
      speakerNames: (input.speakerNames ?? []).map((name) => name.trim()).filter(Boolean),
      sceneContext: trimmedOrNull(input.sceneContext),
      emotion: trimmedOrNull(input.emotion),
      durationHint: trimmedOrNull(input.durationHint),
      transcriptSnippet: trimmedOrNull(input.transcriptSnippet),
      soundCueText: trimmedOrNull(input.soundCueText),
      defaultAudioPromptSeed: null,
    });
    return this.accept(`已认出音频「${checked.name}」`);
  }

  /**
   * P6 阶段②落镜:服务层把 skill 单次结构化输出解析出的分镜整体写进工作台。
   * 不走工具逐格校验——阶段②有自己的解析合同(storyboard-parse.ts),
   * 这里只负责接住结果,续跑时草稿里的镜头同样经此恢复。
   */
  applyStoryboardShots(shots: ShotCandidate[]): void {
    this.shots.length = 0;
    this.shots.push(...shots);
  }

  /**
   * 收尾:agent 声明拆完了。这一步只判「能不能交」,不再改内容——
   * 交不了就把还差什么说清楚,agent 补完再收一次尾。
   */
  finish(): FillOutcome {
    if (this.scenes.length === 0) {
      return this.reject("完成拆解", "还没有拆出任何场次。");
    }
    if (this.storySummary === undefined) {
      return this.reject("完成拆解", "还没有写这一集的故事梗概。");
    }
    const uncoveredFrom = this.progress.nextSceneStartLineIndex;
    if (uncoveredFrom !== null) {
      return this.reject(
        "完成拆解",
        `第 ${uncoveredFrom} 行往后的剧本还没有归入任何场次,请继续加场。`,
      );
    }
    // P6:镜头不在阶段①产出——场次与资产齐了即可收尾,分镜由阶段②
    // (skill 单次结构化输出)一次生成,不再要求 agent 逐镜填完才能交。
    return this.accept(`拆解完成:${this.scenes.length} 场,资产 ${this.progress.characterCount + this.progress.locationCount + this.progress.propCount + this.progress.costumeCount + this.progress.audioCount} 个`);
  }

  /** 运行级校验结果,供服务层决定草稿能不能交给人确认。 */
  validate(): ReturnType<typeof validateRunDraft> {
    return validateRunDraft({
      draft: {
        sceneDivisions: [...this.scenes],
        assetCandidates: {
          characters: [...this.characters],
          scenes: [...this.locations],
          props: [...this.props],
          costumes: [...this.costumes],
          audios: [...this.audios],
        },
        shotCandidates: [...this.shots],
      },
      lineCount: this.context.scriptLines.length,
      approvedAssets: this.context.approvedAssets,
      targetDurationSec: this.context.targetDurationSec,
    });
  }

  private hasAnyAsset(): boolean {
    return this.characters.length > 0
      || this.locations.length > 0
      || this.props.length > 0
      || this.costumes.length > 0
      || this.audios.length > 0;
  }

  private prelinkedCharacter(name: string): AssetCandidates["characters"][number]["prelinkedAsset"] {
    return prelinkedCharacterAsset(name, this.context.approvedAssets);
  }

  private checkAssetInput(
    kind: "角色" | "场景" | "道具" | "服装" | "音频",
    input: AssetInput,
    existingCount: number,
  ): { rejection?: FillOutcome; name: string; description: string | null } {
    const label = `登记${kind}`;
    const name = input.name?.trim() ?? "";
    const description = boundedOrNull(input.description, ASSET_DESCRIPTION_MAX);
    if (!name) return { rejection: this.reject(label, `${kind}名称不能为空。`), name, description };
    if (name.length > ASSET_NAME_MAX) {
      return {
        rejection: this.reject(label, `${kind}名称最多 ${ASSET_NAME_MAX} 个字,请用剧本里的称呼。`),
        name,
        description,
      };
    }
    if (existingCount >= ASSETS_PER_KIND_MAX) {
      return { rejection: this.reject(label, `${kind}最多登记 ${ASSETS_PER_KIND_MAX} 个,已经填满。`), name, description };
    }
    if (description !== null && this.context.scriptLines.some((line) => line.text === description)) {
      // P5(九.1)硬校验兜底:提示词要求实体描述不照抄剧本原句,模型仍照抄时
      // 退回重写,让「描述 ≠ 剧本原文」成为硬约束而非只靠提示词。
      return {
        rejection: this.reject(
          label,
          `${kind}的 description 照抄了剧本原行。改写成这个${kind}的实体描述(剧本里真有的特征),剧本没写就给 null。`,
        ),
        name,
        description,
      };
    }
    if (this.namesOf(kind).includes(name)) {
      return { rejection: this.reject(label, `${kind}「${name}」已经登记过了,不要重复登记。`), name, description };
    }
    return { name, description };
  }

  private namesOf(kind: "角色" | "场景" | "道具" | "服装" | "音频"): string[] {
    if (kind === "角色") return this.characters.map((item) => item.name);
    if (kind === "场景") return this.locations.map((item) => item.name);
    if (kind === "道具") return this.props.map((item) => item.name);
    if (kind === "服装") return this.costumes.map((item) => item.name);
    return this.audios.map((item) => item.name);
  }

  private accept(description: string): FillOutcome {
    return { status: "accepted", description, progress: this.progress };
  }

  private reject(description: string, reason: string): FillOutcome {
    return { status: "rejected", description, reason, progress: this.progress };
  }
}

export function draftValidationOf(workspace: BreakdownWorkspace): DraftValidation {
  return workspace.validate().validation;
}

/**
 * 只有项目里恰好一条同名已通过角色时才提示绑定。同名多条是歧义,静默任选
 * 一个会把两个人当成一个人——宁可不提示,留给人工确认。
 *
 * 工作台和服务层都用这一份:工作台算的是给模型看的提示,服务层收尾时拿
 * 未截断清单重算一遍才作数。
 */
export function prelinkedCharacterAsset(
  name: string,
  approvedAssets: ApprovedAssetSummary[],
): PrelinkedCharacterAsset | null {
  const matches = approvedAssets.filter(
    (asset) => asset.assetKind === "character" && asset.name === name,
  );
  const only = matches.length === 1 ? matches[0]! : undefined;
  return only ? { assetEntityId: only.assetEntityId, name: only.name, matchedBy: "exact_name" } : null;
}

function serial(value: number): string {
  return String(value).padStart(3, "0");
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function boundedOrNull(value: string | null | undefined, max: number): string | null {
  const trimmed = trimmedOrNull(value);
  return trimmed === null ? null : trimmed.slice(0, max);
}
