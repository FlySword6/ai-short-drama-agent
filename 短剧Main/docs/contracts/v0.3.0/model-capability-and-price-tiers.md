# 模型能力档与价格档合同(v0.3.0 参数解冻,2026-08-06 修订)

背景:前端参数行(画幅/尺寸/张数/时长)已上界面,但后端仍锁定单一参数组合,
报价不随参数变化——"界面可调、后端不认"是假可用(Sol 参数真相盘点结论,Fable 确认)。
本合同定义参数解冻的唯一路径:**先有档,再有界面;没有档的参数组合,界面不给选。**

## 一、概念

- **能力档(tier)**:某模型在本平台被允许提交的一组完整参数组合。后端仍以完整档计价和提交，
  但前端可以把多个有效档投影为画幅、清晰度、数量、时长等独立选择。
- **价格档**:每个能力档绑定唯一计价(积分,按张或按秒),报价与扣费都按档算。
- 一个模型可有多个档;档与档之间参数组合互斥不重叠。

## 二、档的数据形状(后端配置真源,Sol 实现)

```jsonc
{
  "tier_id": "img-seedream5pro-169-2k-1",     // 稳定 ID,前后端通信用
  "model_id": "doubao-seedream-5-0-pro-260628",
  "media_type": "image",                       // image | video | audio
  "params": {                                  // 提交 Provider 的完整参数组合
    "aspect_ratio": "16:9",
    "resolution": "2K",
    "quantity": 1
    // video 档另有 duration_seconds / fps 等
  },
  "price": { "unit": "per_image", "points": 60 },  // per_image | per_second
  "status": "active"                           // active | experimental | retired
}
```

- 配置存放与加载方式由 Sol 定(建议随 pricing_rules 同源管理,避免两处真源);
- **初始档 = 现状**:图片、视频各一个 active 档,参数与价格以 Sol 参数真相盘点
  回执为准(generation 模块当前实际校验+pricing_rules 现行两行),不新增任何
  未实测组合。

## 三、API(Sol 实现)

- `GET /api/v1/generation/capability-tiers?media_type=image|video|audio`
  → `{ tiers: [<上述形状>] }`,登录即可读；为保持既有客户端合同，缺省只返回可用档。
  显式追加 `include_frozen=true` 时，目录同时返回可用档和冻结档：
  可用档为 `status=active / availability=available|dev_smoke_only`；冻结档强制投影为
  `status=experimental`，并返回 `availability` 与中文 `availability_reason`。前端只有
  `status=active` 才能选中，后续灰档界面直接使用冻结原因，不再猜供应商状态;
- 报价链改造:`quote` 请求带 `tier_id`,按档计价;`confirm`/任务创建校验
  `tier_id` 存在且 active,参数组合与档完全一致,不一致 422;
- 不放宽任何现有校验:档外组合在报价阶段就拒绝,不许"报价通过、提交拒绝"。

## 四、前端行为(Kimi 实现)

- 参数行渲染数据源 = capability-tiers 接口,**不再有本地参数选项**;
- 只有一个 active 档时:参数行显示为固定标签(如「16:9 · 2K · 1 张」)+
  「更多档位即将开放」,**不可点**——当前假可调控件全部改为此形态;
- 多档时:前端从 active 档投影独立参数控件；每次选择最终必须命中一个完整 `tier_id`
  才能报价。用户不需要理解“整档”，后端也不接受不存在的自由组合;
- 发送仍走人工确认红线,确认卡显示档位与价格。

## 五、新档解锁流程(任何人不得跳步)

1. 实测冒烟:目标参数组合真跑一次最低成本生成(Dario 授权付费);
2. 计费核对:Provider 实际计费与拟定价格档核对留痕;
3. 合同登记:本文件附表加一行(tier_id/参数/价格/实测证据链接);
4. 后端上档(status=active)→ 前端自动出现,无需改前端代码。

Seedance 2.5 等新模型上线的适配窗,同样走此流程建档,不直接改旧档。

### 5.1 开发环境冒烟例外

为了在正式解锁前验证真实报价链，S-goal-04 允许 7 个候选档在开发环境临时投影。临时档：

- 必须带 `metadata.activation_scope=dev_smoke_only`；
- `metadata.price_source_kind=待核`，不能伪装成“实测”；
- 只能由 `seed-pricing-tiers.mts --target dev --promote-sgoal04-p2
  --confirm-sgoal04-p2` 受控启用；
- 脚本拒绝生产 schema，测试和生产环境也不得复制这些行；
- 仅用于用户界面、报价链和逐档冒烟；完成第五节四步后才可迁入附表 A。

这个例外不改变附表 B 的默认状态：未被显式选中的候选仍为 inactive / experimental。

### 5.2 逐档价格守卫与证据

- Ark 有 `tier_id` 的档位必须命中版本化官方价格目录
  `src/modules/generation/tierPricingGuard.ts`。目录按
  `provider/model/media_kind/billing_unit/params` 核对官方单价或 token 公式，并校验
  `pricing_rules.unit_price_fen`；数据库 metadata 不能自报一个“官方价”绕过目录。
- 目录查不到价格或参数矩阵不一致时分别保持 `pricing_unverified` /
  `parameter_matrix_unverified`，不得报价。
- 正式 active 新档还必须有 `price_source_kind=实测` 与
  `metadata.activation_evidence`（批次、脱敏任务指纹、产物 SHA-256、平台登记价、
  供应商账单引用与实扣、冒烟与核账时间、证据文件 SHA-256、已部署守卫 commit）。
  缺一项即
  `billing_unverified`。
- 开发冒烟档可以使用 `activation_scope=dev_smoke_only`，但只能由身份绑定的受控脚本
  临时读取；普通目录、报价链和管理 API 一律不把它当可选档。价格与参数仍必须命中
  官方目录；该例外不能把推算价变成正式解冻。
- 无 `tier_id` 的历史视频价格行继续保留 80 分/秒兼容兜底；它不是新档价格规则，
  也不会抬高已在目录中按官方公式核准的 25/40/50 等档位。
- 正式解冻统一使用 `scripts/tier-unfreeze.mts`：默认 dry-run；`--apply` 需要重复确认
  精确批次、逐档实测核账 JSON、已指纹绑定的数据库，并在事务内持有价格 advisory
  lock 与表锁。`dev` 既有批次和行为不变；测试环境只额外开放
  `--target test-env` 的 9:16 最低价图片单档批次，并要求 `--confirm-target test-env`、
  独立的数据库+schema 指纹、测试服务地址和公司 Ark 凭据指纹。`prod` / `production`
  目标始终拒绝，dev/prod 部署清单不得继承 test 的三项批准值。
- apply 前还要通过目标部署服务 `/health` 的 commit 和 `/ready` 核验，证明本守卫已经
  发布。单批最多 4 档，整单供应商实扣超过 50 元拒绝执行。付费 smoke 在调用供应商前
  先占额：dev 保持既有本地账本，test-env 写 PostgreSQL 唯一防重记录，Pod 重建也不能
  再付一次。同一档一旦 reserved（含调用中断）即禁止自动重跑，必须人工核账后处置；
  test-env 的 9:16 证据还必须包含实际产物宽高且宽高比核验通过。

## 附表 A:已解锁 active 档位

| tier_id | 模型 | 参数 | 价格 | 状态 | 实测证据 |
| --- | --- | --- | --- | --- | --- |
| `img-seedream5pro-169-2k-1` | `doubao-seedream-5-0-pro-260628` | `16:9`、`2K`、1 张、无水印、禁组图(Pro 不发送 sequential 参数,合同语义=disabled) | 60 积分/张 | active | 2026-07-21 付费冒烟实测(估价 60 分→确认→提交→出图→TOS 落库→记账);`docs/validation/v0.1.1-admin-models-pricing-handoff.md` 第 32 行(60 分/张现行行);pricing_rules 现行行 `8ec1ae5a` |
| `vid-seedance20fast-916-720p-4s` | `doubao-seedance-2-0-fast-260128` | `9:16`、`720p`、4 秒、无水印、无输入视频 | 80 积分/秒（本档 320 积分） | active | `docs/validation/v0.1/checkpoint-05-ark-paid-contract.md` 第 87 行；`checkpoint-06-real-acceptance.md` 第 24 行 |

> 盘点口径：1 积分 = 1 分钱。上述两档与 `pricing_rules` 的现行有效行同源;
> 若云端价格规则已变更,以完成只读核验后的规则为准,并同时更新本附表和对应的实测证据。
> 旧视频档的 80 分/秒只保护上述固定无输入视频组合,不写
> `metadata.supports_input_video`,不得作为视频参考价格。
>
> 2026-07-23 集成修正:原登记的图片档(`img-seedream5-169-2k-1`,
> `doubao-seedream-5-0-260128`,22 积分/张)与云端现行规则不符——真栈 active
> 行自 2026-07-21 付费冒烟后即为 5.0 Pro @ 60 分/张(V0.1 证据对应的旧模型行
> 已停用)。按上一段自我修正条款,以只读核验后的现行规则为准改登本行;
> 22 积分档若未来恢复非 Pro 模型,按第五节解锁流程重新实测建档。

## 附表 B:实验候选登记（未解锁）

本表是价格研究候选清单,不是第五节第 3 步的 active 解锁登记。每行固定为
`pricing_rules.active=false`、`metadata.capability_tier.status="experimental"`、
`metadata.price_source_kind="官方牌价×加成率(推算)"`;均未完成逐档付费实测和账单核对,
会进入公共 capability-tiers 目录的灰态投影并携带冻结原因，但不可进入 active 选择、
报价、确认或提交。视频候选不写 `metadata.supports_input_video`。只有单行完成第五节
全部步骤后,才能通过独立管理动作迁入附表 A。

下列数值仅保留 S58 的官方刊例、token/像素公式、加成率 1.0 与向上取整到 5 积分的研究结果;
其中低于 80 分/秒的值不硬抬。80 分/秒只继续保护无 `tier_id` 的历史兼容行；附表 A
旧固定视频档和附表 B 候选均由逐档价格目录核对，不把旧档价格当全模型下限。

### B.1 Seedream 5 Pro 图片候选

模型统一为 `doubao-seedream-5-0-pro-260628`;共同参数为 `watermark=false`、
`sequential_image_generation=disabled`、`quantity=1`。

| # | tier_id | 比例/规格 | 推算参考值 | 运行状态 | 来源/实测 | 公共投影/报价 |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | `img-seedream5pro-169-1k-1` | 16:9 / 1K | 30 积分/张 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 02 | `img-seedream5pro-916-1k-1` | 9:16 / 1K | 30 积分/张 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 03 | `img-seedream5pro-11-1k-1` | 1:1 / 1K | 30 积分/张 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 04 | `img-seedream5pro-916-2k-1` | 9:16 / 2K | 60 积分/张 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 05 | `img-seedream5pro-11-2k-1` | 1:1 / 2K | 60 积分/张 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |

### B.2 Seedance 2.0 本体视频候选

模型统一为 `doubao-seedance-2-0-260128`;共同参数为 `watermark=false`、`quantity=1`;
`duration_seconds` 尚未冻结,全部不支持视频输入。

| # | tier_id | 比例/规格 | 推算参考值 | 运行状态 | 来源/实测 | 公共投影/报价 |
| --- | --- | --- | --- | --- | --- | --- |
| 06 | `vid-seedance20-169-480p` | 16:9 / 480p | 50 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 07 | `vid-seedance20-916-480p` | 9:16 / 480p | 50 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 08 | `vid-seedance20-11-480p` | 1:1 / 480p | 45 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 09 | `vid-seedance20-169-720p` | 16:9 / 720p | 100 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 10 | `vid-seedance20-916-720p` | 9:16 / 720p | 100 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 11 | `vid-seedance20-11-720p` | 1:1 / 720p | 100 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 12 | `vid-seedance20-169-1080p` | 16:9 / 1080p | 250 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 13 | `vid-seedance20-916-1080p` | 9:16 / 1080p | 250 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 14 | `vid-seedance20-11-1080p` | 1:1 / 1080p | 250 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 15 | `vid-seedance20-169-4k` | 16:9 / 4k | 510 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 16 | `vid-seedance20-916-4k` | 9:16 / 4k | 510 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 17 | `vid-seedance20-11-4k` | 1:1 / 4k | 510 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |

4k 三行保留官方 `rate_limit_hint`（并发 1 / RPM 15）,但限流资料不是生成实测证据。

### B.3 Seedance 2.0 Fast 视频候选

模型统一为 `doubao-seedance-2-0-fast-260128`;全部不支持视频输入。

| # | tier_id | 比例/规格 | 推算参考值 | 运行状态 | 来源/实测 | 公共投影/报价 |
| --- | --- | --- | --- | --- | --- | --- |
| 18 | `vid-seedance20fast-169-480p` | 16:9 / 480p | 40 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 19 | `vid-seedance20fast-916-480p` | 9:16 / 480p | 40 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 20 | `vid-seedance20fast-11-480p` | 1:1 / 480p | 40 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 21 | `vid-seedance20fast-169-720p` | 16:9 / 720p | 80 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 22 | `vid-seedance20fast-11-720p` | 1:1 / 720p | 80 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |

### B.4 Seedance 2.0 Mini 视频候选

模型统一为 `doubao-seedance-2-0-mini-260615`;全部不支持视频输入。

| # | tier_id | 比例/规格 | 推算参考值 | 运行状态 | 来源/实测 | 公共投影/报价 |
| --- | --- | --- | --- | --- | --- | --- |
| 23 | `vid-seedance20mini-169-480p` | 16:9 / 480p | 25 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 24 | `vid-seedance20mini-916-480p` | 9:16 / 480p | 25 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 25 | `vid-seedance20mini-11-480p` | 1:1 / 480p | 25 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 26 | `vid-seedance20mini-169-720p` | 16:9 / 720p | 50 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 27 | `vid-seedance20mini-916-720p` | 9:16 / 720p | 50 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
| 28 | `vid-seedance20mini-11-720p` | 1:1 / 720p | 50 积分/秒 | experimental / inactive | 官方牌价×加成率(推算) / 未实测 | 否 / 否 |
