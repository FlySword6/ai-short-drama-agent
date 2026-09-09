/* ============================================================
   lite-shot-reference-pack.tsx — Lite 分镜卡「这一镜带的参考」控制包
   （P-18a 段② 收纳行 + P-18b 上半展开面板 + 加参考弹层）。

   口径（原型说明 lite-shots-proto-note §二/§九 + #186）：
   - 参考一律以「参考」身份注入；顺序 = 出片时提示词点名顺序，面板内可拖动换位。
   - 上限不写死：能力矩阵读不到各类配额（model_capabilities 无参考配额字段），
     按 §9.2.3 降级——只报已带数量、不报分母，「＋ 加参考」保持可用，
     超限交给后端拒绝并原样展示人话（宁让后端拦，不用过期数字提前拦）。
   - 增删都在原地：缩略图 hover/focus 浮出 × 就地去掉；「＋ 项目资产」开弹层挑。
     「＋ 资产库 / ＋ 上传」两条来源精简版今天没有取数端点，不出假控件（回执单列）。
   - 参考资产 wire（lite/reference-assets）未带 media_kind，既有登记产物实为图片，
     归「图」泳道；视频/音频泳道给如实空态。
   ============================================================ */
import { CaretDown, CaretUp, Plus, X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import { assetKindLabel } from "../../asset-kind-labels";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

/** 一条参考素材（asset_media 行 id 是提交 references 认的 media_id）。 */
export interface LiteReferencePickItem {
  assetMediaId: string;
  name: string;
  /** asset_entities.asset_kind 原值（character/scene/prop…），展示用分类标签。 */
  kind: string;
  storageUrl: string | null;
}

/** 归入「角色」筛选档的资产分类（动物按角色处理）。筛选与标签共用这一处,别再各写一遍。 */
const CHARACTER_KINDS: ReadonlySet<string> = new Set(["character", "animal"]);

/** 顺序调整：把 from 位的条目挪到 to 位（拖动换位的纯函数本体，组件测直接打）。 */
export function moveReferencePick<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

/** 缩略图：有序号角标 + hover/focus 浮出 × 就地去掉。 */
function PickThumb({ item, index, size, onRemove }: {
  item: LiteReferencePickItem;
  index: number;
  /** 收纳态 30×30（size-7.5 无档，用 size-8），面板 64×64（size-16）。 */
  size: "sm" | "lg";
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "group relative inline-block shrink-0 overflow-hidden rounded-lg border border-border-1 bg-surface-2",
        size === "sm" ? "size-8" : "size-16",
      )}
    >
      {item.storageUrl ? (
        <img src={item.storageUrl} alt={item.name} loading="lazy" className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center text-xs text-ink-4">{item.name.slice(0, 1)}</span>
      )}
      <span className="absolute left-0.5 top-0.5 rounded-sm bg-black/55 px-2 font-mono text-[10px] leading-4 text-ink-1">{index + 1}</span>
      <button
        type="button"
        aria-label={`去掉参考 ${item.name}`}
        title="去掉这条参考"
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-black/65 text-ink-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </span>
  );
}

/** 加参考弹层：列本项目登记在册的素材，点选（可多选）后确认一次加入。
    P-17c 选参考图弹层的精简版落法：分类筛选 + 序号角标 + 底部确认条。 */
function ReferencePickerDialog({ open, onClose, candidates, pickedIds, onConfirm }: {
  open: boolean;
  onClose: () => void;
  candidates: readonly LiteReferencePickItem[];
  pickedIds: ReadonlySet<string>;
  onConfirm: (items: LiteReferencePickItem[]) => void;
}): React.JSX.Element {
  const KIND_FILTERS: ReadonlyArray<{ key: string; label: string }> = [
    { key: "all", label: "全部" },
    { key: "character", label: "角色" },
    { key: "scene", label: "场景" },
    { key: "prop", label: "道具" },
  ];
  const [kindFilter, setKindFilter] = useState("all");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const available = useMemo(
    () => candidates.filter((item) => !pickedIds.has(item.assetMediaId) && (kindFilter === "all" || item.kind === kindFilter || (kindFilter === "character" && CHARACTER_KINDS.has(item.kind)))),
    [candidates, pickedIds, kindFilter],
  );
  const toggle = (assetMediaId: string): void => {
    setSelected((previous) => (previous.includes(assetMediaId) ? previous.filter((id) => id !== assetMediaId) : [...previous, assetMediaId]));
  };
  const close = (): void => {
    setSelected([]);
    setKindFilter("all");
    onClose();
  };
  const confirm = (): void => {
    const chosen = available.filter((item) => selected.includes(item.assetMediaId));
    onConfirm(chosen);
    close();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent size="large">
        <DialogHeader>
          <DialogTitle>加参考素材</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="按分类筛选">
            {KIND_FILTERS.map((filter) => (
              <button
                key={filter.key}
                type="button"
                aria-pressed={kindFilter === filter.key}
                className={cn(
                  "rounded-full border px-3 py-2 text-xs transition-colors",
                  kindFilter === filter.key ? "border-accent bg-accent/10 text-accent-text" : "border-border-1 text-ink-2 hover:border-border-2",
                )}
                onClick={() => setKindFilter(filter.key)}
              >{filter.label}</button>
            ))}
          </div>
          {available.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-3">本项目里没有更多登记在册的素材了；先在素材页把候选图「登记素材」入库，这里就能挑。</p>
          ) : (
            <div className="grid max-h-80 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
              {available.map((item) => {
                const order = selected.indexOf(item.assetMediaId);
                return (
                  <button
                    key={item.assetMediaId}
                    type="button"
                    aria-pressed={order >= 0}
                    aria-label={`挑参考 ${item.name}${order >= 0 ? `（第 ${order + 1} 个）` : ""}`}
                    className={cn(
                      "group relative overflow-hidden rounded-md border text-left transition-colors",
                      order >= 0 ? "border-accent ring-2 ring-accent/40" : "border-border-1 hover:border-border-2",
                    )}
                    onClick={() => toggle(item.assetMediaId)}
                  >
                    {item.storageUrl ? (
                      <img src={item.storageUrl} alt="" loading="lazy" className="aspect-square w-full bg-surface-2 object-cover" />
                    ) : (
                      <span className="flex aspect-square w-full items-center justify-center bg-surface-2 text-lg text-ink-4">{item.name.slice(0, 1)}</span>
                    )}
                    {order >= 0 ? <span className="absolute left-1 top-1 rounded-sm bg-accent px-2 font-mono text-[10px] leading-4 text-accent-ink">{order + 1}</span> : null}
                    <span className="block truncate px-1.5 py-2 text-xs text-ink-2">{item.name}</span>
                    <span className="block px-1.5 pb-2 text-[11px] text-ink-4">{assetKindLabel(item.kind)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <DialogFooter>
          <span className="mr-auto text-xs text-ink-3" role="status">{selected.length > 0 ? `这次带 ${selected.length} 张参考` : "点素材即挑中，可一次挑多张"}</span>
          <Button variant="ghost" onClick={close}>取消</Button>
          <Button variant="primary" disabled={selected.length === 0} onClick={confirm}>加进这一镜</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LiteReferencePack({ shotNo, picks, candidates, disabled, onChange }: {
  shotNo: string;
  picks: readonly LiteReferencePickItem[];
  candidates: readonly LiteReferencePickItem[];
  /** demo 离线演示/提交在飞时禁增删（展示不收起）。 */
  disabled: boolean;
  onChange: (next: LiteReferencePickItem[]) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  /* 泳道计数：wire 暂无 media_kind，登记产物一律归图泳道（视频/音频待 #206 补字段）。 */
  const counts = { image: picks.length, video: 0, audio: 0 };
  const countLabel = `${counts.image} 图 · ${counts.video} 视频 · ${counts.audio} 音频`;
  const addItems = (items: LiteReferencePickItem[]): void => onChange([...picks, ...items]);
  const removeAt = (index: number): void => onChange(picks.filter((_, itemIndex) => itemIndex !== index));

  const picker = (
    <ReferencePickerDialog
      open={pickerOpen}
      onClose={() => setPickerOpen(false)}
      candidates={candidates}
      pickedIds={new Set(picks.map((item) => item.assetMediaId))}
      onConfirm={addItems}
    />
  );

  /* 空态：收纳行整行换教学位（原型 §二状态表）。 */
  if (picks.length === 0 && !expanded) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border-1 bg-surface-1 px-4 py-3" aria-label={`第 ${shotNo} 镜参考素材`}>
        <p className="min-w-0 flex-1 text-sm text-ink-2">
          <strong className="font-medium">这一镜还没带参考。</strong>
          <span className="text-ink-3">带上角色定妆照和场景图，出片时人物才对得上。</span>
        </p>
        <Button size="sm" variant="primary" icon={<Plus />} disabled={disabled} onClick={() => setPickerOpen(true)}>带参考</Button>
        {picker}
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-border-1 bg-surface-1" aria-label={`第 ${shotNo} 镜参考素材`}>
      {/* 收纳态一行（52px）：缩略图列 + 加参考 + 计数 + 展开 */}
      <div className="flex min-h-13 flex-wrap items-center gap-3 px-4 py-2.5">
        <span className="shrink-0 text-[13px] text-ink-2">这一镜带的参考</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {picks.slice(0, 4).map((item, index) => (
            <PickThumb key={item.assetMediaId} item={item} index={index} size="sm" onRemove={() => removeAt(index)} />
          ))}
          {picks.length > 4 ? <span className="font-mono text-xs text-ink-3">+{picks.length - 4}</span> : null}
        </span>
        <Button size="sm" variant="outline" icon={<Plus />} disabled={disabled} onClick={() => setPickerOpen(true)}>加参考</Button>
        <span className="font-mono text-xs text-ink-3" aria-label="已带参考计数">{countLabel}</span>
        <Button size="sm" variant="ghost" icon={expanded ? <CaretUp /> : <CaretDown />} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : "展开"}
        </Button>
      </div>

      {expanded ? (
        <div className="border-t border-border-1 px-4 py-3">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h4 className="text-sm font-medium text-ink-1">这一镜带的参考</h4>
            <p className="min-w-0 flex-1 text-xs text-ink-3">出片时这些素材会一起进画面，模型按顺序在提示词里点名。</p>
            <span className="font-mono text-xs text-ink-3">{countLabel}</span>
            <span className="font-mono text-[10px] text-ink-4">上限随出片模型档位</span>
          </div>
          <div className="flex flex-col gap-3">
            {/* 图泳道 */}
            <div className="flex gap-3">
              <div className="w-24 shrink-0">
                <p className="text-[13px] text-ink-2">图</p>
                <p className="mt-0.5 text-[11px] text-ink-4">角色定妆照、场景图、道具图</p>
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2">
                {picks.map((item, index) => (
                  <span
                    key={item.assetMediaId}
                    draggable
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null) onChange(moveReferencePick(picks, dragIndex, index));
                      setDragIndex(null);
                    }}
                    onDragEnd={() => setDragIndex(null)}
                    className={cn("flex w-16 cursor-grab flex-col gap-1", dragIndex === index && "opacity-50")}
                    title="拖动可以换顺序"
                  >
                    <PickThumb item={item} index={index} size="lg" onRemove={() => removeAt(index)} />
                    <span className="truncate text-[11px] text-ink-2">{item.name}</span>
                    <span className="truncate text-[10px] text-ink-4">{assetKindLabel(item.kind)}</span>
                  </span>
                ))}
                <Button size="sm" variant="outline" icon={<Plus />} disabled={disabled} onClick={() => setPickerOpen(true)}>项目资产</Button>
              </div>
            </div>
            {/* 视频/音频泳道：当前 wire 只有图片登记产物，如实空态（不出假控件）。 */}
            <div className="flex gap-3">
              <div className="w-24 shrink-0">
                <p className="text-[13px] text-ink-2">视频</p>
                <p className="mt-0.5 text-[11px] text-ink-4">运镜或动作参考</p>
              </div>
              <p className="text-xs text-ink-4">还没可挑的视频参考。</p>
            </div>
            <div className="flex gap-3">
              <div className="w-24 shrink-0">
                <p className="text-[13px] text-ink-2">音频</p>
                <p className="mt-0.5 text-[11px] text-ink-4">配乐或语气参考</p>
              </div>
              <p className="text-xs text-ink-4">还没可挑的音频参考。</p>
            </div>
          </div>
          <p className="mt-3 border-t border-border-1 pt-2 text-[11px] leading-5 text-ink-4">
            顺序就是出片时点名的顺序，拖动可以换。视频和音频只在出片时带上，出图只带图——不会偷偷丢掉，也不会偷偷带上。
            <br />
            上限不写死在界面里，一律读模型能力矩阵；带满被拦时按当时档位的真实数字说话。
          </p>
        </div>
      ) : null}
      {picker}
    </section>
  );
}
