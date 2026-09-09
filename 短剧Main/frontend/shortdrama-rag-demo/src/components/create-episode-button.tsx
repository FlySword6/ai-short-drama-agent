/* CreateEpisodeButton — 集的产生(PRD 生产章 v1.1「一之补」;UX 基线断头 R1 修复)
   0 集空态唯一 primary「建第一集」+ 有集后集切换位 ghost「+ 集」共用件:
   建集=生产域动作(容器先于内容),调 POST /projects/:id/episodes,成功回 onCreated
   由页面刷新 episodes/status 入常规动线;两处空态不再互相指路。 */
import { useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { api } from "../api";
import { businessErrorMessage } from "../error-copy";
import type { Episode } from "../types";
import { Button } from "./ui/button";

type Notify = (message: string, kind?: "info" | "success" | "error") => void;

export function CreateEpisodeButton({ projectId, nextNo, variant = "primary", label, notify, onCreated }: {
  projectId: string;
  nextNo: number;
  variant?: "primary" | "ghost";
  label?: string;
  notify: Notify;
  onCreated: (episode: Episode) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  async function create(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const episode = await api.createEpisode(projectId, { title: `第 ${nextNo} 集`, episode_no: nextNo });
      onCreated(episode);
    } catch (reason) {
      notify(businessErrorMessage(reason, "建集失败，请重试"), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button
      size="sm"
      variant={variant}
      icon={<Plus />}
      loading={busy}
      onClick={() => { void create(); }}
    >
      {label ?? "建第一集"}
    </Button>
  );
}
