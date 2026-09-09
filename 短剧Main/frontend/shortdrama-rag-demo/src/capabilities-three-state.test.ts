/* ============================================================
   capabilities-three-state.test.ts — 权限读取三态（读取中/读不到/已拿到）

   守的是一句话：**接口读不到权限，不许说成「你没有权限」**。
   原病：能力接口抖一下，capsLive 落回 null，下游一律当无权——项目负责人
   看到「等审核 · 项目审核人能过这张」，建项目按钮、消耗页签、后台入口一起消失。

   本文件按四条判据钉死：
   ① 读取失败 → 界面说「权限信息没读到」并给重试，不出「等审核」话术；
   ② 读取中 → 不渲染任何「你没权限」的说法（也不抢先出可点的动作钮）；
   ③ 重试入口点下去真的重发能力请求（断言请求次数）；
   ④ 已拿到 → 判定语义与后端一字不差（allow/deny 原样）。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
/* 「占位真的占住了吗」的判据只有一份，判据自己的守卫在 testing/holds-space.test.ts。 */
import { holdsSpace } from "./testing/holds-space";

/* happy-dom 先落地全局，再动态 import react/被测模块（同 lite-shots-reference 基建纪律）。 */
const happyWindow = new Window({ url: "http://localhost/" });
for (const key of Object.getOwnPropertyNames(happyWindow)) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] = (happyWindow as unknown as Record<string, unknown>)[key];
  }
}
(globalThis as Record<string, unknown>).window = happyWindow;
(globalThis as Record<string, unknown>).document = happyWindow.document;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
for (const eventCtor of ["Event", "CustomEvent", "PointerEvent", "MouseEvent", "KeyboardEvent", "FocusEvent"]) {
  const ctor = (happyWindow as unknown as Record<string, unknown>)[eventCtor];
  if (ctor) (globalThis as Record<string, unknown>)[eventCtor] = ctor;
}

const { act, createElement } = await import("react");
(globalThis as Record<string, unknown>).React = await import("react");
const { createRoot } = await import("react-dom/client");
const { capabilityGate, platformRoleForCopy, useCapabilitiesState } = await import("./capabilities-state");
const { capabilityErrorCopy } = await import("./capability-status");
type CapabilitiesState = import("./capabilities-state").CapabilitiesState;
type Capabilities = import("./operations").Capabilities;

const OWNER_CAPS: Capabilities = {
  platformRole: "member",
  allowMemberCreateProject: true,
  projects: [{ projectId: "p1", role: "owner" }],
  permissions: [],
};

/* ---------- ① 四值闸门：界面必须画的四种东西，一一对应 ---------- */

test("capabilityGate：读取中/读不到/可裁决/无权四值分明，失败不塌缩成无权", () => {
  const allowOwner = (caps: Capabilities): boolean => caps.projects.some((p) => p.role === "owner");
  assert.equal(capabilityGate({ status: "loading" }, allowOwner), "loading");
  assert.equal(capabilityGate({ status: "unavailable", reload: () => {} }, allowOwner), "unavailable");
  assert.equal(capabilityGate({ status: "ready", capabilities: OWNER_CAPS }, allowOwner), "allowed");
  assert.equal(
    capabilityGate({ status: "ready", capabilities: { ...OWNER_CAPS, projects: [] } }, allowOwner),
    "denied",
  );
});

/* ---------- ①-b 文案角色：没读到就说没读到，不许滑进「你不是管理员」 ----------
   platformRoleForCopy 是按角色分叉文案的唯一入口。它把「还没读到 / 读不到」映射成
   unknown，下游遇到 unknown 就把两条路都摆出来。映射错分支不会报错，只会换一句话说，
   而那句话恰好是本单要消灭的原病：网关 503 时管理员被告知「找管理员开启后再试」。
   类型收窄防得住「删掉 unknown 分支」，防不住「映射到别的分支」——所以这里按值钉。 */

test("platformRoleForCopy：只有已拿到才报角色，读取中与读不到一律 unknown", () => {
  assert.equal(platformRoleForCopy({ status: "loading" }), "unknown", "还在读就报 member，等于替接口把人判成普通成员");
  assert.equal(platformRoleForCopy({ status: "unavailable", reload: () => {} }), "unknown", "读不到不是一种角色");
  assert.equal(platformRoleForCopy({ status: "ready", capabilities: OWNER_CAPS }), "member", "已拿到就原样报");
  assert.equal(
    platformRoleForCopy({ status: "ready", capabilities: { ...OWNER_CAPS, platformRole: "admin" } }),
    "admin",
    "已拿到就原样报",
  );
});

test("网关 503 撞上权限也没读到：两条路都摆出来，不许对管理员说「找管理员」", () => {
  const gatewayDown = { status: 503, code: "ai_gateway_disabled" };
  for (const [label, state] of [
    ["读取中", { status: "loading" } as CapabilitiesState],
    ["读不到", { status: "unavailable", reload: () => {} } as CapabilitiesState],
  ] as const) {
    const copy = capabilityErrorCopy(gatewayDown, platformRoleForCopy(state)) ?? "";
    assert.ok(copy.includes("到「全局设置」开启"), `权限${label}时要给管理员留出路：${copy}`);
    assert.notEqual(copy, "AI 辅助未开启，找管理员开启后再试", `权限${label}时不许把人判成非管理员——管理员会被指去找自己`);
  }
  assert.equal(
    capabilityErrorCopy(gatewayDown, platformRoleForCopy({ status: "ready", capabilities: OWNER_CAPS })),
    "AI 辅助未开启，找管理员开启后再试",
    "查清了确实是普通成员，原文案保持",
  );
});

/* ---------- ② 壳层三态：拉取/失败/重拉 ---------- */

let capabilitiesCalls = 0;
let capabilitiesFails = false;
/** 接口这一刻答的是谁的权限——换账号用例靠它区分 A 和 B。 */
let capabilitiesRole: "admin" | "operator" | "member" = "member";

(globalThis as Record<string, unknown>).fetch = async (input: unknown): Promise<unknown> => {
  const url = String(input);
  if (url.endsWith("/me/capabilities")) {
    capabilitiesCalls += 1;
    if (capabilitiesFails) {
      return { ok: false, status: 500, json: async () => ({ ok: false, error: { code: "internal", message: "boom" } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: { platform_role: capabilitiesRole, allow_member_create_project: true, projects: [{ project_id: "p1", role: "owner" }], permissions: [] },
      }),
    };
  }
  throw new Error(`未预期的请求：${url}`);
};

/** 把 hook 每一帧的值抄进外部变量，供断言读取；setSession 换会话身份（换人/重登）。 */
function mountHook(demoMode: boolean, sessionKey: string | null): {
  states: CapabilitiesState[];
  setSession: (next: string | null) => void;
  unmount: () => void;
} {
  const states: CapabilitiesState[] = [];
  function Probe({ session }: { session: string | null }): null {
    states.push(useCapabilitiesState({ demoMode, sessionKey: session }));
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (session: string | null): void => { act(() => { root.render(createElement(Probe, { session })); }); };
  render(sessionKey);
  return { states, setSession: render, unmount: () => act(() => root.unmount()) };
}

/** 已拿到时的权限；其余两态为 null（断言「有没有残留」用）。 */
function capsOf(state: CapabilitiesState): Capabilities | null {
  return state.status === "ready" ? state.capabilities : null;
}

async function flush(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

test("useCapabilitiesState：第一帧是读取中，不是读不到——读取中绝不等于没权限", async () => {
  window.sessionStorage.setItem("shortdrama_v01_token", "test-token");
  capabilitiesFails = false;
  const { states, unmount } = mountHook(false, "0:user-a");
  assert.equal(states[0]!.status, "loading", "首帧必须是读取中");
  await flush();
  assert.equal(states.at(-1)!.status, "ready");
  unmount();
});

test("useCapabilitiesState：接口失败落「读不到」，重拉入口真的重发请求并能救回来", async () => {
  window.sessionStorage.setItem("shortdrama_v01_token", "test-token");
  capabilitiesFails = true;
  const { states, unmount } = mountHook(false, "0:user-a");
  await flush();
  const failed = states.at(-1)!;
  assert.equal(failed.status, "unavailable", "接口失败必须落读不到，不许落回读取中或伪造空权限");
  assert.equal(typeof (failed as { reload: () => void }).reload, "function", "读不到态必须自带重拉入口");

  const callsBeforeRetry = capabilitiesCalls;
  capabilitiesFails = false;
  await act(async () => { (failed as { reload: () => void }).reload(); });
  await flush();
  assert.ok(capabilitiesCalls > callsBeforeRetry, "点重试必须真的重发能力请求");
  assert.equal(states.at(-1)!.status, "ready", "重拉成功后要回到已拿到");
  unmount();
});

/* ---------- ②-b 会话身份：权限跟着「哪一次登录」走 ----------
   401 原地重登的小窗里账号是可改的。绑「有没有人登录」时这个布尔一路是 true，
   effect 不重跑，B 就顶着 A 的权限：A 是管理员 → B 看得见后台入口和终审钮；
   A 是只读 → B 反而被告知等审核。这两条把它钉死。 */

test("useCapabilitiesState：换账号必须重拉权限，前一个人的那份一帧都不许残留", async () => {
  window.sessionStorage.setItem("shortdrama_v01_token", "test-token");
  capabilitiesFails = false;
  capabilitiesRole = "admin";
  const { states, setSession, unmount } = mountHook(false, "0:user-a");
  await flush();
  assert.equal(capsOf(states.at(-1)!)?.platformRole, "admin", "A 先按管理员读到");

  const callsAsA = capabilitiesCalls;
  const framesAsA = states.length;
  capabilitiesRole = "member";
  setSession("1:user-b");

  assert.ok(
    states.slice(framesAsA).every((state) => capsOf(state)?.platformRole !== "admin"),
    "换账号后不许再有任何一帧拿着 A 的权限",
  );
  await flush();
  assert.ok(capabilitiesCalls > callsAsA, "换账号必须重新请求能力接口");
  assert.equal(capsOf(states.at(-1)!)?.platformRole, "member", "B 必须拿到自己的那份权限");
  assert.ok(
    states.slice(framesAsA).every((state) => capsOf(state)?.platformRole !== "admin"),
    "整个换账号过程里都不许闪出 A 的权限",
  );
  unmount();
});

test("useCapabilitiesState：同一个人原地重登也是新会话——「读不到」不许一直挂着", async () => {
  window.sessionStorage.setItem("shortdrama_v01_token", "test-token");
  capabilitiesFails = true;
  capabilitiesRole = "member";
  const { states, setSession, unmount } = mountHook(false, "0:user-a");
  await flush();
  assert.equal(states.at(-1)!.status, "unavailable", "401 那次连权限也没读到");

  const callsBefore = capabilitiesCalls;
  capabilitiesFails = false;
  setSession("1:user-a");
  await flush();
  assert.ok(capabilitiesCalls > callsBefore, "重登后必须重新请求能力接口，不能等用户去点重试");
  assert.equal(states.at(-1)!.status, "ready", "重登成功后要自己从「读不到」回到已拿到");
  unmount();
});

/* app.tsx 顶上有 CSS import，node 里挂不起来（全仓惯例：壳层接线只能源码级守）。
   上面两条钉的是 hook 的行为，这条钉「壳层真的把会话身份喂给了它」。

   判据按语义写，不按字面写：原先靠整串字面量匹配，行尾加个注释、把三元换成
   `user === null ? null : …` 都会假红。源码级守卫一旦假红，下一个人要么去改 app.tsx
   迁就守卫，要么干脆把守卫删了——两条路都比没有守卫更糟。所以先归一化，再只问三件事：
   会话身份带没带「第几次登录」、带没带「是谁」、没人登录时给不给 null。 */

/** 去注释、压空白：注释与换行不改变这段接线的语义，判据也不该跟着变。 */
function normalizeSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/\s+/g, " ");
}

/** 会话身份表达式：直接写在调用点，或先 const 出来再传——两种写法同义，一并认。 */
function sessionKeyExpression(normalized: string): string {
  const call = /useCapabilitiesState\(([\s\S]*?)\);/.exec(normalized)?.[1] ?? "";
  if (/sessionKey\s*:/.test(call)) return call;
  return /(?:const|let)\s+sessionKey\s*=\s*[^;]*;/.exec(normalized)?.[0] ?? call;
}

/** 从 from 起第一个 `{` 到与它配平的 `}` 之间的内容。 */
function balancedBraces(source: string, from: number): string {
  const open = source.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && (depth -= 1) === 0) return source.slice(open + 1, index);
  }
  return "";
}

/** 401 小窗「重登成功」那个回调：函数体，以及它给「重登进来的这个人」起的名字。 */
function reloginSuccessHandler(normalized: string): { body: string; nextUser: string } {
  const modal = normalized.indexOf("<SessionReloginModal");
  const at = modal < 0 ? -1 : normalized.indexOf("onSuccess=", modal);
  if (at < 0) return { body: "", nextUser: "" };
  const container = balancedBraces(normalized, at);                /* JSX 的 {...} */
  const parameter = /^\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/.exec(container)?.[1] ?? "";
  return { body: balancedBraces(container, 0) || container, nextUser: parameter };
}

/** 「会话序号 +1」的同义写法：函数式更新（形参随便叫）或直接拿当前值加一。 */
const BUMPS_SESSION = /setSignInSeq\(\s*(?:\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\1|signInSeq)\s*\+\s*1\s*\)/;

test("壳层接线：喂给权限状态的是会话身份，不是「有没有人登录」", async () => {
  const { readFileSync } = await import("node:fs");
  const app = normalizeSource(readFileSync(new URL("./app.tsx", import.meta.url), "utf8"));
  const sessionKey = sessionKeyExpression(app);
  assert.ok(sessionKey.length > 0, "app.tsx 里找不到 useCapabilitiesState 的调用点——壳层没接权限状态");
  assert.match(sessionKey, /signInSeq/, "会话身份要带「第几次登录」：同一个人 401 原地重登也是新会话，得重读权限");
  assert.match(sessionKey, /user\.id/, "会话身份要带用户 id：401 小窗里能换成别人登进来，不带 id 就是 B 顶着 A 的权限");
  assert.match(sessionKey, /(?:^|[^.\w])null\b/, "没人登录时喂 null；拿空串或 false 冒充会被当成「某一次会话」");
  assert.ok(!/signedIn\s*:/.test(app), "不许退回「有没有人登录」的布尔——它在换账号时一路是 true，权限不重拉");

  /* 这后半条原先也是字面形状（整串 `setSignInSeq((seq) => seq + 1); setUser(nextUser);`），
     实测三种语义等价改写会假红：形参改名 `(n) => n + 1`、省掉形参括号 `seq => seq + 1`、
     两句调换顺序（同一个事件处理器里 React 批处理，先后无差）。而它的失败消息说的是
     「要开一次新会话」——照着那句话去改 app.tsx 只会越改越糟。所以同样归一化后按语义问：
     ① 这个回调里把会话序号推进了一格；② 顺带把人换成重登进来的那一个。 */
  const relogin = reloginSuccessHandler(app);
  assert.ok(relogin.body.length > 0, "app.tsx 里找不到 401 小窗的重登成功回调——重登接线整个没了");
  assert.match(
    relogin.body,
    BUMPS_SESSION,
    "401 原地重登成功要开一次新会话（会话序号推进一格）：同一个账号重登也得重读权限",
  );
  assert.ok(relogin.nextUser.length > 0, "重登成功回调没接住新用户——拿不到人就谈不上换会话身份");
  assert.match(
    relogin.body,
    new RegExp(`setUser\\(\\s*${relogin.nextUser}\\s*\\)`),
    "重登成功要把当前用户换成重登进来的那一个：401 小窗里可以换个账号登，不换人就是 B 顶着 A 的身份",
  );
});

/* ---------- ③ 正式版整页闸门与按钮位：读不到 ≠ 无权 ---------- */

const { renderToStaticMarkup } = await import("react-dom/server");
const { AdminConsolePage } = await import("./pages/admin-page");
const { ProjectCostsPage } = await import("./pages/operations-pages");
const { ProjectsPage } = await import("./pages/global-pages");
const { BreakdownRunPage } = await import("./pages/breakdown-run-page");
const { CapabilityActionSlot } = await import("./components/capability-notice");
const { createRehearsalRun, tickRehearsalRun } = await import("./requirement-breakdown");
const { demoBreakdownRequirements, demoUser } = await import("./demo");

/** SSR 在相邻文本节点间插 <!-- -->，断言可见文案前先归一。 */
function textOf(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

const MEMBER_CAPS: Capabilities = { platformRole: "member", allowMemberCreateProject: false, projects: [], permissions: [] };

type PageComponent = (props: Record<string, unknown>) => React.JSX.Element;

function renderWithCapabilities(component: unknown, state: CapabilitiesState, extra: Record<string, unknown> = {}): string {
  return textOf(renderToStaticMarkup(createElement(component as PageComponent, {
    demoMode: true,
    notify: () => {},
    user: demoUser,
    capabilities: state,
    ...extra,
  })));
}

test("管理后台整页闸门：读不到说没读到给重试，读取中不下结论，查清了才说只对管理员开放", () => {
  let reloaded = 0;
  const unavailable = renderWithCapabilities(AdminConsolePage, { status: "unavailable", reload: () => { reloaded += 1; } });
  assert.ok(unavailable.includes("权限信息没读到"), "读不到必须明说");
  assert.ok(unavailable.includes("重试"), "读不到必须给重试");
  assert.ok(!unavailable.includes("后台只对管理员和运营开放"), "接口故障不得说成你不是管理员");
  assert.equal(reloaded, 0, "渲染阶段不许自己触发重拉");

  const loading = renderWithCapabilities(AdminConsolePage, { status: "loading" });
  assert.ok(!loading.includes("后台只对管理员和运营开放"), "还在读就下拒绝结论");
  assert.ok(loading.includes("正在确认权限"), "读取中要如实说在确认");

  const denied = renderWithCapabilities(AdminConsolePage, { status: "ready", capabilities: MEMBER_CAPS });
  assert.ok(denied.includes("后台只对管理员和运营开放"), "查清了确实无权，原拒绝文案保持");
});

test("项目消耗页整页闸门：读不到给重试，读取中不下结论，查清了 viewer 才说不可见", () => {
  const projectId = "demo-project-1";
  const unavailable = renderWithCapabilities(ProjectCostsPage, { status: "unavailable", reload: () => {} }, { projectId });
  assert.ok(unavailable.includes("权限信息没读到"), "读不到必须明说");
  assert.ok(!unavailable.includes("成本视图仅查看不可见"), "接口故障不得说成你只可查看");
  assert.ok(!unavailable.includes("消耗明细"), "读不到不得露数据区");

  const loading = renderWithCapabilities(ProjectCostsPage, { status: "loading" }, { projectId });
  assert.ok(!loading.includes("成本视图仅查看不可见"), "还在读就下拒绝结论");
  assert.ok(!loading.includes("消耗明细"), "读取中不得露数据区");

  const denied = renderWithCapabilities(ProjectCostsPage, { status: "ready", capabilities: MEMBER_CAPS }, { projectId });
  assert.ok(denied.includes("成本视图仅查看不可见"), "查清了确实无权，原拒绝文案保持");
  assert.ok(!denied.includes("消耗明细"), "无权者不该看到数据区");
});

test("新建项目按钮位：读不到给重试入口，已拿到有权才出按钮", () => {
  const unavailable = renderWithCapabilities(ProjectsPage, { status: "unavailable", reload: () => {} });
  assert.ok(unavailable.includes("权限信息没读到"), "读不到必须明说，而不是让按钮凭空消失");

  const allowed = renderWithCapabilities(ProjectsPage, { status: "ready", capabilities: { ...MEMBER_CAPS, allowMemberCreateProject: true } });
  assert.ok(allowed.includes("新建项目"), "有权时按钮照出");
  assert.ok(!allowed.includes("权限信息没读到"), "已拿到不该出失败位");
});

/* ---------- ④ 读取中不许闪：占位得真的占住这一格 ----------
   ①②③ 只断言否定项（读取中别说「等审核」、别出可点的钮）。变异实测过：把占位整支删掉
   （CapabilityActionSlot 的读取中分支直接 return null），补这一节之前全前端一条都不红——
   「不闪」压根没被测。闪 = 这一格先空着、权限落地后突然长出一枚按钮，页面跟着往下跳。
   所以下面按肯定项写：这一格必须有东西，撑得起高度，且与真按钮同字。 */

/** SSR 出的是字符串；要问「这一格摆了什么元素」得先落进 DOM。 */
function domOf(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = textOf(html);
  return host as unknown as HTMLElement;
}

const LOADING: CapabilitiesState = { status: "loading" };
const UNAVAILABLE: CapabilitiesState = { status: "unavailable", reload: () => {} };

test("动作位占位：读取中给同字 disabled 钮、读不到给「没读到 · 重试」，两态都占住这一格", () => {
  const loading = domOf(renderToStaticMarkup(createElement(CapabilityActionSlot, { state: LOADING, label: "生成视频" })));
  const placeholder = loading.firstElementChild;
  assert.ok(placeholder, "读取中这一格空着 = 按钮先无后有地闪，正是本单要消灭的东西");
  assert.equal(placeholder!.tagName, "BUTTON", "占位与真按钮同类元素，才谈得上同尺寸");
  assert.equal(placeholder!.textContent?.trim(), "生成视频", "占位与真按钮同字，宽度才不跳");
  assert.ok(placeholder!.hasAttribute("disabled"), "权限还没读到，占位不许可点");
  assert.ok(holdsSpace(placeholder!), "占位得撑得起高度，塌成零高等于没占");

  const unavailable = domOf(renderToStaticMarkup(createElement(CapabilityActionSlot, { state: UNAVAILABLE, label: "生成视频" })));
  const notice = unavailable.firstElementChild;
  assert.ok(notice, "读不到这一格也不许空着");
  assert.ok(holdsSpace(notice!), "「没读到」位同样得占住高度");
  assert.ok(notice!.textContent?.includes("权限信息没读到"), "读不到要明说");
  assert.ok([...unavailable.querySelectorAll("button")].some((el) => el.textContent?.trim() === "重试"), "读不到必须给重试");

  const ready = renderToStaticMarkup(createElement(CapabilityActionSlot, { state: { status: "ready", capabilities: OWNER_CAPS }, label: "生成视频" }));
  assert.equal(ready, "", "已拿到时槽位不插手：出按钮还是出拒绝文案，由调用方按判定自己表态");
});

test("新建项目按钮位：读取中就摆着同字占位，不是空一格等权限落地再长出按钮", () => {
  const named = (root: HTMLElement): HTMLButtonElement[] =>
    [...root.querySelectorAll("button")].filter((el) => el.textContent?.trim() === "新建项目") as HTMLButtonElement[];

  const loading = named(domOf(renderWithCapabilities(ProjectsPage, LOADING)));
  assert.equal(loading.length, 1, "读取中这一格必须有且只有占位这一件东西");
  assert.ok(loading[0]!.hasAttribute("disabled"), "占位不可点");
  assert.ok(holdsSpace(loading[0]!), "占位得占住高度");

  const allowed = named(domOf(renderWithCapabilities(ProjectsPage, { status: "ready", capabilities: { ...MEMBER_CAPS, allowMemberCreateProject: true } })));
  assert.equal(allowed.length, 1, "权限落地后同一格换成真按钮");
  assert.ok(!allowed[0]!.hasAttribute("disabled"), "真按钮可点");
  assert.equal(loading[0]!.textContent?.trim(), allowed[0]!.textContent?.trim(), "占位与真按钮同字——不同字就是宽度会跳");
});

/** 吸底条（拆解确认页底部那条）：三种说法互斥，同屏只许一条，且哪一条都不许是空壳。 */
function stickyBars(root: HTMLElement): Element[] {
  return [...root.querySelectorAll("div")].filter((el) => (el.getAttribute("class") ?? "").includes("sticky bottom-4"));
}

test("拆解确认页吸底条：四态各一条、条条有内容——读取中摆占位，不是一条带边框的空浮条", () => {
  const runId = "run-caps-three-state";
  const projectId = "demo-project-1";
  createRehearsalRun({
    idempotencyKey: "caps-three-state",
    projectId,
    scope: { kind: "shot", shotId: "shot-1" },
    scopeLabel: "第 1 集素材 · #1",
    sourceText: "雨夜巷口，女主奔跑回头。",
    requirements: demoBreakdownRequirements(),
    returnDestination: { label: "回生产页", path: `/projects/${projectId}/storyboards` },
    runId,
  });
  for (let step = 0; step < 4; step += 1) tickRehearsalRun(runId);
  const props = { projectId, runId };

  const loading = stickyBars(domOf(renderWithCapabilities(BreakdownRunPage, LOADING, props)));
  assert.equal(loading.length, 1, "读取中同屏只许一条吸底条");
  /* 条本身有边框有内边距，空着也「有高度」——所以这里问的是里面有没有东西：
     一条带边框的空浮条是改动前真出现过的东西。 */
  assert.ok(loading[0]!.children.length > 0, "读取中的吸底条不许是空壳");
  assert.equal(loading[0]!.textContent?.trim(), "确认并采用", "读取中摆的是与真按钮同字的占位");
  assert.ok((loading[0]!.querySelector("button") as HTMLButtonElement | null)?.hasAttribute("disabled"), "占位不可点");

  const unavailable = stickyBars(domOf(renderWithCapabilities(BreakdownRunPage, UNAVAILABLE, props)));
  assert.equal(unavailable.length, 1, "读不到同屏只许一条吸底条");
  assert.ok(unavailable[0]!.textContent?.includes("权限信息没读到"), "读不到要明说");
  assert.ok(!unavailable[0]!.textContent?.includes("只有项目负责人和编辑能确认采用"), "别一边说没读到、一边替接口把人判成没权限");

  const denied = stickyBars(domOf(renderWithCapabilities(BreakdownRunPage, { status: "ready", capabilities: MEMBER_CAPS }, props)));
  assert.equal(denied.length, 1, "查清了无权也只许一条");
  assert.ok(denied[0]!.textContent?.includes("只有项目负责人和编辑能确认采用"), "查清了确实无权，这句才准说（也说明这条不是空壳浮条）");

  const ownerCaps: Capabilities = { ...MEMBER_CAPS, projects: [{ projectId, role: "owner" }] };
  const allowed = stickyBars(domOf(renderWithCapabilities(BreakdownRunPage, { status: "ready", capabilities: ownerCaps }, props)));
  assert.equal(allowed.length, 1, "有权也只许一条");
  assert.ok(allowed[0]!.textContent?.includes("确认并采用"), "有权出真动作条");
  assert.ok(!allowed[0]!.textContent?.includes("只有项目负责人和编辑能确认采用"), "有权不许再挂那句说明");
});

test("useCapabilitiesState：离线演示恒为已拿到；未登录回读取中，不与失败同形", async () => {
  capabilitiesFails = false;
  const demo = mountHook(true, "0:user-a");
  await flush();
  assert.equal(demo.states.at(-1)!.status, "ready", "离线演示必须直接是已拿到");
  demo.unmount();

  const signedOut = mountHook(false, null);
  await flush();
  assert.equal(signedOut.states.at(-1)!.status, "loading", "未登录是读取中，不是读不到");
  signedOut.unmount();
});

/* ---------- ⑤ 就绪标记与权限分两层：合起来判会让另一件事替权限背锅 ----------
   工作台「生成视频」那一格有两道门：先看这条素材标没标就绪（人工判断，与权限无关），
   标了才轮到权限说话。合成一条 `readyMark && canCreate ? 钮 : 占位` 看着等价，实际是：
   · 没标就绪 + 权限读取中 → 凭空多一枚 disabled「生成视频」幽灵钮（这一格本该空着）；
   · 没标就绪 + 权限读不到 → 把「你还没标就绪」说成「权限信息没读到 · 重试」，
     用户点重试、重试真的成功了，按钮照样不出来——他会一直点下去。
   这两条是本节要钉的东西；SSR 渲不出（就绪标记在 effect 里从本地存储读），只能真挂载。

   为什么可以真挂载：这一页 demo 模式下取数全走 fixture，一次 fetch 都不发（上面那个
   fetch 替身对未预期的 URL 直接抛，这一节全程没被触发就是证据）。
   为什么可以 import 这个「退役中」的文件：禁令挡的是产品代码把它拉回运行时（bundle
   要树摇掉它），测试 import 不进 bundle；文件留着的理由本来就是「测试还锚着它」。 */

const { WorkbenchPage } = await import("./pages/workbench-page");
const { saveReadyMark } = await import("./shot-ready");

const WORKBENCH_PROJECT_ID = "demo-project-1";
const WORKBENCH_SHOT_ID = "demo-shot-1";
const WORKBENCH_OWNER_CAPS: Capabilities = {
  ...MEMBER_CAPS,
  projects: [{ projectId: WORKBENCH_PROJECT_ID, role: "owner" }],
};

/**
 * 真挂载工作台首页跑一段断言；ready=这条素材标没标就绪（就绪标记只存在本地存储里）。
 * 卸载放 finally：断言失败也得卸载——留着的根带着页内轮询，会把测试进程挂住不退出。
 */
function withWorkbench(state: CapabilitiesState, ready: boolean, assertions: (container: HTMLElement) => void): void {
  saveReadyMark(window.localStorage, WORKBENCH_SHOT_ID, ready ? { by: "Alice", at: "2026-08-10T00:00:00.000Z" } : null);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => {
      root.render(createElement(WorkbenchPage as unknown as PageComponent, {
        projectId: WORKBENCH_PROJECT_ID,
        episodeId: "demo-episode-1",
        shotId: WORKBENCH_SHOT_ID,
        demoMode: true,
        notify: () => {},
        user: demoUser,
        capabilities: state,
      }));
    });
    assertions(container as HTMLElement);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
}

/** 这一格里叫「生成视频」的按钮（真钮与占位同字，靠 disabled 区分）。 */
function generateVideoButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")].filter((el) => el.textContent?.trim() === "生成视频") as HTMLButtonElement[];
}

/* ---------- ⑥ 深链意图：权限没落地时挂起，不是当场丢掉 ----------
   ⌘K / 选题雷达 CTA 会带 ?create=1 进项目页，页面读到就开新建弹窗然后剥参。
   剥参必须等权限落地：读取中/读不到时剥参，用户从别处点进来的那一下就没了——
   看板里那格摆的还是「没读到 · 重试」，他重试读回来，弹窗也不会自己开。
   这一条只在客户端跑得出来（意图挂起发生在 effect 里，SSR 渲不到）。 */

/** 带查询串挂 ProjectsPage；返回重渲入口，用来演「权限后来读回来了」。 */
function mountProjectsWithSearch(search: string, state: CapabilitiesState): {
  rerender: (next: CapabilitiesState) => void;
  unmount: () => void;
} {
  window.history.replaceState({}, "", `/projects${search}`);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (next: CapabilitiesState): void => {
    act(() => {
      root.render(createElement(ProjectsPage as unknown as PageComponent, {
        demoMode: true, notify: () => {}, user: demoUser, capabilities: next,
      }));
    });
  };
  render(state);
  return {
    rerender: render,
    unmount: () => { act(() => root.unmount()); container.remove(); },
  };
}

/** 弹窗走 Radix portal，挂在 body 上，不在容器里。 */
function createDialogOpen(): boolean {
  return [...document.querySelectorAll("[role='dialog']")].some((el) => el.textContent?.includes("新建项目"));
}

test("新建项目深链：权限没落地就先挂着——不剥参、不吞掉用户点进来的那一下", () => {
  for (const [label, state] of [
    ["读取中", LOADING],
    ["读不到", UNAVAILABLE],
  ] as const) {
    const view = mountProjectsWithSearch("?create=1", state);
    try {
      assert.equal(
        window.location.search,
        "?create=1",
        `权限${label}就把 ?create=1 剥掉，用户的意图当场没了：这一格摆的是「没读到 · 重试」，他重试读回来弹窗也不会开`,
      );
      assert.ok(!createDialogOpen(), `权限${label}不许先把弹窗开出来`);
    } finally {
      view.unmount();
    }
  }
});

test("新建项目深链：权限读回来那一刻接着办——有权就开弹窗并剥参，无权只剥参", () => {
  const allowedCaps: Capabilities = { ...MEMBER_CAPS, allowMemberCreateProject: true };
  const recovered = mountProjectsWithSearch("?create=1", UNAVAILABLE);
  try {
    recovered.rerender({ status: "ready", capabilities: allowedCaps });
    assert.ok(createDialogOpen(), "重试读回来、确实有权，挂着的那一下要接着办完");
    assert.equal(window.location.search, "", "办完了才剥参");
  } finally {
    recovered.unmount();
  }

  const denied = mountProjectsWithSearch("?create=1", { status: "ready", capabilities: MEMBER_CAPS });
  try {
    assert.ok(!createDialogOpen(), "查清了确实无权，不给开弹窗");
    assert.equal(window.location.search, "", "查清了就剥参，别把点不动的深链留在地址栏");
  } finally {
    denied.unmount();
  }
});

test("新建项目深链：从「读不到」查到「确实无权」也要剥参——这一步只有走转移才测得出来", () => {
  /* 上一条里的无权那半段是**一上来就** ready+无权：首挂时 effect 必然跑一次，
     依赖数组里写什么都剥得掉参。真正会漏的是这条**转移**——
     读不到 →（用户点了重试）查清确实无权。
     这条路上 allowCreate 一路是 false、地址栏也没变，只有 createGate 在依赖数组里
     effect 才会重跑。把 createGate 当成「无害的依赖精简」去掉，`?create=1` 就永远剥不掉，
     点不动的深链一直挂在地址栏上——而「查清了就剥参」正是上一条自己写着要防的事。 */
  const view = mountProjectsWithSearch("?create=1", UNAVAILABLE);
  try {
    assert.equal(window.location.search, "?create=1", "还没查清之前先挂着（这是前提，不是本条要证的）");
    view.rerender({ status: "ready", capabilities: MEMBER_CAPS });
    assert.ok(!createDialogOpen(), "查清确实无权，不给开弹窗");
    assert.equal(
      window.location.search,
      "",
      "查清了就得剥参：这一步 allowCreate 与地址栏都没变，effect 不重跑的话这条点不动的深链就永远挂着",
    );
  } finally {
    view.unmount();
  }
});

test("镜级工作台动作位：没标就绪时这一格本来就空着——不借权限位说话", () => {
  for (const [label, state] of [
    ["读取中", LOADING],
    ["读不到", UNAVAILABLE],
    ["已拿到有权", { status: "ready", capabilities: WORKBENCH_OWNER_CAPS } as CapabilitiesState],
  ] as const) {
    withWorkbench(state, false, (container) => {
      assert.equal(
        generateVideoButtons(container).length,
        0,
        `没标就绪 + 权限${label}：这一格不许有「生成视频」——占位也不行，那是凭空长出来的幽灵钮`,
      );
      assert.ok(
        !container.textContent?.includes("权限信息没读到"),
        `没标就绪 + 权限${label}：按钮不出来是因为没标就绪，不许赖到权限头上（用户点重试、重试成功，按钮还是不出来）`,
      );
    });
  }
});

test("镜级工作台动作位：标了就绪之后，权限四态各说各的话", () => {
  withWorkbench(LOADING, true, (container) => {
    const buttons = generateVideoButtons(container);
    assert.equal(buttons.length, 1, "读取中要摆同字占位——空着就是等权限落地再长出按钮，整行往下跳");
    assert.ok(buttons[0]!.hasAttribute("disabled"), "权限还没读到，占位不许可点");
    assert.ok(holdsSpace(buttons[0]!), "占位得撑得起高度");
    assert.ok(!container.textContent?.includes("权限信息没读到"), "还在读不许先说读不到");
  });

  withWorkbench(UNAVAILABLE, true, (container) => {
    assert.equal(generateVideoButtons(container).length, 0, "读不到时不许摆一枚点不动的「生成视频」冒充");
    assert.ok(container.textContent?.includes("权限信息没读到"), "读不到必须明说");
    assert.ok(
      [...container.querySelectorAll("button")].some((el) => el.textContent?.trim() === "重试"),
      "读不到必须给重试——这一格是用户唯一的出路",
    );
  });

  withWorkbench({ status: "ready", capabilities: WORKBENCH_OWNER_CAPS }, true, (container) => {
    const buttons = generateVideoButtons(container);
    assert.equal(buttons.length, 1, "查清了有权，同一格换成真按钮");
    assert.ok(!buttons[0]!.hasAttribute("disabled"), "真按钮可点");
  });

  withWorkbench({ status: "ready", capabilities: MEMBER_CAPS }, true, (container) => {
    assert.equal(generateVideoButtons(container).length, 0, "查清了确实无权（viewer 只读），不出创作钮");
    assert.ok(!container.textContent?.includes("权限信息没读到"), "查清了就别再说没读到");
  });
});
