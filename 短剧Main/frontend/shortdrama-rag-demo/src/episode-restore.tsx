/* ============================================================
   episode-restore.tsx — 集详情页「已拍画面网格 + 流程阶段条」展示件(EPISODE-RESTORE 单)

   保持 css-free(门禁 node:test 直接 import 做 renderToStaticMarkup 真渲染断言,
   同 production-stepper.tsx 的既有写法);取数与判定全在 episode-frames.ts 纯函数层,
   本文件只摆盘。tk- 体系 class,零 legacy。
   ============================================================ */
import * as React from "react";
import { Check } from "@phosphor-icons/react";
import type { EpisodeStageStep, ShotFrame } from "./episode-frames";
import type { Shot } from "./types";

/** 六步流程条(集详情页「下一步」卡顶部):做完 ✓ / 当前 accent 高亮 / 未做灰。
    只读展示不带动作——动作留在下方下一步条,一页仍只有一个 primary。 */
export function EpisodeStageStrip({ states, error }: {
  states: readonly EpisodeStageStep[] | null;
  error?: string;
}): React.JSX.Element {
  if (error) {
    return <p className="m-0 text-[11px] text-tk-ink-3">流程进度暂时无法读取</p>;
  }
  if (!states) {
    return <p className="m-0 text-[11px] text-tk-ink-3" aria-busy="true">正在读取流程进度…</p>;
  }
  return (
    <ol aria-label="生产流程进度" className="m-0 flex list-none flex-wrap items-center gap-y-1.5 p-0">
      {states.map((step, index) => (
        <li key={step.key} className="flex items-center" aria-current={step.state === "current" ? "step" : undefined}>
          {index > 0 ? <span className="mx-1.5 text-[10px] text-tk-ink-3" aria-hidden="true">→</span> : null}
          <span
            className={[
              "flex size-4 items-center justify-center rounded-full text-[10px]",
              step.state === "complete"
                ? "bg-tk-accent/15 text-tk-accent"
                : step.state === "current"
                  ? "border border-tk-accent font-medium text-tk-accent"
                  : "border border-tk-border-2 text-tk-ink-3",
            ].join(" ")}
          >
            {step.state === "complete" ? <Check aria-hidden="true" className="size-2.5" weight="bold" /> : index + 1}
          </span>
          <span
            className={[
              "ml-1.5 text-[12px]",
              step.state === "current" ? "font-medium text-tk-text" : step.state === "complete" ? "text-tk-ink-2" : "text-tk-ink-3",
            ].join(" ")}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

export interface ShotFrameGridItem {
  shot: Shot;
  frame: ShotFrame;
  sceneName?: string | null;
}

/** 已拍画面网格:这一集已生成成功的镜头缩略图,有多少显示多少;
    点缩略图进对应分场(落点由 episode-frames.shotFrameTarget 给)。 */
export function ShotFrameGrid({ items, onOpen }: {
  items: readonly ShotFrameGridItem[];
  onOpen: (shot: Shot) => void;
}): React.JSX.Element {
  return (
    <section aria-label="已拍画面" className="flex flex-col gap-3">
      <h2 className="m-0 flex items-baseline gap-2 text-[15px] font-semibold text-tk-text">
        已拍画面
        <span className="font-tkmono text-[11px] font-normal text-tk-ink-3">{items.length} 镜</span>
      </h2>
      <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 md:grid-cols-3 xl:grid-cols-4">
        {items.map(({ shot, frame, sceneName }) => (
          <li key={shot.id}>
            <button
              type="button"
              onClick={() => onOpen(shot)}
              aria-label={`进${sceneName ?? "对应分场"} · 镜头 #${shot.shot_no}`}
              title={sceneName ? `${sceneName} · 镜头 #${shot.shot_no}` : `镜头 #${shot.shot_no}`}
              className="flex w-full flex-col gap-1.5 rounded-xl bg-tk-panel p-2 text-left transition-colors hover:bg-tk-elevated"
            >
              <span className="flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-tk-elevated">
                {frame.kind === "video" ? (
                  <video className="h-full w-full object-cover" src={frame.url} muted playsInline preload="metadata" />
                ) : (
                  <img className="h-full w-full object-cover" src={frame.url} alt={`镜头 #${shot.shot_no}`} loading="lazy" />
                )}
              </span>
              <span className="flex items-center gap-1.5 px-0.5">
                <span className="font-tkmono text-[10px] text-tk-ink-3">#{shot.shot_no}</span>
                {sceneName ? <span className="truncate text-[11px] text-tk-ink-2">{sceneName}</span> : null}
                {frame.kind === "video" ? <span className="ml-auto shrink-0 text-[10px] text-tk-ink-3">视频</span> : null}
              </span>
              {shot.script_text ? (
                <span className="line-clamp-2 px-0.5 text-[11px] leading-4 text-tk-ink-2">{shot.script_text}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
