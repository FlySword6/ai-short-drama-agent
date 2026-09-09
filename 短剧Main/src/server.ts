import { createApp } from "./app.js";
import { settings } from "./config/env.js";
import {
  assertDatabaseConfigComplete,
  describeProbeFailure,
  probeDatabaseConnection,
} from "./config/database-preflight.js";
import { createDatabase } from "./db/client.js";

// 启动期配置自检(fail fast):配置坏掉但服务假装健康,会把错误延迟到用户
// 操作才暴露。自检只在启动引导里,不进 createApp()——测试不带库也要能构造应用。
// 日志红线:不打印密码、连接串明文、KMS 密钥值。
try {
  assertDatabaseConfigComplete();
} catch (error) {
  console.error(`[startup] 数据库配置不完整,拒绝启动:${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const databaseHandle = createDatabase();
// 真实连库探测(带超时):失败则拒绝启动,并区分「连不上主机 / 认证失败 /
// 库或 schema 不存在」三类,主机名与用户名只允许出现在本服务端日志。
const probeFailure = await probeDatabaseConnection(databaseHandle.pool, {
  schemaName: settings.postgresSchema,
});
if (probeFailure) {
  console.error(`[startup] 数据库连接探测失败,拒绝启动:${describeProbeFailure(probeFailure)}`);
  await databaseHandle.pool.end().catch(() => undefined);
  process.exit(1);
}

// Database migrations are a separately authorised release action.  Starting a
// serving Pod must never turn an application restart into an unreviewed schema
// write.  Run `npm run db:migrate` in the controlled migration step instead.
// The real server always logs to stdout (container-friendly); tests keep
// the quiet settings.debug default by calling createApp directly.
const app = await createApp({
  databaseHandle,
  startGenerationWorker: true,
  startAssetUploadWorker: true,
  startAssetMediaRepairWorker: true,
  startVideoIngestWorker: true,
  startTrashRetentionWorker: true,
  startWecomTransactionCleanupWorker: true,
  logger: true,
});

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await app.close();
  await databaseHandle.pool.end();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

try {
  await app.listen({ host: settings.host, port: settings.port });
} catch (error) {
  await shutdown();
  throw error;
}
