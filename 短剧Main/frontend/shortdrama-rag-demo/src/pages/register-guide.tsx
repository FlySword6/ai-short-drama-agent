import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { navigate } from "../routing";
import type { Candidate, GrillCheckResult } from "../types";
import type { PageRuntimeProps } from "./global-pages";
import { Button } from "../components/ui/button";
import { businessErrorMessage } from "../error-copy";

type Phase = "loading" | "clarify" | "candidates" | "confirm" | "done" | "error";

interface GuideState {
  phase: Phase;
  question: string;
  targetField: string;
  candidates: Candidate[];
  summary: string;
  collectedFields: string[];
  error: string;
}

const INITIAL_STATE: GuideState = {
  phase: "loading",
  question: "",
  targetField: "",
  candidates: [],
  summary: "",
  collectedFields: [],
  error: "",
};

const FIELD_LABELS: Record<string, string> = {
  preferred_genre: "偏好的短剧类型",
  user_role: "你的角色",
  preferred_tone: "偏好的剧情风格",
};

export function RegisterGuidePage({ notify }: PageRuntimeProps): React.JSX.Element {
  const [state, setState] = useState<GuideState>(INITIAL_STATE);
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const sessionIdRef = useRef<string | null>(null);

  /** 启动 grill check 流程：创建 session → 首次 check */
  const startGuide = useCallback(async () => {
    setState(INITIAL_STATE);
    try {
      const session = await api.createAgentSession({});
      sessionIdRef.current = session.session_id;
      const result = await api.grillCheck(session.session_id, { taskType: "registration", intent: "我想创作短剧" });
      applyResult(result);
    } catch (reason) {
      setState((s) => ({ ...s, phase: "error", error: errorMessage(reason) }));
    }
  }, []);

  /** 根据 grill check/absorb 结果切换 UI 状态 */
  function applyResult(result: GrillCheckResult): void {
    if (result.action === "execute") {
      setState((s) => ({ ...s, phase: "done" }));
      notify("偏好设置完成，欢迎加入！", "success");
      navigate("/projects", { replace: true });
      return;
    }
    if (result.action === "clarify") {
      setState({ phase: "clarify", question: result.question, targetField: result.targetField, candidates: [], summary: "", collectedFields: [], error: "" });
      setAnswer("");
      return;
    }
    if (result.action === "offer_candidates") {
      setState({ phase: "candidates", question: "", targetField: result.targetField, candidates: result.candidates, summary: "", collectedFields: [], error: "" });
      return;
    }
    if (result.action === "pending_confirmation") {
      setState({ phase: "confirm", question: "", targetField: "", candidates: [], summary: result.summary, collectedFields: result.collectedFields, error: "" });
      return;
    }
    // 未知 action 兜底
    setState((s) => ({ ...s, phase: "done" }));
    navigate("/projects", { replace: true });
  }

  useEffect(() => {
    void startGuide();
  }, [startGuide]);

  /** 提交文本回答（clarify 阶段） */
  async function submitAnswer(): Promise<void> {
    const sessionId = sessionIdRef.current;
    if (!sessionId || !answer.trim()) return;
    setSubmitting(true);
    try {
      const result = await api.grillAbsorb(sessionId, {
        taskType: "registration",
        answer: answer.trim(),
        targetField: state.targetField,
      });
      applyResult(result.nextAction);
    } catch (reason) {
      setState((s) => ({ ...s, phase: "error", error: errorMessage(reason) }));
    } finally {
      setSubmitting(false);
    }
  }

  /** 选择候选值（offer_candidates 阶段） */
  async function selectCandidate(candidate: Candidate): Promise<void> {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    setSubmitting(true);
    try {
      const result = await api.grillAbsorb(sessionId, {
        taskType: "registration",
        answer: candidate.value,
        targetField: state.targetField,
      });
      applyResult(result.nextAction);
    } catch (reason) {
      setState((s) => ({ ...s, phase: "error", error: errorMessage(reason) }));
    } finally {
      setSubmitting(false);
    }
  }

  /** 跳过当前问题 */
  async function skipQuestion(): Promise<void> {
    // 跳过 = 提交空壳答案让 grill 推进到下一字段或 execute
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    setSubmitting(true);
    try {
      const result = await api.grillAbsorb(sessionId, {
        taskType: "registration",
        answer: "跳过",
        targetField: state.targetField,
      });
      applyResult(result.nextAction);
    } catch (reason) {
      setState((s) => ({ ...s, phase: "error", error: errorMessage(reason) }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-center justify-center gap-6 px-4 py-12">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-ink-1">欢迎，让我们了解你的偏好</h1>
        <p className="mt-2 text-sm text-ink-2">回答几个简单问题，帮助我们为你推荐更合适的短剧创作方案。</p>
      </div>

      {state.phase === "loading" && (
        <div className="flex flex-col items-center gap-3 text-ink-2">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span>正在准备偏好引导…</span>
        </div>
      )}

      {state.phase === "clarify" && (
        <div className="w-full rounded-xl border border-border-1 bg-surface-1 p-6 shadow-sm">
          <p className="mb-1 text-xs font-medium text-ink-3">{FIELD_LABELS[state.targetField] ?? state.targetField}</p>
          <p className="mb-4 text-lg text-ink-1">{state.question}</p>
          <textarea
            className="mb-4 w-full resize-none rounded-lg border border-border-1 bg-surface-well p-3 text-ink-1 outline-none focus:border-accent"
            rows={3}
            placeholder="在这里输入你的回答…"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            disabled={submitting}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitAnswer();
            }}
          />
          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={skipQuestion} disabled={submitting}>跳过</Button>
            <Button onClick={submitAnswer} disabled={submitting || !answer.trim()}>
              {submitting ? "提交中…" : "下一步"}
            </Button>
          </div>
        </div>
      )}

      {state.phase === "candidates" && (
        <div className="w-full space-y-3">
          <p className="text-center text-lg text-ink-1">{FIELD_LABELS[state.targetField] ? `选择你的${FIELD_LABELS[state.targetField]}` : "请选择"}</p>
          {state.candidates.map((c) => (
            <button
              key={c.value}
              type="button"
              disabled={submitting}
              onClick={() => selectCandidate(c)}
              className="flex w-full flex-col gap-1 rounded-xl border border-border-1 bg-surface-1 p-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-accent hover:shadow-sm disabled:opacity-50"
            >
              <span className="font-medium text-ink-1">{c.label}</span>
              {c.description && <span className="text-sm text-ink-2">{c.description}</span>}
            </button>
          ))}
          <div className="flex justify-center pt-2">
            <Button variant="ghost" onClick={skipQuestion} disabled={submitting}>跳过</Button>
          </div>
        </div>
      )}

      {state.phase === "confirm" && (
        <div className="w-full rounded-xl border border-border-1 bg-surface-1 p-6 shadow-sm">
          <p className="mb-4 whitespace-pre-line text-ink-1">{state.summary}</p>
          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => navigate("/projects", { replace: true })}>跳过</Button>
            <Button
              onClick={() => {
                setState((s) => ({ ...s, phase: "done" }));
                notify("偏好设置完成，欢迎加入！", "success");
                navigate("/projects", { replace: true });
              }}
            >
              确认并继续
            </Button>
          </div>
        </div>
      )}

      {state.phase === "error" && (
        <div className="w-full rounded-xl border border-border-1 bg-surface-1 p-6 text-center">
          <p className="mb-4 text-ink-1">{state.error}</p>
          <div className="flex justify-center gap-3">
            <Button variant="outline" onClick={() => navigate("/projects", { replace: true })}>先跳过</Button>
            <Button onClick={startGuide}>重试</Button>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => navigate("/projects", { replace: true })}>以后再说</Button>
      </div>
    </section>
  );
}

function errorMessage(reason: unknown): string {
  return businessErrorMessage(reason, "偏好引导出了点问题，请重试。");
}
