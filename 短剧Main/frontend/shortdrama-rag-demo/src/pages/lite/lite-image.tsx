/* ============================================================
   lite-image.tsx — Lite 图片组件（#184）：精简版图片统一走站内下载路径渲染。

   口径（issue #184，2026-08-09 走查）：media 对象同时有存储直链与站内下载路径
   两个地址；存储直链在限制外网直连的网络环境下整片挂掉，站内路径不受影响——
   精简版图片一律渲染 /api/v1/media/:id/download（media_results 行 id），不用
   存储直链。后端只认 Authorization 头（http/authenticate.ts），<img> 裸引用
   带不上登录态，故经 api.fetchMediaBlob 取字节 → objectURL 渲染，卸载/换图回收。
   demo fixture 的 data:/https: 直传地址原样渲染，不取字节。
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { ImageSquare } from "@phosphor-icons/react";
import { api } from "../../api";
import { cn } from "../../components/ui/cn";

/** media_results 行 id → 站内下载路径（delivery/routes.ts 只认 media_results 行 id）。 */
export function liteImageSrc(mediaId: string): string {
  return `/api/v1/media/${encodeURIComponent(mediaId)}/download`;
}

/** 展示地址：真栈恒走站内下载路径（#184）；demo 离线演示用 fixture 自带的占位图地址。 */
export function liteImageDisplaySrc(item: { id: string; storage_url?: string | null }, demoMode: boolean): string {
  return demoMode ? (item.storage_url ?? "") : liteImageSrc(item.id);
}

/** 站内下载路径的形状（/api/v1/media/<id>/download）；其它地址（data:/https:）直渲。 */
const STATION_SRC_PATTERN = /^\/api\/v1\/media\/([^/]+)\/download$/;

export function LiteImage({ src, alt, className }: { src: string; alt: string; className?: string }): React.JSX.Element {
  const stationMatch = STATION_SRC_PATTERN.exec(src);
  const stationMediaId = stationMatch?.[1] ? decodeURIComponent(stationMatch[1]) : null;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [nearViewport, setNearViewport] = useState(false);
  const placeholderRef = useRef<HTMLSpanElement | null>(null);

  /* 站内路径要带登录态,只能走 JS 取字节,<img loading="lazy"> 那条原生懒加载在这里
     不生效——不自己判可见性,一个几十镜的项目挂载瞬间就会打出上百个并发鉴权请求。
     没有 IntersectionObserver 的环境(测试里的 jsdom)直接放行,行为与改造前一致。 */
  useEffect(() => {
    if (stationMediaId === null || nearViewport) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const node = placeholderRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNearViewport(true);
    }, { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [stationMediaId, nearViewport]);

  useEffect(() => {
    if (stationMediaId === null || !nearViewport) return;
    let alive = true;
    let created: string | null = null;
    setObjectUrl(null);
    setFailed(false);
    api.fetchMediaBlob(stationMediaId)
      .then((blob) => {
        if (!alive) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => {
        /* 加载失败不放大：原位留占位（title 说人话），列表其余图不连坐。 */
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [stationMediaId, nearViewport]);

  if (stationMediaId === null) return <img src={src} alt={alt} className={className} loading="lazy" />;
  if (objectUrl) return <img src={objectUrl} alt={alt} className={className} loading="lazy" />;
  return (
    <span
      ref={placeholderRef}
      role="img"
      aria-label={alt}
      title={failed ? "图片加载失败，请刷新页面重试" : "图片加载中…"}
      className={cn("flex items-center justify-center", failed ? "" : "animate-pulse", className)}
    >
      {failed ? <ImageSquare aria-hidden="true" className="size-6 text-ink-4" /> : null}
    </span>
  );
}
