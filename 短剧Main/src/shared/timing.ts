import type { IngestedAssetResponse, JsonObject } from "../domain/assets/types.js";

export function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export class TimingCollector {
  private readonly startedAt = performance.now();
  private readonly values: JsonObject = {};

  mark(name: string, startedAt: number): void {
    this.values[name] = elapsedMs(startedAt);
  }

  set(name: string, value: string | number | boolean | null): void {
    this.values[name] = value;
  }

  snapshot(): JsonObject {
    return { ...this.values };
  }

  total(name = "total"): void {
    this.values[name] = elapsedMs(this.startedAt);
  }
}

export function attachTiming(
  items: IngestedAssetResponse[],
  timing: JsonObject,
): void {
  for (const item of items) {
    const current = item.metadata.ingest_timing_ms;
    const currentObject = typeof current === "object" && current !== null && !Array.isArray(current)
      ? current
      : {};
    item.metadata.ingest_timing_ms = { ...currentObject, ...timing };
  }
}
