/* ============================================================
   command-palette.tsx — ⌘K 命令面板(S30)

   职责边界:
   - 指令内容、面板文案全部来自 props(服务端 config_entries 或 demo
     fixture 经 app.tsx 归一后传入);本组件不写死任何指令与搜索结果;
   - 行模型、过滤、选中态机走 command-palette.ts 纯函数;指令行为走
     command-registry.ts;组件只做渲染、键盘与搜索调度;
   - 键盘是主交互:↑↓ 移动、Enter 执行、Esc 关闭;焦点出/回都归位
     (onOpenAutoFocus 抢给输入框,onCloseAutoFocus 还给触发者)。
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilmSlate, FolderPlus, GearSix, MagnifyingGlass, RocketLaunch, ShieldStar } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { inputClasses } from "./ui/primitives";
import { cn } from "./ui/cn";
import { canSeeAdminConsole } from "../operations";
import { capabilityGate } from "../capabilities-state";
import {
  COMMAND_PALETTE_GROUPS_FAILED_BANNER,
  DEFAULT_COMMAND_PALETTE_COPY,
  commandRows,
  filterPaletteGroups,
  moveActiveRow,
  searchResultRows,
  type CommandPaletteCopy,
  type CommandPaletteGroup,
  type CommandPaletteRow,
  type CommandPaletteSearchResults,
} from "../command-palette";
import { commandRegistered, runPaletteCommand, type CommandExecutionContext } from "../command-registry";

/* ---------- 指令 id → 图标(024 先例:iconKey 不入库,映射留前端) ---------- */

const COMMAND_ICONS: Record<string, React.JSX.Element> = {
  "action.create_project": <FolderPlus />,
  "action.create_shot": <FilmSlate />,
  "nav.settings": <GearSix />,
  "nav.releases": <RocketLaunch />,
  "nav.admin": <ShieldStar />,
};

const SEARCH_DEBOUNCE_MS = 150;

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 归一后的指令分组;groupsFailed 时忽略本字段。 */
  groups: CommandPaletteGroup[];
  /** 指令分组接口读失败:指令区空,展示横幅+重试(不写死指令兜底)。 */
  groupsFailed: boolean;
  onRetryGroups: () => void;
  /** 面板文案;调用方读不到时传 null,组件落 DEFAULT 兜底。 */
  copy: CommandPaletteCopy | null;
  /** 执行上下文:当前项目、能力、导航(指令落点在 registry)。 */
  ctx: CommandExecutionContext;
  /** 搜索来源:真栈=api.commandPaletteSearch;demo=fixture 过滤。 */
  search: (query: string) => Promise<CommandPaletteSearchResults>;
  /** 未注册指令等需要给人话时的提示出口(app.tsx 的 toast)。 */
  notify: (message: string, kind?: "info" | "success" | "error") => void;
}

export function CommandPalette({ open, onOpenChange, groups, groupsFailed, onRetryGroups, copy, ctx, search, notify }: CommandPaletteProps): React.JSX.Element {
  const resolvedCopy = copy ?? DEFAULT_COMMAND_PALETTE_COPY;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CommandPaletteSearchResults | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<Element | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<number | null>(null);
  const searchSeq = useRef(0);

  /* 打开时重置一轮状态,并记住触发者(关闭时把焦点还回去)。 */
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement;
    setQuery("");
    setResults(null);
    setSearchFailed(false);
    setActiveIndex(-1);
  }, [open]);

  /* 卸载清 debounce,避免面板关了还把旧结果盖回来。 */
  useEffect(() => () => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
  }, []);

  const trimmedQuery = query.trim();

  /* 指令行:纯函数过滤(上下文+权限+关键词),未注册 id 不上架。 */
  const visibleCommandRows = useMemo(() => {
    if (groupsFailed) return [];
    const filtered = filterPaletteGroups(groups, trimmedQuery, {
      inProject: Boolean(ctx.projectId),
      canAdmin: capabilityGate(ctx.capabilities, canSeeAdminConsole) === "allowed",
    });
    return commandRows(filtered).filter((row) => row.kind === "command" && commandRegistered(row.item.command));
  }, [groups, groupsFailed, trimmedQuery, ctx.projectId, ctx.capabilities]);

  const hitRows = useMemo(() => (trimmedQuery && results ? searchResultRows(results) : []), [trimmedQuery, results]);
  const rows = useMemo(() => [...hitRows, ...visibleCommandRows], [hitRows, visibleCommandRows]);

  /* 行集变化时把选中钉回首行(无行则 -1)。 */
  useEffect(() => {
    setActiveIndex((current) => {
      if (rows.length === 0) return -1;
      if (current < 0) return 0;
      return Math.min(current, rows.length - 1);
    });
  }, [rows]);

  /* 选中行滚进可视区。 */
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const activeEl = listRef.current.querySelector<HTMLElement>(`[data-row-index="${activeIndex}"]`);
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const runSearch = useCallback((nextQuery: string) => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    const needle = nextQuery.trim();
    if (!needle) {
      setResults(null);
      setSearchFailed(false);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      const seq = ++searchSeq.current;
      search(needle)
        .then((nextResults) => {
          if (searchSeq.current !== seq) return;
          setResults(nextResults);
          setSearchFailed(false);
        })
        .catch(() => {
          if (searchSeq.current !== seq) return;
          setResults(null);
          setSearchFailed(true);
        });
    }, SEARCH_DEBOUNCE_MS);
  }, [search]);

  const executeRow = useCallback((row: CommandPaletteRow) => {
    if (row.kind === "hit") {
      onOpenChange(false);
      ctx.navigate(row.path);
      return;
    }
    const executed = runPaletteCommand(row.item.command, ctx);
    if (!executed) {
      notify("这条指令还没接上,先手动走页面入口。", "info");
      return;
    }
    onOpenChange(false);
  }, [ctx, onOpenChange, notify]);

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => moveActiveRow(current, 1, rows.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => moveActiveRow(current, -1, rows.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = activeIndex >= 0 ? rows[activeIndex] : rows[0];
      if (row) executeRow(row);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
    }
  };

  let rowCursor = -1;
  const renderRow = (row: CommandPaletteRow) => {
    rowCursor += 1;
    const index = rowCursor;
    const active = index === activeIndex;
    return (
      <div
        key={row.id}
        id={`command-palette-row-${index}`}
        data-row-index={index}
        role="option"
        aria-selected={active}
        className={cn(
          "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left",
          active ? "bg-accent-subtle text-accent-text" : "text-ink-1",
        )}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => executeRow(row)}
      >
        <span className={cn("inline-flex size-5 shrink-0 items-center justify-center [&_svg]:size-4", active ? "text-accent-text" : "text-ink-3")} aria-hidden="true">
          {row.kind === "command" ? (COMMAND_ICONS[row.item.command] ?? <MagnifyingGlass />) : <MagnifyingGlass />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{row.kind === "command" ? row.item.label : row.label}</span>
          {row.kind === "command" && row.item.hint ? <span className="block truncate text-xs text-ink-3">{row.item.hint}</span> : null}
          {row.kind === "hit" && row.detail ? <span className="block truncate text-xs text-ink-3">{row.detail}</span> : null}
        </span>
        {row.kind === "command" ? <kbd className="shrink-0 rounded border border-border-1 bg-surface-0 px-1.5 py-0.5 text-[10px] text-ink-3 [font-family:var(--font-mono)]">指令</kbd> : null}
      </div>
    );
  };

  /* 分组渲染:有查询=搜索结果组在前(组名来自 copy),指令组在后;无查询只指令组。 */
  const sections: Array<{ key: string; title: string; rows: CommandPaletteRow[] }> = [];
  if (trimmedQuery) {
    for (const groupKey of ["projects", "episodes", "scenes", "shots", "assets"] as const) {
      const groupRows = hitRows.filter((row) => row.kind === "hit" && row.group === groupKey);
      if (groupRows.length) sections.push({ key: `search-${groupKey}`, title: resolvedCopy.searchGroupLabels[groupKey], rows: groupRows });
    }
  }
  if (visibleCommandRows.length) {
    const commandGroups = new Map<string, CommandPaletteRow[]>();
    for (const row of visibleCommandRows) {
      if (row.kind !== "command") continue;
      const list = commandGroups.get(row.groupTitle) ?? [];
      list.push(row);
      commandGroups.set(row.groupTitle, list);
    }
    for (const [title, groupRows] of commandGroups) {
      sections.push({ key: `commands-${title}`, title, rows: groupRows });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="large"
        hideClose
        className="top-[18%] translate-y-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = restoreFocusRef.current;
          if (target instanceof HTMLElement) target.focus();
        }}
      >
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <div className="border-b border-border-1 px-4 py-3">
          <div className="relative">
            <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              className={cn(inputClasses, "pl-9")}
              placeholder={resolvedCopy.placeholder}
              value={query}
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls="command-palette-list"
              aria-activedescendant={activeIndex >= 0 ? `command-palette-row-${activeIndex}` : undefined}
              aria-label="命令面板搜索"
              onChange={(event) => {
                setQuery(event.target.value);
                runSearch(event.target.value);
              }}
              onKeyDown={onInputKeyDown}
            />
          </div>
        </div>
        <div ref={listRef} id="command-palette-list" role="listbox" aria-label="指令与搜索结果" className="max-h-[50dvh] min-h-24 overflow-y-auto px-2 py-2">
          {groupsFailed ? (
            <div className="flex items-center gap-3 px-3 py-3" role="alert">
              <span className="flex-1 text-sm text-ink-2">{COMMAND_PALETTE_GROUPS_FAILED_BANNER}</span>
              <button type="button" className="rounded-md border border-border-1 px-3 py-1.5 text-xs font-medium text-ink-1 transition-colors hover:bg-surface-2" onClick={onRetryGroups}>重试读取</button>
            </div>
          ) : null}
          {searchFailed ? (
            <div className="px-3 py-2 text-sm text-ink-2" role="alert">{resolvedCopy.loadFailed}</div>
          ) : null}
          {sections.map((section) => (
            <div key={section.key} className="px-1 pb-1 pt-2 first:pt-0">
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-4">{section.title}</div>
              {section.rows.map((row) => renderRow(row))}
            </div>
          ))}
          {!groupsFailed && trimmedQuery && !searchFailed && rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-ink-2">{resolvedCopy.emptyResults}</div>
          ) : null}
          {!groupsFailed && !trimmedQuery && rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-ink-2">{resolvedCopy.emptyResults}</div>
          ) : null}
        </div>
        <div className="border-t border-border-1 px-4 py-2 text-[11px] text-ink-4">↑↓ 移动 · Enter 执行 · Esc 关闭</div>
      </DialogContent>
    </Dialog>
  );
}
