import { ArrowSquareOut, CheckCircle, DownloadSimple, ShieldCheck, TerminalWindow } from "@phosphor-icons/react";
import React from "react";

export const CLI_REPOSITORY = "col-shortdrama/zhongwen-shortdrama-cli";
export const CLI_RELEASES_URL = `https://github.com/${CLI_REPOSITORY}/releases`;
export const CLI_INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${CLI_REPOSITORY}/main/scripts/install-shortdrama-cli.sh`;
export const CLI_INSTALL_COMMAND = `gh api -H "Accept: application/vnd.github.raw+json" repos/${CLI_REPOSITORY}/contents/scripts/install-shortdrama-cli.sh | sh`;
export const CLI_WINDOWS_INSTALL_COMMAND = `gh api -H "Accept: application/vnd.github.raw+json" repos/${CLI_REPOSITORY}/contents/scripts/install-shortdrama-cli.ps1 | iex`;

const FEATURES = ["项目、剧本拆解与确认", "资产登记、检索与场级备戏", "生成估价、确认、提交与队列追踪", "交付清单、媒体与 CSV 下载"];
const SECURITY_RULES = [
  "生成必须依次估价、人工确认、提交；CLI 没有跳过确认的一键付费命令。",
  "生产数据只经业务服务端 API；CLI 不直连数据库、AgentKit 或模型供应商。",
  "令牌只从运行环境或安全配置读取，不写入命令、项目文件或运行记录。",
];

function InstallCommand({ label, command }: { label: string; command: string }): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border-1 bg-surface-2 p-4">
      <h2 className="text-sm font-semibold text-ink-1">{label}</h2>
      <code className="mt-3 block overflow-x-auto rounded-md bg-surface-well px-3 py-2 font-mono text-xs text-ink-1">{command}</code>
    </section>
  );
}

/** 独立 CLI 的发布入口；安装资产与 checksum 由其 GitHub Release 维护。 */
export function CliDownloadPage(): React.JSX.Element {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8 sm:px-8">
      <section className="rounded-xl border border-border-1 bg-surface-1 p-6 sm:p-8">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-text"><TerminalWindow aria-hidden="true" className="size-4" />shortdrama-cli</span>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-1">把短剧生产流程带到终端</h1>
            <p className="mt-3 text-sm leading-6 text-ink-2">独立 CLI 与网页共用同一套业务 API，可完成项目、剧本、资产、备戏、生成队列与交付操作。</p>
          </div>
          <a className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={CLI_RELEASES_URL} target="_blank" rel="noreferrer">
            <DownloadSimple aria-hidden="true" className="size-4" />查看 Releases<ArrowSquareOut aria-hidden="true" className="size-3.5" />
          </a>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-xl border border-border-1 bg-surface-1 p-5">
          <h2 className="text-base font-semibold text-ink-1">CLI 能做什么</h2>
          <ul className="mt-4 grid gap-3 p-0">
            {FEATURES.map((feature) => <li className="flex items-start gap-2 text-sm text-ink-2" key={feature}><CheckCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />{feature}</li>)}
          </ul>
        </section>
        <section className="rounded-xl border border-border-1 bg-surface-1 p-5">
          <h2 className="text-base font-semibold text-ink-1">支持的平台</h2>
          <p className="mt-3 text-sm leading-6 text-ink-2">GitHub Release 提供 macOS（x64 / arm64）、Linux（x64 / arm64）和 Windows（x64）安装包。安装器会选择对应平台资产并校验 SHA-256。</p>
        </section>
      </div>

      <section className="rounded-xl border border-warning/35 bg-warning/10 p-5" aria-labelledby="cli-safety-title">
        <h2 id="cli-safety-title" className="flex items-center gap-2 text-base font-semibold text-ink-1"><ShieldCheck aria-hidden="true" className="size-5 text-warning" />默认生产安全红线</h2>
        <ul className="mt-3 grid gap-2 p-0 text-sm leading-6 text-ink-2">
          {SECURITY_RULES.map((rule) => <li key={rule}>{rule}</li>)}
        </ul>
      </section>

      <section className="grid gap-4 lg:grid-cols-2" aria-label="安装命令">
        <InstallCommand label="macOS / Linux" command={CLI_INSTALL_COMMAND} />
        <InstallCommand label="Windows PowerShell" command={CLI_WINDOWS_INSTALL_COMMAND} />
      </section>

      <p className="text-xs leading-5 text-ink-3">先安装 GitHub CLI 并执行 <code>gh auth login</code>。安装脚本从 <a className="text-accent-text underline underline-offset-2" href={CLI_RELEASES_URL} target="_blank" rel="noreferrer">GitHub Releases</a> 选择当前平台资产并校验 SHA-256；此页面不填写或保存凭据。</p>
    </main>
  );
}
