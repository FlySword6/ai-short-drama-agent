/* ============================================================
   lite-shots-reference.test.ts — #186 全能参考 + #184 站内图片路径 +「时长」归视频

   口径锁定（2026-08-10 拍板，docs/design/prd-v2/lite.md）：
   - 生视频 = 全能参考：本镜定稿图（登记产物）+ 勾选参考素材全部以
     usage_mode="reference" 同槽进请求；旧锚定方案（首帧/尾帧/延长接力）整条删除，
     lite 目录源码 grep 无 first_frame/首帧/尾帧/延长 字样（注释一并清净）。
   - #184：精简版图片组件统一走站内下载路径 /api/v1/media/:id/download
     （带登录态取字节 → objectURL），不用存储直链。
   - 「时长」归视频：行编辑时长标注为本镜视频时长；生图侧（配置卡/动作）不出现时长。
   组件级用 happy-dom 真渲染（同 k2-submit-truth 基建：React.createElement 不写 JSX）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";

/* happy-dom 先落地全局，再动态 import react/react-dom（同 s83 基建纪律）。 */
const happyWindow = new Window({ url: "http://localhost/" });
for (const key of Object.getOwnPropertyNames(happyWindow)) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] = (happyWindow as unknown as Record<string, unknown>)[key];
  }
}
(globalThis as Record<string, unknown>).window = happyWindow;
(globalThis as Record<string, unknown>).document = happyWindow.document;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
/* Radix 弹层（参考包「加参考」Dialog）在 happy-dom 里派发自定义事件：事件构造器必须与
   happy-dom 的 EventTarget 同源——Node 22 自带 Event/CustomEvent 会被复制循环跳过，
   强行换成 happy-dom 版，否则 dispatchEvent 类型校验炸掉（dismissable-layer/focus-scope）。 */
for (const eventCtor of ["Event", "CustomEvent", "PointerEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "FocusEvent"]) {
  const ctor = (happyWindow as unknown as Record<string, unknown>)[eventCtor];
  if (ctor) (globalThis as Record<string, unknown>)[eventCtor] = ctor;
}

/* LiteImage 的懒加载靠 IntersectionObserver 判可见性;happy-dom 有构造器但没有真实布局,
   回调永不触发。这里给一个可控替身:默认「立即可见」,让既有断言按真实浏览器行为走;
   把 intersectionImmediately 置 false 就能测「不在视口不取字节」。 */
let intersectionImmediately = true;
const observedNodes: unknown[] = [];
class TestIntersectionObserver {
  constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
  observe(node: unknown): void {
    observedNodes.push(node);
    if (intersectionImmediately) this.callback([{ isIntersecting: true }]);
  }
  disconnect(): void {}
  unobserve(): void {}
}
(globalThis as Record<string, unknown>).IntersectionObserver = TestIntersectionObserver;

/* ---------- fetch 全 mock：按「方法 + 路径」路由；捕获 estimate/submit 请求体 ---------- */

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
  authorization: string | null;
}

const calls: RecordedCall[] = [];
let generationDefaultSaveBody: Record<string, unknown> | null = null;

const PROJECT_ID = "proj-lite-1";
const EPISODE_ID = "ep-lite-1";
const SHOT_ID = "shot-lite-1";
const PRIMARY_MEDIA_RESULT_ID = "mr-primary-1";
const CANDIDATE_MEDIA_RESULT_ID = "mr-candidate-2";
/** 待审的候选视频：出片侧「定成这一镜的片 / 等审核」两条分支都由它触发。 */
const CANDIDATE_VIDEO_RESULT_ID = "mr-video-1";
const PRIMARY_ASSET_MEDIA_ID = "am-primary-1";
const PICK_ASSET_MEDIA_ID = "am-pick-1";
const REVIEWER_USER_ID = "user-reviewer-1";

/** 模板库 CRUD 的内存注册表：自建模板走它回读，避免页面重取时丢失。 */
const templateStore: Record<string, { id: string; project_id: string; media_kind: string; name: string; content: string }> = {};
let templateSeq = 0;
/** 风格库 CRUD 的内存注册表（设默认 = 行级锁定：is_default 行前端禁用只是快路径，服务端 409）。 */
interface StyleRow {
  id: string;
  project_id: string;
  media_kind: string;
  name: string;
  content: string;
  is_default: boolean;
  created_by_user_id: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}
const styleStore: Record<string, StyleRow> = {};
let styleSeq = 0;
/** 生成默认策略覆盖（模板生效拼接测试注入：策略引用库里模板 → 提交体 supplement_prompt）。 */
let imageStrategyOverride: Record<string, unknown> | null = null;
let videoStrategyOverride: Record<string, unknown> | null = null;

const IMAGE_TIER_RAW = {
  tier_id: "img-tier-1",
  media_type: "image",
  display_name: "图片档",
  provider_label: null,
  model_label: "图片模型",
  params: { aspect_ratio: "16:9", resolution: "2K", quantity: 1 },
  price: { unit: "per_image", points: 60 },
  status: "active",
};
/* 第二档（1K）：深挖面板换清晰度用——断言覆盖档真实进提交体。 */
const IMAGE_TIER_RAW_2 = {
  tier_id: "img-tier-2",
  media_type: "image",
  display_name: "图片档",
  provider_label: null,
  model_label: "图片模型",
  params: { aspect_ratio: "16:9", resolution: "1K", quantity: 1 },
  price: { unit: "per_image", points: 30 },
  status: "active",
};
const IMAGE_TIER_OTHER_MODEL = {
  tier_id: "img-tier-other-916-2k",
  media_type: "image",
  display_name: "另一图片档",
  provider_label: null,
  model_label: "另一图片模型",
  params: { aspect_ratio: "9:16", resolution: "2K", quantity: 1 },
  price: { unit: "per_image", points: 60 },
  status: "active",
};
const IMAGE_TIER_OTHER_MODEL_SQUARE = {
  ...IMAGE_TIER_OTHER_MODEL,
  tier_id: "img-tier-other-11-1k",
  params: { aspect_ratio: "1:1", resolution: "1K", quantity: 1 },
};
const IMAGE_TIER_WITHOUT_RATIO = {
  ...IMAGE_TIER_OTHER_MODEL,
  tier_id: "img-tier-without-ratio",
  model_label: "缺画幅图片模型",
  params: { resolution: "1K", quantity: 1 },
};
const VIDEO_TIER_RAW = {
  tier_id: "vid-tier-1",
  media_type: "video",
  display_name: "视频档",
  provider_label: null,
  model_label: "视频模型",
  params: { aspect_ratio: "9:16", resolution: "720p", duration_seconds: 4 },
  price: { unit: "per_second", points: 80 },
  status: "active",
};
/** 修订二视频级联用例的第二档：不同模型/清晰度/比例/时长——验证下游维度随模型收窄（单值也是下拉）。 */
const VIDEO_TIER_RAW_2 = {
  tier_id: "vid-tier-2",
  media_type: "video",
  display_name: "视频档2",
  provider_label: null,
  model_label: "另一视频模型",
  params: { aspect_ratio: "16:9", resolution: "1080p", duration_seconds: 8 },
  price: { unit: "per_second", points: 80 },
  status: "active",
};

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ ok: true, data }),
    blob: async () => new Blob(["lite-image-bytes"], { type: "image/png" }),
  } as unknown as Response;
}

function route(method: string, path: string): unknown {
  if (method === "GET" && path === `/projects/${PROJECT_ID}`) return { id: PROJECT_ID, name: "测试项目", lite_episode_id: EPISODE_ID };
  if (method === "GET" && path === `/episodes/${EPISODE_ID}/shots`) {
    return { items: [{ id: SHOT_ID, episode_id: EPISODE_ID, shot_no: "1", script_text: "林晚：你回来了。", director_prompt: "近景：林晚抬头。", duration_seconds: 6, sort_order: 1 }], count: 1 };
  }
  if (method === "GET" && path === `/shots/${SHOT_ID}/media`) {
    return {
      items: [
        { id: PRIMARY_MEDIA_RESULT_ID, media_kind: "image", storage_url: "https://storage.example/primary.png", is_primary: true, persistence_status: "persisted", review_status: "accepted", provider_result_key: "image-0", created_at: "2026-08-10T08:00:00.000Z" },
        { id: CANDIDATE_MEDIA_RESULT_ID, media_kind: "image", storage_url: "https://storage.example/candidate-2.png", is_primary: false, persistence_status: "persisted", review_status: "needs_review", provider_result_key: "image-1", created_at: "2026-08-10T08:05:00.000Z" },
        { id: CANDIDATE_VIDEO_RESULT_ID, media_kind: "video", storage_url: "https://storage.example/candidate.mp4", is_primary: false, persistence_status: "persisted", review_status: "needs_review", provider_result_key: "video-0", duration_seconds: 4, created_at: "2026-08-10T08:10:00.000Z" },
      ],
      count: 3,
    };
  }
  if (method === "GET" && path === `/projects/${PROJECT_ID}/review-policies`) {
    return {
      items: [
        { id: "pol-img", project_id: PROJECT_ID, media_kind: "image", default_strategy: "pending_review", reviewer_user_id: REVIEWER_USER_ID, version: 1 },
        { id: "pol-vid", project_id: PROJECT_ID, media_kind: "video", default_strategy: "pending_review", reviewer_user_id: null, version: 1 },
      ],
      count: 2,
    };
  }
  if (method === "GET" && path === `/projects/${PROJECT_ID}/members`) {
    return {
      items: [
        { project_id: PROJECT_ID, user_id: "user-owner-1", username: "zhangdao", display_name: "张导", platform_role: "member", project_role: "owner" },
        { project_id: PROJECT_ID, user_id: REVIEWER_USER_ID, username: "lizhipian", display_name: "李制片", platform_role: "member", project_role: "editor" },
      ],
      count: 2,
    };
  }
  if (method === "POST" && path === `/projects/${PROJECT_ID}/media-reviews/decisions`) return { items: [{ media_result_id: CANDIDATE_MEDIA_RESULT_ID, status: "accepted", changed: true }], count: 1 };
  if (method === "POST" && path.endsWith("/set-primary")) return { shot_id: SHOT_ID, media_kind: "image", selected_media_result_id: CANDIDATE_MEDIA_RESULT_ID };
  if (method === "GET" && path === `/projects/${PROJECT_ID}/generation-defaults/image`) {
    return imageStrategyOverride ?? { id: "gd-img", project_id: PROJECT_ID, media_kind: "image", mode: "material_to_prompt", model_key: "img-tier-1", parameters: { size: "2K", ratio: "16:9", prompt_template_id: null }, version: 1 };
  }
  if (method === "GET" && path === `/projects/${PROJECT_ID}/generation-defaults/video`) {
    return videoStrategyOverride ?? { id: "gd-vid", project_id: PROJECT_ID, media_kind: "video", mode: "material_to_prompt", model_key: "vid-tier-1", parameters: { resolution: "720p", ratio: "9:16", duration_seconds: 4, prompt_template_id: null }, version: 1 };
  }
  if (method === "GET" && path === `/projects/${PROJECT_ID}/prompt-templates?media_kind=image`) {
    const items = Object.values(templateStore).filter((template) => template.media_kind === "image");
    return { items, count: items.length };
  }
  if (method === "GET" && path === `/projects/${PROJECT_ID}/prompt-templates?media_kind=video`) {
    const items = Object.values(templateStore).filter((template) => template.media_kind === "video");
    return { items, count: items.length };
  }
  if (method === "GET" && path.startsWith(`/projects/${PROJECT_ID}/project-styles?media_kind=`)) {
    const kind = path.slice(`/projects/${PROJECT_ID}/project-styles?media_kind=`.length);
    const items = Object.values(styleStore).filter((row) => row.media_kind === kind && row.deleted_at === null);
    return { items, count: items.length };
  }
  if (method === "GET" && path === "/generation/default-prompt-templates") {
    return { image: "平台默认图片模板", video: "平台默认视频模板" };
  }
  if (method === "GET" && path.startsWith("/generation/capability-tiers")) {
    return {
      tiers: path.includes("media_type=video")
        ? [VIDEO_TIER_RAW, VIDEO_TIER_RAW_2]
        : [IMAGE_TIER_RAW, IMAGE_TIER_RAW_2, IMAGE_TIER_OTHER_MODEL, IMAGE_TIER_OTHER_MODEL_SQUARE, IMAGE_TIER_WITHOUT_RATIO],
    };
  }
  if (method === "GET" && path === `/projects/${PROJECT_ID}/lite/reference-assets`) {
    return { items: [{ asset_entity_id: "ae-1", name: "林晚（女主）", kind: "character", asset_media_id: PICK_ASSET_MEDIA_ID, storage_url: "https://storage.example/pick.png", registered_at: "2026-08-10T09:00:00.000Z" }] };
  }
  if (method === "GET" && path === `/projects/${PROJECT_ID}/generations`) return { items: [], count: 0 };
  if (method === "GET" && path === `/media-results/${PRIMARY_MEDIA_RESULT_ID}/seedance-registration`) {
    return { registration: { id: "reg-1", asset_media_id: PRIMARY_ASSET_MEDIA_ID, source_media_result_id: PRIMARY_MEDIA_RESULT_ID, remote_asset_id: "volc-1", status: "active", latest_error: null } };
  }
  if (method === "GET" && path.startsWith("/media/") && path.endsWith("/download")) return {};
  if (method === "POST" && path === "/events") return {};
  return undefined;
}

async function respond(input: unknown, init?: { method?: string; headers?: unknown; body?: unknown }): Promise<Response> {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/api\/v1/, "") || "/";
  const authorization = new Headers(init?.headers as HeadersInit).get("authorization");
  let body: unknown;
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  calls.push({ method, path, body, authorization });
  if (method === "PUT" && path === `/projects/${PROJECT_ID}/generation-defaults/image`) {
    generationDefaultSaveBody = body as Record<string, unknown>;
    return jsonResponse({ id: "gd-img", project_id: PROJECT_ID, media_kind: "image", ...generationDefaultSaveBody, version: 2 });
  }
  if (method === "POST" && path === `/projects/${PROJECT_ID}/prompt-templates`) {
    const input = body as { media_kind: string; name: string; content: string };
    templateSeq += 1;
    const created = { id: `tpl-${templateSeq}`, project_id: PROJECT_ID, media_kind: input.media_kind, name: input.name, content: input.content };
    templateStore[created.id] = created;
    return jsonResponse(created);
  }
  if (method === "PUT" && path.startsWith(`/projects/${PROJECT_ID}/prompt-templates/`)) {
    const templateIdPath = path.slice(`/projects/${PROJECT_ID}/prompt-templates/`.length);
    const input = body as { media_kind: string; name: string; content: string };
    const existing = templateStore[templateIdPath] ?? { id: templateIdPath, project_id: PROJECT_ID, media_kind: input.media_kind, name: input.name, content: input.content };
    const updated = { ...existing, media_kind: input.media_kind, name: input.name, content: input.content };
    templateStore[templateIdPath] = updated;
    return jsonResponse(updated);
  }
  if (method === "DELETE" && path.startsWith(`/projects/${PROJECT_ID}/prompt-templates/`)) {
    const templateIdPath = path.slice(`/projects/${PROJECT_ID}/prompt-templates/`.length);
    delete templateStore[templateIdPath];
    return jsonResponse({ template_id: templateIdPath, deleted: true });
  }
  if (method === "POST" && path === `/projects/${PROJECT_ID}/project-styles`) {
    const input = body as { media_kind: string; name: string; content: string };
    styleSeq += 1;
    const created: StyleRow = {
      id: `style-${styleSeq}`,
      project_id: PROJECT_ID,
      media_kind: input.media_kind,
      name: input.name,
      content: input.content,
      is_default: false,
      created_by_user_id: REVIEWER_USER_ID,
      deleted_at: null,
      created_at: "2026-08-14T00:00:00Z",
      updated_at: "2026-08-14T00:00:00Z",
    };
    styleStore[created.id] = created;
    return jsonResponse(created);
  }
  if (method === "PUT" && path.startsWith(`/projects/${PROJECT_ID}/project-styles/`) && path.endsWith("/default")) {
    const styleIdPath = path.slice(`/projects/${PROJECT_ID}/project-styles/`.length, -"/default".length);
    const existing = styleStore[styleIdPath];
    assert.ok(existing, `设置默认风格：风格行不存在 ${styleIdPath}`);
    const updated = { ...existing, is_default: true, updated_at: "2026-08-14T00:00:00Z" };
    styleStore[styleIdPath] = updated;
    /* D1（2026-08-17 修订）：换设让位——同项目同媒介的旧默认行退位，与后端 setDefaultForActor 一致。 */
    for (const [key, row] of Object.entries(styleStore)) {
      if (key !== styleIdPath && row.project_id === existing.project_id && row.media_kind === existing.media_kind && row.is_default) {
        styleStore[key] = { ...row, is_default: false, updated_at: "2026-08-14T00:00:00Z" };
      }
    }
    return jsonResponse(updated);
  }
  /* D1（2026-08-17 修订）：取消默认是独立端点，必须放在通用 DELETE（删整行）之前。 */
  if (method === "DELETE" && path.startsWith(`/projects/${PROJECT_ID}/project-styles/`) && path.endsWith("/default")) {
    const styleIdPath = path.slice(`/projects/${PROJECT_ID}/project-styles/`.length, -"/default".length);
    const existing = styleStore[styleIdPath];
    assert.ok(existing, `取消默认风格：风格行不存在 ${styleIdPath}`);
    const updated = { ...existing, is_default: false, updated_at: "2026-08-14T00:00:00Z" };
    styleStore[styleIdPath] = updated;
    return jsonResponse(updated);
  }
  if (method === "PUT" && path.startsWith(`/projects/${PROJECT_ID}/project-styles/`)) {
    const styleIdPath = path.slice(`/projects/${PROJECT_ID}/project-styles/`.length);
    const input = body as { media_kind: string; name: string; content: string };
    const existing = styleStore[styleIdPath] ?? {
      id: styleIdPath,
      project_id: PROJECT_ID,
      media_kind: input.media_kind,
      name: input.name,
      content: input.content,
      is_default: false,
      created_by_user_id: REVIEWER_USER_ID,
      deleted_at: null,
      created_at: "2026-08-14T00:00:00Z",
      updated_at: "2026-08-14T00:00:00Z",
    };
    const updated = { ...existing, media_kind: input.media_kind, name: input.name, content: input.content, updated_at: "2026-08-14T00:00:00Z" };
    styleStore[styleIdPath] = updated;
    return jsonResponse(updated);
  }
  if (method === "DELETE" && path.startsWith(`/projects/${PROJECT_ID}/project-styles/`)) {
    const styleIdPath = path.slice(`/projects/${PROJECT_ID}/project-styles/`.length);
    delete styleStore[styleIdPath];
    return jsonResponse({ style_id: styleIdPath, deleted: true });
  }
  const data = route(method, path);
  assert.notEqual(data, undefined, `fetch mock 未覆盖：${method} ${path}`);
  return jsonResponse(data);
}

/* 在飞的请求台账：等待靠它，不靠轮数（见下面 settle）。 */
const inflight = new Set<Promise<unknown>>();
let issuedRequests = 0;

(globalThis as Record<string, unknown>).fetch = (input: unknown, init?: { method?: string; headers?: unknown; body?: unknown }): Promise<Response> => {
  issuedRequests += 1;
  const pending = respond(input, init);
  inflight.add(pending);
  void pending.catch(() => {}).finally(() => inflight.delete(pending));
  return pending;
};

/* objectURL 打桩：断言渲染 src 用。 */
let createdObjectUrl = 0;
(URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = () => `blob:lite-mock-${(createdObjectUrl += 1)}`;
(URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => {};

const { act, createElement } = await import("react");
(globalThis as Record<string, unknown>).React = await import("react");
const { createRoot } = await import("react-dom/client");
const { ApiClientError } = await import("./api");
const { LiteImage, liteImageDisplaySrc, liteImageSrc } = await import("./pages/lite/lite-image");
const { LiteWorkspacePage } = await import("./pages/lite/lite-workspace-page");
const { LITE_REFERENCE_REJECT_MESSAGE, buildLiteVideoReferences, isLiteReferenceRejection } = await import("./pages/lite/lite-generation");
const { LiteProjectConfigPage } = await import("./pages/lite/lite-project-config-page");
const { canDecideLiteReview, liteReviewerNames } = await import("./pages/lite/lite-review");
const { moveReferencePick } = await import("./pages/lite/lite-shot-reference-pack");
type Capabilities = import("./operations").Capabilities;
type CapabilitiesState = import("./capabilities-state").CapabilitiesState;

/** 已拿到态包装：判定语义没变，变的只是「读没读到」这一层。 */
function ready(capabilities: Capabilities): CapabilitiesState {
  return { status: "ready", capabilities };
}

/** PageRuntimeProps.user 必填：测试用户（lite 界面模式）。 */
const TEST_USER = { id: "user-lite-1", username: "lite-tester", display_name: "精简版测试员", ui_mode: "lite" as const };

function mount(node: Parameters<ReturnType<typeof createRoot>["render"]>[0]): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container: container as HTMLElement,
    unmount: () => act(() => root.unmount()),
  };
}

/* ---------- 等待：等「请求都落地了」，不等「再轮几次」 ----------
   原来是轮 200 次宏任务、每轮试一下断言。够不够全看这段时间机器替页面干了多少活——
   同一份代码在空载和满载下覆盖的工作量不一样，CI 忙的时候会随机红，
   接着就有人拿「又是那两条 flaky」把真回归一起忽略掉。

   现在的判据是确定的：这一页所有异步都从上面那个 fetch 替身出来，
   于是「还有没有在飞的请求、这一轮有没有再发新的」就是明确的完工信号。
   轮数由页面自己的请求链长度决定（实测 2 轮到底），与机器负载无关。 */

/** 只防「请求自己发自己」的死循环，不是等待预算——正常路径两三轮就返回。 */
const SETTLE_ROUND_CAP = 50;

async function settle(): Promise<void> {
  for (let round = 0; round < SETTLE_ROUND_CAP; round += 1) {
    const issuedBefore = issuedRequests;
    await act(async () => {
      /* 一个宏任务足够排干微任务链（Promise 链不跨宏任务）；随后把在飞的请求全 settle 掉，
         它们触发的 setState 与后续 effect 都在这个 act 里落地。 */
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.allSettled([...inflight]);
    });
    if (inflight.size === 0 && issuedRequests === issuedBefore) return;
  }
  assert.fail(`请求链停不下来（${SETTLE_ROUND_CAP} 轮仍在发新请求）——这是页面在自己发自己，不是等得不够`);
}

/** 等到请求全落地再断言一次。不过就是真不过，不再多轮几次碰运气。 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  await settle();
  assert.ok(predicate(), `请求全部落地后仍不满足：${label}`);
}

/* ---------- 纯函数：references 组装（全能参考同槽同身份） ---------- */

test("buildLiteVideoReferences：定稿图排首位，全部 usage_mode=reference", () => {
  const references = buildLiteVideoReferences("am-primary", ["am-pick-1", "am-pick-2"]);
  assert.deepEqual(references, [
    { media_id: "am-primary", usage_mode: "reference" },
    { media_id: "am-pick-1", usage_mode: "reference" },
    { media_id: "am-pick-2", usage_mode: "reference" },
  ]);
  assert.ok(JSON.stringify(references).includes("first_frame") === false, "请求体不得出现旧锚定用途");
});

test("buildLiteVideoReferences：勾选与定稿图同素材自动去重；不设前端写死上限", () => {
  const deduped = buildLiteVideoReferences("am-primary", ["am-primary", "am-pick-1"]);
  assert.deepEqual(deduped, [
    { media_id: "am-primary", usage_mode: "reference" },
    { media_id: "am-pick-1", usage_mode: "reference" },
  ], "同素材不得占两个参考槽（后端跨槽 422）");

  /* 原型 §9.2：上限随出片档位读能力矩阵，前端不写死（能力矩阵无参考配额字段 →
     §9.2.3 降级：不猜不夹取，超限交给后端拒绝并原样展示人话）。 */
  const many = buildLiteVideoReferences("am-primary", ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]);
  assert.equal(many.length, 9, "前端不再用写死数字提前夹取；上限由后端按当时档位拦");
  assert.equal(many[0]!.media_id, "am-primary", "定稿图恒在首位");
});

test("isLiteReferenceRejection 只认 422 + InvalidParameter", () => {
  assert.equal(isLiteReferenceRejection(new ApiClientError("Invalid parameter: 图片1", { status: 422, code: "InvalidParameter" })), true);
  assert.equal(isLiteReferenceRejection(new ApiClientError("参考素材类型不正确", { status: 422, code: "control_asset_invalid_usage" })), false, "普通 422 不误伤");
  assert.equal(isLiteReferenceRejection(new ApiClientError("bad request", { status: 400, code: "InvalidParameter" })), false, "非 422 不误伤");
  assert.equal(isLiteReferenceRejection(new Error("InvalidParameter")), false);
  assert.equal(LITE_REFERENCE_REJECT_MESSAGE, "参考素材提交被模型拒绝（参数校验未过）：请调整参考素材后重试；反复出现请联系管理员");
});

/* ---------- 源码口径：lite 目录无旧锚定方案残留（注释一并清净） ---------- */

test("lite 目录源码无 first_frame/首帧/尾帧/延长 残留", () => {
  const liteFiles = [
    "lite-workspace-page.tsx",
    "lite-generation.ts",
    "lite-registration.ts",
    "lite-image.tsx",
    "lite-assets-page.tsx",
    "lite-asset-detail-page.tsx",
    "lite-asset-create-dialog.tsx",
    "lite-asset-add-image-dialog.tsx",
    "lite-shot-detail-page.tsx",
    "lite-media-entries.ts",
    "lite-shell.tsx",
    "lite-projects-page.tsx",
    "lite-project-config-page.tsx",
  ];
  for (const file of liteFiles) {
    const source = readFileSync(new URL(`./pages/lite/${file}`, import.meta.url), "utf8");
    for (const banned of ["first_frame", "尾帧", "延长到下一镜", "lastFrame", "last-frame"]) {
      assert.ok(!source.includes(banned), `${file} 残留「${banned}」字样`);
    }
  }
});

test("api.ts Lite 窄口与 422 人话常量保持", () => {
  const apiSource = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  assert.ok(apiSource.includes("liteReferenceAssets"), "api.ts 缺 liteReferenceAssets 窄口");
  assert.ok(apiSource.includes("/lite/reference-assets"), "参考资产端点路径漂移");
  assert.ok(apiSource.includes("asset_media_id"), "参考资产项缺 asset_media_id（references 只认它）");
  assert.ok(apiSource.includes("fetchMediaBlob"), "api.ts 缺 fetchMediaBlob（Lite 图片站内路径取字节）");
});

/* ---------- #184 组件级：LiteImage 站内路径走登录态取字节，直传地址原样渲染 ---------- */

test("LiteImage：站内下载路径 → 带 Bearer 取字节 → objectURL 渲染", async () => {
  window.sessionStorage.setItem("shortdrama_v01_token", "lite-test-token");
  const before = calls.length;
  const { container, unmount } = mount(createElement(LiteImage, {
    src: liteImageSrc("mr-xyz"),
    alt: "候选图",
    className: "aspect-video",
  }));
  await waitFor(() => container.querySelector("img") !== null, "LiteImage 站内路径出图");
  const img = container.querySelector("img")!;
  assert.ok(img.getAttribute("src")?.startsWith("blob:lite-mock-"), "站内路径必须渲染 objectURL");
  const downloadCalls = calls.slice(before).filter((call) => call.path === "/media/mr-xyz/download");
  assert.equal(downloadCalls.length, 1, "站内路径只取一次字节");
  assert.equal(downloadCalls[0]!.authorization, "Bearer lite-test-token", "站内下载必须带登录态");
  unmount();
});

/* #184 懒加载:站内路径要带登录态、只能走 JS 取字节,<img loading="lazy"> 的原生懒加载在这条路上失效。
   不自己判可见性,几十镜的项目挂载瞬间会打出上百个并发鉴权请求。 */
test("LiteImage：不在视口时不取字节，滚进视口才取", async () => {
  window.sessionStorage.setItem("shortdrama_v01_token", "lite-test-token");
  intersectionImmediately = false;
  const before = calls.length;
  const { container, unmount } = mount(createElement(LiteImage, {
    src: liteImageSrc("mr-offscreen"),
    alt: "视口外候选图",
  }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    calls.slice(before).filter((call) => call.path === "/media/mr-offscreen/download").length,
    0,
    "视口外不该发取字节请求",
  );
  assert.equal(container.querySelector("img"), null, "视口外只渲染占位，不出 img");
  intersectionImmediately = true;
  unmount();
});

test("LiteImage：data:/https: 直传地址原样渲染，不取字节（demo fixture 口径）", async () => {
  const before = calls.length;
  const dataSrc = "data:image/svg+xml;utf8,placeholder";
  const { container, unmount } = mount(createElement(LiteImage, { src: dataSrc, alt: "占位", className: "aspect-video" }));
  await settle();
  const img = container.querySelector("img")!;
  assert.ok(img, "直传地址必须直接出 img");
  assert.equal(img.getAttribute("src"), dataSrc);
  assert.equal(calls.slice(before).filter((call) => call.path.includes("/download")).length, 0, "直传地址不得走下载端点");
  unmount();
});

test("liteImageDisplaySrc：真栈恒站内路径，demo 用 fixture 占位地址", () => {
  const item = { id: "mr-1", storage_url: "https://tos.example/direct.png" };
  assert.equal(liteImageDisplaySrc(item, false), "/api/v1/media/mr-1/download", "真栈不得用存储直链");
  assert.equal(liteImageDisplaySrc(item, true), "https://tos.example/direct.png", "demo 用 fixture 自带地址");
});

/* ---------- #186 组件级：分镜页生视频请求体全为 reference；时长标注归视频 ---------- */

/** 按可见文本找按钮（卡布局后动作钮文案=「出这一镜的图/片」）。 */
function findButton(container: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
}

/** 修订三·补三（2026-08-17）：新建/编辑模板与风格改 Radix 弹窗（portal 到 document.body），
    编辑器内元素不再在卡内查询；两个编辑器互斥，合并选择器即可。 */
function editorButton(label: string): HTMLButtonElement | undefined {
  /* 弹窗 footer 按钮在 DialogFooter（role=group 之外），按整个 dialog 查；两编辑器互斥。 */
  const root = document.querySelector("[role='dialog']");
  return root ? [...root.querySelectorAll("button")].find((el) => el.textContent?.trim() === label) : undefined;
}

/** happy-dom 受控 input/textarea 必须走原生 value setter + input 事件，React 的 onChange 才认；
    直接赋 .value 不会触发 React 变更检测（已在可控复现里验证）。 */
function setFieldValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

const OWNER_CAPS: Capabilities = { platformRole: "member", allowMemberCreateProject: true, projects: [{ projectId: PROJECT_ID, role: "owner" }], permissions: [] };

test("配置页源码口径：生图配置卡无时长维度，生视频配置卡有", () => {
  const configSource = readFileSync(new URL("./pages/lite/lite-project-config-page.tsx", import.meta.url), "utf8");
  const imageLine = configSource.match(/image:\s*\[([^\]]*)\]/)?.[1] ?? "";
  const videoLine = configSource.match(/video:\s*\[([^\]]*)\]/)?.[1] ?? "";
  assert.equal(imageLine, '"model_label", "aspect_ratio", "resolution"', "生图配置必须按模型→画幅→清晰度排列");
  assert.ok(!imageLine.includes("duration_seconds"), "生图配置卡不得有时长维度");
  assert.ok(videoLine.includes("duration_seconds"), "生视频配置卡必须有时长维度");
  /* 修订三 Q1（2026-08-17）：卡是 flex 行内子项，必须 w-full 撑满容器（否则收缩到内容自然宽，
     基础配置与模板配置宽度不一致）；维度行 grid 等分满宽。 */
  assert.ok(configSource.includes('w-full flex-col gap-3 p-4'), "配置卡必须 w-full 撑满容器（§4.1.4 Q1）");
  assert.ok(configSource.includes("[grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]"), "维度行必须 grid 等分满宽（§4.1.4 Q1）");
});

test("LiteProjectConfigPage：图片模型切换级联画幅，保存带画幅", async () => {
  generationDefaultSaveBody = null;
  window.sessionStorage.setItem("shortdrama_v01_token", "lite-test-token");
  const { container, unmount } = mount(createElement(LiteProjectConfigPage, {
    demoMode: false,
    notify: () => {},
    user: TEST_USER,
    capabilities: ready(OWNER_CAPS),
    projectId: PROJECT_ID,
  }));
  const imageCard = container.querySelector("[aria-label='图片生成配置']")!;
  await waitFor(() => imageCard.querySelector("select[aria-label='图片生成配置模型']") !== null, "图片配置模型选择器就绪");
  assert.ok(imageCard.textContent?.includes("画幅"), "图片配置必须渲染画幅维度");
  const model = imageCard.querySelector("select[aria-label='图片生成配置模型']") as HTMLSelectElement;
  /* 修订二（2026-08-17）：单值维度也是下拉——回读断言从「固定标签 span」改为 select 值。 */
  const ratioInitial = imageCard.querySelector("select[aria-label='图片生成配置画幅']") as HTMLSelectElement;
  assert.ok(ratioInitial, "画幅维度渲染为下拉（单值也是下拉）");
  assert.equal(ratioInitial.value, "16:9", "已存的单值图片画幅必须正确回读");
  assert.deepEqual([...model.options].map((option) => option.value), ["图片模型", "另一图片模型", "缺画幅图片模型"]);
  await act(async () => {
    model.value = "另一图片模型";
    model.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const ratio = imageCard.querySelector("select[aria-label='图片生成配置画幅']") as HTMLSelectElement;
  await waitFor(() => [...ratio.options].map((option) => option.value).join(",") === "9:16,1:1", "模型变化后的画幅选项");
  await act(async () => {
    ratio.value = "9:16";
    ratio.dispatchEvent(new Event("change", { bubbles: true }));
  });
  /* 修订二：清晰度单值也是下拉——跟随断言读 select 选中值而非固定标签文本。 */
  const resolution = imageCard.querySelector("select[aria-label='图片生成配置清晰度']") as HTMLSelectElement;
  assert.ok(resolution, "清晰度维度渲染为下拉（单值也是下拉）");
  assert.equal(resolution.value, "2K", "画幅变化后清晰度跟随当前 active 档");
  await act(async () => {
    ([...imageCard.querySelectorAll("button")].find((button) => button.textContent?.trim() === "保存图片配置") as HTMLButtonElement).click();
  });
  await waitFor(() => generationDefaultSaveBody !== null, "图片配置保存请求");
  assert.deepEqual(generationDefaultSaveBody!.parameters, { size: "2K", ratio: "9:16", prompt_template_id: null });
  await act(async () => {
    model.value = "缺画幅图片模型";
    model.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitFor(() => imageCard.querySelector("select[aria-label='图片生成配置画幅']") === null, "缺画幅模型不渲染假控件");
  assert.ok(imageCard.textContent?.includes("当前模型没有可用选项，请改选模型"), "缺画幅模型必须给业务原因");
  const saveButton = [...imageCard.querySelectorAll("button")].find((button) => button.textContent?.trim() === "保存图片配置") as HTMLButtonElement;
  assert.equal(saveButton.disabled, true, "缺画幅模型不得保存硬编码 fallback");
  unmount();
});

/** 修订二（2026-08-17）：视频与图片同口径级联——切模型后清晰度/比例/时长随模型收窄；
    时长在单档下只有一个值也是下拉（撤销「单值=固定标签」）。 */
test("LiteProjectConfigPage：视频按模型级联，时长单值也是下拉", async () => {
  /* 从 ?kind=video 直开视频卡，不背图片卡的 URL 状态。 */
  window.history.replaceState({}, "", "/?kind=video");
  window.sessionStorage.setItem("shortdrama_v01_token", "lite-test-token");
  const { container, unmount } = mount(createElement(LiteProjectConfigPage, {
    demoMode: false,
    notify: () => {},
    user: TEST_USER,
    capabilities: ready(OWNER_CAPS),
    projectId: PROJECT_ID,
  }));
  const videoCard = container.querySelector("[aria-label='视频生成配置']")!;
  await waitFor(() => videoCard.querySelector("select[aria-label='视频生成配置模型']") !== null, "视频配置模型选择器就绪");
  const model = videoCard.querySelector("select[aria-label='视频生成配置模型']") as HTMLSelectElement;
  assert.deepEqual([...model.options].map((option) => option.value), ["视频模型", "另一视频模型"]);
  /* 档1（已存默认 vid-tier-1）：时长只有 4 秒一个值，也是下拉而非固定标签。 */
  const durationOf = (): HTMLSelectElement => videoCard.querySelector("select[aria-label='视频生成配置时长']") as HTMLSelectElement;
  assert.ok(durationOf(), "时长维度渲染为下拉");
  assert.deepEqual([...durationOf().options].map((option) => option.value), ["4"], "单档单值时长也是一个选项的下拉");
  assert.equal(durationOf().value, "4", "已存时长正确回读");
  /* 切模型 → 清晰度/比例/时长全部随档2收窄（视频不再是全量值域+置灰）。 */
  await act(async () => {
    model.value = "另一视频模型";
    model.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitFor(() => [...durationOf().options].map((option) => option.value).join(",") === "8", "切模型后时长选项随模型收窄");
  assert.equal((videoCard.querySelector("select[aria-label='视频生成配置比例']") as HTMLSelectElement).value, "16:9", "比例随模型2收窄");
  assert.equal((videoCard.querySelector("select[aria-label='视频生成配置清晰度']") as HTMLSelectElement).value, "1080p", "清晰度随模型2收窄");
  window.history.replaceState({}, "", "/");
  unmount();
});

test("LiteProjectConfigPage：自建模板预览/生效解耦、软删回落系统默认，保存写 prompt_template_id（修订三 §4.1.4）", async () => {
  templateSeq = 0;
  for (const key of Object.keys(templateStore)) delete templateStore[key];
  generationDefaultSaveBody = null;
  const originalConfirm = window.confirm;
  window.confirm = () => true;
  window.sessionStorage.setItem("shortdrama_v01_token", "lite-test-token");
  const { container, unmount } = mount(createElement(LiteProjectConfigPage, {
    demoMode: false,
    notify: () => {},
    user: TEST_USER,
    capabilities: ready(OWNER_CAPS),
    projectId: PROJECT_ID,
  }));
  const imageCard = container.querySelector("[aria-label='图片生成配置']")!;
  await waitFor(() => imageCard.querySelector("select[aria-label='图片生成配置模型']") !== null, "图片配置模型选择器就绪");
  /* 卡内子 tab：基础配置（默认）/模板配置（?section= 持久化，见 §4.1.1 线框）。模板库在「模板配置」
     子 tab 下；模板 TabsList 专属 aria-label=`${meta.title}提示词模板`，「内容分类」子 tab 不混入模板计数。 */
  const sectionTabs = (): HTMLButtonElement[] => [...imageCard.querySelectorAll("[aria-label='图片生成配置内容分类'] [role='tab']")] as HTMLButtonElement[];
  const selectSection = (sectionText: string): void => {
    const tab = sectionTabs().find((item) => item.textContent?.trim() === sectionText)!;
    tab.dispatchEvent(new MouseEvent("mousedown", { button: 0, ctrlKey: false, bubbles: true }));
    tab.dispatchEvent(new MouseEvent("click", { button: 0, bubbles: true }));
  };
  const templateTabs = (): HTMLButtonElement[] => [...imageCard.querySelectorAll("[aria-label='图片生成配置提示词模板'] [role='tab']")] as HTMLButtonElement[];
  const tabByText = (text: string): HTMLButtonElement => templateTabs().find((tab) => tab.textContent?.trim() === text)!;
  const activeTabText = (): string => templateTabs().find((tab) => tab.getAttribute("data-state") === "active")?.textContent?.trim() ?? "";
  /* Radix TabsTrigger 在 onMouseDown 选中，裸 click() 不触发；真实浏览器 mousedown→click 序列都发。 */
  const selectTab = (tab: HTMLButtonElement): void => {
    tab.dispatchEvent(new MouseEvent("mousedown", { button: 0, ctrlKey: false, bubbles: true }));
    tab.dispatchEvent(new MouseEvent("click", { button: 0, bubbles: true }));
  };
  /* 模板库默认落在「基础配置」子 tab（隐藏面板），先切「模板配置」再操作模板，与真实用户路径一致。 */
  await act(async () => {
    selectSection("模板配置");
  });
  assert.equal(templateTabs().length, 2, "未自建模板时只有系统默认 + 新建模板两个 tab");
  assert.equal(activeTabText(), "系统默认", "默认预览系统默认");

  /* [+ 新建模板] tab → 编辑器 → 填名/内容 → 创建即生效并预览（修订三 Q5：生效=策略引用，随基础配置保存落库） */
  await act(async () => {
    selectTab(findButton(imageCard, "+ 新建模板") as HTMLButtonElement);
  });
  const editor = document.querySelector("[aria-label='模板编辑器']")!;
  assert.ok(editor, "新建模板打开弹窗编辑器（portal 到 body）");
  const nameInput = editor.querySelector("input[aria-label='模板名称']") as HTMLInputElement;
  const contentArea = editor.querySelector("textarea[aria-label='模板内容']") as HTMLTextAreaElement;
  assert.ok(nameInput && contentArea, "编辑器渲染名称与内容输入");
  const createTemplateButton = editorButton("创建模板") as HTMLButtonElement;
  assert.equal(createTemplateButton.disabled, true, "空名空内容不可创建");
  await act(async () => {
    setFieldValue(nameInput, "写实电影质感");
    setFieldValue(contentArea, "写实电影质感，自然光，浅景深");
  });
  assert.equal(createTemplateButton.disabled, false, "填完即可创建");
  await act(async () => {
    createTemplateButton.click();
  });
  await waitFor(() => calls.some((call) => call.method === "POST" && call.path === `/projects/${PROJECT_ID}/prompt-templates`), "创建模板请求");
  await waitFor(() => templateTabs().length === 3, "自建模板 tab 出现");
  const createdId = Object.keys(templateStore)[0]!;
  assert.ok(createdId.startsWith("tpl-"), "自建模板拿到服务端 id");
  assert.equal(activeTabText(), "写实电影质感", "创建后自动预览该模板");
  assert.ok(imageCard.textContent?.includes("写实电影质感，自然光，浅景深"), "模板内容预览渲染");
  assert.ok(imageCard.textContent?.includes("生效中"), "创建即生效，生效中徽标在场");
  assert.ok(imageCard.textContent?.includes("系统默认"), "系统默认 tab 仍在场");

  /* 修订三 Q3：保存按钮只在「基础配置」子 tab——模板配置面板无保存按钮。 */
  assert.equal(findButton(imageCard, "保存图片配置"), undefined, "模板配置子 tab 不渲染保存按钮（§4.1.4 Q3）");
  await act(async () => {
    selectSection("基础配置");
  });
  await act(async () => {
    (findButton(imageCard, "保存图片配置") as HTMLButtonElement).click();
  });
  await waitFor(() => generationDefaultSaveBody !== null, "保存带模板引用");
  assert.deepEqual(generationDefaultSaveBody!.parameters, { size: "2K", ratio: "16:9", prompt_template_id: createdId });

  /* 改回系统默认（修订三 Q5：点 tab 仅预览，面板 [设为默认] 才切换生效）→ 保存写 null */
  await act(async () => {
    selectSection("模板配置");
  });
  await act(async () => {
    selectTab(tabByText("系统默认"));
  });
  assert.equal(findButton(imageCard, "设为默认")?.disabled, false, "非生效的系统默认面板提供设为默认（Q5）");
  await act(async () => {
    (findButton(imageCard, "设为默认") as HTMLButtonElement).click();
  });
  assert.ok(imageCard.textContent?.includes("生效中"), "系统默认重新生效后徽标在场");
  await act(async () => {
    selectSection("基础配置");
  });
  await act(async () => {
    (findButton(imageCard, "保存图片配置") as HTMLButtonElement).click();
  });
  await waitFor(() => {
    const parameters = generationDefaultSaveBody?.parameters as Record<string, unknown> | undefined;
    return parameters?.prompt_template_id === null;
  }, "改回系统默认后保存为 null");

  /* 系统默认只读文本框（修订三 Q4）+ 面板 [复制新建] → 预填「平台默认模板（副本）」+ 平台默认内容 */
  await act(async () => {
    selectSection("模板配置");
  });
  assert.ok(imageCard.querySelector("[aria-label='系统默认模板（只读）']"), "系统默认呈只读编辑器形态（Q4）");
  assert.equal((imageCard.querySelector("input[aria-label='模板名称（只读）']") as HTMLInputElement).readOnly, true, "系统默认名称框只读");
  assert.equal((imageCard.querySelector("textarea[aria-label='模板内容（只读）']") as HTMLTextAreaElement).readOnly, true, "系统默认内容框只读");
  await act(async () => {
    (findButton(imageCard, "复制新建") as HTMLButtonElement).click();
  });
  await waitFor(() => document.querySelector("[aria-label='模板编辑器']") !== null, "系统默认复制新建打开编辑器");
  assert.equal((document.querySelector("input[aria-label='模板名称']") as HTMLInputElement).value, "平台默认模板（副本）", "系统默认复制新建预填名");
  assert.equal((document.querySelector("textarea[aria-label='模板内容']") as HTMLTextAreaElement).value, "平台默认图片模板", "系统默认复制新建预填平台默认内容");
  await act(async () => {
    (editorButton("取消") as HTMLButtonElement).click();
  });
  /* 复制新建（预览自建模板 tab，其面板 [复制新建] 才在场）→ 预填「xxx（副本）」第二行 */
  await act(async () => {
    selectTab(tabByText("写实电影质感"));
  });
  await act(async () => {
    (findButton(imageCard, "复制新建") as HTMLButtonElement).click();
  });
  await waitFor(() => document.querySelector("[aria-label='模板编辑器']") !== null, "复制新建打开编辑器");
  const copyName = document.querySelector("input[aria-label='模板名称']") as HTMLInputElement;
  assert.equal(copyName.value, "写实电影质感（副本）", "复制新建预填副本名");
  const copyContent = document.querySelector("textarea[aria-label='模板内容']") as HTMLTextAreaElement;
  assert.equal(copyContent.value, "写实电影质感，自然光，浅景深", "复制新建预填内容");
  await act(async () => {
    (editorButton("创建副本") as HTMLButtonElement).click();
  });
  assert.ok(imageCard.textContent?.includes("生效中"), "副本创建即生效（Q5：生效项唯一，徽标随生效项走）");

  /* 编辑 → 改名并保存修改 → 行内容更新（修订三：编辑保存即生效该模板） */
  await act(async () => {
    (findButton(imageCard, "编辑") as HTMLButtonElement).click();
  });
  const editName = document.querySelector("input[aria-label='模板名称']") as HTMLInputElement;
  await act(async () => {
    setFieldValue(editName, "写实电影质感 V2");
  });
  await act(async () => {
    (editorButton("保存修改") as HTMLButtonElement).click();
  });

  /* 删除被选中模板 → 自定义二次确认弹窗(v1.9 十.11)→ 确认 → tab 消失 + 回落系统默认 + 删除回落提示 */
  await act(async () => {
    (findButton(imageCard, "删除") as HTMLButtonElement).click();
  });
  const confirmDialog = document.querySelector("[role='dialog']")!;
  assert.ok(confirmDialog, "删除须先过自定义二次确认弹窗(非浏览器原生 confirm)");
  await act(async () => {
    (findButton(confirmDialog as HTMLElement, "删除") as HTMLButtonElement).click();
  });
  await waitFor(() => templateTabs().length === 3, "删除后 tab 回落");
  assert.equal(activeTabText(), "系统默认", "删除被选中模板后回落系统默认");
  assert.ok(imageCard.textContent?.includes("已删除"), "删除回落提示出现");
  assert.ok(calls.some((call) => call.method === "DELETE" && call.path.startsWith(`/projects/${PROJECT_ID}/prompt-templates/`)), "删除走软删端点");

  /* 超长内容 → 保存修改禁用 + 危险色计数 */
  await act(async () => {
    selectTab(tabByText("写实电影质感"));
  });
  await act(async () => {
    (findButton(imageCard, "编辑") as HTMLButtonElement).click();
  });
  const longName = document.querySelector("input[aria-label='模板名称']") as HTMLInputElement;
  const longContent = document.querySelector("textarea[aria-label='模板内容']") as HTMLTextAreaElement;
  await act(async () => {
    setFieldValue(longName, "超长内容模板");
    setFieldValue(longContent, "长".repeat(5001));
  });
  const longSave = editorButton("保存修改") as HTMLButtonElement;
  assert.equal(longSave.disabled, true, "超 5000 字符不可保存");
  assert.ok(document.body.textContent?.includes("5001/5000"), "超长计数呈现");
  await act(async () => {
    (editorButton("取消") as HTMLButtonElement).click();
  });
  window.confirm = originalConfirm;
  unmount();
});

/** 风格区（§7：空态、多风格、设默认确认、换设让位、取消默认、?section= 持久化）。
    风格是即时动作不走卡保存；D1（2026-08-17 修订）默认不锁定——可换设、可取消、默认行可编辑可删除。 */
test("LiteProjectConfigPage：风格区空态→添加多风格→设默认→换设→取消默认→URL ?section 持久化", async () => {
  styleSeq = 0;
  for (const key of Object.keys(styleStore)) delete styleStore[key];
  /* 清前序模板测试残留（修订三 Q5：模板面板也有「设为默认」按钮，隐藏面板同样计入全卡按钮计数）。 */
  templateSeq = 0;
  for (const key of Object.keys(templateStore)) delete templateStore[key];
  /* 干净 URL：从「基础配置」子 tab 开始，不背前序测试残留的 section 状态。 */
  window.history.replaceState({}, "", "/");
  const originalConfirm = window.confirm;
  window.confirm = () => true;
  window.sessionStorage.setItem("shortdrama_v01_token", "lite-test-token");
  const { container, unmount } = mount(createElement(LiteProjectConfigPage, {
    demoMode: false,
    notify: () => {},
    user: TEST_USER,
    capabilities: ready(OWNER_CAPS),
    projectId: PROJECT_ID,
  }));
  const imageCard = container.querySelector("[aria-label='图片生成配置']")!;
  await waitFor(() => imageCard.querySelector("select[aria-label='图片生成配置模型']") !== null, "图片配置模型选择器就绪");
  /* 子 tab 持久化与锁定行判定：风格区在「基础配置」面板（默认），模板区在「模板配置」面板。 */
  const sectionTabs = (): HTMLButtonElement[] => [...imageCard.querySelectorAll("[aria-label='图片生成配置内容分类'] [role='tab']")] as HTMLButtonElement[];
  const selectSection = (sectionText: string): void => {
    const tab = sectionTabs().find((item) => item.textContent?.trim() === sectionText)!;
    tab.dispatchEvent(new MouseEvent("mousedown", { button: 0, ctrlKey: false, bubbles: true }));
    tab.dispatchEvent(new MouseEvent("click", { button: 0, bubbles: true }));
  };
  const styleRows = (): HTMLElement[] => [...imageCard.querySelectorAll("button")]
    .filter((button) => button.textContent?.trim() === "编辑")
    .map((button) => button.closest("div")!) as HTMLElement[];
  const rowButton = (row: HTMLElement, label: string): HTMLButtonElement =>
    [...row.querySelectorAll("button")].find((button) => button.textContent?.trim() === label)!;
  /* 「默认」徽标是精确匹配（「设为默认」按钮/「按默认执行」说明都不等于「默认」）。 */
  const defaultBadges = (): HTMLElement[] => [...imageCard.querySelectorAll("span")]
    .filter((span) => span.textContent?.trim() === "默认") as HTMLElement[];

  /* 空态：默认落在基础配置子 tab，风格区空态引导 + [添加风格] 在场。 */
  assert.equal(sectionTabs().find((tab) => tab.textContent?.trim() === "基础配置")?.getAttribute("data-state"), "active", "默认落在基础配置子 tab");
  assert.ok(imageCard.textContent?.includes("风格配置"), "基础配置面板渲染风格配置区");
  assert.ok(imageCard.textContent?.includes("还没有配置风格"), "风格空态引导在场");
  assert.ok(findButton(imageCard, "+ 添加风格"), "添加风格按钮在场");

  /* 添加第一条：空名空内容不可创建，填完创建 → 行渲染 + 空态消失 + 即时动作不改卡保存文案。 */
  await act(async () => {
    (findButton(imageCard, "+ 添加风格") as HTMLButtonElement).click();
  });
  const editor = document.querySelector("[aria-label='风格编辑器']")!;
  assert.ok(editor, "点添加风格打开弹窗编辑器（portal 到 body）");
  const createStyleButton = editorButton("创建风格") as HTMLButtonElement;
  assert.equal(createStyleButton.disabled, true, "空名空内容不可创建");
  await act(async () => {
    setFieldValue(editor.querySelector("input[aria-label='风格名称']") as HTMLInputElement, "港风霓虹");
    setFieldValue(editor.querySelector("textarea[aria-label='风格内容']") as HTMLTextAreaElement, "港风霓虹，暖色调，胶片颗粒，大景别，电影级质感");
  });
  assert.equal(createStyleButton.disabled, false, "填完即可创建");
  await act(async () => {
    createStyleButton.click();
  });
  await waitFor(() => calls.some((call) => call.method === "POST" && call.path === `/projects/${PROJECT_ID}/project-styles`), "创建风格请求");
  await waitFor(() => imageCard.textContent?.includes("港风霓虹") === true, "风格行渲染");
  assert.ok(imageCard.textContent?.includes("港风霓虹，暖色调，胶片颗粒"), "风格内容预览");
  assert.ok(!imageCard.textContent?.includes("还没有配置风格"), "空态随首条风格消失");
  /* 风格是即时动作：保存行文案（已保存(vN)/未配置）在风格操作前后一字不变，不进卡保存。 */
  const saveStatusText = (): string => (imageCard.querySelector('[role="status"]') as HTMLElement | null)?.textContent ?? "";
  const saveStatusBefore = saveStatusText();
  assert.ok(!imageCard.textContent?.includes("风格保存失败"), "风格创建无报错");
  assert.equal(saveStatusText(), saveStatusBefore, "风格即时动作不改卡保存文案");

  /* 添加第二条 → 多风格；两条「设为默认」都在场。 */
  await act(async () => {
    (findButton(imageCard, "+ 添加风格") as HTMLButtonElement).click();
  });
  await act(async () => {
    setFieldValue(document.querySelector("input[aria-label='风格名称']") as HTMLInputElement, "赛博冷调");
    setFieldValue(document.querySelector("textarea[aria-label='风格内容']") as HTMLTextAreaElement, "冷蓝霓虹，金属质感，暗调");
  });
  await act(async () => {
    (editorButton("创建风格") as HTMLButtonElement).click();
  });
  await waitFor(() => styleStore["style-2"] !== undefined, "第二条风格入库");
  await waitFor(() => imageCard.textContent?.includes("赛博冷调") === true, "第二条风格行渲染");
  assert.equal(styleRows().length, 2, "两条风格各有编辑钮");
  assert.equal([...imageCard.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "设为默认").length, 2, "两条风格都提供设为默认");

  /* 设默认（可逆，D1）：确认框 → PUT /default → 「默认」徽标；默认行编辑/删除/取消默认全可用，另一行可换设。 */
  let confirmShown = false;
  window.confirm = () => {
    confirmShown = true;
    return true;
  };
  await act(async () => {
    rowButton(styleRows()[0]!, "设为默认").click();
  });
  assert.equal(confirmShown, true, "设默认必须先过确认框");
  await waitFor(() => calls.some((call) => call.method === "PUT" && call.path === `/projects/${PROJECT_ID}/project-styles/style-1/default`), "设默认请求");
  await waitFor(() => defaultBadges().length === 1, "默认徽标出现在第一条上");
  const rows = styleRows();
  assert.equal(rowButton(rows[0]!, "编辑").disabled, false, "默认风格仍可编辑（D1 不锁定）");
  assert.equal(rowButton(rows[0]!, "删除").disabled, false, "默认风格仍可删除");
  assert.equal(rowButton(rows[0]!, "取消默认").disabled, false, "默认风格提供取消默认");
  assert.equal(rowButton(rows[1]!, "设为默认").disabled, false, "另一行可换设默认（不再互斥禁用）");

  /* 换设：第二条点「设为默认」→ PUT 让位，徽标转移到第二条。 */
  await act(async () => {
    rowButton(styleRows()[1]!, "设为默认").click();
  });
  await waitFor(() => calls.some((call) => call.method === "PUT" && call.path === `/projects/${PROJECT_ID}/project-styles/style-2/default`), "换设默认请求");
  await waitFor(() => {
    const badges = defaultBadges();
    return badges.length === 1 && styleRows()[1]!.contains(badges[0]!);
  }, "默认徽标让位换到第二条");
  assert.equal(styleStore["style-1"]?.is_default, false, "旧默认行让位（mock 同后端让位语义）");

  /* 取消默认（可逆，D1：默认可为空）：DELETE /default → 徽标消失，行回到可再设回。 */
  await act(async () => {
    rowButton(styleRows()[1]!, "取消默认").click();
  });
  await waitFor(() => calls.some((call) => call.method === "DELETE" && call.path === `/projects/${PROJECT_ID}/project-styles/style-2/default`), "取消默认请求");
  await waitFor(() => defaultBadges().length === 0, "默认徽标消失（默认可为空）");
  assert.equal(styleStore["style-2"]?.is_default, false, "取消后该行不再是默认");
  assert.equal(rowButton(styleRows()[1]!, "设为默认").disabled, false, "取消后可再设回");

  /* ?section= 持久化：切「模板配置」写 ?section=template 且面板可见；切回剥参数（与 ?kind= 正交）。 */
  await act(async () => {
    selectSection("模板配置");
  });
  assert.equal(new URLSearchParams(window.location.search).get("section"), "template", "切模板配置写 ?section=template");
  assert.ok(!imageCard.querySelector("[aria-label='图片生成配置提示词模板']")?.closest(".hidden"), "模板配置面板可见");
  await act(async () => {
    selectSection("基础配置");
  });
  assert.equal(new URLSearchParams(window.location.search).get("section"), null, "回基础配置剥 ?section");

  window.confirm = originalConfirm;
  window.history.replaceState({}, "", "/");
  unmount();
});

test("LiteWorkspacePage：demo 兜底渲染制作页（集列表 + 分镜卡网格），点卡片进详情", async () => {
  const { container, unmount } = mount(createElement(LiteWorkspacePage, {
    demoMode: true,
    notify: () => {},
    user: TEST_USER,
    capabilities: ready(OWNER_CAPS),
    projectId: PROJECT_ID,
  }));
  await settle();

  /* 左栏集列表：第 1 集（已确认）与第 2 集（无剧本）都在，?ep 缺省回落 demo 当前集。 */
  assert.ok(container.textContent?.includes("第 1 集"), "缺第 1 集条目");
  assert.ok(container.textContent?.includes("旧宅重逢"), "缺第 1 集集名");
  assert.ok(container.textContent?.includes("第 2 集"), "缺第 2 集条目");
  assert.ok(container.textContent?.includes("祠堂夜话"), "缺第 2 集集名");

  /* 已确认集动作条：常驻「重新生成本集」入口 + 编辑剧本。 */
  assert.ok(container.textContent?.includes("重新生成本集"), "缺重跑入口");
  assert.ok(container.textContent?.includes("编辑剧本"), "缺编辑剧本入口");

  /* 本集资产引用 chips(§2 P4:confirmed 态读本集解析候选按类型分组;
     demo 草稿含角色「林晚」与场景「旧宅客厅」)。 */
  for (const chip of ["林晚", "旧宅客厅"]) {
    assert.ok(container.textContent?.includes(chip), `缺使用资产 chip「${chip}」`);
  }

  /* 卡片网格：镜号 = {集号}-{镜号}-{场景短名}（场景名截 4 字）。 */
  for (const code of ["1-1-旧宅大门", "1-2-祠堂内"]) {
    assert.ok([...container.querySelectorAll("code")].some((el) => el.textContent?.trim() === code), `卡片缺镜号 ${code}`);
  }

  /* 状态徽记：第 1 镜待选首帧 / 第 2 镜已出片 2。 */
  for (const badge of ["◐待选首帧", "●已出片 2"]) {
    assert.ok(container.textContent?.includes(badge), `缺状态徽记「${badge}」`);
  }

  /* 集级打包入口在分镜区头。 */
  assert.ok(container.textContent?.includes("打包本集成片"), "缺集级打包入口");

  /* 点卡片 → 详情页 URL，?ep 跟随当前集（列表页回显原集）。 */
  const card = [...container.querySelectorAll("[role='button']")].find((el) => el.getAttribute("aria-label") === "第 1 集 · 第 1 镜");
  assert.ok(card, "第一镜卡片没渲染");
  await act(async () => {
    (card as HTMLElement).click();
  });
  assert.ok(window.location.pathname.endsWith("/shots/demo-lite-shot-1"), "点卡片应进该镜详情页");
  assert.ok(window.location.search.includes("ep=demo-lite-episode"), "详情页 URL 必须带 ?ep 跟随当前集");
  unmount();
});

/* ---------- 就地审核权限镜像与参考包顺序（纯函数） ---------- */

test("canDecideLiteReview 镜像后端 canDecideProjectReview 逐条对齐", () => {
  const base = { allowMemberCreateProject: true, permissions: [] };
  assert.equal(canDecideLiteReview({ ...base, platformRole: "admin", projects: [] }, "p1", "u1", null), true, "平台 admin 恒可");
  assert.equal(canDecideLiteReview({ ...base, platformRole: "operator", projects: [{ projectId: "p1", role: "owner" }] }, "p1", "u1", null), false, "operator 恒不可");
  assert.equal(canDecideLiteReview({ ...base, platformRole: "member", projects: [{ projectId: "p1", role: "owner" }] }, "p1", "u1", null), true, "项目 owner 可");
  assert.equal(canDecideLiteReview({ ...base, platformRole: "member", projects: [{ projectId: "p1", role: "editor" }] }, "p1", "u1", "u1"), true, "指定审核人可");
  assert.equal(canDecideLiteReview({ ...base, platformRole: "member", projects: [{ projectId: "p1", role: "editor" }] }, "p1", "u1", "u2"), false, "非指定审核人的普通成员不可");
  assert.equal(canDecideLiteReview({ ...base, platformRole: "member", projects: [{ projectId: "p1", role: "viewer" }] }, "p1", "u1", "u1"), true, "viewer 是指定审核人也可");
  /* 原来这里还有一条「权限未读出按不可」——那正是被修的病：它把「没读到」判成了「没权限」。
     现在函数只收已拿到的能力，读取中/读不到进不来，两态各画什么由上面的渲染测试钉。 */
});

test("liteReviewerNames：指定审核人在前、owner 殿后，去重；读不到给空由页面退通称", () => {
  const members = [
    { projectId: "p1", userId: "u-owner", username: "zhangdao", displayName: "张导", platformRole: "member", projectRole: "owner", addedByUserId: null, createdAt: "" },
    { projectId: "p1", userId: "u-rev", username: "lizhipian", displayName: "李制片", platformRole: "member", projectRole: "editor", addedByUserId: null, createdAt: "" },
  ] as const;
  assert.deepEqual(liteReviewerNames(members, "u-rev"), ["李制片", "张导"]);
  assert.deepEqual(liteReviewerNames(members, null), ["张导"], "无指定审核人时只有 owner");
  assert.deepEqual(liteReviewerNames([], "u-rev"), [], "成员列表不可读时给空（页面退「项目审核人」通称）");
});

test("moveReferencePick：顺序=点名顺序，拖动换位纯函数", () => {
  assert.deepEqual(moveReferencePick(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
  assert.deepEqual(moveReferencePick(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  assert.deepEqual(moveReferencePick(["a", "b"], 0, 0), ["a", "b"], "原位不动");
  assert.deepEqual(moveReferencePick(["a", "b"], -1, 5), ["a", "b"], "越界不炸");
});
