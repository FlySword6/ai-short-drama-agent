/**
 * No-BGM native-audio template for vNext Seedance 2.5 generation.
 *
 * "Native audio" means the model generates dialogue, narration, ambience, and
 * action SFX from the scene content — with BGM disabled by default.
 *
 * This template is the only place that decides whether BGM is on or off.
 * Consumers must pass their noBgm flag through applyNoBgmTemplate; they must
 * not construct the provider request parameters directly.
 */


/** Natural-language prompt suffix that constrains the model to no-BGM audio. */
export const NO_BGM_AUDIO_CONSTRAINT =
  "音频约束：仅保留人物对话、叙述旁白、环境音效与动作音效；禁止生成背景音乐（BGM）。";

export interface NoBgmTemplateInput {
  prompt: string;
  noBgm: boolean;
  parameters: Record<string, unknown>;
}

export interface NoBgmTemplateOutput {
  prompt: string;
  /** generate_audio flag for the Seedance 2.5 provider payload. */
  generateAudio: boolean;
  /** Resolved parameters safe to forward to the provider. */
  parameters: Record<string, unknown>;
}

/**
 * Apply the no-BGM template.
 *
 * When noBgm is true (the default):
 *  - Appends the no-BGM audio constraint to the prompt.
 *  - Sets generate_audio: true so native audio is produced.
 *  - Strips any bgm/background_music parameter that a caller might have snuck in.
 *
 * When noBgm is false (explicit opt-out, requires deliberate override):
 *  - Passes the prompt and parameters through unchanged.
 *  - generate_audio: true is still set; the model may include BGM.
 */
export function applyNoBgmTemplate(input: NoBgmTemplateInput): NoBgmTemplateOutput {
  const { bgm: _bgm, background_music: _bm, ...safeParams } = input.parameters;
  if (input.noBgm) {
    return {
      prompt: joinPromptSegments(input.prompt, NO_BGM_AUDIO_CONSTRAINT),
      generateAudio: true,
      parameters: safeParams,
    };
  }
  // Explicit opt-out: still enable audio; caller owns the BGM decision.
  return {
    prompt: input.prompt,
    generateAudio: true,
    parameters: safeParams,
  };
}


function joinPromptSegments(...parts: string[]): string {
  return parts.filter(Boolean).join("\n");
}
