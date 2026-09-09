import { Pool, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { settings } from "../config/env.js";
import * as schema from "./schema.js";
import { resolvePostgresTls } from "./tls.js";

export type Database = NodePgDatabase<typeof schema.databaseSchema>;

export interface DatabaseHandle {
  db: Database;
  pool: Pool;
}

export function buildDatabasePoolConfig(
  databaseUrl: string,
  tls: Pick<typeof settings, "postgresSslMode" | "postgresSslRootCert"> = settings,
): PoolConfig {
  const url = new URL(databaseUrl);
  const ssl = resolvePostgresTls({
    mode: tls.postgresSslMode,
    rootCertPath: tls.postgresSslRootCert,
    servername: url.hostname,
  });

  // node-postgres gives SSL query parameters in a connection string precedence
  // over a top-level `ssl` object. Under verify-full, construct authority
  // fields directly so an inherited URL parameter cannot weaken TLS checks.
  if (ssl) {
    if (!url.hostname || !url.pathname || url.pathname === "/") {
      throw new Error("DATABASE_URL must include a PostgreSQL host and database name");
    }
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      database: decodeURIComponent(url.pathname.slice(1)),
      user: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      ssl,
      max: 10,
    };
  }
  return { connectionString: databaseUrl, max: 10 };
}

export function createDatabase(
  databaseUrl = settings.databaseUrl,
  tls: Pick<typeof settings, "postgresSslMode" | "postgresSslRootCert"> = settings,
): DatabaseHandle {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or complete POSTGRES_* configuration is required for database operations");
  }

  const pool = new Pool(buildDatabasePoolConfig(databaseUrl, tls));
  return {
    db: drizzle(pool, { schema: schema.databaseSchema }),
    pool,
  };
}
