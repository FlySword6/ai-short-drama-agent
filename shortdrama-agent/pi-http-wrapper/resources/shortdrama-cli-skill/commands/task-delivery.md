# 任务与交付

## 查询任务

真实 API 支持：

```bash
shortdrama-cli task get TASK_ID --json
shortdrama-cli task get TASK_ID --wait --json
shortdrama-cli task refresh TASK_ID --json
shortdrama-cli task list --limit 20 --offset 0 --json
```

真实 `task list` 当前不支持 `--project`/`--status` 服务端过滤。`task cancel` 与 `task download` 尚未接入真实业务 API，不要调用。

## 结果验收

`result accept` 与 `result rerun` 尚未接入真实业务 API，不要调用。

## 字幕与渲染

字幕和渲染命令尚未接入真实业务 API，不要调用。

只有返回的本地路径确实存在时才能给出可点击文件。
