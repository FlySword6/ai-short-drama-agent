import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeEndpoints,
  assertSafeSchemaName,
  assertSafeWriteTarget,
  isLocalHost,
  parseDatabaseUrl,
  quoteIdent,
} from "../../scripts/legacy-merge-etl/lib/guards.mjs";
import {
  REDLINE_COLUMNS,
  REDLINE_TABLES,
  SOURCE_COLUMN_WHITELIST,
  assertExtractionSafe,
  assertWhitelistSelfConsistent,
  selectList,
} from "../../scripts/legacy-merge-etl/lib/redlines.mjs";
import {
  buildGlobalVerificationQueries,
  classifyClosure,
  conservationFailures,
} from "../../scripts/legacy-merge-etl/lib/verify.mjs";

// ---------------------------------------------------------------------------
// 红线护栏
// ---------------------------------------------------------------------------

test("白名单自洽:不含红线列/红线表", () => {
  assert.doesNotThrow(() => assertWhitelistSelfConsistent());
});

test("selectList: 白名单表的列清单不含红线列;未知表抛错", () => {
  for (const table of Object.keys(SOURCE_COLUMN_WHITELIST)) {
    const list = selectList(table);
    for (const column of REDLINE_COLUMNS) {
      assert.ok(!list.includes(column), `${table} 的抽取列不得含红线列 ${column}`);
    }
  }
  assert.throws(() => selectList("user_credentials"), /白名单/);
  assert.throws(() => selectList("asset_media"), /白名单/);
});

test("assertExtractionSafe: 命中红线列即抛", () => {
  assert.throws(
    () => assertExtractionSafe('SELECT id, password_hash FROM "common"."users"'),
    /红线列 password_hash/,
  );
  assert.throws(
    () => assertExtractionSafe('SELECT submit_response FROM "common"."seedance_asset_tasks"'),
    /红线/,
  );
});

test("assertExtractionSafe: 引用红线/暂缓表即抛", () => {
  assert.throws(() => assertExtractionSafe('SELECT id FROM "common"."generation_tasks"'), /红线/);
  assert.throws(() => assertExtractionSafe('SELECT id FROM "common"."asset_media"'), /红线/);
  assert.throws(() => assertExtractionSafe('SELECT id FROM "common"."user_sessions"'), /红线/);
});

test("assertExtractionSafe: 字符串字面量里的红线词不误报;合法白名单 SQL 放行", () => {
  // 红线扫描先剥掉字符串字面量:值里的词不应触发(护栏针对列/表引用)。
  assert.doesNotThrow(() => assertExtractionSafe("SELECT id FROM \"common\".\"users\" WHERE status <> 'deleted'"));
  for (const table of Object.keys(SOURCE_COLUMN_WHITELIST)) {
    assert.doesNotThrow(() => assertExtractionSafe(`SELECT ${selectList(table)} FROM "common"."${table}"`));
  }
});

test("红线表清单覆盖契约 §5 关键类目", () => {
  for (const table of ["user_credentials", "user_sessions", "generation_tasks", "generation_calls", "generation_outputs", "asset_media", "migrations"]) {
    assert.ok((REDLINE_TABLES as readonly string[]).includes(table), `红线表清单应含 ${table}`);
  }
});

// ---------------------------------------------------------------------------
// 端点/schema 护栏
// ---------------------------------------------------------------------------

test("parseDatabaseUrl 与 isLocalHost", () => {
  const parsed = parseDatabaseUrl("postgresql://u:p@localhost:5544/dbname");
  assert.equal(parsed.host, "localhost");
  assert.equal(parsed.port, 5544);
  assert.equal(isLocalHost("127.0.0.1"), true);
  assert.equal(isLocalHost("db"), true);
  assert.equal(isLocalHost("prod-rds.example.com"), false);
  assert.throws(() => parseDatabaseUrl("不是连接串"), /无法解析/);
});

test("assertSafeEndpoints: 未授权一律拒远程;授权后目标仍只许本机", () => {
  const local = { sourceUrl: "postgresql://u:p@localhost:5432/a", targetUrl: "postgresql://u:p@127.0.0.1:5432/b" };
  assert.doesNotThrow(() => assertSafeEndpoints({ ...local, allowRemote: false }));
  assert.throws(
    () => assertSafeEndpoints({ sourceUrl: "postgresql://u:p@rds.example.com:5432/a", targetUrl: local.targetUrl, allowRemote: false }),
    /绝不连云库/,
  );
  assert.doesNotThrow(() => assertSafeEndpoints({ sourceUrl: "postgresql://u:p@rds.example.com:5432/a", targetUrl: local.targetUrl, allowRemote: true }));
  assert.throws(
    () => assertSafeEndpoints({ sourceUrl: "postgresql://u:p@rds.example.com:5432/a", targetUrl: "postgresql://u:p@rds.example.com:5432/b", allowRemote: true }),
    /--allow-remote-target/,
  );
});

test("assertSafeEndpoints / assertSafeWriteTarget: 远程目标双开关齐备才放行", () => {
  const remote = { sourceUrl: "postgresql://u:p@rds.example.com:5432/a", targetUrl: "postgresql://u:p@rds.example.com:5432/b" };
  // 仅 --allow-remote 不够;补 --allow-remote-target 才放行(R30 dev/test 导入通道)
  assert.throws(() => assertSafeEndpoints({ ...remote, allowRemote: true }), /--allow-remote-target/);
  assert.doesNotThrow(() => assertSafeEndpoints({ ...remote, allowRemote: true, allowRemoteTarget: true }));
  // 回滚路径同口径:本机目标总是放行;远程目标缺一开关即拒
  assert.doesNotThrow(() => assertSafeWriteTarget({ targetUrl: "postgresql://u:p@127.0.0.1:5432/b", allowRemote: false }));
  assert.throws(() => assertSafeWriteTarget({ targetUrl: remote.targetUrl, allowRemote: true }), /双开关/);
  assert.throws(() => assertSafeWriteTarget({ targetUrl: remote.targetUrl, allowRemote: false, allowRemoteTarget: true }), /双开关/);
  assert.doesNotThrow(() => assertSafeWriteTarget({ targetUrl: remote.targetUrl, allowRemote: true, allowRemoteTarget: true }));
});

test("assertSafeSchemaName / quoteIdent", () => {
  assert.equal(quoteIdent("common"), '"common"');
  assert.throws(() => assertSafeSchemaName('evil";drop'), /不合法/);
  assert.throws(() => assertSafeSchemaName("1abc"), /不合法/);
});

// ---------------------------------------------------------------------------
// 三桶校验与守恒
// ---------------------------------------------------------------------------

function verifyInput(overrides: Partial<Parameters<typeof classifyClosure>[0]> = {}) {
  return {
    sourceCounts: { projects: 1, project_access_grants: 2 },
    decisions: { new: 2, matched: 0, conflict: 0, quarantined: 0 },
    skippedByRule: 1,
    degradationCount: 0,
    hardFailures: [] as string[],
    ...overrides,
  };
}

test("classifyClosure: 三桶分派", () => {
  assert.equal(classifyClosure(verifyInput()), "identical");
  assert.equal(classifyClosure(verifyInput({ degradationCount: 1 })), "needs_human");
  assert.equal(classifyClosure(verifyInput({ decisions: { new: 1, matched: 0, conflict: 1, quarantined: 0 } })), "needs_human");
  assert.equal(classifyClosure(verifyInput({ hardFailures: ["守恒失败"] })), "failed");
});

test("conservationFailures: 源行数 = 四态 + 规则性跳过", () => {
  assert.deepEqual(conservationFailures(verifyInput()), []); // 3 = 2 new + 1 skip
  const broken = conservationFailures(verifyInput({ skippedByRule: 0 }));
  assert.equal(broken.length, 1);
  assert.match(broken[0]!, /守恒失败/);
});

test("buildGlobalVerificationQueries: 覆盖契约 §4 关键核对且带 runId", () => {
  const queries = buildGlobalVerificationQueries("run-123");
  const names = queries.map((query) => query.name).join(" ");
  for (const expected of ["哨兵", "孤儿", "owner", "价格复核", "账目隔离", "账本分离"]) {
    assert.ok(names.includes(expected), `全局核对缺 ${expected}`);
  }
  for (const query of queries) {
    assert.ok(query.sql.includes("run-123") || !query.sql.includes("import_run_id"), `${query.name} 应带 runId`);
    assert.ok(query.sql.includes("{{schema}}"), `${query.name} 应留 schema 占位符由调用方渲染`);
  }
});
