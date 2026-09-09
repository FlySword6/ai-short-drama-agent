/**
 * 后端根地址在三种情况下给三种东西:
 *
 * - 有前端构建产物:伺服它(容器里的正常形态,也包括本机自己构建过一次的情况);
 * - 没有构建产物、且不是线上:给一页中文指引。干净 clone 里 dist 不进版本库,
 *   新人按文档跑完三步打开浏览器,原本只能看到一段给接口调用方的错误信封,
 *   不知道页面其实在前端开发服务器上;
 * - 没有构建产物、且是线上:什么都不给,照旧走 404 信封。线上缺构建产物是发布
 *   事故,让终端用户看见一页"去跑 npm run dev"比看见错误信封更糟
 *   (CONTRIBUTING 第三节 ④:开发过程的自述不进用户空间)。
 */

export type RootEntryMode = "frontend" | "guide" | "api-only";

export function resolveRootEntryMode(input: {
  frontendAvailable: boolean;
  appEnvironment: string;
}): RootEntryMode {
  if (input.frontendAvailable) return "frontend";
  return input.appEnvironment === "production" ? "api-only" : "guide";
}

/**
 * 指引页不写死后端端口,只说"当前这个地址"——本机改了 PORT 也不会指错。
 * 前端开发服务器的 5173 是 2026-08-03 定的端口约定,写死是有意的。
 */
export const localEntryGuideHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>本机后端已启动</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 48px 24px;
    font: 16px/1.75 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  main { max-width: 44rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.4; margin: 0 0 8px; }
  h2 { font-size: 1.05rem; margin: 32px 0 8px; }
  p { margin: 8px 0; }
  pre {
    margin: 8px 0;
    padding: 12px 16px;
    overflow-x: auto;
    border-radius: 8px;
    background: rgba(127, 127, 127, 0.14);
  }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
  .foot { margin-top: 32px; font-size: 0.9rem; opacity: 0.75; }
</style>
</head>
<body>
<main>
  <h1>后端已经跑起来了,页面不在这个地址</h1>
  <p>当前这个地址只提供接口。界面(包括登录页)由前端开发服务器提供,默认在
    <a href="http://localhost:5173">http://localhost:5173</a>。</p>

  <h2>想看页面:另开一个终端</h2>
  <pre><code>cd frontend/shortdrama-rag-demo
npm run dev</code></pre>
  <p>然后打开 <a href="http://localhost:5173">http://localhost:5173</a>。它会把接口请求转发到当前这个地址,
    登录用户名 <code>admin</code>,密码是仓库根目录 <code>.env</code> 里 <code>DEV_ADMIN_PASSWORD</code> 的值。</p>

  <h2>想让当前这个地址直接出页面</h2>
  <p>在仓库根目录构建一次前端,构建完刷新本页就能看到登录页:</p>
  <pre><code>npm run build:frontend</code></pre>
  <p>构建出来的是一份快照,改了前端源码它不会自己更新。要边改边看,还是用上面的 5173。</p>

  <p class="foot">接口文档在 <a href="/docs">/docs</a>,本地环境的完整说明见仓库里的
    <code>docs/dev/local-environment.md</code>。这一页只在本机开发时出现。</p>
</main>
</body>
</html>
`;
