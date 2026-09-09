import assert from "node:assert/strict";
import test from "node:test";
import {
  assetMediaIsNonImage,
  fetchReadableImage,
  isDisplayableImageUrl,
  isImageReferenceMedia,
  mediaFetchUrl,
} from "./asset-media";
import type { MediaVersion } from "./types";

/* S46 C-0：S52 导入的 3D 素模（.glb，Content-Type=model/gltf-binary）URL 被当图片
   塞进 <img> 导致资产中心全裂。判据复用 isImageReferenceMedia，非图片走类型图标。 */

test("非图片尾缀（glb/mp4 等）不得进 <img>，图片尾缀与无尾缀签名 URL 放行", () => {
  assert.equal(isDisplayableImageUrl("https://cdn.example.com/models/tree.glb"), false);
  assert.equal(isDisplayableImageUrl("https://cdn.example.com/models/tree.GLB?x-tos-signature=abc"), false);
  assert.equal(isDisplayableImageUrl("https://cdn.example.com/clip.mp4"), false);
  assert.equal(isDisplayableImageUrl("https://cdn.example.com/role.png"), true);
  assert.equal(isDisplayableImageUrl("https://cdn.example.com/role.webp?x-tos-signature=abc#frag"), true);
  // 无尾缀直链放行：历史图片资产多为这种形态，拦了就是「有图资产回归」
  assert.equal(isDisplayableImageUrl("https://drama-asset.tos-cn-beijing.volces.com/assets/9f8e7d6c"), true);
});

test("资产主媒体非图片（glb/model_3d）时判为不可作缩略图", () => {
  const glb: MediaVersion = { id: "m1", media_kind: "model_3d", format: "glb" };
  const image: MediaVersion = { id: "m2", media_kind: "image", format: "png" };
  assert.equal(assetMediaIsNonImage({ current_media: glb }), true);
  assert.equal(assetMediaIsNonImage({ current_media: image }), false);
  // selected_media 优先于 current_media
  assert.equal(assetMediaIsNonImage({ selected_media: glb, current_media: image }), true);
  assert.equal(assetMediaIsNonImage({ selected_media: image, current_media: glb }), false);
  // 媒体信息缺失放行（老数据无快照，维持原行为）
  assert.equal(assetMediaIsNonImage({}), false);
  assert.equal(assetMediaIsNonImage({ current_media: null }), false);
});

test("isImageReferenceMedia 现有判据不回退：glb 不可引用，无标注老数据视为图片", () => {
  assert.equal(isImageReferenceMedia({ id: "m1", format: "glb" }), false);
  assert.equal(isImageReferenceMedia({ id: "m2", media_kind: "model_3d" }), false);
  assert.equal(isImageReferenceMedia({ id: "m3", format: "jpg" }), true);
  assert.equal(isImageReferenceMedia({ id: "m4" }), true);
});

test("同源代理候选地址在所有构建模式保持一致", () => {
  assert.equal(
    mediaFetchUrl("https://drama-asset.tos-cn-beijing.volces.com/generated/角色图.png?version=2"),
    "/api/v1/media/tos-images?url=https%3A%2F%2Fdrama-asset.tos-cn-beijing.volces.com%2Fgenerated%2F%25E8%25A7%2592%25E8%2589%25B2%25E5%259B%25BE.png%3Fversion%3D2",
  );
  assert.equal(
    mediaFetchUrl("https://other.example.test/generated/role.png"),
    "/api/v1/media/tos-images?url=https%3A%2F%2Fother.example.test%2Fgenerated%2Frole.png",
  );
  assert.equal(mediaFetchUrl("/local/role.png"), "/local/role.png");
});

test("可直接读取的外部图片保留原链路，不会被误送给 TOS 代理", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    calls.push(String(input));
    return new Response("image", { status: 200, headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  try {
    const source = "https://other.example.test/generated/role.png";
    const response = await fetchReadableImage(source);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [source]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("浏览器直读失败后才回落到登录保护的同源代理", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const target = String(input);
    calls.push(target);
    if (calls.length === 1) throw new TypeError("blocked by browser policy");
    return new Response("image", { status: 200, headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  try {
    const source = "https://drama-asset.tos-cn-beijing.volces.com/generated/role.png";
    const response = await fetchReadableImage(source);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [source, mediaFetchUrl(source)]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
