# 视觉资产搜索需求文档

> 状态:草稿 - 2026-08-25(前端 UI 设计补入于 2026-08-26)
> 来源:grilling 会话共识(后端链路 14 条 + 前端 UI 5 条,共 19 条决策),待产品负责人批准后转正为合同。
> 适用范围:资产库的图搜图、图文混搜、入库图片向量化三项能力,以及资产中心检索页的 UI 接入。

## 1. 背景与问题

当前资产搜索只支持**文本搜图**:用户输入文字 -> LLM 改写 -> embedding 文本 -> Milvus 查文本向量 -> PostgreSQL ilike 兜底。三个缺口:

1. **图搜图做不到** - 没有图片查询入口,无法按视觉相似度检索素材。
2. **图文混搜做不到** - 无法同时用文字+图片联合检索。
3. **入库图片未向量化** - Excel 批量入库和单图入库时,图片字节只做了 vision 描述(转成结构化文字),从未生成图片视觉向量。图片的视觉信息没有进入检索索引。

豆包多模态嵌入模型(DOUBAO_EMBEDDING_MODEL)本身支持文+图同空间嵌入,但代码里只走了文本路径。

## 2. 目标与非目标

### 目标

- **图搜图**:用户用一张图片(库里已有素材或外部上传)检索视觉相似的资产。
- **图文混搜**:用户同时提供文字和图片,系统做向量早融合后一次检索。
- **入库图片向量化**:新入库的图片(单图上传、Excel 批量入库)同步生成媒体级视觉向量。
- **检索页 UI 接入**:资产中心·检索页提供图搜双入口(搜索框上传、卡片"找相似"),有图有字自动混搜。

### 非目标

- **存量图片不回填视觉向量**。已入库的 asset_media 只有文本向量,不做一次性回填脚本。存量图的视觉搜索走文本兜底。
- **不引入批量 embedding 接口**。embedImage 只做单张,不做 embedMultimodal 批量。
- **不引入 pgvector 双写**。PostgreSQL 不存图片向量,只存文本兜底。
- **不改原 /api/v1/asset-search 端点契约**。文本搜索路径完全不动。
- **选资产抽屉与项目页的搜索框本轮不接 visual**。仅资产中心检索页;抽屉/项目页复用成本低,留后续单开卡(决策 19)。
- **visual 端点不加 tag 过滤参数**。图搜激活时前端置灰 Tag 框,不做前端内存过滤(决策 17)。

## 3. 架构决策记录

以下 19 条决策经 grilling 会话逐条确认(1-14 为 2026-08-25 后端链路,15-19 为 2026-08-26 前端 UI 增补):

| # | 决策点 | 选定 | 理由摘要 |
|---|--------|------|----------|
| 1 | 搜索目标 | 视觉相似(非语义匹配) | 短剧资产库核心痛点是"找长得像的素材",文字描述粒度撑不住 |
| 2 | 嵌入模型 | 单一多模态模型,文图同空间 | ep-20260630182837-rw8xw 走 /embeddings/multimodal,文图向量可线性组合 |
| 3 | 向量粒度 | 媒体级(每张图一个向量) | 一个角色正面/背影视觉差异大,聚合会抹掉多样性 |
| 4 | Milvus 集合 | 同一个集合 asset_entity_vectors_v2 | 同空间同集合 = 早融合一次查询即可跨模态召回 |
| 5 | 媒体向量内容 | 纯图嵌入(不含 caption) | 通道分离,查询时可调混合权重;不把文字烤死进图像向量 |
| 6 | 图文混搜融合 | 早融合(向量加权平均后一次查) | 同空间红利兑现,一次 Milvus 往返,alpha 参数覆盖三档 |
| 7 | 入库向量化时机 | 同步内联 | 跟现有文本向量同步模式对称,入库即可用,不引入异步基础设施 |
| 8 | 存量回填 | 不回填,只管新入库 | 回填脚本推迟到 Milvus 灾难重建时;存量走文本兜底 |
| 9 | 查询端点 | 新开 POST /api/v1/asset-search/visual | 原文本搜索端点不动;视觉+混搜集中在 visual 端点 |
| 9.1 | 混搜落地 | visual 端点带可选 query,服务端早融合 | 兑现 Q6 早融合决策,前端不调两次 |
| 10 | 图片字节入口 | image_media_id(TOS 拉)+ multipart 上传,二选一 | 库内找相似零字节传输;外部参考图也能搜 |
| 11 | EmbeddingClient 扩展 | 加 embedImage 方法 | 不引入批量接口,无预防性抽象 |
| 12 | VectorSyncService 扩展 | 加 syncMediaVisual 方法 | 与 syncEntity/syncVariant 并列第三方法 |
| 13 | 结果聚合 | 按 entity 聚合取最高分 | 返回粒度跟用户心智一致;附带返回命中的媒体信息 |
| 14 | PG 降级 | 降级成 caption 文本搜索 | 满足架构合同"Milvus 不可用时必须有 PG 降级路径",零新基础设施 |
| 15 | 前端入口 | 双入口:搜索框图片上传 + 卡片"找相似" | 外部参考图与库内找相似都是高频路径,共用同一 visual 端点,Q10 两种输入模式全部兑现 |
| 16 | 混搜触发与权重 | 有图有字自动混搜,前端不传 alpha(默认 0.5) | Q6 的 alpha 可调保留在 API 层;UI 不暴露权重控件,避免非技术用户负担 |
| 17 | 图搜与 Tag 筛选 | 图搜激活时 Tag 框置灰+提示原因 | visual 端点无 tag 参数;不做前端内存过滤,分页失真等于假功能 |
| 18 | 降级 UI 呈现 | 结果区顶部警告条,不阻断 | fallback_mode=caption_text 时告知"文字近似",可用性与不撒谎兼得 |
| 19 | 前端覆盖范围 | 仅资产中心·检索页 | 选资产抽屉/项目页搜索框后续单开卡,控制本轮验证面与 Lite 路径风险 |

## 4. 接口设计

### 4.1 视觉搜索端点

`POST /api/v1/asset-search/visual`

支持两种 content-type:

**JSON 模式(库内找相似)**:

```json
{
  "image_media_id": "<uuid>",
  "query": "可选,纯图搜时留空",
  "alpha": 0.6,
  "scope": "personal | common",
  "project_id": "可选 UUID",
  "page": 1,
  "page_size": 20
}
```

**Multipart 模式(外部图搜库)**:

multipart/form-data: file=<图片文件>, query=可选文本, alpha=可选权重

输入约束:

- 图片输入二选一:`image_media_id`(JSON)或 multipart 文件。至少传一个。
- `query` 可选。有 `query` 且有图片 = 图文混搜(早融合);只有图片 = 纯图搜;只有 `query` 不允许(走原 /asset-search)。
- `alpha`:0~1 浮点数,文本向量权重。`alpha=0` 纯图搜,`alpha=1` 纯文搜(但纯文应走原端点),默认 0.5。混搜时 `q = alpha * v_text + (1-alpha) * v_image`。
- `scope`、`project_id`、`page`、`page_size` 语义与 /asset-search 一致。

响应:

```json
{
  "ok": true,
  "data": {
    "items": [],
    "page": 1,
    "page_size": 20,
    "has_more": false,
    "diagnostics": {
      "status": "results | no_results",
      "semantic_available": true,
      "lexical_available": true,
      "fallback_mode": null,
      "relaxed_once": false
    }
  }
}
```

- `items` 返回实体级结果(与 /asset-search 结构一致),额外附带 `matched_media` 字段:命中媒体的 `media_id`、`storage_url`、`match_score`。
- `diagnostics.fallback_mode`:null(正常)| "caption_text"(Milvus 不可用,降级成 caption 文本搜索)。

### 4.2 权限与媒体锁

- 复用 /asset-search 的 scope 和 project_id 鉴权逻辑。
- `image_media_id` 指向的 asset_media 必须属于当前用户可见范围(personal 或 approved common);不可见时返回 404,不泄露存在性。
- multipart 上传的外部图片不入库,仅临时 embed 后丢弃字节;不创建 asset_media 记录。

## 5. 入库图片向量化

### 5.1 同步内联

在 assetIngestService 的入库流程中,建完 asset_media 后紧跟 vectorSync.syncMediaVisual:

1. 从 TOS 下载图片字节(或复用入库时已读到的 buffer)。
2. sharp 预处理(resize <=1536, jpeg quality 85) - 与 visionClient.prepareImage 参数一致。
3. embedding.embedImage(buffer) 生成视觉向量。
4. milvusVectorStore.upsert 写入,主键 `asset_media:<mediaId>:visual`。

### 5.2 并发控制

Excel 批量入库新增并发池 EXCEL_VISUAL_VECTOR_CONCURRENCY(建议值 4),与现有 EXCEL_VECTOR_SYNC_CONCURRENCY(文本向量,3)并行。单图上传无需并发池。

### 5.3 Milvus 记录结构

| 字段 | 值 |
|------|----|
| id(主键) | asset_media:<mediaId>:visual |
| vector | 图片嵌入向量 |
| text | 该图的 vision caption(供展示,不参与向量) |
| source_table | asset_media |
| source_id | <mediaId> |
| facet | visual |
| entity_id | 所属 asset_entities.id |
| sha256 | 图片 sha256 |
| media_kind | image |
| asset_kind | 继承所属 entity |
| approval_state | 继承所属 entity |
| status | 继承所属 entity |
| embedding_model | DOUBAO_EMBEDDING_MODEL |

## 6. 查询与融合

### 6.1 纯图搜(alpha=0)

1. 获取图片字节(image_media_id 从 TOS 拉,或 multipart 上传)。
2. embedding.embedImage(buffer) -> v_image。
3. Milvus search(v_image, filter=source_table in [asset_media]) -> 媒体级命中。
4. 按 entity_id 聚合取最高分 -> 回查 entity hydrate。

### 6.2 图文混搜(0 < alpha < 1)

1. 获取图片字节 + query 文本。
2. embedding.embedImage(buffer) -> v_image;embedding.embedText(query) -> v_text。
3. q = alpha * v_text + (1-alpha) * v_image。
4. Milvus search(q)(不限制 source_table,同时命中文本实体向量和图片媒体向量)。
5. 媒体级命中按 entity_id 聚合;实体级命中直接保留;跨源去重取最高分。

### 6.3 结果聚合

- parseKey 扩展认 asset_media:<id>,从 metadata 取 entity_id 映射为 asset_entities:<entityId>。
- 同一 entity 多条命中(文本向量 + 多张图向量)去重取最高分。
- 保留最高分命中的 media_id/storage_url 写入 matched_media 字段返回。

## 7. PostgreSQL 降级

Milvus 不可用时(网络错误、UNAVAILABLE、DEADLINE_EXCEEDED),visual 端点降级:

1. **库内找相似**:image_media_id 对应的 entity 已有 vision caption -> 走 searchWithPostgresFailover 的 PG ilike 文本搜索。
2. **外部图搜库**:multipart 上传的图无 caption -> 调一次 visionClient.describeImage 生成描述 -> 走 PG ilike 文本搜索。这是降级路径的额外一次 vision 调用,仅在 Milvus 异常态发生。
3. 响应 diagnostics.fallback_mode = "caption_text",前端可提示用户"当前为降级模式,结果基于文字近似而非视觉相似"。

不引入 pgvector,不双写向量。

## 8. 前端 UI 设计(资产中心·检索页)

范围:仅 frontend/shortdrama-rag-demo 的资产中心检索页(global-pages.tsx),个人/通用两个 scope 同一交互。API 客户端 assetVisualSearch 已就位(api.ts,配套 VisualSearchPage 类型在 types.ts),本节消费之。

### 8.1 双入口(决策 15)

1. **搜索框上传外部图**:搜索框内右侧加图片按钮,点击弹文件选择(accept 常见图片类型,<=10MB,与后端 multipart 限制一致)。选图后搜索框内出现缩略图 chip:可删除(删除即恢复纯文本搜索)、请求中显示加载态、失败可移除重试。一次最多一张图,再选即替换。
2. **卡片"找相似"**:资产卡片 hover 操作区加"找相似"按钮,取该资产主图(primary media)的 media_id 走 JSON image_media_id 模式,零上传。触发后把该图置入 chip(与上传同一呈现,用户能看清"当前在按哪张图搜"),文字框保留已输入内容。

### 8.2 混搜触发(决策 16)

- chip 有图 + 框内有文字 = 自动混搜:前端调 assetVisualSearch 不传 alpha,后端默认 0.5。
- 只有图 = 纯图搜;只有文字 = 走原 /asset-search 文本路径,现有逻辑不动。
- 不做权重三档/滑杆;若后续评测证明 0.5 偏科,再以 UI 决策重开本点。

### 8.3 Tag 筛选互斥(决策 17)

- chip 激活时 Tag 筛选框置灰,提示"图搜暂不支持 Tag 筛选"。
- 不做前端内存过滤:visual 端点无 tag 参数,客户端过滤导致每页不足 page_size 的分页失真。
- 删除 chip 后 Tag 框自动恢复。

### 8.4 降级警告条(决策 18)

- 响应 diagnostics.fallback_mode === "caption_text" 时,结果区顶部显示警告条:"当前为降级模式,结果基于文字近似而非视觉相似"。
- 结果照常分页展示,不阻断;下一次请求 fallback_mode 为 null 时警告条消失。

### 8.5 结果与状态

- 结果卡片沿用现有资产卡片与分页,不新增专属视觉;matched_media 本期仅后端返回,前端不做单独标注。
- 空态/错误态复用现有组件;本地先做 10MB 校验,超限不发请求。

## 9. 代码改动面

| 文件 | 改动 |
|------|------|
| src/integrations/embeddingClient.ts | EmbeddingClient 接口加 embedImage(content: Buffer, contentType: string): Promise<number[]>;DoubaoEmbeddingClient 实现(同端点 input:[{type:image_url}],sharp 预处理,extractEmbeddingVector 复用) |
| src/services/vectorSyncService.ts | 加 syncMediaVisual(media, parent: AssetEntityData):拉字节->预处理->embedImage->store.upsert |
| src/services/assetIngestService.ts | 建完 asset_media 后内联调 syncMediaVisual;加 EXCEL_VISUAL_VECTOR_CONCURRENCY 并发池 |
| src/modules/assets/hybridSearchService.ts 或新 visualSearchService.ts | parseKey 扩认 asset_media;asset_media->entity 映射聚合;semantic recall 加图片分支 + 早融合 |
| src/modules/assets/routes.ts | 新增 POST /api/v1/asset-search/visual(JSON image_media_id 或 multipart,可选 query+alpha) |
| src/modules/assets/searchFailover.ts | visual 端点 Milvus 不可用时降级成 caption 文本搜索 |
| src/integrations/embeddingClient.test.ts | embedImage 契约测试 |
| vectorSyncService 相关测试 | syncMediaVisual 契约测试 |
| frontend/shortdrama-rag-demo/src/pages/global-pages.tsx | 检索页:图片按钮+缩略图 chip、卡片"找相似"、Tag 置灰、降级警告条(§8) |
| frontend/shortdrama-rag-demo/src/api.ts | assetVisualSearch 客户端与 VisualSearchPage 类型已就位,UI 直接消费 |

## 10. 已知边界

- **存量图片无视觉向量**:Q8 决策不回填。已入库的 asset_media 只能靠文本向量+PG ilike 兜底,视觉搜不到。
- **图搜图降级为文本近似**:Q14-A,Milvus 不可用时视觉相似性丢失,降级成 caption 文本搜索。
- **modality gap**:同空间里文/图向量分布可能有偏移,纯文本查询命中图向量的质量不如命中文本向量。由"实体文本向量仍在场"兜底(取并集)。
- **Milvus 重建脚本未写**:Q8 推迟。若 Milvus 需要重建投影,回填脚本本质就是遍历所有 asset_media 重新 embed - 届时再写。
- **图搜不支持 Tag 筛选**:决策 17,UI 置灰规避;如需图+Tag 交集,先给 visual 端点加 tag 参数(后端合同变更,单开卡)。

## 11. 验收标准

- 纯图搜:上传一张图,返回视觉相似的资产,matched_media 指向命中的具体图片。
- 图文混搜:同时传图+文字,结果融合视觉与文本信号;API 层 alpha 可调,前端锁定默认 0.5(决策 16)。
- 入库向量化:新入库的单图和 Excel 批量图,入库后 Milvus 中有对应 asset_media:<id>:visual 记录。
- PG 降级:Milvus 不可用时,visual 端点返回 fallback_mode: "caption_text" 而非报错。
- UI 双入口:搜索框可上传图片并出现可删除缩略图 chip;资产卡片"找相似"按钮触发 image_media_id 纯图搜。
- UI 互斥:chip 激活时 Tag 筛选框置灰并提示原因,删除 chip 后恢复。
- UI 降级:收到 fallback_mode: "caption_text" 时结果区顶部出现降级警告条,结果仍展示。
- 界面实证:真栈(5173 dev + 8000 API)渲染走通上传、找相似、降级三条路径,截图入 docs/prototype/shots/。
- npm run check:architecture、npm run typecheck、npm test、npm run build 全过。
- 不触碰 4 付费红线:embedding 调用不是生图/生视频/生音频,不属于付费生成动作。

## 12. 待批准决策项

本需求文档转正为合同前,需产品负责人确认:

1. 存量图片不回填是否可接受(功能上线即有盲区)。
2. 图搜图降级为 caption 文本搜索是否满足架构合同"必须有 PG 降级路径"的口径。
3. visual 端点的 alpha 默认值(当前建议 0.5)是否合理。
4. 前端 UI 范围与交互是否可接受:已补齐 §8(双入口、alpha 锁 0.5、Tag 置灰、降级警告条、仅资产中心检索页),选资产抽屉/项目页留后续卡。
