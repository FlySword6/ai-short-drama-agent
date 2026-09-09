import { readFileSync } from "node:fs";
import path from "node:path";
import type { ConnectionOptions } from "node:tls";

export type PostgresSslMode = "disable" | "verify-full";

export interface PostgresTlsOptions {
  mode?: PostgresSslMode;
  rootCertPath?: string;
  servername: string;
}

/**
 * The production RDS contract is TLS verify-full: trust only the mounted CA
 * and verify the requested RDS host name. Leaving the mode unset preserves the
 * existing local development default (no explicit TLS configuration).
 */
export function resolvePostgresTls(options: PostgresTlsOptions): ConnectionOptions | undefined {
  if (!options.mode || options.mode === "disable") return undefined;
  if (options.mode !== "verify-full") {
    throw new Error("POSTGRES_SSL_MODE must be verify-full or disable");
  }

  const rootCertPath = options.rootCertPath?.trim();
  if (!rootCertPath) {
    throw new Error("POSTGRES_SSL_ROOT_CERT is required when POSTGRES_SSL_MODE=verify-full");
  }
  if (!path.isAbsolute(rootCertPath)) {
    throw new Error("POSTGRES_SSL_ROOT_CERT must be an absolute path");
  }

  const ca = readFileSync(rootCertPath, "utf8");
  if (!ca.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error("POSTGRES_SSL_ROOT_CERT must contain a PEM certificate");
  }
  return { ca, servername: options.servername, rejectUnauthorized: true };
}
