import type { AudioAssetCategory, AudioAssetMetadata } from "./types.js";

const MAX_TRAIT_COUNT = 20;
const MAX_TRAIT_LENGTH = 32;
const MAX_TEXT_LENGTH = 128;

export function buildAudioAssetMetadata(input: {
  category: AudioAssetCategory;
  voiceTraits?: readonly string[];
  speakingStyle?: string | null;
  musicTraits?: readonly string[];
  tempo?: string | null;
  usageScene?: string | null;
}): AudioAssetMetadata {
  if (input.category === "音色") {
    return {
      kind: "voice",
      voice_traits: normalizeAudioTags(input.voiceTraits ?? []),
      speaking_style: cleanOptionalText(input.speakingStyle),
    };
  }
  return {
    kind: "background_music",
    music_traits: normalizeAudioTags(input.musicTraits ?? []),
    tempo: cleanOptionalText(input.tempo),
    usage_scene: cleanOptionalText(input.usageScene),
  };
}

export function normalizeAudioMetadataForCategory(
  category: AudioAssetCategory,
  metadata: AudioAssetMetadata,
): AudioAssetMetadata {
  if (category === "音色") {
    const voice = metadata.kind === "voice" ? metadata : { kind: "voice" as const, voice_traits: [], speaking_style: null };
    return buildAudioAssetMetadata({
      category,
      voiceTraits: voice.voice_traits,
      speakingStyle: voice.speaking_style,
    });
  }
  const music = metadata.kind === "background_music"
    ? metadata
    : { kind: "background_music" as const, music_traits: [], tempo: null, usage_scene: null };
  return buildAudioAssetMetadata({
    category,
    musicTraits: music.music_traits,
    tempo: music.tempo,
    usageScene: music.usage_scene,
  });
}

export function buildAudioStyleTags(category: AudioAssetCategory, metadata: AudioAssetMetadata): string[] {
  if (metadata.kind === "voice") {
    return normalizeAudioTags([category, ...metadata.voice_traits, metadata.speaking_style ?? ""]);
  }
  return normalizeAudioTags([category, ...metadata.music_traits, metadata.tempo ?? "", metadata.usage_scene ?? ""]);
}

export function buildAudioAssetVectorText(input: {
  name: string;
  description?: string | null;
  category: AudioAssetCategory;
  metadata: AudioAssetMetadata;
}): string {
  const lines = [
    labeled("名称", input.name),
    labeled("类型", `音频 / ${input.category}`),
    labeled("描述", input.description),
  ];
  if (input.metadata.kind === "voice") {
    lines.push(
      labeled("音色特征", input.metadata.voice_traits.join("、")),
      labeled("说话方式", input.metadata.speaking_style),
    );
  } else {
    lines.push(
      labeled("音乐特征", input.metadata.music_traits.join("、")),
      labeled("节奏", input.metadata.tempo),
      labeled("使用场景", input.metadata.usage_scene),
    );
  }
  return lines.filter(Boolean).join("\n");
}

export function normalizeAudioTags(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = cleanRequiredText(value, MAX_TRAIT_LENGTH);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= MAX_TRAIT_COUNT) break;
  }
  return result;
}

function cleanOptionalText(value: string | null | undefined): string | null {
  return cleanRequiredText(value ?? "", MAX_TEXT_LENGTH) || null;
}

function labeled(label: string, value: string | null | undefined): string {
  const text = cleanRequiredText(value ?? "", 2_000);
  return text ? `${label}:${text}` : "";
}

function cleanRequiredText(value: string, maxLength: number): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}
