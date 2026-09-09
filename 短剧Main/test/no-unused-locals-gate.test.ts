/* noUnusedLocals 门禁与它清出的死枝(后端侧)。

   门禁本身在 tsconfig,不开就等于没有——S12 的 ProjectCostAggregateBlock
   正是靠「typecheck 报不出来」在仓库里活了几十个包。本文件守门禁还开着,
   并守住一处不是纯机械删除的判断:
   - 服务注入的 db 只在构造器体内用,摘掉 private 修饰符即可,构造签名不许变。 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/** 剥注释,「符号不存在」类断言只看可执行代码。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("门禁:后端 tsconfig 开着 noUnusedLocals", () => {
  const config = JSON.parse(readSource("../tsconfig.json")) as { compilerOptions?: Record<string, unknown> };
  assert.equal(
    config.compilerOptions?.noUnusedLocals, true,
    "关掉 noUnusedLocals,只赋值不使用的死枝就重新变成 typecheck 报不出来的东西",
  );
});

test("注入的 db 不再挂成从不读的私有属性,构造签名一字不改", () => {
  for (const relative of ["../src/services/assetIngestService.ts", "../src/services/searchService.ts"]) {
    const source = stripComments(readSource(relative));
    assert.ok(
      !/constructor\(private readonly db: Database/.test(source),
      `${relative}:db 又挂回了 private 属性,但没人读 this.db`,
    );
    assert.ok(
      /constructor\(db: Database, dependencies:/.test(source),
      `${relative}:构造器第一位不再是 db——这会改服务构造签名,不在本包授权内`,
    );
    assert.ok(!source.includes("this.db"), `${relative}:出现了 this.db,那就该把属性加回来`);
  }
});

test("停用的单价写入口不再留着没人用的入参 schema,读入口照旧", () => {
  const routes = stripComments(readSource("../src/modules/dashboard/routes.ts"));
  assert.ok(!routes.includes("unitPriceSchema"), "410 停用的写入口又留下了没人调用的入参 schema");
  assert.ok(routes.includes("unit_price_write_moved"), "写入口的 410 停用响应丢了");
  assert.ok(routes.includes('app.get("/api/v1/cost-settings/unit-prices"'), "读入口被误删");
});
