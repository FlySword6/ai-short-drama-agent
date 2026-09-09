/* tk-legacy-archive-guard — R159/R160 ⑥b:legacy 体系已归档隔离,新页零依赖旧样式。
   判据:①新页(pages/* 新五页+landing/global)import/引用禁现 legacy-archived;
        ②index.html 首屏只引 tk 体系(tokens.css+ui-base.css),不引 legacy-archived;
        ③tk 体系文件齐备(tokens/tk-base/tk-login/ui-base)。 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const NEW_PAGES = [
  "segment-workbench-page.tsx",
  "script-breakdown-page.tsx",
  "project-assets-makeup.tsx",
  "prep-stage-page.tsx",
  "landing-page.tsx",
  "global-pages.tsx",
];

test("R160:新页零 legacy-archived 引用(归档隔离)", () => {
  for (const f of NEW_PAGES) {
    const src = read(`./pages/${f}`);
    assert.ok(!src.includes("legacy-archived"), `${f} 仍引用 legacy-archived`);
    assert.ok(!src.includes('from "../legacy'), `${f} 仍 import legacy`);
  }
});

test("R160:index.html 首屏只引 tk 体系,不引 legacy-archived", () => {
  const html = read("../index.html");
  assert.ok(!html.includes("legacy-archived"), "index.html 仍引 legacy-archived");
  assert.ok(!html.includes("/src/legacy.css"), "index.html 仍引 legacy.css");
  assert.ok(html.includes("/src/styles/tokens.css"), "index.html 缺 tokens.css");
  assert.ok(html.includes("/src/styles/ui-base.css"), "index.html 缺 ui-base.css");
});

test("R160:tk 体系文件齐备(tokens/tk-base/tk-login/ui-base)", () => {
  for (const f of ["tokens.css", "tk-base.css", "tk-login.css", "ui-base.css"]) {
    assert.ok(existsSync(new URL(`./styles/${f}`, import.meta.url)), `缺 styles/${f}`);
  }
});

test("R160:tokens.css 真值锚(Figma Foundations 直出值在案)", () => {
  const tokens = read("./styles/tokens.css");
  assert.ok(tokens.includes("--tk-bg: #141311"), "tk-bg 真值缺失");
  assert.ok(tokens.includes("--tk-accent: #3fe0c5"), "tk-accent 真值缺失");
  assert.ok(tokens.includes("--tk-radius-panel: 16px"), "tk-radius-panel 真值缺失");
});
