import type { JsonObject, JsonValue } from "../domain/assets/types.js";

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const parsed = asJsonValue(item);
      if (parsed === undefined) return undefined;
      result.push(parsed);
    }
    return result;
  }
  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const parsed = asJsonValue(item);
      if (parsed === undefined) return undefined;
      result[key] = parsed;
    }
    return result;
  }
  return undefined;
}

export function toJsonObject(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

export function parseJsonValue(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""),
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }

  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1)) as unknown;
    } catch {
      // Try an object below.
    }
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1)) as unknown;
    } catch {
      // Fall through to the useful error.
    }
  }

  throw new Error(`LLM output is not valid JSON. First 1000 chars: ${trimmed.slice(0, 1000)}`);
}

export function jsonObject(value: unknown, message = "Expected a JSON object"): JsonObject {
  if (!isRecord(value)) throw new Error(message);
  return value;
}
