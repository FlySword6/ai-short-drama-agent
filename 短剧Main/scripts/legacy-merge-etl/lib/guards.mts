/**
 * ETL 安全护栏:schema 名合法性、连接目标安全性。
 *
 * 红线:默认只允许本机/本地 Compose 目标;读云库 common 是 Fable 在获批
 * 窗口内的动作,必须显式 --allow-remote(或 LEGACY_ETL_ALLOW_REMOTE=1),
 * 否则一律拒绝——本包自身绝对不连云库。
 */

const schemaNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "db", "postgres"]);

export function assertSafeSchemaName(value: string): string {
  if (!schemaNamePattern.test(value)) {
    throw new Error(`schema 名不合法: ${JSON.stringify(value)}——只允许字母/数字/下划线,字母或下划线开头`);
  }
  return value;
}

export function quoteIdent(value: string): string {
  return `"${assertSafeSchemaName(value).replaceAll('"', '""')}"`;
}

export interface ParsedDatabaseUrl {
  host: string;
  port: number;
  database: string;
  user: string;
}

export function parseDatabaseUrl(raw: string): ParsedDatabaseUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`无法解析数据库连接串(格式应如 postgresql://user:pass@host:5432/db)`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`无法解析数据库连接串(协议必须是 postgresql://)`);
  }
  const host = url.hostname.toLowerCase();
  if (!host) throw new Error("无法解析数据库连接串(缺少主机名)");
  return {
    host,
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username),
  };
}

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTNAMES.has(host.toLowerCase());
}

/**
 * 未显式授权时,源与目标都必须是本机/本地 Compose。显式授权
 * (--allow-remote)是 Fable 在获批窗口内读云库 common 的通道;
 * 目标库默认仍只许本机——真实切流前的演练只允许打在本地副本。
 * 唯一的例外是 R30 批准的 dev/test 环境导入:此时执行人必须再显式加
 * --allow-remote-target(或 LEGACY_ETL_ALLOW_REMOTE_TARGET=1),双开关齐备
 * 才允许写非本机目标,防止只凭一个惯性开关把数据写进云库。
 */
export function assertSafeEndpoints(input: {
  sourceUrl: string;
  targetUrl: string;
  allowRemote: boolean;
  allowRemoteTarget?: boolean;
}): void {
  const source = parseDatabaseUrl(input.sourceUrl);
  const target = parseDatabaseUrl(input.targetUrl);
  if (!input.allowRemote) {
    if (!isLocalHost(source.host)) {
      throw new Error(
        `绝不连云库:源 ${source.host} 不是本机/本地 Compose。真实源读取由 Fable 在获批窗口内加 --allow-remote 执行`,
      );
    }
    if (!isLocalHost(target.host)) {
      throw new Error(
        `绝不连云库:目标 ${target.host} 不是本机/本地 Compose。写入演练只允许打在本地库`,
      );
    }
    return;
  }
  if (!isLocalHost(target.host) && !input.allowRemoteTarget) {
    throw new Error(
      `目标 ${target.host} 不是本机:写非本机目标必须再显式加 --allow-remote-target(R30 批准的 dev/test 导入专用双开关)`,
    );
  }
}

/**
 * rollback 只有目标库(不写源),同样受双开关约束:非本机目标必须
 * --allow-remote 与 --allow-remote-target 同时显式给出,与 plan/apply 同口径。
 */
export function assertSafeWriteTarget(input: {
  targetUrl: string;
  allowRemote: boolean;
  allowRemoteTarget?: boolean;
}): void {
  const target = parseDatabaseUrl(input.targetUrl);
  if (isLocalHost(target.host)) return;
  if (!input.allowRemote || !input.allowRemoteTarget) {
    throw new Error(
      `目标 ${target.host} 不是本机:回滚非本机目标必须同时显式加 --allow-remote 与 --allow-remote-target(R30 批准的 dev/test 导入专用双开关)`,
    );
  }
}
