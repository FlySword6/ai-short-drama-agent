/* ============================================================
   gen-node-features.tsx — S66 生成节点功能位渲染(libTV 三段式的「编辑条 / chips / 模式选择器」)

   渲染唯一数据源 = ../gen-node-capability.ts 的功能位映射(三态):
   - wired       已接真:正常可点,点击走 onAction(id) 调真实能力;
   - planned     未实装:灰显禁用 + tooltip「规划中:…」(Fable 裁决:不做假按钮);
   - needs_media 需产物在场:无产物灰显 + 条件 tooltip;有产物 = 真能力。
   功能位清单/文案/能力对照一律读数据文件,本文件只管呈现——
   渲染、回执「功能位映射表」、组件测试三处不允许漂。

   禁用一律用 aria-disabled(不用 disabled 属性):灰显项仍要可聚焦、可悬浮出 tooltip,
   点击被 onClick 里的 enabled 闸门拦下。
   显式 React import:node:test + tsx classic JSX 渲染断言与 Vite react-jsx 双兼容。
   ============================================================ */

import * as React from "react";
import {
  Aperture,
  CameraRotate,
  CaretDown,
  CornersOut,
  Crop,
  DownloadSimple,
  FilmSlate,
  Globe,
  GridFour,
  GridNine,
  HighDefinition,
  MagicWand,
  Plus,
  Scissors,
  ShootingStar,
  StackSimple,
  Subtitles,
  SunDim,
  Tag,
  UserFocus,
  Users,
  WaveSine,
  type Icon,
} from "@phosphor-icons/react";
import type { GenNodeFeatureSlot } from "../gen-node-capability";
import { AUTO_VALIDATE_SWITCH_TOOLTIP } from "../gen-node-capability";
import { cn } from "./ui/cn";
import { Switch, Tooltip } from "./ui/primitives";

/** 功能位 id → 图标(纯呈现映射,不是能力数据;能力真源在 gen-node-capability.ts)。 */
const GEN_NODE_ICONS: Record<string, Icon> = {
  portrait: UserFocus,
  panorama: Globe,
  "multi-angle": StackSimple,
  relight: SunDim,
  "grid-9": GridNine,
  hd: HighDefinition,
  "grid-split": GridFour,
  download: DownloadSimple,
  fullscreen: CornersOut,
  trim: Scissors,
  crop: Crop,
  parse: FilmSlate,
  "subtitle-removal": Subtitles,
  "audio-split": WaveSine,
  "visual-edit": MagicWand,
  "add-ref": Plus,
  marker: Tag,
  style: Aperture,
  fx: ShootingStar,
  "character-lib": Users,
  "camera-move": CameraRotate,
};

/** libTV 编辑条里带 ▾ 的项(智能去字幕/音频分离/画面编辑);纯呈现,不代表已有子菜单。 */
const DROPDOWN_HINT_IDS: ReadonlySet<string> = new Set(["subtitle-removal", "audio-split", "visual-edit"]);

/** 三态 → 是否可点:wired 恒可点;needs_media 看产物在场;planned 恒不可点。 */
function slotEnabled(slot: GenNodeFeatureSlot, mediaReady: boolean): boolean {
  return slot.state === "wired" || (slot.state === "needs_media" && mediaReady);
}

function FeatureButton({ slot, mediaReady, onAction, className }: {
  slot: GenNodeFeatureSlot;
  mediaReady: boolean;
  onAction: (id: string) => void;
  className: string;
}): React.JSX.Element {
  const enabled = slotEnabled(slot, mediaReady);
  const IconNode = GEN_NODE_ICONS[slot.id] ?? Plus;
  return (
    <Tooltip content={slot.tooltip}>
      <button
        type="button"
        aria-disabled={!enabled}
        aria-label={slot.label}
        className={cn(className, enabled ? "text-ink-2 hover:bg-surface-2 hover:text-ink-1" : "cursor-not-allowed text-ink-3")}
        onClick={() => { if (enabled) onAction(slot.id); }}
      >
        <IconNode aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="whitespace-nowrap">{slot.label}</span>
        {slot.badge ? <span className="rounded-sm bg-accent-subtle px-1 text-[9px] font-semibold leading-4 text-accent-text">{slot.badge}</span> : null}
        {DROPDOWN_HINT_IDS.has(slot.id) ? <CaretDown aria-hidden="true" className="size-3 shrink-0 text-ink-4" /> : null}
      </button>
    </Tooltip>
  );
}

const EDIT_BAR_BUTTON_CLASS = "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent";

/**
 * 节点编辑条(libTV:画布上方一排工具,下载/全屏固定右置)。
 * onAction 只会在功能位可用时触发;planned 项被闸门拦下,页面无需再判。
 */
export function GenNodeEditBar({ features, mediaReady, onAction, ariaLabel }: {
  features: readonly GenNodeFeatureSlot[];
  /** 当前画布是否有产物(needs_media 功能位的可用条件)。 */
  mediaReady: boolean;
  onAction: (id: string) => void;
  ariaLabel: string;
}): React.JSX.Element {
  const trailing = features.filter((slot) => slot.id === "download" || slot.id === "fullscreen");
  const leading = features.filter((slot) => !trailing.includes(slot));
  return (
    <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border-1 px-2 py-1" role="toolbar" aria-label={ariaLabel}>
      {leading.map((slot) => <FeatureButton key={slot.id} slot={slot} mediaReady={mediaReady} onAction={onAction} className={EDIT_BAR_BUTTON_CLASS} />)}
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {trailing.map((slot) => <FeatureButton key={slot.id} slot={slot} mediaReady={mediaReady} onAction={onAction} className={EDIT_BAR_BUTTON_CLASS} />)}
      </span>
    </div>
  );
}

const CHIP_BUTTON_CLASS = "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent";

/** 生成卡 chips 行(libTV:图片=参考/标记/风格;视频=参考/标记/特效/角色库/运镜;add-ref 的「+」由 Plus 图标承载,K-goal-04 条 1)。 */
export function GenNodeChips({ features, mediaReady, onAction, ariaLabel }: {
  features: readonly GenNodeFeatureSlot[];
  mediaReady: boolean;
  onAction: (id: string) => void;
  ariaLabel: string;
}): React.JSX.Element {
  return (
    <div className="gen-node-chips flex flex-wrap items-center gap-1.5" aria-label={ariaLabel}>
      {features.map((slot) => (
        <FeatureButton
          key={slot.id}
          slot={slot}
          mediaReady={mediaReady}
          onAction={onAction}
          className={cn(CHIP_BUTTON_CLASS, slotEnabled(slot, mediaReady) ? "border-border-1 bg-surface-2" : "border-border-1 bg-surface-1")}
        />
      ))}
    </div>
  );
}

/**
 * 「自动校验素材」开关(S73 修,生成卡高级设置):规划中,恒关不可开。
 * 破过的纪律:S66 自己定了「禁用一律 aria-disabled」,这枚却用了 disabled——
 * disabled 的 input 不吃 hover/focus,tooltip 永远出不来(验收实测)。aria-disabled
 * 保持可聚焦可悬浮,点击被 onChange/onClick 闸门拦下,不做假开关。
 */
export function AutoValidateSwitch(): React.JSX.Element {
  return (
    <Tooltip content={AUTO_VALIDATE_SWITCH_TOOLTIP}>
      <span className="inline-flex items-center gap-1.5">
        <Switch checked={false} ariaDisabled label="自动校验素材" onChange={() => undefined} />
        <span className="text-xs text-ink-3">自动校验素材</span>
      </span>
    </Tooltip>
  );
}

/**
 * 视频生成卡模式选择器(libTV:文生视频/全能参考/图生视频/首尾帧/图片参考)。
 * 未实装的模式灰显 + tooltip「规划中」;可选模式选中态 = 页面 videoMode。
 */
export function VideoModeSelector({ modes, mediaReady, value, onChange, ariaLabel }: {
  modes: readonly GenNodeFeatureSlot[];
  mediaReady: boolean;
  /** 当前选中模式 id(页面生效模式:无确认图=omni,有确认图默认可切 i2v)。 */
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}): React.JSX.Element {
  return (
    <div className="inline-flex max-w-full flex-wrap items-center gap-0.5 self-start rounded-md border border-border-1 bg-surface-0 p-0.5" role="group" aria-label={ariaLabel}>
      {modes.map((slot) => {
        const enabled = slotEnabled(slot, mediaReady);
        const selected = value === slot.id;
        return (
          <Tooltip key={slot.id} content={slot.tooltip}>
            <button
              type="button"
              aria-disabled={!enabled}
              aria-pressed={selected}
              className={cn(
                "inline-flex items-center whitespace-nowrap rounded-sm px-2 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                selected ? "bg-surface-2 font-medium text-ink-1" : enabled ? "text-ink-2 hover:bg-surface-2 hover:text-ink-1" : "cursor-not-allowed text-ink-3",
              )}
              onClick={() => { if (enabled) onChange(slot.id); }}
            >{slot.label}</button>
          </Tooltip>
        );
      })}
    </div>
  );
}
