import type { AudioPromptDimensions, CompiledAudioPrompt } from "./types.js";
import { stripPromptTimecodes } from "../generation/promptCompiler.js";

const dimensionKeys: Array<keyof Required<AudioPromptDimensions>> = [
  "voiceReference",
  "performanceEmotion",
  "paceAndPauses",
  "languageAndAccent",
  "vocalDistance",
  "continuity",
];

/**
 * Compile the text which the TTS provider is allowed to speak. Creative
 * direction remains structured: OpenSpeech's `request.text` is a literal
 * reading slot, so labels such as "表演情绪：" must never enter this string.
 * Empty dimensions remain explicit for the provider adapter and audit trail.
 */
export function compileAudioPrompt(
  dimensions: AudioPromptDimensions,
  supplement = "",
): CompiledAudioPrompt {
  const normalized = Object.fromEntries(
    dimensionKeys.map((key) => [key, normalize(dimensions[key])]),
  ) as Required<AudioPromptDimensions>;
  return {
    version: "sound-workshop-v1",
    prompt: normalize(stripPromptTimecodes(supplement)),
    dimensions: normalized,
  };
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").slice(0, 1_000);
}
