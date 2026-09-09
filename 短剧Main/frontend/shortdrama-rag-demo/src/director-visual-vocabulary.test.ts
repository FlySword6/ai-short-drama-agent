/* ============================================================
   director-visual-vocabulary.test.ts — R19 导演视觉词表验收

   锁四件事：
   1. 三组各六条，id/名称/排序对齐原图逐格转写（docs/design/director-visual-vocabulary.md）；
   2. 抄录诚实：原图不可辨/矛盾的地方如实留痕（sourceNote），不擅自「修正」原图；
   3. 词表是数据不是分支：注入一条原词表里没有的新词条，读侧助手照样返回，零改码；
   4. 取数口兜底：fetcher 抛错回落内置，不炸 UI。
   ============================================================ */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  BUILTIN_DIRECTOR_VISUAL_VOCABULARY,
  cameraPresets,
  directorVisualDomains,
  directorVisualEntries,
  directorVisualEntry,
  injectDirectorVisualVocabularyForTest,
  loadDirectorVisualVocabulary,
  resetDirectorVisualVocabularyForTest,
  type DirectorVisualEntry,
} from "./director-visual-vocabulary";

afterEach(() => resetDirectorVisualVocabularyForTest());

/* ---------- 1. 三组各六条，对齐原图 ---------- */

describe("内置词表（=R19 三张图逐格转写）", () => {
  it("三组，组序=构图→景别→镜头语言", () => {
    assert.deepEqual(
      directorVisualDomains().map((domain) => [domain.id, domain.label]),
      [["composition", "构图"], ["shot_size", "景别"], ["camera_language", "镜头语言"]],
    );
  });

  it("构图六条，顺序与名称照抄原图", () => {
    assert.deepEqual(
      directorVisualEntries("composition").map((entry) => [entry.id, entry.displayName, entry.displayNameEn]),
      [
        ["rule_of_thirds", "三分法构图", "RULE OF THIRDS"],
        ["center", "中心构图", "CENTER COMPOSITION"],
        ["leading_lines", "引导线构图", "LEADING LINES"],
        ["frame_within_frame", "框架式构图", "FRAME WITHIN FRAME"],
        ["foreground_layer", "前景遮挡构图", "FOREGROUND LAYER"],
        ["negative_space", "留白构图", "NEGATIVE SPACE"],
      ],
    );
  });

  it("景别六条，大远景→大特写", () => {
    assert.deepEqual(
      directorVisualEntries("shot_size").map((entry) => entry.displayName),
      ["大远景", "全景", "中景", "近景", "特写", "大特写"],
    );
    const extremeCloseUp = directorVisualEntry("extreme_close_up")!;
    assert.deepEqual(extremeCloseUp.params, [
      "摄影距离：极端靠近。",
      "画面范围：单个细节。如：眼睛、戒指、剑锋、手指。",
    ], "params 是原话，服务端编译提示词用它");
    assert.equal(extremeCloseUp.diagramNote, "距离极近");
  });

  it("镜头语言六条，焦段与机位几何照抄原图正文列", () => {
    assert.deepEqual(
      directorVisualEntries("camera_language").map((entry) => [entry.displayName, entry.geometry?.focalLength]),
      [
        ["低机位仰拍", "24mm"],
        ["高机位俯拍", "35mm"],
        ["平视镜头", "50mm"],
        ["近景特写", "85mm"],
        ["远景镜头", "24mm"],
        ["环绕镜头", undefined],
      ],
    );
    assert.deepEqual(directorVisualEntry("low_angle")!.geometry, {
      focalLength: "24mm",
      height: "低于脚部（贴近地面）",
      angle: "向上 45 度仰拍",
    });
    assert.equal(directorVisualEntry("orbit")!.geometry!.movement, "围绕人物 360 度移动");
  });

  it("每组带 DIRECTOR NOTES 那句话——界面文案范本，不是装饰", () => {
    const notes = directorVisualDomains().map((domain) => domain.directorNote);
    assert.ok(notes[0]!.includes("构图不是摆放人物"));
    assert.ok(notes[2]!.includes("镜头不是记录画面"));
  });
});

/* ---------- 2. 抄录诚实：原图的矛盾如实留痕 ---------- */

describe("抄录诚实（原图自身的错不擅自修正）", () => {
  it("近景特写：正文 85mm 与示意图 50mm 的矛盾记在 sourceNote，几何以正文为准", () => {
    const entry = directorVisualEntry("close_up_shot")!;
    assert.equal(entry.geometry!.focalLength, "85mm", "以正文列为准");
    assert.equal(entry.diagramNote, "50mm", "示意图标注如实记录");
    assert.ok(entry.sourceNote?.includes("矛盾"), "矛盾必须留痕，不许悄悄抹平");
  });

  it("远景镜头：原图串行的那行机位说明不采信，但记在 sourceNote", () => {
    const entry = directorVisualEntry("long_shot")!;
    assert.equal(entry.geometry!.distance, "距离人物 15 米以上");
    assert.ok(!JSON.stringify(entry.geometry).includes("面部"), "串行内容不许进几何字段");
    assert.ok(entry.sourceNote?.includes("串行"), "串行如实留痕");
  });

  it("其余词条无需 sourceNote（只有原图有问题的才留）", () => {
    const flagged = BUILTIN_DIRECTOR_VISUAL_VOCABULARY.entries.filter((entry) => entry.sourceNote);
    assert.deepEqual(flagged.map((entry) => entry.id), ["close_up_shot", "long_shot"]);
  });
});

/* ---------- 3. 词表是数据不是分支 ---------- */

describe("词表开放性（R9：加词零改码）", () => {
  it("注入原词表里没有的新词条，读侧助手照样返回", () => {
    const fresh: DirectorVisualEntry = {
      id: "dutch_angle", domain: "composition", displayName: "斜角构图", displayNameEn: "DUTCH ANGLE",
      sort: 7, active: true, params: ["画面倾斜。"], effect: ["制造不安。"],
    };
    injectDirectorVisualVocabularyForTest({
      ...BUILTIN_DIRECTOR_VISUAL_VOCABULARY,
      entries: [...BUILTIN_DIRECTOR_VISUAL_VOCABULARY.entries, fresh],
    });
    assert.equal(directorVisualEntries("composition").length, 7);
    assert.equal(directorVisualEntry("dutch_angle")!.displayName, "斜角构图");
  });

  it("inactive 词条不上界面", () => {
    injectDirectorVisualVocabularyForTest({
      ...BUILTIN_DIRECTOR_VISUAL_VOCABULARY,
      entries: BUILTIN_DIRECTOR_VISUAL_VOCABULARY.entries.map((entry) =>
        entry.id === "center" ? { ...entry, active: false } : entry),
    });
    assert.ok(!directorVisualEntries("composition").some((entry) => entry.id === "center"));
    assert.equal(directorVisualEntry("center"), undefined);
  });

  it("未知 domain 返回空数组不抛；未知 id 返回 undefined 不抛", () => {
    assert.deepEqual(directorVisualEntries("lighting_setup"), []);
    assert.equal(directorVisualEntry("no_such_entry"), undefined);
  });
});

/* ---------- 4. 取数口兜底 + 3D 导演台预设 ---------- */

describe("取数口与机位预设", () => {
  it("fetcher 抛错回落内置，不炸 UI", async () => {
    const loaded = await loadDirectorVisualVocabulary({
      fetcher: async () => { throw new Error("网络挂了"); },
    });
    assert.equal(loaded.version, "builtin-r19");
    assert.equal(directorVisualEntries("composition").length, 6);
  });

  it("远程词表就位时以远程为准", async () => {
    const loaded = await loadDirectorVisualVocabulary({
      fetcher: async () => ({
        version: "api",
        domains: BUILTIN_DIRECTOR_VISUAL_VOCABULARY.domains,
        entries: BUILTIN_DIRECTOR_VISUAL_VOCABULARY.entries.slice(0, 2),
      }),
    });
    assert.equal(loaded.version, "api");
    assert.equal(directorVisualEntries("composition").length, 2);
  });

  it("cameraPresets：六条镜头语言里带几何的五条静止 + 一条环绕，全部可做 3D 导演台预设", () => {
    const presets = cameraPresets();
    assert.equal(presets.length, 6, "六条都带几何");
    assert.ok(presets.every((entry) => entry.geometry !== undefined));
    assert.deepEqual(presets.map((entry) => entry.id), [
      "low_angle", "high_angle", "eye_level", "close_up_shot", "long_shot", "orbit",
    ]);
  });
});
