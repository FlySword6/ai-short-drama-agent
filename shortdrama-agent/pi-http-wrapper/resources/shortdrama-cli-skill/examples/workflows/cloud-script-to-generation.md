# 云端：剧本到生成任务

```bash
set -euo pipefail

shortdrama-cli auth status --json

shortdrama-cli project create \
  --name "竖屏短剧试制" \
  --aspect-ratio 9:16 \
  --json

shortdrama-cli script analyze \
  --project PROJECT_ID \
  --file ./episode-001.md \
  --wait \
  --json

shortdrama-cli create image \
  --project PROJECT_ID \
  --scene-id SCENE_ID \
  --model "Seedream 5.0 Pro" \
  --variants 2 \
  --json
```

逐步读取上一条 JSON 中的真实 ID 后再执行下一条；不要把示例占位符原样提交。生成响应若为 `submitted`，进入轮询案例。
