/* ============================================================
   admin-page.tsx — 管理后台（S12 件 5；admin/operator 可见）

   六个页签：
   - 成本：GET /admin/costs?group_by=project|team|user|model（同源唯一取数源），
     未计价笔数如实标出；CSV 导出=同源接口 format=csv（前端不自己拼）；
     从「用户管理」点积分跳进来时按用户分组并高亮这个人（#152，admin.md §4.2）；
   - 用户管理：开号/改角色/调积分/停用（#152，仅管理员可写）；
   - 团队：CRUD + 成员维护（/admin/teams 及成员子路由）；
   - 用户分组：CRUD + 成员维护（/admin/user-groups 及成员子路由）；
   - 版本计划：预告版本段与版本历史的增删改排序（S23，写动作仅管理员）；
   - 账户与邀请码：S65 自注册策略/邀请码档位/邀请码/人工调账（S57 后端，仅管理员）。
   operator 只读导出不写（写动作 403 时给人话）；界面密度参照消耗明细表。
   ============================================================ */

import { Download, PencilSimple, Plus, Trash, UserMinus, Users } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { ApiClientError, api } from "../api";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import { Badge, EmptyState, Input, Select } from "../components/ui/primitives";
import { businessErrorMessage } from "../error-copy";
import {
  DEMO_ADMIN_COSTS_PROJECT,
  DEMO_DIRECTORY,
  DEMO_TEAMS,
  DEMO_USER_GROUPS,
  PLATFORM_ROLE_LABEL,
  canSeeAdminConsole,
  forbiddenMessage,
  type CostAggregatePage,
  type TeamRecord,
  type UserDirectoryRecord,
  type UserGroupRecord,
} from "../operations";
import type { PageRuntimeProps } from "./global-pages";
import { CapabilityCheckingPage, CapabilityUnavailablePage } from "../components/capability-notice";
import { ReleasePlanPanel } from "./admin-release-plan-panel";
import { AdminCreditsPanel } from "./admin-credits-panel";
import { AdminUsersPanel } from "./admin-users-panel";
import { COST_UNIT_LABEL } from "../cost-units";

type AdminTab = "costs" | "teams" | "groups" | "releases" | "credits" | "users";
type CostGroupBy = "project" | "team" | "user" | "model";

const GROUP_BY_LABEL: Record<CostGroupBy, string> = { project: "按项目", team: "按团队", user: "按用户", model: "按模型" };

/** #152：从用户管理点积分跳过来时，成本页按用户分组并高亮这个人的行。 */
export interface CostsFocusUser {
  id: string;
  label: string;
}

function writeDenied(reason: unknown, notify: PageRuntimeProps["notify"], fallback: string): void {
  notify(reason instanceof ApiClientError && reason.status === 403 ? "运营角色只读可导出，写动作需要管理员。" : businessErrorMessage(reason, fallback), "error");
}

/* ---------- 成本表（消耗明细密度） ---------- */

function CostsPanel({ demoMode, notify, focusUser, onClearFocus }: {
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  focusUser?: CostsFocusUser | null;
  onClearFocus?: () => void;
}): React.JSX.Element {
  const [groupBy, setGroupBy] = useState<CostGroupBy>("project");
  const [data, setData] = useState<CostAggregatePage | null>(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  /* 用户管理带人跳过来：切到「按用户」分组。 */
  useEffect(() => { if (focusUser) setGroupBy("user"); }, [focusUser]);

  const load = useCallback(async () => {
    if (demoMode) { setData({ ...DEMO_ADMIN_COSTS_PROJECT, groupBy }); return; }
    try {
      setData(await api.adminCostAggregate(groupBy));
      setError("");
    } catch (reason) {
      setError(reason instanceof ApiClientError && reason.status === 403 ? forbiddenMessage("admin") : "后台成本读取失败，请稍后重试");
    }
  }, [demoMode, groupBy]);

  useEffect(() => { void load(); }, [load]);

  async function exportCsv(): Promise<void> {
    if (demoMode) { notify("离线演示不会导出真实文件", "info"); return; }
    setExporting(true);
    try {
      const blob = await api.adminCostsCsvBlob(groupBy);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `costs-${groupBy}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      notify("CSV 已开始下载", "success");
    } catch (reason) {
      writeDenied(reason, notify, "CSV 导出失败");
    } finally { setExporting(false); }
  }

  return (
    <section className="flex flex-col gap-3" aria-label="后台成本">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="成本分组" value={groupBy} onChange={(event) => setGroupBy(event.target.value as CostGroupBy)}>
          {(Object.keys(GROUP_BY_LABEL) as CostGroupBy[]).map((key) => <option key={key} value={key}>{GROUP_BY_LABEL[key]}</option>)}
        </Select>
        <Button variant="secondary" icon={<Download />} loading={exporting} onClick={() => void exportCsv()}>导出 CSV</Button>
        {data && data.totals.unpricedCount > 0 ? (
          <Badge tone="warning" title="这些笔没有单价记录，按 0 聚合但未计入价格">未计价 {data.totals.unpricedCount} 笔</Badge>
        ) : null}
        <span className="ml-auto font-mono text-xs text-ink-2">合计 {data?.totals.chargedPoints ?? "—"} {COST_UNIT_LABEL} · {data?.totals.entryCount ?? 0} 笔</span>
      </div>
      {error ? <p className="rounded-sm bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p> : null}
      {focusUser ? (
        <p className="flex flex-wrap items-center gap-2 rounded-sm bg-accent-subtle px-3 py-2 text-xs text-accent-text" role="status">
          已定位到 {focusUser.label} 的账（按用户分组）。
          <button type="button" className="underline underline-offset-2" onClick={onClearFocus}>看全部</button>
        </p>
      ) : null}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border-1 text-left text-xs text-ink-4">
            <th className="py-2 pr-3 font-medium">{GROUP_BY_LABEL[groupBy].slice(1)}</th>
            <th className="py-2 pr-3 font-medium">{COST_UNIT_LABEL}</th>
            <th className="py-2 pr-3 font-medium">笔数</th>
            <th className="py-2 font-medium">未计价</th>
          </tr>
        </thead>
        <tbody>
          {(data?.rows ?? []).map((row) => (
            <tr key={row.key} className={cn("border-b border-border-1/60", focusUser && row.key === focusUser.id ? "bg-accent-subtle" : undefined)}>
              <td className="py-2 pr-3 text-ink-1">{row.label}</td>
              <td className="py-2 pr-3 font-mono">{row.chargedPoints}</td>
              <td className="py-2 pr-3 font-mono">{row.entryCount}</td>
              <td className="py-2">{row.unpricedCount > 0 ? <span className="text-warning">{row.unpricedCount} 笔未计价</span> : <span className="text-ink-4">—</span>}</td>
            </tr>
          ))}
          {data && data.rows.length === 0 ? <tr><td colSpan={4} className="py-6 text-center text-xs text-ink-4">该分组暂无成本记录</td></tr> : null}
        </tbody>
      </table>
    </section>
  );
}

/* ---------- 团队/分组管理表（同构） ---------- */

function MembershipTable<T extends { id: string; name: string }>({ kind, demoMode, notify, items, onCreate, onRename, onDelete, listMembers, addMember, removeMember }: {
  kind: "团队" | "用户分组";
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  items: T[];
  onCreate: (name: string) => Promise<void>;
  onRename: (item: T, name: string) => Promise<void>;
  onDelete: (item: T) => Promise<void>;
  listMembers: (id: string) => Promise<UserDirectoryRecord[]>;
  addMember: (id: string, userId: string) => Promise<void>;
  removeMember: (id: string, userId: string) => Promise<void>;
}): React.JSX.Element {
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState("");
  const [members, setMembers] = useState<UserDirectoryRecord[]>([]);
  const [memberName, setMemberName] = useState("");
  const [directory, setDirectory] = useState<UserDirectoryRecord[]>([]);

  useEffect(() => {
    if (demoMode) { setDirectory(DEMO_DIRECTORY); return; }
    void api.adminUsers().then(setDirectory).catch(() => setDirectory([]));
  }, [demoMode]);

  async function toggleMembers(id: string): Promise<void> {
    if (openId === id) { setOpenId(""); return; }
    setOpenId(id);
    if (demoMode) { setMembers(DEMO_DIRECTORY.slice(0, 2)); return; }
    try { setMembers(await listMembers(id)); } catch (reason) { writeDenied(reason, notify, "成员读取失败"); }
  }

  return (
    <section className="flex flex-col gap-3" aria-label={`${kind}管理`}>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label={`新建${kind}名称`} placeholder={`新建${kind}名称`} value={newName} onChange={(event) => setNewName(event.target.value)} />
        <Button icon={<Plus />} loading={busy} onClick={() => {
          const name = newName.trim();
          if (!name) return;
          setBusy(true);
          void onCreate(name).then(() => setNewName("")).catch((reason) => writeDenied(reason, notify, `新建${kind}失败`)).finally(() => setBusy(false));
        }}>新建{kind}</Button>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {items.map((item) => (
          <li key={item.id} className="rounded-md border border-border-1 bg-surface-2">
            <div className="flex items-center gap-2 px-3 py-2">
              <strong className="min-w-0 flex-1 truncate text-sm text-ink-1">{item.name}</strong>
              <Button size="sm" variant="ghost" icon={<Users />} onClick={() => void toggleMembers(item.id)} aria-expanded={openId === item.id}>成员</Button>
              <Button size="icon" variant="ghost" aria-label={`重命名 ${item.name}`} onClick={() => {
                const next = window.prompt(`重命名${kind}`, item.name)?.trim();
                if (!next || next === item.name) return;
                setBusy(true);
                void onRename(item, next).catch((reason) => writeDenied(reason, notify, "重命名失败")).finally(() => setBusy(false));
              }}><PencilSimple /></Button>
              <Button size="icon" variant="ghost" aria-label={`删除 ${item.name}`} onClick={() => {
                if (!window.confirm(`删除${kind}「${item.name}」？成员关系一并解除。`)) return;
                setBusy(true);
                void onDelete(item).catch((reason) => writeDenied(reason, notify, "删除失败")).finally(() => setBusy(false));
              }}><Trash /></Button>
            </div>
            {openId === item.id ? (
              <div className="flex flex-col gap-2 border-t border-border-1 px-3 py-2">
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {members.map((member) => (
                    <li key={member.id} className="flex items-center gap-2 text-xs">
                      <span className="min-w-0 flex-1 text-ink-1">{member.displayName}<span className="ml-1 font-mono text-ink-4">@{member.username}</span></span>
                      <Badge tone="neutral">{PLATFORM_ROLE_LABEL[member.platformRole]}</Badge>
                      <button type="button" className="text-danger hover:underline" aria-label={`移出 ${member.displayName}`} onClick={() => {
                        setBusy(true);
                        void removeMember(item.id, member.id)
                          .then(() => setMembers((current) => current.filter((m) => m.id !== member.id)))
                          .catch((reason) => writeDenied(reason, notify, "移出失败"))
                          .finally(() => setBusy(false));
                      }}><UserMinus className="size-3.5" /></button>
                    </li>
                  ))}
                  {members.length === 0 ? <li className="text-xs text-ink-4">暂无成员</li> : null}
                </ul>
                <div className="flex flex-wrap items-center gap-2">
                  <Input aria-label="按用户名加成员" placeholder="用户名或显示名" value={memberName} onChange={(event) => setMemberName(event.target.value)} />
                  <Button size="sm" loading={busy} onClick={() => {
                    const key = memberName.trim().toLowerCase();
                    const target = directory.find((u) => u.username.toLowerCase() === key || u.displayName.toLowerCase() === key);
                    if (!target) { notify(`找不到用户「${memberName.trim()}」`, "error"); return; }
                    setBusy(true);
                    void addMember(item.id, target.id)
                      .then(() => { setMembers((current) => [...current.filter((m) => m.id !== target.id), target]); setMemberName(""); })
                      .catch((reason) => writeDenied(reason, notify, "加成员失败"))
                      .finally(() => setBusy(false));
                  }}>加成员</Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
        {items.length === 0 ? <li className="text-xs text-ink-4">暂无{kind}</li> : null}
      </ul>
    </section>
  );
}

/* ---------- 页 ---------- */

export function AdminConsolePage({ demoMode, notify, capabilities }: PageRuntimeProps): React.JSX.Element {
  const [tab, setTab] = useState<AdminTab>("costs");
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [groups, setGroups] = useState<UserGroupRecord[]>([]);
  const [costsFocusUser, setCostsFocusUser] = useState<CostsFocusUser | null>(null);

  const reloadTeams = useCallback(async () => {
    if (demoMode) { setTeams(DEMO_TEAMS); return; }
    try { setTeams(await api.adminTeams()); } catch (reason) { writeDenied(reason, notify, "团队读取失败"); }
  }, [demoMode, notify]);
  const reloadGroups = useCallback(async () => {
    if (demoMode) { setGroups(DEMO_USER_GROUPS); return; }
    try { setGroups(await api.adminUserGroups()); } catch (reason) { writeDenied(reason, notify, "用户分组读取失败"); }
  }, [demoMode, notify]);

  useEffect(() => { void reloadTeams(); void reloadGroups(); }, [reloadTeams, reloadGroups]);

  /* 三态各说各的：还在读就别下结论，读不到就说读不到——只有查清了确实无权才给拒绝页。 */
  if (capabilities.status === "loading") return <CapabilityCheckingPage />;
  if (capabilities.status === "unavailable") return <CapabilityUnavailablePage onRetry={capabilities.reload} />;
  if (!canSeeAdminConsole(capabilities.capabilities)) {
    return <EmptyState title="后台只对管理员和运营开放" description={forbiddenMessage("admin")} icon={<Users />} />;
  }

  return (
    <section className="mx-auto flex w-full max-w-[1200px] flex-col gap-5" aria-label="管理后台">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title text-ink-1">管理后台</h1>
        <p className="text-sm text-ink-2">用户、成本、团队与用户分组。生成与 AI 调用记在同一本账；未计价笔数如实标出。</p>
      </header>
      <nav className="flex gap-1 border-b border-border-1 pb-2" aria-label="后台页签">
        {([["costs", "成本"], ["users", "用户管理"], ["teams", "团队"], ["groups", "用户分组"], ["releases", "版本计划"], ["credits", "账户与邀请码"]] as const).map(([key, label]) => (
          <button key={key} type="button" className={cn("rounded-sm px-3 py-1.5 text-sm", tab === key ? "bg-accent-subtle text-accent-text" : "text-ink-2 hover:text-ink-1")} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>
      {tab === "costs" ? <CostsPanel demoMode={demoMode} notify={notify} focusUser={costsFocusUser} onClearFocus={() => setCostsFocusUser(null)} /> : null}
      {tab === "users" ? (
        <AdminUsersPanel
          demoMode={demoMode}
          notify={notify}
          onShowUserCosts={(user) => {
            if (demoMode) { notify("离线演示：正式环境这里会跳到「成本」页，按用户分组看他的账", "info"); return; }
            setCostsFocusUser({ id: user.id, label: `${user.displayName}（@${user.username}）` });
            setTab("costs");
          }}
        />
      ) : null}
      {tab === "credits" ? <AdminCreditsPanel demoMode={demoMode} notify={notify} /> : null}
      {tab === "releases" ? <ReleasePlanPanel demoMode={demoMode} notify={notify} /> : null}
      {tab === "teams" ? (
        <MembershipTable
          kind="团队"
          demoMode={demoMode}
          notify={notify}
          items={teams}
          onCreate={async (name) => { if (demoMode) { setTeams((c) => [...c, { id: `demo-team-${Date.now()}`, name, parentTeamId: null, createdAt: "" }]); return; } await api.createTeam({ name }); await reloadTeams(); }}
          onRename={async (item, name) => { if (demoMode) { setTeams((c) => c.map((t) => (t.id === item.id ? { ...t, name } : t))); return; } await api.updateTeam(item.id, { name }); await reloadTeams(); }}
          onDelete={async (item) => { if (demoMode) { setTeams((c) => c.filter((t) => t.id !== item.id)); return; } await api.deleteTeam(item.id); await reloadTeams(); }}
          listMembers={(id) => api.teamMembers(id)}
          addMember={async (id, userId) => { if (demoMode) return; await api.addTeamMember(id, userId); }}
          removeMember={async (id, userId) => { if (demoMode) return; await api.removeTeamMember(id, userId); }}
        />
      ) : null}
      {tab === "groups" ? (
        <MembershipTable
          kind="用户分组"
          demoMode={demoMode}
          notify={notify}
          items={groups}
          onCreate={async (name) => { if (demoMode) { setGroups((c) => [...c, { id: `demo-ug-${Date.now()}`, name, createdAt: "" }]); return; } await api.createUserGroup({ name }); await reloadGroups(); }}
          onRename={async (item, name) => { if (demoMode) { setGroups((c) => c.map((g) => (g.id === item.id ? { ...g, name } : g))); return; } await api.updateUserGroup(item.id, { name }); await reloadGroups(); }}
          onDelete={async (item) => { if (demoMode) { setGroups((c) => c.filter((g) => g.id !== item.id)); return; } await api.deleteUserGroup(item.id); await reloadGroups(); }}
          listMembers={(id) => api.userGroupMembers(id)}
          addMember={async (id, userId) => { if (demoMode) return; await api.addUserGroupMember(id, userId); }}
          removeMember={async (id, userId) => { if (demoMode) return; await api.removeUserGroupMember(id, userId); }}
        />
      ) : null}
    </section>
  );
}
