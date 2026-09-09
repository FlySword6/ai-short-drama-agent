/* K2W「全局生产任务队列」浏览器真点验证(1440×900,demo 彩排):
   ① 全局壳(/projects)顶栏入口 + 在途数徽标 2;
   ② 点开面板三态:排队中·第 1 位 / 生成中 / 已失败+原因 / 最近完成 / 离线标注;
   ③ 点生成中行跳对应镜工作台(demo-shot-4);
   ④ 工作台页(项目壳)入口仍在且数字不变;
   ⑤ 切资产中心(全局壳)入口仍在且数字不变;
   ⑥ 控制台 0 error;截图留证。 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = "http://127.0.0.1:5346";
/* fileURLToPath 解码中文路径;scripts/ 上一层即仓根 */
const SHOTS = fileURLToPath(new URL("../docs/validation/k2w-shots/", import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const consoleErrors = [];
const pageErrors = [];
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (error) => pageErrors.push(String(error)));

/* 进 demo:sessionStorage 标记后直接重进 /projects(S14-16:demo 仅由内部 sessionStorage 进入;
   落在 /login 时 App 优先渲染登录页,所以标记后要走项目路径重载) */
await page.goto(`${BASE}/projects`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => window.sessionStorage.setItem("shortdrama_v01_demo", "1"));
await page.goto(`${BASE}/projects`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=离线演示", { timeout: 15000 });

/* ① 全局壳顶栏入口 + 徽标 */
const entry = page.getByRole("button", { name: "任务队列,2 个任务在途" });
await entry.waitFor({ timeout: 10000 });
check("① 全局壳顶栏入口存在,徽标在途数=2", await entry.isVisible());
const badgeText = await entry.locator("span").innerText();
check("① 徽标数字=2", badgeText.trim() === "2", badgeText);

/* ② 面板三态 */
await entry.click();
await page.waitForSelector("text=任务队列", { timeout: 5000 });
const panel = page.locator("[role=menu]");
await panel.waitFor({ timeout: 5000 });
const panelText = await panel.innerText();
check("② 面板头部:2 个在途", panelText.includes("2 个在途"));
check("② 排队中 · 第 1 位", panelText.includes("排队中 · 第 1 位"));
check("② 生成中 + 预计", panelText.includes("生成中") && panelText.includes("预计约 2 分钟"));
check("② 已失败 + 失败原因人话", panelText.includes("已失败") && panelText.includes("参考图尺寸不合规"));
check("② 需要处理区", panelText.includes("需要处理"));
check("② 最近完成区:图片任务已完成", panelText.includes("最近完成") && panelText.includes("图片任务已完成"));
check("② demo 离线标注", panelText.includes("离线演示 · 示例任务"));
check("② 项目/镜归属:《杀穿女频》· 第1集", (panelText.match(/《杀穿女频》/g) ?? []).length >= 3);
await page.screenshot({ path: `${SHOTS}01-panel-three-states.png` });

/* ③ 点生成中行跳对应镜工作台 */
await panel.getByText("第1集 · #4 · 特写").click();
await page.waitForURL("**/projects/demo-project-2/storyboards/demo-episode-1/shots/demo-shot-4", { timeout: 10000 });
check("③ 点任务行跳对应镜工作台(demo-shot-4)", page.url().includes("/shots/demo-shot-4"), page.url());
await page.waitForTimeout(1200);
await page.screenshot({ path: `${SHOTS}02-workbench-after-jump.png` });

/* ④ 项目壳(工作台)入口仍在且数字不变 */
const entryWorkbench = page.getByRole("button", { name: "任务队列,2 个任务在途" });
await entryWorkbench.waitFor({ timeout: 10000 });
check("④ 工作台页入口仍在,数字不变=2", await entryWorkbench.isVisible());

/* ⑤ 切资产中心(全局壳)入口仍在且数字不变 */
await page.goto(`${BASE}/assets?scope=personal`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1000);
const entryAssets = page.getByRole("button", { name: "任务队列,2 个任务在途" });
await entryAssets.waitFor({ timeout: 10000 });
check("⑤ 资产中心入口仍在,数字不变=2", await entryAssets.isVisible());
/* 资产中心再点开一次面板:跨页后面板内容不丢 */
await entryAssets.click();
const panel2 = page.locator("[role=menu]");
await panel2.waitFor({ timeout: 5000 });
const panel2Text = await panel2.innerText();
check("⑤ 资产中心面板三态仍在", panel2Text.includes("排队中 · 第 1 位") && panel2Text.includes("已失败") && panel2Text.includes("图片任务已完成"));
await page.screenshot({ path: `${SHOTS}03-assets-entry-panel.png` });

/* 失败行跳链:点失败任务 → 对应镜工作台(demo-shot-5) */
await panel2.getByText("第1集 · #5 · 中景").click();
await page.waitForURL("**/shots/demo-shot-5", { timeout: 10000 });
check("⑤ 失败行跳对应镜工作台(demo-shot-5)", page.url().includes("/shots/demo-shot-5"), page.url());

/* ⑥ 控制台 */
check("⑥ 控制台 0 error", consoleErrors.length === 0 && pageErrors.length === 0, [...consoleErrors, ...pageErrors].slice(0, 3).join(" | "));

await browser.close();
const failed = results.filter((item) => !item.ok);
console.log(`\n== ${results.length - failed.length}/${results.length} 通过 ==`);
process.exit(failed.length > 0 ? 1 : 0);
