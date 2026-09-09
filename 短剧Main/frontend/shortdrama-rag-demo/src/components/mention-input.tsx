/* ============================================================
   mention-input.tsx — 提示词框 @ 提及 + 已匹配资产 chips（S2b-1/S2b-3）

   - MentionTextarea：输入 @ 弹出已匹配资产，键盘 ↑↓/Enter/Esc 操作，
     选中把 `@资产名` 插到光标处（序列化契约待 Fable，人读层占位=@名称）。
   - AssetChipsRow：已匹配资产按职责分组混排，点击写入 @名；
     hover 160ms 后浮现预览卡（大图/职责/简介）——hover 只做预览。
   ============================================================ */

import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { ASSET_ROLES, assetRoleMeta } from "../control-assets";
import {
  detectMentionQuery,
  filterMentionCandidates,
  insertMention,
  type MentionCandidate,
  type MentionQuery,
} from "../prompt-mentions";
import type { Asset, ProjectAssetRef } from "../types";
import { assetKindLabel, assetName } from "../ui";
import { AssetMiniThumb } from "./asset-pick-drawer";
import { cn } from "./ui/cn";
import { Textarea } from "./ui/primitives";

function refEntity(ref: ProjectAssetRef): Asset {
  return ref.asset ?? ref.snapshot ?? ref.version_snapshot?.entity ?? { id: ref.asset_entity_id || ref.asset_id || ref.id, name: "未命名项目资产", asset_kind: "character" };
}

/** 项目资产引用 → @ 候选（名称 <2 字的过滤掉，防误命中）。 */
export function mentionCandidatesFromRefs(refs: readonly ProjectAssetRef[]): MentionCandidate[] {
  return refs
    .map((ref) => {
      const asset = refEntity(ref);
      const name = assetName(asset);
      const role = assetRoleMeta(asset.role);
      return { key: ref.id, name, subtitle: role?.label ?? (asset.asset_kind ? assetKindLabel(asset.asset_kind) : undefined) };
    })
    .filter((candidate) => candidate.name.trim().length >= 2);
}

export interface MentionTextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> {
  value: string;
  onChange: (value: string) => void;
  candidates: readonly MentionCandidate[];
}

export const MentionTextarea = forwardRef<HTMLTextAreaElement, MentionTextareaProps>(function MentionTextarea({ value, onChange, candidates, onKeyDown, ...rest }, forwardedRef): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [active, setActive] = useState<MentionQuery | null>(null);
  const [highlight, setHighlight] = useState(0);
  const options = useMemo(() => (active ? filterMentionCandidates(candidates, active.query) : []), [active, candidates]);
  const open = Boolean(active && options.length > 0);

  /* 光标移动/点击后刷新查询态（键盘输入走 onChange 路径，已含）。 */
  function refreshQuery(): void {
    const element = textareaRef.current;
    if (!element) return;
    setActive(detectMentionQuery(element.value, element.selectionStart ?? element.value.length));
  }

  function pick(candidate: MentionCandidate): void {
    if (!active) return;
    const result = insertMention(value, active, candidate.name);
    onChange(result.text);
    setActive(null);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(result.caret, result.caret);
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (open) {
      if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((index) => (index + 1) % options.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((index) => (index - 1 + options.length) % options.length); return; }
      if (event.key === "Enter" || event.key === "Tab") {
        const candidate = options[Math.min(highlight, options.length - 1)];
        if (candidate) { event.preventDefault(); pick(candidate); return; }
      }
      if (event.key === "Escape") { event.preventDefault(); setActive(null); return; }
    }
    onKeyDown?.(event);
  }

  useEffect(() => setHighlight(0), [active?.query]);

  return (
    <div className="relative">
      <Textarea
        ref={(element) => {
          textareaRef.current = element;
          if (typeof forwardedRef === "function") forwardedRef(element);
          else if (forwardedRef) forwardedRef.current = element;
        }}
        value={value}
        onKeyDown={handleKeyDown}
        onSelect={refreshQuery}
        onClick={refreshQuery}
        onChange={(event) => {
          onChange(event.target.value);
          setActive(detectMentionQuery(event.target.value, event.target.selectionStart ?? event.target.value.length));
        }}
        {...rest}
      />
      {open ? (
        <ul
          className="absolute bottom-full left-0 z-40 mb-1 max-h-56 w-full min-w-0 overflow-y-auto rounded-md border border-border-2 bg-surface-1 py-1 shadow-lg"
          role="listbox"
          aria-label="已匹配资产提及"
        >
          {options.map((candidate, index) => (
            <li key={candidate.key} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm outline-none",
                  index === highlight ? "bg-surface-2 text-ink-1" : "text-ink-1 hover:bg-surface-2",
                )}
                onMouseDown={(event) => { event.preventDefault(); pick(candidate); }}
                onMouseEnter={() => setHighlight(index)}
              >
                <span className="min-w-0 truncate">{candidate.name}</span>
                {candidate.subtitle ? <span className="shrink-0 text-xs text-ink-2">{candidate.subtitle}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});

/* ---------- 已匹配资产 chips：点击写入 @，hover 浮现预览 ---------- */

interface ChipGroup {
  key: string;
  label: string;
  refs: ProjectAssetRef[];
}

function groupRefs(refs: readonly ProjectAssetRef[]): ChipGroup[] {
  const groups = new Map<string, ChipGroup>();
  const unroled: ChipGroup = { key: "unroled", label: "其他资产", refs: [] };
  for (const role of ASSET_ROLES) groups.set(role.value, { key: role.value, label: role.label, refs: [] });
  for (const ref of refs) {
    const role = refEntity(ref).role ?? "";
    const group = groups.get(role);
    if (group) group.refs.push(ref);
    else unroled.refs.push(ref);
  }
  return [...groups.values(), unroled].filter((group) => group.refs.length > 0);
}

export function AssetChipsRow({ refs, onPick }: {
  refs: readonly ProjectAssetRef[];
  /** 点击 chip：把 `@资产名` 写入提示词框光标处。 */
  onPick: (name: string) => void;
}): React.JSX.Element | null {
  const groups = useMemo(() => groupRefs(refs), [refs]);
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" aria-label="已匹配资产快捷写入">
      {groups.map((group) => (
        <span key={group.key} className="inline-flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-ink-4">{group.label}</span>
          {group.refs.map((ref) => (
            <AssetChip key={ref.id} reference={ref} onPick={onPick} />
          ))}
        </span>
      ))}
    </div>
  );
}

function AssetChip({ reference, onPick }: { reference: ProjectAssetRef; onPick: (name: string) => void }): React.JSX.Element {
  const asset = refEntity(reference);
  const name = assetName(asset);
  const [preview, setPreview] = useState(false);
  const timer = useRef(0);
  const role = assetRoleMeta(asset.role);

  function schedulePreview(show: boolean): void {
    window.clearTimeout(timer.current);
    if (show) timer.current = window.setTimeout(() => setPreview(true), 160);
    else setPreview(false);
  }
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => schedulePreview(true)}
      onMouseLeave={() => schedulePreview(false)}
      onFocus={() => schedulePreview(true)}
      onBlur={() => schedulePreview(false)}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-full border border-border-1 bg-surface-2 py-0.5 pl-1 pr-2.5 text-xs text-ink-1 outline-none transition-colors duration-150 hover:border-accent hover:text-accent-text focus-visible:ring-2 focus-visible:ring-accent"
        title={`把 @${name} 写入提示词`}
        onClick={() => onPick(name)}
      ><AssetMiniThumb asset={asset} size="sm" />@{name}</button>
      {preview ? (
        <span className="pointer-events-none absolute bottom-full left-0 z-40 mb-1 flex w-56 flex-col gap-1.5 rounded-md border border-border-2 bg-surface-1 p-3 shadow-lg" role="tooltip">
          <span className="flex items-center gap-2">
            <AssetMiniThumb asset={asset} />
            <span className="flex min-w-0 flex-col">
              <strong className="truncate text-xs font-semibold text-ink-1">{name}</strong>
              <span className="text-[11px] text-ink-2">{role?.label ?? assetKindLabel(asset.asset_kind)}</span>
            </span>
          </span>
          {asset.intro ? <span className="line-clamp-2 text-[11px] leading-4 text-ink-2">{asset.intro}</span> : null}
          {asset.style_tags && asset.style_tags.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {asset.style_tags.slice(0, 4).map((tag) => (
                <span key={tag} className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-2">{tag}</span>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
