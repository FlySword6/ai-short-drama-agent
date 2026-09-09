import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { downloadMediaBytes } from "../generation/mediaDownload.js";
import { manifestToCsv } from "./manifest.js";
import { DrizzleDeliveryRepository } from "./repository.js";
import { DeliveryService } from "./service.js";

const id = z.string().uuid();
const episodeParams = z.object({ episode_id: id });
const mediaParams = z.object({ media_id: id });
const partialQuery = z.object({
  partial: z.enum(["true", "false"]).default("false"),
});
const deliveryHistoryQuery = z.object({
  page: z.coerce.number().int().min(1).max(100).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(20),
});
const createDeliverySchema = z.object({
  purpose: z.string().trim().min(1).max(1_000).nullish(),
  partial: z.boolean().default(false),
}).strict();

export interface DeliveryRouteDependencies {
  createService?: () => Pick<
    DeliveryService,
    "getPlayback" | "getManifest" | "getDownload" | "createDeliveryRecord" | "listDeliveryRecords"
  >;
}

export async function registerDeliveryRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: DeliveryRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.()
    ?? new DeliveryService(new DrizzleDeliveryRepository(getDatabase()));

  app.get("/api/v1/episodes/:episode_id/playback", async (request) => {
    const params = parseRequest(episodeParams, request.params);
    const query = parseRequest(partialQuery, request.query);
    const user = requireCurrentUser(request);
    return success(await service().getPlayback(user, params.episode_id, { partial: query.partial === "true" }));
  });

  app.get("/api/v1/episodes/:episode_id/deliverables", async (request) => {
    const params = parseRequest(episodeParams, request.params);
    const query = parseRequest(partialQuery, request.query);
    const user = requireCurrentUser(request);
    const manifest = await service().getManifest(user, params.episode_id, { partial: query.partial === "true" });
    return success(manifest);
  });

  app.get("/api/v1/episodes/:episode_id/deliverables.csv", async (request, reply) => {
    const params = parseRequest(episodeParams, request.params);
    const query = parseRequest(partialQuery, request.query);
    const user = requireCurrentUser(request);
    const manifest = await service().getManifest(user, params.episode_id, { partial: query.partial === "true" });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="episode-${manifest.episode.no}-deliverable.csv"`)
      .send(`\uFEFF${manifestToCsv(manifest)}`);
  });

  app.get("/api/v1/episodes/:episode_id/deliveries", async (request) => {
    const params = parseRequest(episodeParams, request.params);
    const query = parseRequest(deliveryHistoryQuery, request.query);
    const user = requireCurrentUser(request);
    return success(await service().listDeliveryRecords(user, params.episode_id, query.page, query.page_size));
  });

  app.post("/api/v1/episodes/:episode_id/deliveries", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    const params = parseRequest(episodeParams, request.params);
    const input = parseRequest(createDeliverySchema, request.body ?? {});
    const user = requireCurrentUser(request);
    const record = await service().createDeliveryRecord(user, params.episode_id, {
      purpose: input.purpose ?? null,
      partial: input.partial,
    });
    return reply.code(201).send(success(record));
  });

  app.get("/api/v1/media/:media_id/download", async (request, reply) => {
    const params = parseRequest(mediaParams, request.params);
    const user = requireCurrentUser(request);
    const media = await service().getDownload(user, params.media_id);
    const downloaded = await downloadMediaBytes(media.storageUrl);
    return reply
      .header("content-type", downloaded.contentType)
      .header("content-length", String(downloaded.byteLength))
      .header("cache-control", "private, no-store")
      .header(
        "content-disposition",
        `attachment; filename="media-${params.media_id}.${downloaded.extension}"`,
      )
      .send(downloaded.content);
  });
}
