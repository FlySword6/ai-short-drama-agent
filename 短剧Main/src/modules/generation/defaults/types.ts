export const generationDefaultMediaKinds = ["image", "video", "audio"] as const;
export type GenerationDefaultMediaKind = (typeof generationDefaultMediaKinds)[number];

/**
 * 默认策略的「生成模式」:direct_reference = 直接引用参考素材;material_to_prompt =
 * 素材转提示词;text_to_speech = 音频 TTS(文本+音色直接合成,无参考素材概念)。
 */
export const generationDefaultModes = ["direct_reference", "material_to_prompt", "text_to_speech"] as const;
export type GenerationDefaultMode = (typeof generationDefaultModes)[number];

export interface GenerationDefaultStrategy {
  id: string;
  projectId: string;
  mediaKind: GenerationDefaultMediaKind;
  mode: GenerationDefaultMode;
  modelKey: string;
  parameters: Record<string, unknown>;
  sourceGenerationRequestId: string | null;
  updatedByUserId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PutGenerationDefaultStrategyInput {
  mediaKind: GenerationDefaultMediaKind;
  mode: GenerationDefaultMode;
  modelKey: string;
  parameters: Record<string, unknown>;
  sourceGenerationRequestId?: string | null;
  expectedVersion: number;
}
