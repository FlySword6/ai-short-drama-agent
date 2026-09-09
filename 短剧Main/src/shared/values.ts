export function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

export function optionalText(value: unknown): string | null {
  const text = textValue(value);
  return text || null;
}

export function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = textValue(value).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const text = textValue(value).toLowerCase();
  if (["true", "1", "yes", "y", "是", "通过", "已通过"].includes(text)) return true;
  if (["false", "0", "no", "n", "否", "不通过", "未通过"].includes(text)) return false;
  return null;
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
