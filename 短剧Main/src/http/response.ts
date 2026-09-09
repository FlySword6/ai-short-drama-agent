import type { ZodType } from "zod";
import { BadRequestError } from "../shared/errors.js";
import { validationFieldDetails } from "../shared/fieldLabels.js";

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

export function success<T>(data: T): SuccessEnvelope<T> {
  return { ok: true, data: toSnakeCaseJson(data) as T };
}

/** Keep every public JSON response on the API's frozen snake_case contract. */
export function toSnakeCaseJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCaseJson);
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (!isPlainObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [camelToSnake(key), toSnakeCaseJson(item)]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function camelToSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function parseRequest<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestError(
      "请求没能处理：请检查标出的填写内容后重试。",
      validationFieldDetails(parsed.error.issues),
    );
  }
  return parsed.data;
}
