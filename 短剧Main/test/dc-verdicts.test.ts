/* ============================================================
   dc-verdicts.test.ts — DC 判决守卫(首批 5 条)

   判决真源:`docs/design/dc-verdicts.md`(V-01…V-32,生成界面域)。
   本文件是那份台账的**执行侧**:能机器判的判决在这里变成会失败的测试。

   为什么存在(2026-07-27 考古结论):
   DC 从 07-20 到 07-27 对生成界面提过 32 条,已修 9、部分修 4、从未修 16、
   **修过又丢 3**。最坏的一条是 V-06:D3/W6 把参数做成可改的(`a2a3ae8`),
   S5 又以「去假可调」为由把参数控件全部下线(`ae93475`)——没人发现原始诉求
   被反转。守卫测试的作用就是在 S5 提交那一刻红掉,而不是三个月后 DC 看见。

   写法纪律(改这个文件前先读):
   - **断言只读真实源码/配置**,不读 `dc-verdicts.md` 自己——文档能被同一个人
     顺手改绿,源码不能;
   - **测试名必须带 V 编号 + DC 原话摘要**,红了直接能看出是谁的哪句话被违反;
   - 既有欠账用 `todo` 标注:红的断言原样保留,门禁不被历史欠账挡住,
     但每次 `npm test` 都把它打在所有人脸上。修完把 `todo` 摘掉,它就变成真门禁。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { FALLBACK_TIERS, activeTiers } from "../frontend/shortdrama-rag-demo/src/capability-tiers.js";
import { resolveDimensionPick } from "../frontend/shortdrama-rag-demo/src/generation-dimensions.js";
import { IMAGE_PRESETS, findImagePreset, presetRatioNote } from "../frontend/shortdrama-rag-demo/src/image-presets.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
/** 判决台账「关联文件」列的 `FE/` 前缀。 */
const FE = "frontend/shortdrama-rag-demo/src";

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/** 取源码区间(用于「某个组件/某个区块内」的结构断言);两端标记必须都在,否则测试自己先红。 */
function sliceBetween(source: string, label: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${label}:起始标记不在源码里了(「${startMarker}」),断言区间失效,先修测试`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${label}:结束标记不在源码里了(「${endMarker}」),断言区间失效,先修测试`);
  return source.slice(start, end);
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

const workbench = readSource(`${FE}/pages/workbench-page.tsx`);
const projectPages = readSource(`${FE}/pages/project-pages.tsx`);
const gridSplitModal = readSource(`${FE}/components/grid-split-modal.tsx`);

/* ============================================================
   V-06 / V-07(🔴 回归 + 回归带出的功能 bug → S66 修复,摘 todo 转真门禁)
   DC 07-22 12:24:「生成图和视频的参数没法改。」
   后果:14 个模板里 5 个承诺的画幅(1:1 / 21:9)根本不生效——九宫格分镜、
   25宫格、剧情推演四宫格、多机位九宫格、720全景,选了也按 16:9 出图,宫格必然变形。
   弹窗自己还写着「模板「X」只预填提示词」,等于把静默失效写在脸上。

   S66 修复口径(R59 维度化):
   - 模板设计画幅在 active 档值域内 → 选中模板时按维度反查切到命中档
     (resolveDimensionPick;档仍是原子的,提交参数 = 命中档的 tierSubmitInput);
   - 不在值域内(如 21:9 全景) → 不动档,模板区 presetRatioNote 明示变形警示,
     不许静默按档画幅出宫格图;
   - 「只预填提示词」这类把静默失效当说明的文案不许再出现在源码里。
   值域真源:`FE/capability-tiers.ts` 的已登记档(= 合同附表
   `docs/contracts/v0.3.0/model-capability-and-price-tiers.md` 的 active 行)。
   ============================================================ */

test("V-06/V-07｜「生成图和视频的参数没法改」——模板画幅在值域内必须能切档命中,不在值域必须明示变形警示", () => {
  const imageTiers = activeTiers(FALLBACK_TIERS.image);
  assert.ok(imageTiers.length > 0, "没有 active 图片档,值域断言无从谈起——先看 capability-tiers.ts");
  const anchor = imageTiers[0]!;
  const allowedRatios = new Set(imageTiers.map((tier) => String(tier.params.aspect_ratio)));

  const debts: string[] = [];
  for (const preset of IMAGE_PRESETS) {
    if (allowedRatios.has(preset.parameters.ratio)) {
      /* 在值域内:维度反查必须命中真实档——模板选中即按设计画幅切档,模板参数真正参与。 */
      const picked = resolveDimensionPick(FALLBACK_TIERS.image, anchor, "image", "aspect_ratio", preset.parameters.ratio);
      if (!picked) {
        debts.push(`模板「${preset.name}」ratio=${preset.parameters.ratio} 在值域内却反查无档——切档链断了`);
      }
    } else {
      /* 不在值域:选中时必须能算出变形警示(presetRatioNote 非空),不许静默按档画幅出图。 */
      const note = presetRatioNote(findImagePreset(preset.id), String(anchor.params.aspect_ratio));
      if (!note) {
        debts.push(
          `模板「${preset.name}」(${preset.id}) 承诺 ratio=${preset.parameters.ratio},` +
          `档只允许 ${[...allowedRatios].join("/")},却没有变形警示——静默失效回来了`,
        );
      }
    }
  }
  if (!workbench.includes("imageGenerationParameters(")) {
    debts.push("模板参数没进页面:workbench-page 未消费 imageGenerationParameters(,模板 parameters 仍被丢弃");
  }
  if (!workbench.includes("resolveDimensionPick(")) {
    debts.push("选中模板未按设计画幅反查切档:workbench-page 未接 resolveDimensionPick");
  }
  if (workbench.includes("只预填提示词")) {
    debts.push("源码仍写着「只预填提示词」——把静默失效写在脸上当说明,不算交代");
  }

  assert.deepEqual(debts, [], `V-06/V-07 欠账(共 ${debts.length} 项):\n${debts.join("\n")}`);
});

/* ============================================================
   V-15(✅ 已修,锁住防回退)
   DC 07-23 10:58:「已匹配资产只是草稿和候选,工作台的才是进入参考控制包的
   多模态全能参考」。S9-17 已把提交参考集的取数源改成工作台控制包。
   K-goal-04 条 4:确认抽屉退场,取数源不变——真相条/提交链同一控制包源。
   行为层断言在 `FE/s9-generation.test.ts`(S9-17),这里锁的是接线。
   ============================================================ */

test("V-15｜「已匹配资产只是草稿和候选」——提交参考集取数源=工作台控制包,不是项目匹配资产", () => {
  // K2K：取数换 partitionControlPack 分层（submitted 层=controlPackReferences 产出，等值断言在 k2-submit-truth.test.ts）
  assert.ok(
    workbench.includes("partitionControlPack(lanesState"),
    "提交参考集没从 lanesState(工作台参考控制包)组装——DC 点名的「拿了项目匹配的资产」又回来了",
  );
  assert.ok(
    workbench.includes("options={controlPackOptions}"),
    "生成卡真相条 props 没接控制包选项:界面所见与 submit 所发已经不同源",
  );
  assert.ok(
    !workbench.includes("references={assetState.data"),
    "提交侧又在直接吃项目匹配资产(候选池)——这正是 DC 判为「逻辑有问题」的那一版",
  );
});

/* ============================================================
   V-24(✅ 已修,锁住防回退)
   DC 07-22 12:24 点名集视图按钮堆砌:「第 1 集 / 本集视频未生成 / 一键生成本集
   (已就绪 1/3)/ 视频库 / 预览全集 / 3D 导演台 / 更多 / AI 批量生成…」
   现在的口径:生成本集=唯一实心主按钮,预览/视频库降 ghost,其余收进「更多」。
   同时对应审美否决清单 #5「一屏多个 primary 按钮」。
   ============================================================ */

test("V-24｜「第 1 集 / 视频库 / 预览全集 / 更多 / AI 批量生成…」按钮堆砌——集视图只留一个实心主按钮", () => {
  const episodeHeader = sliceBetween(
    projectPages,
    "V-24 集视图头部",
    "第 {selectedEpisode.episode_no} 集",
    "</Card>",
  );
  const primaryCount = countOccurrences(episodeHeader, 'variant="primary"');
  assert.equal(
    primaryCount, 1,
    `集视图头部有 ${primaryCount} 个实心主按钮(应为 1,只有「生成本集」)——按钮又堆回去了`,
  );
  assert.ok(
    episodeHeader.includes(">生成本集（已就绪 {readyShots.length}/{shots.length}）</Button>"),
    "唯一主按钮不再是带就绪计数的「生成本集」",
  );
  const batchImageLine = projectPages
    .split("\n")
    .find((line) => line.includes("批量生成图片（本集）"));
  assert.ok(batchImageLine, "集级「批量生成图片（本集）」入口不见了");
  assert.ok(
    batchImageLine.includes("DropdownMenuItem"),
    "「批量生成图片（本集）」又摆回按钮行了——它属于「更多」菜单",
  );
});

/* ============================================================
   V-25(✅ 已修,锁住防回退)
   DC 07-23 11:00:「工作台这两个 button 的功能和逻辑还有文本设计都很奇怪。
   你好好想想」。裁决:撤销「文生视频」+「生成本粗剪素材」双钮,只留「生成视频」。
   K-goal-04 条 4(07-30):生成确认抽屉整体退场——参数/提示词/参考集主界面都已可见,
   抽屉是重复确认;生成方式=视频页签模式选择器(VIDEO_MODES),提交按确认图自动判定
   (有图=按图生成作首帧)。点击直接提交,一次点击只创建一个任务(submitting 闸门)。
   审美否决清单 #5 在新结构下的对应:生成卡底条只许有一个 primary 按钮。
   ============================================================ */

test("V-25｜「工作台这两个 button 的功能和逻辑还有文本设计都很奇怪」——素材级唯一主按钮「生成视频」", () => {
  assert.ok(workbench.includes(">生成视频</Button>"), "素材级唯一主按钮「生成视频」不见了");
  assert.ok(!workbench.includes("生成本粗剪素材"), "旧主按钮「生成本粗剪素材」复活了(DC 判为双钮语义混乱)");
  assert.ok(!workbench.includes(">文生视频<"), "「文生视频」又做成了独立入口按钮,应是模式选择器里的选项");
  // K-goal-04 条 4:确认抽屉退场,点击直接提交;生成方式真相在主界面(模式选择器+确认图首帧标注)
  assert.ok(!workbench.includes("GenerationConfirmDrawer"), "生成确认抽屉复活了(条 4 要求直接提交不弹窗)");
  assert.ok(workbench.includes("modes={VIDEO_MODES}"), "生成方式未收敛到视频页签模式选择器");
  assert.ok(workbench.includes("按图生视频的首帧"), "确认图首帧标注缺失(生成方式真相)");
  // 审美否决清单 #5 新结构对应:生成卡底条 primary 按钮唯一(发送钮)
  const bar = sliceBetween(workbench, "V-25 底条", "S66:生成卡底条", "节点卡之外");
  const primaryCount = countOccurrences(bar, 'variant="primary"');
  assert.equal(
    primaryCount, 1,
    `生成卡底条有 ${primaryCount} 个 primary 按钮(应为 1)——违反审美否决清单 #5「一屏多个 primary 按钮」`,
  );
});

/* ============================================================
   V-26(✅ 已修,S73 挂真守卫)
   DC 07-22 12:24:「『直接文生视频』把『直接』两个字去掉,整体用词要专业和
   行业惯用语」。行业惯用语=「文生视频」(libTV 模式标签同口径),带「直接」的
   五字组合全站禁出。
   执行侧两层:F3 全站禁词扫描在 `FE/s17-dev-copy-guard.test.ts`(剥注释全量
   扫 src,白名单为空);本条锁两件事——①禁词不得回潮(本测试自己也全量扫一遍,
   不依赖隔壁守卫先跑);②禁词在 F3 词表里的登记不得被悄悄摘掉。
   ============================================================ */

/** 与 s17-dev-copy-guard 同口径:剥注释后全量扫 FE src(director 独立模块自带测试,不扫)。 */
function* walkFeSources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!["node_modules", "director"].includes(entry)) yield* walkFeSources(full);
    } else if (/\.(tsx|ts)$/.test(entry) && !entry.endsWith(".test.ts")) {
      yield full;
    }
  }
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("V-26|「『直接文生视频』把『直接』两个字去掉」——五字组合全站零残留,F3 词表登记不得摘除", () => {
  const hits: string[] = [];
  for (const file of walkFeSources(path.join(repoRoot, FE))) {
    const stripped = stripComments(readFileSync(file, "utf8"));
    if (stripped.includes("直接文生视频")) {
      hits.push(file.replace(`${repoRoot}/`, ""));
    }
  }
  assert.deepEqual(hits, [], `「直接文生视频」回潮(行业惯用语是「文生视频」):\n${hits.join("\n")}`);
  const guard = readSource(`${FE}/s17-dev-copy-guard.test.ts`);
  assert.ok(
    guard.includes('"直接文生视频"'),
    "F3 全站禁词表(s17-dev-copy-guard)里的「直接文生视频」登记被摘了——禁词扫描名存实亡",
  );
});

/* ============================================================
   V-04(✅ 已修,锁住防回退)
   DC 07-21 09:16:「宫格切分后还得到最外层的资产中心去把切分后的分镜引入到
   项目里,这个逻辑不对」。现在的口径:选格即入资产库、挂项目资产、建成粗剪素材,
   全程不离开当前弹窗,不跳资产中心。
   ============================================================ */

test("V-04｜「宫格切分后还得到最外层的资产中心去把切分后的分镜引入到项目里,这个逻辑不对」——就地挂项目资产", () => {
  const createGroup = sliceBetween(
    gridSplitModal,
    "V-04 选格创建粗剪素材组",
    "async function createShotGroup(",
    "一键全存",
  );
  assert.ok(createGroup.includes("api.addProjectAsset("), "切分结果没有就地挂进项目资产——又要人去资产中心手动引入了");
  assert.ok(createGroup.includes("api.createShot("), "切分结果没有就地建成粗剪素材");
  assert.ok(
    !gridSplitModal.includes("navigate("),
    "宫格切分流程里出现了跳转:DC 判过「还得到最外层的资产中心去」这个逻辑不对,别再把人踢出去",
  );
  assert.ok(gridSplitModal.includes("创建粗剪素材组"), "「创建粗剪素材组」按钮不见了");
});
