/* ============================================================
   gen-node-capability.ts — S66 生成节点功能位能力映射(数据真源)

   Fable 裁决(S66 任务包「我们的落地边界」第 1 条):能力映射,不做假按钮——
   编辑条与模式选择器逐项对照后端已有能力:有的接真(wired);没有的灰显
   +tooltip「规划中」(planned);需要产物在场的标注条件(needs_media)。

   本文件是唯一真源:工具条/chips/模式选择器渲染读它,回执「功能位映射表」
   从它誊写,组件测试逐条断言——三处不允许漂。
   纯数据,零 DOM,node:test 直接 import。
   ============================================================ */

/** wired=已接真(点击走真实能力);planned=未实装(灰显+tooltip「规划中」);needs_media=有产物才可用(无产物灰显+条件 tooltip)。 */
export type GenNodeFeatureState = "wired" | "planned" | "needs_media";

export interface GenNodeFeatureSlot {
  id: string;
  /** 功能位标签(libTV 口径,设计真源不改名)。 */
  label: string;
  state: GenNodeFeatureState;
  /** 灰显/条件时的悬浮说明(如实写明现状与去处,不写工程话)。 */
  tooltip: string;
  /** libTV 角标(如人像质感调节的 NEW)。 */
  badge?: "NEW";
  /** 我们侧的真实能力对照(回执「功能位→我们能力→状态」映射表的能力列)。 */
  capability: string;
}

/* ---------- 图片节点编辑条(画布上方;下载/全屏固定右置) ---------- */

export const IMAGE_EDIT_FEATURES: readonly GenNodeFeatureSlot[] = [
  {
    id: "portrait",
    label: "人像质感调节",
    state: "planned",
    badge: "NEW",
    tooltip: "规划中:人像质感(磨皮/质感增强)编辑能力规划中",
    capability: "无(图像产物编辑链未建)",
  },
  {
    id: "panorama",
    label: "全景",
    state: "planned",
    tooltip: "规划中:产物级全景编辑规划中;全景生成可走下方「风格」模板区的 720 全景模板",
    capability: "生成侧:720 全景模板(image-presets);产物编辑:无",
  },
  {
    id: "multi-angle",
    label: "多角度",
    state: "planned",
    tooltip: "规划中:产物级多角度编辑规划中;多机位画面可走「风格」模板区多机位九宫格",
    capability: "生成侧:多机位九宫格模板;产物编辑:无",
  },
  {
    id: "relight",
    label: "打光",
    state: "planned",
    tooltip: "规划中:产物级打光/重打光编辑能力规划中",
    capability: "无",
  },
  {
    id: "grid-9",
    label: "九宫格",
    state: "planned",
    tooltip: "规划中:产物级九宫格编辑规划中;九宫格分镜生成可走「风格」模板区",
    capability: "生成侧:九宫格分镜模板;产物编辑:无",
  },
  {
    id: "hd",
    label: "高清",
    state: "planned",
    tooltip: "规划中:产物级超分/高清化规划中;生成侧清晰度在下方参数里选",
    capability: "生成侧:清晰度维度(参数 popover);产物超分:无",
  },
  {
    id: "grid-split",
    label: "宫格切分",
    state: "needs_media",
    tooltip: "把这张图按宫格等分裁切,逐格入资产库(先生成图片)",
    capability: "已实装:GridSplitModal(产物宫格切分→项目资产+粗剪素材)",
  },
  {
    id: "download",
    label: "下载",
    state: "needs_media",
    tooltip: "下载当前图片产物(先生成图片)",
    capability: "已实装:产物 download_url/storage_url 下载",
  },
  {
    id: "fullscreen",
    label: "全屏",
    state: "wired",
    tooltip: "画布全屏(再按 Esc 退出)",
    capability: "已实装:画布 Fullscreen API",
  },
];

/* ---------- 视频节点编辑条(画布上方;下载/全屏固定右置) ---------- */

export const VIDEO_EDIT_FEATURES: readonly GenNodeFeatureSlot[] = [
  {
    id: "trim",
    label: "剪辑",
    state: "planned",
    tooltip: "规划中:视频剪辑(掐头去尾/分段)能力规划中",
    capability: "无",
  },
  {
    id: "crop",
    label: "裁剪",
    state: "planned",
    tooltip: "规划中:画面裁剪能力规划中",
    capability: "无",
  },
  {
    id: "hd",
    label: "高清",
    state: "planned",
    tooltip: "规划中:视频超分/高清化规划中;生成侧清晰度在下方参数里选",
    capability: "生成侧:清晰度维度(参数 popover);产物超分:无",
  },
  {
    id: "parse",
    label: "解析",
    state: "planned",
    tooltip: "规划中:视频内容解析(拆镜/逐镜理解)规划中",
    capability: "无",
  },
  {
    id: "subtitle-removal",
    label: "智能去字幕",
    state: "planned",
    tooltip: "规划中:智能去字幕能力规划中",
    capability: "无",
  },
  {
    id: "audio-split",
    label: "音频分离",
    state: "planned",
    tooltip: "规划中:音频分离规划中(音频生成链 fail-closed 中,归音频链路包)",
    capability: "无(音频链 fail-closed)",
  },
  {
    id: "visual-edit",
    label: "画面编辑",
    state: "needs_media",
    tooltip: "以当前视频为底做受控编辑(默认全锁,只改你声明的部分;先有视频产物)",
    capability: "已实装:EditComposer(声明式受控编辑,编译 IR 提交)",
  },
  {
    id: "download",
    label: "下载",
    state: "needs_media",
    tooltip: "下载当前视频产物(先生成视频;结果保存完成后可下载)",
    capability: "已实装:api.downloadMedia(登录校验后下载)",
  },
  {
    id: "fullscreen",
    label: "全屏",
    state: "wired",
    tooltip: "画布全屏(再按 Esc 退出)",
    capability: "已实装:画布 Fullscreen API",
  },
];

/* ---------- 生成卡 chips(libTV:图片=+参考/标记/风格;视频=+参考/标记/特效/角色库/运镜) ----------
   K-goal-04 条 1:add-ref 标签去掉文字「+」——chip 已带 Plus 图标,图标+文字两个加号重复;
   留图标(仓内 Button/chip 惯例=图标承载动作义+名词短语标签,如 icon={<Plus/>}>加入项目、标记/风格 chip)。 */

export const IMAGE_CHIPS: readonly GenNodeFeatureSlot[] = [
  {
    id: "add-ref",
    label: "参考",
    state: "wired",
    tooltip: "从资产库选参考图,加入本次生成的参考集",
    capability: "已实装:AssetPickDrawer(browse 模式)",
  },
  {
    id: "marker",
    label: "标记",
    state: "planned",
    tooltip: "规划中:参考图区域标记(涂抹指定参考区域)规划中",
    capability: "无",
  },
  {
    id: "style",
    label: "风格",
    state: "wired",
    tooltip: "展开风格/分镜模板(14 个定稿预设,选中预填提示词并按设计画幅切档)",
    capability: "已实装:图片模板预设区(IMAGE_PRESETS,S59 迁至提示词区上方)",
  },
];

export const VIDEO_CHIPS: readonly GenNodeFeatureSlot[] = [
  {
    id: "add-ref",
    label: "参考",
    state: "wired",
    tooltip: "从资产库选参考,加入本次生成的参考集",
    capability: "已实装:AssetPickDrawer(browse 模式)",
  },
  {
    id: "marker",
    label: "标记",
    state: "planned",
    tooltip: "规划中:参考区域标记规划中",
    capability: "无",
  },
  {
    id: "fx",
    label: "特效",
    state: "planned",
    tooltip: "规划中:视频特效模板(运镜特效/转场特效)规划中",
    capability: "无",
  },
  {
    id: "character-lib",
    label: "角色库",
    state: "wired",
    tooltip: "从角色类资产里选参考(只列角色)",
    capability: "已实装:AssetPickDrawer 角色槽(词表 pickKind=character)",
  },
  {
    id: "camera-move",
    label: "运镜",
    state: "wired",
    tooltip: "去工作台首页的运镜组整理运镜参考与机位方案",
    capability: "已实装:参考清单运镜车道(camera_motion lane+机位方案)",
  },
];

/* ---------- 视频生成卡模式选择器(libTV:文生视频/全能参考/图生视频/首尾帧/图片参考) ---------- */

export const VIDEO_MODES: readonly GenNodeFeatureSlot[] = [
  {
    id: "t2v",
    label: "文生视频",
    state: "planned",
    tooltip: "规划中:当前链路默认携带参考控制包;不带参考的纯文生直选规划中",
    capability: "链路默认带控制包参考;纯文生直选未实装",
  },
  {
    id: "omni",
    label: "全能参考",
    state: "wired",
    tooltip: "参考控制包多模态参考全量随本次生成提交(当前默认链路);有确认图时确认卡默认按图生成,可在卡内切纯文字",
    capability: "已实装:控制包多模态参考(实测可用,默认链路)",
  },
  {
    id: "i2v",
    label: "图生视频",
    state: "needs_media",
    tooltip: "以确认图为首帧按图生成(有确认图时确认卡默认即此模式);先在图片页签确认一张图",
    capability: "有条件实装:有确认图时确认弹窗默认按图生成(首帧 role 透传归后端后续包)",
  },
  {
    id: "anchor-frames",
    label: "首尾帧",
    state: "planned",
    tooltip: "规划中:首尾帧锚定现在可在确认弹窗「高级:锚帧」里设置,卡内直选规划中",
    capability: "确认弹窗·高级锚帧可设;卡内直选未实装",
  },
  {
    id: "image-ref",
    label: "图片参考",
    state: "planned",
    tooltip: "规划中:图片参考是全能参考的子集,独立模式入口规划中",
    capability: "全能参考已含图片参考;独立模式未实装",
  },
];

/** planned 灰显的统一 tooltip 前缀(验收口径:灰显项 tooltip 带「规划中」)。 */
export function plannedTooltip(slot: GenNodeFeatureSlot): string {
  return slot.state === "planned" && !slot.tooltip.startsWith("规划中") ? `规划中:${slot.tooltip}` : slot.tooltip;
}

/* ---------- 生成卡高级设置「自动校验素材」开关(规划中,恒关) ---------- */

/** 「自动校验素材」开关 tooltip(S73 修:原句「规划中」说了两遍;灰显开关一律 aria-disabled,
    tooltip 必须真的悬浮得出——disabled 的 input 不吃 hover/focus,tooltip 名存实亡)。 */
export const AUTO_VALIDATE_SWITCH_TOOLTIP = "规划中:上线后,提交生成前自动校验参考素材的清晰度与可用性";
