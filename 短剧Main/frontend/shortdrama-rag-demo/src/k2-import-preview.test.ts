/* ============================================================
   k2-import-preview.test.ts — K2N「导入剧本流程核对支点」验收断言(测试+代码成对提交)

   GP-06(步 4):导入预览渲染模板全十列(集数/场景/镜号/画面描述/运镜/
     景别·视角/台词/音效/参考图/分镜图),没识别出的单元格如实标「未识别」;
   GP-07(步 4):场景绑定结果的界面支点——场景列带试算徽标,表下给
     场景绑定核对清单(按名命中/候选/未命中/新集),候选绝不自动绑定,
     口径「导入后请手工核对绑定」在界面上可见。
   试算逻辑本身(trialSceneBindings)的行为断言在 storyboard.test.ts。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const projectPages = readSource("./pages/project-pages.tsx");

test("GP-06:预览表头覆盖模板十列(源行之外十列全在)", () => {
  for (const header of ["集数", "场景", "镜号", "画面描述", "运镜", "景别·视角", "台词", "音效", "参考图", "分镜图"]) {
    assert.ok(projectPages.includes(`<th className="`) && projectPages.includes(`>${header}</th>`), `预览表缺列:${header}`);
  }
});

test("GP-06:十列各自的数据字段都进单元格,缺失走「未识别」标注", () => {
  for (const field of ["episode_no", "scene_name", "shot_no", "screen_description", "camera_movement", "shot_size_angle", "dialogue", "sound_effect", "reference_image_note", "storyboard_image_note"]) {
    assert.ok(projectPages.includes(`row.${field}`), `预览表未取字段:${field}`);
  }
  assert.ok(projectPages.includes("未识别"), "缺「未识别」如实标注");
  assert.ok(projectPages.includes("function UnrecognizedCell"), "缺 UnrecognizedCell 标注件");
});

test("GP-07:场景列带绑定试算徽标,表下有场景绑定核对清单", () => {
  assert.ok(projectPages.includes("function SceneBindingBadge"), "缺 SceneBindingBadge");
  assert.ok(projectPages.includes("function SceneBindingChecklist"), "缺 SceneBindingChecklist");
  assert.ok(projectPages.includes("场景绑定核对"), "缺清单标题");
  assert.ok(projectPages.includes("trialSceneBindings(preview.preview.rows"), "页面未接试算逻辑");
});

test("GP-07:绝不自动绑定与手工核对口径在界面上可见", () => {
  assert.ok(projectPages.includes("绝不自动绑定"), "缺「绝不自动绑定」口径");
  assert.ok(projectPages.includes("导入后请手工核对绑定"), "缺发版口径「导入后请手工核对绑定」");
  assert.ok(projectPages.includes("不会自动绑定，请导入后核对"), "候选区缺不自动绑定说明");
});

test("GP-07:已有场景读取失败如实降级,不造假核对结果", () => {
  assert.ok(projectPages.includes("项目已有场景读取失败"), "缺读取失败降级文案");
  assert.ok(projectPages.includes('setSceneTrialState("failed")'), "缺 failed 态");
});

test("GP-06:导入规则写清十列去向,不再只说「识别集、场、镜号」", () => {
  assert.ok(projectPages.includes("按示例模板十列表头识别"), "导入规则未写十列去向");
  assert.ok(!projectPages.includes("识别集、场、镜号、剧本文本和提示词"), "旧文案仍在");
});
