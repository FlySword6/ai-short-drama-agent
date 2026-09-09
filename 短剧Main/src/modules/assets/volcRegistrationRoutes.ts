import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import type {
  SeedanceAssetRegistrationPort,
  SeedanceAssetRegistrationView,
} from "../seedance-assets/types.js";
import {
  publicVolcAssetFailureCode,
  publicVolcAssetFailureMessage,
} from "./volcAssetRegistry.js";
import {
  volcRegistrationCreateOpenApi,
  volcRegistrationGetOpenApi,
  volcRegistrationRefreshOpenApi,
} from "./volcRegistrationOpenApi.js";

const uuid = z.string().uuid();
const createBody = z.object({
  asset_id: uuid,
  asset_media_id: uuid,
}).strict();
const registrationParams = z.object({ registration_id: uuid }).strict();

export interface VolcRegistrationRouteDependencies {
  createService?: () => SeedanceAssetRegistrationPort;
}

export async function registerVolcAssetRegistrationRoutes(
  app: FastifyInstance,
  _getDatabase: () => Database,
  dependencies: VolcRegistrationRouteDependencies = {},
): Promise<void> {
  const service = () => {
    if (!dependencies.createService) {
      throw new Error("Volc asset registration service must be injected by the composition root");
    }
    return dependencies.createService();
  };

  app.post(
    "/api/v1/assets/registrations",
    { schema: volcRegistrationCreateOpenApi },
    async (request) => {
      const body = parseRequest(createBody, request.body);
      return success({
        registration: toResponse(await service().registerAssetMedia(
          requireCurrentUser(request),
          body.asset_id,
          body.asset_media_id,
        )),
      });
    },
  );

  app.get(
    "/api/v1/assets/registrations/:registration_id",
    { schema: volcRegistrationGetOpenApi },
    async (request) => {
      const params = parseRequest(registrationParams, request.params);
      return success({
        registration: toResponse(await service().getRegistration(
          requireCurrentUser(request),
          params.registration_id,
        )),
      });
    },
  );

  app.post(
    "/api/v1/assets/registrations/:registration_id/refresh",
    { schema: volcRegistrationRefreshOpenApi },
    async (request) => {
      const params = parseRequest(registrationParams, request.params);
      return success({
        registration: toResponse(await service().refreshRegistration(
          requireCurrentUser(request),
          params.registration_id,
        )),
      });
    },
  );
}

function toResponse(value: SeedanceAssetRegistrationView) {
  const failureCode = value.latestErrorCode
    ? publicVolcAssetFailureCode(value.latestErrorCode)
    : null;
  return {
    id: value.id,
    asset_media_id: value.assetMediaId,
    volc_asset_group_id: value.assetGroupId,
    volc_asset_id: value.remoteAssetId,
    status: value.status,
    request_id: value.latestRequestId,
    retry_count: value.retryCount,
    last_retry_at: value.lastRetryAt?.toISOString() ?? null,
    last_verified_at: value.lastVerifiedAt?.toISOString() ?? null,
    failure: failureCode
      ? {
          code: failureCode,
          message: publicVolcAssetFailureMessage(failureCode),
        }
      : null,
  };
}
