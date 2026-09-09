"""Small CLI text localization helper."""

import os
from typing import Literal

Language = Literal["zh", "en"]

_language: Language = "en" if os.getenv("SHORTDRAMA_LANG", "").lower().startswith("en") else "zh"

MESSAGES: dict[str, dict[Language, str]] = {
    "root.help": {"zh": "短剧生产命令行工具。", "en": "Short drama production CLI."},
    "auth.help": {"zh": "登录、会话和账号摘要命令。", "en": "Login, session, and account commands."},
    "project.help": {"zh": "管理云端项目的命令。", "en": "Manage cloud projects."},
    "asset.help": {"zh": "上传、搜索和管理云端素材。", "en": "Upload, search, and manage cloud assets."},
    "script.help": {"zh": "导入、分析和编辑剧本分镜的云端命令。", "en": "Import, analyze, and edit script storyboards in the cloud."},
    "scene.help": {"zh": "查看和编辑云端分镜。", "en": "Inspect and edit cloud scenes."},
    "edit.help": {"zh": "提交云端图片编辑任务。", "en": "Submit cloud image-edit tasks."},
    "subtitle.help": {"zh": "字幕转写和导出命令。", "en": "Subtitle transcription and export commands."},
    "result.help": {"zh": "接受或重跑生成结果。", "en": "Accept or rerun generation results."},
    "task.help": {"zh": "查询和管理云端任务。", "en": "Inspect and manage cloud tasks."},
    "model.help": {"zh": "检索模型并查看模型 Schema。", "en": "Search models and inspect model schemas."},
    "render.help": {"zh": "提交云端合成和导出任务。", "en": "Submit cloud render and export tasks."},
    "doctor.help": {"zh": "检查和修复 CLI 环境。", "en": "Check and repair the CLI environment."},
    "config.help": {"zh": "查看和修改本地 CLI 配置。", "en": "Inspect and update local CLI config."},
    "breakdown.help": {"zh": "执行单项拆解任务。", "en": "Run individual breakdown tasks."},
    "create.help": {"zh": "通过业务服务端创建 AI 内容。", "en": "Create AI content through the business server."},
    "generate.help": {"zh": "生成图片或视频产物记录。", "en": "Generate image or video artifacts."},
    "pipeline.help": {"zh": "执行完整生产流水线。", "en": "Run full production pipelines."},
    "runs.help": {"zh": "通过后端 API 同步和查看运行记录。", "en": "Sync and inspect runs through the backend API."},
    "lang.option": {"zh": "显示语言：zh 或 en。也可设置 SHORTDRAMA_LANG。", "en": "Display language: zh or en. Also reads SHORTDRAMA_LANG."},
    "version.option": {"zh": "显示版本并退出。", "en": "Show the version and exit."},
    "wrote": {"zh": "已写入 {path}", "en": "Wrote {path}"},
    "pipeline.succeeded": {"zh": "流水线执行成功：{run_id}", "en": "Pipeline succeeded: {run_id}"},
    "provider.mock_only": {
        "zh": "第一阶段只初始化了 mock provider。",
        "en": "Only the mock provider is initialized in milestone 1.",
    },
    "runs.sync.out.help": {
        "zh": "包含 run-manifest.json 的运行输出目录。",
        "en": "Run output directory containing run-manifest.json.",
    },
    "runs.api_url.help": {
        "zh": "后端 API 地址。也会读取 SHORTDRAMA_API_URL。",
        "en": "Backend API URL. Also reads SHORTDRAMA_API_URL.",
    },
    "runs.token.help": {
        "zh": "API bearer token。也会读取 SHORTDRAMA_API_TOKEN。",
        "en": "API bearer token. Also reads SHORTDRAMA_API_TOKEN.",
    },
    "runs.synced": {"zh": "已同步运行记录 {run_id}：{status}", "en": "Synced run {run_id}: {status}"},
    "runs.status": {"zh": "运行记录 {run_id}：{status}", "en": "Run {run_id}: {status}"},
    "runs.api_url.required": {
        "zh": "必须提供 API 地址。请传入 --api-url 或设置 SHORTDRAMA_API_URL。",
        "en": "API URL is required. Pass --api-url or set SHORTDRAMA_API_URL.",
    },
    "runs.manifest.missing": {"zh": "找不到运行记录文件：{path}", "en": "Missing run manifest: {path}"},
    "endpoint.plaintext_warning": {
        "zh": "警告：环境 {name}（{api_base}）是明文 HTTP，凭据和数据将被明文传输。",
        "en": "Warning: environment {name} ({api_base}) uses plaintext HTTP; credentials and data are sent unencrypted.",
    },
    "endpoint.not_logged_in": {
        "zh": "当前环境还没有登录；请先执行 auth login，或用 SHORTDRAMA_API_TOKEN 注入 token。",
        "en": "Not logged in for the active environment; run auth login first or inject SHORTDRAMA_API_TOKEN.",
    },
    "endpoint.untrusted_environment": {
        "zh": "本地记录的环境 {environment} 不在当前发行版的受信清单里，请重新 auth login --env <环境名>。",
        "en": "The locally recorded environment {environment} is not in this release's trusted catalogue; log in again with auth login --env <environment-name>.",
    },
    "auth.env.help": {
        "zh": "目标环境：prod、test 或 dev。只接受环境名，不接受 URL。",
        "en": "Target environment: prod, test, or dev. Names only, never a URL.",
    },
    "auth.env.invalid": {
        "zh": "--env 只接受环境名（prod、test、dev），不接受 URL。",
        "en": "--env accepts only an environment name (prod, test, dev), not a URL.",
    },
    "auth.username.prompt": {
        "zh": "账号",
        "en": "Username",
    },
    "auth.password.prompt": {
        "zh": "密码",
        "en": "Password",
    },
    "client.api_base_must_be_site_root": {
        "zh": "站点根 URL 必须是不带路径的根地址，例如 https://shortdrama.example。",
        "en": "The site root URL must have no path, for example https://shortdrama.example.",
    },
    "path.empty_segment": {
        "zh": "API 路径段不能为空。",
        "en": "API path segments must not be empty.",
    },
    "shot.update.missing_fields": {
        "zh": "至少提供一个可更新字段。",
        "en": "Provide at least one editable field.",
    },
    "shot.delete.confirmation_required": {
        "zh": "删除镜头不可逆；请人工确认后提供 --i-mean-it。",
        "en": "Deleting a shot is irreversible; confirm manually with --i-mean-it.",
    },
}


def set_language(language: str | None) -> None:
    """Set display language for the current process."""

    global _language
    if language:
        _language = "en" if language.lower().startswith("en") else "zh"


def current_language() -> Language:
    """Return the active display language."""

    return _language


def t(key: str, **kwargs: object) -> str:
    """Translate a message key and format it with keyword arguments."""

    template = MESSAGES[key][current_language()]
    return template.format(**kwargs)
