/* ============================================================
   ir-compiler.test.ts — IR→prose 编译器单测（node:test，纯逻辑）
   黄金样本：醉汉天台（GENERATE 全骨架，对应官方实例 5）与
   火车破银幕（EDIT 全骨架，对应官方示例 A），数据来自
   outputs/workbench-w9/design-brief-v3.md / design-brief-v3b.md。
   ============================================================ */

import assert from "node:assert/strict";
import test from "node:test";
import {
  compileEditPrompt,
  compileGeneratePrompt,
  type CompileResult,
  type EditIR,
  type GenerateIR,
  type PromptAsset,
  type PromptShot,
} from "./ir-compiler";

/* ---------------- 黄金样本 1：醉汉天台（GENERATE） ---------------- */

const drunkAsset: PromptAsset = {
  id: "char_drunk_man",
  media: "image",
  role: "character",
  label: "醉汉主角",
  description:
    "一名胖胖的、可爱的、喝醉了的中年男人。体型圆润敦实、挺着一个圆滚滚的啤酒肚，身材不高，动作因醉酒而松垮迟缓、摇摇晃晃。圆脸、双下巴、因醉酒而红扑扑的脸颊和鼻头，眼睛眯成一条缝、眼神迷离涣散、带着憨厚又滑稽的醉态，留着一圈没怎么打理的短络腮胡，头发乱蓬蓬的短发。表情憨傻可爱、一副没心没肺的样子。着装非常随意邋遢：一件沾着汉堡酱渍/番茄酱污点的白色汗衫(背心)，松垮地套在圆肚子上、下摆有点卷边，配一条旧牛仔裤，趿拉着的样子；手里始终攥着一个咬了几口的汉堡。憨厚、迷糊、醉醺醺、慢半拍——一个倒霉又乐天的可爱大叔",
  lock: { mode: "full" },
  scope: "global",
};

const drunkShots: readonly PromptShot[] = [
  {
    id: "S1",
    start_s: 0,
    end_s: 4,
    theme: "开幕：咀嚼大特写(有声)",
    refs: ["char_drunk_man"],
    action:
      "开幕即男人的脸充满整个屏幕的大特写：{{char_drunk_man}}正大口咀嚼着汉堡，腮帮子鼓动，红扑扑的脸颊、眯缝的醉眼、迷离的神情，嘴角沾着酱，一副心满意足的醉态",
    sfx: "听得见咀嚼声、含糊的满足哼哼、远处霓虹城市环境声",
    speed_ramp: "实时",
  },
  {
    id: "S2",
    start_s: 4,
    end_s: 9,
    theme: "拉全景：伸懒腰→失足跌落(有声)",
    action:
      "摄影机平稳拉镜头拉到全景：醉汉站在天台边缘附近，身旁散落空啤酒罐与汉堡袋。他晃晃悠悠地站起身，惬意地伸了个大懒腰，身子后仰——没站稳、脚下一滑，一个踉跄直接向后翻出天台边缘跌落。动作笨拙而真实，汉堡还没撒手",
    sfx: "城市环境声+一声惊慌的短促“欸——!”",
    speed_ramp: "实时",
  },
  {
    id: "S3",
    start_s: 9,
    end_s: 12,
    theme: "切：惊讶面部特写(大喊，巨响)",
    camera: { framing: "面部大特写" },
    action:
      "硬切到他坠落中的面部大特写：醉眼瞬间瞪圆、双下巴挤成一团、满脸惊恐，张大嘴发出极大的惊叫“啊——!!”",
    sfx: "喊声很大、很炸，风声在耳边呼啸",
    speed_ramp: "实时",
  },
  {
    id: "S4",
    start_s: 12,
    end_s: 16,
    theme: "切：远景平视视角(完全无声)",
    camera: { framing: "远景", angle: "平视视角" },
    action:
      "硬切到远景、平视视角：从对面楼或街道远远望去，渺小的白色身影正从高楼笔直下坠，霓虹都市巨大而冷漠地矗立着。画面此刻完全无声——只有绝对的寂静，与前一秒的巨响形成强烈的黑色幽默反差，凸显个体的渺小与荒诞",
    speed_ramp: "实时",
  },
  {
    id: "S5",
    start_s: 16,
    end_s: 21,
    theme: "切：面部特写(大喊)→抓住绳子",
    camera: { framing: "面部大特写" },
    action:
      "硬切回面部大特写，声音猛地回来：他继续大声惊叫“啊啊啊——!!”，手在空中乱抓——猛地一把抓住了那根救命的缆索！缆索在他体重下瞬间绷直下弯、发出崩响，他的惊叫戛然卡住，整个人被拽住、荡了出去",
    speed_ramp: "抓绳受力瞬间短暂慢动作(可见缆索深深下沉、汗衫剧烈抖动)→随即回到实时被甩向窗户",
  },
  {
    id: "S6",
    start_s: 21,
    end_s: 26,
    theme: "切：室内视角(安静)→玻璃爆裂→跌入",
    action:
      "硬切到室内视角：镜头在昏暗安静的室内，透过亮灯的窗户向外——先是一片安静，只有室内轻微的空调嗡鸣。下一秒，玻璃轰然向内爆裂，醉汉连人带汉堡撞破窗户、碎片放射状飞散、霓虹光透过碎玻璃洒进来，他重重跌进室内，砸在地板/沙发上，碎玻璃叮当洒落",
    speed_ramp: "玻璃爆裂瞬间短暂慢动作(子弹时间)→骤回实时",
  },
  {
    id: "S7",
    start_s: 26,
    end_s: 30,
    theme: "结尾：惊讶一秒→倒头睡着(黑色幽默收尾)",
    action:
      "男人四仰八叉地摊在室内地上，满身碎玻璃，汉堡奇迹般还攥在手里(或掉在胸口)。他缓缓睁开眼，愣愣地、茫然地惊讶了整整一秒——环顾四周，仿佛在想“我这是……到哪了？”。然后，醉意彻底占了上风，他满不在乎地咂咂嘴、把汉堡往怀里一搂、翻个身、就地舒服地躺下，呼呼睡着了，还打起了轻鼾。镜头缓缓拉开或定格在这荒诞而安详的一幕上。硬切黑场",
    speed_ramp: "实时",
  },
];

function drunkIr(): GenerateIR {
  return {
    kind: "generate",
    meta: {
      title: "醉汉天台惊魂",
      beats: ["失足坠楼", "抓绳破窗", "倒头就睡"],
      genre: "黑色幽默短片",
      duration_s: 30,
      logline:
        "一个略带黑色幽默的影视片段：一个胖胖可爱的醉酒中年男人在大楼天台吃汉堡、喝啤酒，起身伸懒腰时不慎失足坠落，慌乱中抓住一根救命绳子，随即破窗跌进室内，愣愣地惊讶了一秒钟，然后索性就地躺下、呼呼睡着",
    },
    assets: [drunkAsset],
    global: {
      style: {
        medium: "真实实拍质感，物理电影镜头，真实材质",
        scene:
          "夜晚的赛博朋克巨型都市：玻璃钢铁摩天大楼森林，密集的霓虹招牌(青色/品红/电蓝)，全息广告牌，湿滑反光的地面，被城市光晕照亮的体积雾，远处飞行车的光轨，穿梭的无人机。雨水浸润的楼面倒映着霓虹。天台上散落着几个空啤酒罐、一个汉堡纸袋、一张塑料椅",
        palette_603010: "深蓝黑色夜空+湿润钢铁玻璃(60)/青与品红霓虹光晕+广告牌光(30)/汗衫的白+汉堡包装的暖黄+招牌高光炫光(10)",
        texture: "超高细节——汗衫布料抖动、油渍、汗珠、汉堡碎屑、水珠、玻璃碎片皆锐利清晰",
        exclusions: ["3D 渲染", "游戏引擎", "动漫感"],
      },
      camera: {
        system:
          "混合手持与摇臂/无人机，按分镜切换视角与景别；失足后摄影机随他一同下坠，楼体外墙与霓虹向画面上方飞速掠过以体现速度",
        lens: {
          text: "物理广角变形宽银幕电影镜头质感(24–35mm),180° 快门运动模糊，真实手持重量感，镜头上有细微雨珠",
          verified: false,
        },
        ramp: "大部分为实时；仅抓绳受力瞬间(S5)、破窗瞬间(S6)各做一次短暂慢动作，其余实时",
      },
      physics: {
        label: "极致真实",
        text: "全程真实重力，圆胖的醉汉体型带来十足的重量感。伸懒腰重心不稳→踉跄→失足是自然连贯的醉态动作；自由落体时圆润的身躯与四肢笨拙地随气流翻扑，汗衫被风灌得鼓起，汉堡还攥在手里。绳索=一根绷紧、架设在两楼之间的缆索/滑索；他在下坠中手忙脚乱、侥幸一把抓住，缆索在他厚实体重下猛地绷直、大幅下弯储能，随后将他以钟摆弧线甩向下方一扇亮灯的窗户。窗户=以荡出的速度背部/侧身先入——玻璃向内爆裂，碎片沿真实轨迹放射状飞散，窗棂炸开，他连人带汉堡跌进室内。落地=圆胖身躯重重砸在室内地面/沙发上，碎玻璃如雨洒落身周",
      },
      audio: {
        strategy: "黑色幽默的声音设计：按分镜在“巨响”与“完全无声”之间反复硬切",
        base: "仅现场同期声",
        bed: "赛博朋克城市环境声(车流、霓虹电流、无人机、雨、风啸随下坠增强)",
        vo_policy: "无对白(除本能的惊呼)",
        exclusions: ["音乐", "字幕"],
      },
    },
    shots: drunkShots,
  };
}

/* ---------------- 黄金样本 2：火车破银幕（EDIT） ---------------- */

function trainIr(): EditIR {
  return {
    kind: "edit",
    intent: "让一列蒸汽火车从银幕中冲出，破幕瞬间画面从黑白骤然转为彩色",
    base: "base_projection_hall",
    assets: [
      {
        id: "base_projection_hall",
        media: "video",
        role: "scene",
        label: "放映厅原片",
        scope: "global",
      },
    ],
    style: {
      positive: "超真实电影感写实风格，照片级真实的实拍影像质感，强调冲出实体(蒸汽火车)的现实可信度",
      negative: ["CGI 光泽感", "游戏引擎感", "风格化 3D 外观"],
    },
    fields: {
      lighting: { mode: "override", value: "转色后放映厅暖色实景光仍为主光源，车头灯作为强光源并存" },
      imperfections: { mode: "add", value: "火车蒸汽在镜头上凝成的细微水珠" },
    },
    additions: [
      {
        name: "画面转色规则",
        summary: "破幕瞬间从黑白到真实彩色的转色",
        description:
          "影片开始时严格保持{{base_projection_hall}}原本的黑白老电影质感(颗粒、划痕、闪烁、单色调)。当火车车头真正突破银幕、冲入现实空间的那一瞬间，画面从黑白骤然转为饱满真实的彩色——转色以火车冲出点为中心、如冲击波般向整个画面扩散，火车的黑色钢铁车身、红铜色锅炉光泽、橙黄的蒸汽灯火、木质车厢的暖棕、白灰色蒸汽与放映厅的暖褐色调随之显色。转色后维持照片级真实彩色直到结束",
        trigger: "火车车头真正突破银幕、冲入现实空间的那一瞬间",
        spatial_anchor: "以火车冲出点为中心，如冲击波般向整个画面扩散",
        time_sync: "与破幕的爆发瞬间精确同步，干脆有力",
        physics: "转色仅改变画面显色，不改变任何物体运动与物理状态",
      },
      {
        name: "银幕破裂锁定",
        summary: "银幕的破裂",
        description:
          "银幕表现为一块真实存在、有织物张力的白色投影幕布，而非普通平面。火车冲出时，幕布沿车头轮廓被强行撕裂、爆开——布面出现放射状裂口、边缘翻卷撕扯、碎布与纤维向外飞扬、幕布残片剧烈摆荡，破口处透出后方结构",
        trigger: "火车车头接触银幕的瞬间",
        spatial_anchor: "银幕平面，沿车头轮廓撕裂",
        time_sync: "与火车冲出全程同步",
        physics: "破裂的张力感、撕扯方向与火车冲出的力量和方向一致，全程保留清晰可见的破裂感",
      },
    ],
    subject:
      "一列老式蒸汽火车车头正从银幕中强行冲出。黑色钢铁车身、圆筒锅炉、前置排障器、冒着白灰色蒸汽的烟囱、明亮的车头灯，金属表面有真实的磨损、油污、铆钉与湿润反光。它带着巨大的重量与惯性向前冲，符合可信的机械结构与真实火车的体量感",
    audio: {
      inherit: "放映厅环境音(放映机哒哒声、观众轻微骚动)",
      add: ["幕布被撕裂爆开的布料撕扯声", "蒸汽喷涌声", "钢铁车轮与机械轰鸣声", "冲击气浪声"],
      exclusions: ["音乐"],
    },
    output_notes: ["16:9", "1080p"],
  };
}

/* ---------------- 工具：小块 IR 与回源校验 ---------------- */

function miniGenerateIr(assets: readonly PromptAsset[], shots: readonly PromptShot[]): GenerateIR {
  return {
    kind: "generate",
    meta: { title: "测试片", beats: ["起", "落"], genre: "测试", duration_s: 10, logline: "测试梗概" },
    assets,
    global: { style: { medium: "写实" } },
    shots,
  };
}

/** 解析 "assets[0].lock" / "shots[2].camera" 形态的 IR 路径；解析不到返回 undefined。 */
function resolveIrPath(root: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cursor: unknown = root;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** 回源表完整性：覆盖全部 prose 段、段标识唯一、无悬空路径。 */
function assertProvenanceSound(result: CompileResult, ir: unknown): void {
  assert.equal(
    result.provenance.map((entry) => entry.text).join("\n"),
    result.prose,
    "provenance 各段拼接必须等于 prose",
  );
  assert.ok(result.provenance.length > 0);
  const seen = new Set<string>();
  for (const entry of result.provenance) {
    assert.ok(!seen.has(entry.segment), `segment 重复：${entry.segment}`);
    seen.add(entry.segment);
    assert.ok(entry.source.length > 0, `${entry.segment} 缺少回源路径`);
    for (const path of entry.source) {
      assert.notEqual(resolveIrPath(ir, path), undefined, `${entry.segment} 存在悬空路径：${path}`);
    }
  }
}

/** prose 中各锚点严格按序出现。 */
function assertBlockOrder(prose: string, anchors: readonly string[]): void {
  let cursor = -1;
  for (const anchor of anchors) {
    const index = prose.indexOf(anchor);
    assert.ok(index >= 0, `缺少块：${anchor}`);
    assert.ok(index > cursor, `块顺序错误：${anchor}`);
    cursor = index;
  }
}

/* ---------------- GENERATE 黄金样本 ---------------- */

test("GENERATE 黄金样本：全骨架块顺序与身份锁定句", () => {
  const { prose } = compileGeneratePrompt(drunkIr());
  assertBlockOrder(prose, [
    "【醉汉天台惊魂",
    "整体画面 ——",
    "参考图@图像1——",
    "镜头&变速 ——",
    "物理(极致真实) ——",
    "声音设计 ——",
    "分镜(约 30 秒",
    "S1(0–4秒)",
    "S7(26–30秒)",
    "正向约束 ——",
  ]);
  assert.ok(
    prose.startsWith(
      "【醉汉天台惊魂 — 失足坠楼 — 抓绳破窗 — 倒头就睡 | 黑色幽默短片 | 约 30 秒】【一句话梗概】一个略带黑色幽默的影视片段：",
    ),
  );
  // 身份锁定句：100% 匹配参考图
  assert.ok(prose.includes("参考图@图像1——一名胖胖的、可爱的、喝醉了的中年男人"));
  assert.ok(prose.includes("手里始终攥着一个咬了几口的汉堡。憨厚、迷糊、醉醺醺、慢半拍——一个倒霉又乐天的可爱大叔。100% 匹配参考图。"));
  // 全局风格 / 配色透传 / 排除项
  assert.ok(prose.includes("60:30:10 配色 —— 深蓝黑色夜空+湿润钢铁玻璃(60)/青与品红霓虹光晕+广告牌光(30)/汗衫的白+汉堡包装的暖黄+招牌高光炫光(10)"));
  assert.ok(prose.includes("真实实拍质感，物理电影镜头，真实材质，无 3D 渲染/游戏引擎/动漫感"));
  assert.ok(prose.includes("超高细节——汗衫布料抖动"));
  // 全局镜头 / 变速
  assert.ok(prose.includes("镜头&变速 —— 混合手持与摇臂/无人机"));
  assert.ok(prose.includes("变速：大部分为实时；仅抓绳受力瞬间(S5)、破窗瞬间(S6)各做一次短暂慢动作，其余实时"));
  // 全局声音
  assert.ok(prose.includes("声音设计 —— 黑色幽默的声音设计：按分镜在“巨响”与“完全无声”之间反复硬切"));
  assert.ok(prose.includes("背景垫赛博朋克城市环境声(车流、霓虹电流、无人机、雨、风啸随下坠增强)"));
  assert.ok(prose.includes("无对白(除本能的惊呼)。无音乐/字幕。"));
});

test("GENERATE 黄金样本：S1-S7 时间码与分镜体字段", () => {
  const { prose } = compileGeneratePrompt(drunkIr());
  const timecodes = ["S1(0–4秒)", "S2(4–9秒)", "S3(9–12秒)", "S4(12–16秒)", "S5(16–21秒)", "S6(21–26秒)", "S7(26–30秒)"];
  for (const timecode of timecodes) assert.ok(prose.includes(timecode), `缺少时间码：${timecode}`);
  // refs 前缀 + {{asset_id}} 内联引用都被编译为 @N，产物无占位符残留
  assert.ok(prose.includes("参考@图像1。开幕即男人的脸充满整个屏幕的大特写：@图像1正大口咀嚼着汉堡"));
  assert.ok(!prose.includes("{{"), "prose 不允许残留 {{asset_id}} 占位符");
  // CameraSpec：景别 / 景别，视角
  assert.ok(prose.includes("S3(9–12秒)・切：惊讶面部特写(大喊，巨响) —— 镜头：面部大特写"));
  assert.ok(prose.includes("镜头：远景，平视视角"));
  // SpeedRamp：实时原样成句；慢动作编译为 变速：…
  assert.ok(prose.includes("听得见咀嚼声、含糊的满足哼哼、远处霓虹城市环境声。实时。"));
  assert.ok(prose.includes("变速：抓绳受力瞬间短暂慢动作(可见缆索深深下沉、汗衫剧烈抖动)→随即回到实时被甩向窗户"));
});

test("GENERATE 约束尾：由 IR 字段自动推导（无自由文本字段）", () => {
  const { prose } = compileGeneratePrompt(drunkIr());
  assert.ok(prose.includes("正向约束 —— 约 30 秒，黑色幽默短片，严格遵循上述分镜的景别切换与声音切换"));
  assert.ok(prose.includes("全片只有一个角色：一名胖胖的、可爱的、喝醉了的中年男人"));
  assert.ok(prose.includes("无其他人物，身份/长相/体型/着装 100% 匹配参考图，全程一致不漂移"));
  assert.ok(prose.includes("故事闭环：失足坠楼→抓绳破窗→倒头就睡"));
  assert.ok(prose.includes("正向约束 ——") && prose.includes("仅现场同期声，无音乐/字幕"));
  // 推导而非手存：改 duration_s 重编译，头部/分镜头/约束尾三处复述同步变化
  const recompiled = compileGeneratePrompt({ ...drunkIr(), meta: { ...drunkIr().meta, duration_s: 45 } });
  assert.ok(recompiled.prose.includes("约 45 秒】"));
  assert.ok(recompiled.prose.includes("分镜(约 45 秒"));
  assert.ok(recompiled.prose.includes("正向约束 —— 约 45 秒，黑色幽默短片"));
  assert.ok(!recompiled.prose.includes("约 30 秒"));
});

/* ---------------- EDIT 黄金样本 ---------------- */

test("EDIT 黄金样本：锁定枚举 / 白名单 / 核心新增块四要素 / 技术规格继承句", () => {
  const { prose } = compileEditPrompt(trainIr());
  assertBlockOrder(prose, [
    "编辑目标：对@视频1进行编辑",
    "风格：",
    "原视频锁定：",
    "画面转色规则(核心新增)",
    "银幕破裂锁定(核心新增)",
    "光线改为：",
    "主体：",
    "镜头要求：",
    "声音：",
    "限制条件：",
  ]);
  // 原视频锁定块：基础绑定 + 枚举锁定项（override/add 的字段不进枚举）
  assert.ok(prose.includes("原视频锁定：将@视频1完整保留为基础画面"));
  assert.ok(
    prose.includes(
      "时长与节奏、构图、镜头运动、主体运动轨迹、场景与物体、色调与调色、画幅与镜头特性、原音频都保持不变，不要修改",
    ),
  );
  // 「唯一新增的内容是：…」白名单 = 新增块 summary + add 字段值 + override 字段
  assert.ok(
    prose.includes(
      "唯一新增的内容是：破幕瞬间从黑白到真实彩色的转色、银幕的破裂、火车蒸汽在镜头上凝成的细微水珠、光线：转色后放映厅暖色实景光仍为主光源，车头灯作为强光源并存",
    ),
  );
  // 核心新增块：命名 + 四要素齐全；{{base}} 内联引用替换为 @视频1
  assert.ok(prose.includes("画面转色规则(核心新增)。影片开始时严格保持@视频1原本的黑白老电影质感"));
  assert.ok(prose.includes("触发条件：火车车头真正突破银幕、冲入现实空间的那一瞬间"));
  assert.ok(prose.includes("空间锚点：以火车冲出点为中心，如冲击波般向整个画面扩散"));
  assert.ok(prose.includes("时间同步：与破幕的爆发瞬间精确同步，干脆有力"));
  assert.ok(prose.includes("物理约束：转色仅改变画面显色，不改变任何物体运动与物理状态"));
  assert.ok(prose.includes("银幕破裂锁定(核心新增)"));
  assert.ok(prose.includes("物理约束：破裂的张力感、撕扯方向与火车冲出的力量和方向一致，全程保留清晰可见的破裂感"));
  assert.ok(!prose.includes("{{"));
  // 覆写字段编译进增量声明
  assert.ok(prose.includes("光线改为：转色后放映厅暖色实景光仍为主光源，车头灯作为强光源并存"));
  // 增量主体 / 镜头继承声明（缺省自动生成）/ 音频继承+增量
  assert.ok(prose.includes("主体：一列老式蒸汽火车车头正从银幕中强行冲出"));
  assert.ok(prose.includes("镜头要求：完全继承@视频1原本的镜头运动。不要平滑，不要重定时，不要重新构图"));
  assert.ok(
    prose.includes(
      "声音：不要音乐。继承@视频1原本的放映厅环境音(放映机哒哒声、观众轻微骚动)，并新增幕布被撕裂爆开的布料撕扯声、蒸汽喷涌声、钢铁车轮与机械轰鸣声、冲击气浪声",
    ),
  );
  // 技术规格尾块：复述规格透传 + 继承句强制自动生成
  assert.ok(
    prose.includes(
      "限制条件：16:9，1080p，总时长与@视频1完全一致。除上述增量与声明的变化外，不新增、不修改任何其他内容，未提及的一切保持原样",
    ),
  );
});

test("EDIT 三态默认值：全锁枚举 / 无白名单 / 继承句兜底", () => {
  const ir: EditIR = {
    kind: "edit",
    intent: "删除所有人，除了主角",
    base: "vid_base",
    assets: [{ id: "vid_base", media: "video", role: "scene", scope: "global" }],
  };
  const result = compileEditPrompt(ir);
  // 未声明任何字段 → 十个维度全部进锁定枚举句
  assert.ok(
    result.prose.includes(
      "时长与节奏、构图、镜头运动、主体运动轨迹、场景与物体、光线、色调与调色、画幅与镜头特性、原音频、自然瑕疵感都保持不变，不要修改",
    ),
  );
  // 无增量 → 不出现白名单句
  assert.ok(!result.prose.includes("唯一新增的内容是"));
  // 镜头继承声明与技术规格继承句自动兜底
  assert.ok(result.prose.includes("镜头要求：完全继承@视频1原本的镜头运动"));
  assert.ok(result.prose.includes("限制条件：总时长与@视频1完全一致。"));
  // 缺省块不占段
  const segments = result.provenance.map((entry) => entry.segment);
  assert.deepEqual(segments, ["edit_intent", "edit_lock", "edit_camera", "edit_techspec"]);
});

/* ---------------- 槽位：编号分配与稳定性 ---------------- */

function slotAssets(): readonly PromptAsset[] {
  return [
    { id: "img_hero", media: "image", role: "character", lock: { mode: "full" }, scope: "global", description: "主角身份参考" },
    { id: "vid_comp", media: "video", role: "composition", lock: { mode: "dimension", dimension: "构图" }, scope: "global" },
    {
      id: "img_scene",
      media: "image",
      role: "scene",
      lock: { mode: "partial", inherit: ["房间结构"], override: ["窗外风景", "室内氛围"] },
      scope: "global",
    },
    { id: "vid_motion", media: "video", role: "motion", lock: { mode: "dimension", dimension: "运镜" }, scope: "global" },
    { id: "img_prop", media: "image", role: "prop", lock: { mode: "full" }, scope: "global", description: "关键道具" },
  ];
}

function slotShots(): readonly PromptShot[] {
  return [
    { id: "S1", start_s: 0, end_s: 10, refs: ["img_prop", "vid_motion"], action: "镜头扫过{{img_prop}}，运镜跟随{{vid_motion}}" },
  ];
}

test("槽位：3 图 2 视频分开编号，映射表与 prose 一致", () => {
  const result = compileGeneratePrompt(miniGenerateIr(slotAssets(), slotShots()));
  // 图片、视频各自按 IR 数组顺序从 1 编号（交错不影响）
  assert.deepEqual(result.slots, [
    { asset_id: "img_hero", token: "@图像1", media: "image", role: "character" },
    { asset_id: "vid_comp", token: "@视频1", media: "video", role: "composition" },
    { asset_id: "img_scene", token: "@图像2", media: "image", role: "scene" },
    { asset_id: "vid_motion", token: "@视频2", media: "video", role: "motion" },
    { asset_id: "img_prop", token: "@图像3", media: "image", role: "prop" },
  ]);
  // prose 中的 @N 与映射表逐一一致
  for (const slot of result.slots) {
    const segment = result.provenance.find((entry) => entry.segment === `asset:${slot.asset_id}`)!;
    assert.ok(segment.text.includes(slot.token), `${slot.asset_id} 声明段未出现 ${slot.token}`);
  }
  // 三种 LockStrength 的编译形态
  assert.ok(result.prose.includes("参考图@图像1——主角身份参考。100% 匹配参考图。"));
  assert.ok(result.prose.includes("参考@视频1的构图。"));
  assert.ok(result.prose.includes("参考@图像2，继承其房间结构，但窗外风景、室内氛围完全不同。"));
  assert.ok(result.prose.includes("参考@视频2的运镜。"));
  // refs 与内联占位都解析为 @N
  assert.ok(result.prose.includes("参考@图像3、@视频2。镜头扫过@图像3，运镜跟随@视频2。"));
});

test("槽位稳定性：中间删资产重编译，编号前移且引用同步，IR 不被改写", () => {
  const ir = miniGenerateIr(slotAssets(), slotShots());
  const snapshot = JSON.stringify(ir);
  const before = compileGeneratePrompt(ir);
  assert.ok(before.prose.includes("镜头扫过@图像3"));

  // 从中间删掉 img_scene：其后图片编号前移是预期行为，视频编号不受影响
  const trimmed = miniGenerateIr(slotAssets().filter((asset) => asset.id !== "img_scene"), slotShots());
  const after = compileGeneratePrompt(trimmed);
  assert.deepEqual(
    after.slots.map((slot) => [slot.asset_id, slot.token]),
    [
      ["img_hero", "@图像1"],
      ["vid_comp", "@视频1"],
      ["vid_motion", "@视频2"],
      ["img_prop", "@图像2"],
    ],
  );
  // 正文引用由编译器生成，随编号同步更新（IR 层从不手存 @N）
  assert.ok(after.prose.includes("参考@图像2、@视频2。镜头扫过@图像2，运镜跟随@视频2。"));
  assert.ok(after.prose.includes("参考@视频1的构图。"));
  assert.ok(after.prose.includes("参考@视频2的运镜。"));
  assert.ok(!after.prose.includes("@图像3"));
  // @N 只存在于编译产物：编译不回写 IR
  assert.equal(JSON.stringify(ir), snapshot);
});

test("别名绑定：显示层 @her 与身份锁定句", () => {
  const ir = miniGenerateIr(
    [
      {
        id: "img_lynx",
        media: "image",
        role: "character",
        label: "女间谍",
        alias: "her",
        description: "精瘦的拟人猞猁女性",
        lock: { mode: "full" },
        scope: "global",
      },
    ],
    [{ id: "S1", start_s: 0, end_s: 10, action: "{{img_lynx}}转身离开" }],
  );
  const result = compileGeneratePrompt(ir);
  const slot = result.slots.find((item) => item.asset_id === "img_lynx")!;
  assert.equal(slot.token, "@图像1");
  assert.equal(slot.alias, "@her");
  assert.ok(result.prose.includes("参考@图像1：@her——精瘦的拟人猞猁女性。100% 匹配参考图。"));
});

/* ---------------- provenance 回源映射 ---------------- */

test("provenance：GENERATE 黄金样本覆盖所有段且无悬空路径", () => {
  const ir = drunkIr();
  const result = compileGeneratePrompt(ir);
  assertProvenanceSound(result, ir);
  const segments = result.provenance.map((entry) => entry.segment);
  for (const expected of [
    "header",
    "global_style",
    "asset:char_drunk_man",
    "global_camera",
    "global_physics",
    "global_audio",
    "timeline",
    "shot:S1",
    "shot:S3",
    "shot:S7",
    "constraint_tail",
  ]) {
    assert.ok(segments.includes(expected), `缺少段：${expected}`);
  }
  // 段级来源路径示例：shot:S3 → shots[2]（含 camera 细路径）
  const shotS3 = result.provenance.find((entry) => entry.segment === "shot:S3")!;
  assert.ok(shotS3.source.includes("shots[2]"));
  assert.ok(shotS3.source.includes("shots[2].camera"));
  const asset = result.provenance.find((entry) => entry.segment === "asset:char_drunk_man")!;
  assert.deepEqual(asset.source, ["assets[0]", "assets[0].lock"]);
  const tail = result.provenance.find((entry) => entry.segment === "constraint_tail")!;
  for (const path of ["meta.duration_s", "meta.genre", "meta.beats", "assets", "global.style", "global.audio"]) {
    assert.ok(tail.source.includes(path), `约束尾缺少来源：${path}`);
  }
});

test("provenance：EDIT 黄金样本覆盖所有段且无悬空路径", () => {
  const ir = trainIr();
  const result = compileEditPrompt(ir);
  assertProvenanceSound(result, ir);
  const segments = result.provenance.map((entry) => entry.segment);
  assert.deepEqual(segments, [
    "edit_intent",
    "edit_style",
    "edit_lock",
    "addition:画面转色规则",
    "addition:银幕破裂锁定",
    "edit_delta_fields",
    "edit_subject",
    "edit_camera",
    "edit_audio",
    "edit_techspec",
  ]);
  const lock = result.provenance.find((entry) => entry.segment === "edit_lock")!;
  assert.deepEqual(lock.source, ["base", "fields", "additions"]);
  const addition = result.provenance.find((entry) => entry.segment === "addition:画面转色规则")!;
  assert.deepEqual(addition.source, ["additions[0]"]);
});

/* ---------------- 伪精度透传与确定性 ---------------- */

test("数值伪精度：字符串原样透传，verified 仅类型标注不影响产物", () => {
  const base = drunkIr();
  const asString = compileGeneratePrompt(base);
  const asClaim = compileGeneratePrompt({
    ...base,
    global: {
      ...base.global,
      style: { ...base.global.style, palette_603010: { text: "深蓝(60)/霓虹(30)/暖黄(10)", verified: false } },
    },
  });
  assert.ok(asString.prose.includes("60:30:10 配色 —— 深蓝黑色夜空+湿润钢铁玻璃(60)/青与品红霓虹光晕+广告牌光(30)/汗衫的白+汉堡包装的暖黄+招牌高光炫光(10)"));
  assert.ok(asClaim.prose.includes("60:30:10 配色 —— 深蓝(60)/霓虹(30)/暖黄(10)"));
  // 编译器纯确定性：同 IR 同输出（prose / provenance / slots 全等）
  const again = compileGeneratePrompt(base);
  assert.deepEqual(again, asString);
});

/* ---------------- 分镜叙事复用 parseShotScript ---------------- */

test("script 复用：画面/对白确定性拆分，refs 按命中排序", () => {
  const ir = miniGenerateIr(
    [
      { id: "char_a", media: "image", role: "character", label: "醉汉主角", lock: { mode: "full" }, scope: "global" },
      { id: "char_b", media: "image", role: "character", label: "警察", lock: { mode: "full" }, scope: "global" },
    ],
    [
      {
        id: "S1",
        start_s: 0,
        end_s: 5,
        refs: ["char_b", "char_a"],
        script: "夜·内\n醉汉主角摇摇晃晃走到天台边\n风很大，霓虹闪烁\n醉汉主角：再来一瓶！",
      },
    ],
  );
  const result = compileGeneratePrompt(ir);
  const shot = result.provenance.find((entry) => entry.segment === "shot:S1")!;
  // 场景行进画面、对白行原样成句；refs 声明序 [char_b, char_a] 按文本命中重排为 [char_a, char_b]
  assert.equal(
    shot.text,
    "S1(0–5秒) —— 参考@图像1、@图像2。夜·内；醉汉主角摇摇晃晃走到天台边；风很大，霓虹闪烁。醉汉主角：再来一瓶！",
  );
});

/* ---------------- 品牌文字块 ---------------- */

test("品牌文字块：位于时间轴之后、约束尾之前", () => {
  const ir: GenerateIR = {
    ...miniGenerateIr([drunkAsset], [{ id: "S1", start_s: 0, end_s: 10, action: "主角吃完汉堡" }]),
    brand: { text: "seedance", timing: "结尾黑屏" },
  };
  const { prose } = compileGeneratePrompt(ir);
  assert.ok(prose.includes("品牌文字 —— 结尾黑屏：画面出现“seedance”字样。"));
  assertBlockOrder(prose, ["S1(0–10秒)", "品牌文字 ——", "正向约束 ——"]);
});

/* ---------------- 编译期错误 ---------------- */

test("编译期错误：未知引用与非法 EDIT 基础资产", () => {
  // 正文内联占位引用未知 asset_id
  assert.throws(
    () => compileGeneratePrompt(miniGenerateIr([], [{ id: "S1", start_s: 0, end_s: 5, action: "{{ghost}}出场" }])),
    /未知资产引用/,
  );
  // refs 引用未知 asset_id
  assert.throws(
    () => compileGeneratePrompt(miniGenerateIr([], [{ id: "S1", start_s: 0, end_s: 5, refs: ["ghost"] }])),
    /未知资产引用/,
  );
  // EDIT 基础视频未注册
  assert.throws(
    () => compileEditPrompt({ kind: "edit", intent: "测试", base: "ghost_video", assets: [] }),
    /未在资产注册表/,
  );
  // EDIT 基础资产必须是 video 媒介
  assert.throws(
    () =>
      compileEditPrompt({
        kind: "edit",
        intent: "测试",
        base: "img_wrong",
        assets: [{ id: "img_wrong", media: "image", role: "scene", scope: "global" }],
      }),
    /必须是 video/,
  );
});
