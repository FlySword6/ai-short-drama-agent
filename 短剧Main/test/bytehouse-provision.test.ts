import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGrantBoundary,
  inspectSchemaState,
  isExpectedByteHousePrincipalIdentity,
  loadByteHouseSchema,
  splitSqlStatements,
  type ByteHouseSchemaQueryClient,
  type ByteHouseSchemaTarget,
} from "../scripts/bytehouse-schema.mts";

const target: ByteHouseSchemaTarget = {
  environment: "dev",
  database: "shortdrama_analytics",
  endpointEnv: "BYTEHOUSE_DEV_HTTP_ENDPOINT",
  credentialRole: "app",
  usernameEnv: "BYTEHOUSE_DEV_APP_USERNAME",
  passwordEnv: "BYTEHOUSE_DEV_APP_PASSWORD",
  endpoint: new URL("https://example.invalid:8123"),
  username: "tenant::app::dev",
  password: "not-a-real-password",
};

function inventoryClient(names: readonly string[]): ByteHouseSchemaQueryClient {
  return {
    async query() {
      return "";
    },
    async queryJson<T>() {
      return names.map((name) => ({
        name,
        engine: name.startsWith("v_") ? "View" : "CnchMergeTree",
        partition_key: "",
        sorting_key: "",
        primary_key: "",
        comment: "",
        create_table_query: "",
      })) as T[];
    },
  };
}

test("controlled SQL splitter ignores semicolons inside strings and comments", () => {
  const statements = splitSqlStatements(`
-- lead ; comment
CREATE TABLE x (a String COMMENT 'x;y');
/* block ; comment */
CREATE VIEW y AS SELECT 'a;b';
  `);
  assert.equal(statements.length, 2);
  assert.match(statements[0]!, /CREATE TABLE/u);
  assert.match(statements[1]!, /CREATE VIEW/u);
});

test("write preflight ignores S55-HW and supports safe partial resume", async () => {
  const bundle = await loadByteHouseSchema();
  assert.equal(
    await inspectSchemaState(target, inventoryClient(["s55_hello_world"]), bundle),
    "empty",
  );
  assert.equal(
    await inspectSchemaState(
      target,
      inventoryClient(["s55_hello_world", bundle.tables[0]!.name]),
      bundle,
    ),
    "partial",
  );
  await assert.rejects(
    inspectSchemaState(target, inventoryClient(["unexpected_table"]), bundle),
    /写前对象清单漂移/u,
  );
});

test("app and readonly grants enforce the exact least-privilege boundary", () => {
  assert.doesNotThrow(() => assertGrantBoundary(
    "GRANT CREATE TABLE, CREATE VIEW, INSERT, SELECT, SHOW ON SHORTDRAMA_ANALYTICS.* TO app",
    target,
  ));
  assert.doesNotThrow(() => assertGrantBoundary(
    "GRANT CREATE, INSERT, SELECT, SHOW ON SHORTDRAMA_ANALYTICS.* TO app",
    target,
  ));
  assert.doesNotThrow(() => assertGrantBoundary(
    "GRANT SHOW DATABASES, SHOW TABLES, SHOW COLUMNS, SHOW DICTIONARIES, SELECT, INSERT, CREATE DATABASE, CREATE TABLE, CREATE VIEW, CREATE DICTIONARY ON SHORTDRAMA_ANALYTICS.* TO app",
    target,
  ));
  assert.doesNotThrow(() => assertGrantBoundary(
    "GRANT SELECT ON SHORTDRAMA_ANALYTICS.* TO reader",
    { ...target, credentialRole: "readonly" },
  ));
  assert.throws(() => assertGrantBoundary(
    "GRANT CREATE TABLE, CREATE VIEW, SELECT ON SHORTDRAMA_ANALYTICS.* TO app",
    target,
  ), /缺少受控/u);
  assert.throws(() => assertGrantBoundary(
    "GRANT ALL ON SHORTDRAMA_ANALYTICS.* TO app",
    target,
  ), /权限超出/u);
  assert.throws(() => assertGrantBoundary(
    "GRANT CREATE, INSERT, SELECT, SHOW ON SHORTDRAMA_ANALYTICS.* TO app WITH GRANT OPTION",
    target,
  ), /权限超出/u);
  assert.doesNotThrow(() => assertGrantBoundary(
    "GRANT CREATE, INSERT, SELECT, SHOW ON SHORTDRAMA_ANALYTICS.* TO app WITH GRANT OPTION",
    target,
    { allowTargetGrantOption: true },
  ));
  assert.doesNotThrow(() => assertGrantBoundary(
    "GRANT SHOW DATABASES, SHOW TABLES, SHOW COLUMNS, SHOW DICTIONARIES, SELECT, INSERT, ALTER TABLE, ALTER VIEW, CREATE DATABASE, CREATE TABLE, CREATE VIEW, CREATE DICTIONARY, DROP DATABASE, DROP TABLE, DROP VIEW, DROP DICTIONARY, TRUNCATE, OPTIMIZE, dictGet ON SHORTDRAMA_ANALYTICS.* TO app WITH GRANT OPTION",
    target,
    { allowTargetGrantOption: true },
  ));
  assert.throws(() => assertGrantBoundary(
    "GRANT SELECT ON OTHER_DATABASE.* TO reader",
    { ...target, credentialRole: "readonly" },
  ), /目标库外/u);
  assert.throws(() => assertGrantBoundary(
    "GRANT SELECT, SHOW ON SHORTDRAMA_ANALYTICS.* TO reader",
    { ...target, credentialRole: "readonly" },
  ), /精确白名单/u);
});

test("identity check accepts ByteHouse short and canonical principal forms only", () => {
  assert.equal(isExpectedByteHousePrincipalIdentity("app", "tenant::app::dev", "dev"), true);
  assert.equal(isExpectedByteHousePrincipalIdentity("tenant::app::dev", "app", "dev"), true);
  assert.equal(
    isExpectedByteHousePrincipalIdentity("tenant::app::dev", "tenant::app::dev", "dev"),
    true,
  );
  assert.equal(isExpectedByteHousePrincipalIdentity("1234567890", "tenant::app::dev", "dev"), true);
  assert.equal(isExpectedByteHousePrincipalIdentity("other", "tenant::app::dev", "dev"), false);
  assert.equal(isExpectedByteHousePrincipalIdentity("app", "tenant::app::prod", "dev"), false);
  assert.equal(isExpectedByteHousePrincipalIdentity("tenant::app::qa", "app", "dev"), false);
});

test("schema bundle contains seven domain tables, one control table and ten views", async () => {
  const bundle = await loadByteHouseSchema();
  assert.equal(bundle.tables.length, 8);
  assert.equal(bundle.views.length, 10);
  assert.equal(bundle.tables.at(-1)?.name, "asset_vector_index");
  assert.ok(bundle.tables.every(({ source }) => source.includes("IF NOT EXISTS")));
  assert.ok(bundle.views.every(({ source }) => source.includes("IF NOT EXISTS")));
});
