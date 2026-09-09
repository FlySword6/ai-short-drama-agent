# S-goal-04 选题雷达跨端 API 形状提案

> 状态：`PROPOSAL_AWAITING_FABLE`
>
> 范围：52API 榜单目录、指定榜单分页、缓存与额度边界，以及前后端共同依赖的响应形状。
>
> 本文件仅用于跨端裁决，**不代表相关接口、缓存、迁移、前端页面或部署配置已经实现**。
> 编写本提案未读取或写入任何密钥，未启用选题雷达，也未向 52API 发出真实请求。

## 1. 结论

现有选题雷达实现只支持“运维预先配置一个榜单，然后读取这个榜单的第 1 页”。S-goal-04
需要改为两步：

1. 先读取可选榜单目录；
2. 再按用户选择的一级榜单、可选二级榜单和页码读取单页数据。

前端不直接访问 52API，也不接触 `key`、`cell_id`、供应商原始响应或原始错误。后端应用
API 使用供应商无关的 `ranking_id`、`sub_ranking_id` 命名，适配器内部再映射到
`cell_id`、`sub_cell_id`。

52API 不返回总条数或总页数，只有请求到空页才能确认结束。因此应用 API 不应编造
`total`，也不应在非空页上声称已经确认 `has_more=true`。后端一次只读用户明确请求的
一页，不自动循环拉全，不为判断下一页而偷偷预取。

## 2. 供应商合同与产品选择

用户确认已购买并调通过的是旧版“红果排行榜”产品：

- [52API 红果排行榜（`/api/hg_top`）](https://www.52api.cn/doc/114)
- [52API 红果短剧新版排行榜（`/api/hg_new_top`）](https://www.52api.cn/doc/134)

两个产品是独立的计费接口，不应在同一个已启用配置中自动试探或故障切换。本提案建议
S-goal-04 固定使用：

```text
GET https://www.52api.cn/api/hg_top
```

GET 查询参数由 `URLSearchParams` 编码，与供应商官方 GET 示例一致：

- `type=top`：获取一级榜单及可选二级榜单的 ID 和名称；
- `type=list`：获取指定榜单数据；
- `cell_id`：一级榜单 ID；
- `sub_cell_id`：可选二级榜单 ID；
- `page`：可选页码，从 1 开始；
- `key`：仅在服务端受控环境注入。

供应商同时声明支持 POST，但本能力是只读查询，GET 更适合应用缓存、测试和审计。本提案
不要求改成 POST。

## 3. 应用 API 草案

所有接口要求登录，统一返回 `{ "ok": true, "data": ... }`，公共 JSON 字段使用
`snake_case`。

### 3.1 榜单目录

```http
GET /api/v1/topic-radar/rankings
```

成功响应：

```json
{
  "ok": true,
  "data": {
    "rankings": [
      {
        "id": "ugc_rank_list_vote",
        "name": "热播榜",
        "sub_rankings": [
          {
            "id": "weekly",
            "name": "周榜"
          }
        ]
      }
    ],
    "fetched_at": "2026-07-30T08:00:00.000Z",
    "freshness": "fresh",
    "commercial_display_status": "pending_vendor_written_approval"
  }
}
```

约束：

- `id`、二级榜单 `id` 都是 opaque string，不转成数字，不从名称推导；
- `sub_rankings` 始终存在，没有二级榜单时为 `[]`；
- 只返回归一化后的 ID、名称和层级，不透传供应商 `data`；
- 已成功获取但目录确实为空时，可以返回 `rankings: []`；
- 缺少可识别的数据数组属于上游结构错误，与“明确的空数组”区分处理；
- 目录没有供应商数据日期，不编造 `data_date`。

### 3.2 指定榜单的单页数据

```http
GET /api/v1/topic-radar/rankings/:ranking_id/items?page=1&sub_ranking_id=weekly
```

其中：

- `ranking_id` 必填；
- `sub_ranking_id` 可选；
- `page` 默认 1，必须为正整数，上限待 Fable 裁决。

非空页响应：

```json
{
  "ok": true,
  "data": {
    "ranking_id": "ugc_rank_list_vote",
    "sub_ranking_id": "weekly",
    "page": 1,
    "items": [
      {
        "rank": 1,
        "title": "示例短剧",
        "heat": "123.4w",
        "link": "https://..."
      }
    ],
    "next_page": 2,
    "end_reached": false,
    "data_date": "2026-07-30",
    "fetched_at": "2026-07-30T08:00:00.000Z",
    "freshness": "fresh",
    "commercial_display_status": "pending_vendor_written_approval"
  }
}
```

当且仅当供应商明确返回可识别的空条目数组时，该页是成功的终止页：

```json
{
  "ok": true,
  "data": {
    "ranking_id": "ugc_rank_list_vote",
    "sub_ranking_id": "weekly",
    "page": 8,
    "items": [],
    "next_page": null,
    "end_reached": true,
    "data_date": "2026-07-30",
    "fetched_at": "2026-07-30T08:05:00.000Z",
    "freshness": "fresh",
    "commercial_display_status": "pending_vendor_written_approval"
  }
}
```

分页语义：

- 非空页的 `next_page` 是下一次应探测的页码，不承诺下一页一定有数据；
- 空页返回 HTTP 200，不转成 404、502 或“供应商无可用条目”；
- 不返回 `total`、`total_pages` 或未经证实的 `has_more`；
- 前端采用“加载更多”或累计列表，不把终止空页渲染成一个空白业务页；
- 后端不自动请求下一页，避免一次页面读取变成不确定次数的付费调用。

### 3.3 管理员显式刷新

若保留现有：

```http
POST /api/v1/admin/topic-radar/refresh
```

它必须增加刷新目标，不能继续表示一个全局、无榜单上下文的快照。

目录刷新：

```json
{
  "target": "rankings"
}
```

单页刷新：

```json
{
  "target": "ranking_page",
  "ranking_id": "ugc_rank_list_vote",
  "sub_ranking_id": "weekly",
  "page": 1
}
```

该入口仍仅允许 platform `admin`，且使用与正常读取相同的资源 scope。

## 4. 后端端口形状

供应商端口建议拆成：

```ts
interface TopicRadarProvider {
  assertReady(): void;
  fetchRankings(): Promise<TopicRadarRankingCatalogResult>;
  fetchRankingPage(input: {
    rankingId: string;
    subRankingId?: string;
    page: number;
  }): Promise<TopicRadarRankingPageResult>;
}
```

服务端口建议拆成：

```ts
interface TopicRadarServicePort {
  listRankings(actor: TopicRadarActor): Promise<TopicRadarRankingCatalogView>;
  getRankingPage(
    actor: TopicRadarActor,
    input: {
      rankingId: string;
      subRankingId?: string;
      page: number;
    },
  ): Promise<TopicRadarRankingPageView>;
  forceRefresh(
    actor: TopicRadarActor,
    target: TopicRadarRefreshTarget,
  ): Promise<TopicRadarRankingCatalogView | TopicRadarRankingPageView>;
}
```

适配器必须分别解析目录与榜单条目。不能继续用同一个 `normalizeItem()` 把目录中的
`name` 当作短剧标题，也不能丢掉榜单 ID 和二级榜单层级。

## 5. 缓存 scope 与调用额度

现有账本的唯一键只有 `source + cache_date + request_kind`。它无法区分目录、不同榜单、
二级榜单和页码。若只改路由和 provider：

- 第一个榜单请求会占掉当天唯一领取；
- 后续其他榜单或其他页可能错误返回第一个快照；
- stale fallback 也可能跨榜单、跨页串数据。

建议每个可独立请求的供应商资源都有稳定 scope：

```text
rankings
ranking_page(ranking_id, sub_ranking_id|null, page)
```

缓存、调用领取和 stale fallback 都必须使用同一个 scope。推荐额度口径：

- 每个 scope、每个 `Asia/Shanghai` 自然日最多一个 `daily` 领取；
- 每个 scope、每个自然日最多一个独立的 `manual` 领取；
- 失败领取保留，不因用户重复刷新自动重试；
- 同 scope 并发读取只允许一个上游请求；
- 不同榜单、二级榜单和页码彼此独立；
- 自动读取不循环分页，用户明确加载下一页才产生下一个 page scope；
- fallback 只能返回同 scope 的最近成功快照。

实现此口径需要新的 schema/migration、repository 和真库测试。不能为了把接口先露出来而
绕过现有调用账本。

## 6. 前端共同约定

前端按以下顺序工作：

1. 加载 `/rankings`；
2. 由裁决后的默认策略选择一级榜单和可选二级榜单；
3. 请求所选榜单第 1 页；
4. 用户点击“加载更多”时请求 `next_page`；
5. 收到 `end_reached=true` 后停止，并保留此前累计条目；
6. 切换一级或二级榜单时清空累计条目并从第 1 页重新加载。

前端不得：

- 直接拼 52API URL；
- 持有或发送 52API key；
- 把 `ranking_id` 展示为用户文案；
- 根据本页条目数量猜测总页数；
- 在后台自动循环到空页；
- 把 stale 数据标成今日实时榜单；
- 隐藏 `pending_vendor_written_approval` 所代表的展示权边界。

需要覆盖 loading、目录空、榜单空、stale、未配置、更新中和失败状态。供应商名、HTTP 状态、
原始错误和内部状态机名称不进入用户文案。

## 7. 现有实现缺口

| 缺口 | 当前证据 | 影响 |
| --- | --- | --- |
| provider 只有固定榜单读取 | `src/modules/topic-radar/provider.ts:43-44` 只有 `fetchHotList()` | 无法获取榜单目录 |
| 静态 cell 是 readiness 条件 | `provider.ts:99-106` | `type=top` 本不需要 cell，却会在请求前失败 |
| 固定 `type=list&page=1` | `provider.ts:120-128` | 无法按用户选择榜单或翻页 |
| 空数组被判为错误 | `provider.ts:70-75` | 无法表达分页结束 |
| 目录 ID 和层级会丢失 | `provider.ts:158-167` | `name` 会被误映射为短剧标题 |
| 单页静默截断 200 条 | `provider.ts:70-72` | 供应商页大小未核实前可能丢条目 |
| 类型端口无目录/分页输入 | `src/modules/topic-radar/types.ts:56-60,100-110` | service/routes 无稳定跨端合同 |
| service 无资源参数 | `src/modules/topic-radar/service.ts:40-70` | 所有读取共用一个“hot list” |
| fallback 按来源全局读取 | `service.ts:81-82,113-114` | 多榜单后可能返回错误榜单或页码 |
| 路由只有 `/hot` | `src/modules/topic-radar/routes.ts:26-34` | 前端不能列榜单或指定 page |
| 调用账本按来源/日期全局唯一 | `migrations/018_topic_radar.sql:117-126` | 多资源请求互相占用额度 |
| repository claim 无 scope | `src/modules/topic-radar/repository.ts:149-165` | 不能安全缓存目录与分页 |
| 合同明确禁止分页 | `docs/contracts/v0.2.0/topic-radar.md:19-22` | 新需求实施前必须先修正式合同 |
| 现有 provider 测试只锁第 1 页 | `src/modules/topic-radar/provider.test.ts:26-59` | 未覆盖 top、二级榜单和空页 |
| 现有 route/service 测试只覆盖 hot | `routes.test.ts:15-31`、`service.test.ts:20-39` | 未覆盖新的跨端行为 |

当前代码允许配置 `hg_top` 或 `hg_new_top`，测试中也混用了两者。用户已经确认所购产品后，
继续自动兼容两个产品会掩盖错误配置并可能调用错误的计费产品。

## 8. 最小安全实施范围

裁决后，完整实现至少涉及：

1. 更新正式 topic-radar 合同；
2. `types.ts` 增加目录、分页与刷新目标类型；
3. `provider.ts` 拆分 `top` 和 `list` 请求及解析器；
4. `service.ts` 按 scope 读取、领取和 fallback；
5. `routes.ts` 增加新 GET 路由及严格 Zod 校验；
6. repository/schema/migration 增加资源 scope 和目录归一化存储；
7. provider/service/routes/migration/PostgreSQL 测试；
8. 前端 API client、榜单选择、加载更多与全状态页面；
9. 受控环境中的密钥迁移、启用和部署验证；
10. 经明确授权的一次 dev 真实调用与脱敏回执。

只完成前五项而不改存储与调用账本，不能视为可用实现。

## 9. 需 Fable 裁决

1. **供应商产品**：是否按用户已购事实固定旧 `hg_top`。本提案建议固定，不自动尝试
   `hg_new_top`。
2. **旧路由兼容**：是否删除尚无前端消费者的 `/api/v1/topic-radar/hot`，还是保留为某个
   默认榜单第 1 页的兼容别名。本提案建议新功能上线前直接替换，避免长期双合同。
3. **默认榜单**：目录加载后由前端默认首项、后端运营配置，还是要求用户主动选择。
4. **二级榜单首发范围**：API 和数据形状是否首版即开放；本提案建议合同先保留，UI 以一次
   经授权的真实响应确认层级后再展示。
5. **page 上限**：建议先采用 `1..100`，防止任意深页消耗调用；若真实榜单超过上限，再用
   证据调整。
6. **缓存与额度**：是否批准“每 scope 每日一次 daily + 一次 manual”。若仍坚持当前来源
   全局每日一次，就不能同时提供目录和任意榜单分页。
7. **空目录与第一页为空**：是否都作为供应商明确成功的业务空态。本提案建议是；只有无法识别
   数据数组才算上游结构错误。
8. **密钥名称与部署**：本地记录使用 `LEGACY_52API_KEY`，应用读取
   `TOPIC_RADAR_52API_KEY`，测试部署 KMS 尚未包含该键。需裁决受控迁移方式，不能仅改
   enabled 开关。
9. **真实调用授权**：是否批准实现完成后做一次 dev `type=top` 和必要的单页 `type=list`
   冒烟，以脱敏 fixture 固化真实字段、二级榜单层级和空页行为。未获授权前保持零调用。

## 10. 验收证据

实现完成时至少应提供：

- provider 合同测试：`top`、指定一级/二级榜单、任意页、合法空页、畸形响应、错误脱敏；
- service 测试：同 scope 并发单领、不同 scope 独立、失败不自动重试、fallback 不串榜；
- route 测试：登录、参数校验、目录/分页响应、空页终止、管理员刷新权限；
- migration 静态测试与 disposable PostgreSQL 真库测试；
- 前端真实渲染：目录、切榜、加载更多、终止空页、stale、空、失败；
- 若获授权，记录真实 52API 调用日期、scope、次数和脱敏结果，不记录 key 或原始敏感响应；
- 明确区分“文件存在”“本地合同测试通过”“真实 dev 调用通过”和“已部署可用”。

