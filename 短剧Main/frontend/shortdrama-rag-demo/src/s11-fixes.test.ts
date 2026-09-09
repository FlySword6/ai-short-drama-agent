/* ============================================================
   s11-fixes.test.ts — S11「说了但做不到」六件修复验收断言（测试+代码成对提交）

   1. 「导入为个人资产」路径对齐后端真合同（/assets/import-personal，body 带 asset_id）；
   2. 注册表单补「邀请码」字段 + 403 人话提示（后端强制校验邀请码）；
   3. 分镜场景名接真数据（api.episodeScenes），真无场景才「未分场」；
   4. /video 孤儿页下线（路由/入口/页文件全摘，零件=version-modal 纯函数已由真工作台复用）；
   5. 上传弹窗三口径：资产职责接 PATCH role 真链路；文件大小三处统一 10MB（后端真口径）；
   6. 「新建变体」「入库转通用」改不可用态+说明（端点未开，开了再点亮）。
   ============================================================ */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { api } from "./api";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const apiSource = readSource("./api.ts");
const projectPages = readSource("./pages/project-pages.tsx");
const appSource = readSource("./app.tsx");
const routing = readSource("./routing.ts");
const uploadModal = readSource("./components/asset-upload-modal.tsx");
const assetMedia = readSource("./asset-media.ts");

/* ---------- 轻量 fetch mock（捕获请求） ---------- */
interface CapturedRequest { url: string; init: RequestInit }
async function withMockFetch(
  responses: Array<{ body: unknown; status?: number }>,
  run: (requests: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  const storage = new Map<string, string>();
  const items: CapturedRequest[] = [];
  let call = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
  });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    items.push({ url: String(input), init });
    const next = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await run(items);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

const assetPayload = {
  id: "asset-1", source_id: "src-1", owner_user_id: "u1", scope: "personal", asset_kind: "character",
  name: "任天野", status: "approved", use_count: 0, created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
};

/* ---------- 1. 导入为个人资产：路径对齐 ---------- */

test("S11-1 运行时：importAssetToPersonal 打 /assets/import-personal 且 body 带 asset_id", async () => {
  await withMockFetch([{ body: { ok: true, data: assetPayload } }], async (requests) => {
    api.setToken("test-token");
    await api.importAssetToPersonal("asset-1");
    const call = requests.find((item) => item.url.includes("import-personal"));
    assert.ok(call, "未发出 import-personal 请求");
    assert.ok(call.url.endsWith("/assets/import-personal"), `路径仍是旧的 :id 形式：${call.url}`);
    assert.ok(!call.url.includes("/assets/asset-1/import-personal"), "旧的必 404 路径仍在");
    assert.deepEqual(JSON.parse(String(call.init.body)), { asset_id: "asset-1" });
  });
});

test("S11-1 源码级：旧路径与过期注释清场", () => {
  assert.ok(!apiSource.includes("import-personal`"), "旧模板串路径残留");
  assert.ok(!apiSource.includes("后端端点由 Sol 实现中"), "过期注释残留（端点已在册）");
});

/* ---------- 2. 注册（issue #26 改写：邮箱+验证码+邀请码必填注册） ----------
   口径史：S11-2 旧口径=邀请制强制校验；S57 曾放宽为无码可注册；issue #26 内部试点
   重新定死——自注册必须核销固定邀请码，缺码/错码 422 拒绝，邀请码在 wire 上始终携带。 */

test("S11-2 运行时：register 按 #26 合同发 email/verification_code/invitation_code；注册后以邮箱登录", async () => {
  const loginPayload = { data: { token: "t", expires_at: "2027-01-01T00:00:00Z", user: { id: "u", username: "kimi", display_name: "Kimi" } } };
  await withMockFetch([{ body: { data: { user: { id: "u" } } } }, { body: loginPayload }], async (requests) => {
    await api.register({ email: "kimi@example.test", password: "pw", verificationCode: "123456", displayName: "Kimi", invitationCode: "SD-INV-123" });
    const registerBody = JSON.parse(String(requests[0]!.init.body));
    assert.equal(registerBody.email, "kimi@example.test");
    assert.equal(registerBody.verification_code, "123456");
    assert.equal(registerBody.display_name, "Kimi");
    assert.equal(registerBody.invitation_code, "SD-INV-123");
    const loginCall = requests.find((item) => item.url.endsWith("/auth/login"));
    assert.ok(loginCall, "注册成功后未自动登录");
    assert.equal(JSON.parse(String(loginCall.init.body)).email, "kimi@example.test", "邮箱登录应走 email 键（#26 合同）");
  });
  await withMockFetch([{ body: { data: { user: { id: "u" } } } }, { body: loginPayload }], async (requests) => {
    await api.register({ email: "kimi@example.test", password: "pw", verificationCode: "123456", invitationCode: "COLTECH" });
    const registerBody = JSON.parse(String(requests[0]!.init.body));
    assert.equal(registerBody.invitation_code, "COLTECH", "邀请码必填，必须始终携带");
    assert.ok(!("display_name" in registerBody), "未填显示名不应带键");
  });
});

test("S11-2 运行时：requestEmailVerificationCode 打 /auth/email-verification-codes 且不透出验证码", async () => {
  await withMockFetch([{ body: { ok: true, data: { email: "kimi@example.test", expires_at: "2026-07-28T00:10:00Z", delivery: "dev_log" } }, status: 202 }], async (requests) => {
    const result = await api.requestEmailVerificationCode("kimi@example.test");
    assert.ok(requests[0]!.url.endsWith("/auth/email-verification-codes"));
    assert.equal(JSON.parse(String(requests[0]!.init.body)).email, "kimi@example.test");
    assert.equal(result.delivery, "dev_log");
    assert.ok(!("verification_code" in result), "HTTP 响应绝不返回验证码（合同 §2）");
  });
});

/* ---------- 3. 场景名接真 ---------- */

test("S11-3 源码级：episodeScenes 方法+工作台场景名接真，硬编码兜底退役", () => {
  assert.ok(apiSource.includes("async episodeScenes(episodeId: string)"), "api 缺 episodeScenes");
  assert.ok(apiSource.includes("/scenes`"), "episodeScenes 路径不对");
  assert.ok(projectPages.includes("api.episodeScenes(selectedEpisode.id)"), "生产页未拉场景真数据");
  assert.ok(projectPages.includes("sceneNameOf"), "缺 sceneNameOf 解析");
  assert.ok(projectPages.includes("sceneName={sceneNameOf(shot)}"), "ShotCard 未接场景名");
  assert.ok(projectPages.includes("shotDisplayName(selectedEpisode.episode_no, shot, sceneNameOf(shot))"), "批量抽屉未接场景名");
  assert.ok(!projectPages.includes("api 层暂无 scenes 查询"), "「暂无 scenes 查询」过期注释仍在");
  assert.ok(!projectPages.includes("shotDisplayName(episodeNo, shot, DEMO_SHOT_SCENES[shot.id])"), "分镜卡命名仍硬编码 demo 映射");
});

/* ---------- 4. /video 孤儿页下线 ---------- */

test("S11-4 源码级：/video 路由/入口/页文件全摘", () => {
  assert.ok(!appSource.includes("video-workbench-page"), "app.tsx 仍引用孤儿页");
  assert.ok(!appSource.includes("VideoWorkbenchPage"), "路由仍渲染孤儿页");
  assert.ok(!routing.includes("shotVideoWorkbenchPath"), "routing 仍有孤儿页路径函数");
  assert.ok(!existsSync(new URL("./pages/video-workbench-page.tsx", import.meta.url)), "页文件仍在");
});

/* ---------- 5. 上传弹窗三口径 ---------- */

test("S11-5 源码级：资产职责接 PATCH role 真链路", () => {
  /* 2026-08-07 Lite D1 加宽签名（追加可选 usage_mode，首帧登记标记走这里）；
     守卫口径同步钉两个字段，role 链路语义不变。 */
  assert.ok(apiSource.includes("async updateAsset(assetId: string, input: { role?: string | null;"), "api 缺 updateAsset(role)");
  assert.ok(apiSource.includes('usage_mode?: "reference" | "first_frame" | "last_frame" | null'), "api 缺 updateAsset(usage_mode)——Lite 首帧标记链路");
  assert.ok(projectPages.includes("await api.updateAsset(assetId, { role: input.role })"), "上传链路未 PATCH role");
  assert.ok(projectPages.includes('input.role !== (asset?.role ?? "")'), "未按「有变化才 PATCH」节制");
});

test("S11-5 运行时：文件大小三处统一 10MB（后端 ASSET_MEDIA_MAX_FILE_BYTES 真口径）", async () => {
  const { ASSET_UPLOAD_MAX_BYTES, assetUploadValidationError } = await import("./components/asset-upload-modal");
  const { MAX_ASSET_IMAGE_BYTES } = await import("./asset-media");
  assert.equal(ASSET_UPLOAD_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_ASSET_IMAGE_BYTES, 10 * 1024 * 1024);
  assert.equal(assetUploadValidationError({ name: "a.png", size: 11 * 1024 * 1024, type: "image/png" }), "图片不能超过 10 MB");
  assert.ok(!uploadModal.includes("超过 20 MB") && !uploadModal.includes("≤ 20MB"), "上传弹窗 20MB 拒收口径残留");
  assert.ok(!assetMedia.includes("超过 100 MB"), "通用校验 100MB 拒收口径残留");
});

/* ---------- 6. 断头入口处置（S17 更新：死按钮不如没有按钮） ---------- */

test("S11-6 源码级：「入库转通用」disabled+用户语言说明；「新建变体」S17 起入口隐藏", () => {
  assert.ok(projectPages.includes('title="转为团队通用资产即将上线"'), "「入库转通用」缺用户语言说明（S17 起禁开发词）");
  const titleIndex = projectPages.indexOf('title="转为团队通用资产即将上线"');
  assert.ok(projectPages.slice(titleIndex - 400, titleIndex).includes("disabled"), "「入库转通用」未置灰");
  /* S17-A4：变体写入端点未开——永远点不动的死按钮不如隐藏入口（R5），存量变体正常展示 */
  assert.ok(!projectPages.includes("新建变体暂未开放"), "「新建变体」死按钮残留");
  assert.ok(!projectPages.includes('setBlankModal("variant")'), "「新建变体」仍可点开空表单");
  assert.ok(projectPages.includes("变体写入端点未开"), "缺隐藏口径注释");
});
