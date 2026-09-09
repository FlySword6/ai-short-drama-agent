/* rail-z-tokens.test.ts — 2026-08-04 P0 守卫:全局页 rail 隐形事故防回归

   事故链:结构 token(z 阶梯等)唯一真源 src/tokens.css 不在任何运行时加载链
   → --z-float 全局缺省 → rail 的 z-[calc(var(--z-float)+2)] 失效回退 auto
   → 被页内固定衬底(.or-projects::before,z-0 层叠上下文)盖没,五全局页 rail 隐形。
   修复:z/动效结构 token 挂载 styles/tokens.css :root(运行时必载)。

   钉三件事:
   1. 结构 token 在运行时必载文件的 :root 里(z-float 为代表);
   2. 该文件确实在加载链(index.html link 或 app.tsx import);
   3. rail 仍走 z-float 计算档(不被改成裸数字而失去阶梯语义)。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const tkTokens = readSource("./styles/tokens.css");
const app = readSource("./app.tsx");
const indexHtml = readSource("../index.html");
const rail = readSource("./components/app-rail.tsx");

test("P0:结构 token(z 阶梯)挂在运行时文件的 :root", () => {
  const rootBlock = tkTokens.slice(tkTokens.indexOf(":root"), tkTokens.indexOf(":root") + 3000);
  for (const token of ["--z-dropdown", "--z-sticky", "--z-float", "--z-modal-backdrop", "--z-modal", "--z-toast", "--z-tooltip"]) {
    assert.ok(rootBlock.includes(token), `styles/tokens.css :root 缺 ${token}`);
  }
  for (const token of ["--duration-1", "--ease-out-quart", "--move-1"]) {
    assert.ok(rootBlock.includes(token), `styles/tokens.css :root 缺 ${token}`);
  }
});

test("P0:styles/tokens.css 在运行时加载链(index.html link 或 app.tsx import)", () => {
  const linked = indexHtml.includes('/src/styles/tokens.css') || app.includes('"./styles/tokens.css"');
  assert.ok(linked, "styles/tokens.css 不在加载链——结构 token 又会全局缺省");
});

test("P0:rail 走 z-float 阶梯计算档(不裸写数字,不与页内衬底同级)", () => {
  assert.ok(rail.includes("z-[calc(var(--z-float)+2)]"), "rail 层级声明变了,回到失效档会再隐形");
});
