import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { BadRequestError } from "../../shared/errors.js";
import { requireAdministrator } from "../auth/admin.js";
import { DrizzleConfigEntriesRepository } from "./repository.js";
import { ConfigEntriesService } from "./service.js";
import {
  CONFIG_ENTRY_KINDS,
  CONFIG_ENTRY_PAYLOAD_SCHEMAS,
  CONFIG_ENTRY_STATUSES,
  PUBLIC_CONFIG_ENTRY_KINDS,
  type ConfigEntriesRepository,
  type ConfigEntryKind,
} from "./types.js";

const kindSchema = z.enum(CONFIG_ENTRY_KINDS);
const publicKindSchema = z.enum(PUBLIC_CONFIG_ENTRY_KINDS);

const publicListQuery = z.object({
  kind: publicKindSchema,
}).strict();

const adminListQuery = z.object({
  kind: kindSchema,
}).strict();

const createEntryBody = z.object({
  kind: kindSchema,
  entry_key: z.string().trim().min(1).max(128),
  status: z.enum(CONFIG_ENTRY_STATUSES).default("published"),
  sort: z.number().int().min(0).max(999999).default(0),
  payload: z.unknown(),
}).strict();

const updateEntryBody = z.object({
  kind: kindSchema,
  entry_key: z.string().trim().min(1).max(128).optional(),
  status: z.enum(CONFIG_ENTRY_STATUSES).optional(),
  sort: z.number().int().min(0).max(999999).optional(),
  payload: z.unknown().optional(),
}).strict();

function parsePayload(kind: ConfigEntryKind, payload: unknown): unknown {
  const parsed = CONFIG_ENTRY_PAYLOAD_SCHEMAS[kind].safeParse(payload ?? {});
  if (!parsed.success) throw new BadRequestError("这项设置没填对，请检查后再试");
  return parsed.data;
}

export interface RegisterConfigEntriesRoutesOptions {
  createRepository?: () => ConfigEntriesRepository;
}

/**
 * Config-entry reads are login-readable (published only); every write is
 * admin only.  The integration owner wires this once from src/http/routes.ts.
 */
export async function registerConfigEntriesRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  options: RegisterConfigEntriesRoutesOptions = {},
): Promise<void> {
  const createRepository = options.createRepository
    ?? (() => new DrizzleConfigEntriesRepository(getDatabase()));
  const service = () => new ConfigEntriesService(createRepository());

  app.get("/api/v1/config-entries", async (request) => {
    requireCurrentUser(request);
    const query = parseRequest(publicListQuery, request.query);
    const entries = await service().listPublished(query.kind);
    return success({ entries });
  });

  app.get("/api/v1/admin/config-entries", async (request) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user);
    const query = parseRequest(adminListQuery, request.query);
    const entries = await service().listAll(query.kind);
    return success({ entries });
  });

  app.post("/api/v1/admin/config-entries", async (request, reply) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user);
    const input = parseRequest(createEntryBody, request.body);
    const entry = await service().create({
      kind: input.kind,
      entryKey: input.entry_key,
      status: input.status,
      sort: input.sort,
      payload: parsePayload(input.kind, input.payload),
      createdBy: user.id,
    });
    return reply.code(201).send(success({ entry }));
  });

  app.put("/api/v1/admin/config-entries/:id", async (request) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user);
    const { id } = request.params as { id: string };
    const input = parseRequest(updateEntryBody, request.body);
    const entry = await service().update(id, input.kind, {
      ...(input.entry_key !== undefined ? { entryKey: input.entry_key } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.sort !== undefined ? { sort: input.sort } : {}),
      ...(input.payload !== undefined ? { payload: parsePayload(input.kind, input.payload) } : {}),
      updatedBy: user.id,
    });
    return success({ entry });
  });

  app.delete("/api/v1/admin/config-entries/:id", async (request, reply) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user);
    const { id } = request.params as { id: string };
    await service().remove(id);
    return reply.code(204).send();
  });
}
