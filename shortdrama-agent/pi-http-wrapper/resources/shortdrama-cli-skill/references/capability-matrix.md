# 能力矩阵

先确认目标环境和登录状态，再调用命令。后端地址由 shortdrama-cli 内置的受信端点清单决定：用 `--env` 或 `SHORTDRAMA_ENV` 选择环境名（prod/test/dev），不接受 URL。

| 命令组 | 当前真实业务 API | 当前不可用 |
|---|---|---|---|
| `auth` | login/status/refresh/info | — |
| `project` | create/list/info/update/archive | use/delete/export |
| `model` | `search`（支持 `--type` 与本地关键词筛选）、`get`（读取模型 Schema） | — |
| `script` | analyze/import/import-episodes/list/breakdown-assets | polish |
| `create` | image/video/audio | — |
| `task` | get/list/refresh | cancel/download |
| `runs` | sync/status 通过 runs API client | — |
| `asset` | `ingest`（提交 Seedance 素材入库）、`status`（查询/同步入库状态）、`search`（独立资产库的语义检索） | upload/classify/preview/replace/delete |
| `breakdown` / `generate` / `pipeline` / `scene` / `edit` / `result` / `render` / `subtitle` | — | 当前未接入真实业务 API |

## 状态判定

- `submitted`：已提交，不能宣称完成。
- `succeeded`：命令报告成功；仍需检查结果 URL 或本地文件是否存在。
- `failed` / `cancelled`：终态失败，不继续下载或验收。
- `dry_run_generate_image`：只验证请求体和预估积分，不产生内容；不能作为交付结果。

## 输出约定

Agent 自动化统一加 `--json`；`--format json` 与 `--json` 等价时优先用较短的 `--json`。解析以下常见字段：

- `status`
- `action`
- `project_id`
- `script_id`
- `task_id`
- `results[]`
- `result_url`
- `local_output`

字段缺失时不要猜测。先检查完整 JSON，再决定下一步。
