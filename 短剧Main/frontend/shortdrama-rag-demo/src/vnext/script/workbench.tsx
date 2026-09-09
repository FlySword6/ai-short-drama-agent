import { ArrowClockwise, CheckCircle, FileArrowUp, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { newId } from "../../uuid";
import { VnextApiError, type VnextScriptWorkbench, vnextApi } from "../api";
import { ShotPlanDiagnostics, ShotPlanDraftView } from "../shot-plan/draft-view";
import { StoryboardWorkbench } from "../storyboard/workbench";

const POLL_MS = 180;

export function ScriptWorkbench({ projectId }: { projectId: string }): React.JSX.Element {
  const [state, setState] = useState<VnextScriptWorkbench | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [script, setScript] = useState("");
  const [fileName, setFileName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const importKey = useRef(newId());
  const confirmationKey = useRef(newId());

  const load = useCallback(async () => {
    try {
      const next = await vnextApi.scriptWorkbench(projectId);
      setState(next);
      setLoadError("");
    } catch (reason) {
      setLoadError(message(reason));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!state?.run || !["queued", "running"].includes(state.run.status)) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, state?.run?.id, state?.run?.status]);

  async function submit(): Promise<void> {
    if (!script.trim() || submitting) return;
    setSubmitting(true);
    setActionError("");
    try {
      const result = await vnextApi.createScriptRun(projectId, {
        source_kind: fileName ? "upload" : "paste",
        ...(fileName ? { file_name: fileName } : {}),
        script_content: script,
        client_idempotency_key: importKey.current,
      });
      setState((current) => ({ run: result.run, formal_facts: current?.formal_facts ?? null }));
      importKey.current = newId();
    } catch (reason) {
      setActionError(message(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function readFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setActionError("");
    try {
      setScript(await file.text());
      setFileName(file.name);
    } catch {
      setActionError("文件没能读取，请换一个 UTF-8 文本文件重试");
    }
  }

  async function retry(): Promise<void> {
    if (!state?.run) return;
    setActionError("");
    try {
      const result = await vnextApi.retryScriptRun(state.run.id);
      setState((current) => ({ run: result.run, formal_facts: current?.formal_facts ?? null }));
    } catch (reason) {
      setActionError(message(reason));
    }
  }

  async function confirm(): Promise<void> {
    if (!state?.run || state.run.status !== "draft") return;
    setSubmitting(true);
    setActionError("");
    try {
      const result = await vnextApi.confirmScriptRun(state.run.id, confirmationKey.current);
      confirmationKey.current = newId();
      await load();
      setState((current) => current ? { ...current, formal_facts: result.formal_facts } : current);
    } catch (reason) {
      setActionError(message(reason));
    } finally {
      setSubmitting(false);
    }
  }

  if (state === null && !loadError) {
    return <WorkbenchShell><p aria-live="polite" className="text-sm text-slate-300">正在恢复剧本与分镜状态…</p></WorkbenchShell>;
  }
  if (state === null && loadError) {
    return <WorkbenchShell><StateError message={loadError} action="重新读取" onAction={() => void load()} /></WorkbenchShell>;
  }

  const run = state?.run ?? null;
  const draft = run?.draft ?? null;
  const confirmed = run?.status === "confirmed" && state?.formal_facts;
  const canReplaceSource = !run || ["failed", "partial_failure"].includes(run.status);
  return <>
    <WorkbenchShell>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">Script → Shot Plan</p>
        <h2 className="mt-1 text-lg font-semibold text-white">固定剧本解析与分镜确认</h2>
        <p className="mt-1 text-xs text-slate-300">草稿确认前不会写入正式角色、场景或分镜事实。</p>
      </div>
      {confirmed ? <span className="inline-flex items-center gap-2 rounded-full bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200"><CheckCircle />已确认并恢复正式事实</span> : null}
    </div>

    {canReplaceSource ? <div className="mt-5 grid gap-4 md:grid-cols-[1fr_auto]">
      <textarea value={script} onChange={(event) => { setScript(event.target.value); setFileName(""); }} rows={7} placeholder="粘贴固定测试剧本" className="w-full rounded-md border border-white/15 bg-black/20 p-3 text-sm text-white outline-none focus:border-cyan-400" />
      <div className="flex min-w-48 flex-col gap-3">
        <label className="flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded border border-white/15 px-3 text-sm text-slate-200 hover:border-cyan-400">
          <FileArrowUp />上传文本剧本
          <input type="file" accept=".txt,text/plain" className="sr-only" onChange={(event) => void readFile(event.target.files?.[0])} />
        </label>
        {fileName ? <p className="text-xs text-slate-300">已选择：{fileName}</p> : null}
        <Button disabled={!script.trim() || submitting} onClick={() => void submit()}>{submitting ? "正在导入" : run ? "提交修正后的剧本" : "开始解析"}</Button>
      </div>
    </div> : null}

    {run && ["queued", "running"].includes(run.status) ? <div className="mt-5">
      <div className="flex justify-between text-xs text-slate-300"><span>{stageLabel(run.current_stage)}</span><span>{run.progress}%</span></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-cyan-400 transition-all" style={{ width: `${run.progress}%` }} /></div>
      <p aria-live="polite" className="mt-2 text-xs text-slate-400">解析进度已保存，刷新页面后会继续恢复。</p>
    </div> : null}

    {draft?.warnings.length ? <div className="mt-5">
      <ShotPlanDiagnostics warnings={draft.warnings} />
    </div> : null}
    {run?.error ? <div className="mt-5"><StateError
      message={`${errorTitle(run.error.code)}：${run.error.message}`}
      action={run.error.retryable ? "重试解析" : undefined}
      onAction={run.error.retryable ? () => void retry() : undefined}
      actionDescribedBy={draft?.warnings.length ? "vnext-script-diagnostics" : undefined}
    /></div> : null}
    {actionError ? <div className="mt-4"><StateError message={actionError} action="重新读取" onAction={() => void load()} /></div> : null}
    {draft ? <div className="mt-5">
      <ShotPlanDraftView draft={draft} formalFacts={state?.formal_facts ?? null} />
      {run?.status === "draft" ? <div className="mt-4 flex items-center justify-between gap-4 rounded-md border border-amber-300/20 bg-amber-200/5 p-4">
        <p className="text-xs text-amber-100">确认会在一个数据库事务中写入正式角色、场景和分镜；重复确认不会重复创建。</p>
        <Button disabled={submitting} onClick={() => void confirm()}>{submitting ? "正在确认" : "确认形成正式分镜"}</Button>
      </div> : null}
    </div> : null}
    </WorkbenchShell>
    {state?.formal_facts ? <StoryboardWorkbench projectId={projectId} confirmationId={state.formal_facts.confirmation_id} /> : null}
  </>;
}

function WorkbenchShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <section className="mb-4 rounded-md border border-white/10 bg-[#171d24] p-5 text-white">{children}</section>;
}

function StateError({
  message,
  action,
  onAction,
  actionDescribedBy,
}: {
  message: string;
  action?: string;
  onAction?: () => void;
  actionDescribedBy?: string;
}): React.JSX.Element {
  return <div role="alert" className="flex flex-wrap items-center gap-3 rounded bg-red-400/10 px-4 py-3 text-sm text-red-100">
    <WarningCircle /> <span className="flex-1">{message}</span>
    {action && onAction ? <button
      type="button"
      aria-describedby={actionDescribedBy}
      className="inline-flex items-center gap-1 underline"
      onClick={onAction}
    ><ArrowClockwise />{action}</button> : null}
  </div>;
}

function stageLabel(stage: string): string {
  if (stage === "queued") return "等待解析";
  if (stage === "reading") return "读取剧本";
  if (stage === "structuring") return "整理角色与场景";
  if (stage === "validating") return "校验分镜结构";
  return "准备草稿";
}

function errorTitle(code: string): string {
  if (code === "script_partial_failure") return "部分解析失败";
  if (code === "script_model_unavailable") return "模型不可用";
  if (code === "script_parse_timeout") return "解析超时";
  if (code === "script_schema_validation_failed") return "结构校验失败";
  return "解析失败";
}

function message(reason: unknown): string {
  return reason instanceof VnextApiError ? reason.message : "vNext 剧本服务暂时不可用，请重试";
}
