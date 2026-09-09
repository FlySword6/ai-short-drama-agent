import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { MediaVersion } from "./types";

const React = await import("react");
(globalThis as Record<string, unknown>).React = React;
const { createElement } = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { LiteShotImages } = await import("./pages/lite/lite-shot-images");

const workspaceSource = readFileSync(new URL("./pages/lite/lite-workspace-page.tsx", import.meta.url), "utf8");

const candidate = (overrides: Partial<MediaVersion> = {}): MediaVersion => ({
  id: "image-1",
  media_kind: "image",
  storage_url: "https://assets.test/image-1.png",
  review_status: "needs_review",
  is_primary: false,
  ...overrides,
} as MediaVersion);

test("候选图有终审权时给一个就地通过并选用动作", () => {
  const html = renderToStaticMarkup(createElement(LiteShotImages, {
    shotNo: "3",
    images: [candidate()],
    reviewGate: "allowed",
    reviewerHint: "项目负责人",
    busyId: null,
    onReloadCapabilities: () => undefined,
    onSelect: () => undefined,
  }));

  assert.match(html, /第 3 镜候选图/);
  assert.match(html, /通过并选用/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /点选为首帧/);
});

test("候选图无终审权时只说明等审核和审核人，不给无效动作", () => {
  const html = renderToStaticMarkup(createElement(LiteShotImages, {
    shotNo: "3",
    images: [candidate()],
    reviewGate: "denied",
    reviewerHint: "张制片",
    busyId: null,
    onReloadCapabilities: () => undefined,
    onSelect: () => undefined,
  }));

  assert.match(html, /等审核/);
  assert.match(html, /张制片能过这张/);
  assert.doesNotMatch(html, /通过并选用/);
});

test("审核权限读取中不提前显示可点动作", () => {
  const html = renderToStaticMarkup(createElement(LiteShotImages, {
    shotNo: "3",
    images: [candidate()],
    reviewGate: "loading",
    reviewerHint: "项目负责人",
    busyId: null,
    onReloadCapabilities: () => undefined,
    onSelect: () => undefined,
  }));

  assert.match(html, /正在确认审核权限/);
  assert.doesNotMatch(html, /通过并选用/);
});

test("审核拒绝的候选图说明不能选用，不提供必失败动作", () => {
  const html = renderToStaticMarkup(createElement(LiteShotImages, {
    shotNo: "3",
    images: [candidate({ review_status: "rejected" })],
    reviewGate: "allowed",
    reviewerHint: "项目负责人",
    busyId: null,
    onReloadCapabilities: () => undefined,
    onSelect: () => undefined,
  }));

  assert.match(html, /未通过审核，不能选用/);
  assert.doesNotMatch(html, /选用这张|通过并选用/);
});

test("当前首帧与空态都有明确可访问文案", () => {
  const selected = renderToStaticMarkup(createElement(LiteShotImages, {
    shotNo: "3",
    images: [candidate({ is_primary: true, review_status: "accepted" })],
    reviewGate: "allowed",
    reviewerHint: "项目负责人",
    busyId: null,
    onReloadCapabilities: () => undefined,
    onSelect: () => undefined,
  }));
  assert.match(selected, /aria-pressed="true"/);
  assert.match(selected, /当前首帧/);

  const empty = renderToStaticMarkup(createElement(LiteShotImages, {
    shotNo: "3",
    images: [],
    reviewGate: "allowed",
    reviewerHint: "项目负责人",
    busyId: null,
    onReloadCapabilities: () => undefined,
    onSelect: () => undefined,
  }));
  assert.match(empty, /还没有候选图/);
  assert.match(empty, /生成完成后会自动显示在这里，再挑一张定为首帧/);
});

test("制作页把图片候选接到媒体无关的审核并选用动作", () => {
  assert.match(workspaceSource, /<LiteShotImages/);
  assert.match(workspaceSource, /images=\{candidates\}/);
  assert.match(workspaceSource, /reviewGate=\{reviewGateImage\}/);
  assert.ok(workspaceSource.includes("approveAndSelect(shot, image)"));
  assert.match(workspaceSource, /候选图已生成，可直接在卡片上挑一张定为首帧/);
});
