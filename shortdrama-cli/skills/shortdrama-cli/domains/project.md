# 项目

读取项目和集：`project list`、`project get --project-id ID`、`project episode-list --project-id ID`、`project episode-get --episode-id ID`。写入前确认名称或标题，再用 `project create`、`project update`、`project episode-create`。

## 拆解拆错了怎么改

先用 `project shot-list --episode-id ID` 找到镜头，再用 `project shot-get --shot-id ID` 回读景别、机位运动、时长和视觉提示词。只改错项：`project shot-update --shot-id ID --framing ...`、`--camera-movement ...`、`--duration ...` 或 `--visual-prompt ...`；四项至少提供一项。不要为改字段重跑拆解。

多余镜头先向用户复述镜头 ID 与不可逆删除风险，只有用户明确确认后才能执行 `project shot-delete --shot-id ID --i-mean-it`。需要检查已有产物时用 `project shot-media-list --shot-id ID`；需要判断整集卡点时用 `project episode-production-status --episode-id ID`；需要读取可播放条目时用 `project episode-playback --episode-id ID`。

## 项目盘点与成员

盘点项目时，先 `project member-list --project-id ID` 看成员及项目角色；需派单时，用 `project member-directory --query <至少两个字符>` 取得目录返回的真实 `user_id`，再用 `project member-add` 或 `project member-update` 管理 `owner`、`editor`、`viewer`。抽卡师是业务称谓，不是系统角色，不能把它传给 `--role`。移除成员不可逆，先向用户复述该成员与后果，只有人工确认后执行 `project member-remove --i-mean-it`。

项目生成记录用 `generation project-list --project-id ID`，失败任务用 `generation failed-list`；项目花费汇总用 `project costs --group-by member|model|day`，消费明细用 `project consumption-records --project-id ID`。
