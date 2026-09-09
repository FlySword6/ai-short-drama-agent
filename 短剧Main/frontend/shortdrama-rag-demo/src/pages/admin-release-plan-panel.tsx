/* ============================================================
   admin-release-plan-panel.tsx — 管理后台「版本计划」页签(S23)

   版本计划(预告版本段)与版本历史的增、删、改、排序。
   写动作仅管理员；运营角色看得到页签但写不了(403 时给人话)。
   新建条目默认草稿——确认后再置「显示中」，防止手滑直接上前台。
   卡片/条目顺序即展示顺序，用上移/下移调整；段与段之间同理。
   S46 B-7(R46):预告口径(只放功能/零 bug fix 零后端词/每条=功能名+用户价值)
   写进编辑面——段表 hint 与卡片非「新功能」类即时预警。
   显式 React import:仓根门禁(node:test + tsx,classic JSX)渲染断言与 Vite react-jsx 双兼容。
   ============================================================ */

import * as React from "react";
import { ArrowDown, ArrowUp, FilmSlate, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { ApiClientError, api } from "../api";
import { Button } from "../components/ui/button";
import { Badge, EmptyState, Input, Select, Textarea } from "../components/ui/primitives";
import { businessErrorMessage } from "../error-copy";
import {
  CONFIG_ENTRY_STATUS_LABEL,
  RELEASE_CATEGORY_LABEL,
  RELEASE_PREVIEW_RULE,
  RELEASE_STATUS_LABEL,
  historyPayloadFromView,
  previewCategoryWarning,
  releaseHistoryFromEntry,
  releaseSectionFromEntry,
  sectionPayloadFromView,
  type ConfigEntry,
  type ConfigEntryKind,
  type ConfigEntryStatus,
  type ReleaseCard,
  type ReleaseCategory,
  type ReleaseHistoryItem,
  type ReleaseStatus,
} from "../release-plan";
import type { PageRuntimeProps } from "./global-pages";

const ENTRY_STATUS_OPTIONS = Object.entries(CONFIG_ENTRY_STATUS_LABEL) as Array<[ConfigEntryStatus, string]>;
const RELEASE_STATUS_OPTIONS = Object.entries(RELEASE_STATUS_LABEL) as Array<[ReleaseStatus, string]>;
const CATEGORY_OPTIONS = Object.entries(RELEASE_CATEGORY_LABEL) as Array<[ReleaseCategory, string]>;

function saveDenied(reason: unknown, notify: PageRuntimeProps["notify"], fallback: string): void {
  notify(reason instanceof ApiClientError && reason.status === 403 ? "只有管理员可以管理版本计划。" : businessErrorMessage(reason, fallback), "error");
}

/* ---------- 表单形状 ---------- */

interface SectionForm {
  entryKey: string;
  entryStatus: ConfigEntryStatus;
  title: string;
  sectionStatus: ReleaseStatus;
  note: string;
  cards: ReleaseCard[];
}

interface HistoryForm {
  entryKey: string;
  entryStatus: ConfigEntryStatus;
  date: string;
  title: string;
  items: ReleaseHistoryItem[];
}

type Editing =
  | { kind: "release_section"; id: string | null; form: SectionForm }
  | { kind: "release_history_entry"; id: string | null; form: HistoryForm }
  | null;

function blankSectionForm(): SectionForm {
  return { entryKey: "", entryStatus: "draft", title: "", sectionStatus: "concept", note: "", cards: [] };
}

function blankHistoryForm(): HistoryForm {
  return { entryKey: "", entryStatus: "draft", date: "", title: "", items: [] };
}

function sectionFormFromEntry(entry: ConfigEntry): SectionForm | null {
  const section = releaseSectionFromEntry(entry);
  if (!section) return null;
  return {
    entryKey: entry.entryKey,
    entryStatus: entry.status,
    title: section.title,
    sectionStatus: section.status,
    note: section.note,
    cards: section.cards,
  };
}

function historyFormFromEntry(entry: ConfigEntry): HistoryForm | null {
  const history = releaseHistoryFromEntry(entry);
  if (!history) return null;
  return {
    entryKey: entry.entryKey,
    entryStatus: entry.status,
    date: history.date,
    title: history.title,
    items: history.items,
  };
}

function newCard(sectionStatus: ReleaseStatus, release: string): ReleaseCard {
  return {
    id: `card-${Date.now().toString(36)}`,
    title: "",
    tagline: "",
    status: sectionStatus,
    category: "feature",
    release,
  };
}

/* ---------- 主面板 ---------- */

export function ReleasePlanPanel({ demoMode, notify }: { demoMode: boolean; notify: PageRuntimeProps["notify"] }): React.JSX.Element {
  const [entries, setEntries] = useState<Record<ConfigEntryKind, ConfigEntry[]>>({ release_section: [], release_history_entry: [] });
  const [state, setState] = useState<"loading" | "error" | "forbidden" | "idle">("loading");
  const [editing, setEditing] = useState<Editing>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (demoMode) return;
    setState("loading");
    try {
      const [sections, history] = await Promise.all([
        api.adminConfigEntries("release_section"),
        api.adminConfigEntries("release_history_entry"),
      ]);
      setEntries({ release_section: sections, release_history_entry: history });
      setState("idle");
    } catch (reason) {
      setState(reason instanceof ApiClientError && reason.status === 403 ? "forbidden" : "error");
    }
  }, [demoMode]);

  useEffect(() => { void load(); }, [load]);

  async function move(kind: ConfigEntryKind, entry: ConfigEntry, direction: -1 | 1): Promise<void> {
    const list = entries[kind];
    const index = list.findIndex((item) => item.id === entry.id);
    const neighbor = list[index + direction];
    if (!neighbor) return;
    try {
      await api.updateConfigEntry(entry.id, { kind, sort: neighbor.sort });
      await api.updateConfigEntry(neighbor.id, { kind, sort: entry.sort });
      await load();
    } catch (reason) {
      saveDenied(reason, notify, "调整顺序失败，请重试");
      await load();
    }
  }

  async function remove(kind: ConfigEntryKind, entry: ConfigEntry): Promise<void> {
    try {
      await api.deleteConfigEntry(entry.id);
      setPendingDelete(null);
      notify("已删除", "success");
      await load();
    } catch (reason) {
      saveDenied(reason, notify, "删除失败，请重试");
    }
  }

  async function save(): Promise<void> {
    if (!editing || saving) return;
    const { kind, id, form } = editing;
    const entryKey = form.entryKey.trim();
    if (!entryKey) {
      notify(kind === "release_section" ? "先填档期版本号，如 v0.4" : "先填版本号，如 v0.1.3", "error");
      return;
    }
    const payload = kind === "release_section"
      ? sectionPayloadFromView({
          version: entryKey,
          title: (form as SectionForm).title.trim(),
          status: (form as SectionForm).sectionStatus,
          note: (form as SectionForm).note.trim(),
          cards: (form as SectionForm).cards,
        })
      : historyPayloadFromView({
          version: entryKey,
          date: (form as HistoryForm).date.trim(),
          title: (form as HistoryForm).title.trim(),
          items: (form as HistoryForm).items,
        });
    setSaving(true);
    try {
      if (id) {
        await api.updateConfigEntry(id, { kind, entry_key: entryKey, status: form.entryStatus, payload });
      } else {
        const sort = Math.max(0, ...entries[kind].map((entry) => entry.sort)) + 1;
        await api.createConfigEntry({ kind, entry_key: entryKey, status: form.entryStatus, sort, payload });
      }
      setEditing(null);
      notify("已保存", "success");
      await load();
    } catch (reason) {
      saveDenied(reason, notify, "保存失败，请检查内容后重试");
    } finally {
      setSaving(false);
    }
  }

  if (demoMode) {
    return <EmptyState title="离线演示不展示版本计划管理" description="版本计划保存在服务端，离线演示读取不到；登录正式环境即可管理。" icon={<FilmSlate />} />;
  }
  if (state === "forbidden") {
    return <EmptyState title="只有管理员可以管理版本计划" description="需要管理员开通权限后才能增删改。" icon={<FilmSlate />} />;
  }
  if (state === "error") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
        <span>版本计划读取失败，请稍后重试。</span>
        <button type="button" className="font-semibold underline underline-offset-2" onClick={() => void load()}>重试</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <KindTable
        kind="release_section"
        title="预告版本段"
        hint={`设置页「版本预告」的段与卡片；「显示中」才会上前台，顺序即展示顺序。${RELEASE_PREVIEW_RULE}`}
        entries={entries.release_section}
        loading={state === "loading"}
        renderRow={(entry) => {
          const section = releaseSectionFromEntry(entry);
          return [entry.entryKey, section?.title ?? "内容读不出来", section ? RELEASE_STATUS_LABEL[section.status] : "—", `${section?.cards.length ?? 0} 张卡`];
        }}
        onEdit={(entry) => {
          const form = sectionFormFromEntry(entry);
          if (!form) { notify("这条内容格式读不出来，未能打开编辑", "error"); return; }
          setEditing({ kind: "release_section", id: entry.id, form });
        }}
        onCreate={() => setEditing({ kind: "release_section", id: null, form: blankSectionForm() })}
        onMove={(entry, direction) => void move("release_section", entry, direction)}
        pendingDelete={pendingDelete}
        onAskDelete={(entry) => setPendingDelete(entry.id)}
        onConfirmDelete={(entry) => void remove("release_section", entry)}
        onCancelDelete={() => setPendingDelete(null)}
      />
      <KindTable
        kind="release_history_entry"
        title="版本历史"
        hint="设置页页顶「版本历史」折叠块的内容，新发布排前。"
        entries={entries.release_history_entry}
        loading={state === "loading"}
        renderRow={(entry) => {
          const history = releaseHistoryFromEntry(entry);
          return [entry.entryKey, history?.date ?? "—", history?.title ?? "内容读不出来", `${history?.items.length ?? 0} 项`];
        }}
        onEdit={(entry) => {
          const form = historyFormFromEntry(entry);
          if (!form) { notify("这条内容格式读不出来，未能打开编辑", "error"); return; }
          setEditing({ kind: "release_history_entry", id: entry.id, form });
        }}
        onCreate={() => setEditing({ kind: "release_history_entry", id: null, form: blankHistoryForm() })}
        onMove={(entry, direction) => void move("release_history_entry", entry, direction)}
        pendingDelete={pendingDelete}
        onAskDelete={(entry) => setPendingDelete(entry.id)}
        onConfirmDelete={(entry) => void remove("release_history_entry", entry)}
        onCancelDelete={() => setPendingDelete(null)}
      />
      {editing?.kind === "release_section" ? (
        <SectionEditor
          form={editing.form}
          isNew={editing.id === null}
          saving={saving}
          onChange={(form) => setEditing({ kind: "release_section", id: editing.id, form })}
          onSave={() => void save()}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {editing?.kind === "release_history_entry" ? (
        <HistoryEditor
          form={editing.form}
          isNew={editing.id === null}
          saving={saving}
          onChange={(form) => setEditing({ kind: "release_history_entry", id: editing.id, form })}
          onSave={() => void save()}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

/* ---------- 列表(段/历史共用) ---------- */

function KindTable({ kind, title, hint, entries, loading, renderRow, onEdit, onCreate, onMove, pendingDelete, onAskDelete, onConfirmDelete, onCancelDelete }: {
  kind: ConfigEntryKind;
  title: string;
  hint: string;
  entries: ConfigEntry[];
  loading: boolean;
  renderRow: (entry: ConfigEntry) => string[];
  onEdit: (entry: ConfigEntry) => void;
  onCreate: () => void;
  onMove: (entry: ConfigEntry, direction: -1 | 1) => void;
  pendingDelete: string | null;
  onAskDelete: (entry: ConfigEntry) => void;
  onConfirmDelete: (entry: ConfigEntry) => void;
  onCancelDelete: () => void;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-ink-1 text-section-title">{title}</h2>
        <span className="text-xs text-ink-2">{hint}</span>
        <Button className="ml-auto" size="sm" variant="secondary" icon={<Plus />} onClick={onCreate}>新增{title}</Button>
      </div>
      {entries.length === 0 ? (
        loading
          ? <p className="text-xs text-ink-2">正在读取…</p>
          : <EmptyState title={`还没有${title}`} description={`点「新增${title}」建第一条；保存为「显示中」后上前台。`} icon={<FilmSlate />} />
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border-1 text-left text-xs text-ink-4">
              <th className="py-2 pr-3 font-medium">顺序</th>
              <th className="py-2 pr-3 font-medium">{kind === "release_section" ? "版本/标题/段状态/卡片" : "版本/日期/定位/条目"}</th>
              <th className="py-2 pr-3 font-medium">显示状态</th>
              <th className="py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => {
              const cells = renderRow(entry);
              return (
                <tr key={entry.id} className="border-b border-border-1 last:border-b-0">
                  <td className="whitespace-nowrap py-2 pr-3">
                    <span className="mr-2 font-mono text-xs text-ink-4">{entry.sort}</span>
                    <button type="button" aria-label="上移" className="mr-1 inline-flex text-ink-2 hover:text-ink-1 disabled:opacity-30" disabled={index === 0} onClick={() => onMove(entry, -1)}><ArrowUp aria-hidden="true" /></button>
                    <button type="button" aria-label="下移" className="inline-flex text-ink-2 hover:text-ink-1 disabled:opacity-30" disabled={index === entries.length - 1} onClick={() => onMove(entry, 1)}><ArrowDown aria-hidden="true" /></button>
                  </td>
                  <td className="py-2 pr-3 text-xs text-ink-1">{cells.join(" · ")}</td>
                  <td className="py-2 pr-3"><Badge tone={entry.status === "published" ? "success" : entry.status === "draft" ? "warning" : "neutral"}>{CONFIG_ENTRY_STATUS_LABEL[entry.status]}</Badge></td>
                  <td className="whitespace-nowrap py-2">
                    {pendingDelete === entry.id ? (
                      <span className="inline-flex items-center gap-2 text-xs">
                        <button type="button" className="font-semibold text-danger underline underline-offset-2" onClick={() => onConfirmDelete(entry)}>确认删除</button>
                        <button type="button" className="text-ink-2 underline underline-offset-2" onClick={onCancelDelete}>取消</button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Button size="icon" variant="ghost" icon={<PencilSimple />} aria-label={`编辑 ${entry.entryKey}`} onClick={() => onEdit(entry)} />
                        <Button size="icon" variant="ghost" icon={<Trash />} aria-label={`删除 ${entry.entryKey}`} onClick={() => onAskDelete(entry)} />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* ---------- 段编辑器 ---------- */

const fieldLabelClass = "flex flex-col gap-1 text-xs text-ink-2";
const fieldInputClass = "w-full";

export function SectionEditor({ form, isNew, saving, onChange, onSave, onCancel }: {
  form: SectionForm;
  isNew: boolean;
  saving: boolean;
  onChange: (form: SectionForm) => void;
  onSave: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  function patchCard(index: number, patch: Partial<ReleaseCard>): void {
    onChange({ ...form, cards: form.cards.map((card, cardIndex) => (cardIndex === index ? { ...card, ...patch } : card)) });
  }
  function moveCard(index: number, direction: -1 | 1): void {
    const next = [...form.cards];
    const [card] = next.splice(index, 1);
    next.splice(index + direction, 0, card!);
    onChange({ ...form, cards: next });
  }
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border-1 bg-surface-1 p-4" aria-label={isNew ? "新增预告版本段" : `编辑 ${form.entryKey}`}>
      <h3 className="text-sm font-semibold text-ink-1">{isNew ? "新增预告版本段" : `编辑版本段 ${form.entryKey}`}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={fieldLabelClass}>档期版本号(如 v0.4;远景段填 vision)
          <Input className={fieldInputClass} value={form.entryKey} onChange={(event) => onChange({ ...form, entryKey: event.target.value })} aria-label="档期版本号" />
        </label>
        <label className={fieldLabelClass}>段标题
          <Input className={fieldInputClass} value={form.title} onChange={(event) => onChange({ ...form, title: event.target.value })} aria-label="段标题" />
        </label>
        <label className={fieldLabelClass}>段状态
          <Select value={form.sectionStatus} onChange={(event) => onChange({ ...form, sectionStatus: event.target.value as ReleaseStatus })} aria-label="段状态">
            {RELEASE_STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </label>
        <label className={fieldLabelClass}>显示状态
          <Select value={form.entryStatus} onChange={(event) => onChange({ ...form, entryStatus: event.target.value as ConfigEntryStatus })} aria-label="显示状态">
            {ENTRY_STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </label>
      </div>
      <label className={fieldLabelClass}>段注(一句话，不说状态词)
        <Input className={fieldInputClass} value={form.note} onChange={(event) => onChange({ ...form, note: event.target.value })} aria-label="段注" />
      </label>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <strong className="text-xs text-ink-1">卡片({form.cards.length})</strong>
          <Button size="sm" variant="secondary" icon={<Plus />} onClick={() => onChange({ ...form, cards: [...form.cards, newCard(form.sectionStatus, form.entryKey || "")] })}>新增卡片</Button>
        </div>
        {form.cards.map((card, index) => (
          <div className="flex flex-col gap-2 rounded-md border border-border-1 bg-surface-2 p-3" key={card.id}>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
              <label className={fieldLabelClass}>名称
                <Input value={card.title} onChange={(event) => patchCard(index, { title: event.target.value })} aria-label={`卡片 ${index + 1} 名称`} />
              </label>
              <label className={fieldLabelClass}>标识(小写字母数字与连字符)
                <Input value={card.id} onChange={(event) => patchCard(index, { id: event.target.value })} aria-label={`卡片 ${index + 1} 标识`} />
              </label>
              <label className={fieldLabelClass}>分类
                <Select value={card.category} onChange={(event) => patchCard(index, { category: event.target.value as ReleaseCategory })} aria-label={`卡片 ${index + 1} 分类`}>
                  {CATEGORY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </Select>
              </label>
              <label className={fieldLabelClass}>状态
                <Select value={card.status} onChange={(event) => patchCard(index, { status: event.target.value as ReleaseStatus })} aria-label={`卡片 ${index + 1} 状态`}>
                  {RELEASE_STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </Select>
              </label>
              <label className={fieldLabelClass}>档期(如 v0.3;未定档填「未定档」)
                <Input value={card.release} onChange={(event) => patchCard(index, { release: event.target.value })} aria-label={`卡片 ${index + 1} 档期`} />
              </label>
              <span className="flex items-end justify-end gap-1">
                <button type="button" aria-label={`卡片 ${index + 1} 上移`} className="inline-flex p-1 text-ink-2 hover:text-ink-1 disabled:opacity-30" disabled={index === 0} onClick={() => moveCard(index, -1)}><ArrowUp aria-hidden="true" /></button>
                <button type="button" aria-label={`卡片 ${index + 1} 下移`} className="inline-flex p-1 text-ink-2 hover:text-ink-1 disabled:opacity-30" disabled={index === form.cards.length - 1} onClick={() => moveCard(index, 1)}><ArrowDown aria-hidden="true" /></button>
                <Button size="icon" variant="ghost" icon={<Trash />} aria-label={`删除卡片 ${card.title || index + 1}`} onClick={() => onChange({ ...form, cards: form.cards.filter((_, cardIndex) => cardIndex !== index) })} />
              </span>
            </div>
            {/* R46:非「新功能」类卡不上预告页,编辑时即时预警(预警文案走 release-plan 纯逻辑)。 */}
            {previewCategoryWarning(card.category) ? (
              <p className="rounded-sm bg-warning/14 px-3 py-1.5 text-xs text-warning" role="status">{previewCategoryWarning(card.category)}</p>
            ) : null}
            <label className={fieldLabelClass}>一句话价值(说清解决什么痛点)
              <Textarea rows={2} value={card.tagline} onChange={(event) => patchCard(index, { tagline: event.target.value })} aria-label={`卡片 ${index + 1} 一句话价值`} />
            </label>
            {/* S24-A：reason 用户可见「为什么做」；basis 留痕字段不进表单(只经接口/迁移写入)。 */}
            <label className={fieldLabelClass}>起因(可空；用户可见，说清为什么做)
              <Input value={card.reason ?? ""} onChange={(event) => patchCard(index, { reason: event.target.value.trim() ? event.target.value : undefined })} aria-label={`卡片 ${index + 1} 起因`} />
            </label>
            <label className={fieldLabelClass}>轮播短句(可空；已上线与远景卡不会进轮播)
              <Input value={card.teaser ?? ""} onChange={(event) => patchCard(index, { teaser: event.target.value.trim() ? event.target.value : undefined })} aria-label={`卡片 ${index + 1} 轮播短句`} />
            </label>
          </div>
        ))}
      </div>
      <EditorActions saving={saving} onSave={onSave} onCancel={onCancel} />
    </section>
  );
}

/* ---------- 历史编辑器 ---------- */

function HistoryEditor({ form, isNew, saving, onChange, onSave, onCancel }: {
  form: HistoryForm;
  isNew: boolean;
  saving: boolean;
  onChange: (form: HistoryForm) => void;
  onSave: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  function patchItem(index: number, patch: Partial<ReleaseHistoryItem>): void {
    onChange({ ...form, items: form.items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)) });
  }
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border-1 bg-surface-1 p-4" aria-label={isNew ? "新增版本历史" : `编辑 ${form.entryKey}`}>
      <h3 className="text-sm font-semibold text-ink-1">{isNew ? "新增版本历史" : `编辑版本历史 ${form.entryKey}`}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={fieldLabelClass}>版本号(如 v0.1.3)
          <Input value={form.entryKey} onChange={(event) => onChange({ ...form, entryKey: event.target.value })} aria-label="版本号" />
        </label>
        <label className={fieldLabelClass}>发布日期(YYYY-MM-DD)
          <Input value={form.date} onChange={(event) => onChange({ ...form, date: event.target.value })} aria-label="发布日期" placeholder="2026-07-26" />
        </label>
        <label className={fieldLabelClass}>一句话定位
          <Input value={form.title} onChange={(event) => onChange({ ...form, title: event.target.value })} aria-label="一句话定位" />
        </label>
        <label className={fieldLabelClass}>显示状态
          <Select value={form.entryStatus} onChange={(event) => onChange({ ...form, entryStatus: event.target.value as ConfigEntryStatus })} aria-label="显示状态">
            {ENTRY_STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </label>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <strong className="text-xs text-ink-1">交付项({form.items.length})</strong>
          <Button size="sm" variant="secondary" icon={<Plus />} onClick={() => onChange({ ...form, items: [...form.items, { label: "", category: "feature" }] })}>新增交付项</Button>
        </div>
        {form.items.map((item, index) => (
          <div className="flex flex-wrap items-center gap-2" key={index}>
            <Input className="min-w-0 flex-1" value={item.label} onChange={(event) => patchItem(index, { label: event.target.value })} aria-label={`交付项 ${index + 1} 名称`} />
            <Select value={item.category} onChange={(event) => patchItem(index, { category: event.target.value as ReleaseCategory })} aria-label={`交付项 ${index + 1} 分类`}>
              {CATEGORY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
            <Button size="icon" variant="ghost" icon={<Trash />} aria-label={`删除交付项 ${item.label || index + 1}`} onClick={() => onChange({ ...form, items: form.items.filter((_, itemIndex) => itemIndex !== index) })} />
          </div>
        ))}
      </div>
      <EditorActions saving={saving} onSave={onSave} onCancel={onCancel} />
    </section>
  );
}

function EditorActions({ saving, onSave, onCancel }: { saving: boolean; onSave: () => void; onCancel: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" loading={saving} onClick={onSave}>保存</Button>
      <Button variant="secondary" onClick={onCancel}>取消</Button>
      <span className="text-xs text-ink-4">「显示中」保存后立即上前台；草稿只有这里看得到。</span>
    </div>
  );
}
