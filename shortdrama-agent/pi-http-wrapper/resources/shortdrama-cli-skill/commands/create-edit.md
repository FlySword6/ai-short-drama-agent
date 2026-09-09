# 生成与编辑

## 单张图片

先查询启用的图片模型，将返回的 `displayName`、`model` 和 `modelType` 展示给用户，并等待用户选择：

```bash
shortdrama-cli model search \
  --type image \
  --json
```

`create image` 必须提供 `--project`，且 `--scene-id`、`--prompt`、`--prompt-file` 三选一：

```bash
shortdrama-cli create image \
  --project PROJECT_ID \
  --prompt-file ./shot-prompt.txt \
  --model "Seedream 5.0 Pro" \
  --reference-asset ASSET_ID \
  --reference-weight 0.7 \
  --aspect-ratio 9:16 \
  --variants 2 \
  --timeout 1200 \
  --wait \
  --json
```

约束：

- `--size` 与 `--resolution` 不能同时提供；
- `--reference-weight` 必须在 0 到 1；
- `--accept` 需要 scene 绑定；
- `--model` 用户未指定模型时，默认为 `Seedream 5.0 Pro`；
- 生成和编辑命令的 `--model` 必须使用 `/models` 返回项的 `displayName`，也就是 CLI 输出里的 `modelName`；如果只有 `model` 标识，先通过 `model search` 查到对应 `modelName`，不要直接把 `model` 标识填给 `--model`；
- `--timeout` 控制创建请求的 HTTP 超时，默认 600 秒；`--wait` 的任务轮询独立处理；
- 先估算请求时用 `--dry-run`，它不生成内容。

如果真实响应中的 `model_used`/`model_selected`，且生成成功并返回图片 URL，先把图片交给用户并询问是否提交素材库。只有用户明确确认后，才执行：

```bash
shortdrama-cli asset ingest \
  --url IMAGE_RESULT_URL \
  --type image \
  --wait \
  --json
```

入库是异步审核：`active` 才表示通过；`submitting`/`processing` 表示处理中，`failed` 表示失败。没有真实图片 URL 时不得自动入库。

## 生图回报规范

`create image` 每次成功后，回报固定包含两项：

1. 该分镜使用的**提示词（prompt）原文**——从 `--prompt` 参数或 `--prompt-file` 文件内容提取；
2. 生成的**图片本地路径**——下载 `result_url` 到本地工作目录。

格式：分镜 `<scene_id>`：提示词「原文」｜图片：`<本地路径>`
不需要额外的落盘、映射表或数据契约。

## 视频与音频

生视频前同样先查询启用的视频模型并让用户选择：

```bash
shortdrama-cli model search \
  --type video \
  --json
```

如果用户已明确给出 `model`，仍需用列表验证它属于 `video` 且当前启用。列表为空或键不存在时停止生成。

用户直接上传图片、音频或视频作为图生视频参考时，先确认是否入素材库。只有用户明确要求查询、搜索或检索资产候选时，才调用 `asset search`；不能因提示词出现角色名、场景名或道具名而自动检索。图生视频当前只能直接使用首帧图片，所以最终要把用户选定的图片素材作为 `--image`；音频和视频素材只能作为上下文补充，不要硬塞进首帧输入。查不到真实资产时，必须回问用户，不要伪造命中结果。

如果这份参考素材已可作为 HTTPS 素材 URL 使用，就先走 `asset ingest`，并等待 `status=active` 再继续后续 `create video`。

```bash
shortdrama-cli create video \
  --project PROJECT_ID \
  --scene-id SCENE_ID \
  --image IMAGE_URL \
  --model "Seedance 2.0 VIP" \
  --prompt "用户原始要求" \
  --duration 5 \
  --json

shortdrama-cli create audio \
  --scene-id SCENE_ID \
  --text "需要朗读的原始台词" \
  --model "音频模型展示名" \
  --voice-id VOICE_ID \
  --json
```

批量 `images`、`videos`、`audios` 当前尚未接入真实业务 API，不要调用。

## 图片编辑

`edit image` 尚未接入真实业务 API，不要调用。需要参考图时，先使用业务服务端已有的 URL/asset ID，或通过 `asset ingest` 入库。后续接真实 API 时，`--model` 同样使用 `/models` 返回项的 `displayName`/`modelName`。
