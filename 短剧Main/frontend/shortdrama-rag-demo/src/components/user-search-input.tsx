/* ============================================================
   user-search-input.tsx — 用户目录搜索选人输入框（S17-A1）

   断头路回收：旧链路用 admin 目录（普通 owner 403 →「缺口已报 Sol」）；
   新链路 GET /users/directory?q=（任何登录用户可用）——输入即搜、
   下拉建议、点选填入用户名。父层把结果并进本地缓存，提交时按用户名/
   显示名精确解析（resolveUser 口径不变）；搜索失败给用户语言提示。
   显式 React import:门禁(node:test + tsx,classic JSX)渲染断言与 Vite react-jsx 双兼容。
   ============================================================ */
import * as React from "react";
import { createPortal } from "react-dom";
import { Branch as DismissableLayerBranch } from "@radix-ui/react-dismissable-layer";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiClientError, api } from "../api";
import { DEMO_DIRECTORY, type UserDirectoryRecord } from "../operations";
import { Input } from "./ui/primitives";

/** 目录本地过滤（demo/测试用；与服务端 searchActiveUsers 同口径：用户名/显示名包含匹配）。 */
export function directoryMatches(users: readonly UserDirectoryRecord[], query: string): UserDirectoryRecord[] {
  const key = query.trim().toLowerCase();
  if (!key) return [];
  return users.filter((user) => user.username.toLowerCase().includes(key) || user.displayName.toLowerCase().includes(key));
}

/** 按用户名/显示名精确解析（提交口径：点选或手打全名都能解析）。 */
export function resolveDirectoryUser(users: readonly UserDirectoryRecord[], nameOrDisplay: string): UserDirectoryRecord | null {
  const key = nameOrDisplay.trim().toLowerCase();
  if (!key) return null;
  return users.find((user) => user.username.toLowerCase() === key || user.displayName.toLowerCase() === key) ?? null;
}

/** 成员 chip 上屏口径（GP-10）：一律显示名（陈默），用户名只作唯一标识落账。
    入参是已规范化的 username；目录里查不到（目录未并进/被停用）时如实回落原串。 */
export function viewerChipLabel(users: readonly UserDirectoryRecord[], username: string): string {
  const key = username.trim().toLowerCase();
  if (!key) return username;
  return users.find((user) => user.username.toLowerCase() === key)?.displayName ?? username;
}

export function UserSearchInput({ value, onChange, onResolve, onPick, placeholder, ariaLabel, disabled, demoMode, onKeyDown, excludeUserIds }: {
  value: string;
  onChange: (text: string) => void;
  /** 每次搜索返回的结果集（父层并进缓存）；点选的单条也会经这里回传。 */
  onResolve: (users: UserDirectoryRecord[]) => void;
  /** 点选某个用户时触发（父层即时加入成员，无需单独提交按钮）。 */
  onPick?: (user: UserDirectoryRecord) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  demoMode: boolean;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  /** 下拉里不出现这些用户（如当前登录用户、已是成员的人——下拉只列「可加用户」）。 */
  excludeUserIds?: readonly string[];
}): React.JSX.Element {
  const [results, setResults] = useState<UserDirectoryRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const timer = useRef(0);
  const seq = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  /* 排除名单走 ref：pick 后立即刷新候选时父层 setState 尚未落，闭包里的旧 props 会把
     刚加的人又列回来；渲染期同步 ref，宏任务回调里读到的就是最新名单。 */
  const excludeRef = useRef<readonly string[] | undefined>(excludeUserIds);
  excludeRef.current = excludeUserIds;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  /* 下拉用 portal 渲染到 body（fixed 定位），逃逸弹窗 DialogBody overflow-y-auto 的裁剪。
     跟随 input 位置：监听 resize / 捕获 scroll，open 期间持续校正坐标。 */
  useLayoutEffect(() => {
    if (!open) return;
    const el = wrapRef.current;
    if (!el) return;
    const place = (): void => {
      const rect = el.getBoundingClientRect();
      /* pointerEvents:"auto" 必带：Radix modal Dialog 会把 body 设成 pointer-events:none，
         portal 到 body 下的菜单继承 none → 鼠标事件穿透、pick 永不触发（点选无回显的根因）。 */
      setMenuStyle({ position: "fixed", top: rect.bottom + 4, left: rect.left, width: rect.width, zIndex: 80, pointerEvents: "auto" });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  function runSearch(text: string): void {
    window.clearTimeout(timer.current);
    const query = text.trim();
    timer.current = window.setTimeout(() => {
      const id = ++seq.current;
      const run = demoMode
        ? Promise.resolve(query ? directoryMatches(DEMO_DIRECTORY, query) : DEMO_DIRECTORY)
        : api.searchUserDirectory(query);
      void run.then((items) => {
        if (id !== seq.current) return;
        const excluded = excludeRef.current;
        const filtered = excluded?.length ? items.filter((u) => !excluded.includes(u.id)) : items;
        setResults(filtered);
        setOpen(filtered.length > 0);
        setNote("");
        onResolve(filtered);
      }).catch((reason: unknown) => {
        if (id !== seq.current) return;
        setResults([]);
        setOpen(false);
        setNote(reason instanceof ApiClientError ? reason.message : "用户搜索暂不可用，请稍后再试");
      });
    }, query ? 250 : 0);
  }

  function handleChange(text: string): void {
    onChange(text);
    runSearch(text);
  }

  function pick(user: UserDirectoryRecord): void {
    onChange(user.username);
    onResolve([user]);
    onPick?.(user);
    setNote("");
    /* onPick=多选加人场景（Lite 项目弹窗）：点选后保持下拉展开并刷新候选——焦点本就在
       输入框里，若直接关下拉，再点已聚焦的输入框不触发 onFocus，下拉再也开不了。
       单选填值场景（审核人等，无 onPick）维持点选即关。 */
    if (onPick) runSearch("");
    else setOpen(false);
  }

  return (
    <div className="relative" ref={wrapRef}>
      <Input
        value={value}
        disabled={disabled}
        placeholder={placeholder ?? "搜用户名或显示名"}
        aria-label={ariaLabel ?? placeholder ?? "搜用户名或显示名"}
        autoComplete="off"
        onChange={(event) => handleChange(event.target.value)}
        onFocus={() => {
          /* 聚焦即展示全部可加用户（空查询拉全量目录）；已有结果则直接展开。 */
          if (!value.trim()) {
            handleChange("");
          } else if (results.length > 0) {
            setOpen(true);
          }
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
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
