/* ============================================================
   s46b-upload-card.test.ts — S46 B-3 入库等待期卡片 组件渲染断言
   walkthrough P1-3 第 7 条:入库 toast 裸露 UUID 文件名 + 「预计总耗时:暂无估计」。
   渲染真实组件(renderToStaticMarkup),不读源码字符串:
   ① 机器串文件名不裸露,显示「未命名图片+扩展名」;
   ② 服务端给不出 ETA 时不显示耗时行,兜底「已提交,等待入库」;
   ③ 有排位/有 ETA 时正常显示。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UploadTaskCard } from "./components/upload-task-card";
import type { AssetUploadTask } from "./types";

function task(partial: Partial<AssetUploadTask>): AssetUploadTask {
  return { id: "t-1", status: "queued", original_file_name: "角色.png", ...partial };
}

function render(taskInput: AssetUploadTask): string {
  return renderToStaticMarkup(React.createElement(UploadTaskCard, { task: taskInput }));
}

test("B-3⑦ 渲染:UUID 文件名不裸露,显示「未命名图片.png」", () => {
  const html = render(task({ original_file_name: "3fa85f64-5717-4562-b3fc-2c963f66afa6.png" }));
  assert.ok(!html.includes("3fa85f64"), "UUID 原文仍裸露");
  assert.ok(html.includes("未命名图片.png"), "缺友好文件名");
});

test("B-3⑦ 渲染:人类可读文件名原样显示", () => {
  const html = render(task({ original_file_name: "角色.png" }));
  assert.ok(html.includes("排队中：角色.png"));
});

test("B-3⑦ 渲染:服务端给不出 ETA 不显示耗时行,兜底「已提交,等待入库」", () => {
  const html = render(task({ status: "queued", queue_position: null, estimated_duration_seconds: null }));
  assert.ok(!html.includes("暂无估计"), "「暂无估计」状态自述残留");
  assert.ok(!html.includes("预计总耗时"), "无 ETA 仍显示耗时行");
  assert.ok(html.includes("已提交，等待入库"), "缺兜底文案");
});

test("B-3⑦ 渲染:有排位与 ETA 时正常显示,不显示兜底", () => {
  const html = render(task({ status: "queued", queue_position: 2, estimated_duration_seconds: 125 }));
  assert.ok(html.includes("排队第 2 位"));
  assert.ok(html.includes("预计总耗时约 2 分 5 秒"));
  assert.ok(!html.includes("已提交，等待入库"));
});
