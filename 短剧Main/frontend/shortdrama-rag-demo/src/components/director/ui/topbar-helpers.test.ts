/**
 * 3D 导演台 · TopBar 纯逻辑测试（S8：P1-8 模版分组 + P1-9 快捷键契约）
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRECTOR_SHORTCUTS,
  TEMPLATE_CATEGORY_LABELS,
  groupTemplatesByCategory,
} from "./topbar-helpers";

function tpl(id: string, category: string): { id: string; category: string } {
  return { id, category };
}

/* ---------- P1-8：groupTemplatesByCategory ---------- */

test("P1-8：六类目中文组名映射（对齐后端 TEMPLATE_CATEGORIES）", () => {
  assert.deepEqual(TEMPLATE_CATEGORY_LABELS, {
    dialogue: "对话",
    action: "打戏",
    confrontation: "对峙",
    emotion: "情绪",
    establishing: "开场",
    movement: "运动",
  });
});

test("P1-8：常用组置顶（对话→对峙→情绪→打戏→开场→运动），空组不占位", () => {
  const groups = groupTemplatesByCategory([
    tpl("m1", "movement"),
    tpl("d1", "dialogue"),
    tpl("e1", "emotion"),
    tpl("a1", "action"),
    tpl("c1", "confrontation"),
    tpl("s1", "establishing"),
    tpl("d2", "dialogue"),
  ]);
  assert.deepEqual(groups.map((group) => group.label), ["对话", "对峙", "情绪", "打戏", "开场", "运动"]);
  assert.deepEqual(groups[0]?.items.map((item) => item.id), ["d1", "d2"], "组内保持原顺序");
});

test("P1-8：未知类目归「其他」且永远殿后", () => {
  const groups = groupTemplatesByCategory([
    tpl("x1", "unknown_cat"),
    tpl("d1", "dialogue"),
    tpl("x2", "sci-fi"),
  ]);
  assert.deepEqual(groups.map((group) => group.label), ["对话", "其他"]);
  assert.deepEqual(groups[1]?.items.map((item) => item.id), ["x1", "x2"]);
});

test("P1-8：空清单返回空数组", () => {
  assert.deepEqual(groupTemplatesByCategory([]), []);
});

/* ---------- P1-9：DIRECTOR_SHORTCUTS（与 StageCanvas 热键契约逐字一致） ---------- */

test("P1-9：帮助浮层快捷键清单=契约九条，键位与动作逐字一致", () => {
  assert.deepEqual(
    DIRECTOR_SHORTCUTS.map((item) => `${item.keys} ${item.action}`),
    [
      "G 平移",
      "R 旋转",
      "S 缩放",
      "Ctrl+C 复制",
      "Ctrl+V 粘贴",
      "Ctrl+Z 撤销",
      "Delete 删除",
      "F 聚焦",
      "Esc 取消选中",
    ],
  );
});
