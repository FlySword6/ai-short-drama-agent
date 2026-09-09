import { z } from "zod";
import type { GenerationParameters } from "../generation/types.js";

/**
 * Public wire contract shared by LLM interpretation and HTTP requote. Keeping
 * one schema prevents an operation card from advertising a parameter that the
 * transport cannot actually submit.
 */
export const generationRequestedParametersWireSchema = z.object({
  size: z.string().trim().min(1).max(32).optional(),
  ratio: z.string().trim().min(1).max(32).optional(),
  duration_seconds: z.number().int().positive().optional(),
  resolution: z.string().trim().min(1).max(32).optional(),
  generate_audio: z.boolean().optional(),
  sequential_image_generation: z.enum(["auto", "disabled"]).optional(),
  original_duration_seconds: z.number().int().positive().optional(),
  format: z.enum(["mp3", "wav", "pcm"]).optional(),
  sample_rate: z.number().int().positive().optional(),
  speech_rate: z.number().finite().optional(),
  loudness_rate: z.number().finite().optional(),
  pitch_rate: z.number().finite().optional(),
  speaker_id: z.string().trim().min(1).max(128).optional(),
}).strict();

export type GenerationRequestedParametersWire = z.infer<
  typeof generationRequestedParametersWireSchema
>;

export function generationParametersFromWire(
  input: GenerationRequestedParametersWire,
): GenerationParameters {
  return {
    ...(input.size ? { size: input.size } : {}),
    ...(input.ratio ? { ratio: input.ratio } : {}),
    ...(input.duration_seconds !== undefined ? { durationSeconds: input.duration_seconds } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.generate_audio !== undefined ? { generateAudio: input.generate_audio } : {}),
    ...(input.sequential_image_generation
      ? { sequentialImageGeneration: input.sequential_image_generation }
      : {}),
    ...(input.original_duration_seconds !== undefined
      ? { originalDurationSeconds: input.original_duration_seconds }
      : {}),
    ...(input.format ? { format: input.format } : {}),
    ...(input.sample_rate !== undefined ? { sampleRate: input.sample_rate } : {}),
    ...(input.speech_rate !== undefined ? { speechRate: input.speech_rate } : {}),
    ...(input.loudness_rate !== undefined ? { loudnessRate: input.loudness_rate } : {}),
    ...(input.pitch_rate !== undefined ? { pitchRate: input.pitch_rate } : {}),
    ...(input.speaker_id ? { speakerId: input.speaker_id } : {}),
  };
}
