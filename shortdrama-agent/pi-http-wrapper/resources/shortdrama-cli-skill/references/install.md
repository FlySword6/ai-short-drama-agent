# 安装与更新

## 源码仓运行

该 skill 与 Python 项目 `zhongwen-shortdrama-cli` 同仓维护。进入包含 `pyproject.toml` 的仓库根目录：

```bash
uv sync
uv run shortdrama-cli --help
```

项目要求 Python 3.11+。`shortdrama-cli` 与 `shortdrama` 都指向同一个 Typer 应用，文档统一使用前者。

## GitHub Release 安装（推荐）

macOS 与 Linux 公开仓库一键安装：

```bash
curl -fsSL https://raw.githubusercontent.com/col-shortdrama/zhongwen-shortdrama-cli/main/scripts/install-shortdrama-cli.sh | sh
```

私有仓库需要已认证的 GitHub CLI：

```bash
gh auth login
gh api repos/col-shortdrama/zhongwen-shortdrama-cli/contents/scripts/install-shortdrama-cli.sh --jq .content | base64 --decode | sh
```

安装器从 GitHub Release 选择当前平台包，验证 SHA-256 后安装 CLI 和包内同版本 skill。指定版本使用 `SHORTDRAMA_VERSION=0.0.1-beta`。Windows 使用公开仓库时可运行：

```powershell
irm https://raw.githubusercontent.com/col-shortdrama/zhongwen-shortdrama-cli/main/scripts/install-shortdrama-cli.ps1 | iex
```

默认安装位置：

- CLI：`~/.shortdrama/bin/shortdrama-cli`
- Skill：`~/.agents/skills/shortdrama-cli`

## 源码开发安装

在可信的本地源码仓根目录执行 `uv sync`，并使用 `uv run shortdrama-cli`。源码开发不应覆盖 Release 安装的用户级命令。

不要从 `shortdrama-cli-go` 构建或复制同名二进制。用下列命令核对实际入口：

```bash
command -v shortdrama-cli
shortdrama-cli --version
```

## 开发验证

```bash
uv run pytest -q
```

只有 CLI 的 `--help` 与本 skill 不一致时才更新文档；不要凭 README 示例推断不存在的选项。
