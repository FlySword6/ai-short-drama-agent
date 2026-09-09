# 剧本与云端流程

## 云端剧本

剧本形态不做自动判断，按用户指定方式处理：

- 「全集/多集」→ `script import-episodes`；它创建全部剧集记录，但不会自动拆解角色、场景、道具或分镜；
- 「单集/第 N 集」→ `script import --title "第 N 集" --episode-no N`（生产路径用 `script analyze`）；
- 「短篇/单篇」→ `script import`（不带 `--episode-no`）；
- 用户未指定 → 先问「这是全集、单集还是短篇？」，按回答执行。

执行后只回报返回的 `script_id` / `episodes[]`，不自行评判结果。

```bash
shortdrama-cli script import-episodes \
  --project PROJECT_ID \
  --title "完整剧本名称" \
  --file ./full-script.md \
  --json
```

只从返回的 `episodes[]` 回报已拆分剧集；完成后主动询问用户是否需要拆解指定剧集的角色、
场景和道具。用户指定剧集后，使用其返回的 `scriptId`：

```bash
shortdrama-cli script breakdown-assets \
  --script-id SCRIPT_ID \
  --timeout 1200 \
  --json
```

单集剧本须先确认所属剧本/项目名称和单集名称。先用 `project list` 找到项目，再用
`script list --project PROJECT_ID` 查询已有剧集；确认没有同名剧集后，用带名称和集数的
`script import` 创建该集：

```bash
shortdrama-cli script import \
  --project PROJECT_ID \
  --title "第 1 集" \
  --episode-no 1 \
  --file ./episode-001.md \
  --json
```

`script analyze` 读取 UTF-8 单集文本，通过 Main API 创建剧本，然后依次触发资产和分镜拆解：

```bash
shortdrama-cli script analyze \
  --project PROJECT_ID \
  --file ./episode.md \
  --language zh \
  --timeout 600 \
  --wait \
  --json
```

约束：
- `--timeout` 控制创建请求的 HTTP 超时，默认 600 秒；`--wait` 的任务轮询独立处理；

`script import` 只创建剧本，不做完整分析：

```bash
shortdrama-cli script import \
  --project PROJECT_ID \
  --file ./episode.md \
  --json
```

`script polish` 当前尚未接入真实业务 API，不要调用。

## 拆解结果展示与确认

`script analyze --wait` 返回后，不做任何「完整性」判断，直接把拆解结果原样展示给用户：

1. **角色**：逐条列出返回的 name 及全部已有字段值；
2. **场景**：逐条列出返回的 name 及全部已有字段值；
3. **道具**：逐条列出返回的 name 及全部已有字段值；
4. **分镜**：逐条列出返回的镜头描述。

然后询问用户：

- 拆解结果是否可用？
- 是否需要手动补充或修改某些条目？
- 确认无误后是否继续进入生图？

由用户决定是否充分，不由模型自行判断「缺失」或「不完整」。
用户确认前，不进入下一步。
