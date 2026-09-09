# V0.2.0 选题雷达合同

## 目的与边界

选题雷达是内部研究用的后端缓存服务。前端只读取归一化结果，不直接调用 52API，也不获得 key、供应商原始响应或错误正文。所有展示位必须带“数据仅内部参考”，并保留 `commercial_display_status=pending_vendor_written_approval`。

供应商适配器固定使用已购买的旧版 `https://www.52api.cn/api/hg_top`：目录使用 `type=top`，指定页使用 `type=list`。不得试探 `/api/hg_new_top`，不得自动预取下一页或循环拉全。

受控环境只需启用开关和供应商 key。未配置时必须在任何额度领取或上游请求前停止，
并以 `freshness=unconfigured` 的成功数据态返回；不得用 503 或空榜伪装成来源故障。
2026-07-31 已用受控环境 key 完成一次目录和单页真实冒烟：目录响应数组字段为
`data.lists`，子榜字段为 `sub_lists`，单页响应同样使用 `data.lists`；适配器兼容这些
真实字段。回执只记录请求次数和归一化摘要，不保存 key 或供应商原始响应。

## API

所有接口要求已登录，成功体为 `{ "ok": true, "data": ... }`，字段使用 `snake_case`。

- `GET /api/v1/topic-radar/rankings`：返回 opaque `id`、`name`、`sub_rankings`。
- `GET /api/v1/topic-radar/rankings/:ranking_id/items?page=1&sub_ranking_id=...`：只返回用户指定的一页，页码为 1..50。
- `POST /api/v1/admin/topic-radar/refresh`：仅 platform admin；body 的 `target` 是 `rankings` 或 `ranking_page`，后者必须带 `ranking_id`，可带 `sub_ranking_id` 和 `page`。

目录与榜单页成功响应都必须带
`data_date`、`fetched_at`、`freshness=fresh|stale|unconfigured` 与
`commercial_display_status=pending_vendor_written_approval`。未配置时日期均为 `null`，
条目数组为空，且榜单页返回 `next_page=null,end_reached=true`；这是明确状态，不代表
供应商返回了空榜。`fresh`/`stale` 的 `data_date` 只使用供应商明确返回的榜单日期；
供应商没有给日期时该字段也为 `null`，不得拿抓取日期冒充。`fetched_at` 单独表达抓取时间。

目录的显式空数组是成功；缺少可识别数组，或非空数组却无法归一化，都是上游结构错误。榜单页同样适用。非空页在 page 1..49 返回 `next_page=page+1,end_reached=false`；显式空页返回 `next_page=null,end_reached=true`；第 50 页非空返回 `next_page=null,end_reached=false`。不返回 `total`、`total_pages` 或 `has_more`。不保留 `/hot` 兼容路由。

## 缓存、失败与额度

`cache_date` 按 `Asia/Shanghai` 自然日计算。每个 resource scope（`rankings` 或一个 ranking/sub-ranking/page 元组）每天各有最多一个 `daily` 和一个 `manual` 领取。同 scope 并发只会有一个领取，不同 scope 独立。失败领取不自动重试；stale fallback 只能取同 scope 最近成功快照。

生产环境允许在上游失败或当日 daily 仍在执行时返回同 scope 最近成功快照并标记
`stale`。开发、测试环境不做该错误降级，必须保留真实失败，避免联调时把供应商问题藏成旧数据。

管理员对同一 resource scope 在同一中国日重复手动刷新时，返回已登记的 manual 结果或
状态，不再次请求供应商。`daily` 与 `manual` 是两份独立额度，不能互相冒充或覆盖。

迁移 `040_sgoal06_topic_radar_scopes.sql` 为 018 的历史热榜行写入 `legacy_hot` scope；它们不属于新 `rankings` 目录，不能被新目录或页面 fallback 使用。新 repository 总是显式写入 resource scope。scope 使用固定长度无歧义编码，避免 opaque ID 分隔符碰撞。

原始留档只用于内部追溯，必须经过供应商适配器脱敏；API 不序列化 `raw_payload`、`raw_item`、账本或供应商错误。
