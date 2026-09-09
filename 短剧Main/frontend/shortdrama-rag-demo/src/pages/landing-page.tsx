/* ============================================================
   landing-page.tsx — 获客落地页(批次一卡 2,走法 a:新 /landing)

   原型基准:Figma P-01a(hero 宋体三行「资产更厚/控制更全/抽卡更准」+副文案+
   monitor 拼贴+四要点卡 01-04 含 Agent 同台+footer)。
   工程口径:无剧照资产不放假图(S9-16c),monitor 格=panel 底+竖排剧名缺省态+
   mono 时间码+一格生成中呼吸;「进入片场/登录进片场/登录」=页内弹层
   (P-01a→P-01b 原型语义:overlay 浮在落地页上,不跳路由;卡片=LoginCard
   单份复用,任务纯粹不放品牌位)。V-47:整页登录退役,/login 换乘到本页;
   URL 带 redirect 时挂载即自动展开登录卡(登出/401/未登录深链三条路同落点),
   登录成功 safeRedirectTarget 回原位。
   ============================================================ */
import * as React from "react";
import { ArrowRight, X } from "@phosphor-icons/react";
import { BrandLockup } from "../components/ui/brand-mark";
import { Button } from "../components/ui/button";
import { safeRedirectTarget } from "../routing";
import { LoginCard, type WecomCallback } from "./login-card";
import type { User as UserType } from "../types";

const SERIF = { fontFamily: '"Noto Serif SC", "Songti SC", "STSong", serif' } as const;

/** monitor 格缺省态:panel 底+竖排剧名+mono 时间码(书封缺省态工程版)。
    登录页(P-01b)背景拼贴复用同一格,与落地页视觉同源。 */
export function MonitorCell({ time, drama, generating = false, image }: { time: string; drama?: string; generating?: boolean; image?: string }) {
  return (
    <div className="relative flex aspect-video flex-col items-center justify-center overflow-hidden rounded-xl bg-tk-panel">
      {image ? <img className="absolute inset-0 h-full w-full object-cover" src={image} alt={drama ? `${drama} 剧照` : "剧照"} loading="lazy" /> : null}
      {generating ? (
        <>
          <span className="relative text-xs text-tk-ink-2">生成中</span>
          <span className="relative mt-2 h-0.5 w-10 animate-pulse rounded-full bg-tk-accent" />
        </>
      ) : !image && drama ? (
        <span className="text-sm leading-6 text-tk-ink-3" style={{ ...SERIF, writingMode: "vertical-rl" }}>{drama}</span>
      ) : null}
      <span className="absolute bottom-2 right-3 font-tkmono text-[10px] text-tk-ink-3">{time}</span>
    </div>
  );
}

const TALKING_POINTS: ReadonlyArray<{ no: string; title: string; desc: string }> = [
  { no: "01", title: "更丰富更高质量的资产库", desc: "角色、场景、道具入库即资产;肖像、定妆、三视图一套齐,被引用越多越准" },
  { no: "02", title: "更全面的参考控制", desc: "身份、场景、道具、光影、运镜、音频,一次备包,整段共用,换镜不重备" },
  { no: "03", title: "更高的抽卡成功率", desc: "参考喂得全,废片自然少;先出样片再正片,钱花在刀刃上" },
  { no: "04", title: "Agent 同台", desc: "编剧、美术、导演的 Agent 各司其职;你能点的,Agent 都能调——API 全开放" },
];

export function LandingPage({
  onAuthenticated,
  wecomCallback,
  onWecomCallbackHandled,
}: {
  onAuthenticated: (user: UserType) => void;
  wecomCallback: WecomCallback | null;
  onWecomCallbackHandled: () => void;
}): React.JSX.Element {
  /* P-01a→P-01b:三入口都开页内登录弹层,不跳路由(DC 2026-08-02 裁定)。
     V-47:URL 带 redirect(登出/401/未登录深链换乘来)时挂载即自动展开登录卡。 */
  const [loginOpen, setLoginOpen] = React.useState(() => (
    Boolean(wecomCallback) || Boolean(safeRedirectTarget(window.location.search))
  ));
  const [wecomExchangePending, setWecomExchangePending] = React.useState(
    wecomCallback?.kind === "result",
  );
  React.useEffect(() => {
    if (!loginOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !wecomExchangePending) setLoginOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [loginOpen, wecomExchangePending]);

  return (
    <main className="min-h-dvh bg-tk-bg text-tk-ink-1">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <BrandLockup size="md" />
        <Button variant="outline" onClick={() => setLoginOpen(true)}>登录</Button>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-10 px-6 pb-16 pt-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex flex-col items-start gap-6">
          <h1 className="text-5xl font-semibold leading-tight tracking-tight" style={SERIF}>
            资产更厚<br />控制更全<br />抽卡更准
          </h1>
          <p className="max-w-md text-sm leading-6 text-tk-ink-2">
            中文在线 AI 短剧生产平台。<br />
            角色、场景、道具入库即资产,越用越准;参考控制包一次备齐,整段生成;人和 Agent 同台开拍,API 全开放。
          </p>
          <div className="flex items-center gap-3">
            <Button variant="primary" icon={<ArrowRight />} onClick={() => setLoginOpen(true)}>进入片场</Button>
            {/* F05：只读演示不存在就不许空愿——第二入口与登录同义,文案说真话。 */}
            <Button variant="outline" onClick={() => setLoginOpen(true)}>登录进片场</Button>
          </div>
        </div>

        <div className="rounded-2xl bg-tk-panel p-4" aria-label="片场监视器拼贴">
          <div className="grid grid-cols-3 gap-3">
            <MonitorCell time="00:02" drama="雾岛来信" image="/demo-media/still-duel.png" />
            <MonitorCell time="00:04" image="/demo-media/poster-wudao.png" />
            <MonitorCell time="00:06" drama="雾岛来信" image="/demo-media/still-chase.png" />
            <MonitorCell time="00:08" image="/demo-media/poster-shanhai.png" />
            <MonitorCell time="" generating />
            <MonitorCell time="00:11" drama="雾岛来信" image="/demo-media/poster-changjie.png" />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-16">
        <div className="grid gap-6 md:grid-cols-4">
          {TALKING_POINTS.map((point) => (
            <article key={point.no} className="flex flex-col gap-2">
              <span className="font-tkmono text-xs text-tk-ink-3">{point.no}</span>
              <h2 className="text-base font-semibold text-tk-ink-1">{point.title}</h2>
              <p className="text-xs leading-5 text-tk-ink-2">{point.desc}</p>
            </article>
          ))}
        </div>
      </section>

      <footer className="mx-auto max-w-6xl px-6 pb-8">
        <p className="text-xs text-tk-ink-3">© 中文在线 · 邀请内测中</p>
      </footer>

      {loginOpen ? (
        <div
          className="landing-login-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="登录"
          onClick={(event) => {
            if (event.target === event.currentTarget && !wecomExchangePending) setLoginOpen(false);
          }}
        >
          <div className="landing-login-card">
            <button
              type="button"
              className="landing-login-close"
              aria-label="关闭登录"
              disabled={wecomExchangePending}
              onClick={() => { if (!wecomExchangePending) setLoginOpen(false); }}
            >
              <X aria-hidden="true" />
            </button>
            <LoginCard
              onAuthenticated={onAuthenticated}
              wecomCallback={wecomCallback}
              onWecomCallbackHandled={onWecomCallbackHandled}
              onWecomExchangePendingChange={setWecomExchangePending}
            />
          </div>
        </div>
      ) : null}
    </main>
  );
}
