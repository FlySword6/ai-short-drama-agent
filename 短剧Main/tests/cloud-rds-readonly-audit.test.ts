import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import {
  READ_ONLY_SESSION_OPTIONS,
  SafeAuditError,
  V011_EXPECTED_MIGRATION_VERSIONS,
  assertTargetAllowed,
  assertCloudInvocationPolicy,
  buildClientConfig,
  classifyTarget,
  compareMigrations,
  connectionTarget,
  diagnoseAuditFailure,
  mergeDatabaseEnvironment,
  parseCliArgs,
  quotePgIdentifier,
  readExpectedMigrations,
  targetFingerprint,
} from "../scripts/audit-cloud-rds-readonly.js";

test("runtime diagnostics expose only an allowlisted category", () => {
  const secretBearingError = Object.assign(
    new Error("unable to verify the first certificate for postgres-secret.example with password=swordfish"),
    { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", host: "postgres-secret.example", password: "swordfish" },
  );
  const diagnosis = diagnoseAuditFailure(secretBearingError);

  assert.deepEqual(diagnosis, {
    category: "TLS_CERTIFICATE",
  });
  const serialized = JSON.stringify(diagnosis);
  assert.doesNotMatch(serialized, /postgres-secret|swordfish|certificate/);
});

test("runtime diagnostics classify nested network errors without returning their messages", () => {
  const nested = Object.assign(new Error("aggregate connect failure"), {
    errors: [Object.assign(new Error("getaddrinfo ENOTFOUND private-db.example"), { code: "ENOTFOUND" })],
  });

  assert.deepEqual(diagnoseAuditFailure(nested), {
    category: "NETWORK_DNS",
  });
});

test("cloud client config refuses implicit process credential fallback", () => {
  assert.throws(
    () =>
      buildClientConfig(
        {
          POSTGRES_HOST: "postgres.rds-pg.volces.com",
          POSTGRES_DB: "shortdrama",
          POSTGRES_USER: "readonly",
        },
        "cloud",
      ),
    /explicit credentials/,
  );
  assert.throws(
    () => buildClientConfig({ DATABASE_URL: "postgresql://readonly@postgres.rds-pg.volces.com/shortdrama" }, "cloud"),
    /explicit credentials/,
  );
});

test("env file parser only admits PostgreSQL connection keys", () => {
  const environment = mergeDatabaseEnvironment(
    { POSTGRES_HOST: "inherited.example", POSTGRES_PORT: "6543", TOS_SECRET_KEY: "must-not-pass" },
    [
      "POSTGRES_HOST=rds.example",
      "POSTGRES_DB=shortdrama",
      "POSTGRES_USER=readonly",
      "POSTGRES_PASSWORD='not-printed'",
      "TOS_SECRET_KEY=must-not-pass-either",
      "ARBITRARY_COMMAND=$(touch /tmp/never)",
    ].join("\n"),
  );

  assert.deepEqual(environment, {
    POSTGRES_HOST: "rds.example",
    POSTGRES_DB: "shortdrama",
    POSTGRES_USER: "readonly",
    POSTGRES_PASSWORD: "not-printed",
  });
  assert.equal("TOS_SECRET_KEY" in environment, false);
  assert.equal("ARBITRARY_COMMAND" in environment, false);
  assert.equal("POSTGRES_PORT" in environment, false);
});

test("connection config enforces read-only startup settings", () => {
  const config = buildClientConfig({
    POSTGRES_HOST: "db.example",
    POSTGRES_DB: "shortdrama",
    POSTGRES_USER: "auditor",
    POSTGRES_PASSWORD: "example-only",
  });

  assert.match(READ_ONLY_SESSION_OPTIONS, /default_transaction_read_only=on/);
  assert.equal(config.options, READ_ONLY_SESSION_OPTIONS);
  assert.equal(config.statement_timeout, 15_000);
  assert.equal(config.lock_timeout, 3_000);
  assert.equal(config.application_name, "v011_cloud_rds_readonly_audit");
});

test("cloud DATABASE_URL cannot weaken TLS or the read-only startup guard", () => {
  const config = buildClientConfig({
    DATABASE_URL:
      "postgresql://approved-user:approved-password@db.example:5432/shortdrama?host=other.example&port=6543&sslmode=disable&ssl=false&sslrootcert=/tmp/untrusted&sslnegotiation=direct&options=-c%20default_transaction_read_only%3Doff",
  }, "cloud");
  const client = new Client(config);

  assert.equal(config.connectionString, undefined);
  assert.equal(client.connectionParameters.host, "db.example");
  assert.equal(client.connectionParameters.port, 5432);
  assert.equal(client.connectionParameters.database, "shortdrama");
  assert.deepEqual(config.ssl, { rejectUnauthorized: true, servername: "db.example" });
  assert.deepEqual(client.connectionParameters.ssl, { rejectUnauthorized: true, servername: "db.example" });
});

test("cloud audit uses an isolated configured CA without weakening hostname validation", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "shortdrama-cloud-audit-ca-"));
  const certificatePath = path.join(directory, "ca.pem");
  writeFileSync(certificatePath, "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n", "utf8");
  try {
    const config = buildClientConfig({
      POSTGRES_HOST: "postgres.rds-pg.volces.com",
      POSTGRES_DB: "shortdrama",
      POSTGRES_USER: "auditor",
      POSTGRES_PASSWORD: "example-only",
      POSTGRES_SSL_MODE: "verify-full",
      POSTGRES_SSL_ROOT_CERT: certificatePath,
    }, "cloud");
    assert.equal((config.ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized, true);
    assert.equal((config.ssl as { servername?: string }).servername, "postgres.rds-pg.volces.com");
    assert.match(String((config.ssl as { ca?: string }).ca), /BEGIN CERTIFICATE/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cloud audit requires an explicit isolated env file and approved target fingerprint before any client is constructed", () => {
  const target = { host: "postgres.rds-pg.volces.com", port: "5432", database: "shortdrama" };
  const fingerprint = targetFingerprint(target);

  assert.throws(
    () =>
      assertCloudInvocationPolicy(
        { migrationsDirectory: "/repo/migrations", scope: "cloud", expectedFingerprint: fingerprint },
        target,
      ),
    /--env-file/,
  );
  assert.throws(
    () =>
      assertCloudInvocationPolicy(
        {
          migrationsDirectory: "/repo/migrations",
          scope: "cloud",
          envFile: "/secure/audit.env",
          expectedFingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
        target,
      ),
    /fingerprint does not match/,
  );
  assert.doesNotThrow(() =>
    assertCloudInvocationPolicy(
      {
        migrationsDirectory: "/repo/migrations",
        scope: "cloud",
        envFile: "/secure/audit.env",
        expectedFingerprint: fingerprint,
      },
      target,
    ),
  );
});

test("cloud scope permits known managed RDS DNS and rejects local or unknown targets", () => {
  assert.equal(classifyTarget("localhost"), "local");
  assert.equal(classifyTarget("127.0.0.1"), "local");
  assert.equal(classifyTarget("db.cluster.rds.amazonaws.com"), "managed_rds_dns");
  assert.equal(classifyTarget("postgres.rds-pg.volces.com"), "managed_rds_dns");
  assert.equal(classifyTarget("postgres.internal.example"), "cloud_unconfirmed");
  assert.doesNotThrow(() => assertTargetAllowed("cloud", "managed_rds_dns"));
  assert.throws(() => assertTargetAllowed("cloud", "local"), SafeAuditError);
  assert.throws(() => assertTargetAllowed("cloud", "cloud_unconfirmed"), SafeAuditError);
  assert.doesNotThrow(() => assertTargetAllowed("dev-test", "local"));
});

test("target parsing and fingerprint do not expose credentials", () => {
  const connectionUrl = new URL("postgresql://db.example:5432/shortdrama");
  connectionUrl.username = "example-user";
  connectionUrl.password = "example-password";
  const target = connectionTarget({ DATABASE_URL: connectionUrl.toString() });
  const fingerprint = targetFingerprint(target);

  assert.deepEqual(target, { host: "db.example", port: "5432", database: "shortdrama" });
  assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(fingerprint, /user|password|db\.example|shortdrama/);
});

test("migration comparison reports missing, extra, and checksum drift", () => {
  assert.deepEqual(V011_EXPECTED_MIGRATION_VERSIONS.map((version) => version.slice(0, 3)), [
    "001",
    "002",
    "003",
    "004",
    "005",
    "006",
    "007",
    "008",
    "009",
    "010",
    "011",
    "012",
  ]);
  const comparison = compareMigrations(
    [
      { version: "001_core.sql", checksum: "aaa" },
      { version: "002_more.sql", checksum: "bbb" },
    ],
    [
      { version: "001_core.sql", checksum: "changed", appliedAt: "2026-07-21T00:00:00.000Z" },
      { version: "003_extra.sql", checksum: "ccc", appliedAt: "2026-07-21T00:00:00.000Z" },
    ],
  );

  assert.deepEqual(comparison, {
    status: "drift",
    missing: ["002_more.sql"],
    extra: ["003_extra.sql"],
    checksumMismatch: ["001_core.sql"],
  });
});

test("local V011 migration inventory is the frozen 001-012 sequence", async () => {
  const migrations = await readExpectedMigrations(fileURLToPath(new URL("../migrations", import.meta.url)));
  assert.deepEqual(
    migrations.map(({ version }) => version),
    [...V011_EXPECTED_MIGRATION_VERSIONS],
  );
  assert.equal(migrations.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)), true);
});

test("CLI parser rejects unsafe schema names and unknown arguments", () => {
  assert.deepEqual(parseCliArgs(["--scope", "dev-test", "--schema", "common"], "/repo"), {
    migrationsDirectory: "/repo/migrations",
    schema: "common",
    scope: "dev-test",
  });
  assert.throws(() => parseCliArgs(["--schema", "common;drop"]), SafeAuditError);
  assert.throws(() => parseCliArgs(["--password", "secret"]), /Unknown argument/);
  assert.equal(parseCliArgs(["--help"]).help, true);
  assert.throws(() => parseCliArgs([]), /--env-file/);
  assert.throws(
    () => parseCliArgs(["--env-file", ".env.cloud", "--expected-fingerprint", "not-a-fingerprint"]),
    /--expected-fingerprint/,
  );
  assert.deepEqual(
    parseCliArgs(["--scope", "dev-test", "--schema", "common"], "/repo"),
    {
      migrationsDirectory: "/repo/migrations",
      schema: "common",
      scope: "dev-test",
    },
  );
  assert.equal(quotePgIdentifier('odd"name'), '"odd""name"');
});
