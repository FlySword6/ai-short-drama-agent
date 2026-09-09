/* ============================================================
   multi-user-picker.tsx — 多选成员 tag 输入框（Element 多选下拉形态）

   用途:Lite 项目弹窗的成员管理。已选成员以紧凑 chip(显示名 + ×)
   排在输入框区域内,打字触发下拉搜索(portal),点下拉项加 chip、
   点 chip × 删人。区域内部 chip 多了限高滚动,不再撑高弹窗。

   机制复刻自 user-search-input.tsx 的成熟模式(防抖搜索、portal 定位、
   pointerEvents:auto 破 modal body none、排除名单走 ref 防闭包旧值、
   点选后保持展开刷新候选)——那套是单值输入框,本组件是多选 tag 容器,
   各自独立演进。user-search-input 的 5 个单选/多选调用方不受影响。

   PRD lite.md §三 2026-08-10 拍板的「搜索框交互」(聚焦展示全量、
   模糊过滤、点选即加、无添加按钮)全部保留;本组件只改已选成员的
   呈现形态(独立列表 → chip),不触及搜索/加入行为口径。
   ============================================================ */
import * as React from "react";
import { createPortal } from "react-dom";
import { Branch as DismissableLayerBranch } from "@radix-ui/react-dismissable-layer";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { ApiClientError, api } from "../api";
import { DEMO_DIRECTORY, type ProjectMember, type UserDirectoryRecord } from "../operations";
import { directoryMatches } from "./user-search-input";
import { cn } from "./ui/cn";
import { inputClasses } from "./ui/primitives";

export function MultiUserPicker({
  members,
  excludeUserIds,
  onAdd,
  onRemove,
  demoMode,
  disabled,
  placeholder,
  ariaLabel,
}: {
  /** 已选成员(chip 来源),只读;父层已过滤掉 owner,这里只渲染「其他人」。 */
  members: readonly ProjectMember[];
  /** 下拉不出现这些用户(父层算好:当前登录用户 + 已在成员表里的所有人,含 owner)。 */
  excludeUserIds: readonly string[];
  /** 点下拉项时触发(父层 addMemberForUser 去重/自检/落账)。 */
  onAdd: (user: UserDirectoryRecord) => void;
  /** 点 chip × 时触发(父层 removeMember)。 */
  onRemove: (member: ProjectMember) => void;
  demoMode: boolean;
  disabled: boolean;
  placeholder?: string;
  ariaLabel?: string;
}): React.JSX.Element {
  const [results, setResults] = useState<UserDirectoryRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  /* 输入文本是组件内部 state——父层不再持有,避免 newMemberName 级联。 */
  const [query, setQuery] = useState("");
  const timer = useRef(0);
  const seq = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  /* 排除名单走 ref:pick 后立即刷新候选时父层 setState 尚未落,闭包里的旧 props 会把
     刚加的人又列回来;渲染期同步 ref,宏任务回调里读到的就是最新名单。 */
  const excludeRef = useRef<readonly string[]>(excludeUserIds);
  excludeRef.current = excludeUserIds;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  /* 下拉用 portal 渲染到 body(fixed 定位),逃逸弹窗 DialogBody overflow-y-auto 的裁剪。
     跟随外框容器位置:监听 resize / 捕获 scroll,open 期间持续校正坐标。
     依赖含 members.length——连续加人时 chip 区换行变高,菜单要随锚点重算,否则瞬间错位。 */
  useLayoutEffect(() => {
    if (!open) return;
    const el = wrapRef.current;
    if (!el) return;
    const place = (): void => {
      const rect = el.getBoundingClientRect();
      /* pointerEvents:"auto" 必带:Radix modal Dialog 会把 body 设成 pointer-events:none,
         portal 到 body 下的菜单继承 none → 鼠标事件穿透、pick 永不触发(点选无回显的根因)。 */
      setMenuStyle({ position: "fixed", top: rect.bottom + 4, left: rect.left, width: rect.width, zIndex: 80, pointerEvents: "auto" });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, members.length]);

  function runSearch(text: string): void {
    window.clearTimeout(timer.current);
    const q = text.trim();
    timer.current = window.setTimeout(() => {
      const id = ++seq.current;
      const run = demoMode
        ? Promise.resolve(q ? directoryMatches(DEMO_DIRECTORY, q) : DEMO_DIRECTORY)
        : api.searchUserDirectory(q);
      void run.then((items) => {
        if (id !== seq.current) return;
        const excluded = excludeRef.current;
        const filtered = excluded.length ? items.filter((u) => !excluded.includes(u.id)) : items;
        setResults(filtered);
        setOpen(filtered.length > 0);
        setNote("");
      }).catch((reason: unknown) => {
        if (id !== seq.current) return;
        setResults([]);
        setOpen(false);
        setNote(reason instanceof ApiClientError ? reason.message : "用户搜索暂不可用，请稍后再试");
      });
    }, q ? 250 : 0);
  }

  function handleChange(text: string): void {
    setQuery(text);
    runSearch(text);
  }

  function pick(user: UserDirectoryRecord): void {
    onAdd(user);
    setQuery("");
    setNote("");
    /* 多选场景:点选后清空输入并保持下拉展开刷新候选——连续加人不断流。 */
    runSearch("");
  }

  return (
    <div className="relative" ref={wrapRef}>
      {/* 外框容器:复用 inputClasses 的边框/配色;twMerge 用后面的 min-h-9/h-auto 顶掉 h-9,
          改成可随 chip 换行增高、并限高滚动。focus-within 让内部 input 获焦时整个外框高亮。 */}
      <div
        className={cn(
          inputClasses,
          "min-h-9 h-auto max-h-40 overflow-y-auto",
          "flex flex-wrap items-center gap-1 px-1.5 py-1",
          "focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/40",
          disabled && "opacity-60",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {members.map((member) => (
          <span key={member.userId} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-2">
            {member.displayName}
            <button
              type="button"
              aria-label={`移除 ${member.displayName}`}
              disabled={disabled}
              onClick={(event) => { event.stopPropagation(); onRemove(member); }}
              className="text-ink-4 transition-colors hover:text-danger [&_svg]:size-3"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </span>
        ))}
        {/* 无边框透明输入框:占剩余宽度,最小宽度保证可点。空成员时显示 placeholder。 */}
        <input
          ref={inputRef}
          value={query}
          disabled={disabled}
          placeholder={members.length === 0 ? (placeholder ?? "搜用户名或显示名") : ""}
          aria-label={ariaLabel ?? placeholder ?? "搜用户名或显示名"}
          autoComplete="off"
          onChange={(event) => handleChange(event.target.value)}
          onFocus={() => {
            /* 聚焦即展示全部可加用户(空查询拉全量目录);已有结果则直接展开。 */
            if (!query.trim()) {
              handleChange("");
            } else if (results.length > 0) {
              setOpen(true);
            }
          }}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          className="min-w-[8rem] flex-1 border-0 bg-transparent px-1 py-0.5 text-sm text-ink-1 outline-none placeholder:text-ink-4 focus:outline-none focus:ring-0"
        />
      </div>
      {open ? createPortal(
        <DismissableLayerBranch asChild>
          <ul style={menuStyle} data-user-search-menu className="max-h-48 overflow-auto rounded-md border border-border-1 bg-surface-1 py-1 shadow-lg" role="listbox">
            {results.map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink-1 hover:bg-surface-2"
                  onMouseDown={(event) => { event.preventDefault(); pick(user); }}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-medium text-ink-2">{user.displayName.slice(0, 1)}</span>
                  <span className="font-medium">{user.displayName}</span>
                  <span className="text-xs text-ink-3">@{user.username}</span>
                </button>
              </li>
            ))}
          </ul>
        </DismissableLayerBranch>,
        document.body,
      ) : null}
      {note ? <p className="mt-1 text-xs text-warning" role="status">{note}</p> : null}
    </div>
  );
}
