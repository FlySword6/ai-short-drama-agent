/* ============================================================
   uiux-fix1.test.ts — 会话与状态诚实修复包(UIUX 审计第一批)回归钉

   逐 F 销账口径:A 组(F01-F04 前端)/F13/F14/F15/F16/F17/F18/F19半/F20/F21/F22。
   纯函数直测;页面级改动走源码守卫(与 error-copy.test.ts 同一先例)。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyUnauthorized } from "./auth-token";
import { breakdownRunsErrorCopy, isBreakdownServerFault } from "./pages/script-breakdown-page";
import { pickResumeProject, resumeCardTitle } from "./home-next-step";
import { clearLocalDraft, readLocalDraft, scriptDraftKey, writeLocalDraft } from "./local-drafts";
import { withOwnedProject, type Capabilities } from "./operations";
import { loginEntryPathFor, prepStagePath } from "./routing";
import { sessionEndCopy } from "./components/session-relogin-modal";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/* ---------- A 组:401 不丢用户的东西 ---------- */

test("F04：401 原因分类——到期在未来=被顶下线(revoked),已过=过期,没存=过期(不武断)", () => {
  const now = Date.now();
  assert.equal(classifyUnauthorized(new Date(now + 60_000).toISOString(), now), "revoked");
  assert.equal(classifyUnauthorized(new Date(now - 60_000).toISOString(), now), "expired");
  assert.equal(classifyUnauthorized(null, now), "expired");
  assert.equal(classifyUnauthorized("不是日期", now), "expired");
});

test("F04：被顶下线话术说清原因+给改密码建议;过期话术安抚内容还在", () => {
  const revoked = sessionEndCopy("revoked");
  assert.ok(revoked.title.includes("别处登录"), "被顶不说原因");
  assert.ok(revoked.body.includes("改密码"), "被顶不给安全建议");
  assert.ok(revoked.body.includes("内容都还在"), "不安抚内容保留");
  const expired = sessionEndCopy("expired");
  assert.ok(expired.title.includes("过期"));
  assert.ok(expired.body.includes("接着干"));
});

test("F01/F02 源码级:401 处理=原地重登小窗,不清 user 不硬跳;登录页分支保留 redirect", () => {
  const app = readSource("./app.tsx");
  assert.ok(app.includes("setRelogin((current) => current ?? { reason })"), "401 未走原地重登小窗");
  assert.ok(app.includes("<SessionReloginModal"), "重登小窗未渲染");
  const handler = app.split("onUnauthorized")[1] ?? "";
  /* 清 user 只许发生在「无用户态/已在登录页」分支;小窗分支绝不清(内容随组件卸载丢光)。 */
  const guardIdx = handler.indexOf('if (!user || window.location.pathname.startsWith("/login"))');
  const kickIdx = handler.indexOf("setUser(null)");
  const modalIdx = handler.indexOf("setRelogin");
  assert.ok(guardIdx !== -1 && kickIdx !== -1 && guardIdx < kickIdx, "清 user 必须先过登录页/无用户态闸门");
  assert.ok(modalIdx > kickIdx, "小窗分支在清 user 分支之后(互斥两路)");
});

test("F03：loginEntryPathFor(V-47 换乘)——/login 带 redirect 原样换乘保留;裸 /login 与根给默认去向;普通地址带参", () => {
  assert.equal(loginEntryPathFor("/login?redirect=%2Fprojects%2Fabc"), "/landing?redirect=%2Fprojects%2Fabc", "并发 401 抹掉了回去地址");
  assert.equal(loginEntryPathFor("/login"), "/landing?redirect=/projects");
  assert.equal(loginEntryPathFor("/"), "/landing?redirect=/projects");
  assert.equal(loginEntryPathFor("/projects/abc"), "/landing?redirect=%2Fprojects%2Fabc");
});

test("F01：剧本草稿 localStorage 读写清除+按键位隔离(项目+集)", () => {
  const store = new Map<string, string>();
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  try {
    const keyA = scriptDraftKey("p1", "e1");
    const keyB = scriptDraftKey("p1", "e2");
    assert.notEqual(keyA, keyB, "集间草稿键位串了");
    writeLocalDraft(keyA, JSON.stringify({ title: "", text: "整集剧本" }));
    assert.equal(JSON.parse(readLocalDraft(keyA)!).text, "整集剧本");
    assert.equal(readLocalDraft(keyB), null, "草稿跨集泄漏");
    clearLocalDraft(keyA);
    assert.equal(readLocalDraft(keyA), null, "保存成功后草稿未清");
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  }
});

/* ---------- E/F 组:认人、权限、上下文、状态诚实 ---------- */

test("F13：继续上次工作先挑本人足迹;足迹没有才降级全局最近", () => {
  const projects = [
    { id: "other", name: "别人的项目", updated_at: "2026-08-04T10:00:00Z" },
    { id: "mine", name: "我的项目", updated_at: "2026-08-01T10:00:00Z" },
  ];
  assert.equal(pickResumeProject(projects, new Set(["mine"]))?.id, "mine", "不认本人足迹");
  assert.equal(pickResumeProject(projects, new Set())?.id, "other", "足迹为空应降级全局最近");
  assert.equal(resumeCardTitle("mine", new Set(["mine"])), "继续上次工作");
  assert.equal(resumeCardTitle("other", new Set(["mine"])), "最近更新的项目", "不冒充上次工作");
});

test("F14：withOwnedProject 本地并入创建者=负责人;已有记录不动;只作用在已拿到的权限上", () => {
  const caps: Capabilities = { platformRole: "member", allowMemberCreateProject: true, projects: [{ projectId: "p1", role: "viewer" }], permissions: [] };
  const merged = withOwnedProject(caps, "p2");
  assert.equal(merged.projects.find((p) => p.projectId === "p2")?.role, "owner");
  assert.equal(withOwnedProject(caps, "p1").projects.find((p) => p.projectId === "p1")?.role, "viewer", "服务端已有角色被本地覆盖");
  /* 原来这里还断言 withOwnedProject(null) 会凭空造一份权限——那是在「还不知道」的状态上
     编具体权限（还把 allowMemberCreateProject 编成 true）。现在它只收已拿到的能力。 */
});

test("F14 源码级：建项目成功即发权限刷新事件,壳层先本地并入再重拉", () => {
  const api = readSource("./api.ts");
  assert.ok(api.includes("CAPABILITIES_REFRESH_EVENT"), "createProject 未发权限刷新事件");
  /* 壳层的权限持有者=capabilities-state（app.tsx 只消费三态）。 */
  const capabilitiesState = readSource("./capabilities-state.ts");
  assert.ok(capabilitiesState.includes("withOwnedProject"), "壳层未本地并入负责人角色");
  assert.ok(capabilitiesState.includes("meCapabilities()"), "壳层未重拉权限真源");
  assert.ok(capabilitiesState.includes("CAPABILITIES_REFRESH_EVENT"), "壳层未监听权限刷新事件");
});

test("F15：备戏深链带项目/集/场;场缺省不带 scene 参", () => {
  assert.equal(prepStagePath("p1", "e1", "s1"), "/assets/prep?project=p1&episode=e1&scene=s1");
  assert.equal(prepStagePath("p1", "e1"), "/assets/prep?project=p1&episode=e1");
  /* 特殊字符按 URLSearchParams 编码语义做往返断言(读回也走 URLSearchParams,口径一致) */
  const deep = prepStagePath("p 1", "e/1", null);
  const params = new URLSearchParams(deep.split("?")[1]);
  assert.equal(params.get("project"), "p 1");
  assert.equal(params.get("episode"), "e/1");
  assert.equal(params.get("scene"), null);
});

test("F15 源码级：生产页两个「去备戏」出口都带上下文;备戏台顶部亮明正在为哪场备戏", () => {
  const view = readSource("./pages/production-view-page.tsx");
  assert.ok(!view.includes('go(`/assets/prep`)'), "下一步卡仍裸跳 /assets/prep");
  assert.ok(!view.includes('navigate("/assets/prep")'), "gotoPrep 仍裸跳 /assets/prep");
  const prep = readSource("./pages/prep-stage-page.tsx");
  assert.ok(prep.includes("备戏上下文"), "备戏台缺上下文横条");
  assert.ok(prep.includes('URLSearchParams(window.location.search).get("project")'), "备戏台未读 URL 深链");
});

test("F16/F17/F18 源码级：状态三层+控制包标签+留位黑话不见客", () => {
  const view = readSource("./pages/production-view-page.tsx");
  assert.ok(view.includes("剧本已导入"), "F16 有剧本无分镜层缺失");
  assert.ok(view.includes("正在确认这一集有没有剧本"), "F16 unknown 态抢答保护缺失");
  assert.ok(view.includes("控制包 ${scene.control_package_summary.filled_lane_count}"), "F17 控制包裸数字未带名");
  assert.ok(view.includes("导出本集（即将上线）"), "F18 留位黑话仍在");
  assert.ok(!view.includes("导出本集 · 留位"), "F18 旧「留位」文案残留");
});

/* ---------- G 组:剧本分镜页 ---------- */

test("F19：5xx 永久故障给「请联系管理员」且不再诱导重试;瞬断如实透传", () => {
  assert.equal(isBreakdownServerFault("服务暂时不可用"), true);
  assert.equal(breakdownRunsErrorCopy("服务暂时不可用"), "拆解服务出故障了，已记录，请联系管理员");
  assert.equal(isBreakdownServerFault("网络连接异常，请检查网络后重试"), false);
  assert.equal(breakdownRunsErrorCopy("网络连接异常，请检查网络后重试"), "网络连接异常，请检查网络后重试");
});

test("F20/F21/F22 源码级：确认代价清单三段俱全;错误与空态互斥;按钮按有无历史换文案", () => {
  const page = readSource("./pages/script-breakdown-page.tsx");
  for (const needle of ["会换下", "带不走", "会保留", "已产生的积分消耗记录"]) {
    assert.ok(page.includes(needle), `F20 确认条缺「${needle}」段`);
  }
  const errorChain = /runsState\.loading[\s\S]*?runsState\.error[\s\S]*?runs\.length === 0/;
  assert.ok(errorChain.test(page), "F21 错误与空状态未互斥");
  assert.ok(page.includes('runs.length > 0 ? "重新拆解" : "开始拆解"'), "F22 按钮未按历史换文案");
  assert.ok(page.includes("已恢复上次未保存的草稿"), "F01 草稿恢复提示缺失");
});
