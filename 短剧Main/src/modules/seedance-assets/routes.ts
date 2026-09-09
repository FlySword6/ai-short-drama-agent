import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import {
  publicVolcAssetFailureCode,
  publicVolcAssetFailureMessage,
} from "../assets/volcAssetRegistry.js";
import type { SeedanceAssetRegistrationPort, SeedanceAssetRegistrationView } from "./types.js";

const uuid = z.string().uuid();
const mediaResultParams = z.object({ media_result_id: uuid }).strict();
const assetMediaParams = z.object({ asset_id: uuid, media_id: uuid }).strict();

export interface SeedanceAssetRegistrationRouteDependencies {
  createService?: () => SeedanceAssetRegistrationPort;
}

/**
 * Registration is intentionally separate from generation: this module never
 * creates a registration as a side effect of a quote, submission, or result.
 * The single automatic trigger is a media becoming an asset's primary variant
 * (Lite set-primary / any is_primary upload), fired as a background task after
 * the flip commits; every other entry point here is an explicit human click.
 */
export async function registerSeedanceAssetRegistrationRoutes(
  app: FastifyInstance,
  _getDatabase: () => Database,
  dependencies: SeedanceAssetRegistrationRouteDependencies = {},
): Promise<void> {
  const service = () => {
    if (!dependencies.createService) {
      throw new Error("Seedance asset registration service must be injected by the composition root");
    }
    return dependencies.createService();
  };

  app.post("/api/v1/media-results/:media_result_id/seedance-registration", async (request) => {
    const params = parseRequest(mediaResultParams, request.params);
    return success({ registration: toResponse(await service().registerMediaResult(
      requireCurrentUser(request),
      params.media_result_id,
    )) });
  });

  app.get("/api/v1/media-results/:media_result_id/seedance-registration", async (request) => {
    const params = parseRequest(mediaResultParams, request.params);
    return success({ registration: toResponse(await service().getMediaResult(
      requireCurrentUser(request),
      params.media_result_id,
    )) });
  });

  app.post("/api/v1/media-results/:media_result_id/seedance-registration/refresh", async (request) => {
    const params = parseRequest(mediaResultParams, request.params);
    return success({ registration: toResponse(await service().refreshMediaResult(
      requireCurrentUser(request),
      params.media_result_id,
    )) });
  });

  app.post("/api/v1/assets/:asset_id/media/:media_id/seedance-registration", async (request) => {
    const params = parseRequest(assetMediaParams, request.params);
    return success({ registration: toResponse(await service().registerAssetMedia(
      requireCurrentUser(request),
      params.asset_id,
      params.media_id,
    )) });
  });

  app.get("/api/v1/assets/:asset_id/media/:media_id/seedance-registration", async (request) => {
    const params = parseRequest(assetMediaParams, request.params);
    return success({ registration: toResponse(await service().getAssetMedia(
      requireCurrentUser(request),
      params.asset_id,
      params.media_id,
    )) });
  });

  app.post("/api/v1/assets/:asset_id/media/:media_id/seedance-registration/refresh", async (request) => {
    const params = parseRequest(assetMediaParams, request.params);
    return success({ registration: toResponse(await service().refreshAssetMedia(
      requireCurrentUser(request),
      params.asset_id,
      params.media_id,
    )) });
  });
}

function toResponse(value: SeedanceAssetRegistrationView) {
  const failureCode = value.latestErrorCode
    ? publicVolcAssetFailureCode(value.latestErrorCode)
    : null;
  return {
    id: value.id,
    asset_media_id: value.assetMediaId,
    source_media_result_id: value.sourceMediaResultId,
    remote_asset_id: value.remoteAssetId,
    status: value.status,
    created_at: value.createdAt.toISOString(),
    updated_at: value.updatedAt.toISOString(),
    activated_at: value.activatedAt?.toISOString() ?? null,
    authorization_expires_at: value.authorizationExpiresAt?.toISOString() ?? null,
    last_verified_at: value.lastVerifiedAt?.toISOString() ?? null,
    latest_error: failureCode
      ? {
          code: failureCode,
          message: publicVolcAssetFailureMessage(failureCode),
        }
      : null,
  };
}
