import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDatabasePoolConfig } from "../src/db/client.js";
import { resolvePostgresTls } from "../src/db/tls.js";

function withCertificateFile(run: (certificatePath: string) => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "shortdrama-pg-ca-"));
  const certificatePath = path.join(directory, "ca.pem");
  writeFileSync(certificatePath, "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n", "utf8");
  try {
    run(certificatePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("verify-full reads the mounted CA and verifies the intended RDS hostname", () => {
  withCertificateFile((certificatePath) => {
    const tls = resolvePostgresTls({
      mode: "verify-full",
      rootCertPath: certificatePath,
      servername: "postgres.rds-pg.volces.com",
    });
    assert.equal(tls?.rejectUnauthorized, true);
    assert.equal(tls?.servername, "postgres.rds-pg.volces.com");
    assert.match(String(tls?.ca), /BEGIN CERTIFICATE/);
  });
});

test("verify-full rejects a missing or relative CA path", () => {
  assert.throws(
    () => resolvePostgresTls({ mode: "verify-full", servername: "postgres.rds-pg.volces.com" }),
    /POSTGRES_SSL_ROOT_CERT is required/,
  );
  assert.throws(
    () => resolvePostgresTls({ mode: "verify-full", rootCertPath: "ca.pem", servername: "postgres.rds-pg.volces.com" }),
    /must be an absolute path/,
  );
});

test("the development default keeps legacy connection-string behavior", () => {
  const config = buildDatabasePoolConfig("postgresql://local:secret@localhost:5432/shortdrama?sslmode=disable", {
    postgresSslMode: "disable",
    postgresSslRootCert: undefined,
  });
  assert.equal(config.connectionString, "postgresql://local:secret@localhost:5432/shortdrama?sslmode=disable");
  assert.equal(config.ssl, undefined);
});

test("verify-full ignores unsafe connection-string TLS query parameters", () => {
  withCertificateFile((certificatePath) => {
    const config = buildDatabasePoolConfig(
      "postgresql://app:secret@postgres.rds-pg.volces.com:5432/shortdrama?sslmode=disable&ssl=false",
      { postgresSslMode: "verify-full", postgresSslRootCert: certificatePath },
    );
    assert.equal(config.connectionString, undefined);
    assert.equal(config.host, "postgres.rds-pg.volces.com");
    assert.equal(config.database, "shortdrama");
    assert.equal((config.ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized, true);
    assert.equal((config.ssl as { servername?: string }).servername, "postgres.rds-pg.volces.com");
  });
});
