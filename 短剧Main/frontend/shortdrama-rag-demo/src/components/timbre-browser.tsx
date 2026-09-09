/* ============================================================
   timbre-browser.tsx — 音频页·音色浏览(S44:接真音色词表)

   数据只来自 GET /api/v1/audio/voices(迁移 033 音色词表,后端
   DbVoiceCatalogProvider);S10 的 346 条 fixture 快照已完成占位使命,
   不再使用。
   试听 = 播放预渲染静态 URL(裁决 3):audition_url 为空的音色按钮置灰
   并说明原因,不做"点了没反应"的假按钮,也绝不按点击发 TTS 请求。
   ============================================================ */

import { ArrowClockwise, MagnifyingGlass, MusicNote, Pause, Play, Plus } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "./ui/cn";
import { Button } from "./ui/button";
import { Input, Skeleton } from "./ui/primitives";
import {
  fetchVoiceCatalog,
  matchesVoice,
  voiceCategories,
  type VoiceCatalogVoice,
} from "../voice-catalog";

/** 与 workbench 页 onSelect 的既有结构约定(speaker_id + 可选 name)。 */
export interface Timbre {
  speaker_id: string;
  name?: string;
}

const PAGE_SIZE = 30;
const DISABLED_AUDITION_TITLE = "试听音频尚未预渲染：等批量渲染授权后生成";

export function TimbreBrowser({ onSelect }: {
  /** 选为音色参考（写入参考清单「音频」组）。 */
  onSelect: (timbre: Timbre) => void;
}): React.JSX.Element {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "ready"; voices: VoiceCatalogVoice[]; reason?: string }
  >({ phase: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchVoiceCatalog()
      .then((result) => {
        if (cancelled) return;
        setState({ phase: "ready", voices: result.voices, ...(result.reason ? { reason: result.reason } : {}) });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ phase: "error", message: error instanceof Error ? error.message : "音色库加载失败" });
      });
    return () => { cancelled = true; };
  }, [reloadKey]);

  // 卸载或换源时停掉试听,不留游离声音。
  useEffect(() => () => {
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  const voices = state.phase === "ready" ? state.voices : [];
  const categories = useMemo(() => voiceCategories(voices), [voices]);
  const filtered = useMemo(
    () => voices.filter((voice) => matchesVoice(voice, query, category)),
    [voices, query, category],
  );
  const visible = filtered.slice(0, limit);
  const noneAudible = voices.length > 0 && voices.every((voice) => !voice.auditionUrl);

  function toggleAudition(voice: VoiceCatalogVoice): void {
    if (!voice.auditionUrl) return;
    setPlaybackError(null);
    if (playingId === voice.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(voice.auditionUrl);
    audio.onended = () => setPlayingId((current) => (current === voice.id ? null : current));
    audio.onerror = () => {
      setPlayingId(null);
      setPlaybackError(`${voice.displayName} 试听播放失败,请稍后重试`);
    };
    audioRef.current = audio;
    setPlayingId(voice.id);
    void audio.play().catch(() => {
      setPlayingId(null);
      setPlaybackError(`${voice.displayName} 试听播放失败,请稍后重试`);
    });
  }

  if (state.phase === "loading") {
    return <Skeleton className="h-[300px] w-full" aria-label="音色库加载中" />;
  }
  if (state.phase === "error") {
    return (
      <div className="flex flex-col items-start gap-2 rounded-md border border-border-1 bg-surface-2 px-3 py-3">
        <p className="text-xs text-ink-2">音色库加载失败:{state.message}</p>
        <Button size="sm" variant="outline" icon={<ArrowClockwise />} onClick={() => { setState({ phase: "loading" }); setReloadKey((value) => value + 1); }}>重试</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative">
          <MagnifyingGlass aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-4" />
          <Input
            className="w-56 pl-8"
            value={query}
            placeholder="搜音色（名称/语言/特点）"
            aria-label="搜索音色"
            onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); }}
          />
        </span>
        <span className="text-xs text-ink-2">{filtered.length} / {voices.length} 个音色</span>
      </div>
      {categories.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="音色分类">
          <button
            type="button"
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
              category === "" ? "border-accent bg-accent-subtle text-accent-text" : "border-border-1 bg-surface-1 text-ink-2 hover:border-border-2",
            )}
            aria-pressed={category === ""}
            onClick={() => { setCategory(""); setLimit(PAGE_SIZE); }}
          >全部</button>
          {categories.map((option) => (
            <button
              key={option}
              type="button"
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                category === option ? "border-accent bg-accent-subtle text-accent-text" : "border-border-1 bg-surface-1 text-ink-2 hover:border-border-2",
              )}
              aria-pressed={category === option}
              onClick={() => { setCategory(category === option ? "" : option); setLimit(PAGE_SIZE); }}
            >{option}</button>
          ))}
        </div>
      ) : null}
      {state.phase === "ready" && state.reason ? (
        <p className="rounded-sm border border-dashed border-border-1 bg-surface-2 px-2.5 py-1.5 text-[11px] text-ink-2">{state.reason}</p>
      ) : null}
      {noneAudible ? (
        <p className="rounded-sm border border-dashed border-border-1 bg-surface-2 px-2.5 py-1.5 text-[11px] text-ink-2">
          试听音频尚未预渲染：音色可正常浏览与选用,批量渲染授权后试听开放。
        </p>
      ) : null}
      {playbackError ? <p className="text-[11px] text-danger">{playbackError}</p> : null}
      {voices.length === 0 ? (
        <p className="text-xs text-ink-2">音色库暂无可选音色。</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-ink-2">没有匹配的音色,换个关键词或分类。</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {visible.map((voice) => (
            <li key={voice.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border-1 bg-surface-2 px-3 py-2">
              <MusicNote aria-hidden="true" className="size-4 shrink-0 text-ink-2" />
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-xs font-semibold text-ink-1">{voice.displayName}</strong>
                <span className="text-[11px] text-ink-2">
                  {[voice.gender, voice.language, voice.category].filter(Boolean).join(" · ") || "—"}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                icon={<Plus />}
                onClick={() => onSelect({ speaker_id: voice.id, ...(voice.displayName ? { name: voice.displayName } : {}) })}
              >选为音色参考</Button>
              {voice.auditionUrl ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={playingId === voice.id ? <Pause /> : <Play />}
                  aria-label={playingId === voice.id ? `停止试听 ${voice.displayName}` : `试听 ${voice.displayName}`}
                  onClick={() => toggleAudition(voice)}
                >{playingId === voice.id ? "停止" : "试听"}</Button>
              ) : (
                <Button size="sm" variant="ghost" icon={<Play />} disabled title={DISABLED_AUDITION_TITLE} aria-label={`试听 ${voice.displayName}（未预渲染）`}>试听</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {filtered.length > visible.length ? (
        <Button variant="outline" onClick={() => setLimit((value) => value + PAGE_SIZE)}>显示更多（还有 {filtered.length - visible.length} 个）</Button>
      ) : null}
      <p className="text-[11px] text-ink-4">音色来自音色词表（官方文档种子）;试听为预渲染静态音频,点击不产生合成调用。</p>
    </div>
  );
}
