import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { DrizzleCapabilityTierRepository } from "./repository.js";
import { CapabilityTierService, generationParameterModels } from "./service.js";
import type { CapabilityTierRepository } from "./types.js";

const querySchema = z.object({
  media_type: z.enum(["image", "video", "audio"]),
  include_frozen: z.enum(["true", "false"]).default("false"),
}).strict();

export interface RegisterCapabilityTierRoutesOptions {
  createRepository?: () => CapabilityTierRepository;
  now?: () => Date;
}

/**
 * Read-only tier catalog for authenticated users. Active rows are selectable;
 * frozen rows are returned as experimental with a safe reason for a later UI.
 */
export async function registerCapabilityTierRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  options: RegisterCapabilityTierRoutesOptions = {},
): Promise<void> {
  const createRepository = options.createRepository
    ?? (() => new DrizzleCapabilityTierRepository(getDatabase()));
  const now = options.now ?? (() => new Date());

  app.get("/api/v1/generation/capability-tiers", async (request) => {
    requireCurrentUser(request);
    const query = parseRequest(querySchema, request.query);
    const service = new CapabilityTierService(createRepository());
    const catalog = await service.listCatalog(query.media_type, now());
    const tiers = query.include_frozen === "true"
      ? catalog
      : catalog.filter((tier) => tier.status === "active");
    return success({
      parameterModels: generationParameterModels(catalog),
      tiers,
    });
  });
}
