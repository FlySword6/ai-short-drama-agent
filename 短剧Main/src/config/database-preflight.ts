import { classifyDatabaseError, type DatabaseErrorKind } from "../shared/errors.js";

/**
 * 启动期数据库配置自检(fail fast)。
 *
 * 背景:曾因「账号不存在 + 引错密钥 + schema 为空」三重配置错误,服务照样
 * 启动成功,错误延迟到用户点登录才暴露。自检因此必须放在启动引导
 * (src/server.ts)里,而不是 createApp()——测试不带库也要能构造应用。
 *
 * 日志红线:任何输出不得包含密码、连接串明文或 KMS 密钥值;主机名与用户名
 * 只允许出现在服务端日志,绝不进入 HTTP 响应。
 */

export interface DatabaseConfigEnv {
  DATABASE_URL?: string | undefined;
  POSTGRES_HOST?: string | undefined;
  POSTGRES_DB?: string | undefined;
  POSTGRES_USER?: string | undefined;
  POSTGRES_PASSWORD?: string | undefined;
}

const postgresPieceVariables = [
  "POSTGRES_HOST",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
] as const;

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/** 缺哪些数据库变量;完整(DATABASE_URL 或四个 POSTGRES_* 拼件)时返回空数组。 */
export function findMissingDatabaseConfig(env: DatabaseConfigEnv = process.env): string[] {
  if (hasValue(env.DATABASE_URL)) return [];
  return postgresPieceVariables.filter((name) => !hasValue(env[name]));
}

/**
 * 配置不完整(或 DATABASE_URL 格式非法)时抛错,错误信息点名缺失的变量名;
 * 绝不回显任何变量值。
 */
export function assertDatabaseConfigComplete(env: DatabaseConfigEnv = process.env): void {
  const missing = findMissingDatabaseConfig(env);
  if (missing.length > 0) {
    throw new Error(
      `缺少数据库配置环境变量:${missing.join("、")}。` +
      "请配置 DATABASE_URL,或配齐 POSTGRES_HOST / POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD",
    );
  }
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) {
    try {
      // 只校验可解析性;URL 内含凭据,任何情况下不回显。
      new URL(databaseUrl);
    } catch {
      throw new Error("DATABASE_URL 格式非法(出于安全不回显其值,请核对密钥来源)");
    }
  }
}

/** 结构兼容 pg.Pool / pg.PoolClient,测试可直接用 fake 注入。 */
export interface ProbeQueryResult {
  rows: Array<Record<string, unknown>>;
}

export interface ProbeClientLike {
  query(text: string, params?: readonly unknown[]): Promise<ProbeQueryResult>;
  release(): void;
}

export interface ProbePoolLike {
  connect(): Promise<ProbeClientLike>;
}

export type DatabaseProbeFailureKind = DatabaseErrorKind;

export interface DatabaseProbeFailure {
  kind: DatabaseProbeFailureKind;
  /** 供服务端日志使用的原始错误消息;绝不包含密码或连接串。 */
  detail: string;
}

const defaultProbeTimeoutMs = 5_000;

/**
 * 真实连库探测(带超时):先 select 1 验证连通与认证,再确认目标 schema 存在。
 * 返回 null 表示通过;否则给出三类可运维区分——连不上主机 / 认证失败 /
 * 库或 schema 不存在(以及兜底的 unknown)。
 */
export async function probeDatabaseConnection(
  pool: ProbePoolLike,
  options: { schemaName: string; timeoutMs?: number },
): Promise<DatabaseProbeFailure | null> {
  const timeoutMs = options.timeoutMs ?? defaultProbeTimeoutMs;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      runProbe(pool, options.schemaName),
      new Promise<DatabaseProbeFailure>((resolve) => {
        // The awaited timeout must stay referenced until it settles. Unref here
        // lets Node 22 end the test worker with the probe promise still pending.
        timer = setTimeout(() => {
          resolve({ kind: "host_unreachable", detail: `连接数据库超时(超过 ${timeoutMs}ms)` });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runProbe(pool: ProbePoolLike, schemaName: string): Promise<DatabaseProbeFailure | null> {
  let client: ProbeClientLike;
  try {
    client = await pool.connect();
  } catch (error) {
    return classifyProbeError(error);
  }
  try {
    await client.query("select 1");
    const schemaResult = await client.query(
      "select exists(select 1 from pg_namespace where nspname = $1) as exists",
      [schemaName],
    );
    if (schemaResult.rows[0]?.["exists"] !== true) {
      return { kind: "database_or_schema_missing", detail: `目标 schema 不存在:${schemaName}` };
    }
    return null;
  } catch (error) {
    return classifyProbeError(error);
  } finally {
    client.release();
  }
}

function classifyProbeError(error: unknown): DatabaseProbeFailure {
  return {
    kind: classifyDatabaseError(error),
    detail: error instanceof Error ? error.message : String(error),
  };
}

const probeFailureLabels: Record<DatabaseProbeFailureKind, string> = {
  host_unreachable: "无法连接数据库主机",
  auth_failed: "数据库认证失败(用户名或密码错误)",
  database_or_schema_missing: "数据库或目标 schema 不存在",
  unknown: "数据库探测出现未分类错误",
};

/** 服务端日志用的人话描述;不含密码与连接串。 */
export function describeProbeFailure(failure: DatabaseProbeFailure): string {
  return `${probeFailureLabels[failure.kind]}:${failure.detail}`;
}
