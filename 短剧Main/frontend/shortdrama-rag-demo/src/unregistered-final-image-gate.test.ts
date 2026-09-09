/**
 * 守前端对「定稿图没入库」这道闸的接法。
 *
 * 起因(2026-08-08 实测对照,证据在 outputs/e2e-wolf-ep1-20260808/):同一分镜、同样
 * 提示词,只差有没有把定稿图注册进素材库——不注册,生出来的视频里一广场全是狼、
 * 三个主角一个没有;注册了人物全对上。后端(b7fffc54)已经把这条路从静默降级改成挡住。
 *
 * 挡住之后,前端要是只把错误码原样弹成一行红字,用户看到的还是「又报错了」,
 * 既不知道为什么被挡,也不知道该干什么——那这道闸等于白挡。这个文件钉住三件事:
 * ① 认得这个错误码,不落进通用报错;② 界面把后果和两条出路说清;
 * ③ 用户确认继续时,重提的请求真的带上知情标记(不然会被后端再挡一次,变成死循环)。
 *
 * 锚在段落工作台而不是镜级工作台:后者(pages/workbench-page.tsx)已从路由摘除、
 * 运行时不可达(文件头自述 bundle 树摇不进),接在那儿等于交一段死代码。
 * 真正在跑的视频提交是段落工作台的 submitRegen。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const segmentWorkbench = readSource("./pages/segment-workbench-page.tsx");
const apiClient = readSource("./api.ts");
const types = readSource("./types.ts");
const errorCopy = readSource("./error-copy.ts");

/** 后端错误码,前端靠它分辨「缺参考素材」而不是别的失败。 */
const errorCode = "shot_final_image_unregistered";

test("提交入参带得上知情标记,类型层不拦着", () => {
  assert.match(
    types,
    /unregistered_final_image_confirmed\?:\s*true/u,
    "GenerationSubmissionInput 缺知情标记字段,重提时带不上",
  );
});

test("认得这个错误码,不让它落进通用报错", () => {
  assert.ok(
    segmentWorkbench.includes(errorCode) || errorCopy.includes(errorCode),
    "没有一处认得这个错误码——用户只会看到一行看不懂的红字",
  );
});

test("界面把不入库的后果说清,并给出两条出路", () => {
  const at = segmentWorkbench.indexOf("unregistered-final-image-notice");
  assert.notEqual(at, -1, "没有专门的告知区(data-testid=unregistered-final-image-notice)");
  const notice = segmentWorkbench.slice(at, at + 2200);

  // 后果:说清人物可能跟定稿图不是同一个,不然用户不知道自己在放弃什么。
  assert.match(notice, /人物/u, "告知区没说清不入库会导致人物对不上");

  // 出路①:去把定稿图存进资产库。
  assert.match(notice, /资产库/u, "告知区没给「去存进资产库」这条出路");

  // 出路②:明确知情后继续——不剥夺选择权。
  assert.match(notice, /继续|仍要|照这样/u, "告知区没给「知道了,继续生成」这条出路");

  /* 告知区得真的被这个错误码点亮。只断言 JSX 长什么样抓不住「渲染在、但没人触发它」——
     捕获分支一旦被摘掉,界面永远停在通用红字,这段 JSX 就是死代码。 */
  assert.match(
    segmentWorkbench,
    /reason\.code === "shot_final_image_unregistered"[\s\S]{0,200}setFinalImageBlocked\(/u,
    "告知区没有接到这个错误码上——渲染得再全也不会出现",
  );
  // 「仍要继续」这个按钮必须真的置上知情状态,否则点了等于没点。
  assert.match(
    notice,
    /unregistered-final-image-proceed[\s\S]{0,400}setFinalImageConfirmed\(true\)/u,
    "「仍要继续」按钮没置上知情状态,点了照样过不去",
  );
});

test("确认继续时重提要带上知情标记,否则会被后端再挡一次", () => {
  assert.match(
    segmentWorkbench,
    /unregistered_final_image_confirmed:\s*true/u,
    "确认后重提没带知情标记——会被后端再挡一次,用户点了也过不去",
  );
});

test("默认不带知情标记:不能为了少挡一次就每次都替用户确认", () => {
  const marks = segmentWorkbench.match(/unregistered_final_image_confirmed:\s*true/gu) ?? [];
  assert.equal(
    marks.length,
    1,
    "知情标记出现多于一处——多半有一处是无条件带上的,那等于绕过闸门",
  );
  // 必须挂在状态判断上(用户确认过才带),不能是常量。
  assert.match(
    segmentWorkbench,
    /finalImageConfirmed\s*\?\s*\{\s*unregistered_final_image_confirmed:\s*true\s*\}/u,
    "知情标记不是按用户是否确认过条件带上的——默认关闭这条守不住",
  );
});

test("知情确认与费用复核各管一件事,不互相顶掉", () => {
  // 超阈值费用复核用 regenReview;人物一致性告知必须是独立状态,
  // 复用同一个会让「我知道人物可能不一致」顺手把费用确认也点掉。
  assert.ok(
    segmentWorkbench.includes("finalImageConfirmed"),
    "没有独立的知情状态——跟费用复核混用会互相顶掉",
  );
  assert.ok(
    segmentWorkbench.includes("regenReview"),
    "费用复核状态不见了,本测试的对照基准需同步更新",
  );
});

test("接口层把知情标记原样发给后端,不在 api 层丢掉", () => {
  // createGeneration / quoteGeneration 都用展开原入参,标记跟着走即可;
  // 这里守的是「别有人后来改成挑字段发」,那样标记会被静默吃掉。
  assert.match(
    apiClient,
    /body:\s*JSON\.stringify\(\{\s*\.\.\.input,\s*action:\s*"submit"/u,
    "估价接口不再原样展开入参,知情标记可能被丢掉",
  );
  assert.match(
    apiClient,
    /body:\s*JSON\.stringify\(\{\s*\.\.\.input,\s*generation_quote_id/u,
    "提交接口不再原样展开入参,知情标记可能被丢掉",
  );
});
