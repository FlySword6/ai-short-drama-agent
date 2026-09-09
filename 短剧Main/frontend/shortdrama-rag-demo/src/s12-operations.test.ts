/* ============================================================
   s12-operations.test.ts — S12 权限与成本六件验收断言（测试+代码成对提交）

   1. capabilities 驱动入口显隐（mapper/显隐助手/壳接线）；
   2. 项目成员面板（四接口接线+owner 限定）；
   3. 新建项目表单增强（负责人默认自己/查看人员/题材/审核策略）+项目设置可改；
   4. 项目消耗页（capabilities 门控+viewer 不可见整页人话；S73 删净从不渲染的成本块死枝）；
   5. 管理后台（团队/分组 CRUD+成员维护+后台成本 CSV）；
   6. 403 人话（看得到但不能做给一句，不抛错误码）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  capabilitiesFromUnknown,
  canCreateInProject,
  canCreateProject,
  canManageProject,
  canSeeAdminConsole,
  canSeeProjectCosts,
  costPageFromUnknown,
  forbiddenMessage,
  memberFromUnknown,
  type Capabilities,
} from "./operations";
import { capabilityGate } from "./capabilities-state";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** 剥注释(块注释+行注释),「符号不存在」类断言只看可执行代码,不被考古注释误伤。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const app = readSource("./app.tsx");
const globalPages = readSource("./pages/global-pages.tsx");
const projectSettings = readSource("./components/project-settings.tsx");
const operationsPages = readSource("./pages/operations-pages.tsx");
const adminPage = readSource("./pages/admin-page.tsx");
const apiSource = readSource("./api.ts");
const capabilitiesState = readSource("./capabilities-state.ts");
const operationsSource = readSource("./operations.ts");

/* ---------- 1. capabilities mapper + 显隐助手 ---------- */

test("S12-1：capabilities 按 snake wire 归一（platform_role/allow_member_create_project/projects）", () => {
  const caps = capabilitiesFromUnknown({
    platform_role: "operator",
    allow_member_create_project: true,
    projects: [{ project_id: "p1", role: "editor" }, { project_id: "p2", role: "viewer" }, { role: "owner" }],
    permissions: ["costs:read"],
  });
  assert.equal(caps.platformRole, "operator");
  assert.equal(caps.allowMemberCreateProject, true);
  assert.deepEqual(caps.projects, [
    { projectId: "p1", role: "editor" },
    { projectId: "p2", role: "viewer" },
  ]);
});

test("S12-1：显隐矩阵——viewer 不创作不看成本，owner 管理，operator/admin 见后台，member 受开关限制", () => {
  const base: Capabilities = { platformRole: "member", allowMemberCreateProject: false, projects: [
    { projectId: "own", role: "owner" },
    { projectId: "edit", role: "editor" },
    { projectId: "view", role: "viewer" },
  ], permissions: [] };
  assert.equal(canCreateInProject(base, "own"), true);
  assert.equal(canCreateInProject(base, "edit"), true);
  assert.equal(canCreateInProject(base, "view"), false);
  assert.equal(canSeeProjectCosts(base, "view"), false);
  assert.equal(canSeeProjectCosts(base, "edit"), true);
  assert.equal(canManageProject(base, "own"), true);
  assert.equal(canManageProject(base, "edit"), false);
  assert.equal(canCreateProject(base), false);
  assert.equal(canCreateProject({ ...base, allowMemberCreateProject: true }), true);
  assert.equal(canCreateProject({ ...base, platformRole: "operator" }), true);
  assert.equal(canSeeAdminConsole(base), false);
  assert.equal(canSeeAdminConsole({ ...base, platformRole: "operator" }), true);
  assert.equal(canSeeAdminConsole({ ...base, platformRole: "admin" }), true);
  /* 「还没读到 / 读不到」不再走这两个助手（它们只收已拿到的能力）——
     那两态画什么由 capabilityGate 决定，断言在 capabilities-three-state.test.ts。 */
  assert.equal(capabilityGate({ status: "loading" }, canCreateProject), "loading");
  assert.equal(capabilityGate({ status: "unavailable", reload: () => {} }, canSeeAdminConsole), "unavailable");
});

test("S12-1 源码级：壳接线——App 拉 capabilities 进 runtime，管理后台入口与消耗页签受其驱动", () => {
  /* 取数与三态收在 capabilities-state（壳层唯一持有者）；界面「读不到 ≠ 无权」的行为断言
     在 capabilities-three-state.test.ts，这里只守「入口显隐单源」这条纪律。 */
  assert.ok(capabilitiesState.includes("api.meCapabilities()"), "壳层状态源未拉 capabilities");
  assert.ok(app.includes("useCapabilitiesState({"), "App 未用壳层三态");
  assert.ok(app.includes("capabilities,"), "runtime 未带 capabilities");
  // 2026-08-02 Fable 改锚:R2 壳后管理后台入口移居 rail,驱动判据不变(capabilities 单源)。
  {
    const rail = readFileSync(new URL("./components/app-rail.tsx", import.meta.url), "utf8");
    assert.ok(rail.includes("canSeeAdminConsole"), "rail 管理后台入口未由 capabilities 驱动");
    assert.ok(rail.includes('"/admin"'), "rail 缺 /admin 入口");
  }
  assert.ok(app.includes("canSeeProjectCosts(caps, projectId)") && app.includes("capabilityGate(capabilities"), "消耗页签未由 capabilities 驱动");
  assert.ok(app.includes("ProjectSettingsDrawer"), "项目设置抽屉未接线");
  assert.ok(apiSource.includes('"/me/capabilities"'), "api 缺 meCapabilities");
});

/* ---------- 2. 成员面板 ---------- */

test("S12-2 源码级：成员面板=四接口接线+owner 限定+按用户名解析+缺口如实", () => {
  assert.ok(apiSource.includes("/members`"), "缺成员列表接口");
  assert.ok(apiSource.includes("user_id: input.userId, role: input.role"), "加成员请求形状不对");
  assert.ok(apiSource.includes("method: \"PATCH\"") && apiSource.includes("/members/${encodeURIComponent(userId)}"), "缺改角色接口");
  assert.ok(projectSettings.includes("canManageProject(caps, projectId)"), "成员面板未限定 owner");
  assert.ok(projectSettings.includes("api.projectMembers(projectId)"), "未接成员列表");
  assert.ok(projectSettings.includes("api.addProjectMember"), "未接加成员");
  assert.ok(projectSettings.includes("api.updateProjectMember"), "未接改角色");
  assert.ok(projectSettings.includes("api.removeProjectMember"), "未接移除");
  /* S17-A1：按用户名选人改走 /users/directory 搜索（任何登录用户可用），死文案「缺口已报 Sol」清除 */
  assert.ok(projectSettings.includes("UserSearchInput"), "加成员未接目录搜索选人");
  assert.ok(!projectSettings.includes("缺口已报 Sol"), "目录死文案残留");
});

/* ---------- 3. 新建项目表单增强 ---------- */

test("S12-3 源码级：新建表单=负责人默认自己/仅查看批量（S14 改词「谁可以看这部剧」）/题材 combobox（S14-2）/审核策略默认+审核人；创建后落运营字段", () => {
  assert.ok(globalPages.includes("（你）"), "负责人未默认自己");
  assert.ok(globalPages.includes('list="genre-suggestions"'), "题材未用 combobox（S14-2 自由文本）");
  assert.ok(globalPages.includes("谁可以看这部剧"), "缺「谁可以看这部剧」批量添加（S14-3 改词）");
  assert.ok(globalPages.includes("图片默认审核") && globalPages.includes("视频默认审核"), "缺分开的审核策略默认档");
  assert.ok(globalPages.includes("指定审核人"), "缺指定审核人");
  assert.ok(globalPages.includes("api.patchProjectOperations(project.id"), "创建后未落题材/审核策略");
  assert.ok(globalPages.includes("api.addProjectMember(project.id, { userId: target.id, role: \"viewer\" })"), "仅查看成员未按 viewer 加入");
  assert.ok(globalPages.includes("capabilityGate(capabilities, canCreateProject)"), "新建入口未由 capabilities 驱动");
  // 项目设置同字段可改（合同：项目设置页同样可改这些）
  assert.ok(projectSettings.includes("题材") && projectSettings.includes("api.patchProjectOperations"), "项目设置不可改题材/运营字段");
});

test("S24-B：题材枚举废弃——前端无 PROJECT_GENRES/localStorage 残留，建议词接 genre_suggestions 词表接口", () => {
  assert.ok(!operationsSource.includes("PROJECT_GENRES"), "operations.ts 残留 PROJECT_GENRES 写死枚举");
  assert.ok(!operationsSource.includes("CUSTOM_GENRES_KEY ="), "operations.ts 残留 localStorage 自定义体裁");
  assert.ok(!operationsSource.includes("rememberCustomGenre") && !operationsSource.includes("loadCustomGenres"), "operations.ts 残留体裁记忆函数");
  assert.ok(apiSource.includes("vocabularyGenres"), "api 缺 vocabularyGenres");
  assert.ok(apiSource.includes("addVocabularyGenre"), "api 缺 addVocabularyGenre");
  assert.ok(apiSource.includes("/vocabulary/genres"), "api 未接体裁词表路由");
  assert.ok(globalPages.includes("api.vocabularyGenres()"), "新建表单建议词未接词表接口");
  assert.ok(globalPages.includes("api.addVocabularyGenre(genre.trim())"), "新建后未把新体裁写回词表");
  assert.ok(projectSettings.includes("api.vocabularyGenres()"), "项目设置建议词未接词表接口");
  assert.ok(projectSettings.includes("api.addVocabularyGenre(genre.trim())"), "项目设置保存未把新体裁写回词表");
});

/* ---------- 4. 成本块+成员排行 ---------- */

test("S12-4：costPage 归一（charged_points/unpriced_count 如实保留）", () => {
  const page = costPageFromUnknown({
    group_by: "member",
    rows: [{ key: "u1", label: "Alice", charged_points: 60, unpriced_count: 2, entry_count: 3 }],
    totals: { charged_points: 60, unpriced_count: 2, entry_count: 3 },
    total: 1, page: 1, page_size: 20,
  });
  assert.equal(page.rows[0]!.chargedPoints, 60);
  assert.equal(page.rows[0]!.unpricedCount, 2);
  assert.equal(page.totals.unpricedCount, 2);
});

test("S12-4 源码级：项目消耗页按 capabilities 门控+viewer 整页人话（S73 死枝清理后口径）", () => {
  /* S73:ProjectCostAggregateBlock 自 S12 起从不渲染,已删净——「成本块走 costs 接口/
     未计价标出」的旧断言守的是死代码,随组件一并删除;未计价标出在管理后台成本页保留。 */
  assert.ok(!operationsPages.includes("SUM("), "前端自己算成本（违同源硬规矩）");
  assert.ok(operationsPages.includes("canSeeProjectCosts(capabilities.capabilities, projectId)"), "消耗页未按 capabilities 门控");
  assert.ok(operationsPages.includes('forbiddenMessage("cost")'), "viewer 缺人话");
  assert.ok(!stripComments(operationsPages).includes("ProjectCostAggregateBlock"), "死枝组件复活了");
  assert.ok(!stripComments(apiSource).includes("projectCostAggregate"), "死枝专用 api 方法复活了");
});

/* ---------- 5. 管理后台 ---------- */

test("S12-5 源码级：后台三表+CSV 同源导出+operator 写拒绝人话", () => {
  assert.ok(adminPage.includes("api.adminCostAggregate(groupBy)"), "后台成本未走接口");
  assert.ok(adminPage.includes("api.adminCostsCsvBlob(groupBy)"), "缺 CSV 导出");
  assert.ok(apiSource.includes("format=csv"), "CSV 非同源接口");
  assert.ok(adminPage.includes("api.adminTeams") && adminPage.includes("api.createTeam") && adminPage.includes("api.deleteTeam"), "团队 CRUD 未接全");
  assert.ok(adminPage.includes("api.addTeamMember") && adminPage.includes("api.removeTeamMember"), "团队成员维护未接");
  assert.ok(adminPage.includes("api.adminUserGroups") && adminPage.includes("api.addUserGroupMember"), "用户分组 CRUD/成员未接全");
  assert.ok(adminPage.includes("canSeeAdminConsole(capabilities.capabilities)"), "后台页未按 capabilities 门控");
  assert.ok(adminPage.includes("运营角色只读可导出"), "operator 写拒绝缺人话");
});

/* ---------- 6. 403 人话 ---------- */

test("S12-6：forbiddenMessage 按场景给人话，不抛错误码", () => {
  assert.match(forbiddenMessage("create"), /仅可查看/);
  assert.match(forbiddenMessage("create"), /负责人授权/);
  assert.match(forbiddenMessage("member"), /项目负责人/);
  assert.match(forbiddenMessage("cost"), /仅可查看/);
  assert.ok(!/403|Forbidden|forbidden/i.test(forbiddenMessage("generic")), "人话里出现错误码");
});

/* ---------- 成员 mapper ---------- */

test("S12-2：member 归一（project_role/platform_role/display_name）", () => {
  const member = memberFromUnknown({
    project_id: "p1", user_id: "u1", username: "alice", display_name: "Alice",
    platform_role: "admin", project_role: "owner", added_by_user_id: null, created_at: "2026-07-01T00:00:00Z",
  });
  assert.equal(member.projectRole, "owner");
  assert.equal(member.platformRole, "admin");
  assert.equal(member.displayName, "Alice");
  // 旧形状（role 键）兼容
  assert.equal(memberFromUnknown({ user_id: "u2", role: "editor" }).projectRole, "editor");
});
