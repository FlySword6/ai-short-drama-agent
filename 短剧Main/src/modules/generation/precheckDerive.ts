/**
 * 从 PromptCompilationContext 派生 PrecheckInput 的辅助函数。
 * 规划文档: docs/planning/generation-precheck-cost-control.md §5.2 附录 C
 *
 * 三个 derive 函数源码中此前不存在,此处新建。
 * 数据源: PromptCompilationContext (repository.resolvePromptCompilationContext 产物),
 * 它的字段来自 shots 表 breakdownElements + directorPrompt + imagePrompt + videoPrompt
 * 以及 episodes.name / scenes.description,经 promptCompiler 组装。
 */
import type { GenerationMediaKind } from "./types.js";
import type { PrecheckInput } from "./promptPrechecker.js";
import type { PromptCompilationContext } from "./promptCompiler.js";

/**
 * 从 references 中提取角色描述列表。
 * lane = "character" 的参考资产即为角色,name + description 组成一条角色描述。
 */
export function deriveCharacterDescriptions(
  context: PromptCompilationContext,
): string[] {
  const refs = context.references ?? [];
  return refs
    .filter((ref) => ref.lane === "character")
    .map((ref) => {
      const desc = ref.description?.trim();
      return desc ? `${ref.name} ${desc}` : ref.name;
    });
}

/**
 * 从 context 中提取场景描述。
 * PromptCompilationContext.sceneDescription 来自 scenes.description (经 repository 查询)。
 */
export function deriveSceneDescription(
  context: PromptCompilationContext,
): string | undefined {
  return context.sceneDescription?.trim() || undefined;
}

/**
 * 从 context 中提取镜头意图。
 * PromptCompilationContext.shotIntent 来自 shots.directorPrompt。
 * 如果有 references 中 lane = "camera_motion" 的条目,也合并进来。
 */
export function deriveShotIntent(
  context: PromptCompilationContext,
): string {
  const parts: string[] = [];
  const intent = context.shotIntent?.trim();
  if (intent) parts.push(intent);
  const cameraMotionRefs = (context.references ?? [])
    .filter((ref) => ref.lane === "camera_motion")
    .map((ref) => {
      const desc = ref.description?.trim();
      return desc ? `${ref.name} ${desc}` : ref.name;
    });
  parts.push(...cameraMotionRefs);
  return parts.join("。").trim();
}

/**
 * 从编译上下文组装 PrecheckInput。
 * autoPrompt 由调用方 (路由层) 通过 compileAutoPrompt(context) 得到后传入。
 */
export function buildPrecheckInput(params: {
  context: PromptCompilationContext;
  autoPrompt: string;
  manualPrompt?: string;
  referenceLaneCount: number;
  filledLaneCount: number;
  negativePrompt?: string;
  mediaKind: GenerationMediaKind;
}): PrecheckInput {
  return {
    autoPrompt: params.autoPrompt,
    ...(params.manualPrompt ? { manualPrompt: params.manualPrompt } : {}),
    characterDescriptions: deriveCharacterDescriptions(params.context),
    sceneDescription: deriveSceneDescription(params.context),
    shotIntent: deriveShotIntent(params.context),
    referenceLaneCount: params.referenceLaneCount,
    filledLaneCount: params.filledLaneCount,
    ...(params.negativePrompt ? { negativePrompt: params.negativePrompt } : {}),
    mediaKind: params.mediaKind,
  };
}
