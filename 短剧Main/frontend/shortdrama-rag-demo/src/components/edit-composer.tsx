/* ============================================================
   edit-composer.tsx — W9-C EDIT 组装台（L0 命令条 / L1 回显 / L2 手风琴 / L3 只读预览）

   EDIT 是第二套语法（diff/patch 心智）：默认全锁，只声明增量。
   IR 是唯一真源（EditIR），prose 是编译产物（compileEditPrompt）；
   用户编辑结构与字段，不直接改 prose（L3 只读预览 + 回源点击）。
   短指令与精细控制是同一结构的不同展开粒度：L0 一句话 = intent，
   展开 L2 后 intent 保留、逐维解锁/新增，不重来。
   ============================================================ */

import { CaretDown, LockKey, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import {
  EDIT_DIMENSIONS,
  compileEditPrompt,
  type CoreAddition,
  type EditDimension,
  type EditField,
  type EditIR,
} from "../ir-compiler";
import type { MediaResult } from "../types";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { Badge, Input } from "./ui/primitives";

/** 编辑目标 → EditIR（组件与测试共用这一份组装，防漂移）。 */
export function buildEditIR(input: {
  intent: string;
  overrides: Readonly<Partial<Record<EditDimension, string>>>;
  additions: readonly CoreAddition[];
  cameraInheritance: string;
}): EditIR {
  const fields: Partial<Record<EditDimension, EditField>> = {};
  for (const [dimension, value] of Object.entries(input.overrides)) {
    const trimmed = (value ?? "").trim();
    if (trimmed) fields[dimension as EditDimension] = { mode: "override", value: trimmed };
  }
  return {
    kind: "edit",
    intent: input.intent.trim() || "（未填写编辑目标）",
    base: "base-video",
    assets: [{ id: "base-video", media: "video", role: "composition", label: "原视频", scope: "global" }],
    fields,
    additions: input.additions,
    camera_inheritance: input.cameraInheritance.trim() || undefined,
  };
}

/** 空新增块（四要素待填；summary 通常由 L0 一句话带入）。 */
export function emptyAddition(summary = ""): CoreAddition {
  return { name: "", summary, description: "", trigger: "", spatial_anchor: "", time_sync: "", physics: "" };
}

/** 数值伪精度两档标注（W9-C 纪律：已验证可控 / 官方推荐未验证，不承诺未验证维度）。 */
function SpecTag({ verified }: { verified: boolean }): React.JSX.Element {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", verified ? "border-success/40 text-success" : "border-warning/40 text-warning")}
      title={verified ? "该维度由服务端参数强制，效果可验证" : "官方推荐写法，模型执行效力未逐条验证"}
    >
      {verified ? "已验证可控" : "官方推荐未验证"}
    </span>
  );
}

export function EditComposer({ base, demoMode, notify, submitting, onSubmit, onClose }: {
  base: MediaResult;
  demoMode: boolean;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
  submitting?: boolean;
  onSubmit: (prose: string, referenceMediaIds: string[]) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [intent, setIntent] = useState("");
  const [expertOpen, setExpertOpen] = useState(false);
  const [overrides, setOverrides] = useState<Partial<Record<EditDimension, string>>>({});
  const [additions, setAdditions] = useState<CoreAddition[]>([]);
  const [cameraInheritance, setCameraInheritance] = useState("");
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(new Set(["additions"]));

  const ir = useMemo(
    () => buildEditIR({ intent, overrides, additions, cameraInheritance }),
    [intent, overrides, additions, cameraInheritance],
  );
  const compiled = useMemo(() => compileEditPrompt(ir), [ir]);
  const overrideCount = Object.values(overrides).filter((value) => (value ?? "").trim()).length;
  const lockCount = EDIT_DIMENSIONS.length - overrideCount;

  function toggleSection(key: string): void {
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function setOverride(dimension: EditDimension, value: string): void {
    setOverrides((current) => ({ ...current, [dimension]: value }));
  }

  function patchAddition(index: number, patch: Partial<CoreAddition>): void {
    setAdditions((current) => current.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  }

  /** L0 → L2 升级：一句话带入首个新增块（不重来，继续填四要素）。 */
  function openExpert(): void {
    if (additions.length === 0 && intent.trim()) setAdditions([emptyAddition(intent.trim())]);
    setExpertOpen(true);
  }

  async function submit(): Promise<void> {
    if (!intent.trim() && additions.every((item) => !item.summary.trim())) {
      notify("先说一句要改什么，或展开精细控制", "error");
      return;
    }
    if (demoMode) {
      notify("离线演示不会提交编辑任务", "info");
      return;
    }
    await onSubmit(compiled.prose, [base.id]);
  }

  const sectionHeader = (key: string, title: string, summary: string): React.JSX.Element => (
    <button
      type="button"
      className="flex w-full items-center gap-2 text-left text-xs font-medium text-ink-2 outline-none transition-colors duration-150 hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent"
      aria-expanded={openSections.has(key)}
      onClick={() => toggleSection(key)}
    >
      <CaretDown className={cn("size-3.5 shrink-0 transition-transform duration-150", openSections.has(key) ? "" : "-rotate-90")} aria-hidden="true" />
      {title}
      <span className="ml-auto font-normal text-ink-4">{summary}</span>
    </button>
  );

  return (
    <>
      <div className="fixed inset-0 z-[70] animate-fade-in bg-surface-well/70 backdrop-blur-sm" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !submitting && onClose()} />
      <aside className="fixed inset-y-0 right-0 z-[71] flex w-[min(620px,100vw)] animate-fade-up flex-col border-l border-border-2 bg-surface-1 shadow-[0_24px_48px_-16px_oklch(0_0_0/0.60)]" role="dialog" aria-modal="true" aria-label="基于此版本编辑">
        <header className="flex items-start justify-between gap-3 border-b border-border-1 px-5 py-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-ink-1 text-section-title">基于此版本编辑</h2>
            <p className="text-xs text-ink-2">默认全盘保留原视频，只声明要改的部分；系统编译为完整编辑指令。</p>
          </div>
          <Button size="icon" variant="ghost" aria-label="关闭" title="关闭" disabled={submitting} onClick={onClose}><X /></Button>
        </header>
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          <video controls preload="metadata" src={base.storage_url || ""} className="aspect-video w-full rounded-md border border-border-1 bg-surface-well object-contain" aria-label="被编辑的视频版本" />

          {/* L0 命令条：一句话编辑（系统包 EDIT 骨架） */}
          <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <label className="text-xs font-medium text-ink-2" htmlFor="edit-intent">对这个视频说一句话</label>
            <div className="flex gap-2">
              <Input
                id="edit-intent"
                value={intent}
                placeholder="删除所有人，除了主角。"
                aria-label="编辑目标一句话"
                disabled={submitting}
                onChange={(event) => setIntent(event.target.value)}
              />
              <Button variant="primary" type="submit" loading={submitting}>提交编辑</Button>
            </div>
          </form>

          {/* L1 结构化回显：将锁定/将修改（不假装解析，如实回显字段状态） */}
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs" role="status" aria-label="编辑结构回显">
            <Badge tone="neutral">将锁定 {lockCount} 维</Badge>
            <Badge tone={overrideCount > 0 ? "warning" : "neutral"}>覆写 {overrideCount}</Badge>
            <Badge tone={additions.length > 0 ? "warning" : "neutral"}>新增块 {additions.length}</Badge>
            <span className="min-w-0 flex-1 truncate text-ink-2">{intent.trim() ? `目标：${intent.trim()}` : "未声明修改内容时提交=仅锁定复述，无实际编辑"}</span>
            {!expertOpen ? (
              <button type="button" className="shrink-0 text-accent-text underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={openExpert}>展开精细控制</button>
            ) : null}
          </div>

          {/* L2 分区手风琴表单 */}
          {expertOpen ? (
            <div className="flex flex-col gap-4">
              <section className="flex flex-col gap-2">
                {sectionHeader("fields", "锁定与覆写", `${lockCount} 锁 · ${overrideCount} 改`)}
                {openSections.has("fields") ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-ink-4">未解锁的维度全部自动锁定（原样保留）；解锁后填写覆盖值即覆写。</p>
                    {EDIT_DIMENSIONS.map(([dimension, label]) => {
                      const value = overrides[dimension] ?? "";
                      const unlocked = value.trim().length > 0 || dimension in overrides;
                      return (
                        <div className="flex items-center gap-2" key={dimension}>
                          <button
                            type="button"
                            className={cn(
                              "inline-flex w-28 shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors duration-150",
                              unlocked ? "border-warning/50 bg-warning/10 text-warning" : "border-border-1 text-ink-2 hover:border-border-2 hover:text-ink-1",
                            )}
                            aria-pressed={unlocked}
                            title={unlocked ? `${label}：已解锁（清空输入回到锁定）` : `${label}：锁定中，点击解锁覆写`}
                            onClick={() => (unlocked ? setOverride(dimension, "") : setOverride(dimension, " "))}
                          >
                            {unlocked ? <PencilSimple className="size-3.5" aria-hidden="true" /> : <LockKey className="size-3.5" aria-hidden="true" />}{label}
                          </button>
                          {unlocked ? (
                            <Input
                              value={value.trimStart()}
                              placeholder={`覆写${label}…`}
                              aria-label={`覆写${label}`}
                              disabled={submitting}
                              onChange={(event) => setOverride(dimension, event.target.value)}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </section>

              <section className="flex flex-col gap-2">
                {sectionHeader("additions", "核心新增块", `${additions.length} 块`)}
                {openSections.has("additions") ? (
                  <div className="flex flex-col gap-3">
                    <p className="text-xs text-ink-4">每块是一条命名的增量规则（转色规则、银幕破裂锁定…），四要素齐全模型才锁得住。</p>
                    {additions.map((item, index) => (
                      <div className="flex flex-col gap-2 rounded-md border border-border-1 bg-surface-2 px-3 py-3" key={index}>
                        <div className="flex items-center gap-2">
                          <Input value={item.name} placeholder="规则名（如：转色规则）" aria-label={`新增块 ${index + 1} 规则名`} disabled={submitting} onChange={(event) => patchAddition(index, { name: event.target.value })} />
                          <Button size="icon" variant="ghost" aria-label={`删除新增块 ${index + 1}`} title="删除该块" disabled={submitting} onClick={() => setAdditions((current) => current.filter((_, position) => position !== index))}><Trash /></Button>
                        </div>
                        <Input value={item.summary} placeholder="一句话增量（进「唯一新增的内容是：…」白名单）" aria-label={`新增块 ${index + 1} 一句话增量`} disabled={submitting} onChange={(event) => patchAddition(index, { summary: event.target.value })} />
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <Input value={item.trigger} placeholder="触发条件（事件锚点）" aria-label={`新增块 ${index + 1} 触发条件`} disabled={submitting} onChange={(event) => patchAddition(index, { trigger: event.target.value })} />
                          <Input value={item.spatial_anchor} placeholder="空间锚点（从哪里开始/扩散）" aria-label={`新增块 ${index + 1} 空间锚点`} disabled={submitting} onChange={(event) => patchAddition(index, { spatial_anchor: event.target.value })} />
                          <Input value={item.time_sync} placeholder="时间同步（与哪一瞬精确同步）" aria-label={`新增块 ${index + 1} 时间同步`} disabled={submitting} onChange={(event) => patchAddition(index, { time_sync: event.target.value })} />
                          <Input value={item.physics} placeholder="物理约束（阴影/遮挡/力度）" aria-label={`新增块 ${index + 1} 物理约束`} disabled={submitting} onChange={(event) => patchAddition(index, { physics: event.target.value })} />
                        </div>
                      </div>
                    ))}
                    <Button variant="outline" icon={<Plus />} disabled={submitting} onClick={() => setAdditions((current) => [...current, emptyAddition()])}>加一块</Button>
                  </div>
                ) : null}
              </section>

              <section className="flex flex-col gap-2">
                {sectionHeader("camera", "镜头继承", cameraInheritance.trim() ? "自定义" : "默认全继承")}
                {openSections.has("camera") ? (
                  <Input
                    value={cameraInheritance}
                    placeholder="缺省：完全继承原视频的镜头运动，不重定时、不重新构图"
                    aria-label="镜头继承声明"
                    disabled={submitting}
                    onChange={(event) => setCameraInheritance(event.target.value)}
                  />
                ) : null}
              </section>

              <section className="flex flex-col gap-2">
                {sectionHeader("spec", "技术规格", "强制继承")}
                {openSections.has("spec") ? (
                  <div className="flex flex-col gap-2 text-xs text-ink-2">
                    <p className="m-0">总时长、画幅与原视频完全一致 <SpecTag verified /></p>
                    <p className="m-0">提示词各约束段的模型执行效力 <SpecTag verified={false} /></p>
                  </div>
                ) : null}
              </section>
            </div>
          ) : null}

          {/* L3 只读 prose 预览 + 回源点击 */}
          <section className="flex flex-col gap-2">
            <header className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium text-ink-2">编译预览（只读，随结构实时更新）</h3>
              <span className="text-[11px] text-ink-4">{compiled.prose.length} 字 · {compiled.provenance.length} 段</span>
            </header>
            <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border-1 bg-surface-well px-3 py-2 font-mono text-xs leading-relaxed text-ink-2">{compiled.prose}</pre>
            <div className="flex flex-wrap gap-1" aria-label="回源映射">
              {compiled.provenance.map((entry) => (
                <span
                  className="rounded-full border border-border-1 px-2 py-0.5 font-mono text-[10px] text-ink-4"
                  title={`回源：${entry.source.join("、")}`}
                  key={entry.segment}
                >{entry.segment}</span>
              ))}
            </div>
          </section>
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-border-1 px-5 py-4">
          <span className="text-xs text-ink-2">提交走同一条付费确认链；一次点击只创建一个任务。</span>
          <Button variant="primary" loading={submitting} onClick={() => void submit()}>提交编辑</Button>
        </footer>
      </aside>
    </>
  );
}
