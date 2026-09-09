/* ============================================================
   w6-grid.test.ts — W6-2 宫格切分验收断言
   纯逻辑：宫格行列数学（每格像素坐标/尺寸，奇数尺寸余数分配）、
   宫格命名（R{行}C{列}）、自定义行列 clamp（1-6）、
   入库实体载荷、全存聚合文案（N 成功 M 失败如实报数）。
   组件文件不引 CSS（node:test 可 import）。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import {
  GRID_CUSTOM_MAX,
  GRID_CUSTOM_MIN,
  GRID_PRESET_OPTIONS,
  buildGridIngestItem,
  clampGridDimension,
  gridAssetBaseName,
  gridCellAssetName,
  gridCellLabel,
  gridCellRects,
  normalizeGridSpec,
  summarizeGridSave,
} from "./components/grid-split-modal";

/* ---------- 宫格行列数学 ---------- */

test("整除：900×600 按 3×3 均分为 300×200 九格，坐标无缝铺满", () => {
  const rects = gridCellRects(900, 600, { rows: 3, cols: 3 });
  assert.equal(rects.length, 9);
  for (const rect of rects) {
    assert.equal(rect.width, 300);
    assert.equal(rect.height, 200);
    assert.equal(rect.x, (rect.col - 1) * 300);
    assert.equal(rect.y, (rect.row - 1) * 200);
  }
  // 阅读顺序从左到右、从上到下
  assert.deepEqual(
    rects.map((rect) => gridCellLabel(rect.row, rect.col)),
    ["R1C1", "R1C2", "R1C3", "R2C1", "R2C2", "R2C3", "R3C1", "R3C2", "R3C3"],
  );
});

test("奇数尺寸余数分配：1000×701 按 3×3，余数逐 1px 分给前面的行/列", () => {
  const rects = gridCellRects(1000, 701, { rows: 3, cols: 3 });
  const widths = rects.filter((rect) => rect.row === 1).map((rect) => rect.width);
  const heights = rects.filter((rect) => rect.col === 1).map((rect) => rect.height);
  // 1000 = 334 + 333 + 333；701 = 234 + 234 + 233
  assert.deepEqual(widths, [334, 333, 333]);
  assert.deepEqual(heights, [234, 234, 233]);
  // 每行 x 连续累积、最后一格恰好到图宽；每列同理到图高（不丢像素不越界）
  for (let row = 1; row <= 3; row += 1) {
    const rowCells = rects.filter((rect) => rect.row === row);
    assert.equal(rowCells.reduce((sum, rect) => sum + rect.width, 0), 1000);
    rowCells.forEach((rect, index) => {
      assert.equal(rect.x, rowCells.slice(0, index).reduce((sum, cell) => sum + cell.width, 0));
    });
  }
  for (let col = 1; col <= 3; col += 1) {
    const colCells = rects.filter((rect) => rect.col === col);
    assert.equal(colCells.reduce((sum, rect) => sum + rect.height, 0), 701);
  }
});

test("不等分宫格与预置选项：2×2 四格 + 预置 2/3/4/5 规格", () => {
  const rects = gridCellRects(1920, 1080, { rows: 2, cols: 2 });
  assert.equal(rects.length, 4);
  assert.deepEqual(rects[0], { row: 1, col: 1, x: 0, y: 0, width: 960, height: 540 });
  assert.deepEqual(rects[3], { row: 2, col: 2, x: 960, y: 540, width: 960, height: 540 });
  assert.deepEqual(
    GRID_PRESET_OPTIONS.map((option) => [option.spec.rows, option.spec.cols]),
    [[2, 2], [3, 3], [4, 4], [5, 5]],
  );
});

/* ---------- 宫格命名 ---------- */

test("宫格命名：R{行}C{列}，资产名 `{素材标题} · 宫格 R{行}C{列}`", () => {
  assert.equal(gridCellLabel(3, 2), "R3C2");
  assert.equal(gridCellLabel(1, 1), "R1C1");
  assert.equal(gridCellAssetName("北疆战场", 3, 2), "北疆战场 · 宫格 R3C2");
  // 标题空/纯空白回落「素材图」
  assert.equal(gridCellAssetName("   ", 1, 2), "素材图 · 宫格 R1C2");
  assert.equal(gridCellAssetName("", 5, 5), "素材图 · 宫格 R5C5");
});

test("宫格基底名（S7-11）：自动「分镜 N」归一「素材 N」，实义标题沿用，空标题按镜号回落", () => {
  assert.equal(gridAssetBaseName({ title: "分镜 1", shot_no: "1" }), "素材 1");
  assert.equal(gridAssetBaseName({ title: "分镜12", shot_no: "12" }), "素材 12");
  // 实义标题不动
  assert.equal(gridAssetBaseName({ title: "北疆战场", shot_no: "7" }), "北疆战场");
  // 标题空/缺按镜号回落
  assert.equal(gridAssetBaseName({ title: "  ", shot_no: "4" }), "素材 4");
  assert.equal(gridAssetBaseName({ title: null, shot_no: "4" }), "素材 4");
  // 全空回落「素材图」
  assert.equal(gridAssetBaseName({ title: "", shot_no: "" }), "素材图");
  assert.equal(gridAssetBaseName(null), "素材图");
  // 组合出最终资产名
  assert.equal(
    gridCellAssetName(gridAssetBaseName({ title: "分镜 1", shot_no: "1" }), 3, 2),
    "素材 1 · 宫格 R3C2",
  );
});

/* ---------- 自定义行列 clamp（1-6） ---------- */

test("clamp：非有限数/小于 1 回落 1，大于 6 截断 6，小数取整", () => {
  assert.equal(clampGridDimension(0), GRID_CUSTOM_MIN);
  assert.equal(clampGridDimension(-3), GRID_CUSTOM_MIN);
  assert.equal(clampGridDimension(Number.NaN), GRID_CUSTOM_MIN);
  assert.equal(clampGridDimension(Number.POSITIVE_INFINITY), GRID_CUSTOM_MIN);
  assert.equal(clampGridDimension(7), GRID_CUSTOM_MAX);
  assert.equal(clampGridDimension(99), GRID_CUSTOM_MAX);
  assert.equal(clampGridDimension(3), 3);
  assert.equal(clampGridDimension(2.6), 3);
  assert.equal(GRID_CUSTOM_MIN, 1);
  assert.equal(GRID_CUSTOM_MAX, 6);
});

test("normalizeGridSpec：双向 clamp；gridCellRects 对越界规格同样安全", () => {
  assert.deepEqual(normalizeGridSpec(0, 9), { rows: 1, cols: 6 });
  assert.deepEqual(normalizeGridSpec(2.4, 3.6), { rows: 2, cols: 4 });
  // 越界规格进切分数学时也被 clamp，不产生 0 宽格
  const rects = gridCellRects(10, 10, { rows: 0, cols: 99 });
  assert.equal(rects.length, 6);
  assert.ok(rects.every((rect) => rect.width >= 1 && rect.height === 10));
});

/* ---------- 入库实体载荷 ---------- */

test("入库实体：kind=keyframe，metadata 标宫格来源与行列，shot_id 透传", () => {
  const item = buildGridIngestItem({
    name: "北疆战场 · 宫格 R3C2",
    sourceUrl: "https://example.com/grid.png",
    shotId: "shot-9",
    rows: 3,
    cols: 3,
    row: 3,
    col: 2,
  });
  assert.equal(item.asset_kind, "keyframe");
  assert.equal(item.name, "北疆战场 · 宫格 R3C2");
  assert.equal(item.source_file_url, "https://example.com/grid.png");
  assert.equal(item.metadata?.origin, "grid_split");
  assert.equal(item.metadata?.grid_rows, 3);
  assert.equal(item.metadata?.grid_cols, 3);
  assert.equal(item.metadata?.grid_row, 3);
  assert.equal(item.metadata?.grid_col, 2);
  assert.equal(item.metadata?.shot_id, "shot-9");
  // 无 shotId 时不带 shot_id 字段
  const orphan = buildGridIngestItem({ name: "n", sourceUrl: "u", rows: 2, cols: 2, row: 1, col: 1 });
  assert.equal(orphan.metadata?.shot_id, undefined);
});

/* ---------- 全存聚合文案 ---------- */

test("全存聚合：N 成功 M 失败如实报数", () => {
  assert.equal(summarizeGridSave({ total: 9, saved: 9, failed: 0 }), "已入库 9 格");
  assert.equal(summarizeGridSave({ total: 9, saved: 7, failed: 2 }), "已入库 7 格，2 格失败，可逐格重试");
  assert.equal(summarizeGridSave({ total: 4, saved: 0, failed: 4 }), "4 格入库失败，可逐格重试");
  assert.equal(summarizeGridSave({ total: 0, saved: 0, failed: 0 }), "");
});
