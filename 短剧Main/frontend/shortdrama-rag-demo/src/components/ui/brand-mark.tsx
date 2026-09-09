/**
 * BrandMark / BrandLockup / XiaoheiMark — 中文在线品牌件（深色片场）。
 *
 * - BrandMark：蓝色太极标（DC 指定方向，S3 专业化定稿；favicon 用同几何纯色版
 *   #2455DF/#4FC0EE，见 public/favicon.svg）
 * - BrandLockup：太极标 + 「中文在线AI短剧平台」+ 英文副行（全站唯一锁排，
 *   产品名定稿后不再接受自定义 product 文案）
 * - XiaoheiMark：罗小黑吉祥物几何剪影（token 纪律：纯黑轮廓=surface-well、
 *   薄荷青眼睛=accent、底盘=surface-2/border-2——不引入任何新色值）
 * 官方素材包到位前用几何剪影；到位后单点替换 XiaoheiMark。
 */
import * as React from "react";
import { useId } from "react";
import { cn } from "./cn";

const SIZES = {
  sm: "h-5 w-5",
  md: "h-7 w-7",
  lg: "h-10 w-10",
} as const;

/** 蓝色太极标：深蓝圆 + 浅蓝 S 形（渐变 id 按实例唯一，避免同页多实例撞 id）。 */
export function BrandMark({ size = "md", className }: {
  size?: keyof typeof SIZES;
  className?: string;
}): React.JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <svg
      viewBox="0 0 48 48"
      role="img"
      aria-label="中文在线AI短剧平台"
      className={cn("shrink-0", SIZES[size], className)}
    >
      <defs>
        <linearGradient id={`tjDeep${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2F6FEA" /><stop offset="1" stopColor="#1E4FD6" />
        </linearGradient>
        <linearGradient id={`tjLight${uid}`} x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#67D4F2" /><stop offset="1" stopColor="#38A8E8" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="20" fill={`url(#tjDeep${uid})`} />
      <path d="M24 4 A20 20 0 0 1 24 44 A10 10 0 0 1 24 24 A10 10 0 0 0 24 4 Z" fill={`url(#tjLight${uid})`} />
    </svg>
  );
}

/** 品牌锁排：太极标 + 产品名（15px/600）+ 英文副行（11px / 字距 0.14em / 弱色）。 */
export function BrandLockup({ size = "md", className }: {
  size?: keyof typeof SIZES;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <BrandMark size={size} />
      <span className="flex flex-col leading-tight">
        <strong className={`font-semibold text-ink-1 ${size === "lg" ? "text-[17px]" : "text-[15px]"}`}>中文在线AI短剧平台</strong>
        <span className="text-[11px] tracking-[0.14em] text-ink-2">ZHONGWEN ONLINE · AI SHORT DRAMA</span>
      </span>
    </span>
  );
}

/* ---------- 罗小黑吉祥物（几何剪影，token 用色） ---------- */

/** 用色全部取自 tokens.css：纯黑=--surface-well、薄荷青眼=--accent、底盘=--surface-2、环=--border-2。 */
const CAT_BLACK = "oklch(0.00 0 0)";                 // var(--surface-well)
const CAT_EYE = "oklch(0.82 0.15 172)";              // var(--accent)
const BADGE_BG = "oklch(0.235 0.012 260)";           // var(--surface-2)
const BADGE_RING = "oklch(1 0 0 / 0.16)";            // var(--border-2)

export type XiaoheiPose = "sit" | "search" | "shrug" | "run" | "badge";

/** 猫头（耳+头+眼），pose 变体只动耳朵/头倾/眼睛形状——不画崩的安全形状。 */
function CatHead({ pose }: { pose: XiaoheiPose }): React.JSX.Element {
  const tilt = pose === "search" ? -10 : pose === "shrug" ? 14 : 0;
  return (
    <g transform={`rotate(${tilt} 24 26)`}>
      {/* 耳（shrug 时左耳耷拉） */}
      <path d={pose === "shrug" ? "M11 21 L5 12 L20 15 Z" : "M11 19 L7 5 L21 11 Z"} fill={CAT_BLACK} />
      <path d="M37 19 L41 5 L27 11 Z" fill={CAT_BLACK} />
      {/* 头 */}
      <ellipse cx="24" cy="28" rx="18" ry="15" fill={CAT_BLACK} />
      {/* 眼（shrug 眯成半月、其余圆眼薄荷青） */}
      {pose === "shrug" ? (
        <>
          <path d="M13 27 a4.5 4 0 0 0 8 0 Z" fill={CAT_EYE} />
          <path d="M27 27 a4.5 4 0 0 0 8 0 Z" fill={CAT_EYE} />
        </>
      ) : (
        <>
          <ellipse cx="17.5" cy="27" rx="3.6" ry="4.4" fill={CAT_EYE} />
          <ellipse cx="30.5" cy="27" rx="3.6" ry="4.4" fill={CAT_EYE} />
          <ellipse cx="17.5" cy="27.4" rx="1" ry="2.4" fill={CAT_BLACK} />
          <ellipse cx="30.5" cy="27.4" rx="1" ry="2.4" fill={CAT_BLACK} />
        </>
      )}
    </g>
  );
}

/** 尾巴：sit 盘尾绕身、run 翘尾、默认下垂。 */
function CatTail({ pose }: { pose: XiaoheiPose }): React.JSX.Element | null {
  if (pose === "sit") {
    return <path d="M40 34 q10 6 2 12 q-6 4 -12 1" fill="none" stroke={CAT_BLACK} strokeWidth="4.5" strokeLinecap="round" />;
  }
  if (pose === "run") {
    return <path d="M40 30 q9 -2 6 -12" fill="none" stroke={CAT_BLACK} strokeWidth="4.5" strokeLinecap="round" />;
  }
  return null;
}

/**
 * 罗小黑吉祥物（几何剪影）。
 * pose：badge=徽章头像（默认）/ sit=开机祈愿坐姿 / search=翻找歪头 / shrug=加载失败摊手歪头 / run=慢加载奔跑。
 * 出现纪律：单屏至多一处（见 W7-A 拍板门）；官方素材包到位后替换本组件。
 */
export function XiaoheiMark({ pose = "badge", size = 28, className }: {
  pose?: XiaoheiPose;
  size?: number;
  className?: string;
}): React.JSX.Element {
  if (pose === "badge") {
    return (
      <svg aria-hidden="true" viewBox="0 0 48 48" width={size} height={size} className={cn("shrink-0", className)}>
        <circle cx="24" cy="24" r="22" fill={BADGE_BG} stroke={BADGE_RING} strokeWidth="1.4" />
        <CatHead pose="badge" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" width={size} height={size} className={cn("shrink-0", className)}>
      <CatTail pose={pose} />
      <CatHead pose={pose} />
      {pose === "run" ? (
        <>
          <ellipse cx="14" cy="42" rx="5" ry="2" fill={CAT_BLACK} />
          <ellipse cx="28" cy="43" rx="5" ry="2" fill={CAT_BLACK} />
        </>
      ) : null}
    </svg>
  );
}
