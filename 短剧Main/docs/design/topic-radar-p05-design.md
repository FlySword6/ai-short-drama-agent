# 选题雷达进 P-05 · 控件与数据流设计稿(v1,2026-07-31,Kimi 预研)

> 依据:`docs/contracts/v0.2.0/topic-radar.md`(已合流 dev)。只做设计,不铺 UI;交 Fable 裁定后重排进施工。
> 边界:前端只读自家 API,绝不直调 52api;不引入供应商 key/原始响应/上游错误正文。

## 1. 数据流(一句话)

```
P-05 榜单面板 → GET /api/v1/topic-radar/rankings(登录态)
             → GET /api/v1/topic-radar/rankings/:ranking_id/items?page=1
                                                ↘ 失败 → 最近成功快照(stale)或明确不可用
```

响应消费:`data.items[]{rank,title,heat,link}` + `data_date` + `fetched_at` +
`freshness=fresh|stale|unconfigured` + `commercial_display_status`。snake_case 原样透传,
前端不改名。目录响应同样带齐四个状态字段。

## 2. P-05 帧改动点(对照现帧 168:928)

现「短剧热度榜 · 示例数据」panel(5 条写死)升级为**选题雷达榜**:

| 区域 | 现状 | 设计 |
|---|---|---|
| 面板头 | 「短剧热度榜 · 示例数据」 | 「短剧热度榜」+ 数据日期(mono,`data_date`);供应商未给日期时显示 `fetched_at` 对应的「抓取于…」，不得把抓取日标成数据日;`freshness=stale` 时日期旁加 weak 标注「非今日,显示最近可用」 |
| 合规标 | 无 | `commercial_display_status=pending_vendor_written_approval` 时,面板头下常驻 weak 小字「数据仅内部参考」(pending 期间一直显示,不随刷新消失) |
| 榜单行 | 5 行写死 | 每页 **24 行**(rank mono 两位 / title 一行截断 / heat mono 右对齐);行点击=选中态(elevated 底),**不打开 `link` 外链**(商用状态 pending,外链一律不导) |
| 分页 | 无 | 面板底部页码器:‹ 1 2 3 ›(每页 24;总条数=快照条目数,不足一页隐分页器) |
| 选中联动 | 点卡立项 | 选中榜单行后,底部 CTA 变为「用这道题,去写剧本 →」;不选时 CTA 维持「确定选题,去写剧本」(四张推荐卡路径不变) |
| 空/错态 | — | 三态分开:loading=24 行骨架(书封缺省态同族,panel 底+弱条);未配置/无快照=「选题雷达尚未配置」+ 弱说明(不装空数组);`stale` 无新快照=照显旧榜+日期标 |

## 3. 状态机(前端面板)

```
idle → loading → ready(fresh) ┐
              ↘ ready(stale,显示 data_date)
              ↘ unconfigured(HTTP 200,选题雷达尚未配置,日期为 null)
              ↘ unavailable(有历史快照则回退 ready(stale))
admin 手动刷新:不经本面板(见 §4)
```

## 4. 联动帧(admin 刷新入口,仅标注不施工)

`POST /api/v1/admin/topic-radar/refresh` 仅 platform admin,每个中国日最多一次成功领取。入口放 **P-11 管理后台**:批次流旁加「榜单缓存」卡(data_date / freshness / 上次抓取 fetched_at mono / 「手动刷新」按钮+当日已刷新禁点态)。重复点击返回已有结果,不二次扣额度;按钮旁弱注「手动刷新消耗一次上游调用」。

## 5. 与演示宇宙的关系(走查兼容)

- 演示期(无真实上游):面板落「未配置」态太丑,建议 demo 环境注入《雾岛来信》宇宙示例榜(现 5 行写死内容即 demo 数据源,标注「示例数据」改为合规小字);
- 走查时导演看到的 heat 单位(「123.4w」)原样显示,不做单位换算;
- `commercial_display_status` 变为 approved 前,「数据仅内部参考」常驻——此标注是合规件,不是 UI 装饰,施工时不得做成可关。

## 6. 施工拆分建议(裁定后)

1. P-05 榜单面板组件化(行/分页器/状态位)→ demo 数据源接通;
2. 真接口联调( dev 环境,fresh/stale/未配置三态用 mock 响应驱动);
3. P-11 榜单缓存卡(admin 刷新);
4. 走查回归:卡 3 动线(选题→剧本)重截。

— 完,待 Fable 裁定。
