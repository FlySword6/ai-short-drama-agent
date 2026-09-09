import { z } from "zod";

const id = z.string().uuid();
const text = z.string().trim().min(1).max(4_000);

export const storyboardGenerateSchema = z.object({
  confirmation_id: id,
  client_idempotency_key: z.string().trim().min(1).max(128),
  paid_confirmation: z.literal(true),
}).strict();
export const storyboardLoadQuerySchema = z.object({ confirmation_id: id }).strict();

export const storyboardRedrawSchema = z.object({
  confirmation_id: id,
  prompt: text,
  client_idempotency_key: z.string().trim().min(1).max(128),
  paid_confirmation: z.literal(true),
}).strict();

export const storyboardCellParamsSchema = z.object({ project_id: id, cell_id: id }).strict();

export const storyboardProjectParamsSchema = z.object({ project_id: id }).strict();
