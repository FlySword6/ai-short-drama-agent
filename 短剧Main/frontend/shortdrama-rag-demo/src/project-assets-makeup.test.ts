/* P-07 定妆两件套就绪纯函数合同(批次二第 3 卡):
   分桶=metadata.view_angle 优先于 title 的约定关键词;只数 image;
   缺件顺序=先大头照后全身照;三视图只计数不进就绪。 */
import assert from "node:assert/strict";
import test from "node:test";
import { makeupReadiness } from "./pages/project-assets-makeup";
import type { MediaVersion } from "./types";

function version(partial: Partial<MediaVersion> & { id: string }): MediaVersion {
  return { media_kind: "image", ...partial } as MediaVersion;
}

test("makeupReadiness:特写+全身=2/2,三视图只计数不进就绪", () => {
  const result = makeupReadiness([
    version({ id: "v1", metadata: { view_angle: "特写" } }),
    version({ id: "v2", metadata: { view_angle: "骑马 · 全身" } }),
    version({ id: "v3", metadata: { view_angle: "三视图 · 正" } }),
    version({ id: "v4", metadata: { view_angle: "三视图 · 侧" } }),
  ]);
  assert.equal(result.ready, 2);
  assert.deepEqual(result.missing, []);
  assert.equal(result.turnaroundCount, 2);
});

test("makeupReadiness:只有特写=1/2 缺全身照(白发师父基准)", () => {
  const result = makeupReadiness([version({ id: "v1", metadata: { view_angle: "特写" } })]);
  assert.equal(result.ready, 1);
  assert.deepEqual(result.missing, ["全身照"]);
});

test("makeupReadiness:无命中=0/2 先缺大头照后缺全身照;非 image 不计", () => {
  const result = makeupReadiness([
    version({ id: "v1", title: "版本A" }),
    version({ id: "v2", media_kind: "video", metadata: { view_angle: "全身" } }),
  ]);
  assert.equal(result.ready, 0);
  assert.deepEqual(result.missing, ["大头照", "全身照"]);
});

test("makeupReadiness:view_angle 缺失时回落 title;肖像/肩部以上也算大头照", () => {
  const result = makeupReadiness([
    version({ id: "v1", title: "肖像照" }),
    version({ id: "v2", metadata: { view_angle: "肩部以上" } }),
    version({ id: "v3", title: "全身" }),
  ]);
  assert.equal(result.headshot, true);
  assert.equal(result.fullBody, true);
});
