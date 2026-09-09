/**
 * 守「存进资产库」这个动作的可见性。
 *
 * 起因(2026-08-08 实测对照):同一个分镜、同样提示词,只差有没有把定稿图注册进素材库——
 * 不注册,生出来的视频里一广场全是狼、三个主角一个没有;注册了,人物全对上。
 * 证据在 outputs/e2e-wolf-ep1-20260808/(两段视频 + 两张抽帧)。
 *
 * 也就是说这一步决定人物一致性,不是「以后别的镜头也能复用」这种锦上添花。
 * 但改之前它长得跟「看大图」同一档(无边框、最浅的灰字),文案也只说复用、
 * 完全没提不做会怎样——用户按那个界面读,不会知道这两件事有关。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const imagePanel = readSource("./pages/shot-image-results.tsx");

/** 从按钮的 data-testid 反查它那一段 JSX,用来比对样式类。 */
function buttonBlock(testIdPrefix: string): string {
  const marker = `data-testid={\`${testIdPrefix}`;
  const at = imagePanel.indexOf(marker);
  assert.notEqual(at, -1, `没找到 ${testIdPrefix} 按钮`);
  // 往前回溯到这个 button 的起始标签,往后到闭合,取整段。
  const start = imagePanel.lastIndexOf("<button", at);
  const end = imagePanel.indexOf("</button>", at);
  assert.ok(start !== -1 && end !== -1, `${testIdPrefix} 按钮 JSX 边界异常`);
  return imagePanel.slice(start, end);
}

test("存进资产库跟选用同档视觉权重——它决定人物一致性,不能长得像「看大图」", () => {
  const register = buttonBlock("register-asset-");
  const select = buttonBlock("select-final-");
  const viewLarge = imagePanel.slice(
    imagePanel.lastIndexOf("<button", imagePanel.indexOf("看大图")),
    imagePanel.indexOf("看大图"),
  );

  // 有边框:跟「选用这张」一致,是个正经动作而不是辅助链接。
  assert.match(register, /border border-tk-border-2/u,
    "存进资产库缺边框,视觉权重比选用低一档");
  assert.ok(select.includes("border border-tk-border-2"),
    "选用这张的边框类变了,本测试的对照基准需同步更新");

  // 字色不能停留在最浅那档(tk-ink-3 = 辅助信息色,「看大图」用的就是它)。
  assert.doesNotMatch(register, /text-tk-ink-3/u,
    "存进资产库还在用辅助信息色,跟「看大图」同档");
  assert.match(viewLarge, /text-tk-ink-3/u,
    "「看大图」的辅助色变了,本测试的对照基准需同步更新");
});

test("存进资产库的提示语要说清不做的后果,不能只说「以后能复用」", () => {
  const register = buttonBlock("register-asset-");
  const title = /title="([^"]*)"/u.exec(register)?.[1] ?? "";
  assert.notEqual(title, "", "存进资产库没有悬停提示语");

  // 判据:必须点明它和生视频人物一致性的因果,不是泛泛说复用。
  assert.match(title, /人物|一致/u,
    "提示语没提人物一致性——用户读不出不做这步会出废片");
  assert.match(title, /生视频|视频/u,
    "提示语没说清是在生视频这一步吃亏");
});

test("底部说明同样要点明这一步影响人物,不能停在「两码事」", () => {
  const at = imagePanel.indexOf("选用=设为本镜定稿");
  assert.notEqual(at, -1, "底部说明段落找不到了");
  const paragraph = imagePanel.slice(at, at + 400);
  assert.match(paragraph, /人物|一致/u,
    "底部说明没点明入库影响生视频的人物一致性");
});
