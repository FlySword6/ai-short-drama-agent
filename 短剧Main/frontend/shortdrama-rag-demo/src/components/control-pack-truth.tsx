/* ============================================================
   control-pack-truth.tsx — 生成卡「参考集真相条」(K2K/GP-11+16+17+18)
   块 2 自镜级工作台(已归档)挪出的活资产:提交层/不随提交层的如实呈现。
   段落工作台接线=块 3 首项(靶单欠件表),接线前本组件仅测试在跑。
   ============================================================ */
import * as React from "react";
import { referenceMediaCounts, type ControlPackExclusion, type ControlPackReference } from "../control-pack";
import { REFERENCE_LANES } from "../reference-lanes";

/**
 * 提交模式人话（K2K/GP-17，与视频页签 videoMode 口径一致）：
 * 视频 + 有确认图 = 按图生成（确认图作首帧）；其余 = 多模态参考（全能参考）。
 * byImage 由提交点实况推导（kind==="video" && 有确认图；K-goal-04 起确认抽屉退场，
 * 与 startGeneration 组装 payload 的首帧口径一致）。
 */
export function submissionModeLabel(byImage: boolean): string {
  return byImage ? "按图生成（确认图作首帧）" : "多模态参考（全能参考）";
}

/** 锚帧占用判定（K2K/GP-18）：mediaId 被设为锚帧时返回其角色，否则 null。 */
export function anchorRoleFor(mediaId: string, firstFrameId: string | null, lastFrameId: string | null): "首帧" | "尾帧" | null {
  if (firstFrameId === mediaId) return "首帧";
  if (lastFrameId === mediaId) return "尾帧";
  return null;
}

/** 参考集按控制包职责分组（六组顺序，空组不出现）；分组展示与提交取数共用同一数组源。 */
export function groupControlPackReferences(options: readonly ControlPackReference[]): { label: string; options: ControlPackReference[] }[] {
  const groups = new Map<string, ControlPackReference[]>();
  for (const option of options) {
    const list = groups.get(option.laneLabel) ?? [];
    list.push(option);
    groups.set(option.laneLabel, list);
  }
  return REFERENCE_LANES.filter((lane) => groups.has(lane.label)).map((lane) => ({ label: lane.label, options: groups.get(lane.label)! }));
}

/**
 * K-goal-04 条 4：生成卡常驻「随提交/不随提交」真相条（原确认抽屉分层挪到主界面）。
 * 铁律不变（K2K）：静默丢弃是最接近数据丢失的一类，用户交了什么自己必须知道——
 * 只是不再藏进弹窗，挂在提交点旁边的生成卡上常驻：
 * - 随提交：控制包全量计数 + 提交模式人话 + 参考图 N · 视频 M 分计（GP-17 口径）；
 * - 不随提交：逐项点名+人话原因（GP-11+GP-16），弱显，悬停可见完整原因；
 * 控制包全空（两层都没有）时不渲染——没有真相可述就不占位。
 */
export function ControlPackSubmitTruth({ options, excluded, byImage }: {
  /** 随本次提交的参考集（partitionControlPack.submitted，与提交 payload 同源）。 */
  options: readonly ControlPackReference[];
  /** 不随本次提交的栏条目（partitionControlPack.excluded，逐项+原因）。 */
  excluded: readonly ControlPackExclusion[];
  /** 提交模式：视频且有确认图=按图生成（确认图作首帧），其余=多模态参考（与提交口径一致）。 */
  byImage: boolean;
}): React.JSX.Element | null {
  if (options.length === 0 && excluded.length === 0) return null;
  const mediaCounts = referenceMediaCounts(options);
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border-1 bg-surface-2 px-3 py-2" data-testid="control-pack-submit-truth">
      <p className="m-0 text-[11px] text-ink-2" data-testid="submission-mode-line">
        随本次提交：{options.length} 项 · 提交模式：{submissionModeLabel(byImage)} · 参考图 {mediaCounts.images} · 视频 {mediaCounts.videos}
      </p>
      {excluded.length > 0 ? (
        <div className="flex flex-col gap-0.5" data-testid="control-pack-excluded">
          <span className="text-[11px] font-medium text-ink-4">不随本次提交（{excluded.length} 项，原因悬停可见）</span>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {excluded.map((item) => (
              <li
                className="truncate text-[11px] leading-relaxed text-ink-4"
                key={item.itemId}
                title={`${item.name}（${item.laneLabel}）——${item.reason}`}
                data-excluded-item={item.itemId}
              >
                <span className="text-ink-2">{item.name}</span>（{item.laneLabel}）——{item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
