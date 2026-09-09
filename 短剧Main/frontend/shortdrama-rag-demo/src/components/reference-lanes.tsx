/* ============================================================
   reference-lanes.tsx — 工作台「参考清单」六组卡片（DC 去黑话改版）

   统一卡片模板（DC 2026-07-22 裁决）：
     [图标] 角色          ✓ 2 项                [去图片页] [从资产库选]
       （已挂参考物缩略图排开，hover 预览，可摘除）
       建议：每个出场角色锁定 1 张身份定妆图 ✓ / 多角色同框补 1 张比例参考（可选）—
   空组只说一句白话 + 该组自己的动作；界面零自造词（无备料/车间/参考栏/基线）。
   ============================================================ */

import React from "react"; /* 经典 JSX 运行时兜底：LANE_ICONS 为模块级 JSX，tsx 从仓根跑测试时按仓根 tsconfig(无 react-jsx)编译，需显式 React 在作用域 */
import {
  Check,
  CaretDown,
  CircleNotch,
  Sun,
  Cube,
  FilmStrip,
  FolderOpen,
  ImageSquare,
  Minus,
  Mountains,
  MusicNote,
  Package,
  Palette,
  User,
  VideoCamera,
  X,
} from "@phosphor-icons/react";
import { useState } from "react";
import { assetAttachGate, assetReviewLabelOf } from "../asset-review";
import {
  LANE_DOMAINS,
  laneCompleteness,
  laneDef,
  type LaneItem,
  type LanesState,
  type ReferenceLaneDef,
  type ReferenceLaneId,
} from "../reference-lanes";
import { activeColorCards, type ColorCardEntry } from "../color-card-vocabulary";
import type { LaneTaskCardModel } from "../lane-generation-tracker";
import { cn } from "./ui/cn";
import { Button } from "./ui/button";
import { Textarea } from "./ui/primitives";

/* S15-B：iconKey→组件映射（词表元数据驱动）；未知 key 给默认图标，新词条不炸 UI。 */
const ICON_BY_KEY: Record<string, React.JSX.Element> = {
  user: <User aria-hidden="true" />,
  mountains: <Mountains aria-hidden="true" />,
  package: <Package aria-hidden="true" />,
  sun: <Sun aria-hidden="true" />,
  "video-camera": <VideoCamera aria-hidden="true" />,
  "film-strip": <FilmStrip aria-hidden="true" />,
  "music-note": <MusicNote aria-hidden="true" />,
  cube: <Cube aria-hidden="true" />,
  palette: <Palette aria-hidden="true" />,
};

/** 词条图标：iconKey 命中即映射，未知 key 回退 ImageSquare（词表加新参考栏不用改码）。 */
export function laneIcon(lane: ReferenceLaneDef): React.JSX.Element {
  return ICON_BY_KEY[lane.iconKey] ?? <ImageSquare aria-hidden="true" />;
}

/** 组内动作（「去X页/打开X」直达功能页；写机位描述/快抽小样/选一套色卡是组内操作）。 */
export type LaneAction = "generate" | "quick_draft" | "toggle_note" | "toggle_palette" | "open_page";

export interface LaneActionDef {
  key: LaneAction;
  label: string;
  icon: React.JSX.Element;
}

/* 特例动作（写机位描述/快抽小样/打开导演台等组内操作）。 */
const LANE_ACTIONS_SPECIAL: Record<string, readonly LaneActionDef[]> = {
  character: [{ key: "generate", label: "去图片页", icon: <ImageSquare aria-hidden="true" /> }],
  scene: [
    { key: "open_page", label: "打开 3D 导演台", icon: <Cube aria-hidden="true" /> },
    { key: "generate", label: "去图片页", icon: <ImageSquare aria-hidden="true" /> },
  ],
  prop: [{ key: "generate", label: "去图片页", icon: <ImageSquare aria-hidden="true" /> }],
  camera_motion: [
    { key: "toggle_note", label: "写机位描述", icon: <VideoCamera aria-hidden="true" /> },
    { key: "open_page", label: "打开 3D 导演台", icon: <Cube aria-hidden="true" /> },
  ],
  /* K2：toggle 组内色卡区（写机位描述同款先例）。挂接回调 onPickColorCard 缺省时
     按钮不渲染（B 走法：S83 合流后才接线），色卡以只读内容卡呈现。 */
  color_card: [{ key: "toggle_palette", label: "选一套色卡", icon: <Palette aria-hidden="true" /> }],
  reference_video: [
    { key: "quick_draft", label: "快抽运镜小样", icon: <FilmStrip aria-hidden="true" /> },
    { key: "generate", label: "去视频页", icon: <VideoCamera aria-hidden="true" /> },
  ],
  audio: [{ key: "open_page", label: "去音频页", icon: <MusicNote aria-hidden="true" /> }],
};

/** 词条动作：特例优先；新词条按 workshop 给默认功能页入口（词表加新栏不改码）。 */
export function laneActions(lane: ReferenceLaneDef): readonly LaneActionDef[] {
  const special = LANE_ACTIONS_SPECIAL[lane.id];
  if (special) return special;
  switch (lane.workshop) {
    case "video": return [{ key: "generate", label: "去视频页", icon: <VideoCamera aria-hidden="true" /> }];
    case "director": return [{ key: "open_page", label: "打开 3D 导演台", icon: <Cube aria-hidden="true" /> }];
    case "audio": return [{ key: "open_page", label: "去音频页", icon: <MusicNote aria-hidden="true" /> }];
    default: return [{ key: "generate", label: "去图片页", icon: <ImageSquare aria-hidden="true" /> }];
  }
}

export interface ReferenceListProps {
  state: LanesState;
  demoMode: boolean;
  /** 跳转/执行组动作（generate=去生成页并记入归组；open_page=打开 3D 导演台/音频页；quick_draft=快抽小样）。 */
  onLaneAction: (lane: ReferenceLaneId, action: LaneAction) => void;
  /** 从资产库选：打开资产匹配抽屉，选中的资产按职责/类型自动进对应组。 */
  onPickFromLibrary: (lane: ReferenceLaneId) => void;
  /** 摘除生成归入的条目（资产条目走资产管理，不在此摘除）。 */
  onRemoveItem: (lane: ReferenceLaneId, itemId: string) => void;
  /** 运镜组文字描述保存。 */
  onSaveCameraNote: (text: string) => void;
  /** 色卡点选挂接（K2）。状态在 workbench-page 持有，S83 合流后接线一行；
      缺省时「选一套色卡」按钮不渲染，色卡以只读内容卡呈现（B 走法）。 */
  onPickColorCard?: (lane: ReferenceLaneId, entry: ColorCardEntry) => void;
  /** S16 条 2：各栏进行中的生成任务卡（lane id → 卡片模型；缺省=无任务不渲染）。 */
  laneTasks?: Record<string, readonly LaneTaskCardModel[]>;
  /** 任务成功后「归入本栏」（接既有归入机制，不另造）。 */
  onLaneTaskAttach?: (lane: ReferenceLaneId, requestId: string) => void;
  /** 失败任务重试（outcome-unknown 同入口）。 */
  onLaneTaskRetry?: (kind: LaneTaskCardModel["kind"], requestId: string) => void;
  /** K-goal-04 条 4：不随本次提交的栏条目（itemId → 人话原因）——条目常驻弱显+「不随提交」徽标，
      与生成卡真相条同一数据源（partitionControlPack.excluded），弹窗真相挪到主界面。 */
  excludedReasons?: ReadonlyMap<string, string>;
}

export function ReferenceList({ state, demoMode, onLaneAction, onPickFromLibrary, onRemoveItem, onSaveCameraNote, onPickColorCard, laneTasks, onLaneTaskAttach, onLaneTaskRetry, excludedReasons }: ReferenceListProps): React.JSX.Element {
  /* 条 8：三域分区——实体参考（角色/场景/道具）/风格参考（光影/色卡/运镜）/媒介参考（参考视频/音频），
     每域有域标题与收纳（默认展开，可收起；计数随组自动汇总），不再每类一行平铺。 */
  return (
    <div className="flex flex-col gap-4" aria-label="参考清单">
      {LANE_DOMAINS.map((domain) => (
        <DomainSection
          key={domain.id}
          domain={domain}
          state={state}
          onLaneAction={onLaneAction}
          onPickFromLibrary={onPickFromLibrary}
          onRemoveItem={onRemoveItem}
          onSaveCameraNote={onSaveCameraNote}
          onPickColorCard={onPickColorCard}
          laneTasks={laneTasks}
          onLaneTaskAttach={onLaneTaskAttach}
          onLaneTaskRetry={onLaneTaskRetry}
          excludedReasons={excludedReasons}
        />
      ))}
      {/* 降级说明页面级一条，收在清单底部（不逐组重复） */}
      {demoMode ? <p className="text-right text-[11px] text-ink-4">原型演示：归入记录只存本机</p> : null}
    </div>
  );
}

function DomainSection({ domain, state, onLaneAction, onPickFromLibrary, onRemoveItem, onSaveCameraNote, onPickColorCard, laneTasks, onLaneTaskAttach, onLaneTaskRetry, excludedReasons }: {
  domain: { id: string; label: string; lanes: readonly string[] };
  state: LanesState;
  onLaneAction: ReferenceListProps["onLaneAction"];
  onPickFromLibrary: ReferenceListProps["onPickFromLibrary"];
  onRemoveItem: ReferenceListProps["onRemoveItem"];
  onSaveCameraNote: ReferenceListProps["onSaveCameraNote"];
  onPickColorCard?: ReferenceListProps["onPickColorCard"];
  laneTasks?: ReferenceListProps["laneTasks"];
  onLaneTaskAttach?: ReferenceListProps["onLaneTaskAttach"];
  onLaneTaskRetry?: ReferenceListProps["onLaneTaskRetry"];
  excludedReasons?: ReferenceListProps["excludedReasons"];
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const inflight = domain.lanes.reduce((sum, laneId) => sum + (laneTasks?.[laneId]?.filter((card) => card.active).length ?? 0), 0);
  const count = domain.lanes.reduce((sum, laneId) => sum + (state[laneId]?.length ?? 0), 0);
  return (
    <section className="flex flex-col gap-2" aria-label={domain.label}>
      <button
        type="button"
        className="flex items-center gap-2 rounded-md px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <CaretDown aria-hidden="true" className={`size-3.5 text-ink-4 transition-transform duration-150 ${collapsed ? "-rotate-90" : ""}`} />
        <h2 className="text-xs font-semibold tracking-wide text-ink-2">{domain.label}</h2>
        <span className="text-[11px] text-ink-4">{count > 0 ? `${count} 项` : "空"}</span>
        {inflight > 0 ? <span className="rounded-full bg-accent-subtle px-1.5 py-px text-[11px] text-accent-text">{inflight} 个生成中</span> : null}
      </button>
      {collapsed ? null : (
        <div className="flex flex-col gap-3 border-l-2 border-border-1 pl-3">
          {domain.lanes.map((laneId) => {
            const lane = laneDef(laneId);
            return (
              <LaneCard
                key={lane.id}
                lane={lane}
                items={state[lane.id] ?? []}
                tasks={laneTasks?.[lane.id] ?? []}
                onLaneAction={onLaneAction}
                onPickFromLibrary={onPickFromLibrary}
                onRemoveItem={onRemoveItem}
                onSaveCameraNote={onSaveCameraNote}
                onPickColorCard={onPickColorCard}
                onLaneTaskAttach={onLaneTaskAttach}
                onLaneTaskRetry={onLaneTaskRetry}
                excludedReasons={excludedReasons}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function LaneCard({ lane, items, tasks, onLaneAction, onPickFromLibrary, onRemoveItem, onSaveCameraNote, onPickColorCard, onLaneTaskAttach, onLaneTaskRetry, excludedReasons }: {
  lane: ReferenceLaneDef;
  items: LaneItem[];
  tasks: readonly LaneTaskCardModel[];
  onLaneAction: ReferenceListProps["onLaneAction"];
  onPickFromLibrary: ReferenceListProps["onPickFromLibrary"];
  onRemoveItem: ReferenceListProps["onRemoveItem"];
  onSaveCameraNote: ReferenceListProps["onSaveCameraNote"];
  onPickColorCard?: ReferenceListProps["onPickColorCard"];
  onLaneTaskAttach?: ReferenceListProps["onLaneTaskAttach"];
  onLaneTaskRetry?: ReferenceListProps["onLaneTaskRetry"];
  excludedReasons?: ReferenceListProps["excludedReasons"];
}): React.JSX.Element {
  const completeness = laneCompleteness(lane, items);
  const has = items.length > 0;
  const noteItem = items.find((item) => item.id === "note:camera_motion");
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border-1 bg-surface-1 px-4 py-3" aria-label={lane.label} data-lane={lane.id}>
      <header className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-1 [&_svg]:size-4 [&_svg]:text-ink-2">
          {laneIcon(lane)}{lane.label}
        </span>
        {has ? (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <Check aria-hidden="true" className="size-3.5" />{items.length} 项
          </span>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {/* 「选一套色卡」由挂接回调门控：prop 缺省=只读内容卡，按钮不渲染（B 走法） */}
          {laneActions(lane).filter((action) => action.key !== "toggle_palette" || onPickColorCard).map((action) => (
            <Button
              key={action.key}
              size="sm"
              variant="ghost"
              icon={action.icon}
              title={action.key === "quick_draft" ? "先用默认模型快抽一段小样看效果，更细的档位后续开放" : undefined}
              onClick={() => {
                if (action.key === "toggle_note") { setNoteDraft(noteItem?.name ?? ""); setNoteOpen((value) => !value); return; }
                if (action.key === "toggle_palette") { setPaletteOpen((value) => !value); return; }
                onLaneAction(lane.id, action.key);
              }}
            >{action.label}</Button>
          ))}
          <Button size="sm" variant="outline" icon={<FolderOpen />} onClick={() => onPickFromLibrary(lane.id)}>从资产库选</Button>
        </span>
      </header>
      {lane.id === "camera_motion" && noteOpen ? (
        <div className="flex flex-col gap-2 rounded-md border border-border-1 bg-surface-2 p-2">
          <Textarea
            className="min-h-[64px] text-xs"
            value={noteDraft}
            placeholder="例：中景平视缓推，手持感；末镜急停特写…"
            aria-label="机位描述"
            onChange={(event) => setNoteDraft(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={() => { onSaveCameraNote(noteDraft); setNoteOpen(false); }}>保存</Button>
            <Button size="sm" onClick={() => setNoteOpen(false)}>取消</Button>
          </div>
        </div>
      ) : null}
      {/* K2 色卡区：挂接回调就位=toggle 开合；缺省=只读内容卡常驻（B 走法）。 */}
      {lane.id === "color_card" && (onPickColorCard ? paletteOpen : true) ? (
        <ColorCardGallery
          lane={lane}
          onPick={onPickColorCard ? (entry) => { onPickColorCard(lane.id, entry); setPaletteOpen(false); } : undefined}
        />
      ) : null}
      {tasks.length > 0 ? (
        /* S16 条 2：栏内生成任务卡——状态徽章+阶段词+失败人话；完成即预览+一键归入本栏 */
        <ul className="flex flex-col gap-1.5" aria-label={`${lane.label}生成任务`}>
          {tasks.map((card) => (
            <li
              key={card.requestId}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
                card.failed ? "border-danger/40 bg-danger/5" : card.succeeded ? "border-success/40 bg-success/5" : "border-accent/30 bg-accent-subtle/40",
              )}
            >
              {card.active ? <CircleNotch aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-accent-text" /> : null}
              {card.succeeded && card.media ? <img src={card.media.url} alt={`${lane.label}产出预览`} className="size-8 shrink-0 rounded-sm border border-border-1 object-cover" /> : null}
              <span className={cn("font-medium", card.failed ? "text-danger" : card.succeeded ? "text-success" : "text-ink-1")}>{card.statusLabel}</span>
              {card.stageLabel !== card.statusLabel ? <span className="text-ink-3">{card.stageLabel}</span> : null}
              {card.queuePositionText ? <span className="text-ink-2">{card.queuePositionText}</span> : null}
              {card.estimatedDurationText ? <span className="text-ink-2">{card.estimatedDurationText}</span> : null}
              {card.failureText ? <span className="min-w-0 flex-1 truncate text-danger" title={card.failureText}>{card.failureText}</span> : null}
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {card.succeeded && card.media && onLaneTaskAttach ? (
                  <Button size="sm" variant="outline" onClick={() => onLaneTaskAttach(lane.id, card.requestId)}>归入本栏</Button>
                ) : null}
                {card.failed && onLaneTaskRetry ? (
                  <Button size="sm" variant="outline" onClick={() => onLaneTaskRetry(card.kind, card.requestId)}>重试</Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {has ? (
        <ul className="flex flex-wrap items-center gap-2">
          {items.map((item) => (
            <LaneItemThumb key={item.id} lane={lane} item={item} excludedReason={excludedReasons?.get(item.id)} onRemove={() => onRemoveItem(lane.id, item.id)} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink-2">{lane.emptyHint}</p>
      )}
      {/* 完备度页脚：满足与否只认 laneCompleteness（判定真源，reference-lanes.ts），
          不在视图层复刻一份「有条目即到位」的规则——两处各写一遍必然漂移。 */}
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-4">
        {lane.recommended.map((element) => {
          const satisfied = completeness.satisfied.includes(element.key);
          return (
            <span key={element.key} className="inline-flex items-center gap-1">
              {satisfied ? <Check aria-hidden="true" className="size-3 text-success" /> : <Minus aria-hidden="true" className="size-3" />}
              {element.label}{element.required ? "" : "（可选）"}
            </span>
          );
        })}
      </footer>
    </section>
  );
}

/** 色值呈现纪律（color-card-vocabulary 头注释）：# 开头才渲染色块；只记了色名原话的按文字呈现，不猜色。 */
function SwatchChip({ value }: { value: string }): React.JSX.Element | null {
  if (!value) return null;
  if (value.startsWith("#")) {
    return <span className="size-4 rounded-sm border border-border-1" style={{ backgroundColor: value }} />;
  }
  return <span className="text-[11px] text-ink-3">{value}</span>;
}

/**
 * K2 色卡内容卡（六条导演调色，active 条目才上界面）：
 * 色块+名称+情绪词+导演用途。样式纪律：色块=内容数据 inline 色值
 * （≤16px、不投影不发光），不碰 tokens.css/oriental.css；
 * R19 没记的行（如暖调情绪词）不渲染，不编。
 */
function ColorCardGallery({ lane, onPick }: {
  lane: ReferenceLaneDef;
  onPick?: (entry: ColorCardEntry) => void;
}): React.JSX.Element | null {
  const entries = activeColorCards();
  if (entries.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5" aria-label={`${lane.label}内容卡`}>
      {entries.map((entry) => {
        const body = (
          <>
            <span className="flex shrink-0 items-center gap-1">
              <SwatchChip value={entry.primaryHex} />
              <SwatchChip value={entry.secondaryHex} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs font-semibold text-ink-1">{entry.name}</span>
              {entry.mood.length > 0 ? <span className="text-[11px] text-ink-3">情绪：{entry.mood.join("、")}</span> : null}
              {entry.directorUse ? <span className="text-[11px] text-ink-2">导演用途：{entry.directorUse}</span> : null}
            </span>
          </>
        );
        const className = "flex w-full items-center gap-2.5 rounded-md border border-border-1 bg-surface-2 px-2.5 py-2 text-left";
        return (
          <li key={entry.id}>
            {onPick ? (
              <button
                type="button"
                className={cn(className, "outline-none transition-colors hover:border-border-2 focus-visible:ring-2 focus-visible:ring-accent")}
                onClick={() => onPick(entry)}
              >{body}</button>
            ) : (
              <div className={className}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** text 条目徽标按栏取词（原为「机位描述」硬编码：色卡等栏的文本条目会顶错标签）。 */
const TEXT_ITEM_BADGE: Record<string, string> = { camera_motion: "机位描述" };

/** 参考物缩略：hover 160ms 浮现预览卡（hover 只做预览）；生成归入的可摘除。
    K-goal-04 条 4：不随本次提交的条目常驻弱显+「不随提交」徽标（title 带人话原因），
    真相从确认抽屉挪到主界面参考区。 */
function LaneItemThumb({ lane, item, excludedReason, onRemove }: {
  lane: ReferenceLaneDef;
  item: LaneItem;
  /** 不随本次提交的人话原因（partitionControlPack.excluded 同源）；缺省=随提交。 */
  excludedReason?: string;
  onRemove: () => void;
}): React.JSX.Element {
  const [preview, setPreview] = useState(false);
  const [timer, setTimer] = useState(0);
  function schedule(show: boolean): void {
    window.clearTimeout(timer);
    if (show) setTimer(window.setTimeout(() => setPreview(true), 160));
    else setPreview(false);
  }
  const excludedBadge = excludedReason ? (
    <span className="rounded-full bg-surface-1 px-1.5 py-0.5 text-[10px] text-ink-3" title={excludedReason}>不随提交</span>
  ) : null;
  if (item.kind === "text") {
    const badge = TEXT_ITEM_BADGE[lane.id] ?? lane.label;
    return (
      <li
        className={cn("inline-flex max-w-full items-center gap-1.5 rounded-md border border-border-1 bg-surface-2 py-1 pl-2 pr-1.5", excludedReason ? "opacity-60 saturate-50" : "")}
        title={excludedReason ? `${item.name} · 不随本次提交：${excludedReason}` : undefined}
        data-excluded={excludedReason ? "true" : undefined}
      >
        <span className="max-w-[280px] truncate text-xs text-ink-1" title={item.name}>{item.name}</span>
        <span className="rounded-full bg-accent-subtle px-1.5 py-0.5 text-[10px] text-accent-text">{badge}</span>
        {excludedBadge}
        <button
          type="button"
          className="rounded-full p-0.5 text-ink-4 outline-none transition-colors hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent"
          aria-label={`删除${badge}`}
          onClick={onRemove}
        ><X aria-hidden="true" className="size-3" /></button>
      </li>
    );
  }
  if (item.kind === "swatch") {
    /* K2 色卡条目：色块圆点（内容数据 inline 色值，≤16px、不投影不发光）+ 名称 + 可摘除；
       呈现纪律同 SwatchChip——# 开头才渲染圆点，色名原话按文字呈现。 */
    return (
      <li
        className={cn("inline-flex max-w-full items-center gap-1.5 rounded-md border border-border-1 bg-surface-2 py-1 pl-2 pr-1.5", excludedReason ? "opacity-60 saturate-50" : "")}
        title={excludedReason ? `${item.name} · 不随本次提交：${excludedReason}` : undefined}
        data-excluded={excludedReason ? "true" : undefined}
      >
        <span className="flex shrink-0 items-center gap-1">
          {(item.colors ?? []).map((color) => (
            color.startsWith("#") ? (
              <span key={color} className="size-3.5 rounded-full border border-border-1" style={{ backgroundColor: color }} />
            ) : (
              <span key={color} className="text-[10px] text-ink-3">{color}</span>
            )
          ))}
        </span>
        <span className="max-w-[160px] truncate text-xs text-ink-1" title={item.name}>{item.name}</span>
        {item.note ? <span className="max-w-[200px] truncate text-[10px] text-ink-3" title={item.note}>{item.note}</span> : null}
        {excludedBadge}
        <button
          type="button"
          className="rounded-full p-0.5 text-ink-4 outline-none transition-colors hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent"
          aria-label={`从${lane.label}摘除 ${item.name}`}
          onClick={onRemove}
        ><X aria-hidden="true" className="size-3" /></button>
      </li>
    );
  }
  /* GP-14：栏内资产条目的审核态可区分——待审核/已拒绝带徽标 + 弱呈现，
     悬停预览给状态人话（闸门口径与抽屉/后端 422 同源，asset-review.ts）。 */
  const reviewLabel = item.origin === "asset" ? assetReviewLabelOf({ status: item.assetStatus }) : null;
  const gateReason = reviewLabel ? assetAttachGate({ status: item.assetStatus }).reason : "";
  const titleReasons = [reviewLabel ? gateReason : "", excludedReason ? `不随本次提交：${excludedReason}` : ""].filter(Boolean).join(" · ");
  return (
    <li
      className="relative"
      onMouseEnter={() => schedule(true)}
      onMouseLeave={() => schedule(false)}
    >
      <span
        className={cn("inline-flex max-w-full items-center gap-1.5 rounded-md border border-border-1 bg-surface-2 py-1 pl-1 pr-1.5", reviewLabel || excludedReason ? "opacity-60 saturate-50" : "")}
        title={titleReasons ? `${item.name} · ${titleReasons}` : undefined}
        data-review-status={reviewLabel ?? undefined}
        data-excluded={excludedReason ? "true" : undefined}
      >
        <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-surface-well text-ink-4 [&_svg]:size-4">
          {item.thumbUrl ? <img src={item.thumbUrl} alt={item.name} className="size-full object-cover" loading="lazy" /> : laneIcon(lane)}
        </span>
        <span className="max-w-[160px] truncate text-xs text-ink-1">{item.name}</span>
        <span className={cn(
          "rounded-full px-1.5 py-0.5 text-[10px]",
          item.origin === "asset" ? "bg-surface-1 text-ink-2" : "bg-accent-subtle text-accent-text",
        )}>{item.origin === "asset" ? "资产" : "生成"}</span>
        {reviewLabel ? (
          <span className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px]",
            reviewLabel === "已拒绝" ? "bg-danger/15 text-danger" : "bg-warning/15 text-warning",
          )}>{reviewLabel}</span>
        ) : null}
        {excludedBadge}
        {item.origin === "workshop" ? (
          <button
            type="button"
            className="rounded-full p-0.5 text-ink-4 outline-none transition-colors hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent"
            aria-label={`从${lane.label}摘除 ${item.name}`}
            onClick={onRemove}
          ><X aria-hidden="true" className="size-3" /></button>
        ) : null}
      </span>
      {preview ? (
        <span className="pointer-events-none absolute bottom-full left-0 z-40 mb-1 flex w-56 flex-col gap-1.5 rounded-md border border-border-2 bg-surface-1 p-3 shadow-lg" role="tooltip">
          {item.thumbUrl ? <img src={item.thumbUrl} alt={item.name} className="max-h-36 w-full rounded-sm object-cover" /> : null}
          <strong className="truncate text-xs font-semibold text-ink-1">{item.name}</strong>
          <span className="text-[11px] text-ink-2">{item.origin === "asset" ? "来自项目资产" : "本项目生成"}{item.note ? ` · ${item.note}` : ""}</span>
          {reviewLabel ? <span className="text-[11px] text-ink-2">状态：{gateReason}</span> : null}
          {excludedReason ? <span className="text-[11px] text-ink-2">不随本次提交：{excludedReason}</span> : null}
        </span>
      ) : null}
    </li>
  );
}
