---
type: design_system_contract
status: superseded
version: 0.1.1
owner_approval: DC
created: 2026-07-15
approved: 2026-07-15(DC;三项待批点全部按建议裁决,见〇.2)
authors: Fable-5 (主编) + 四个起草代理 (tokens/动效/组件/迁移)
superseded: 2026-08-03(DC 裁定真源换代;后继真源=Figma「COL 短剧设计系统 · v2」fileKey=4JDL0kKz1VxOUNKDqoyEAL;物理归档待架构门禁改锚窗口,见 archive/README.md)
---

# 短剧生产平台 设计系统合同 (V0.1.1)

> **真源换代（2026-08-03 DC 裁定）**：设计系统与产品原型的唯一参考=Figma「COL 短剧设计系统 · v2」（fileKey=`4JDL0kKz1VxOUNKDqoyEAL`）。本文退役为历史参考，冻结状态由 approved_frozen 改 superseded；物理归档待 `scripts/check-v011-architecture.mjs` 必查清单改锚窗口（`archive/README.md`）。

> **V0.1.1 收敛说明（2026-07-20）**：本文继续作为色彩、材质、排版、可访问性和动效上限的视觉真源；其中“小龙虾”统一理解为“AI 智能工作区”，不是人格吉祥物。报价卡、强制费用确认、旧页面旅程和旧组件锚点只保留为历史迁移参考，产品行为以 `PRODUCT.md`、`DESIGN.md` 与 `docs/contracts/v0.1.1/` 为准。发生冲突时后者优先。

本文是前端表现层的**合同级规格**,与 `api.md`、`data-model.md`、`runtime.md` 同级。消费者是执行迁移与后续开发的 AI 代理;每条规则尽量可判定、带 do/don't。批准后:token 数值、四层材质、三处玻璃、辉光两用途、唯一强调色、agent 色边界、圆角/z/动效上限、独特性红线的任何变更都需 DC 批准,代理只能提案。

## 〇、九项已批准决策 (2026-07-15,本文的宪法层)

1. **气质**: 电影级暗色 AI 工作台,克制档 (Runway/Linear/Vercel Console 参照);排除霓虹赛博与紫渐变 AI 模板。
2. **色彩**: 全站唯一强调色 = 暗底荧光薄荷青;小龙虾红橙 = agent 专属存在色;状态色标准语义。
3. **字体**: Geist 自托管 (拉丁+数字) + 中文系统栈;Geist Mono 给一切数据 (任务ID/费用/时间戳/元数据);tabular-nums。
4. **材质**: 四层暗房 —— L0 底幕 / L1 实心面板 / 玻璃只给三处浮空层 (小龙虾侧栏、全部 modal、顶栏) / 媒体井纯黑;辉光仅两个合法用途。
5. **动效**: Motion 库;五个英雄时刻全套编排,微交互统一弹簧预设,其余禁动;基础 120-240ms,英雄上限 600ms;reduced-motion 全覆盖。
6. **底座**: Tailwind v4 + shadcn (copy-in 含 Radix) 彻底重建表现层;tokens→primitives→业务组件→页面分层;禁任意值;CVA 变体;逻辑层零改动。
7. **主题**: 语义 token 预留双主题,V0.1.1 只交付暗色。
8. **治理**: 本文 + tokens.css 唯一真源 + Storybook 实况库;变更需批准。
9. **节奏**: P1 底座→P2 组件+Storybook→P3 页面按验收流程迁移 (每页冷启动走查)→P4 Playwright 11 步回归。

依赖冻结: Tailwind v4、shadcn (Radix)、Motion、Geist (+ cva/clsx/tailwind-merge 视为 shadcn 固有依赖,Storybook 仅 devDeps)。

## 〇.1 编集说明 (实施者必读)

1. **token 命名以第一章 tokens.css 为唯一真源**。已做全文对齐: 玻璃层 = `--surface-glass`(四件套),媒体井 = `--surface-well`,实心嵌套面板/hover 底 = `--surface-2`(新增,#1b1e24,亮度与玻璃填充一致,对比度结论沿用)。
2. 第三/四章示例中偶见 `--text-1/2/3` 简写,映射: `--text-1→--ink-1`、`--text-2→--ink-2`、弱文按语境取 `--ink-2`、占位符一律 `--ink-4`;`--surface-0..well` 以第一章为准。P1 落盘时只按 tokens.css 命名生成工具类。
3. 第四章 0.1 节的"示例锚点"数值已被第一章的**已验证冻结值**取代,以第一章为准;第四章其余部分 (页面映射/迁移剧本/治理/回滚) 为规范性内容。
4. 五个英雄时刻的编排以第二章 MOT-* 规则为准,组件挂接点以第三章为准,页面归属以第四章映射表为准;三者冲突时优先级: 第二章(怎么动) > 第三章(挂在哪个组件) > 第四章(出现在哪页)。
5. 独特性红线 (任一页面去 logo 后仍能凭 薄荷青强调 + agent 红橙存在感 + 暗房/媒体井隐喻 + mono 数据声 识别为本产品) 是验收标准,不是修辞。

## 〇.2 裁决记录 (2026-07-15,DC)

1. **已批准**:L2 玻璃层"描边+大柔影并用"为幽灵卡禁令的唯一例外(玻璃配方固有组成);L1 实心卡片仍严禁该组合。
2. **已批准**:z 阶梯新增 `--z-float: 30`(小龙虾侧栏专用档,位于 sticky 与 modal-backdrop 之间)。
3. **已裁决**:付费动作按钮(含小龙虾侧栏报价卡的"确认费用并提交")一律使用产品强调色薄荷青;agent 红橙只做存在感,永不上按钮。
4. lint 强制方案(3.2 节,涉及新 devDependency)维持"建议"状态,零依赖的 `check:design` grep 门禁先行;是否升级为强制待 P2 后再议。

---

验证已全绿(45 组配对,0 色域裁剪)。以下为最终交付。

# tokens.css(可直接落盘,Tailwind v4 @theme 语法)

建议路径:`frontend/shortdrama-rag-demo/src/tokens.css`(替换现 `styles.css` 中的变量段,由入口 `@import "tailwindcss"; @import "./tokens.css";` 引入)

```css
/* ============================================================
   tokens.css — 短剧生产平台 V0.1.1 设计 token 唯一真源
   合同级文件:任何值的变更需用户批准(见 design-system.md)
   验证:全部前景/背景配对经 WCAG 2.1 计算(/tmp/oklch-contrast.mjs)
   正文≥4.5:1,非文字部件≥3:1,占位符≥4.5:1,全绿
   ============================================================ */

/* ---------- 1. 语义色值:挂在 [data-theme] 下,双主题预留 ---------- */
/* V0.1.1 只交付 dark;亮色主题未来新增 [data-theme="light"] 块,不改任何引用 */

[data-theme="dark"] {
  color-scheme: dark;

  /* -- L0 底幕:深灰非纯黑,径向渐变+暗角构成"暗房"氛围 -- */
  --surface-0:      oklch(0.165 0.008 260);  /* #0c0e12 页面底 */
  --surface-0-glow: oklch(0.190 0.010 260);  /* #111418 渐变中心(顶部微亮) */
  --surface-0-edge: oklch(0.130 0.008 260);  /* #06070a 暗角边缘 */
  --backdrop-l0: radial-gradient(120% 90% at 50% 0%,
      var(--surface-0-glow) 0%, var(--surface-0) 55%, var(--surface-0-edge) 100%);

  /* -- L1 实心面板:卡片/表格/表单容器,只用描边分层,零阴影 -- */
  --surface-1: oklch(0.205 0.010 260);       /* #15171c */
  --surface-2: oklch(0.235 0.012 260);       /* #1b1e24 面板内嵌套块/行 hover 底(实心) */

  /* -- L2 玻璃:仅限三处浮空层(小龙虾侧栏/全部 modal/顶栏),配方四件套 --
     用法: background: var(--surface-glass);
           backdrop-filter: blur(var(--surface-glass-blur)) saturate(var(--surface-glass-saturate));
           border: 1px solid var(--surface-glass-border);
           box-shadow: var(--shadow-2);
     [治理标注] 玻璃层"描边+大柔影并用"是四层材质决策的组成部分,
     作为幽灵卡禁令的唯一经批准例外记录;L1 卡片严禁此组合 */
  --surface-glass:          oklch(0.230 0.012 260 / 0.88); /* 填充 #1a1d23 @88%,不透明度是对比度红线,禁调低 */
  --surface-glass-blur:     20px;
  --surface-glass-saturate: 140%;
  --surface-glass-border:   oklch(1 0 0 / 0.10);

  /* -- L3 媒体井:视频/图片展示区纯黑,让素材自己发光 -- */
  --surface-well: oklch(0 0 0);                 /* #000000 */

  /* -- 输入井:L1 面板上的输入框用 L0 色内凹,不另造新灰 -- */
  --surface-input: var(--surface-0);

  /* -- ink 阶梯:正文/次要/禁用/占位 --
     注意顺序:ink-3(禁用)刻意比 ink-4(占位)更暗——
     禁用态是 WCAG 豁免项,占位符是真实引导内容,必须 4.5:1 */
  --ink-1: oklch(0.930 0.006 260);  /* #e5e8ec 正文/标题 */
  --ink-2: oklch(0.780 0.010 260);  /* #b4b8be 次要说明/表头/图标默认 */
  --ink-3: oklch(0.520 0.010 260);  /* #66696f 禁用态(豁免,仅此用途) */
  --ink-4: oklch(0.715 0.010 260);  /* #9fa3a9 占位符(全层验证 4.5:1) */

  /* -- accent:全站唯一强调色,暗底荧光薄荷青 -- */
  --accent:        oklch(0.820 0.150 172);          /* #30e3b9 主按钮底/选中态/进行中 */
  --accent-hover:  oklch(0.860 0.155 172);          /* #3af1c5 */
  --accent-active: oklch(0.780 0.145 172);          /* #25d5ad */
  --accent-subtle: oklch(0.820 0.150 172 / 0.13);   /* 选中背景/激活行 tint */
  --accent-text:   oklch(0.850 0.130 172);          /* #63e9c4 深底上的链接/强调文字 */
  --accent-ink:    oklch(0.200 0.030 172);          /* #061a14 accent 底上的按钮文字 */

  /* -- agent:小龙虾红橙,只为助手存在感,禁止挪作装饰 -- */
  --agent:          oklch(0.720 0.160 40);          /* #f67d51 头像/图标/高亮 */
  --agent-text:     oklch(0.780 0.130 45);          /* #fc9b6f 侧栏内助手署名/强调文字 */
  --agent-presence: oklch(0.680 0.185 38);          /* #f36537 工作中呼吸条(侧栏顶部指示,非卡片边条) */
  --agent-bubble:   oklch(0.720 0.160 40 / 0.10);   /* 助手气泡底 tint */

  /* -- status:标准语义,文字版≥4.5,subtle 为同色低透明背景 --
     进行中刻意复用 accent 青(决策2:状态色只有红/橙/绿,青=活动本身) */
  --status-success:        oklch(0.780 0.140 155);          /* #63d18f */
  --status-success-subtle: oklch(0.780 0.140 155 / 0.14);
  --status-danger:         oklch(0.740 0.150 25);           /* #fb817a 错误文字/图标 */
  --status-danger-subtle:  oklch(0.740 0.150 25 / 0.14);
  --status-danger-strong:  oklch(0.550 0.200 27);           /* #cc2827 危险按钮底,配白字 */
  --status-danger-strong-ink: oklch(1 0 0);
  --status-warning:        oklch(0.820 0.140 80);           /* #f3b94c */
  --status-warning-subtle: oklch(0.820 0.140 80 / 0.14);
  --status-running:        var(--accent);
  --status-running-subtle: oklch(0.820 0.150 172 / 0.14);

  /* -- 描边 2 档 -- */
  --border-1: oklch(1 0 0 / 0.08);   /* 静默分隔:卡片描边/表格线 */
  --border-2: oklch(1 0 0 / 0.16);   /* 交互描边:输入框/hover 卡/可点击边界 */

  /* -- focus ring:键盘可达性,全层≥3:1 -- */
  --ring:        var(--accent);
  --ring-width:  2px;
  --ring-offset: 2px;

  /* -- 阴影/elevation:低层描边分层,高层才有影 --
     L0/L1: 无阴影,--border-1 分层
     dropdown/popover: --shadow-1 (blur<16px,可与描边并用,不构成幽灵卡)
     L2 浮空层: --shadow-2 (深色硬投影,配玻璃配方)
     辉光仅两个合法用途:主按钮 hover-active、生成完成一次性提示 */
  --shadow-1: 0 1px 2px oklch(0 0 0 / 0.35), 0 4px 12px oklch(0 0 0 / 0.45);
  --shadow-2: 0 24px 48px -16px oklch(0 0 0 / 0.60);
  --shadow-glow: 0 0 24px oklch(0.820 0.150 172 / 0.28);
}

/* ---------- 2. 结构 token:与主题无关,挂 :root ---------- */

:root {
  /* -- 语义 z 阶梯:禁 999/9999;--z-float 为小龙虾侧栏浮空层专用插档 -- */
  --z-dropdown:       10;
  --z-sticky:         20;   /* 顶栏/生产进度条吸顶 */
  --z-float:          30;   /* 小龙虾侧栏 */
  --z-modal-backdrop: 40;
  --z-modal:          50;
  --z-toast:          60;
  --z-tooltip:        70;

  /* -- 动效时长阶梯:120-240 为日常,400/600 只属于五个英雄时刻 -- */
  --duration-1: 120ms;  /* 微反馈:hover/按下/开关 */
  --duration-2: 180ms;  /* 标准过渡:dropdown/tooltip/tab */
  --duration-3: 240ms;  /* 面板/侧栏开合/较大位移 */
  --duration-4: 400ms;  /* 英雄时刻子步骤:进度条前进/报价卡展开 */
  --duration-5: 600ms;  /* 英雄时刻上限:生成完成/连播开幕,禁超 */

  /* -- 缓动:仅 ease-out 指数族,禁 bounce/elastic -- */
  --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
  --ease-out-quint: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-out-expo:  cubic-bezier(0.16, 1, 0.3, 1);

  /* -- Motion(motion.dev) 弹簧预设:阻尼比≈0.97,快而无过冲 --
     微交互: { type:"spring", stiffness:550, damping:46, mass:1 }
     英雄时刻: { type:"spring", stiffness:180, damping:26, mass:1 } */
  --spring-micro-stiffness: 550;
  --spring-micro-damping:   46;
  --spring-micro-mass:      1;
  --spring-hero-stiffness:  180;
  --spring-hero-damping:    26;
  --spring-hero-mass:       1;

  /* -- 位移距离:动效只许 transform/opacity,位移取此阶梯 -- */
  --move-1: 4px;    /* 微交互 nudge */
  --move-2: 8px;    /* dropdown/tooltip 入场 */
  --move-3: 16px;   /* modal/侧栏入场 */
  --move-4: 24px;   /* 英雄时刻位移上限 */
}

/* -- prefers-reduced-motion 全覆盖:时长归零、位移归零,状态仍要传达 -- */
@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-1: 1ms; --duration-2: 1ms; --duration-3: 1ms;
    --duration-4: 1ms; --duration-5: 1ms;
    --move-1: 0px; --move-2: 0px; --move-3: 0px; --move-4: 0px;
  }
}

/* ---------- 3. Tailwind v4 @theme:生成工具类 ---------- */

@theme {
  /* 清空默认调色板:全站只允许语义 token,bg-red-500 类直接不存在 */
  --color-*: initial;

  /* -- 字族:Geist 自托管拉丁+数字,中文走系统栈,Windows 兜底雅黑;上限 3 族 -- */
  --font-sans: "Geist", "PingFang SC", "HarmonyOS Sans SC",
               "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, "SF Mono", "Cascadia Mono",
               Consolas, monospace;

  /* -- 固定 rem 阶梯(product 域,非 clamp):
     12→14→16→19→22→26→30,相邻步进 1.143–1.19,全部落在 1.125–1.2 -- */
  --text-xs: 0.75rem;      --text-xs--line-height: 1.4;   /* 12px 数据密度档:mono 任务ID/时间戳/费用/表格元数据 */
  --text-sm: 0.875rem;     --text-sm--line-height: 1.5;   /* 14px UI 默认:按钮/表单/表格正文/侧栏对话 */
  --text-base: 1rem;       --text-base--line-height: 1.6; /* 16px 长文阅读:剧本/分镜描述 */
  --text-lg: 1.1875rem;    --text-lg--line-height: 1.4;   /* 19px 卡片标题/分区标题 */
  --text-xl: 1.375rem;     --text-xl--line-height: 1.3;   /* 22px 页面标题 */
  --text-2xl: 1.625rem;    --text-2xl--line-height: 1.2;  /* 26px 看板大数字/英雄时刻数字 */
  --text-3xl: 1.875rem;    --text-3xl--line-height: 1.15; /* 30px 登录页主标/空态主标 */

  /* -- 4px 基准 spacing:spacing-1=4px;组件内 1-6,组件间 8-12,分区 16-24 -- */
  --spacing: 0.25rem;

  /* -- radius:卡片上限 16px(--radius-xl 封顶),标签/按钮可全圆 -- */
  --radius-xs: 4px;       /* 内嵌小控件/checkbox */
  --radius-sm: 6px;       /* 按钮/输入框 */
  --radius-md: 10px;      /* 下拉/popover/小卡 */
  --radius-lg: 14px;      /* 标准卡片 */
  --radius-xl: 16px;      /* modal/浮空层,硬上限 */
  --radius-full: 9999px;  /* 标签/pill/头像 */

  --blur-glass: 20px;
}

@theme inline {
  /* 颜色全部经 var() 间接引用,换主题只换 [data-theme] 块 */
  --color-surface-0: var(--surface-0);
  --color-surface-1: var(--surface-1);
  --color-surface-2: var(--surface-glass);
  --color-surface-3: var(--surface-well);
  --color-surface-input: var(--surface-input);
  --color-ink-1: var(--ink-1);
  --color-ink-2: var(--ink-2);
  --color-ink-3: var(--ink-3);
  --color-ink-4: var(--ink-4);
  --color-accent: var(--accent);
  --color-accent-hover: var(--accent-hover);
  --color-accent-active: var(--accent-active);
  --color-accent-subtle: var(--accent-subtle);
  --color-accent-text: var(--accent-text);
  --color-accent-ink: var(--accent-ink);
  --color-agent: var(--agent);
  --color-agent-text: var(--agent-text);
  --color-agent-presence: var(--agent-presence);
  --color-agent-bubble: var(--agent-bubble);
  --color-success: var(--status-success);
  --color-success-subtle: var(--status-success-subtle);
  --color-danger: var(--status-danger);
  --color-danger-subtle: var(--status-danger-subtle);
  --color-danger-strong: var(--status-danger-strong);
  --color-danger-strong-ink: var(--status-danger-strong-ink);
  --color-warning: var(--status-warning);
  --color-warning-subtle: var(--status-warning-subtle);
  --color-running: var(--status-running);
  --color-running-subtle: var(--status-running-subtle);
  --color-border-1: var(--border-1);
  --color-border-2: var(--border-2);
  --color-ring: var(--ring);

  --shadow-1: var(--shadow-1);
  --shadow-2: var(--shadow-2);
  --shadow-glow: var(--shadow-glow);

  --ease-out-quart: var(--ease-out-quart);
  --ease-out-quint: var(--ease-out-quint);
  --ease-out-expo: var(--ease-out-expo);
}

/* ---------- 4. 排印基础规则(token 的强制执行面) ---------- */

@layer base {
  html { font-family: var(--font-sans); }
  body { background: var(--backdrop-l0); color: var(--ink-1); }
  /* 数字一律等宽对齐:费用/时长/计数/百分比不跳动 */
  body { font-variant-numeric: tabular-nums; }
  code, kbd, samp, pre { font-family: var(--font-mono); }
  ::placeholder { color: var(--ink-4); }
}

/* ============================================================
   使用规则(合同摘要,细则见 design-system.md)
   - 字重:400 正文 / 500 UI 标签与按钮 / 600 标题与关键数字;禁 700+,禁装饰字体
   - mono 场景清单:任务ID、时间戳、费用金额、时长/进度百分比、
     模型名与参数、SSE 日志行、分镜/镜头编号;正文与按钮禁 mono
   - 玻璃(surface-2)只许三处:小龙虾侧栏/全部 modal/顶栏;其余一律 L1
   - --shadow-glow 只许两处:主按钮 hover-active、生成完成一次性提示
   - --agent-* 只为助手存在感;--accent 是唯一全站强调色
   - 禁任意值类名;新 token 需用户批准后进此文件
   ============================================================ */
```

# 对比度验证表(WCAG 2.1,脚本实算,非目测)

脚本:`/tmp/oklch-contrast.mjs`(OKLab 参考实现 OKLCH→sRGB,gamma 空间 alpha 合成,45 组配对)。玻璃层按最不利底色计算:88% 玻璃填充压**纯白媒体画面**的合成色 `#35383d`(blur 不计入 WCAG)。最终运行 0 FAIL、0 色域裁剪。

| 前景 | 背景 | 对比度 | 要求 | 结果 |
|---|---|---|---|---|
| ink-1 正文 #e5e8ec | L0 底幕 #0c0e12 | 15.68:1 | ≥4.5 | PASS |
| ink-1 正文 #e5e8ec | L0 渐变中心(最不利) #111418 | 15.03:1 | ≥4.5 | PASS |
| ink-1 正文 #e5e8ec | L1 面板 #15171c | 14.58:1 | ≥4.5 | PASS |
| ink-1 正文 #e5e8ec | L2 玻璃压纯白(最不利) #35383d | 9.55:1 | ≥4.5 | PASS |
| ink-1 正文 #e5e8ec | L3 媒体井 #000000 | 17.09:1 | ≥4.5 | PASS |
| ink-2 次要 #b4b8be | L0 底幕 #0c0e12 | 9.63:1 | ≥4.5 | PASS |
| ink-2 次要 #b4b8be | L0 渐变中心(最不利) #111418 | 9.23:1 | ≥4.5 | PASS |
| ink-2 次要 #b4b8be | L1 面板 #15171c | 8.95:1 | ≥4.5 | PASS |
| ink-2 次要 #b4b8be | L2 玻璃压纯白(最不利) #35383d | 5.86:1 | ≥4.5 | PASS |
| ink-2 次要 #b4b8be | L3 媒体井 #000000 | 10.49:1 | ≥4.5 | PASS |
| ink-4 占位 #9fa3a9 | L0 底幕(输入井) #0c0e12 | 7.63:1 | ≥4.5 | PASS |
| ink-4 占位 #9fa3a9 | L1 面板 #15171c | 7.09:1 | ≥4.5 | PASS |
| ink-4 占位 #9fa3a9 | L2 玻璃压纯白(最不利) #35383d | 4.65:1 | ≥4.5 | PASS |
| ink-4 占位 #9fa3a9 | L3 媒体井 #000000 | 8.31:1 | ≥4.5 | PASS |
| ink-3 禁用 #66696f | L1 面板 #15171c | 3.25:1 | 豁免 | 记录 |
| accent-text #63e9c4 | L0 底幕 #0c0e12 | 12.85:1 | ≥4.5 | PASS |
| accent-text #63e9c4 | L1 面板 #15171c | 11.95:1 | ≥4.5 | PASS |
| accent-text #63e9c4 | L2 玻璃压纯白(最不利) #35383d | 7.83:1 | ≥4.5 | PASS |
| accent-text #63e9c4 | L3 媒体井 #000000 | 14.01:1 | ≥4.5 | PASS |
| accent-text #63e9c4 | accent-subtle 压 L1 #183230 | 9.13:1 | ≥4.5 | PASS |
| accent-ink 按钮文字 #061a14 | accent 默认 #30e3b9 | 10.95:1 | ≥4.5 | PASS |
| accent-ink 按钮文字 #061a14 | accent hover #3af1c5 | 12.49:1 | ≥4.5 | PASS |
| accent-ink 按钮文字 #061a14 | accent active #25d5ad | 9.55:1 | ≥4.5 | PASS |
| agent-text #fc9b6f | L0 底幕 #0c0e12 | 9.23:1 | ≥4.5 | PASS |
| agent-text #fc9b6f | L2 玻璃压纯白(侧栏最不利) #35383d | 5.62:1 | ≥4.5 | PASS |
| agent-text #fc9b6f | agent 气泡压玻璃(最不利) #483f3f | 4.88:1 | ≥4.5 | PASS |
| agent-presence(非文字) #f36537 | L2 玻璃压纯白(最不利) #35383d | 3.78:1 | ≥3.0 | PASS |
| agent-presence(非文字) #f36537 | L0 底幕 #0c0e12 | 6.20:1 | ≥3.0 | PASS |
| status-success #63d18f | L1 面板 #15171c | 9.46:1 | ≥4.5 | PASS |
| status-success #63d18f | success-subtle 压 L1 #1f312c | 7.20:1 | ≥4.5 | PASS |
| status-danger #fb817a | L1 面板 #15171c | 7.29:1 | ≥4.5 | PASS |
| status-danger #fb817a | danger-subtle 压 L1 #352629 | 5.85:1 | ≥4.5 | PASS |
| status-danger #fb817a | L2 玻璃压纯白(modal 最不利) #35383d | 4.77:1 | ≥4.5 | PASS |
| status-warning #f3b94c | L1 面板 #15171c | 10.13:1 | ≥4.5 | PASS |
| status-warning #f3b94c | warning-subtle 压 L1 #342e23 | 7.62:1 | ≥4.5 | PASS |
| status-running(=accent) #30e3b9 | L1 面板 #15171c | 10.92:1 | ≥4.5 | PASS |
| status-running(=accent) #30e3b9 | running-subtle 压 L1 #183432 | 8.14:1 | ≥4.5 | PASS |
| 白色按钮文字 #ffffff | danger-strong 危险按钮底 #cc2827 | 5.37:1 | ≥4.5 | PASS |
| ring(=accent) #30e3b9 | L0 底幕 #0c0e12 | 11.75:1 | ≥3.0 | PASS |
| ring(=accent) #30e3b9 | L1 面板 #15171c | 10.92:1 | ≥3.0 | PASS |
| ring(=accent) #30e3b9 | L2 玻璃压纯白(最不利) #35383d | 7.16:1 | ≥3.0 | PASS |
| ring(=accent) #30e3b9 | L3 媒体井 #000000 | 12.81:1 | ≥3.0 | PASS |
| accent 按钮底(非文字) #30e3b9 | L1 面板 #15171c | 10.92:1 | ≥3.0 | PASS |
| agent 图标/高亮(非文字) #f67d51 | L2 玻璃压纯白(最不利) #35383d | 4.45:1 | ≥3.0 | PASS |

迭代记录:初版 3 处调整——ink-4 占位 L 0.700→0.715(玻璃最不利 4.39→4.65)、agent-text L 0.760→0.780 且气泡透明度 0.12→0.10(4.39→4.88)、danger chroma 0.16→0.15(消除 sRGB 色域裁剪)。

# 每组值的设计意图(一句话)

- **surface 0-3**:一间暗房——L0 顶部微亮的深灰幕布给"有灯的房间"感而非虚空,L1 实心面板承载工作,L2 玻璃只给三个真正浮起的东西,L3 纯黑让媒体自己发光。
- **ink 1-4**:冷灰四档只降亮度不换色相;禁用(ink-3)刻意暗于占位(ink-4),因为占位是内容、禁用是豁免。
- **accent**:oklch(0.82 0.15 172) 的荧光薄荷青,是暗房里唯一的"进行中"信号灯,高亮到可以直接压深色按钮文字。
- **agent**:小龙虾红橙(hue 38-45)只出现在助手身上,与 danger 红(hue 25)拉开 15° 色相差,存在感条是侧栏顶部呼吸指示、不是卡片边条。
- **status**:红/橙/绿标准语义,进行中复用 accent 青以守住"全站唯一强调色";危险按钮单独给深红底+白字。
- **玻璃配方**:88% 不透明度是压在纯白视频画面上仍保 4.5:1 的对比度红线,blur 20px + saturate 140% 负责质感。
- **排印**:12→30px 七档固定阶梯(步进 1.143-1.19),12px 数据档全部走 Geist Mono + tabular-nums,给平台"生产日志"的数据声。
- **spacing/radius/z**:4px 网格;卡 14px、浮空层 16px 封顶;z 七档语义化,小龙虾侧栏占专属 float 档。
- **阴影**:暗色下低层靠描边、高层才有影,辉光只留给主按钮 hover 和生成完成两个时刻。
- **动效**:120/180/240ms 管日常、400/600ms 只属于五个英雄时刻;弹簧阻尼比 0.97 快而无回弹,reduced-motion 时全部时长与位移归零。

# 两个治理标注(已批准,裁决记录见〇.2)

1. **L2 玻璃 = 描边+大柔影并用**:幽灵卡禁令的唯一批准例外(玻璃配方固有组成),L1 卡片仍严禁。
2. **--z-float: 30**:已批准,小龙虾侧栏专用语义档。

验证脚本:`/tmp/oklch-contrast.mjs`(node 直接重跑可复现全表)。

---

以下为交付内容。规格中所有组件锚点均已对照 `frontend/shortdrama-rag-demo/src/` 现有实现核实（文中标注真实文件路径与类名/事件名，迁移时按此对应）。

---

# 动效编排规格（design-system.md · Motion 章节草案）

> 适用范围：全站。执行者：迁移代理（codex）。依赖：Motion（motion.dev，React 包 `motion/react`）。
> 本章规则编号 `MOT-*`，与 tokens/红线同级：任何偏离需用户批准。
> 真实组件锚点基于 `frontend/shortdrama-rag-demo/src/`，P3 迁移后路径变化时锚点随迁，规则不变。

---

## 1. 动效宪法（MOT-C）

### MOT-C1 只有四类事件允许动

1. **状态变化**：任务 pending→running→succeeded/failed、报价 ready→expired、主版本切换、进度条步进。
2. **用户操作反馈**：按压、开关、聚焦、提交、toast。
3. **加载与等待**：骨架屏、按钮内 spinner、小龙虾存在条。
4. **内容揭示**：modal/下拉/侧栏的出现与消失、新数据进入列表。

一切动效必须能回答"它告诉了用户什么状态"。回答不了 = 删除。

### MOT-C2 硬性禁动清单

- **页面加载编排**：路由切换、首屏渲染，禁止任何 stagger/飞入/缩放开场。内容就位即显示（数据揭示见 MOT-L1，那是 fetch 完成的状态变化，不是页面开场）。
- **装饰动效**：背景粒子、常驻浮动、图标无事件自转、渐变流动。
- **悬停炫技**：hover 3D 倾斜、放大超过 1.02、hover 触发的连锁动画。
- **bounce / elastic / overshoot**：所有弹簧必须 `bounce: 0`。
- **无限循环**：仅两处合法循环——按钮内 loading spinner、小龙虾存在条（MOT-H5）。`SpinnerGap className="spin"` 目前在 `LoadingState`（`ui.tsx:140`）作居中大 spinner 使用，迁移时**必须替换为骨架屏**，spinner 只保留在 `Button loading` 内。

```tsx
// ❌ DON'T：页面开场编排
<motion.main initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
  {page}
</motion.main>

// ✅ DO：页面直接渲染；只有异步数据到位这个"状态变化"允许一次整体淡入
<main>{loading ? <ProjectGridSkeleton /> : <motion.div {...listReveal}>{cards}</motion.div>}</main>
```

### MOT-C3 时长与属性预算

- 微交互 120–240ms；英雄时刻整条时间轴 ≤ 600ms。
- 只允许动 `transform` 与 `opacity`。唯一例外：三处 L2 玻璃浮空层（小龙虾侧栏、全部 modal、顶栏）允许**存在** `backdrop-filter`，但 **blur 数值本身永不参与动画**（进出场动它所在元素的 opacity/transform）。
- 缓动：ease-out 指数族（quart/quint/expo）或 `bounce: 0` 弹簧。禁 ease-in-out 用于入场，禁 linear（除 spinner 旋转与光标闪烁）。

### MOT-C4 Motion 库引入边界

| 场景 | 用什么 | 理由 |
|---|---|---|
| hover/focus/active/disabled 的颜色、边框、透明度 | 纯 CSS transition | 七态是样式层职责，不进 JS |
| 按钮按压缩放、开关滑块 | 纯 CSS transition（transform） | 单元素单属性，CSS 足够 |
| toast、modal、下拉、报价卡的挂载/卸载 | Motion `AnimatePresence` | React 卸载动画只有 Motion 能做 |
| 进度条高亮滑移、视频网格 FLIP | Motion `layout` / `layoutId` | FLIP 手写易错 |
| 金额数字滚动 | Motion `animate()`（mini API） | 数值插值 |
| 五个英雄时刻 | Motion（编排、delay 链） | 多元素时间轴 |
| 小龙虾存在条呼吸 | 纯 CSS `@keyframes`（opacity） | 无限循环放 CSS，可被 `animation-play-state` 暂停 |

```tsx
// ❌ DON'T：用 Motion 做 hover 变色
<motion.button whileHover={{ backgroundColor: "var(--surface-3)" }} />

// ✅ DO：七态交给 CSS，Motion 只管挂载/卸载与编排
// button.css: .button { transition: background-color var(--dur-fast) var(--ease-out-quart); }
```

打包纪律：全站用 `LazyMotion` + `domAnimation` + `m` 组件，禁止直接散用 `motion.div`（bundle 红线）：

```tsx
// src/design/motion-provider.tsx
import { LazyMotion, domAnimation } from "motion/react";
export const MotionProvider = ({ children }: { children: React.ReactNode }) => (
  <LazyMotion features={domAnimation} strict>{children}</LazyMotion>
);
// 业务代码一律 import { m, AnimatePresence } from "motion/react" 并使用 <m.div>
```

### MOT-C5 reduced-motion 全覆盖（无例外）

CSS 侧统一降级 + JS 侧统一工厂，**禁止**每个组件各写一份判断。

```css
/* tokens.css —— 唯一真源 */
:root {
  --dur-fast: 120ms; --dur-base: 180ms; --dur-slow: 240ms;
  --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
}
@media (prefers-reduced-motion: reduce) {
  :root { --dur-fast: 1ms; --dur-base: 1ms; --dur-slow: 1ms; }
}
/* 根级投影/低端机手动降级开关，与媒体查询等效 */
[data-motion="reduced"] { --dur-fast: 1ms; --dur-base: 1ms; --dur-slow: 1ms; }
```

```tsx
// src/design/motion.ts —— 所有 Motion 变体从这里取，禁止内联 transition 对象
import { useReducedMotion } from "motion/react";
export function useMotionPrefs() {
  const reduced = useReducedMotion()
    || document.documentElement.dataset.motion === "reduced";
  return { reduced };
}
```

```tsx
// ❌ DON'T：组件里裸写弹簧且无降级
<m.div animate={{ y: 0 }} transition={{ type: "spring", stiffness: 300 }} />

// ✅ DO：变体带降级分支，参数来自预设表
const { reduced } = useMotionPrefs();
<m.div variants={reduced ? fadeOnly : slideUpEnter} initial="hidden" animate="show" />
```

降级原则：**位移/缩放全部归零，只保留 ≤120ms 的 opacity 交叉淡化；循环动画替换为静态标识；数字滚动直接显示终值。**

---

## 2. 微交互预设（MOT-M）

### MOT-M1 统一弹簧参数表

唯一来源 `src/design/motion.ts`。使用 Motion 的 `visualDuration + bounce` 弹簧 API（时长可直接对账预算）：

```ts
// src/design/motion.ts
export const springs = {
  press: { type: "spring", visualDuration: 0.12, bounce: 0 },  // 按压回弹
  snap:  { type: "spring", visualDuration: 0.18, bounce: 0 },  // 开关/下拉/聚焦
  enter: { type: "spring", visualDuration: 0.24, bounce: 0 },  // 入场（toast/卡片/面板）
  hero:  { type: "spring", visualDuration: 0.45, bounce: 0 },  // 仅英雄时刻主元素
} as const;
export const exitTween = { duration: 0.12, ease: [0.25, 1, 0.5, 1] } as const; // 退场永远比入场快
```

| 交互 | 预设 | 属性 | 备注 |
|---|---|---|---|
| 按钮按压（`ui.tsx` Button 全变体） | CSS，等效 press | `scale 1→0.97` | `:active` 触发，CSS transition 即可 |
| 卡片悬停（project-card / shot-card / video-library 卡） | CSS，等效 snap | `translateY 0→-2px` + 描边变亮 | 禁放大、禁大柔影 |
| 开关 / checkbox 滑块 | CSS，等效 snap | `translateX` | |
| 输入聚焦（textarea/prompt 编辑器） | CSS | 描边色 + focus ring opacity | 只动颜色/opacity，不动布局 |
| toast 进出（`app.tsx` `.toast`） | Motion enter / exitTween | `opacity 0→1, y 12→0` | `AnimatePresence` |
| 下拉展开（storyboard 页 `.dropdown-menu`） | Motion snap / exitTween | `opacity 0→1, scale 0.96→1`，transform-origin 顶部 | |
| modal 进出（`ui.tsx` Modal 全部） | Motion enter / exitTween | 面板 `opacity+y 16→0`；backdrop `opacity` | 连播 modal 例外走 MOT-H3 |
| 小龙虾侧栏开合（`.assistant-panel`） | Motion enter / exitTween | `x 100%→0` 的 transform 滑入 | 现实现是 class 切换，迁移为 AnimatePresence |

代码片段（toast，标准范式，其余照抄结构）：

```tsx
import { AnimatePresence, m } from "motion/react";
import { springs, exitTween } from "@/design/motion";

<AnimatePresence>
  {toast && (
    <m.div role="status" className={toastVariants({ kind: toast.kind })}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: exitTween }}
      transition={springs.enter}
    >…</m.div>
  )}
</AnimatePresence>
```

```tsx
// ❌ DON'T：给 toast 加 bounce 或超时长
transition={{ type: "spring", bounce: 0.4, visualDuration: 0.5 }}
// ❌ DON'T：条件渲染直接 {toast ? <div/> : null}（卸载无退场，闪断）
```

### MOT-M2 骨架屏

`LoadingState` 迁移为各页专用骨架（面板轮廓 + 1.6s 的 opacity 0.4↔0.7 呼吸，CSS keyframes，reduced 下静止在 0.55）。禁止居中大 spinner。骨架形状必须贴近真实内容轮廓（卡片网格出卡片形骨架，表格出行骨架）。

---

## 3. 五个英雄时刻（MOT-H）

通则：
- 每个英雄时刻是**一次性**编排，同一触发条件在同一会话内不重复播放（用 ref 记录已播 key）。
- 同屏最多 1 个英雄时刻。冲突时优先级：生成完成 > 报价确认 > 进度条前进 > 连播开幕 > 小龙虾（H5 是常态循环不算冲突）。低优先级方退化为 120ms 淡入。
- 每个英雄时刻的根元素挂 `data-hero="<name>"`、播放完成后置 `data-hero-state="settled"`，供 P4 Playwright 断言。
- reduced-motion 下：全部退化为 ≤120ms opacity，一次性辉光脉冲取消。

### MOT-H1 生成完成

**锚点**：`workbench-page.tsx`。`useTaskPolling`（3s 轮询）令 `imageTask/videoTask.status` 变为 `succeeded` 且 `media_results` 非空 → `MediaStage` 出现媒体 + `task-success` 面板 + CTA（视频侧为「去视频库选主版本」，见 line 342）。这是 UX 断点修复：用户必须被引导去选主版本。

**触发条件**：该 kind 的 task status 从 `pending|running` 变为 `succeeded` 且拿到 media_results。页面刷新后恢复的已完成任务（`recoverGenerationTask`）**不触发**编排，直接静态渲染。

**元素分解**：① MediaStage 媒体（img / video poster）② 辉光脉冲 overlay（媒体井 L3 边缘）③ task-success 状态面板 ④ 主 CTA 按钮。

**时间轴**（总长 560ms）：

| # | 元素 | 延迟 | 时长 | 属性 | 缓动 |
|---|---|---|---|---|---|
| 1 | 媒体 | 0 | 320ms | opacity 0→1, scale 0.98→1 | springs.hero |
| 2 | 辉光 overlay | 120ms | 480ms | opacity 0→0.9→0（keyframes，一次性） | ease-out-expo |
| 3 | task-success 面板 | 200ms | 240ms | opacity 0→1, y 8→0 | springs.enter |
| 4 | 主 CTA | 320ms | 240ms | opacity 0→1, scale 0.95→1 | springs.enter |

**Motion 实现要点**：

```tsx
// 辉光是合法用途之二（生成完成一次性提示）。禁止动 box-shadow 本身：
// 预合成一个带静态 box-shadow 的 overlay，只动它的 opacity。
<div className="media-stage" data-hero="generation-complete">
  <m.img initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}
         transition={springs.hero} src={url} alt="分镜生成结果" />
  {justCompleted && !reduced && (
    <m.div aria-hidden className="media-glow"  /* 静态 box-shadow: 0 0 0 1px var(--accent), 0 0 24px var(--accent-glow) */
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 0.9, 0] }}
      transition={{ duration: 0.48, delay: 0.12, ease: [0.16, 1, 0.3, 1], times: [0, 0.35, 1] }}
      onAnimationComplete={markSettled} />
  )}
</div>
```

```tsx
// ❌ DON'T
animate={{ boxShadow: "0 0 40px var(--accent)" }}        // 动 paint 属性
transition={{ repeat: Infinity }}                          // 辉光循环 = 违宪
if (recovered) playHero()                                  // 恢复态重播
```

**reduced-motion 降级**：媒体与面板 120ms 淡入；辉光脉冲取消，改为媒体井描边静态切换为 accent 色 2s 后还原（无动画，setTimeout 换 class）。CTA 立即可见。

**性能注意**：video 先渲染 poster（首帧图），入场动画结束前不 attach `controls` 焦点；辉光 overlay `pointer-events: none`；整条时间轴只有 opacity/transform。

### MOT-H2 生产进度条前进

**锚点**：`production-stepper.tsx` + `production-stepper.css`。步骤态 `complete/current/upcoming`（line 50–51）；`production-progress-changed` window 事件 + 15s 轮询触发 `refresh()`；`.production-stepper-next` 持有描述与主 CTA。

**触发条件**：`inferProductionProgress` 返回的 `currentIndex` **比上一次大**（用 `usePrevious` 比较）。15s 轮询结果 index 不变时零动画；index 变小（回退）时零动画直接切换。

**元素分解**：① 旧 current 步骤图标（数字→Check）② current 高亮胶囊（`layoutId` 滑移）③ next 区旧文案/CTA ④ next 区新文案 ⑤ 新主 CTA。

**时间轴**（总长 560ms）：

| # | 元素 | 延迟 | 时长 | 属性 | 缓动 |
|---|---|---|---|---|---|
| 1 | 旧步骤 数字→Check 交叉淡化，Check scale 0.6→1 | 0 | 160ms | opacity, scale | ease-out-quart |
| 2 | 高亮胶囊滑移到下一步 | 120ms | 300ms | transform（FLIP） | springs.hero |
| 3 | next 区旧内容 | 120ms | 120ms | opacity 1→0 | exitTween |
| 4 | next 区新描述 | 260ms | 200ms | opacity 0→1, x 8→0 | springs.enter |
| 5 | 新主 CTA | 320ms | 240ms | opacity 0→1, scale 0.97→1 | springs.enter |

**Motion 实现要点**：

```tsx
// 高亮滑移用 layoutId，让 Motion 做 FLIP，不手算坐标
{steps.map((step, i) => (
  <li key={step.key} className={stateOf(i)}>
    {i === progress.currentIndex && (
      <m.span layoutId="stepper-active" className="stepper-active-pill"
              transition={reduced ? { duration: 0 } : springs.hero} />
    )}
    …
  </li>
))}
```

```tsx
// ❌ DON'T
window.addEventListener("production-progress-changed", playHero) // 事件≠前进，必须比较 index
animate={{ left: nextX }}                                        // 动布局属性
```

**reduced-motion 降级**：胶囊瞬移（duration 0），Check 与新文案 120ms 淡入，CTA 无 scale。

**性能注意**：进度条是 sticky 常驻元素，胶囊 FLIP 期间 Motion 自动加 will-change，结束自动移除；不要在 stylesheet 里给 `.production-stepper` 写死 will-change。

### MOT-H3 连播开幕

**锚点**：`operations-pages.tsx` `EpisodePlaybackModal`（line 192–248）：`Modal size="wide"`、`.playback-layout`、`.playback-player` 内 `<video autoPlay>`、`.playback-playlist` 列表。由分镜页「本集连播与交付」或工作台头部按钮打开。

**触发条件**：modal 打开且 `clips.length > 0`（有可播主版本）。loading / 空态打开时只走 MOT-M1 标准 modal 入场，**不演开幕**。

**元素分解**：① backdrop（全域压暗，电影"灯光熄灭"）② L2 玻璃 modal 面板升起 ③ 播放器 L3 黑幕 cover 淡出（"银幕亮起"）④ 播放列表条目 stagger。

**时间轴**（总长 590ms）：

| # | 元素 | 延迟 | 时长 | 属性 | 缓动 |
|---|---|---|---|---|---|
| 1 | backdrop | 0 | 200ms | opacity 0→1 | ease-out-quart |
| 2 | 玻璃面板 | 80ms | 320ms | opacity 0→1, y 24→0 | springs.hero |
| 3 | 播放器黑幕 cover | 240ms | 320ms | opacity 1→0 | ease-out-expo |
| 4 | 播放列表条目 | 280ms 起，step 30ms，最多前 6 条 | 各 160ms | opacity 0→1, y 6→0 | springs.enter |

**Motion 实现要点**：

```tsx
// 黑幕 cover 覆盖在已 autoPlay 的 video 之上，只动 cover 的 opacity，
// 不延迟 video 播放本身（声音/进度从 0ms 就开始）。
<div className="playback-player" data-hero="playback-open">
  <video autoPlay … />
  {!reduced && <m.div aria-hidden className="screen-cover" /* 纯黑，absolute 满铺 */
    initial={{ opacity: 1 }} animate={{ opacity: 0 }}
    transition={{ delay: 0.24, duration: 0.32, ease: [0.16, 1, 0.3, 1] }} />}
</div>
```

```tsx
// ❌ DON'T
animate={{ backdropFilter: "blur(12px)" }}   // blur 数值禁动
transition={{ delayChildren: 0.28, staggerChildren: 0.03 }} // 可以，但列表>6条时禁止逐条排队
{clips.map((c, i) => <m.button transition={{ delay: 0.28 + i * 0.03 }} …>)} // 20 镜=880ms 超预算
// ✅ DO：i >= 6 的条目 delay 固定钉在第 6 条的值
const d = 0.28 + Math.min(i, 5) * 0.03;
```

**reduced-motion 降级**：backdrop 与面板 120ms 淡入，无 y 位移；cover 与 stagger 取消，首帧直接可见。

**性能注意**：backdrop-filter 只存在于 modal 面板一层；video `preload="metadata"` 维持现状；cover 是独立合成层（opacity），不遮挡 video 解码。

### MOT-H4 报价确认

**锚点**：两处同一编排——`workbench-page.tsx` `GenerationQuoteModal`（line 372）与 `app.tsx` `AssistantGenerationQuoteCard`（line 409）。金额 `formatCost(estimated_cost_fen)`，Geist Mono + `tabular-nums`。

**基调**：付费郑重感。无弹跳、无彩带、无辉光。只有"数字落定 → 按钮就绪"两拍。

**触发条件**：报价数据首次呈现（modal 打开 / 报价卡从 SSE 流入）。同一 `generation_quote_id` 只播一次；`refreshPendingQuote` 换新报价时金额从旧值滚到新值（300ms），不重播整卡。

**元素分解**：① 容器（modal 面板或卡片）② 金额数字 ③ 确认按钮（蓄力态→就绪态）。

**时间轴**（总长 600ms）：

| # | 元素 | 延迟 | 时长 | 属性 | 缓动 |
|---|---|---|---|---|---|
| 1 | 容器 | 0 | 240ms | opacity 0→1, y 16→0 | springs.enter |
| 2 | 金额 0→终值滚动后定格 | 80ms | 400ms | 数值插值（textContent，非 DOM 属性动画） | ease-out-expo |
| 3 | 确认按钮蓄力→就绪 | 480ms | 120ms | 内层 accent 填充 opacity 0→1, scale 0.98→1 | ease-out-quart |

**Motion 实现要点**：

```tsx
import { animate } from "motion";           // mini API，不走 React 渲染
function useAmountRoll(fen: number, reduced: boolean) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (reduced) { el.textContent = formatCost(fen); return; }
    const controls = animate(0, fen, {
      delay: 0.08, duration: 0.4, ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => { el.textContent = formatCost(Math.round(v)); },
    });
    return () => controls.stop();
  }, [fen, reduced]);
  return ref;
}
// <strong ref={amountRef} className="font-mono tabular-nums" aria-hidden="true" />
// 旁边放 visually-hidden 的静态终值给屏幕阅读器，滚动区 aria-hidden。
```

蓄力态定义：按钮**全程可点击、全程是 primary 语义**，只是 accent 填充层 opacity 在 480ms 前保持 0.55（视觉未满）；就绪拍把填充推满。用户提前点击 → 金额立即 snap 到终值并直接提交流程。

```tsx
// ❌ DON'T
<Button disabled={rolling}>确认并生成</Button>   // 用动画时长阻塞付费操作
animate={{ scale: [1, 1.05, 1] }} transition={{ repeat: Infinity }} // 按钮脉冲循环
digits.map(d => <m.span animate={{ y: -d * lineHeight }} />)         // 老虎机逐位滚轮，轻佻且费帧
```

**reduced-motion 降级**：金额直接显示终值；按钮直接就绪态；容器 120ms 淡入。

**性能注意**：`onUpdate` 写 textContent 不触发 React 重渲；`tabular-nums` 保证滚动期间零布局抖动；过期倒计时（现有 1s interval）保持纯文本刷新，不加动画。

### MOT-H5 小龙虾工作中

**锚点**：`app.tsx` `AssistantPanel`：SSE `api.streamAgentMessage` 产生 `text_delta` / `generation_quote` 事件；消息 `status: "streaming"`；`role: "tool"` 消息与报价卡插入列表（`addAssistantQuoteMessage`）。这是 agent 红橙色**唯一**的动效载体。

**元素分解**：① 存在条（assistant-header 底边 2px，agent 红橙）② 工具调用/报价卡条目流入 ③ streaming 光标。

**编排**（②按事件到达触发，无固定总时长）：

| # | 元素 | 触发 | 时长 | 属性 | 缓动 |
|---|---|---|---|---|---|
| 1 | 存在条呼吸 | busy 或存在 streaming 消息期间 | 循环 2000ms | opacity 0.35→0.9→0.35 | CSS ease-in-out |
| 2 | 工具条目/报价卡流入 | 每条 SSE 事件到达时 | 200ms | opacity 0→1, y 8→0 | springs.enter |
| 3 | streaming 光标 | 消息 streaming 期间 | CSS 1s steps(2) | opacity | steps |

**实现要点**：

```css
/* 呼吸放 CSS：无限循环不进 Motion；agent 色只在此出现 */
.agent-presence { background: var(--agent); opacity: 0.35; }
.assistant-panel.working .agent-presence { animation: agent-breathe 2s ease-in-out infinite; }
@keyframes agent-breathe { 50% { opacity: 0.9; } }
@media (prefers-reduced-motion: reduce) {
  .assistant-panel.working .agent-presence { animation: none; opacity: 0.7; } /* 静态在场 */
}
```

```tsx
// 条目流入：AnimatePresence initial={false}——历史消息回填（api.agentMessages）不动画
<AnimatePresence initial={false}>
  {messages.map((msg) => (
    <m.article key={msg.id} layout="position"
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }} transition={springs.enter}>…</m.article>
  ))}
</AnimatePresence>
```

```tsx
// ❌ DON'T
{delta.split("").map(ch => <m.span …>)}   // 逐字动画：SSE 本身就是动态，再动是噪音
.assistant-panel { animation: glow … }     // agent 色配辉光 = 违反辉光双用途红线
面板关闭后呼吸继续跑                          // 必须随 .working/open class 停止
```

**reduced-motion 降级**：呼吸→静态 0.7 opacity 条 +「工作中」文字徽标；条目 120ms 淡入。

**性能注意**：呼吸是单元素 opacity，合成器直通；面板 `closed` 时移除 `.working`（`animation-play-state` 归停）；SSE 高频 `text_delta` 只更新文本节点，不为每次 delta 创建 motion 值。

---

## 4. 列表编排（MOT-L）

**锚点**：项目卡 `.project-card`（global-pages.tsx line 217）、分镜卡 `.shot-grid > .shot-card`（project-pages.tsx line 475/494）、视频网格 `.video-library-grid`（workbench-page.tsx line 474）、项目资产 `.project-asset-grid`。

### MOT-L1 首次数据揭示

fetch 完成、骨架换真实内容：**容器整体一次淡入（180ms）+ 前 8 个条目 stagger（step 30ms，各 160ms，opacity + y 6→0）**，第 9 项起 delay 钉在第 8 项。这是"数据到位"状态变化，不是页面开场；同一列表在一次路由停留内只揭示一次（翻页/筛选不算首次）。

```tsx
const revealDelay = (i: number) => Math.min(i, 7) * 0.03;
```

### MOT-L2 筛选与翻页

筛选条件变化（资产筛选、集切换）：`AnimatePresence mode="popLayout"`，退场 120ms opacity、入场 160ms opacity，**无 stagger、无位移**。频繁操作不配编排。

### MOT-L3 新条目插入（FLIP）

新生成的视频进入 `.video-library-grid`、新导入分镜进入 `.shot-grid`：

```tsx
<LayoutGroup>
  {items.map((item) => (
    <m.article key={item.id} layout                 // 既有条目 FLIP 让位（纯 transform）
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, transition: exitTween }}
      transition={springs.enter}>…</m.article>
  ))}
</LayoutGroup>
```

```tsx
// ❌ DON'T
<m.article layout …>  // 网格 > 30 项仍开 layout：一次插入触发 30 个 FLIP
// ✅ DO：items.length > 30 时关闭 layout，新条目只做自身淡入
<m.article layout={items.length <= 30} …>
```

### MOT-L4 主版本切换

视频库「设为主版本」（`onPrimary`）：徽标与按钮态 120ms CSS 交叉淡化；卡片**不重排、不移动**（当前实现顺序不变，保持）。若未来主版本置顶，重排走 MOT-L3 的 layout FLIP，禁额外强调动画——状态徽标就是强调。

### MOT-L5 拖拽排序（分镜 `DotsSixVertical` 预留）

启用时用 Motion `Reorder`；拖起仅 `scale 1.02 + 描边变亮`，落位 springs.snap。禁旋转、禁投影放大。

---

## 5. 性能预算（MOT-P）

| 规则 | 预算 |
|---|---|
| MOT-P1 属性白名单 | 只动 transform/opacity。backdrop-filter 仅静态存在于三处 L2 玻璃。任何 PR 出现 width/height/top/left/margin/box-shadow/filter 参与动画 = 返工 |
| MOT-P2 will-change | 禁止写进 stylesheet 常驻。Motion 自动管理；手写 CSS transition 元素如需，只允许通过 `:active`/`.is-animating` 临时 class 加、动画结束移除 |
| MOT-P3 同屏并发 | 常驻循环 ≤2（小龙虾存在条 + 至多一个按钮 spinner）；单次编排参与元素 ≤12；英雄时刻同屏 ≤1（冲突按 MOT-H 通则降级） |
| MOT-P4 列表阈值 | stagger 逐条上限 8；layout FLIP 参与上限 30；超限直接整体淡入 |
| MOT-P5 低端机与投影 | `prefers-reduced-motion` 为第一开关；另提供根级 `data-motion="reduced"` 手动开关（设置项「投影/演示模式」），两者走同一套 tokens 降级（MOT-C5），不写第二套逻辑。可选增强：`navigator.hardwareConcurrency <= 4` 时自动置 `data-motion="reduced"`，但不得覆盖用户显式选择 |
| MOT-P6 帧预算 | 英雄时刻期间禁止并发 setState 风暴：H1/H2 的触发 effect 内先播动画后 dispatch 数据刷新（现有 `production-progress-changed` 已是事件解耦，保持）；SSE 流入条目用 `layout="position"` 而非全量 layout |
| MOT-P7 测试钩子 | 每个英雄时刻根元素 `data-hero` + 完成后 `data-hero-state="settled"`；Playwright 回归在 `data-motion="reduced"` 下跑功能断言，另设一条真机动效冒烟走查五个英雄时刻 |

```css
/* ❌ DON'T */
.project-card { will-change: transform, opacity; }        /* 常驻合成层，内存白烧 */
.modal-layer { transition: backdrop-filter 300ms; }        /* 动 blur = GPU 灾难 */
```

---

## 附：迁移对照表（现状 → 目标）

| 现有实现 | 文件锚点 | 迁移动作 |
|---|---|---|
| `LoadingState` 居中 spinner | `ui.tsx:140` | 换页面级骨架屏（MOT-M2） |
| `.toast` 直接条件渲染 | `app.tsx:148` | AnimatePresence 进出场（MOT-M1） |
| `.assistant-panel open/closed` class 切换 | `app.tsx:381` | Motion transform 滑入滑出 + `.working` 呼吸（MOT-H5） |
| `ProductionStepper` 状态瞬切 | `production-stepper.tsx:50` | layoutId 胶囊 + 前进编排（MOT-H2），须比较 currentIndex |
| `MediaStage` 结果瞬现 | `workbench-page.tsx:420` | 生成完成编排（MOT-H1），恢复态不重播 |
| `GenerationQuoteModal` / `AssistantGenerationQuoteCard` 静态金额 | `workbench-page.tsx:372` / `app.tsx:409` | 金额滚动 + 蓄力按钮（MOT-H4），按 quote_id 去重 |
| `EpisodePlaybackModal` 标准 modal | `operations-pages.tsx:192` | 开幕编排（MOT-H3），空态/loading 不演 |
| `VideoLibrary` 网格瞬变 | `workbench-page.tsx:474` | LayoutGroup FLIP（MOT-L3） |

未决事项（需用户拍板后写入合同）：H4 蓄力态的 480ms 视觉延迟是否保留（付费郑重感 vs 极速党）；`data-motion="reduced"` 是否作为设置页正式选项交付于 V0.1.1。

---

普查与规格所需代码已全部读完（基线 `git show 95272eb`，含 `ui.tsx`、`app.tsx`、`pages/*.tsx`、`styles.css` 全文），以下为组件合同矩阵章节。

---

# 组件合同矩阵（design-system.md · 组件章节草案）

**普查基线**：commit `95272eb`，路径前缀 `frontend/shortdrama-rag-demo/src/`。行号均指已提交版。
**例外声明**：`production-stepper.tsx`、`production-progress.ts` 在 95272eb 尚未提交（仅存在于工作区，untracked）。ProductionStepper 规格以工作区实现为组件化输入，迁移时以本规格为合同，不以该临时实现为准。
**合同效力**：本章节每张表的"归宿"列即迁移指令；变体矩阵即验收面。新增 variant、改 token 引用、改红线，须走 design-system.md 变更审批（决策 8）。

---

## 1. 组件普查表

### 1.1 归宿 A：shadcn 原语 copy-in（表现层重建，逻辑照抄）

| # | 现役模式 | 证据（文件:行） | 现状问题 | 归宿 |
|---|---|---|---|---|
| A1 | Button（primary/secondary/accent/danger/ghost + loading） | `ui.tsx:14-35`；样式 `styles.css:62-85` | 变体靠字符串拼类名；accent 橙与"唯一强调色"冲突 | **shadcn Button** 重建，CVA 矩阵见 2.1；`accent` 变体删除 |
| A2 | IconButton | `ui.tsx:37-43`；`styles.css:87-98` | 与 Button 平行实现，焦点/禁用态不同源 | 并入 Button：`size="icon"`，独立组件删除 |
| A3 | Modal（small/medium/large/wide，Esc + 遮罩点击关闭） | `ui.tsx:45-65`；`styles.css:289-316` | 无焦点陷阱、无 scroll lock、遮罩 `mousedown` 判定脆弱；`.assistant-visible .modal-layer` 偏移 hack（`styles.css:298`） | **shadcn Dialog（Radix）**，L2 玻璃，尺寸映射见 2.4 |
| A4 | 原生 `<select>` × 9 处 | `global-pages.tsx:311-313,330`；`project-pages.tsx:117-120`；样式 `styles.css:252` | 原生下拉在暗色下不可控（怪异表单控件红线） | **shadcn Select（Radix）** |
| A5 | 原生 input / textarea | `global-pages.tsx:92-93,201-202`；`project-pages.tsx:319-320`；`workbench-page.tsx:290,297`；样式 `styles.css:319-327,368-370` | 无统一 error/disabled 态；`input-with-icon` 是登录页私有写法 | **shadcn Input / Textarea**，`leadingIcon` 进入 Input 规格 |
| A6 | checkbox-field（设为主版本勾选） | `project-pages.tsx:321`；`styles.css:440-442` | 原生 checkbox 无暗色态 | **shadcn Checkbox + Label** |
| A7 | Toast（info/success/error，4.2s 自动关） | `app.tsx:68,104-107,138`；`styles.css:742-745` | 单条互斥、z-index 100（禁 999 同族问题）、无队列 | **shadcn Toast（Radix Toast）**，见 2.5 |
| A8 | StatusBadge（字符串猜语义） | `ui.tsx:78-101`；`styles.css:100-114` | 中英文混猜 `["ready","已入库"].includes(...)`，新增状态静默落 warning | **shadcn Badge** 原语 + 自建 StatusBadge 显式映射（见 2.6 与红线 5.2） |
| A9 | 表格 × 3（用户费用/费用明细/导入预览） | `operations-pages.tsx:92,254-256`；`project-pages.tsx:436`；样式 `styles.css:644-652,514-517` | 两套表样式并存 | **shadcn Table**，mono 数据列规范见 2.7 |
| A10 | segmented-control × 4（项目状态/资产 scope/回收站/剧本集） | `global-pages.tsx:185-188,306`；`operations-pages.tsx:176`；`project-pages.tsx:393`；样式 `styles.css:198-208` | 同一模式四处手写；"回收站"按钮混进 segmented（`global-pages.tsx:187`，导航混入筛选） | **shadcn Tabs** `variant="segmented"`；导航按钮移出 |
| A11 | asset-kind-tabs（带计数） | `global-pages.tsx:316-318`；`project-pages.tsx:122-126`；样式 `styles.css:259-270` | `role="tab"` 但无键盘循环；active 满饱和实底（红线：非活动态外禁满饱和，active 也应降档） | **shadcn Tabs** `variant="pill"`，计数用 Badge |
| A12 | scope-tabs（引入资产弹窗内） | `project-pages.tsx:141`；`styles.css:400-402` | 与 A10 长相不同、行为相同 | 合并进 Tabs `segmented`（同一动作同一长相） |
| A13 | 手写下拉菜单（分镜"更多"） | `project-pages.tsx:401`；`styles.css:477-481` | 无 outside-click 关闭、无键盘导航、z:10 裸数 | **shadcn DropdownMenu（Radix）** |
| A14 | `title=` 充当禁用解释 × 10+ 处 | `app.tsx:186-187,194`；`workbench-page.tsx:292,299`；`project-pages.tsx:119-120,274` 等 | 原生 title 延迟 1s+、触屏不可见；违反"disabled 必给去处" | **shadcn Tooltip（Radix）**，裸 `title` 全站禁用（见 2.10） |
| A15 | 加载态 = 居中 spinner | `ui.tsx:124-126`（LoadingState）；`app.tsx:120`（app-boot）；`styles.css:59-60,349` | 骨架屏红线：列表/卡片加载不许居中 spinner | **shadcn Skeleton**（新增），LoadingState 删除，见 2.11 |
| A16 | 项目卡进度条 | `global-pages.tsx:229-230`；`styles.css:242-245` | 手写 div 轨道 | **shadcn Progress**，语义并入 ProductionStepper 步骤口径 |
| A17 | 原生 `<progress>`（看板排行/趋势） | `operations-pages.tsx:66,76` | 原生控件默认样式不可控 | shadcn Progress 的 `data` 变体（mono 数值 + 轨道），禁原生 `<progress>` |
| A18 | 用户菜单 user-pill（点击即登出！） | `app.tsx:174,195`；`styles.css:154-165` | 点头像直接 logout，无确认 | DropdownMenu trigger 化：菜单含"退出登录"项 |

### 1.2 归宿 B：自建业务组件（tokens → primitives 之上）

| # | 现役模式 | 证据 | 归宿 |
|---|---|---|---|
| B1 | 生产进度条 | `production-stepper.tsx:15-56`（工作区）；步骤定义 `production-progress.ts:3-9`；推导 `production-progress.ts:31-37` | **ProductionStepper**（3.1） |
| B2 | 分镜卡 | `project-pages.tsx:421-428`；`styles.css:499-508` | **ShotCard**（3.2） |
| B3 | 任务三态块 | `ui.tsx:103-122`；`styles.css:551-557` | **TaskState**（3.3） |
| B4 | 报价确认弹窗 | `workbench-page.tsx:325-361`；`styles.css:560-571` | **QuoteConfirmDialog**（3.4） |
| B5 | 助手报价卡（侧栏内联） | `app.tsx:360-404`；`styles.css:716-734` | **QuoteCard**：与 B4 共用 QuoteSummary 解剖（3.4 附） |
| B6 | 媒体容器 × 5 套（AssetThumb / MediaThumb / MediaStage / 视频库 video / 连播 player） | `ui.tsx:150-155`；`project-pages.tsx:333-337`；`workbench-page.tsx:363-369`；`workbench-page.tsx:411`；`operations-pages.tsx:236`；样式 `styles.css:273-275,543-547,581,671-672` | **MediaWell**（3.5），五套统一 |
| B7 | 小龙虾侧栏 + FAB + 欢迎态 + 消息流 + 工具流 | `app.tsx:200-358`（面板）、`app.tsx:137`（FAB）；`styles.css:692-741` | **AssistantPanel**（3.6） |
| B8 | 视频库弹窗 | `workbench-page.tsx:371-414`；`styles.css:579-584` | **VideoLibrary**（3.7） |
| B9 | 空态 | `ui.tsx:139-148`；`styles.css:349-354` | **EmptyState** 教学型（3.8） |
| B10 | 本集连播弹窗 | `operations-pages.tsx:192-248`；`styles.css:670-690` | **PlaybackModal**：Dialog(wide) + MediaWell + 播放列表；"连播开幕"英雄时刻挂接见 3.9 |
| B11 | 错误态面板 | `ui.tsx:128-137` | **ErrorState** 保留自建（icon + 原因 + 重试 secondary） |
| B12 | 提示条 × 6 种（inline-note / form-error / cost-notice / offline-banner / workbench-error / assistant-error） | `styles.css:328-330,586-600,166-178,558-559,738-739` | **Callout** 一个组件收编：`tone: info\|warning\|danger` × `layout: inline\|banner\|floating`；硬禁左彩条写法 |
| B13 | 上传区 × 3 | `global-pages.tsx:325-328`；`project-pages.tsx:306-317,413`；`styles.css:332-347` | **UploadDropzone**：空/已选/校验失败/上传中四态 |
| B14 | 指标卡 | `operations-pages.tsx:250-252`；`styles.css:601-615` | **StatCard**：Geist Mono 数值 + tabular-nums；tone 收敛为 `neutral|accent|success|warning`（现 blue/green/orange 五彩删除） |
| B15 | 分镜分页器 | `app.tsx:186`；`styles.css:522-524` | **ShotPager**：现为硬编码 1-6 假分页，接真实 shot 列表后按 Button `size="icon"` 组合 |
| B16 | 集列表侧栏 | `project-pages.tsx:392-397`；`styles.css:468-472` | **EpisodeRail**（列表项 = 选中态 + mono 集号） |
| B17 | 面包屑 | `project-pages.tsx:271`；`styles.css:411-412` | **Breadcrumb** 轻量自建 |
| B18 | 标签/chip | `global-pages.tsx:348`；`project-pages.tsx:404`；`styles.css:284-288,487-488` | Badge `variant="tag"`（静默）与 `variant="chip"`（带 icon），不再两套色 |
| B19 | 删除确认内容块 | `global-pages.tsx:207,336`；`operations-pages.tsx:187`；`styles.css:665-668` | **ConfirmDestructive**：Dialog 内容预制件（danger icon + 后果说明 + danger 按钮），三处措辞统一 |
| B20 | 生成参数只读披露（16:9 / 2K / Seedream…） | `workbench-page.tsx:292,299` | **ParamChip**：只读参数不该是 disabled Button；chip + Tooltip 说明"V0.1 固定" |
| B21 | 剧本折叠块 | `project-pages.tsx:403`；`styles.css:482-484` | **ScriptSummary**：保留原生 `<details>`，只换 token |

### 1.3 归宿 C：删除

| # | 模式 | 证据 | 理由 |
|---|---|---|---|
| C1 | `Field`（字符串 children 自动变只读 input） | `ui.tsx:67-76` | 魔法行为，全站仅隐式使用；Label + Input 组合替代 |
| C2 | `GlobalHeaderActions` | `global-pages.tsx:359-367` | 死代码，无任何引用 |
| C3 | `LoadingState` | `ui.tsx:124-126` | 被 Skeleton 替代（A15） |
| C4 | Button `accent` 变体（橙实底） | `styles.css:81-82`；使用点 `project-pages.tsx:294,328` | 与"唯一强调色薄荷青"冲突；"设为主版本"统一为 secondary + Star（见 5.2 动作词表） |
| C5 | 五彩装饰 tone（cover-tone-N / assetTone hash / metric 五色） | `global-pages.tsx:216`；`ui.tsx:227-230`；`operations-pages.tsx:52-56` | 非活动态满饱和红线；占位统一井内灰阶 + accent 单色（第 4 节） |
| C6 | 裸 z-index 家族（10/25/34/36/50/100） | `styles.css:478,692,740,558,749,742` | 换语义 z 阶梯 token：`--z-dropdown(10) < --z-sticky(20) < --z-modal-backdrop(30) < --z-modal(40) < --z-toast(50) < --z-tooltip(60)` |
| C7 | `generation-loop` 静态示意块（用真 StatusBadge 摆假状态） | `project-pages.tsx:405`；`styles.css:489-498` | 把状态组件当插画用，误导；由 ProductionStepper 取代其"流程说明"职责 |

---

## 2. 基础组件规格

通用约定：所有组件必须交付七态 `default / hover / focus-visible / active / disabled / loading / error`；无该态语义的组件在 Storybook 标注 `N/A + 理由`，不许留空。颜色只引用语义 token（值以 tokens.css 为唯一真源，全部 OKLCH，配对对比度先算后交付）。类名禁任意值（`h-[38px]` 之类 CI 拦截）。

### 2.1 Button（完整版）

变体矩阵：

| variant \ size | sm (h-8) | md (h-9，默认) | lg (h-10) | icon (9×9) |
|---|---|---|---|---|
| **primary**（薄荷青实底，每页至多一个） | ✓ | ✓ | ✓ | ✗（primary 必带文字动词） |
| **secondary**（L1 面板 + 1px 描边，默认） | ✓ | ✓ | ✓ | ✓ |
| **ghost**（无底，工具行为） | ✓ | ✓ | ✓ | ✓ |
| **danger**（danger 弱底 + danger 文字） | ✓ | ✓ | ✓ | ✓ |
| **agent**（小龙虾红橙，仅 AssistantPanel 子树内可用，lint 圈禁） | ✓ | ✓ | ✗ | ✓ |

七态：hover 换 `-hover` token；focus-visible 用 `ring-2 ring-focus`（禁 outline 3px 旧写法 `styles.css:78`）；active 位移 0、只换色（禁 bounce）；disabled `opacity-50 pointer-events-none` + 必须由外层 Tooltip 给去处；loading 时 spinner 顶替 icon、锁宽、`aria-busy`；error 态 N/A（由表单/Callout 承载，Storybook 标注）。辉光只允许 primary 的 hover/active（决策 4 合法用途一）。

```tsx
// src/components/ui/button.tsx
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { SpinnerGap } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap select-none",
    "rounded-lg font-medium transition-colors duration-150 ease-out-quart",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1",
    "disabled:pointer-events-none disabled:opacity-50",
    "aria-busy:pointer-events-none",
    "[&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active " +
          "hover:shadow-glow-accent active:shadow-glow-accent", // 辉光合法用途之一
        secondary:
          "bg-surface-2 text-text-1 border border-stroke-1 hover:bg-surface-3 hover:border-stroke-2",
        ghost: "text-text-2 hover:bg-surface-2 hover:text-text-1",
        danger:
          "bg-danger-muted text-danger border border-danger-stroke hover:bg-danger-muted-hover",
        agent: "bg-agent text-on-agent hover:bg-agent-hover", // 仅 AssistantPanel 内
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4 text-sm",
        lg: "h-10 px-5 text-sm",
        icon: "size-9 px-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
}

export function Button({
  className, variant, size, asChild, loading = false, icon, children, disabled, ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <SpinnerGap className="animate-spin motion-reduce:animate-none" aria-hidden /> : icon}
      {children}
    </Comp>
  );
}
```

don't（现状）：``<button className={`button button-${variant}`}>``（`ui.tsx:30`，字符串拼接绕过类型与审计）。
do：CVA 变体 + `asChild` 承接"打开项目"这类链接按钮（`global-pages.tsx:231` 现在是裸 button 假装链接）。

### 2.2 Input / Textarea（差异点）

- 矩阵：`size: sm|md` × `tone: default|mono`；`mono` 用于任务 ID、幂等键、金额输入（Geist Mono + tabular-nums）。
- 结构：`<InputGroup>` 提供 `leadingIcon` 槽（收编登录页 `input-with-icon`，`global-pages.tsx:92-93`）。
- 七态：error 态由 `aria-invalid` 驱动 `border-danger + ring-danger-muted`，配套 `<FieldError role="alert">`（收编 `form-error`，`global-pages.tsx:94`）；placeholder 用 `--text-3` 且对比度必须 ≥4.5:1（红线，禁目测）；loading N/A 标注。
- don't：`<div className="input-with-icon">` 私有壳；do：`<InputGroup icon={<User />}><Input autoComplete="username" /></InputGroup>`。

### 2.3 Select（差异点）

- Radix Select；Trigger 与 Input 同高同描边（同一表单行等高强制）。
- Content：**L1 实心面板 + 1px 半透明描边 + 阴影**，`z-(--z-dropdown)`。玻璃只许三处浮空层，下拉不在其列（红线）。
- 禁用项必须 `<SelectItem disabled>` + Tooltip 说明（替代 `project-pages.tsx:119-120` 的 disabled 整个 select + title）。
- 七态：error 同 Input；loading 态 = trigger 内 Skeleton 短条。

### 2.4 Dialog（差异点）

- 尺寸：`sm(560) | md(720) | lg(900) | wide(1080)`，映射现 `modal-small/medium/large/wide`（`styles.css:310-312`）。
- 材质：面板 = **L2 玻璃**（`bg-glass + backdrop-blur + border-glass-stroke`，backdrop-filter 是玻璃浮层唯一动效属性豁免）；遮罩 `bg-scrim z-(--z-modal-backdrop)`，面板 `z-(--z-modal)`。遮罩居中，不再为侧栏偏移（删除 `styles.css:298` hack；侧栏 z 低于 modal-backdrop）。
- 动效：进出 opacity + scale 0.98→1，180ms ease-out-quint；`prefers-reduced-motion` 只留 opacity。
- Radix 自带焦点陷阱、Esc、`aria-labelledby`；关闭时若有进行中提交，`onInteractOutside` preventDefault（对应 `workbench-page.tsx:315-317` 的 busy 锁语义）。
- 七态：loading = footer 主按钮 loading；error = 内容区 Callout；其余交互态由子组件承载（标注）。

### 2.5 Toast（差异点）

- Radix Toast Viewport 固定底部居中，`z-(--z-toast)`；矩阵 `tone: info|success|error` × 单尺寸。
- L1 实心（Toast 不是玻璃三处之一）；success/error 用 `-muted` 弱底 + 语义文字色，禁满饱和实底。
- 队列上限 3，自动关 4s（对齐现 4.2s，`app.tsx:106`），hover 暂停；`role="status"`，error 用 `role="alert"`。
- 英雄挂接：报价确认成功的金额 mono 值由 QuoteConfirmDialog 经 Motion `layoutId="quote-amount"` 移交到 success toast（见 3.4）。

### 2.6 Badge（差异点）

- 矩阵：`variant: neutral | success | warning | danger | accent | agent | tag | chip` × `size: sm|md`。
- 所有语义变体 = `-muted` 弱底 + 语义前景，全部配对算对比度；圆角全圆（标签豁免 16px 上限）。
- `accent` 仅表"进行中/工作中"（青 = 正在进化），`agent` 仅 AssistantPanel 内。
- 七态：静态组件，hover/active/loading N/A 标注；带关闭钮的 chip 例外交付 hover/focus。
- StatusBadge 业务包装：显式穷举映射，禁字符串包含猜测。

```tsx
// don't（ui.tsx:80-86）：
const kind = ["ready","succeeded","complete","已完成","已入库"].includes(value) ? "success" : ...
// do：
const STATUS_MAP: Record<GenerationStatus | AssetStatus, { variant: BadgeVariant; label: string }> = {
  pending:   { variant: "neutral", label: "待处理" },
  running:   { variant: "accent",  label: "生成中" },
  succeeded: { variant: "success", label: "已完成" },
  failed:    { variant: "danger",  label: "失败" },
  cancelled: { variant: "neutral", label: "已取消" },
  ready:     { variant: "success", label: "已入库" },
  draft:     { variant: "warning", label: "待入库" },
}; // 未知 key：dev 抛错，prod 落 neutral + 原文
```

### 2.7 Table（差异点）

- shadcn Table；表头 `text-text-2 bg-surface-2`，行分隔 `border-stroke-1`，行 hover `bg-surface-2`。
- **mono 数据声**：时间戳、金额、次数、任务 ID 列一律 `font-mono tabular-nums text-right`（金额右对齐；现 `cost-table` 金额左对齐且仅 `font-variant-numeric` 局部生效，`operations-pages.tsx:255`）。
- 空态：表内 EmptyState `size="inline"`；loading：整表 Skeleton 行 ×5（禁 spinner）。

### 2.8 Tabs（差异点）

- 矩阵：`variant: segmented | pill` × `size: sm|md`。segmented = 一体轨道 + 滑动选中块（Motion layoutId，弹簧预设）；pill = 独立圆角项 + 计数 Badge。
- 选中态：`bg-surface-3 text-text-1 + 1px accent 下缘指示`（禁 `styles.css:269` 的满饱和实底反白）。
- 必须走 Radix Tabs 的 roving tabindex；现 `role="tab"` 无键盘（`global-pages.tsx:317`）为 don't 范例。
- URL 驱动的 tab（scope/kind）用受控 value + navigate，行为不变。

### 2.9 DropdownMenu（差异点）

- Radix；Content L1 实心，`z-(--z-dropdown)`；item 高 40px 对齐现状（`styles.css:479`）。
- `<DropdownMenuItem variant="destructive">` 承接"删除本集"（`project-pages.tsx:401` 的 `.danger`）。
- 禁用 item 必须可聚焦并带 Tooltip 去处。
- 七态：item 交付 hover(highlighted)/focus/disabled；loading N/A。

### 2.10 Tooltip（差异点）

- Radix Tooltip，`delayDuration=300`，Content 深灰实底（`--surface-inverse`）小圆角，`z-(--z-tooltip)`。
- **契约**：任何 `disabled` 交互元素必须包 `<TooltipDisabled reason="...">`（内部套 span 保证事件触发），文案 = 去处或解锁条件（29 号决议"disabled 必给去处"）。
- don't：`<Button disabled title="生成视频后才可下载">`（`app.tsx:187`）；do：`<TooltipDisabled reason="生成视频后可下载"><Button disabled icon={<FolderOpen />}>下载视频</Button></TooltipDisabled>`。
- CI 审计：`grep 'title=' src/ --include='*.tsx'` 应为 0（媒体元素除外）。

### 2.11 Skeleton（差异点）

- 矩阵：`shape: text | rect | media`；media 形态供 MediaWell 井内使用（纯黑底上的 `--surface-2` 微光块）。
- 动效：opacity 脉动 1.2s（transform/opacity 白名单内）；reduced-motion 降为静态色块。
- 页面加载合同：列表页 = 卡片骨架 ×N 占位真实布局；工作台 = 三栏骨架。全站禁居中 spinner（替换 `ui.tsx:124-126`、`app.tsx:120`）；spinner 仅存于 Button loading 与 TaskState running 的行内小图标。

---

## 3. 业务组件规格

### 3.1 ProductionStepper（生产进度条）

- **职责**：项目内页面（资产/分镜/工作台/消耗）顶栏下方常驻，呈现五步流程 `导入分镜→生成图片→生成视频→选主版本→连播交付`（`production-progress.ts:3-9`），并给出"下一步"唯一 primary CTA。29 号方案的组件化。
- **解剖**：`<section aria-label="项目生产进度">` = ① 步骤轨道 `<ol>`（节点：完成=Check 图标 / 当前=mono 序号 + accent 环 / 未来=mono 序号灰阶；节点间 1px 连接线）② 行动区（description 一句话 + primary 按钮，`production-stepper.tsx:53`）。整体 L1 面板。
- **状态机**：组件级 `loading(骨架条) → ready | error(Callout inline + 重试)`；每步 `complete | current | upcoming`；`currentIndex` 由 `selected_image_result_id / selected_video_result_id + 已持久化媒体` 推导（`production-progress.ts:31-37`，types 依据 `types.ts:252-253`）。数据信号沿用 `production-progress-changed` 事件 + 15s 轮询（工作区实现 `production-stepper.tsx:36-37`）。
- **token**：complete/current 前景 `--accent`；current 环 `--accent-muted`；upcoming `--text-3`；连接线 `--stroke-1`（完成段 `--accent`）；序号 Geist Mono。
- **英雄动效挂接（英雄时刻二）**：`currentIndex` 增大时：完成段连接线 `scaleX 0→1`（origin-left，420ms ease-out-quint）→ 新节点 Check 弹簧落位（统一弹簧预设）→ 行动区文案交叉淡入。总时长 ≤600ms，仅在 index 前进时触发一次；reduced-motion 直接切换终态。回退（index 减小）无动效。

### 3.2 ShotCard（分镜卡）

- **职责**：分镜页网格单元，展示单镜进度并唯一入口进工作台。
- **解剖**：① MediaWell 缩略（16:9，L3；有已选图显示图，否则教学占位）② 标题行（`S{shot_no}` Geist Mono + 标题 + StatusBadge）③ 剧本摘录（2 行 clamp）④ footer 唯一动作"打开工作台"（ghost + ArrowRight）。删除现卡上的删除 IconButton（`project-pages.tsx:425`，动作是假的 notify 占位，移入 DropdownMenu 待引用检查接入）。
- **状态徽章推导**（替代现 `shot.status || "pending"` 直喂，`project-pages.tsx:425`）：

```tsx
function shotStage(shot: Shot): { variant: BadgeVariant; label: string } {
  if (!shot.selected_image_result_id) return { variant: "neutral", label: "待生图" };
  if (!shot.selected_video_result_id) return { variant: "accent",  label: "待生视频" };
  return { variant: "success", label: "已选主版本" };
} // 与 production-progress.ts:31-37 同一口径，禁止两套推导
```

- **状态机**：`skeleton → ready`；卡内不承载 error（页面级 ErrorState）。七态：hover（`border-stroke-2` + 缩略图亮度 +4%）、focus-visible ring（整卡可聚焦，Enter 进入）、active、其余 N/A 标注。
- **token**：卡 `bg-surface-1 border-stroke-1 rounded-xl`（≤16px 红线内）；镜号 `font-mono text-text-2`。
- **动效**：无英雄时刻；hover 过渡 150ms，禁位移。

### 3.3 TaskState（任务三态）

- **职责**：工作台内图片/视频任务的 进行中/失败/成功 反馈，失败带原因与重试（重试必须重新走报价，行为对齐 `workbench-page.tsx:291,298` 的 `onRetry→retryGeneration→quote`）。
- **解剖**：`<div role="status">`（failed 用 `role="alert"`）= 状态图标 + 标题 + 说明行 +（failed 时）重试按钮。文案合同：running 保留"可离开当前页，刷新后会从服务端恢复进度。"（`ui.tsx:119`，好文案，保）；failed 原因兜底"服务没有返回具体原因"（`ui.tsx:108`）。
- **状态机**：`pending → running → succeeded | failed(reason) → [重试] → pending`。pending 与 running 同视觉、不同标题（`ui.tsx:119`）。
- **token**：running `bg-accent-muted text-accent` + 行内小 spinner；succeeded `bg-success-muted text-success`；failed `bg-danger-muted text-danger`，重试按钮 `variant="danger"`。
- **英雄动效挂接（英雄时刻一：生成完成）**：`status` 从 running→succeeded 跃迁时触发 `onSucceeded`，由同区 MediaWell 播放一次性完成辉光（见 3.5）；TaskState 自身仅 Check 弹簧入场。辉光属"生成完成一次性提示"合法用途，只播一次，reduced-motion 降级为 2s 静态 accent 描边后消失。

### 3.4 QuoteConfirmDialog（报价确认）

- **职责**：付费同意书。生成/重试前展示冻结报价，确认后才提交任务（模态是最后手段的合法例外）。
- **解剖**（QuoteSummary 共享块，Dialog 与侧栏 QuoteCard 复用）：① 种类块（媒体 icon + "本次将生成 1 张图片 / 1 段 4 秒视频"）② 金额块（**Geist Mono、tabular-nums、大号**，`formatCost` 分→元）③ 明细 `<dl>`：有效期**倒计时**（mono 秒级，沿用 1s tick `workbench-page.tsx:331-335`；剩余 <60s 数字转 warning 橙）、报价状态 ④ notice（"这是预估费用，不是云平台实际账单。只有点击确认后才会提交付费任务"，`workbench-page.tsx:356`）⑤ error Callout ⑥ footer：取消 + 唯一 primary。
- **状态机**（对齐 `workbench-page.tsx:53,215-273`）：`ready → confirming → submitting → (成功关闭) | failed(可再次提交) | expired(CTA 变"重新获取报价"→refresh)`。**防重复合同**：busy 中禁关禁重复点（`workbench-page.tsx:217,316`）；服务端 `consumed` 视为已提交、不再扣费并提示（`workbench-page.tsx:225-233`）；过期错误码 `GENERATION_QUOTE_EXPIRED / quote_stale / GENERATION_QUOTE_CONFLICT` 归入 expired（`workbench-page.tsx:250-251`）；状态更新前比对 quote_id 防串单（`workbench-page.tsx:234,252`）。侧栏 QuoteCard 额外持有 sessionStorage 已提交记忆（`app.tsx:447-467`），提交后按钮永久锁定并展示 mono 任务编号。
- **token**：金额 `text-text-1 font-mono`；金额块底 `bg-surface-2`（禁现橙色暖底 `styles.css:566-570`，橙只留给 warning 语义）。
- **英雄动效挂接（英雄时刻四）**：confirming→成功：金额块 Check 弹簧脉冲 → Dialog 淡出 → 金额 mono 值以 `layoutId="quote-amount"` 移交至 success toast。全程 ≤600ms；reduced-motion 直接关闭 + toast。

### 3.5 MediaWell（媒体井，L3）

- **职责**：全站图片/视频唯一容器。统一替换五套实现（普查 B6）。
- **解剖**：井框（`bg-media-well` 纯黑、`rounded-xl`、内容 `object-contain`）+ 内容层四选一：`image | video | placeholder(教学) | skeleton`；`ratio: 16:9 | 9:16 | 1:1 | auto`；`size: thumb | stage | full`。
- **状态机**：`empty(教学占位) | loading(Skeleton media) | loaded(240ms opacity 入场) | failed(井内 danger icon + 重试)`。教学占位文案 do 范例保留：`"图片确认后，再填写视频提示词生成"`（`workbench-page.tsx:368`）；don't："暂无图片"。
- **token**：井底 `--media-well`（纯黑，全站唯一纯黑）；占位 icon `--text-3` 单色（替代 `assetTone` 五彩 hash，`ui.tsx:227-230`）；井内文字与纯黑底对比 ≥4.5:1。
- **英雄动效挂接（英雄时刻一承载体）**：`celebrate` prop 置真播一次性完成辉光：井外圈 `shadow-glow-accent` 0→1→0（600ms ease-out-expo）+ 新媒体 opacity/scale 入场；播完自动复位，不入常态样式。这是辉光第二个合法用途，且仅此处。

### 3.6 AssistantPanel（小龙虾侧栏）

- **职责**：SSE 对话 + 四类受限工具 + 报价卡；全站唯一 agent 色域。
- **解剖**：L2 玻璃浮空层（三处玻璃之一），`z-(--z-sticky)`：① header：agent 色圆点头像 + "小龙虾" + context chip（`app.tsx:333` 的 label）+ 历史/关闭 ghost icon ② conversation：欢迎教学空态（EmptyState 变体：四工具 chip，`app.tsx:336`）、消息流（user 右对齐 / assistant 左 / tool 行）、ToolCallRow（mono 工具名 + 状态点）、QuoteCard（3.4 附）③ composer：Textarea + 发送 primary（薄荷青；agent 色不做操作色，只做存在感——决策 2）。collapsed 态 = FAB（agent 色描边 + ChatCircleDots，收编 `app.tsx:137`）。
- **agent 存在条实现红线**：存在感 = 头像点 + header 名字 + 工作中呼吸，**禁左缘彩色粗边条**（硬禁项）。
- **状态机**：`closed ⇄ open`；open 内 `idle | streaming | error(composer 上方 Callout + 重试上一条，对齐 app.tsx:352) | demo(禁发 + 说明)`。会话按 context key 隔离并从服务端恢复（`app.tsx:213-240`）。
- **token**：面板 `bg-glass backdrop-blur border-l border-glass-stroke`；agent 点/呼吸 `--agent`；消息气泡 `bg-surface-2`。
- **英雄动效挂接（英雄时刻五：小龙虾工作中）**：streaming 期间 header 头像点做 agent 色呼吸脉冲（opacity 0.6⇄1，1.6s 循环）+ 正文流式光标；FAB 折叠时若有任务进行，同样呼吸。stream 结束呼吸停。reduced-motion：呼吸换静态 agent 点 + "正在处理"文字。开合动效：transform translateX，200ms ease-out-quart（现移动端已有雏形 `styles.css:749`）。

### 3.7 VideoLibrary（视频库 + 设主版本）

- **职责**：单镜全部已持久化视频的网格，选定主版本供连播交付。
- **解剖**：Dialog(lg) 内 2 列网格；每项 = MediaWell(video, 9:16/16:9 auto) + meta 行（StatusBadge "当前主版本"/"已持久化" + mono 时间戳）+ footer（"设为主版本" secondary + Star；"下载" ghost + Tooltip，无 storage_url 时 disabled 给去处，对齐 `workbench-page.tsx:411`）。
- **状态机**：`empty(教学：真实任务完成并持久化后会出现在这里) | list`；item 级 `settingPrimary / downloading` busy 锁（`workbench-page.tsx:379-407`）；主版本互斥更新回写两处 state（`workbench-page.tsx:307-310`）。
- **token**：主版本项 `border-accent + ring-1 ring-accent-muted`（替代 `styles.css:584` 阴影模拟）。
- **动效**：设主版本成功 = "当前主版本" Badge 以 `layoutId="primary-badge"` 从旧项弹簧飞至新项（微交互，非英雄，≤240ms）。**连播开幕英雄时刻不在本组件**，见 3.9。

### 3.8 EmptyState（教学型空态）

- **职责**：每个"空"都回答三件事：这是什么、为什么是空的、下一步点哪。
- **解剖**：`icon(井灰阶) + 标题(动词句) + 一句话 + 唯一 CTA(该页 primary 或 secondary) + steps?: [string×3]`（可选三步引导，数字 Geist Mono 圆标）。矩阵 `size: page | panel | inline`。
- **状态机**：静态组件；七态除 CTA 外 N/A 标注。
- **文案合同**：禁"暂无数据/无内容"。do 范例（现有代码达标句保留）："还没有项目｜新建项目后即可管理资产、导入分镜并开始生成"（`global-pages.tsx:192`）；don't："没有符合条件的资产。"若无 CTA 必须给调整建议（`global-pages.tsx:320` 已给"调整关键词或筛选条件后再试"，合格）。
- **token**：icon 盒 `bg-surface-2 text-text-3`；禁 accent 实底 icon 盒（现 `styles.css:352` 青底为 don't）。

### 3.9 附：PlaybackModal 英雄挂接（连播开幕，英雄时刻三）

组件本体 = Dialog(wide) + MediaWell(stage) + 播放列表（普查 B10，解剖沿 `operations-pages.tsx:229-247`）。开幕编排：遮罩落下 → 井从纯黑亮入首帧（opacity）→ 播放列表项 60ms 级联入场（≤4 项参与级联）→ 自动播放。总时长 ≤600ms，只在打开时播一次；reduced-motion 全部直接呈现。连播自动切集（`operations-pages.tsx:236` onEnded 循环）切换时仅 crossfade 120ms。

---

## 4. 图标与插画

1. **Phosphor 沿用**（现状唯一图标源，证据：全部页面 import `@phosphor-icons/react`，`app.tsx:1-28`、`ui.tsx:1-9` 等）。默认 `weight="regular"`；选中/激活态允许 `weight="fill"`；同一图标在同一组件内不得混 weight。
2. **尺寸档**（token 化，禁逐处写 px）：`icon-xs 16`（按钮/输入/表格内联）、`icon-sm 20`（IconButton、列表项）、`icon-md 24`（TaskState、Callout）、`icon-lg 32`（EmptyState、占位）、`icon-xl 48`（登录页/欢迎态，现 `styles.css:346,703` 的 48/50 收敛为 48）。
3. **禁手绘 SVG**：禁止内联 `<svg><path .../></svg>` 与项目内自绘图标文件；语义缺口先查 Phosphor，确实没有则走 design-system.md 审批新增映射，仍从 Phosphor 近义项选。
4. **动作-图标绑定表**归 5.2 词表管辖：同一动作全站同一图标（现状反例：设主版本一处 `Star`（`project-pages.tsx:294`）一处 `CheckCircle`（`workbench-page.tsx:411`））。
5. **媒体占位策略**：一律走 MediaWell placeholder（井内灰阶 icon + 教学一句话）；删除彩底 hash tone（`ui.tsx:227-230`）与封面随机双图标（`global-pages.tsx:217` 的 `index % 3` 花活）。项目封面无图时 = 井底 + FilmSlate 灰阶 + 项目名首字 mono，确定性、无彩底。
6. **无插画系统**：V0.1.1 不引入插画资产；空态表达力全部由"图标 + 文案 + CTA"承担，不得为空态生成装饰图。

---

## 5. 组件红线

### 5.1 七态齐全检查清单（每组件 Storybook 出厂门禁）

| 态 | 验收标准 | 常见现状违例 |
|---|---|---|
| default | 只用语义 token；对比度已计算（正文 ≥4.5:1，大字/粗体 ≥3:1，placeholder ≥4.5:1） | 硬编码色 40+ 处（如 `styles.css:500,558,697`） |
| hover | 仅换色/辉光（primary 限定），无位移；150-250ms ease-out | — |
| focus-visible | `ring-2 ring-focus`，键盘可达；Radix roving 生效 | 手写 tabs 无键盘（`global-pages.tsx:317`） |
| active | 即时反馈，禁 bounce/elastic | — |
| disabled | `opacity-50` + **必有 Tooltip 去处**；不许用 disabled 表达"只读参数"（用 ParamChip） | `title=` 充当去处（普查 A14） |
| loading | 骨架优先；行内才许 spinner；`aria-busy`；锁宽防跳动 | 居中大 spinner（`ui.tsx:124-126`） |
| error | 有原因、有出路（重试/修改入口）；`role="alert"` | 空态与错误态混用无重试路径 |
| （空态） | 教学三件套，禁"暂无数据" | — |

无某态语义 → Storybook 该 story 显式 `N/A + 一句理由`；缺 story 或留空 = 不交付。每个含动效的态必须附 `prefers-reduced-motion` story。

### 5.2 "同一动作全站同一长相"审计规则

**动作词表**（合同，节选核心行；按钮文案一律动词+宾语）：

| 动作 | label | icon | variant | 现状违例（迁移时修正） |
|---|---|---|---|---|
| 设为主版本 | 设为主版本 | Star | secondary | 三处三样：accent+Star（`project-pages.tsx:294`）、accent（`project-pages.tsx:328`）、primary+CheckCircle（`workbench-page.tsx:411`） |
| 进入回收站 | 打开回收站 | Trash | ghost | segmented 内假 tab（`global-pages.tsx:187`）、Archive icon（`global-pages.tsx:303`）、danger 变体（`project-pages.tsx:113`） |
| 移入回收站 | 移入回收站 | Trash | danger | 一致，保留 |
| 永久删除 | 确认永久删除 | Trash | danger + ConfirmDestructive | 一致，保留 |
| 重试（任务/请求） | 重试 | ArrowClockwise | danger（任务失败）/ secondary（读取失败） | 侧栏裸 button（`app.tsx:352`） |
| 提交生成 | 获取报价 →（弹窗内）确认并生成 | ImageSquare/VideoCamera → CheckCircle | primary | 一致，保留两段式措辞 |
| 刷新数据 | 刷新数据 | ArrowClockwise | ghost | "刷新数据"/"刷新"不一致（`operations-pages.tsx:48,175`） |
| 引入资产 | 引入资产 | UserPlus | 该页 primary 或 secondary | 详情页与列表页 variant 漂移（`project-pages.tsx:274` vs `:113`） |

**审计执行**：
1. 词表以 29 号词汇表为上游，存于 design-system.md；新增动作先入表后写码。
2. CI 三条 grep 门禁：`title=`（应 0，媒体标签除外）；`z-\d{3,}`（应 0）；`className=.*\$\{`（禁字符串拼变体）。
3. Storybook 出"动作墙"页：同一动作在所有出现页的按钮并排截图，P3 每页冷启动走查时人工比对。
4. 每页唯一 primary 审计：P3 逐页数 primary，>1 即返工（现状违例：AssetDetailPage 三个高亮动作并列，`project-pages.tsx:274`；分镜工具栏 primary + accent 项目导航同屏，`app.tsx:194` + `styles.css:386`）。
5. 独特性抽查：任一页面截图去 logo 后仍能凭"薄荷青强调 + agent 红橙存在感 + 场记板/暗房/媒体井隐喻 + mono 数据声"识别为本产品，否则判定坠入通用暗色模板，返工。

---

**遗留声明**：`production-stepper.tsx`、`production-progress.ts` 未提交，迁移前需先入库（否则 P3 验收流程无基线可 diff）；`GlobalHeaderActions`（`global-pages.tsx:359-367`）为死代码，随迁移删除。

---

# V0.1.1 设计系统应用与迁移合同（已批准冻结,2026-07-15）

状态：已批准冻结（裁决见〇.2）。依据：`docs/contracts/v0.1/` 三份冻结合同的写法（中文标题、表格、可执行的规范句、示例代码块）、`frontend/shortdrama-rag-demo/src/` 当前实现、`design-qa.md` 走查惯例、已拍板的九项决策与设计纪律。本文写给执行迁移的 AI 代理（codex），每条规则给出可判定的验收方式；do/don't 违反即返工。

执行者注意：本文引用的九项决策与设计纪律由用户拍板，不得在迁移中"顺手优化"掉。任何与本文冲突的临时想法，先提案（见治理章节），不先改代码。

---

## 0. 范围与真源

- 改动范围：`frontend/shortdrama-rag-demo/` 表现层全部；逻辑层、数据层、`src/api.ts`、`src/types.ts`、`src/routing.ts`、`src/production-progress.ts`、`src/generation-quotes.ts`、`src/generation-task-recovery.ts`、`src/storyboard.ts`、`src/asset-media.ts`、全部 `*.test.ts` 零改动。
- 唯一真源：`src/styles/tokens.css`（新建）。任何颜色、圆角、阴影、时长、z 值只允许在这一个文件定义；组件与页面只消费语义 token。
- 依赖冻结：Tailwind v4、shadcn（copy-in，含 Radix）、Motion（motion.dev）、Geist（自托管文件），到此为止。`cva`/`clsx`/`tailwind-merge` 视为 shadcn copy-in 的固有依赖。Storybook 只进 devDependencies。其他任何 npm 包都需要用户批准。
- 主题：全部 token 语义化命名（`--surface-1`、`--accent`），值挂在 `:root`（暗色）下；V0.1.1 只交付暗色，但选择器结构预留 `[data-theme="light"]`，不得写死 `dark:` 前缀式思维。

### 0.1 语义 token 名单（页面映射表引用它们；具体 OKLCH 数值在 P1 的 design-system.md 中冻结，冻结前必须逐对计算对比度，不许目测）

| 组 | token | 用途 | 示例锚点（待验证） |
|---|---|---|---|
| 底幕 | `--surface-0` | L0 深灰底幕基色，配 body 径向渐变+暗角 | `oklch(0.15 0.01 250)` |
| 面板 | `--surface-1` | L1 实心面板 | `oklch(0.19 0.012 250)` |
| 面板嵌套 | `--surface-2` | L1 内嵌套块、hover 底 | `oklch(0.23 0.012 250)` |
| 玻璃 | `--surface-glass` | L2，仅三处浮空层 | `oklch(0.19 0.012 250 / 0.72)` + blur |
| 媒体井 | `--surface-well` | L3 纯黑 | `oklch(0 0 0)` |
| 文本 | `--text-1` / `--text-2` / `--text-3` | 主文/次文/弱文，占位符也用 `--text-3` | 三档对 `--surface-1` 均 ≥4.5:1 |
| 描边 | `--border-1` / `--border-2` | 1px 半透明描边 / 强描边 | `oklch(1 0 0 / 0.08)` / `/ 0.14` |
| 强调 | `--accent` / `--accent-hover` / `--accent-active` / `--accent-soft` / `--text-on-accent` | 全站唯一强调色：暗底荧光薄荷青 | `oklch(0.86 0.14 172)`，按钮文字用深色 `--text-on-accent` |
| agent | `--agent` / `--agent-soft` | 小龙虾红橙，只用于助手存在感 | `oklch(0.70 0.18 38)` |
| 状态 | `--success` / `--warning` / `--danger` + `-soft` | 标准语义 | 前景对 soft 底 ≥4.5:1 |
| 焦点 | `--focus-ring` | 全站统一 focus-visible | 基于 `--accent` 的半透明环 |
| 圆角 | `--radius-sm: 6px` / `--radius-md: 10px` / `--radius-lg: 16px` / `--radius-pill: 999px` | 卡片上限 16px；标签/按钮可 pill | |
| 字阶 | `--text-12/14/17/20/24/29`（rem 表达） | 固定 rem 阶梯，步进比 ≈1.2，正文基准 14 | 非 clamp 流式 |
| 字族 | `--font-sans` / `--font-mono` | Geist+中文栈 / Geist Mono | 见 P1 |
| z 阶 | `--z-dropdown:10` `--z-sticky:20` `--z-modal-backdrop:30` `--z-modal:40` `--z-toast:50` `--z-tooltip:60` | 禁 999/9999 | |
| 动效 | `--duration-fast:150ms` `--duration-base:200ms` `--duration-slow:240ms`；`--ease-out-quart: cubic-bezier(.25,1,.5,1)` `--ease-out-expo: cubic-bezier(.16,1,.3,1)` | 英雄时刻上限 600ms 只在 Motion 编排中出现 | 禁 bounce/elastic |

微交互统一弹簧预设（Motion）：`src/components/motion/springs.ts` 导出唯一一组 `{ press, reveal, hero }`；组件不得自带 transition 参数。

```ts
// do — 唯一弹簧真源
export const springs = {
  press:  { type: "spring", stiffness: 500, damping: 34 },   // 按压/开关，感知 ~150ms
  reveal: { type: "spring", stiffness: 300, damping: 30 },   // 面板/卡片进场，~240ms
  hero:   { type: "spring", stiffness: 170, damping: 26 },   // 五个英雄时刻，≤600ms
} as const;

// don't — 组件里手写 transition={{ duration: 0.45, ease: "easeInOut" }} 或 bounce
```

---

## 1. 逐页材质映射表

通用规则（先于所有页面）：
- L0：`body` 上一次性实现（径向渐变+暗角），页面组件不再各自铺底。
- L1：所有卡片/面板 = `bg-[--surface-1] + 1px --border-1`，禁"1px 描边 + ≥16px 大柔影"同元素并用，禁左/右彩色粗边条。
- L2 玻璃全站只有三处：顶栏（`GlobalHeader`/`ProjectHeader`/`workbench-header`）、小龙虾侧栏（`AssistantPanel`）、全部 Modal（`Modal` 组件一处实现，所有弹窗自动继承）。dropdown-menu、toast、报价卡、生产进度条一律 L1 实心。
- L3 媒体井纯黑：所有放图/放视频的容器。图片视频"坐"在纯黑里，不加描边渐变装饰。
- "唯一 primary" 的作用域 = 一个视图层（页面主体 / 单个 modal / 侧栏各算一层）。同一层内同一时刻至多一个薄荷青实心按钮。报价确认类"付费同意"按钮属于所在 modal/卡片层，不与页面主体冲突。
- disabled 必给去处：保留现有 `title` 说明开放条件的做法，全站不得出现无解释的 disabled。
- 每页正文、占位符、soft 底上的状态文字全部按 4.5:1 验证；大字/粗体 3:1。

| 页面 | 文件（组件） | L0–L3 分配 | 唯一 primary（状态驱动） | 密度档 | 专属注意点 |
|---|---|---|---|---|---|
| 登录/注册 | `pages/global-pages.tsx`（`LoginPage`） | L0 全屏可见（全站唯一允许"品牌时刻"的页面：暗角+径向渐变最强表达，可加一次性的场记板品牌区）；登录卡 L1；无 L2/L3 | 提交按钮"登录"/"创建并登录"。"进入离线演示"永远 secondary | 舒展 | 表单 input 底色须比 `--surface-1` 再深一档并保证输入文字 ≥7:1（长时间使用第一屏）；错误 `role="alert"` 用 `--danger` 文字直接放 L1 上，不做红底大块 |
| 项目列表 | `global-pages.tsx`（`ProjectsPage`、`ProjectCard`） | 页面 L1 卡片网格；项目封面区改 L3 纯黑（现在是 `#34444b` 色块+图标，改为纯黑媒体井待真实封面）；新建/删除 Modal L2 | "新建项目"（空态时空态内的"新建项目"是同一动作，工具栏那颗降级 secondary，二选一渲染） | 标准 | 进度条用 `--accent` 单色，禁五色 cover-tone 系列（`cover-tone-0..4` 删除）；卡片 hover 只允许描边亮起+背景升 `--surface-2`，禁辉光 |
| 资产中心 | `global-pages.tsx`（`AssetCenterPage`、`AssetCard`） | 卡片 L1；缩略图区 L3；上传/删除 Modal L2 | personal："新建资产"；common：筛选表单的"查询"（common 无写操作） | 密集 | 现状 personal 有"新建资产"+"查询"两颗 primary，违反唯一 primary——"查询"在 personal 降 secondary。`asset-tone-1..4` 彩色占位删除，占位统一 L3+图标 `--text-3` |
| 项目资产 | `pages/project-pages.tsx`（`ProjectAssetsPage`） | 同资产中心；引入资产 Modal L2，picker 卡 L1 | "引入资产"。Modal 内每张候选卡"确认引入"为 accent-outline（描边强调），只有 hover/focus 卡片升实心，保证视觉上同屏只有一颗实心 | 密集 | 类型 tab 计数用 `--font-mono`+`tabular-nums`；"回收站"按钮现为 danger 实心，降为 ghost+danger 文字（非活动态禁满饱和） |
| 资产详情 | `project-pages.tsx`（`AssetDetailPage`） | 主图/版本缩略图 L3；面板 L1；上传/预览 Modal L2 | 状态驱动：无版本→"上传图片"；有版本→"设为主版本"（当前非主版本的候选，accent-outline 收敛为聚焦升实心，同项目资产规则） | 标准 | 只读态（通用资产）不做灰蒙层，用 `--text-3` 文案+禁用按钮带 `title` 去处；"新建变体" disabled 保留 title 引导 |
| 分镜页 | `project-pages.tsx`（`StoryboardPage`、`ShotCard`、`ImportPreview`） | 剧集 rail 与分镜卡 L1；分镜卡预览区 L3；导入/连播 Modal L2 | 生产进度条的下一步按钮是项目内页面的唯一 primary（29 号状态驱动）。页内"导入分镜 Excel"只在零分镜空态时是 primary（此时进度条同样指向导入，视觉上同一动作）；有分镜后工具栏"本集连播与交付"恒为 secondary，交付 CTA 由进度条在 delivery 阶段给出 | 标准偏密 | 导入预览表格：表头 `--text-2`、行号/镜号 mono；错误行不整行红底，用行首 `--danger` 指示+文字 |
| 分镜工作台 | `pages/workbench-page.tsx`（`WorkbenchPage`、`MediaStage`、`GenerationQuoteModal`） | 三栏面板 L1；`MediaStage` 图/视频井 L3 纯黑（空态也是纯黑+`--text-3` 教学文案）；报价 Modal L2 | 状态驱动单主键：`selected_image_result_id`/无图片媒体→"生成图片"primary、"生成视频"secondary；有图后互换。报价 Modal 内"确认并生成"是该 modal 的 primary（付费同意，模态例外条款） | 密集 | 表单对比度重点页：textarea 提示词是主要劳动对象，输入文字对输入底 ≥7:1、占位符 ≥4.5:1；固定参数 disabled 按钮（16:9/2K/Seedream…）改为 mono 规格标签样式而非按钮，保留 title；费用、有效期、任务编号全部 `--font-mono`+`tabular-nums`。英雄时刻#1（生成完成）与 #4（报价确认）在此页 |
| 视频库 + 连播 | `workbench-page.tsx`（`VideoLibrary`）、`pages/operations-pages.tsx`（`EpisodePlaybackModal`） | 两个 Modal 本体 L2；video 元素与播放器区 L3 纯黑；播放列表条目 L1 | 视频库：未定主版本时候选卡"设为主版本"按 accent-outline/聚焦升实心规则；连播 modal 无页面级 primary（播放器即主体），"下载 JSON/CSV"secondary | 密集 | 英雄时刻#3（连播开幕）：modal 进场+首镜起播编排 ≤600ms；播放顺序编号、模型名、费用 mono；主版本用 `--accent` 描边+badge 表达，不用满饱和绿色块 |
| 回收站 | `operations-pages.tsx`（`TrashPage`） | 列表行 L1；确认 Modal L2 | 无页面级 primary（防误操作页，有意为之）："恢复"secondary，"永久删除"danger-outline；确认 Modal 内"确认永久删除"是 modal 层唯一主键（danger 实心） | 标准 | 空态是教学空态（"删除的项目和个人资产会出现在这里"已合格，保留）；删除时间 mono |
| 数据看板 + 项目消耗 | `operations-pages.tsx`（`DashboardPage`、`ProjectCostsPage`、`MetricCard`、`CostAttemptTable`） | 全部面板 L1；无 L2/L3 | 无 primary（纯读页）；"刷新数据"secondary | 数据密集档 | 数据 mono 化重点页：所有金额、计数、日期、attempt 编号 `--font-mono`+`tabular-nums` 右对齐；`MetricCard` 的 `metric-blue/green/orange` 五彩 tone 删除，统一 L1+数值 `--text-1`，仅"预估总费用"允许 `--accent` 数值；`<progress>` 条重做为 token 色单色条；"预估费用非实际账单"提示用 `--warning` 文字非橙底大条 |
| 小龙虾侧栏 | `app.tsx`（`AssistantPanel`、`AssistantGenerationQuoteCard`、`assistant-fab`） | 侧栏整体 L2 玻璃（三处之一）；消息气泡 L1；报价卡 L1 | "发送"是侧栏层 primary（薄荷青）；报价卡"确认费用并提交"是卡内付费同意主键（薄荷青，与工作台报价一致——付费动作永远是产品强调色，不是 agent 色） | 紧凑 | `--agent` 红橙只用于存在感：侧栏标识"小龙虾"、assistant-fab、streaming 中的工作指示（英雄时刻#5 小龙虾工作中：红橙微光呼吸，仅 streaming 期间）；agent 色禁止用于任何按钮底色、边框强调或状态语义。SSE 流式文本不逐字动画，光标闪烁即可 |
| 壳层 | `app.tsx`（Header 三态、`offline-banner`、toast）、`production-stepper.tsx` | 顶栏 L2（三处之一）；生产进度条 L1 实心贴顶栏下；toast L1（`--z-toast`）；离线横幅 L1+`--warning` 文字 | 生产进度条的行动按钮（`progress.actionLabel`）——它就是项目内页面的唯一 primary，页面主体不再另设 | — | 英雄时刻#2（进度条前进）：步骤完成时 check 打勾+连接线推进，一次性播放；顶栏玻璃在 `@supports not (backdrop-filter: blur(1px))` 时退化为 `--surface-1` 实心 |

登录页"品牌时刻"边界（do/don't）：

```tsx
// do — 品牌时刻只在登录页：L0 渐变可以更强、品牌区可以有一次性 reveal 动画
<main className="login-page">        {/* 允许局部更深的径向渐变与暗角 */}
  <motion.section {...reveal} className="bg-surface-1 border border-border-1 rounded-lg" />

// don't — 把登录页的品牌渐变/大图带进项目内任何页面；don't 在登录页放霓虹描边、紫渐变、粒子背景
```

数据 mono 声（do/don't）：

```tsx
// do
<td className="font-mono tabular-nums text-right">{formatFen(item.estimated_cost_fen)}</td>
<code className="font-mono text-xs">{state.generationRequestId}</code>

// don't — 金额/ID/时间戳用默认字族，或给数字上装饰字体、渐变文字（gradient text 全站硬禁）
```

---

## 2. P1–P4 迁移剧本

前置（先于 P1，见第 4 章风险）：codex 当前有未提交 WIP（`git status`：`app.tsx`、`ui.tsx`、`styles.css`、`types.ts`、`project-pages.tsx`、`workbench-page.tsx` 修改中，`production-stepper.*`、`production-progress.*` 未跟踪）。P1 会重写 `styles.css` 并动 `app.tsx`，必须先让该 WIP 提交合入，再切 P1 分支。禁止在未提交 WIP 之上开工。

### P1 底座（一个 PR，不动任何页面视觉之外的行为）

动哪些文件：

| 动作 | 文件 | 内容 |
|---|---|---|
| 改 | `package.json` | devDeps: `tailwindcss@^4`、`@tailwindcss/vite`、`motion`、`class-variance-authority`、`clsx`、`tailwind-merge`（Radix 包随 P2 组件 copy-in 逐个进入） |
| 改 | `vite.config.ts` | `import tailwindcss from "@tailwindcss/vite"` → `plugins: [tailwindcss()]` |
| 新建 | `src/styles/tokens.css` | `@import "tailwindcss";` + `@theme` 映射全部 0.1 节 token；唯一真源 |
| 新建 | `src/styles/fonts.css` | Geist / Geist Mono `@font-face`（`woff2`，仅拉丁+数字子集，`font-display: swap`；文件放 `public/fonts/geist/`，自托管，不装 npm 字体包）；`--font-sans: "Geist", "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif; --font-mono: "Geist Mono", ui-monospace, monospace;` 全局 `font-variant-numeric: tabular-nums` 挂在数据类工具类上 |
| 新建 | `src/styles/base.css` | L0 底幕（body 径向渐变+暗角）、focus-visible 统一环、`::selection`、reduced-motion 全局闸（见下） |
| 新建 | `src/styles/index.css` | 依序 `@import` fonts/tokens/base |
| 改 | `index.html` | 删 `<link href="/src/styles.css">`；`theme-color` 改为 `--surface-0` 对应 hex；`<html lang="zh-CN">` 加 `class="dark"`（预留双主题的挂点） |
| 改 | `src/app.tsx` | 仅第一行加 `import "./styles/index.css";`（旧 `styles.css` 此阶段继续由谁引用？——改为在 `index.css` 末尾临时 `@import "../styles.css";` 保持旧页面可用，P3 逐页迁完后删除） |
| 新建 | `src/lib/cn.ts` | `clsx` + `tailwind-merge` |
| 新建 | `src/components/motion/springs.ts`、`src/components/motion/reduced.ts` | 弹簧真源 + `useReducedMotion` 包装 |
| 新建 | `docs/contracts/v0.1/design-system.md` | 合同级：冻结 token 数值（附每对前景/背景的对比度计算结果表）、四层材质、辉光两用途、z 阶梯、动效红线、独特性红线。写法对齐本目录三份合同 |
| 壳层变暗 | `src/app.tsx`（className）、`src/production-stepper.css` | 顶栏、进度条、侧栏容器、offline-banner、toast 换 token 类；这是 P1 唯一可见变化 |

reduced-motion 全局闸（P1 就位，之后每个动画默认被覆盖）：

```css
/* do — base.css 一处兜底 + Motion 侧 useReducedMotion 双保险 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
```

P1 验什么：
1. `npm run typecheck`、`npm run build` 全绿；根仓库 test runner 全绿（`src/*.test.ts` 未动即应全绿）。
2. 冷启动打开五个路由，旧页面在暗壳下仍可读可用（允许过渡期新暗壳+旧亮页面并存的丑，不允许功能损坏）。
3. `design-system.md` 中对比度表逐对有计算值（工具：OKLCH→sRGB→WCAG 比值），无一对目测。
4. Geist 断网可用（Network 面板无字体外链）；Windows 栈验证：无 PingFang 环境回落 HarmonyOS Sans/雅黑，数字仍是 Geist。
5. 回滚点：单 commit，revert 即回到纯旧样式。

### P2 组件 + Storybook（只建组件，不迁页面）

shadcn copy-in 清单与定制顺序（`src/components/ui/`；每个组件搬进来就重写为 token/CVA，禁保留 shadcn 默认灰紫色阶）：

1. `button.tsx` — CVA variants：`primary | secondary | ghost | danger | accent-outline`；size：`sm | md`；七态齐全（loading 内建 spinner，替代 `ui.tsx` 的 `Button`，props 签名保持 `variant/icon/loading` 兼容）。
2. `icon-button.tsx`（自建，非 shadcn）— 保持 `label` 必填（aria-label）。
3. `badge.tsx` — 承接 `StatusBadge` 的语义映射（success/danger/info/warning），soft 底+达标前景。
4. `input.tsx`、`textarea.tsx`、`select.tsx`（Radix Select）、`checkbox.tsx`（Radix）— 工作台表单对比度在此一次做对。
5. `dialog.tsx`（Radix Dialog）— 替代手写 `Modal`：焦点圈闭、Esc、遮罩点击、`--z-modal-backdrop/--z-modal`、L2 玻璃在此唯一实现；保持 `title/footer/size/onClose` 兼容层。
6. `dropdown-menu.tsx`（Radix）— 替代分镜页手写 `moreMenu` outside-click；L1 实心（不是玻璃）。
7. `tooltip.tsx`（Radix）— 承接现有 `title=` 的"disabled 去处"说明，`--z-tooltip`。
8. `tabs.tsx` / `segmented.tsx` — 资产类型 tab、scope 切换、回收站筛选。
9. `progress.tsx` — 看板排行条+项目卡进度。
10. `table.tsx` — 看板/费用/导入预览三处表格的密集数据样式（斑马线禁用，行 hover 升 `--surface-2`）。
11. `toast.tsx` — 现有自研 toast 换壳（不引 sonner，依赖冻结）。
12. `skeleton.tsx` — 列表/卡片骨架（骨架屏不用居中 spinner；`LoadingState` 仅保留给全页首载）。
13. 业务组件重构（`src/components/app/`）：`status-badge`（含中文状态词映射，逻辑从 `ui.tsx` 原样搬运）、`task-state`、`empty-state`（教学空态模板：图标+一句为什么+一个去处）、`metric-card`、`quote-card`（工作台 modal 与侧栏卡共用的报价展示体）、`production-stepper`、`media-stage`（L3 井）、`asset-thumb`。
14. `src/components/motion/hero/`：五个英雄时刻的编排组件：`generation-complete.tsx`（媒体井一次性辉光+成品淡入——辉光合法用途之二）、`stepper-advance.tsx`、`playback-open.tsx`、`quote-confirmed.tsx`、`agent-working.tsx`。

CVA 与任意值（do/don't）：

```tsx
// do — 变体一律 CVA，样式值全部来自 token 类
const button = cva("inline-flex items-center gap-2 rounded-md font-medium transition-colors", {
  variants: {
    variant: {
      primary: "bg-accent text-on-accent hover:bg-accent-hover",
      secondary: "bg-surface-2 text-text-1 border border-border-1 hover:border-border-2",
    },
    size: { sm: "h-8 px-3 text-sm", md: "h-9 px-4 text-sm" },
  },
});

// don't — 任意值类名（lint 目标）与条件字符串拼接
<button className={`h-[38px] px-[14px] ${active ? "bg-[#17c9a4]" : ""}`} />
```

辉光两个合法用途（do/don't）：

```css
/* do — 仅此两处 */
.button-primary:hover:not(:disabled) { box-shadow: 0 0 20px oklch(from var(--accent) l c h / .25); }
/* hero: generation-complete 一次性 600ms 后移除 */

/* don't — 卡片常驻辉光、focus 用辉光代替 ring、agent 色辉光按钮 */
```

Storybook 8 接入：`@storybook/react-vite`（Vite builder），`.storybook/main.ts` framework `react-vite`；`.storybook/preview.ts`：`backgrounds: { default: "surface-0" }`、导入 `src/styles/index.css`、全局 decorator 套 L0 底幕、docs 主题 dark。stories 四区目录即侧栏结构：

```
src/stories/
  0-tokens/        色板（含每对对比度值）、字阶、材质四层、z 阶、弹簧
  1-primitives/    button/input/dialog/… 每个组件一个七态矩阵 story（缺一态 CI 不过）
  2-business/      status-badge 全状态词、quote-card 五相位、stepper 五步、empty/error/task-state
  3-hero/          五个英雄时刻可回放 story，每个带 reduced-motion 对照开关
```

P2 验什么：七态矩阵逐组件截图走查；`quote-card` 的 ready/submitting/submitted/failed/expired 五相位与 `app.tsx`/`workbench-page.tsx` 现有状态机一一对应；Storybook 构建进 CI（`storybook build`）。回滚点：组件目录独立，未被页面引用前删除无副作用。

### P3 页面迁移（按验收流程，一页一 PR，每页冷启动走查）

顺序（对应用户真正走的一遍流程）：
1. 登录（`global-pages.tsx: LoginPage`）
2. 项目列表（`ProjectsPage`/`ProjectCard`）+ 壳层收尾（`GlobalHeader`/`ProjectHeader`）
3. 分镜页（`project-pages.tsx: StoryboardPage` + 导入 modal + `ProductionStepper`）
4. 分镜工作台（`workbench-page.tsx` + `GenerationQuoteModal`，英雄#1/#4）
5. 视频库 + 连播交付（`VideoLibrary`、`EpisodePlaybackModal`，英雄#3）
6. 小龙虾侧栏（`app.tsx: AssistantPanel`/`AssistantGenerationQuoteCard`/fab，英雄#5；放在连播后，因为报价流程两端此时都已是新组件）
7. 资产三页（`AssetCenterPage` → `ProjectAssetsPage` → `AssetDetailPage`）
8. 回收站（`TrashPage`）
9. 看板两页（`DashboardPage`、`ProjectCostsPage`，数据 mono 化）

每页迁移的统一验收标准：
- 冷启动走查（以冷启动一线同事视角）：进入本页 3 秒内能回答"我在哪、下一步做什么"；唯一 primary 与映射表一致；每个 disabled 有去处；loading/empty/error/retry 四态实测；空态是教学不是"暂无数据"。
- 对照原型可弃项（延续 `design-qa.md` 已有决议）：亮色主题整体废弃；五彩 cover-tone/asset-tone/metric-tone 废弃；neumorphic 阴影体系废弃；原型中无接口支撑的收藏/归档/生成流程细分数字维持"禁用+开放条件"不补假数据。
- 布局结构（分区、信息顺序、四区工作台、340px 侧栏、1440 桌面主档）不弃，保持与 design-qa 结论一致。
- 文案红线抽查：按钮动词+宾语；无 em dash；29 号词汇表生产语言优先（分镜/主版本/入库/连播交付等词不得被"通用后台话"替换）。

逻辑层零改动红线的核查方法（每页 PR 强制）：
1. 允许改动集：JSX 的 `className`、标签结构、`import` 来源从 `../ui` 换到 `@/components/*`、静态文案的样式包裹。禁止改动集：任何 hooks、事件处理器、`api.*` 调用、条件分支、`useResource` 依赖数组、状态机字符串。
2. 机械核查：

```bash
# 逻辑文件必须零 diff
git diff --stat main -- src/api.ts src/types.ts src/routing.ts src/*.ts ':!src/styles*' | grep -v '^$' && echo FAIL
# 页面文件 diff 中不得出现逻辑 token 的增删
git diff main -- src/pages/ src/app.tsx | grep -E '^[+-].*(useState|useEffect|api\.|await |navigate\(|sessionStorage)' \
  | grep -vE '^[+-].*className' && echo REVIEW-REQUIRED
```
   命中 REVIEW-REQUIRED 的行必须逐行人审确认只是行移动（结构调整导致），否则返工。
3. `npm run typecheck` + 根仓库测试全绿；`location-observer`、`production-progress-changed` 事件等测试锚点类名/事件名不得改名。

### P4 回归

Playwright 11 步脚本骨架（`frontend/shortdrama-rag-demo/e2e/v011-regression.spec.ts`；对真实服务跑，付费步骤遵守 runtime.md 付费闸门，默认 `ALLOW_PAID_GENERATION=false` 下断言 403/503 路径，真实生成只在最低成本验收窗口执行）：

| 步 | 动作 | 断言 |
|---|---|---|
| 1 | 注册并登录 | 跳转 `/projects`；token 生效（`me` 不 401）；登录页无 axe 严重违规 |
| 2 | 新建项目 | toast"项目已创建"；跳转分镜页；生产进度条 step1"导入分镜"为 current |
| 3 | 导入分镜 Excel：预览 | 预览表行数与 fixture 一致；有错误 fixture 时"确认导入"禁用 |
| 4 | 确认导入 | toast 含"已导入";进度条推进到"生成图片"（英雄#2 触发一次，`prefers-reduced-motion` 下无动画仍推进） |
| 5 | 进入工作台，点"生成图片" | 报价 modal 出现：金额 mono、有效期倒计时、"确认并生成"为 modal 唯一 primary；关闭闸门时断言错误文案而非假成功 |
| 6 | 确认报价（或闸门路径） | 提交后 `TaskState` 进入 pending/running；同报价重复确认不产生第二任务（幂等断言） |
| 7 | 图片完成后"生成视频"升为页面 primary | 断言两颗生成按钮的 variant 互换；视频报价流程同 5–6 |
| 8 | 视频库设主版本 | 按钮变"当前主版本"；`shot` 卡状态变"视频已定"；受保护下载返回 `video/mp4` |
| 9 | 本集连播与交付 | 连播 modal 按 shot_no 顺序；点击第 2 镜切换；JSON/CSV 下载 200；合计金额与看板一致 |
| 10 | 资产流程：上传个人资产→引入项目→工作台已选资产出现 | 引用计数与列表一致；通用资产只读断言（上传/设主禁用） |
| 11 | 回收站+看板收口 | 项目移入回收站→恢复；看板五卡数值为 mono 且与费用明细表合计一致；全站 console 0 error |

design-qa 截图刷新清单（同名覆盖 `design-qa/` 下 15 张，另增 4 张）：
- 刷新：`projects-1440x960`、`projects-comparison`、`projects-card-focus`、`projects-mobile-390x844`、`projects-mobile-assistant-open-390x844`、`workbench-1440x960`、`workbench-comparison`、`dashboard-live-1440x960`、`dashboard-comparison-1440x960`、`project-costs-live-1440x960`、`project-costs-comparison-1440x960`、`trash-permanent-confirm-live-1440x960`、`episode-playback-live-1440x960`、`shot-primary-live-1440x960`、`shot-primary-comparison-1440x960`。
- 新增：`login-1440x960`（品牌时刻）、`assistant-quote-card-live`（侧栏报价卡）、`storyboard-import-preview-live`、`hero-generation-complete`（动效关键帧）。
- `design-qa.md` 同步更新对照依据与结论段。

真实演示屏对比度检查步骤：
1. 在实际演示用显示器（含至少一台 Windows 低端机）上开满亮度 50% 与 100% 两档；
2. 打开工作台与看板，用取色器实测渲染后像素（不是 token 理论值——玻璃层叠加后的实效底色会变），对正文/占位符/soft 状态字重算比值；
3. 任何一对 <4.5:1（大字 <3:1）→ 回 `tokens.css` 调值 → 重跑 `design-system.md` 对比度表 → 走 token 变更流程；
4. 结果记入 `design-qa.md`"交互与状态检查"。

---

## 3. 治理章节

### 3.1 变更流程

- `tokens.css`、`design-system.md` 中的红线条款（四层材质、三处玻璃、辉光两用途、唯一强调色、agent 色边界、圆角/z/动效上限、独特性红线）：唯一批准人是用户。任何代理（含 Fable、codex）只能提案，不能自行合入。
- 提案格式（PR 描述或独立 issue）：动机 → 影响的 token/条款 → 前后对比截图 → 新对比度计算表 → 波及页面清单。批准后 `design-system.md` 版本号+1 并记录变更日志。
- 组件层新增 variant：不触红线时 codex 可自主，PR 中必须附该 variant 的七态 story；触红线（新颜色、新阴影、新动效曲线）即升级为 token 提案。
- 页面层：只许消费组件与 token，页面文件中出现新的视觉决策（自造类组合表达新样式语言）视为违规，评审打回。

### 3.2 lint 方案（标注：建议，涉及新 devDependency，超出依赖冻结，待用户批准后实施）

- 禁任意值：ESLint `no-restricted-syntax`，对 JSX `className` 匹配 `/\[[^\]]*\]/`（放行 `data-[state=…]`、`aria-[…]` Radix 状态前缀）；
- 禁字面量颜色：Stylelint `declaration-property-value-disallowed-list`：`color|background|border-color|box-shadow` 禁 `/#|rgb|hsl|oklch\(/`，白名单仅 `src/styles/tokens.css`；
- 禁裸 z-index：Stylelint `declaration-property-value-allowed-list`：`z-index` 只允许 `var(--z-*)`；
- 批准前的替代（零依赖，立即生效）：上面第 2.3 节的 `git diff | grep` 核查脚本进 `package.json scripts.check:design`，CI 每 PR 跑。

### 3.3 新页面上线检查清单（10 条）

1. L0–L3 分配写进 PR 描述，玻璃未超三处；
2. 唯一 primary 及其状态驱动规则明确，disabled 全部有去处；
3. 全部颜色经 token，`check:design` 脚本零命中；
4. 正文/占位符/soft 状态字对比度实测达标；
5. 数据（金额/ID/时间/计数）已 mono + tabular-nums；
6. loading/empty/error/retry 四态可复现，空态是教学空态；
7. 动效只用 springs 预设，reduced-motion 实测降级；
8. 文案过 29 号词汇表（生产语言优先，按钮动词+宾语）；
9. 逻辑零改动核查通过 + typecheck + 测试全绿；
10. 1440 冷启动走查截图 + console 0 error 记入 design-qa.md。

### 3.4 与 journey.md 的关系

- `journey.md`（验收流程文档，若尚未建档则在 P3 开工前由本合同附录升格创建）负责"用户走到哪、看见什么、下一步去哪"；`design-system.md` 负责"长什么样、怎么动"。分工：journey 变更可以触发页面 primary 与空态去处的调整（属 29 号状态驱动层），但永远不产生新颜色/新材质——那必须回 token 提案。
- P3 的页面顺序即 journey 的章节顺序；每页验收时对照 journey 该节的"进入前提/离开条件"，不一致时先改文档共识再改码。
- Playwright 11 步是 journey.md 的可执行镜像；journey 改一步，脚本同 PR 改一步。

---

## 4. 风险与回滚

| 阶段 | 回滚点 | 操作 |
|---|---|---|
| P1 | 单 commit 底座 | revert 该 commit：删 tokens/fonts/base、还原 vite.config 与 index.html，旧 `styles.css` 全程未删即刻复原 |
| P2 | 组件目录未被页面引用 | 直接删 `src/components/`、`src/stories/`、`.storybook/`，零业务影响 |
| P3 | 一页一 PR，`styles.css` 旧规则按页删除且删除与页面迁移同 PR | 回滚单页 = revert 单 PR；因 `ui.tsx` 以兼容签名换壳，跨页耦合被隔离在 facade 层 |
| P4 | 只增测试与截图 | 无需回滚路径 |

与 codex 未提交 WIP 的合流顺序：
1. codex 先把现有 WIP（生产进度条与相关页面修改，涉及 `app.tsx/ui.tsx/styles.css/types.ts/project-pages.tsx/workbench-page.tsx/production-stepper.*/production-progress.*`）自测后提交合入主线；
2. 主线打 tag（如 `pre-v011-ui`）作为 P1 基线与全局回滚锚点；
3. 再开 `design/v011-p1` 分支。P1–P3 期间 `styles.css`、`production-stepper.css`、`src/styles/**`、`src/components/**` 为设计迁移分支单一写者，codex 的功能修补只动逻辑文件（与 runtime.md 并行修改边界同款约定）；两侧同时要动 `app.tsx` 时，逻辑改动先合、样式改动 rebase 跟进。

字体/玻璃在 Windows 低端机的降级路径：
- 字体：`font-display: swap` 防白屏；中文栈 `PingFang SC → HarmonyOS Sans SC → Microsoft YaHei`，不依赖中文字形精致度；Geist 只子集拉丁+数字（单文件 <40KB），首屏数字闪替可接受。若演示机渲染 Geist 发虚（低分屏 ClearType），预留 `html[data-latin="system"]` 开关把 `--font-sans` 首位换系统栈，一行 token 生效。
- 玻璃：`@supports not (backdrop-filter: blur(1px))` 自动回退 `--surface-glass` → `--surface-1` 实心（顶栏/侧栏/modal 三处同时生效）；另设 `html[data-no-glass]` 手动开关应对"支持但掉帧"的机器，演示前实测低端机滚动帧率 <50fps 即打开。
- L0 径向渐变在低色深屏出现色带时：退化为 `--surface-0` 纯色（同一开关 `data-no-glass` 顺带关闭渐变），不引入噪点纹理（避免新材质）。
- 五个英雄时刻全部走 Motion 的 `useReducedMotion` 与 `springs.hero`，只动 transform/opacity（玻璃浮层 backdrop-filter 除外），低端机最坏情况 = 无动画但状态正确。

遗留风险（明说）：
- token 示例锚点未经对比度计算，P1 冻结前数值必然调整；不得跳过计算直接抄本文示例。
- `*.test.ts` 的 runner 不在前端 `package.json`（由仓库根执行），P1 需先确认根部测试命令并纳入每 PR 门槛。
- 29 号 UX 决议与 journey.md 未在主仓定位到独立文件（本文按用户给定摘要执行：进度条贯穿/唯一 primary/disabled 去处/词汇表优先）；若原文与本文冲突，以原文+用户裁决为准，先停手提案。
- 侧栏报价卡按钮用产品强调色而非 agent 色：已裁决（〇.2 第 3 条），付费动作永远用产品强调色，agent 色只做存在感。
