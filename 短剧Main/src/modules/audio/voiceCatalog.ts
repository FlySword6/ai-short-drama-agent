import type { VoiceCatalogFilter, VoiceCatalogProvider, VoiceCatalogVoice } from "./types.js";

export class CachedVoiceCatalog {
  private cached?: { expiresAt: number; voices: readonly VoiceCatalogVoice[] };

  constructor(
    private readonly provider: VoiceCatalogProvider,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async list(filter: VoiceCatalogFilter = {}): Promise<VoiceCatalogVoice[]> {
    const voices = await this.load();
    const query = normalize(filter.query);
    return voices.filter((voice) => matches(voice.language, filter.language)
      && matches(voice.category, filter.category)
      && matches(voice.gender, filter.gender)
      && matches(voice.age, filter.age)
      && (!query || searchable(voice).includes(query)));
  }

  private async load(): Promise<readonly VoiceCatalogVoice[]> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.voices;
    const voices = await this.provider.listVoices();
    const deduplicated = [...new Map(voices.map((voice) => [voice.id, { ...voice }])).values()];
    this.cached = { voices: deduplicated, expiresAt: this.now() + this.ttlMs };
    return deduplicated;
  }
}

function matches(value: string | undefined, expected: string | undefined): boolean {
  return !expected || normalize(value) === normalize(expected);
}

function searchable(voice: VoiceCatalogVoice): string {
  return normalize([voice.id, voice.displayName, voice.language, voice.category, voice.gender, voice.age, voice.description]
    .filter((value): value is string => Boolean(value)).join(" "));
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}
