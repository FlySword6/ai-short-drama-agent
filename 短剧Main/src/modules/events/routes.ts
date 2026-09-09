import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { BadRequestError } from "../../shared/errors.js";
import { requireAdministrator } from "../auth/admin.js";
import { DrizzleEventRepository, type EventRepository } from "./repository.js";
import { EventService } from "./service.js";

const EVENT_PROPS_MAX_BYTES = 16 * 1024;

const recordEventSchema = z.object({
  event: z.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9_.:-]*$/),
  props: z.record(z.string(), z.unknown()).default({}),
  ts: z.union([
    z.string().datetime({ offset: true }).transform((value) => new Date(value)),
    z.number().int().nonnegative().transform((value) => new Date(value)),
  ]),
}).strict();

const aggregateQuerySchema = z.object({
  event: z.string().trim().min(1).max(128).optional(),
  user_id: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
}).refine(
  (query) => !query.from || !query.to || query.from.getTime() <= query.to.getTime(),
  { message: "开始时间不能晚于结束时间", path: ["from"] },
);

export interface EventRouteDependencies {
  createRepository?: () => EventRepository;
  adminUsernames?: readonly string[];
}

export async function registerEventRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: EventRouteDependencies = {},
): Promise<void> {
  const service = () => new EventService(
    dependencies.createRepository?.() ?? new DrizzleEventRepository(getDatabase()),
  );

  app.post("/api/v1/events", async (request, reply) => {
    const input = parseRequest(recordEventSchema, request.body);
    if (input.ts.toString() === "Invalid Date") throw new BadRequestError("记录时间不正确，请检查后再试");
    if (Buffer.byteLength(JSON.stringify(input.props), "utf8") > EVENT_PROPS_MAX_BYTES) {
      throw new BadRequestError("这次记录内容太多，请精简后再试");
    }
    const item = await service().record(requireCurrentUser(request).id, {
      event: input.event,
      props: input.props,
      occurredAt: input.ts,
    });
    return reply.code(201).send(success({
      id: item.id,
      event: item.event,
      props: item.props,
      ts: item.occurredAt.toISOString(),
      receivedAt: item.receivedAt.toISOString(),
    }));
  });

  app.get("/api/v1/admin/events/summary", async (request) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user, dependencies.adminUsernames ?? settings.adminUsernames);
    const query = parseRequest(aggregateQuerySchema, request.query);
    const result = await service().aggregate({
      event: query.event,
      userId: query.user_id,
      occurredFrom: query.from,
      occurredTo: query.to,
    });
    return success({
      ...result,
      timezone: "UTC",
      filters: {
        event: query.event ?? null,
        userId: query.user_id ?? null,
        from: query.from?.toISOString() ?? null,
        to: query.to?.toISOString() ?? null,
      },
    });
  });
}
