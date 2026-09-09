import type { FastifyInstance } from "fastify";
import { settings } from "../../config/env.js";
import { success } from "../../http/response.js";
import type { Database } from "../../db/client.js";
import { checkReadiness, type ReadinessFailure } from "./readiness.js";

const readinessFailureMessages: Record<ReadinessFailure["reason"], string> = {
  db_unreachable: "服务尚未就绪：数据库暂时不可用，请稍后重试。",
  schema_missing: "服务尚未就绪：数据库结构未准备好，请联系管理员。",
  migrations_not_applied: "服务尚未就绪：数据库还没有完成初始化，请联系管理员。",
  migration_behind: "服务尚未就绪：数据库版本落后，请联系管理员完成升级。",
  expected_unknown: "服务尚未就绪：发布内容不完整，请联系管理员。",
};

function notReadyEnvelope(failure: ReadinessFailure) {
  // 响应体红线:details 只出现版本号、schema 名、原因枚举——
  // 本端点未鉴权可访问,主机名/用户名/连接串泄露即事故。
  return {
    ok: false as const,
    error: {
      code: "not_ready",
      message: readinessFailureMessages[failure.reason],
      retryable: true,
      details: {
        reason: failure.reason,
        schema: failure.schema,
        ...(failure.dbVersion ? { db_version: failure.dbVersion } : {}),
        ...(failure.expected ? { expected: failure.expected } : {}),
      },
    },
  };
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  getDatabase?: () => Database,
): Promise<void> {
  // 存活探针:纯静态不触库(LB liveness 用)。可用性判断走 /ready,不看本端点。
  // 响应体红线同 /ready:本端点未鉴权可访问,只出现制品身份,不出现运行环境信息。
  // sha 归在制品身份一侧——它标识「跑的是哪个提交」,不描述服务跑在哪台机器、
  // 连哪个库、用哪个账号,与红线点名的主机名/用户名/连接串不是一类。分支名和构建
  // 时间刻意留在镜像 label(docker inspect 可查),它们对定位提交没有增量作用
  // (sha 已唯一),却会把内部分支命名和发布节奏送到公网。
  // 代价写明:公开 sha 等于公开「线上是哪个版本」,已知漏洞可被精准匹配。这里选
  // 可追溯优先——审计要靠中文文案和迁移编号反推到 9~18 个提交的窗口,代价更大。
  app.get("/api/v1/health", async () => success({
    status: "ok",
    app_name: settings.appName,
    version: settings.appVersion,
    sha: settings.appCommitSha,
  }));

  // 就绪探针:三段校验(连通性 → schema 存在 → 迁移版本追平代码),任一不过 503。
  // 迁移与部署验收以本端点为准。响应体只带机器可判读原因,不含主机/用户名。
  app.get("/api/v1/ready", async (_request, reply) => {
    if (!getDatabase) {
      return reply.code(503).send(notReadyEnvelope({ reason: "db_unreachable", schema: settings.postgresSchema }));
    }
    let database: Database;
    try {
      database = getDatabase();
    } catch {
      // 配置缺失时连池都建不出来;启动自检会点名缺哪个变量,探针只报不可达。
      return reply.code(503).send(notReadyEnvelope({ reason: "db_unreachable", schema: settings.postgresSchema }));
    }
    const failure = await checkReadiness(database, { schemaName: settings.postgresSchema });
    if (failure) return reply.code(503).send(notReadyEnvelope(failure));
    return success({ status: "ready", db: "ok" });
  });
}
