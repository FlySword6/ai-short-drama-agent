/**
 * CandidateCard — Grill Engine offer_candidates 路径渲染的候选卡片。
 *
 * 后端 card_delta 事件发来 2~4 个候选（Candidate[]），每个候选有：
 * - label：粗体短标签（如「写实电影感」）
 * - description：灰色小字说明
 * - value：机器可读值（前端不直接用，提交 label）
 *
 * 交互：
 * - 点击某个候选 → onPick(label) → 提交 label 作为用户消息
 * - 「其他」输入框 → 用户自定义输入 → onCustomSubmit(text)
 * - 可关闭（onDismiss）
 *
 * 样式对齐现有对话界面风格（glass-panel / border-border-1 / bg-surface-2）。
 */
import * as React from "react";
import { X, PaperPlaneTilt } from "@phosphor-icons/react";
import type { Candidate } from "../types";
import { cn } from "./ui/cn";
import { Button } from "./ui/button";

export interface CandidateCardProps {
  candidates: Candidate[];
  /** true 时禁用所有交互（助手正在响应）。 */
  disabled?: boolean;
  /** 用户选了某个候选——提交 label 作为用户消息。 */
  onPick: (label: string) => void;
  /** 用户在「其他」输入框提交了自定义文本。 */
  onCustomSubmit: (text: string) => void;
  /** 用户点了关闭按钮。 */
  onDismiss: () => void;
}

export function CandidateCard({ candidates, disabled, onPick, onCustomSubmit, onDismiss }: CandidateCardProps): React.JSX.Element {
  const [customText, setCustomText] = React.useState("");
  const [showCustom, setShowCustom] = React.useState(false);

  const handleCustomSubmit = () => {
    const trimmed = customText.trim();
    if (!trimmed || disabled) return;
    onCustomSubmit(trimmed);
  };

  return (
    <div className="mt-3 rounded-lg border border-border-1 bg-surface-2 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-agent-text">请选择一个选项</span>
        <button
          type="button"
          className="text-ink-3 hover:text-ink-1 disabled:pointer-events-none"
          disabled={disabled}
          onClick={onDismiss}
          aria-label="关闭候选卡片"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {candidates.map((candidate) => (
          <button
            key={candidate.value || candidate.label}
            type="button"
            disabled={disabled}
            onClick={() => onPick(candidate.label)}
            className={cn(
              "group flex flex-col gap-0.5 rounded-md border border-border-1 bg-surface-1 px-3 py-2 text-left transition-all duration-150 ease-out-quart",
              "hover:border-accent/50 hover:bg-accent/5 active:scale-[0.98]",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <span className="text-sm font-semibold text-ink-1">{candidate.label}</span>
            {candidate.description ? (
              <span className="text-xs text-ink-3">{candidate.description}</span>
            ) : null}
          </button>
        ))}
      </div>

      {/* 其他输入框（可折叠） */}
      {showCustom ? (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            className="min-w-0 flex-1 rounded-md border border-border-1 bg-surface-1 px-3 py-1.5 text-sm text-ink-1 outline-none focus:border-accent/50"
            placeholder="输入自定义内容…"
            value={customText}
            disabled={disabled}
            autoFocus
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleCustomSubmit();
              }
            }}
          />
          <Button
            variant="primary"
            size="sm"
            icon={<PaperPlaneTilt />}
            loading={disabled}
            disabled={!customText.trim()}
            onClick={handleCustomSubmit}
          >
            发送
          </Button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setShowCustom(true)}
          className="mt-2 text-xs text-accent-text underline-offset-4 hover:underline disabled:pointer-events-none"
        >
          其他…
        </button>
      )}
    </div>
  );
}
