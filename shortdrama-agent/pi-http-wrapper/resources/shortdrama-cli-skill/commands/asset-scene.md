# 素材与分镜

本页只提供已接入真实 API 的 Seedance 素材入库和资产语义检索命令。其余素材和分镜命令尚未接入真实 API，不要调用。

## 素材

将已有公网 HTTPS 素材提交到 Seedance 素材库：

```bash
shortdrama-cli asset ingest \
  --url "https://cdn.example.com/characters/hero.png" \
  --name "女主正面" \
  --type image \
  --json
```

接口是异步的。需要等待审核结果时追加 `--wait`：

```bash
shortdrama-cli asset ingest \
  --url "https://cdn.example.com/characters/hero.png" --type image --wait --json
```

不等待时保存响应中的 `task_id`，之后查询：

```bash
shortdrama-cli asset status TASK_ID --json
```

`submitting`/`processing` 不代表素材已审核通过；只有 `active` 才表示入库审核通过，`failed` 表示失败。

### 资产语义检索

只有用户明确提出“查询、搜索、检索、查找已有资产”或要求给出资产候选时，才调用独立资产库服务；它不是主业务 API 的 `--api-base`：

```bash
shortdrama-cli asset search \
  --asset-api-base "$SHORTDRAMA_ASSET_API_BASE" \
  --query "红衣古装女主，全身正面" \
  --limit 10 \
  --json
```

默认资产库地址为 `http://124.174.8.150:8000/api/v1`，可由
`--asset-api-base` 或 `SHORTDRAMA_ASSET_API_BASE` 覆盖。响应中的 `items[]`
按相关度排序，只包含稳定的 `asset_id`、`score`、资产描述和 `source_file_url`；CLI
不会输出服务端检索调试信息、元数据或本地文件路径。WorkBuddy 展示候选时，直接用返回的
HTTPS `source_file_url` 输出内联图片（例如 `![资产名称](https://cdn.example.com/asset.png)`，将
示例 URL 替换为真实 `source_file_url`）；不要下载缓存、使用 `Read`、调用 `present_files` 或输出文件卡片。

检索结果为候选，不等于已选中或已获审核。向用户展示候选的 `asset_id`、名称、类型、相关度和
图片 URL 后，等待用户明确选择；零命中时如实报告资产缺口，不编造或自动入库。创建、导入、入库、
生成，或仅出现角色/场景/道具名称，都不是检索触发条件；用户只说“复用”但未要求查询时，先询问是否
需要搜索候选。

当用户直接上传图片、音频或视频并要拿去图生视频时，流程应当是：

1. 先确认用户是否同意把参考素材入素材库；
2. 只有用户明确要求查询候选时，才用 `asset search --query` 做语义检索；查不到真实资产时必须回问用户，不要伪造命中结果；
3. 同意后，若参考素材已可作为 HTTPS 素材 URL 使用，再调用 `asset ingest`，并指定对应的 `--type image|audio|video`；
4. 等到 `status` 变成 `active`；
5. 再把命中的图片素材用于后续 `create video`；音频和视频素材只作为上下文补充。

`asset upload`、`classify`、`preview`、`replace` 和 `delete` 尚未接入真实 API，WorkBuddy 不得调用。
本版本要提交资产时，必须取得真实的 HTTPS URL 后使用 `asset ingest`；用户只提供本地文件而没有可访问 URL 时，说明当前无法自动提交，不能用 `asset upload` 代替。

## 分镜

当前 CLI 尚未提供真实分镜 CRUD API；需要分镜操作时停止并报告能力缺口。
