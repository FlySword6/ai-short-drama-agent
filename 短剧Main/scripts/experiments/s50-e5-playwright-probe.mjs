/**
 * S50-E5: 播放链路浏览器级实测探针。
 *
 * 目的：验证「仅追加自有 XMP 元数据、不动任何媒体流」的 C2PA 视频,
 * 在本地 dev 栈的真实前端工作台里能被 <video> 元素加载并实际解码播放。
 *
 * 凭据纪律:用户名/密码只从环境变量读,不打印、不落盘。
 * 输出:stdout 打印 JSON 结果 + 截图写到 S50_SCREENSHOT_DIR。
 *
 * 运行:
 *   set -a; source .env; set +a
 *   node scripts/experiments/s50-e5-playwright-probe.mjs
 *   # 依赖不在项目内时:S50_PLAYWRIGHT_PKG=/path/to/global/playwright/index.js
 */
const pwModule = await import(process.env.S50_PLAYWRIGHT_PKG ?? "playwright");
const { chromium } = pwModule.default ?? pwModule;

const FRONTEND = process.env.S50_FRONTEND_URL ?? "http://localhost:5173";
const PROJECT_ID = "00000000-de70-4000-8000-000000000001";
const EPISODE_ID = "00000000-de70-4000-8000-000000000002";
const SHOT_ID = "00000000-de70-4000-8000-000000000005";
const SHOT_URL = `${FRONTEND}/projects/${PROJECT_ID}/storyboards/${EPISODE_ID}/shots/${SHOT_ID}`;
const SCREENSHOT_DIR = process.env.S50_SCREENSHOT_DIR ?? "/tmp";

const username = process.env.DEV_ADMIN_USERNAME;
const password = process.env.DEV_ADMIN_PASSWORD;
if (!username || !password) {
  console.error("missing DEV_ADMIN_USERNAME / DEV_ADMIN_PASSWORD in env");
  process.exit(1);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const result = { steps: [] };

try {
  // 1) 登录
  await page.goto(`${FRONTEND}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 });
  result.steps.push({ step: "login", ok: true, landed: page.url() });

  // 2) 直达到挂有「改元数据视频」的分镜工作台,切到「视频」页签(MediaStage 在此渲染)
  await page.goto(SHOT_URL, { waitUntil: "domcontentloaded" });
  await page.click('[aria-label="工作台页签"] >> text=视频');
  const video = page.locator("video").first();
  await video.waitFor({ state: "attached", timeout: 30000 });
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.readyState >= 1 && v.videoWidth > 0;
  }, null, { timeout: 30000 });

  const meta = await video.evaluate((v) => ({
    src: v.currentSrc || v.src,
    readyState: v.readyState,
    videoWidth: v.videoWidth,
    videoHeight: v.videoHeight,
    duration: v.duration,
    muted: v.muted,
  }));
  result.steps.push({ step: "video_metadata_loaded", ok: true, ...meta });

  // 3) 实际解码播放 1.5s,确认 currentTime 真的往前走(解码器接受码流)
  await video.evaluate((v) => { v.muted = true; return v.play(); });
  await page.waitForTimeout(1500);
  const playState = await video.evaluate((v) => ({
    currentTime: v.currentTime,
    paused: v.paused,
    ended: v.ended,
    error: v.error ? { code: v.error.code, message: v.error.message } : null,
  }));
  result.steps.push({ step: "decode_playback_1.5s", ok: playState.currentTime > 0 && playState.error === null, ...playState });

  // 4) 截图存证
  const shot = `${SCREENSHOT_DIR}/e5-workbench-player.png`;
  await page.screenshot({ path: shot, fullPage: false });
  result.steps.push({ step: "screenshot", ok: true, path: shot });

  result.ok = result.steps.every((s) => s.ok);
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? error.message : String(error);
  try {
    const shot = `${SCREENSHOT_DIR}/e5-workbench-player-FAILED.png`;
    await page.screenshot({ path: shot });
    result.failure_screenshot = shot;
  } catch { /* ignore */ }
} finally {
  await browser.close();
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
