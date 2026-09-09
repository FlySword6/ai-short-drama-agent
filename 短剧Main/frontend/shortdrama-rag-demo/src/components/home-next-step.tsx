/* ============================================================
   home-next-step.tsx — K2G 首页「我该去哪」三件套
   ① ResumeWorkCard  继续上次工作（回访用户第一眼：上次干到哪 + 下一步点哪）
   ② HomeActivityStrip 最近动态（生成/入库终态提醒，与 app.tsx 通知 Dock 同源；
     demo 恒禁 Dock 的现状不动，这里给如实空态，不用 fixture 造假动态）
   ③ HomeStartGuide  新用户三步起步指引（空项目时的去处：建项目→导剧本→拆分镜）

   单独成文件且保持 css-free（palette-trigger.tsx / production-stepper.tsx 同一
   先例）：仓根门禁 node:test 要 import 做 renderToStaticMarkup 真渲染断言，
   视觉全部走既有 token 类，零新 CSS、零新 token。
   容器组件挂 hooks 取数；View 组件纯渲染，门禁直接断 View。
   ============================================================ */
import * as React from "react";
import { ArrowRight, CheckCircle, Plus, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api } from "../api";
import {
  HOME_ACTIVITY_VISIBLE,
  HOME_START_STEPS,
  buildResumeWorkModel,
  demoRecordsForProject,
  hasDemoProductionData,
  toHomeActivityItems,
  type HomeActivityItem,
  type ResumeWorkModel,
} from "../home-next-step";
import { inferProductionProgress, type ProductionProgress } from "../production-progress";
import { loadProductionRecords } from "../production-stepper";
import { navigate, recallProjectLocation, visitedProjectIds } from "../routing";
import type { Project } from "../types";
import { relativeTimeLabel } from "../ui";
import { Button } from "./ui/button";
import { Input } from "./ui/primitives";

/* ---------- ① 继续上次工作 ---------- */

export function ResumeWorkCard({ project, demoMode }: { project: Project; demoMode: boolean }): React.JSX.Element | null {
  const [state, setState] = useState<{ ready: boolean; progress: ProductionProgress | null }>({ ready: false, progress: null });
  useEffect(() => {
    let active = true;
    if (demoMode) {
      /* demo 只对有归属 fixture 的项目推导；其余项目如实降级——拿别的项目的
         fixture 硬算下一步，就是 GP-04 数据串台的同款病根。 */
      setState({
        ready: true,
        progress: hasDemoProductionData(project.id) ? inferProductionProgress(demoRecordsForProject(project.id)) : null,
      });
      return;
    }
    loadProductionRecords(project.id)
      .then((records) => { if (active) setState({ ready: true, progress: inferProductionProgress(records) }); })
      .catch(() => { if (active) setState({ ready: true, progress: null }); });
    return () => { active = false; };
  }, [project.id, demoMode]);
  if (!state.ready) return null;
  const model = buildResumeWorkModel({
    projectId: project.id,
    projectName: project.name,
    rememberedPath: recallProjectLocation(project.id),
    progress: state.progress,
    updatedLabel: relativeTimeLabel(project.updated_at),
    /* F13：本人在本机打开过才配叫「继续上次工作」，否则如实「最近更新的项目」。 */
    personal: visitedProjectIds().has(project.id),
  });
  return <ResumeWorkView model={model} />;
}

export function ResumeWorkView({ model }: { model: ResumeWorkModel }): React.JSX.Element {
  return (
    <section className="flex items-center gap-4 rounded-lg border border-border-1 bg-surface-1 px-5 py-4" aria-label={model.title}>
      <div className="min-w-0 flex-1">
        <span className="text-xs font-medium text-ink-3">{model.title}</span>
        <p className="mt-1 text-sm text-ink-1">
          <strong>{model.projectName}</strong>
          {model.nextStepText ? <span className="text-ink-2">　{model.nextStepText}</span> : null}
        </p>
        {model.contextText ? <p className="mt-0.5 text-xs text-ink-2">{model.contextText}</p> : null}
      </div>
      <Button variant="primary" icon={<ArrowRight />} className="shrink-0" onClick={() => navigate(model.targetPath)}>{model.actionLabel}</Button>
    </section>
  );
}

/* ---------- ② 最近动态 ---------- */

type ActivityState = "loading" | "ready" | "error";

export function HomeActivityStrip({ demoMode, projects }: { demoMode: boolean; projects: readonly Project[] }): React.JSX.Element {
  const [state, setState] = useState<ActivityState>("loading");
  const [items, setItems] = useState<HomeActivityItem[]>([]);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    if (demoMode) return;
    let active = true;
    const nameOf = (projectId: string) => projects.find((project) => project.id === projectId)?.name ?? null;
    Promise.all([api.generationAttemptNotifications(8), api.assetUploadNotifications(8)])
      .then(([generation, uploads]) => {
        if (!active) return;
        setItems(toHomeActivityItems(generation.items, uploads.items, nameOf));
        setTotal(generation.count + uploads.count);
        setState("ready");
      })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [demoMode, projects]);
  return <HomeActivityView demoMode={demoMode} state={state} items={items} total={total} />;
}

export function HomeActivityView({ demoMode, state, items, total }: {
  demoMode: boolean;
  state: ActivityState;
  items: readonly HomeActivityItem[];
  total: number;
}): React.JSX.Element {
  const visible = items.slice(0, HOME_ACTIVITY_VISIBLE);
  const remaining = Math.max(0, total - visible.length);
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border-1 bg-surface-1 px-5 py-4" aria-label="最近动态">
      <span className="text-xs font-medium text-ink-3">最近动态</span>
      {demoMode ? (
        <p className="text-sm text-ink-2">离线演示不生成任务提醒。正式使用时，生成完成、入库完成的提醒会出现在这里。</p>
      ) : null}
      {!demoMode && state === "loading" ? <p className="text-sm text-ink-2" aria-busy="true">正在读取最近动态…</p> : null}
      {!demoMode && state === "error" ? <p className="text-sm text-ink-2" role="status">任务提醒暂时读不出来，稍后再看。</p> : null}
      {!demoMode && state === "ready" && items.length === 0 ? (
        <p className="text-sm text-ink-2">最近没有生成或入库完成的提醒。</p>
      ) : null}
      {!demoMode && state === "ready" && visible.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {visible.map((item) => (
            <li className="flex items-center gap-2" key={item.id}>
              {item.tone === "success"
                ? <CheckCircle aria-hidden="true" className="size-4 shrink-0 text-success" />
                : <WarningCircle aria-hidden="true" className="size-4 shrink-0 text-danger" />}
              <span className="shrink-0 text-sm text-ink-1">{item.title}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-2">{item.body}</span>
              <button
                type="button"
                className="shrink-0 text-xs font-medium text-accent-text underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onClick={() => navigate(item.targetPath)}
              >查看</button>
            </li>
          ))}
        </ul>
      ) : null}
      {!demoMode && state === "ready" && remaining > 0 ? <p className="text-xs text-ink-3">还有 {remaining} 条任务提醒。</p> : null}
    </section>
  );
}

/* ---------- ③ 新用户三步起步指引（仅空项目列表时渲染；有项目即退场） ---------- */

export function HomeStartGuide({ name, onNameChange, onSubmit, creating }: {
  name: string;
  onNameChange: (value: string) => void;
  onSubmit: () => void;
  creating: boolean;
}): React.JSX.Element {
  return (
    <section className="mx-auto flex w-full max-w-xl flex-col gap-5 rounded-lg border border-border-1 bg-surface-1 px-6 py-8" aria-label="三步开出第一部剧">
      <strong className="text-center text-section-title text-ink-1">还没有剧。三步开出第一部：</strong>
      <ol className="flex flex-col gap-4">
        {HOME_START_STEPS.map((step, index) => (
          <li className="flex gap-3" key={step.key}>
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border-2 text-xs font-medium text-ink-2" aria-hidden="true">{index + 1}</span>
            <div className="min-w-0 flex-1">
              <strong className="text-sm text-ink-1">{step.title}</strong>
              <p className="mt-0.5 text-xs text-ink-2">{step.note}</p>
              {step.key === "create" ? (
                <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
                  <Input className="w-60" value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="剧名，例如：《杀穿女频》" aria-label="剧名" />
                  <Button variant="primary" icon={<Plus />} type="submit" loading={creating}>新建项目</Button>
                </form>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
