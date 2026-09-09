/* ============================================================
   s79-oriental.test.ts — S79 东方诗意设计语言定版验收断言

   验收口径(S79 任务包 + Fable 边界):
   1. token 落码:tokens.css 第 3 节 or- 色板/字族齐全;tw.css 新增 font-song/font-kai;
      定版色 19 色逐个锁值(S79c 起,每色一条独立断言,变异即红);
   2. 字体自托管:@font-face 只指 /fonts/* 本地 woff2,全文件零外网 URL;OFL 许可随库;
      单字体 subset 后 < 2MB(任务书体积红线);
   3. 三页 scope 接线:登录 .or-theme.or-login、项目 .or-theme.or-projects(+or-projects-grid)、
      生成节点卡 .or-theme.or-gennode;chips 挂 gen-node-chips;
   4. 边界:S66/S8 钩子不动(s66/s8 测试自身在守,这里只守「皮不动骨」的新增部分);
      accent 重指只发生在 .or-theme 作用域内;朱砂禁作功能色(or-zhu 不出现在 button/link 规则);
   5. 加载顺序:app.tsx 在 tw.css 之后引入 oriental.css;index.html 不得预载字体
      (@font-face 惰性加载,代价登录页一次 FOUT)。

   写法纪律同 dc-verdicts.test.ts:只读真实源码/文件真源,不读文档。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const tokens = readSource("./tokens.css");
const tw = readSource("./tw.css");
const oriental = readSource("./oriental.css");
const appShell = readSource("./app.tsx");
const globalPages = readSource("./pages/global-pages.tsx");
const workbench = readSource("./pages/workbench-page.tsx");
const featuresComponent = readSource("./components/gen-node-features.tsx");
const indexHtml = readSource("../index.html");

/* ---------- 1. token 落码 ---------- */

test("S79 tokens:or- 色板四族齐全(松烟墨/月白/黛青/朱砂/芦白)", () => {
  for (const name of [
    "--or-mo-0", "--or-mo-1", "--or-mo-2", "--or-mo-glass",
    "--or-yue-1", "--or-yue-2", "--or-yue-3", "--or-yue-4",
    "--or-dai", "--or-dai-text", "--or-dai-subtle",
    "--or-zhu", "--or-zhu-deep", "--or-zhu-ink", "--or-lu",
  ]) {
    assert.ok(tokens.includes(name), `tokens.css 缺 ${name}`);
  }
});

test("S79 tokens:字族 token 双落(tokens.css 与 tw.css @theme 同源)", () => {
  assert.ok(tokens.includes("--font-song") && tokens.includes("--font-kai"), "tokens.css 缺 --font-song/--font-kai");
  assert.ok(tw.includes("--font-song") && tw.includes("--font-kai"), "tw.css @theme 缺 --font-song/--font-kai");
  assert.ok(tokens.includes("Noto Serif SC") && tokens.includes("LXGW WenKai"), "字族栈缺真源字体名");
});

test("S79 tokens:既有 token 语义未被删改(SaaS 蓝灰与薄荷青默认值仍在)", () => {
  // 旧页面靠这些默认值活着;S79 只许新增,不许改旧值
  assert.ok(tokens.includes("--surface-0:      oklch(0.165 0.008 260)"), "surface-0 默认值被改");
  assert.ok(tokens.includes("--accent:        oklch(0.820 0.150 172)"), "accent 薄荷青默认值被改");
  assert.ok(tw.includes("--color-accent: oklch(0.820 0.150 172)"), "tw.css accent 默认值被改");
});

/* S79c 条件三:定版色 19 色逐个锁值,不是只补 --or-dai。
   每色一条独立测试——逐色变异时每发只红自己那一条,回执表格可按名对账。
   宽松匹配(忽略冒号后空白),只吃色值变异,不被格式化空格误伤(S79b 验收变异 D2)。 */
const lockedColors: ReadonlyArray<readonly [name: string, value: string, label: string]> = [
  // 松烟墨(表面阶梯,hue≈175 青墨)
  ["--or-mo-0", "oklch(0.155 0.012 175)", "墨底"],
  ["--or-mo-0-glow", "oklch(0.185 0.014 175)", "墨底顶部微亮"],
  ["--or-mo-0-edge", "oklch(0.120 0.010 175)", "墨底暗角边缘"],
  ["--or-mo-1", "oklch(0.205 0.015 175)", "墨锭面板"],
  ["--or-mo-2", "oklch(0.240 0.017 172)", "嵌套块/hover"],
  ["--or-mo-glass", "oklch(0.225 0.016 175 / 0.88)", "墨玻璃"],
  ["--or-mo-well", "oklch(0.060 0.008 175)", "装饰井"],
  // 月白(墨色阶梯,hue≈95 月下宣纸)
  ["--or-yue-1", "oklch(0.930 0.012 95)", "月白主文字"],
  ["--or-yue-2", "oklch(0.780 0.015 100)", "月白次要说明"],
  ["--or-yue-3", "oklch(0.520 0.012 100)", "月白禁用"],
  ["--or-yue-4", "oklch(0.715 0.014 100)", "月白占位"],
  // 黛青(引路色;--status-running / --ring 在 .or-theme 内指向它)
  ["--or-dai", "oklch(0.780 0.065 195)", "黛青"],
  ["--or-dai-hover", "oklch(0.830 0.070 195)", "黛青 hover"],
  ["--or-dai-text", "oklch(0.820 0.055 195)", "黛青文字"],
  ["--or-dai-subtle", "oklch(0.780 0.065 195 / 0.14)", "黛青淡底"],
  // 朱砂(全站唯一红)+ 芦白(装饰笔触)
  ["--or-zhu", "oklch(0.585 0.155 30)", "朱砂印"],
  ["--or-zhu-deep", "oklch(0.490 0.135 28)", "朱砂深色"],
  ["--or-zhu-ink", "oklch(0.950 0.010 90)", "印面文字"],
  ["--or-lu", "oklch(0.880 0.025 100)", "芦白"],
];
const escapeRegExp = (s: string) => s.replace(/[^\w\s]/g, "\\$&");
for (const [name, value, label] of lockedColors) {
  test(`S79 tokens:定版色值锁定 ${name}(${label})`, () => {
    // 定版色的 oklch 值就是交付物本身;只查名字不咬色值变异(S79b 必修三口径,本轮全量补齐)
    const pattern = new RegExp(`${escapeRegExp(name)}\\s*:\\s*${escapeRegExp(value)}(?:[;\\s]|$)`);
    assert.ok(pattern.test(tokens), `${label} ${name} 定版色值被改(应为 ${value})`);
  });
}

/* ---------- 2. 字体自托管 ---------- */

test("S79 fonts:@font-face 双族齐、只指本地 /fonts/* woff2", () => {
  assert.ok(oriental.includes('font-family: "Noto Serif SC"'), "缺 Noto Serif SC @font-face");
  assert.ok(oriental.includes('font-family: "LXGW WenKai"'), "缺 LXGW WenKai @font-face");
  assert.ok(oriental.includes('url("/fonts/noto-serif-sc-600.woff2")'), "宋体未指本地 woff2");
  assert.ok(oriental.includes('url("/fonts/lxgw-wenkai-400.woff2")'), "楷体未指本地 woff2");
  assert.ok(oriental.includes("font-display: swap"), "缺 font-display: swap");
});

test("S79 fonts:全站字体零外网(不拉 CDN)", () => {
  // SVG data-uri 的 xmlns 是命名空间标识符,不是网络拉取,豁免
  const strip = (s: string) => s.replaceAll("http://www.w3.org/2000/svg", "").replaceAll("https://github.com", "");
  for (const [label, source] of [["oriental.css", oriental], ["tokens.css", tokens], ["tw.css", tw]] as const) {
    assert.ok(!/https?:\/\//.test(strip(source)), `${label} 出现外网 URL`);
    assert.ok(!source.includes("fonts.googleapis.com") && !source.includes("fonts.gstatic.com") && !source.includes("jsdelivr") && !source.includes("cdn"), `${label} 出现 CDN 引用`);
  }
});

test("S79 fonts:subset 体积红线(单字体 < 2MB)且 OFL 许可随库", () => {
  for (const file of ["noto-serif-sc-600.woff2", "lxgw-wenkai-400.woff2"]) {
    const size = statSync(new URL(`../public/fonts/${file}`, import.meta.url)).size;
    assert.ok(size > 100_000, `${file} 体积异常小(${size}B),疑似空壳`);
    assert.ok(size < 2 * 1024 * 1024, `${file} 超 2MB 体积红线(${(size / 1048576).toFixed(2)}MB)`);
  }
  for (const license of ["OFL-noto.txt", "OFL-lxgw.txt"]) {
    const text = readSource(`../public/fonts/${license}`);
    assert.ok(text.includes("SIL OPEN FONT LICENSE") || text.includes("SIL Open Font License"), `${license} 不是 OFL 文本`);
  }
});

/* ---------- 3. 三页 scope 接线 ---------- */

test("S79 scope:登录页旧东方皮整体退役(P-01b 定稿皮取代),不得回潮;V-47 整页容器随葬", () => {
  // 2026-08-02 Fable 改锚:卡 2 重开(DC 亲判「login还是旧页面」)——or-login/or-seal/or-vertical
  // 随 R88 尾巴清退,登录页=P-01b 风格 A(监视器拼贴+登录卡首屏浮起);断言翻转为退役防回潮。
  // 2026-08-04 V-47:整页登录自身也退役,登录卡唯一载体=落地页弹层,login-page 容器锚随之入土。
  assert.ok(!globalPages.includes("or-login"), "or-login 旧皮 scope 不得回潮");
  assert.ok(!globalPages.includes("or-seal"), "朱砂印章不得回潮");
  assert.ok(!globalPages.includes("or-vertical"), "旧竖排点缀不得回潮");
  assert.ok(!globalPages.includes("login-page"), "V-47:整页登录容器未随葬");
  assert.ok(!globalPages.includes("LoginPage"), "V-47:LoginPage 未退役");
});

test("S79 scope:项目列表破格网格随看板化退役,不得回潮", () => {
  // 2026-08-02 Fable 改锚:R2 看板四列取代破格网格(批次一卡 3);
  // 本断言从「接上」翻转为「退役防回潮」,看板容器为新载体。
  assert.ok(!globalPages.includes("or-projects-grid"), "破格网格 class 已退役,不得回潮");
  assert.ok(globalPages.includes("projectBoardColumn"), "缺看板列载体");
});

test("S79 scope:生成节点卡 .or-theme.or-gennode + chips 笺形 class", () => {
  assert.ok(workbench.includes("or-theme or-gennode"), "节点卡 scope 未接");
  assert.ok(featuresComponent.includes("gen-node-chips"), "chips class 未接");
});

test("S79 scope:破格规则存在(特写卡 ≥1100px 跨两列,否决清单 #1 反例)", () => {
  assert.ok(oriental.includes("or-projects-grid > article:first-of-type"), "缺特写卡选择器");
  assert.ok(oriental.includes("grid-column: span 2"), "缺破格跨列规则");
  assert.ok(oriental.includes("min-width: 1100px"), "破格未加宽屏闸门(窄屏必须回单列)");
});

/* ---------- 4. 边界与红线 ---------- */

test("S79 边界:accent 重指只发生在 .or-theme 作用域内", () => {
  const scopeStart = oriental.indexOf(".or-theme {");
  assert.ok(scopeStart >= 0, ".or-theme 作用域缺失");
  const scopeEnd = oriental.indexOf("}", oriental.indexOf("--shadow-glow", scopeStart));
  const scope = oriental.slice(scopeStart, scopeEnd);
  assert.ok(scope.includes("--accent:"), "作用域内缺 accent 重指");
  // 作用域外不得再出现 --accent 赋值(其余页面语义不动)
  const outside = oriental.slice(scopeEnd);
  assert.ok(!/--accent\s*:/.test(outside), ".or-theme 之外出现 accent 重指,越界");
});

test("S79 红线:朱砂不作功能色(button/link/accent 规则不得引用 or-zhu)", () => {
  assert.ok(!/\.button[^{]*\{[^}]*or-zhu/.test(oriental), "按钮引用了朱砂");
  assert.ok(!/--accent[^:]*:\s*var\(--or-zhu/.test(oriental), "accent 重指成了朱砂");
  // 朱砂只允许印章与 REC 小点两处用例
  const uses = oriental.match(/or-zhu(?!-ink|-deep)/g) ?? [];
  assert.ok(uses.length <= 6, `朱砂用例超限(${uses.length} 处)`);
});

test("S79 守卫:tokens.css 间接声明(var 引用)必须跟随作用域重指(S79b 必修一根因)", () => {
  // 根因:var() 在声明处即完成替换,只继承计算值。--x: var(--y) 的 --x
  // 不会跟着 .or-theme 对 --y 的重指走,必须在作用域内显式重指 --x。
  const scopeStart = oriental.indexOf(".or-theme {");
  assert.ok(scopeStart >= 0, ".or-theme 作用域缺失");
  const scopeEnd = oriental.indexOf("}", oriental.indexOf("--shadow-glow", scopeStart));
  const scope = oriental.slice(scopeStart, scopeEnd);
  const rescoped = new Set([...scope.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const m of tokens.matchAll(/(--[\w-]+)\s*:\s*var\((--[\w-]+)\)/g)) {
    const [, alias, target] = m;
    if (rescoped.has(target) && !rescoped.has(alias)) {
      assert.fail(`${alias}: var(${target}) —— ${target} 已在 .or-theme 重指,${alias} 漏重指(计算值不跟随)`);
    }
  }
});

test("S79 边界:libTV 三段式未误伤;整页登录钩子随 V-47 入土", () => {
  assert.ok(workbench.includes("<GenNodeEditBar"), "编辑条丢了");
  assert.ok(workbench.includes("<MediaStage"), "画布丢了");
  assert.ok(workbench.includes("生成卡底条"), "底条丢了");
  /* V-47:aurora/grain/vignette/vf-corner 是整页登录的光影钩子,随整页退役——
     弹层登录不需要也不许回潮(弹层自己的 veil=landing-login-overlay)。 */
  for (const hook of ["aurora-field", "grain-overlay", "login-vignette", "vf-corner"]) {
    assert.ok(!globalPages.includes(hook), `整页登录钩子 ${hook} 未随葬(V-47)`);
  }
});

/* ---------- 5. 加载顺序与预载 ---------- */

test("S79 接线:app.tsx 在 tw.css 之后引入 oriental.css;index.html 不得预载字体", () => {
  const twAt = appShell.indexOf('import "./tw.css"');
  const orAt = appShell.indexOf('import "./oriental.css"');
  assert.ok(twAt >= 0 && orAt > twAt, "oriental.css 加载顺序必须在 tw.css 之后(级联依赖)");
  // S79b 必修二:index.html 是全路由 shell,preload 会对每条路由(含无 .or-theme 的旧页)
  // 无条件拉 2.87MB 字体;@font-face(font-display: swap) 惰性加载才是正确策略
  assert.ok(!/rel="preload"[^>]*\/fonts\//.test(indexHtml), "index.html 不得预载字体(每条路由都会付 2.87MB)");
});
