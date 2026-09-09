import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CLI_INSTALL_COMMAND,
  CLI_INSTALL_SCRIPT_URL,
  CLI_RELEASES_URL,
  CliDownloadPage,
} from "./pages/cli-download-page";

test("CLI 下载页：公开安装命令与 Releases 指向独立 CLI 仓，不携带凭据", () => {
  assert.equal(CLI_RELEASES_URL, "https://github.com/col-shortdrama/zhongwen-shortdrama-cli/releases");
  assert.equal(CLI_INSTALL_SCRIPT_URL, "https://raw.githubusercontent.com/col-shortdrama/zhongwen-shortdrama-cli/main/scripts/install-shortdrama-cli.sh");
  assert.ok(CLI_INSTALL_COMMAND.startsWith("gh api "));
  assert.ok(CLI_INSTALL_COMMAND.includes("application/vnd.github.raw+json"));
  assert.ok(!/token|password|secret/i.test(CLI_INSTALL_COMMAND));
});

test("CLI 下载页：展示平台、生产安全红线与安装命令", () => {
  const html = renderToStaticMarkup(React.createElement(CliDownloadPage));
  assert.ok(html.includes("支持的平台"));
  assert.ok(html.includes("默认生产安全红线"));
  assert.ok(html.includes("macOS / Linux"));
  assert.ok(html.includes("Windows PowerShell"));
  assert.ok(html.includes(CLI_INSTALL_COMMAND.replaceAll('"', "&quot;")));
});

test("CLI 下载页：路由接入应用", () => {
  const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
  assert.ok(appSource.includes('pathname === "/cli"'));
  assert.ok(appSource.includes("<CliDownloadPage />"));
});
