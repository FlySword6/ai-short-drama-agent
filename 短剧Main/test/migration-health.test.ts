import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkExtensions,
  checkLedger,
  checkNumbering,
  checkPlaceholders,
  computeChecksum,
  findReferencedExtensions,
  listMigrationFiles,
  runAllChecks,
  updateLedger,
} from "../scripts/check-migrations.mts";
import { renderMigrationSql } from "../src/db/migrate.js";

const migrationsDirectory = path.resolve("migrations");

test("当前仓库迁移全量通过体检:编号/占位符/台账/扩展", async () => {
  assert.deepEqual(await runAllChecks(migrationsDirectory), []);
});

test("每个迁移经迁移器同款渲染后无残留占位符", async () => {
  const { files } = await listMigrationFiles(migrationsDirectory);
  assert.ok(files.length > 0);
  for (const name of files) {
    const source = await readFile(path.join(migrationsDirectory, name), "utf8");
    const rendered = renderMigrationSql(source, "health_check_schema");
    assert.equal(rendered.includes("{{"), false, `${name} 渲染后仍残留 {{`);
    assert.equal(rendered.includes("}}"), false, `${name} 渲染后仍残留 }}`);
  }
});

test("checksum 算法与迁移器一致(sha256 hex)", async () => {
  const source = await readFile(path.join(migrationsDirectory, "001_v01_core.sql"), "utf8");
  assert.match(computeChecksum(source), /^[0-9a-f]{64}$/);
  const ledger = JSON.parse(await readFile(path.join(migrationsDirectory, "ledger.json"), "utf8"));
  assert.equal(ledger.checksums["001_v01_core.sql"], computeChecksum(source));
});

test("编号检查:跳号、重号、无法识别的文件名都被发现", async () => {
  assert.deepEqual(checkNumbering({ files: [], unrecognized: [] }), []);
  assert.deepEqual(
    checkNumbering({ files: ["001_a.sql", "002_b.sql"], unrecognized: [] }),
    [],
  );
  const gapped = checkNumbering({ files: ["001_a.sql", "003_c.sql"], unrecognized: [] });
  assert.equal(gapped.length, 1);
  assert.match(gapped[0]!, /缺 002/);
  const duplicated = checkNumbering({ files: ["001_a.sql", "001_b.sql"], unrecognized: [] });
  assert.equal(duplicated.length, 1);
  assert.match(duplicated[0]!, /重号/);
  const unrecognized = checkNumbering({ files: ["001_a.sql"], unrecognized: ["notes.sql"] });
  assert.equal(unrecognized.length, 1);
  assert.match(unrecognized[0]!, /静默跳过/);
});

test("占位符检查:未知占位符与不成对都被发现", async () => {
  assert.deepEqual(checkPlaceholders("CREATE TABLE {{schema}}.t (id uuid);", "x.sql"), []);
  assert.equal(checkPlaceholders("CREATE TABLE {{schem}}.t (id uuid);", "x.sql").length, 1);
  assert.equal(checkPlaceholders("CREATE TABLE {{schema.t (id uuid);", "x.sql").length, 1);
  assert.equal(checkPlaceholders("CREATE TABLE schema}}.t (id uuid);", "x.sql").length, 1);
  // 未知占位符与残留可以同时报,但正常双占位符用法不许误报。
  assert.deepEqual(
    checkPlaceholders("ALTER TABLE {{schema}}.a ADD CONSTRAINT c FOREIGN KEY REFERENCES {{schema}}.b(id);", "x.sql"),
    [],
  );
});

test("台账检查:改动已入账迁移被发现,--update-ledger 拒绝覆盖旧账", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "s22-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "ledger.json");
  await writeFile(path.join(directory, "001_first.sql"), "SELECT 1;\n");
  await writeFile(path.join(directory, "002_second.sql"), "SELECT 2;\n");

  // 首次入账:两个新迁移都追加。
  const first = await updateLedger(directory, ["001_first.sql", "002_second.sql"], ledgerPath);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.added, ["001_first.sql", "002_second.sql"]);
  assert.deepEqual(await checkLedger(directory, ["001_first.sql", "002_second.sql"], ledgerPath), []);

  // 新增迁移:正常追加。
  await writeFile(path.join(directory, "003_third.sql"), "SELECT 3;\n");
  const missing = await checkLedger(directory, ["001_first.sql", "002_second.sql", "003_third.sql"], ledgerPath);
  assert.equal(missing.length, 1);
  assert.match(missing[0]!, /003_third\.sql.*未入账/);
  const appended = await updateLedger(directory, ["001_first.sql", "002_second.sql", "003_third.sql"], ledgerPath);
  assert.deepEqual(appended.errors, []);
  assert.deepEqual(appended.added, ["003_third.sql"]);

  // 事后修改已入账迁移:体检和更新都要拒绝。
  await writeFile(path.join(directory, "001_first.sql"), "SELECT 1; -- tampered\n");
  const tampered = await checkLedger(directory, ["001_first.sql", "002_second.sql", "003_third.sql"], ledgerPath);
  assert.equal(tampered.length, 1);
  assert.match(tampered[0]!, /001_first\.sql.*禁止事后修改/);
  const refused = await updateLedger(directory, ["001_first.sql", "002_second.sql", "003_third.sql"], ledgerPath);
  assert.equal(refused.errors.length, 1);
  // 台账内容未被覆盖。
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.checksums["001_first.sql"], computeChecksum("SELECT 1;\n"));
});

test("扩展检查:未登记依赖、CREATE EXTENSION、台账脱节都被发现", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "s22-ext-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registryPath = path.join(directory, "extensions.json");
  const migration = [
    "DO $$ BEGIN",
    "  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN RAISE EXCEPTION 'missing';",
    "  END IF;",
    "END $$;",
  ].join("\n");
  await writeFile(path.join(directory, "001_needs_trgm.sql"), migration);
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    extensions: [{ name: "pg_trgm", requiredBy: ["001_needs_trgm.sql"] }],
  }));

  assert.deepEqual(findReferencedExtensions(migration), ["pg_trgm"]);
  assert.deepEqual(await checkExtensions(directory, ["001_needs_trgm.sql"], registryPath), []);

  // 未登记。
  await writeFile(registryPath, JSON.stringify({ version: 1, extensions: [] }));
  const undeclared = await checkExtensions(directory, ["001_needs_trgm.sql"], registryPath);
  assert.equal(undeclared.length, 1);
  assert.match(undeclared[0]!, /pg_trgm 但未在 migrations\/extensions\.json 登记/);

  // requiredBy 漏登本迁移。
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    extensions: [{ name: "pg_trgm", requiredBy: ["001_needs_trgm.sql"] }, { name: "pgcrypto", requiredBy: ["001_needs_trgm.sql"] }],
  }));
  const dangling = await checkExtensions(directory, ["001_needs_trgm.sql"], registryPath);
  assert.equal(dangling.length, 1);
  assert.match(dangling[0]!, /pgcrypto.*该迁移并未引用/);

  // CREATE EXTENSION 一律禁止。
  await writeFile(path.join(directory, "001_needs_trgm.sql"), "CREATE EXTENSION IF NOT EXISTS pg_trgm;\n");
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    extensions: [{ name: "pg_trgm", requiredBy: ["001_needs_trgm.sql"] }],
  }));
  const createExtension = await checkExtensions(directory, ["001_needs_trgm.sql"], registryPath);
  assert.ok(createExtension.some((error) => /禁止 CREATE EXTENSION/.test(error)));
});

test("当前扩展声明能回答『这套迁移需要哪些扩展』", async () => {
  const registry = JSON.parse(await readFile(path.join(migrationsDirectory, "extensions.json"), "utf8"));
  assert.ok(Array.isArray(registry.extensions));
  assert.ok(registry.extensions.length > 0);
  for (const entry of registry.extensions) {
    assert.ok(entry.name, "扩展必须有名字");
    assert.ok(entry.requiredBy.length > 0, `${entry.name} 必须指向依赖它的迁移`);
  }
});
