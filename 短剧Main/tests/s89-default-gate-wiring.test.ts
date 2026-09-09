import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fastLaneTestFiles } from "./support/fast-lane.js";

const repoRoot = path.resolve(".");

test("S89 守卫:跨租户真 PG runner 必须留在默认 npm test 链", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};

  assert.equal(
    scripts["test:review-cross-tenant-authz-db"],
    "bash scripts/run-review-cross-tenant-authz-db-test.sh",
  );
  assert.match(
    scripts.test ?? "",
    /(?:^|&&\s*)npm run test:review-cross-tenant-authz-db(?:\s*&&|$)/,
    "从默认 test 链摘掉跨租户 runner 时本守卫必须报红",
  );
  assert.match(
    scripts["test:node"] ?? "",
    /^node scripts\/run-node-tests\.mjs --list-files \| xargs /,
    "test:node 必须经便携清单脚本(#288)排除真 PG 用例,避免 skip 冒充默认门禁证人",
  );
  // 2026-08-12 起排除按文件名后缀判,不再逐个列举。字面量匹配只证明规则在,
  // 这里再复算一次 `|` 左侧清单命令的实际结果,证明这个证人确实被排掉了。
  assert.ok(
    !fastLaneTestFiles().includes("tests/review-cross-tenant-authz-db.test.ts"),
    "跨租户真 PG 用例仍出现在 test:node 的文件清单里",
  );
});

test("S89 守卫:runner 必须是随机端口、退出即焚的一次性本地容器并执行目标证人", () => {
  const source = readFileSync(
    path.join(repoRoot, "scripts/run-review-cross-tenant-authz-db-test.sh"),
    "utf8",
  );

  assert.match(source, /container="review-cross-tenant-authz-\$\$"/);
  assert.match(source, /trap cleanup EXIT/);
  assert.match(source, /docker run -d --rm --name "\$container"/);
  assert.match(source, /-p 127\.0\.0\.1::5432/);
  assert.match(source, /POSTGRES_SCHEMA="\$schema"[\s\\]+DATABASE_URL="\$database_url"/);
  assert.match(source, /node --import tsx src\/db\/migrate\.ts/);
  assert.match(source, /REVIEW_AUTHZ_TEST_DATABASE_URL="\$database_url"/);
  assert.match(
    source,
    /node --import tsx --test tests\/review-cross-tenant-authz-db\.test\.ts/,
  );
  assert.doesNotMatch(source, /\.env|localhost:5432|shortdrama-dev-db-1/);
});
