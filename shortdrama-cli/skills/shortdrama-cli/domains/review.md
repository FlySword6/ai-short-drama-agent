# 审核

媒体审核与设置镜头主版本是人工裁决，Agent 只能准备命令和展示服务端事实，不能自行作出判断。

- 通过：用户核对项目和媒体后，执行 `review decide --project-id ID --media-result-id ID --action approve --i-mean-it`。
- 拒绝：必须使用用户确认的中文业务理由，执行 `review decide --project-id ID --media-result-id ID --action reject --rejection-reason 原因 --i-mean-it`。
- 设主版本：用户核对镜头、媒体及审核状态后，执行 `review set-primary --shot-id ID --media-id ID --i-mean-it`。

缺少 `--i-mean-it` 时命令必须停止。服务端拒绝未过审媒体成为主版本时，原样报告业务说明，不得改选其他媒体。
