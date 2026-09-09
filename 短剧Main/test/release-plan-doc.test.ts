import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  expectedCardRelease,
  parseReleasePlanDoc,
  RELEASE_PLAN_DOC_PATH,
} from "../src/modules/config-entries/release-plan-doc.js";
import { releaseCardPayloadSchema } from "../src/modules/config-entries/types.js";

/**
 * S31 真源合一机制的静态半部分(不连库,永远运行):
 * ① 真实 version-plan.md 通过解析器结构校验——锚点齐全、key 唯一、状态词
 *    认得出(文档侧的「归属检查」:加卡忘加锚点在这里当场报红,不再靠人眼);
 * ② 解析器规则的单测(合成样例):划掉的行不算卡、非首表不解析、第 3 列
 *    按表头映射、「—」占位不落内容;
 * ③ 验收标准锚点块(S37):<!-- acceptance:key --> 独占一行起块、多行文本、
 *    靠 card_key 挂卡;孤儿锚点/空锚点/重复锚点/写进表格行/不独占行/超长
 *    都进 issues;
 * ④ release_section 卡片新字段 card_key/acceptance 的 zod 合同:可空、
 *    向后兼容、格式受控;
 * ⑤ 迁移 027 的静态形状:带守卫的 card_key 回填。
 */

const docSource = await readFile(path.resolve(RELEASE_PLAN_DOC_PATH), "utf8");
const doc = parseReleasePlanDoc(docSource);

test("真实文档:解析零 issue,每段至少一张卡,卡片 key 全局唯一", () => {
  assert.deepEqual(doc.issues, [], "version-plan.md 锚点结构必须健康");
  assert.ok(doc.sections.length >= 5, "版本计划至少应有五个档期段");
  const keys = new Set<string>();
  for (const section of doc.sections) {
    assert.ok(section.cards.length > 0, `段 ${section.entryKey} 没有卡片`);
    for (const card of section.cards) {
      assert.ok(!keys.has(card.cardKey), `card_key ${card.cardKey} 全局重复`);
      keys.add(card.cardKey);
    }
  }
});

test("真实文档:段状态与版本语规则(live/filming/scheduled/vision,远景未定档)", () => {
  for (const section of doc.sections) {
    assert.match(section.entryKey, /^[a-z0-9][a-z0-9.+_-]*$/, `段键非法 ${section.entryKey}`);
    if (section.status === "vision") {
      assert.equal(expectedCardRelease(section), "未定档");
    } else {
      assert.equal(expectedCardRelease(section), section.entryKey);
    }
  }
});

test("解析器:没锚点的段不解析,其表行不产生卡片", () => {
  const source = [
    "## v9.9 —— 进行中",
    "",
    "| 卡片 | 内容 |",
    "| --- | --- |",
    "| 孤儿卡 | 没有段锚点,谁也不管它 |",
  ].join("\n");
  const parsed = parseReleasePlanDoc(source);
  assert.deepEqual(parsed.sections, []);
  assert.deepEqual(parsed.issues, []);
});

test("解析器:计划表里有卡忘加锚点 → 点名那行报错(7-26 分叉的文档侧护栏)", () => {
  const source = [
    "## v9.9 —— 进行中 <!-- section:v9.9 -->",
    "",
    "| 卡片 | 内容 | 起因 |",
    "| --- | --- | --- |",
    "| 有锚点 | 内容 | 起因 <!-- card:anchored --> |",
    "| 忘加锚点的卡 | 内容 | 起因 |",
  ].join("\n");
  const parsed = parseReleasePlanDoc(source);
  assert.equal(parsed.sections[0]?.cards.length, 1);
  assert.equal(parsed.issues.length, 1);
  assert.match(parsed.issues[0]!, /忘加锚点的卡/);
  assert.match(parsed.issues[0]!, /v9\.9/);
});

test("解析器:划掉的行不是计划卡;划掉的行带锚点要报错", () => {
  const source = [
    "## v9.9 —— 已发布 <!-- section:v9.9 -->",
    "",
    "| 卡片 | 实际交付 | 依据 |",
    "| --- | --- | --- |",
    "| 正经卡 | 交付物 | 迁移 099 <!-- card:normal --> |",
    "| ~~误列卡~~ | 已移出 | 核实 |",
    "| ~~带锚点的误列卡~~ | 矛盾 | 核实 <!-- card:struck --> |",
  ].join("\n");
  const parsed = parseReleasePlanDoc(source);
  assert.deepEqual(parsed.sections[0]?.cards.map((card) => card.cardKey), ["normal"]);
  assert.equal(parsed.issues.length, 1);
  assert.match(parsed.issues[0]!, /划掉/);
});

test("解析器:同一 card_key 跨段重复 → 报错(对齐歧义)", () => {
  const source = [
    "## v9.9 —— 进行中 <!-- section:v9.9 -->",
    "",
    "| 卡片 | 内容 |",
    "| --- | --- |",
    "| 甲卡 | 内容 <!-- card:same-key --> |",
    "",
    "## v9.10 —— 下一档 <!-- section:v9.10 -->",
    "",
    "| 卡片 | 内容 |",
    "| --- | --- |",
    "| 乙卡 | 内容 <!-- card:same-key --> |",
  ].join("\n");
  const parsed = parseReleasePlanDoc(source);
  assert.equal(parsed.issues.length, 1);
  assert.match(parsed.issues[0]!, /same-key/);
  assert.match(parsed.issues[0]!, /v9\.9/);
});

test("解析器:认不出状态词的段整段忽略并报错;第 3 列只认 起因/依据/备注", () => {
  const source = [
    "## v9.9 —— 随便写的 <!-- section:v9.9 -->",
    "",
    "| 卡片 | 内容 |",
    "| --- | --- |",
    "| 甲卡 | 内容 <!-- card:a --> |",
    "",
    "## v9.10 —— 下一档 <!-- section:v9.10 -->",
    "",
    "| 卡片 | 内容 | 备注列 |",
    "| --- | --- | --- |",
    "| 乙卡 | 内容 | 不认识 <!-- card:b --> |",
  ].join("\n");
  const parsed = parseReleasePlanDoc(source);
  assert.deepEqual(parsed.sections.map((section) => section.entryKey), ["v9.10"]);
  assert.equal(parsed.issues.length, 2);
  assert.match(parsed.issues[0]!, /状态词/);
  assert.match(parsed.issues[1]!, /备注列/);
  assert.equal(parsed.sections[0]?.cards[0]?.reason, undefined);
  assert.equal(parsed.sections[0]?.cards[0]?.basis, undefined);
});

test("解析器:第 3 列按表头映射,「—」占位不落内容", () => {
  const source = [
    "## v9.9 —— 进行中 <!-- section:v9.9 -->",
    "",
    "| 卡片 | 内容 | 起因 |",
    "| --- | --- | --- |",
    "| 甲卡 | 内容 | 真起因 <!-- card:a --> |",
    "| 乙卡 | 内容 | — <!-- card:b --> |",
    "",
    "## v9.10 —— 下一档 <!-- section:v9.10 -->",
    "",
    "| 卡片 | 内容 | 依据 |",
    "| --- | --- | --- |",
    "| 丙卡 | 内容 | 迁移 099 <!-- card:c --> |",
  ].join("\n");
  const parsed = parseReleasePlanDoc(source);
  assert.deepEqual(parsed.issues, []);
  const [v99, v910] = parsed.sections;
  assert.equal(v99?.cards[0]?.reason, "真起因");
  assert.equal(v99?.cards[0]?.basis, undefined);
  assert.equal(v99?.cards[1]?.reason, undefined, "「—」占位必须当成没写");
  assert.equal(v910?.cards[0]?.basis, "迁移 099");
  assert.equal(v910?.cards[0]?.reason, undefined);
});

test("解析器:每段只读第一张表——「没做的三张卡」之类的后续表不解析", () => {
  const source = [
    "## v9.9 —— 已发布 <!-- section:v9.9 -->",
    "",
    "| 卡片 | 实际交付 | 依据 |",
    "| --- | --- | --- |",
    "| 正经卡 | 交付物 | 迁移 099 <!-- card:normal --> |",
    "",
    "### 原计划里没做的三张卡",
    "",
    "| 卡片 | 原计划内容 | 现状 | 待定 |",
    "| --- | --- | --- | --- |",
    "| 没做的卡 | 不该被解析 | 未做 | 待定 |",
  ].join("\n");
  const parsed = parseReleasePlanDoc(source);
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.sections[0]?.cards.map((card) => card.cardKey), ["normal"]);
});

test("验收块(S37):锚点独占一行起块,多行文本按 card_key 挂卡;没块的卡为空", () => {
  const source = [
    "## v9.9 —— 进行中 <!-- section:v9.9 -->",
    "",
    "| 卡片 | 内容 |",
    "| --- | --- |",
    "| 甲卡 | 内容 <!-- card:a --> |",
    "| 乙卡 | 内容 <!-- card:b --> |",
    "",
    "<!-- acceptance:a -->",
    "交付物:示例假卡的交付物",
    "门禁:npm test 绿",
    "实打:在 dev 环境跑过命令 X",
    "",
    "<!-- acceptance:b -->",
    "交付物:乙卡的验收(与上一块之间没有空行也各归各)",
  ].join("\n");
  const parsed = parseReleasePlanDoc(source);
  assert.deepEqual(parsed.issues, []);
  const [a, b] = parsed.sections[0]!.cards;
  assert.equal(a!.acceptance, "交付物:示例假卡的交付物\n门禁:npm test 绿\n实打:在 dev 环境跑过命令 X", "多行文本原样保留换行");
  assert.equal(b!.acceptance, "交付物:乙卡的验收(与上一块之间没有空行也各归各)");
});

test("验收块:遇到表格行/小节标题收尾,不吞后续内容;后续表依旧不解析", () => {
  const source = [
    "## v9.9 —— 已发布 <!-- section:v9.9 -->",
    "",
    "| 卡片 | 实际交付 |",
    "| --- | --- |",
    "| 正经卡 | 交付物 <!-- card:normal --> |",
    "",
    "<!-- acceptance:normal -->",
    "交付物:示例假卡判据",
    "### 验收之后的备注小节",
    "",
    "| 别的表 | 不该解析 |",
    "| --- | --- |",
    "| 行 | 行 |",
  ].join("\n");
  const parsed = parseReleasePlanDoc(source);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.sections[0]!.cards.length, 1);
  assert.equal(parsed.sections[0]!.cards[0]!.acceptance, "交付物:示例假卡判据", "小节标题结束验收块,不进内容");
});

test("验收块:孤儿锚点(段里没有这张卡)→ 点名段与 key 报错", () => {
  const source = [
    "## v9.9 —— 进行中 <!-- section:v9.9 -->",
    "",
    "| 卡片 | 内容 |",
    "| --- | --- |",
    "| 甲卡 | 内容 <!-- card:a --> |",
    "",
    "<!-- acceptance:ghost-card -->",
    "交付物:卡都没了验收还在",
  ].join("\n");
  const parsed = parseReleasePlanDoc(source);
  assert.equal(parsed.issues.length, 1);
  assert.match(parsed.issues[0]!, /ghost-card/);
  assert.match(parsed.issues[0]!, /v9\.9/);
  assert.equal(parsed.sections[0]!.cards[0]!.acceptance, undefined, "孤儿验收不许挂到别的卡上");
});

test("验收块:空锚点、同卡重复锚点、写进表格行、不独占一行 → 各报各的错", () => {
  const source = [
    "## v9.9 —— 进行中 <!-- section:v9.9 -->",
    "",
    "| 卡片 | 内容 |",
    "| --- | --- |",
    "| 甲卡 | 内容 <!-- card:a --> |",
    "| 乙卡 | 内容 <!-- card:b --> <!-- acceptance:b --> |",
    "",
    "<!-- acceptance:a -->",
    "",
    "<!-- acceptance:a -->",
    "交付物:第一个块(有效)",
    "",
    "<!-- acceptance:a -->",
    "交付物:第二个块(重复)",
    "",
    "<!-- acceptance:c --> 行尾带字不算独占一行",
  ].join("\n");
  const parsed = parseReleasePlanDoc(source);
  assert.equal(parsed.issues.length, 4);
  assert.match(parsed.issues[0]!, /表格行/, "锚点写进表格行要报");
  assert.match(parsed.issues[1]!, /没有内容/, "空锚点要报");
  assert.match(parsed.issues[2]!, /独占一行/, "不独占一行要报");
  assert.match(parsed.issues[3]!, /重复/, "同卡重复锚点要报");
  assert.equal(parsed.sections[0]!.cards[0]!.acceptance, "交付物:第一个块(有效)", "重复时第一个块有效,空块不算数");
});

test("验收块:超 2000 字进 issues(与 zod 上限对齐)", () => {
  const source = [
    "## v9.9 —— 进行中 <!-- section:v9.9 -->",
    "",
    "| 卡片 | 内容 |",
    "| --- | --- |",
    "| 甲卡 | 内容 <!-- card:a --> |",
    "",
    "<!-- acceptance:a -->",
    "长".repeat(2001),
  ].join("\n");
  const parsed = parseReleasePlanDoc(source);
  assert.equal(parsed.issues.length, 1);
  assert.match(parsed.issues[0]!, /2000/);
  assert.equal(parsed.sections[0]!.cards[0]!.acceptance, undefined);
});

test("解析器:卡片文本去掉 ** 标记(标题/内容/起因都不带格式符号)", () => {
  const source = [
    "## v9.9 —— 进行中 <!-- section:v9.9 -->",
    "",
    "| 卡片 | 内容 | 起因 |",
    "| --- | --- | --- |",
    "| **加粗的卡(范围)** | 内容里**强调**过 | 起因 **加粗** <!-- card:bold --> |",
  ].join("\n");
  const parsed = parseReleasePlanDoc(source);
  assert.deepEqual(parsed.issues, []);
  const card = parsed.sections[0]?.cards[0];
  assert.equal(card?.title, "加粗的卡(范围)");
  assert.equal(card?.body, "内容里强调过");
  assert.equal(card?.reason, "起因 加粗");
});

test("zod 合同:卡片新字段可空向后兼容,格式受控,strict 仍拦未知字段", () => {
  const base = {
    id: "core-domain",
    title: "核心域打底",
    tagline: "项目、分镜、资产,一次搭好。",
    status: "live",
    category: "feature",
    release: "v0.1.x",
  };
  assert.ok(releaseCardPayloadSchema.safeParse(base).success, "没有新字段的旧卡片必须仍能过校验");
  assert.ok(
    releaseCardPayloadSchema.safeParse({ ...base, card_key: "core-domain", acceptance: "迁移重放后卡数对得上" }).success,
    "带 card_key/acceptance 的卡片必须能过校验",
  );
  for (const bad of ["Not A Slug", "-head", "tail-", "has space", ""]) {
    assert.equal(
      releaseCardPayloadSchema.safeParse({ ...base, card_key: bad }).success,
      false,
      `非法 card_key ${JSON.stringify(bad)} 必须被拒`,
    );
  }
  assert.equal(
    releaseCardPayloadSchema.safeParse({ ...base, acceptance: "" }).success,
    false,
    "acceptance 要么不写,要么非空——不许空串占位",
  );
  assert.equal(
    releaseCardPayloadSchema.safeParse({ ...base, acceptance: "好".repeat(2001) }).success,
    false,
    "acceptance 超 2000 字必须被拒",
  );
  assert.equal(
    releaseCardPayloadSchema.safeParse({ ...base, unknown_field: 1 }).success,
    false,
    "strict 必须继续拦未知字段",
  );
});

test("迁移 027 静态形状:带守卫的 card_key 回填,不动 acceptance", async () => {
  const source = await readFile(path.resolve("migrations/027_release_card_keys.sql"), "utf8");
  assert.match(source, /UPDATE \{\{schema\}\}\.config_entries/, "必须是 UPDATE 回填而不是重建行");
  assert.match(source, /WHERE entry\.kind = 'release_section'/, "只碰 release_section");
  assert.match(source, /jsonb_build_object\('card_key', card\.value ->> 'id'\)/, "缺省 card_key 回填为卡片 id");
  assert.match(source, /WHEN card\.value \? 'card_key' THEN card\.value/, "已有 card_key 的卡片保留不覆盖");
  assert.match(source, /NOT \(missing\.value \? 'card_key'\)/, "WHERE 守卫:重放命中 0 行才幂等");
  assert.equal(source.includes("acceptance ="), false, "acceptance 留空,本迁移不填");
});
