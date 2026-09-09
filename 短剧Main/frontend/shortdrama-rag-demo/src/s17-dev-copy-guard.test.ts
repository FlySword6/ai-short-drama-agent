/* ============================================================
   s17-dev-copy-guard.test.ts — S17 用户可见文案禁含开发词（回归守卫）

   病根（first-principles-review 四）：工程视角泄漏到用户空间——「缺口已报
   Sol」「接口接入后开放」这类 fail-closed 工程台账只能留在 repo，用户空间
   只允许两种状态：能用，或者用户语言的「即将上线/联系管理员」。

   机制：剥掉注释后全量扫描 src（pages/components/app + 字符串模块），
   开发词表命中即失败；白名单机制=逐条带理由登记（当前为空——应永远为空）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** 开发词表（用户可见文案禁含）。 */
const BANNED_TOKENS = [
  "报 Sol",
  "Sol 侧",
  "等 Sol",
  "缺口",
  "mock",
  "Mock",
  "基线",
  "端点",
  "接口未",
  "后端未",
  "接口接入",
  "未对接",
  "暂未接通",
  /* S46 B-3(walkthrough P1-3):开发状态自述不入 UI */
  "暂存本机",
  "后端字段接入",
  "数据回传",
  "待管理员核实",
  "供应商标识待核实",
  "自动同步到服务端",
  /* V-26(DC 07-22):「『直接文生视频』把『直接』两个字去掉,整体用词要专业和
     行业惯用语」——行业惯用语是「文生视频」,带「直接」的五字组合全站禁出。 */
  "直接文生视频",
] as const;

/** 白名单（file 相对路径 + token + 理由）——应永远为空；非加不可时在回执里说明。 */
const WHITELIST: ReadonlyArray<{ file: string; token: string; reason: string }> = [];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      /* director/ 是嵌入导演台（独立模块自带测试），页面文案守卫只管主前端 */
      if (!["node_modules", "director"].includes(entry)) yield* walk(path);
    } else if (/\.(tsx|ts)$/.test(entry) && !entry.endsWith(".test.ts")) {
      yield path;
    }
  }
}

/** 剥注释（块注释+行注释），只留可执行代码与字符串。 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("用户可见文案禁含开发词（全量扫描）", () => {
  it("剥注释后零命中；命中必带白名单理由", () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.replace(SRC, "src/");
      const stripped = stripComments(readFileSync(file, "utf8"));
      for (const token of BANNED_TOKENS) {
        let index = stripped.indexOf(token);
        while (index !== -1) {
          const line = stripped.slice(0, index).split("\n").length;
          const whitelisted = WHITELIST.some((item) => item.file === rel && item.token === token);
          if (!whitelisted) violations.push(`${rel}:${line} [${token}] ${stripped.split("\n")[line - 1]!.trim().slice(0, 80)}`);
          index = stripped.indexOf(token, index + token.length);
        }
      }
    }
    assert.deepEqual(violations, [], `用户可见文案命中开发词：\n${violations.join("\n")}`);
  });

  it("白名单为空（任何新增都要在回执里带理由）", () => {
    assert.deepEqual(WHITELIST, []);
  });
});

/* ---------- S17-A 断头路处置锁定 ---------- */

describe("S17-A 处置断言", () => {
  const apiSource = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  const projectSettings = readFileSync(new URL("./components/project-settings.tsx", import.meta.url), "utf8");
  const globalPages = readFileSync(new URL("./pages/global-pages.tsx", import.meta.url), "utf8");
  const projectPages = readFileSync(new URL("./pages/project-pages.tsx", import.meta.url), "utf8");
  const uploadModal = readFileSync(new URL("./components/asset-upload-modal.tsx", import.meta.url), "utf8");
  const userSearchInput = readFileSync(new URL("./components/user-search-input.tsx", import.meta.url), "utf8");

  it("A1：成员/审核人选人走 /users/directory 搜索（任何登录用户可用），admin 目录不再是路径", () => {
    assert.ok(apiSource.includes("searchUserDirectory"), "api 缺目录搜索");
    assert.ok(apiSource.includes("/users/directory?q="), "搜索路径不对");
    assert.ok(projectSettings.includes("UserSearchInput") && globalPages.includes("UserSearchInput"), "两处选人未接搜索组件");
    assert.ok(userSearchInput.includes("api.searchUserDirectory"), "组件未走目录搜索");
    assert.ok(!projectSettings.includes("api.adminUsers()") && !globalPages.includes("api.adminUsers()"), "admin 目录仍是选人路径");
  });

  it("A2：按描述生成提示词接真链（POST /ai/prompt-draft）；503 走能力状态统一口径（S46-A）", () => {
    assert.ok(apiSource.includes('"/ai/prompt-draft"'), "api 缺 prompt-draft");
    assert.ok(projectPages.includes("api.draftPrompt"), "页面未接真链");
    // S46-A：AI 网关类 503 统一走 capabilityErrorCopy（角色感知,不再「请联系管理员」死循环）
    assert.ok(projectPages.includes("capabilityErrorCopy"), "503 未走能力状态统一口径");
    assert.ok(!projectPages.includes("AI 助手当前未开启，请联系管理员"), "「请联系管理员」死循环话术残留");
    assert.ok(!projectPages.includes("助手能力接入后开放"), "假按钮文案残留");
  });

  it("A3：上传假「待审」档摘除（后端上传即 approved），只留一句用户语言", () => {
    assert.ok(!uploadModal.includes("待审</button>"), "假待审档按钮残留");
    assert.ok(uploadModal.includes("上传后即自动通过"), "缺用户语言说明");
    assert.ok(!projectPages.includes("审核流接入后生效"), "上传后提示死文案残留");
  });

  it("A4-A9：变体入口隐藏；删除版本/档位/资料/辅助消耗文案用户语言", () => {
    assert.ok(!projectPages.includes("新建变体暂未开放"), "变体死按钮残留");
    assert.ok(projectPages.includes("删除功能完善后开放"), "删除版本说明未改");
  });
});
