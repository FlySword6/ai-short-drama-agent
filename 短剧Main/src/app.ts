import path from "node:path";
import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { createAssetUploadTaskService, createSnapshotARegistration } from "./composition/seedanceAssetRegistration.js";
import { createSnapshotATosVerification } from "./composition/snapshotAImport.js";
import type { SnapshotARegistrationPort, SnapshotATosVerificationPort } from "./modules/vnext/imports/service.js";
import { createDatabase, type DatabaseHandle } from "./db/client.js";
import { settings } from "./config/env.js";
import { toHttpErrorResponse } from "./http/errorResponse.js";
import { localEntryGuideHtml, resolveRootEntryMode } from "./http/localEntryGuide.js";
import { registerRoutes } from "./http/routes.js";
import { createAuthenticationHook } from "./http/authenticate.js";
import { GenerationWorker } from "./modules/generation/worker.js";
import { assetWorkerExecutionEnabled, generationExecutionEnabled } from "./modules/generation/factory.js";
import { AssetUploadWorker } from "./modules/asset-uploads/worker.js";
import { TrashRetentionWorker } from "./modules/trash/retention.js";
import { AssetMediaRepairWorker } from "./modules/assets/mediaRepairWorker.js";
import { registerVnextRoutes } from "./modules/vnext/routes.js";
import { createVnextDatabase } from "./modules/vnext/db.js";
import { VnextProjectService } from "./modules/vnext/service.js";
import { VideoIngestService } from "./modules/video-ingest/service.js";
import { VideoIngestWorker } from "./modules/video-ingest/worker.js";
import type { AuthRouteDependencies } from "./modules/auth/routes.js";
import { WecomTransactionCleanupWorker } from "./modules/auth/wecomCleanupWorker.js";

export interface AppOptions {
  databaseHandle?: DatabaseHandle;
  /**
   * vNext 数据面的专用连接(每条连接钉死最小权限角色 vnext_app)。
   * 测试用它注入非超级用户连接;缺省时按独立 VNEXT_DATABASE_URL 懒建。
   */
  vnextDatabaseHandle?: DatabaseHandle;
  logger?: FastifyServerOptions["logger"];
  /** 前端构建产物目录,默认取仓库里的位置;测试用它构造"有 dist / 没 dist"两种环境。 */
  frontendDistDirectory?: string;
  startGenerationWorker?: boolean;
  startAssetUploadWorker?: boolean;
  startTrashRetentionWorker?: boolean;
  startWecomTransactionCleanupWorker?: boolean;
  startAssetMediaRepairWorker?: boolean;
  createSnapshotARegistration?: (actorUserId?: string) => SnapshotARegistrationPort | undefined;
  createSnapshotATosVerification?: () => SnapshotATosVerificationPort | undefined;
  startVideoIngestWorker?: boolean;
  /** Optional authentication route composition overrides, used by isolated integration tests. */
  authRoutes?: AuthRouteDependencies;
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const configuredLogger = options.logger ?? settings.debug;
  const logger = configuredLogger === false
    ? false
    : {
        ...(typeof configuredLogger === "object" ? configuredLogger : {}),
        serializers: {
          ...(typeof configuredLogger === "object" ? configuredLogger.serializers : {}),
          req(request: FastifyRequest) {
            return {
              method: request.method,
              url: request.url?.split("?", 1)[0],
              host: request.host,
              remoteAddress: request.ip,
              remotePort: request.socket.remotePort,
            };
          },
        },
      };
  const app = Fastify({ logger });
  let databaseHandle = options.databaseHandle;
  const getDatabase = () => {
    databaseHandle ??= createDatabase();
    return databaseHandle.db;
  };
  // vNext 业务事实只走受 vnext_app 约束的专用连接;会话认证仍读主 schema,
  // 所以认证钩子继续用主连接——vnext_app 对主 schema 没有任何权限。
  let vnextDatabaseHandle = options.vnextDatabaseHandle;
  const getVnextDatabase = () => {
    vnextDatabaseHandle ??= createVnextDatabase();
    return vnextDatabaseHandle.db;
  };

  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 100 * 1024 * 1024, files: 50 },
  });
  await app.register(swagger, {
    openapi: {
      info: { title: settings.appName, version: settings.appVersion },
      servers: [{ url: "/" }],
    },
  });

  // Register this before the routes so Fastify applies the compatible error
  // envelope to every API handler, including multipart validation failures.
  app.setErrorHandler((error, request, reply) => {
    const { statusCode, body } = toHttpErrorResponse(error);
    if (statusCode >= 500) {
      app.log.error({
        requestId: request.id,
        code: body.code,
        errorType: error instanceof Error ? error.constructor.name : "UnknownError",
        stage: "http_error_handler",
      }, "request failed");
    }
    return reply.code(statusCode).send({ ok: false, error: body });
  });

  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.addHook("preHandler", createAuthenticationHook(getDatabase));
  await registerVnextRoutes(app, getVnextDatabase, {
    getMainDatabase: getDatabase,
    createSnapshotARegistration: options.createSnapshotARegistration ? (actorUserId) => options.createSnapshotARegistration!(actorUserId) : (actorUserId) => createSnapshotARegistration({ db: getDatabase(), actorUserId }),
    createSnapshotATosVerification: options.createSnapshotATosVerification ?? createSnapshotATosVerification,
  });

  let assetUploadWorker: AssetUploadWorker | undefined;
  if (options.startAssetUploadWorker) {
    assetUploadWorker = new AssetUploadWorker(
      createAssetUploadTaskService(getDatabase()),
      app.log,
      { executionEnabled: assetWorkerExecutionEnabled },
    );
  }
  let assetMediaRepairWorker: AssetMediaRepairWorker | undefined;
  if (options.startAssetMediaRepairWorker) {
    assetMediaRepairWorker = new AssetMediaRepairWorker(
      getDatabase(),
      app.log,
      undefined,
      { executionEnabled: assetWorkerExecutionEnabled },
    );
  }
  let videoIngestWorker: VideoIngestWorker | undefined;
  if (options.startVideoIngestWorker) {
    videoIngestWorker = new VideoIngestWorker(new VideoIngestService(getDatabase()), app.log);
  }
  await registerRoutes(app, {
    getDatabase,
    ...(options.authRoutes ? { authRoutes: options.authRoutes } : {}),
    assistantRoutes: {
      createVnextService: () => new VnextProjectService(getVnextDatabase()),
    },
    ...(assetUploadWorker ? { assetUploadWorker } : {}),
    ...(assetMediaRepairWorker ? { assetMediaRepairWorker } : {}),
    ...(videoIngestWorker ? { videoIngestWorker } : {}),
  });
  assetUploadWorker?.start();
  assetMediaRepairWorker?.start();
  videoIngestWorker?.start();

  let trashRetentionWorker: TrashRetentionWorker | undefined;
  if (options.startTrashRetentionWorker) {
    trashRetentionWorker = new TrashRetentionWorker(getDatabase(), app.log);
    trashRetentionWorker.start();
  }

  let wecomTransactionCleanupWorker: WecomTransactionCleanupWorker | undefined;
  if (options.startWecomTransactionCleanupWorker) {
    wecomTransactionCleanupWorker = new WecomTransactionCleanupWorker(getDatabase(), app.log);
    wecomTransactionCleanupWorker.start();
  }

  let generationWorker: GenerationWorker | undefined;
  if (options.startGenerationWorker) {
    if (generationExecutionEnabled()) {
      generationWorker = new GenerationWorker(getDatabase(), app.log);
      generationWorker.start();
    } else {
      app.log.warn("generation worker paused because paid generation is disabled, budget is zero, or dependencies are incomplete");
    }
  }

  const frontendDirectory = options.frontendDistDirectory ?? path.resolve("frontend", "shortdrama-rag-demo", "dist");
  const rootEntryMode = resolveRootEntryMode({
    frontendAvailable: existsSync(frontendDirectory),
    appEnvironment: settings.appEnvironment,
  });
  if (rootEntryMode === "frontend") {
    await app.register(fastifyStatic, {
      root: frontendDirectory,
      wildcard: false,
      index: "index.html",
    });
  } else if (rootEntryMode === "guide") {
    // 只占根地址:其余打不着的路径仍走错误信封,免得 curl 调接口时收到一页 HTML。
    app.get("/", (_request, reply) => reply.type("text/html; charset=utf-8").send(localEntryGuideHtml));
  }
  // API errors must keep one envelope in both backend-only test/runtime
  // environments and full frontend deployments. SPA fallback only exists
  // when a built frontend is actually present.
  app.setNotFoundHandler((request, reply) => {
    if (rootEntryMode === "frontend" && request.method === "GET" && !request.url.startsWith("/api/") && !request.url.startsWith("/docs")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ ok: false, error: { code: "not_found", message: "接口不存在", retryable: false, details: null } });
  });

  app.addHook("onClose", async () => {
    await assetUploadWorker?.stop();
    await assetMediaRepairWorker?.stop();
    await videoIngestWorker?.stop();
    await trashRetentionWorker?.stop();
    await wecomTransactionCleanupWorker?.stop();
    await generationWorker?.stop();
    if (databaseHandle && databaseHandle !== options.databaseHandle) await databaseHandle.pool.end();
    if (vnextDatabaseHandle && vnextDatabaseHandle !== options.vnextDatabaseHandle) await vnextDatabaseHandle.pool.end();
  });

  return app;
}
