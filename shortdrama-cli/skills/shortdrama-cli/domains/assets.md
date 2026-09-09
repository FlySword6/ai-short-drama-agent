# 资产

先 `asset search` 或 `asset semantic`，再 `asset get`。查询项目资产时必须同时使用 `asset search --scope project --project-id ID`。登记前读取 `asset registration-schema`；把用户确认后的同版本登记表作为 `--registration-json` 传给 `asset register --file PATH`，不得自行补造置信度、质量分或系统管理字段。完成状态用 `asset register-status` 查询。项目关联必须显式 `asset add-to-project`；解绑是 `asset remove-from-project --project-id ID --ref-id REF`，不可逆，先向用户复述资产与后果再传 `--i-mean-it`。

## 变体与媒体版本

**变体（variant）是同一个角色或场景的另一套形态**——「3 岁闪回」「18 岁主线」「狼形」；带名称、类别（`--kind`）、使用场景（`--usage-context`）和适用集数（`--episode-no`）。**媒体版本（version）是同一形态下的不同张图**。不要把两者搞混：新形态建变体，同一形态再添一张图追加媒体版本，三张图也仍然是一个资产。

读取是 `asset variant-list` / `asset version-list`；变体写入是 `asset variant-create`，媒体版本写入是 `asset version-add`。`asset version-set-primary` 设主媒体版本，引用该资产的地方默认拿到主版本那张图；它是人工裁决，先向用户复述资产与媒体再传 `--i-mean-it`。

## 给已有角色补一套变体

1. `asset get --asset-id ID` 确认角色资产本体存在，拿资产 id。
2. `asset variant-create --asset-id ID --name "18 岁主线" --kind age --usage-context "主线剧情" --episode-no 1 --episode-no 2` 建变体，记下返回的变体 id。
3. 抽卡产出图后入库：`asset version-add --asset-id ID --file 图.png --variant-id 变体id --title "正面主视角"` 把图追加为该变体名下的媒体版本；同一变体的多张图重复这一步。
4. 向用户复述资产与媒体后， `asset version-set-primary --asset-id ID --media-id 媒体id --i-mean-it` 设主版本；`asset version-add` 传 `--is-primary` 也能在追加时直接设主。
5. `asset variant-list --asset-id ID` 与 `asset version-list --asset-id ID` 回读核对。

## 已知坑：媒体类别字段是自由取值

媒体行上的类别字段（`media_kind`）是后端自由取值，现有 13 个值在用，后端从不保证它等于某个固定词。**不要在判断「这是不是图」时对类别字段做等值比较**（如 `=== "image"`）：前端就是这么踩的，结果明明有图的资产被判定成没有图。判断可按后端给出的可用性信号走，例如缩略图/访问地址字段是否非空，类别只作展示和透传。
