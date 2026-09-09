# 导演台站位/动作/镜头组合模版包（director-templates）

导演一键套用、agent 当数据/API 消费的「站位 + 姿势 + 机位」组合模版包。
模版源自《天尊》1289 镜真实分镜数据挖出的 11 个高频模式（T1–T11），
机位参数化数学借鉴 blockout（Apache-2.0）的 applyFraming 思路自行实现。

**署名声明**：Framing math adapted from [blockout](https://github.com/wassermanproductions/blockout) (Apache-2.0), © Sam Wasserman。
见其 `instantiate.ts` 文件头注释；仅借鉴参数化机位思路，坐标系与竖屏景别参数为本项目自定义。

## 目录与代码

- 模版数据：`assets/director/templates/*.json`（每条模版一个文件，`id` 与文件名一致）
- 模块代码：`src/modules/director/templates/`
  - `types.ts`：zod schema + 推导类型（模版、apply 请求、场景输出）
  - `registry.ts`：读目录加载全部模版（zod + 静态结构校验，损坏即 fail fast），`list/get`
  - `instantiate.ts`：origin + roleAssignments → 导演台场景 JSON（机位数学在此）
  - `validate.ts`：间距约束、keepSide 越轴、角色机位覆盖、景别距离合理性；实例化时自动执行
  - `routes.ts`：HTTP API
- 测试：`src/modules/director/templates/*.test.ts`

## 模版 schema

```jsonc
{
  "schemaVersion": 1,
  "id": "dialogue-reverse-2p",          // kebab-case，与文件名一致
  "name": "双人对话·内反打",
  "category": "dialogue",               // dialogue|confrontation|emotion|movement|action|establishing
  "tags": ["正反打", "近景", "对话"],
  "characterCount": 2,
  "mood": ["neutral", "tense"],          // 自由字符串，供检索/推荐
  "axisOfAction": { "from": "A", "to": "B" },  // 可选；OTS/REV/keepSide 需要
  "origin": { "x": 0, "z": 0, "headingDeg": 0 },  // 默认落位，apply 时可覆盖
  "characters": [
    {
      "role": "A",
      "offset": { "x": -0.55, "z": 0 },  // 模版本地坐标（米，地面 xz 平面）
      "facing": { "faceTo": "B" },        // 或 {"headingDeg": 135}（本地偏航角，0=+z，90=+x）
      "pose": { "preset": "stand" },      // 20 个预设之一
      "height": 1.7, "bodyType": "male", "color": "#4A82E1"
    }
  ],
  "constraints": {
    "spacing": [{ "between": ["A", "B"], "min": 0.9, "max": 1.5 }],
    "keepSide": true                      // 实例化校验全部机位在轴线同侧
  },
  "cameras": [ /* 2-6 条，见下 */ ],
  "moves": [ /* 可选：运镜意图，见「已知边界」 */ ],
  "promptHints": { "zh": "…", "en": "…" },
  "dataSource": "tianzun-master-table:T1"
}
```

pose 预设（20）：`stand tpose walk run sit squat kneelOne kneelBoth akimbo lean bow think fight kick throw push wave reach foldedArms phone`。
focalLength 只允许 `16/24/35/50/85`（与导演台机位契约一致）。景别 `EWS/WS/FS/MS/MCU/CU/ECU`。

### 机位类型

- `{"kind":"relational","relation":"single","subject":"A","side":"left","shotSize":"MCU","focalLength":50,"heightM":1.5,"sideBiasDeg":7}`
  单人构图。`distanceM` 可直接指定拍摄距离（优先于 shotSize 反推）；`visibleFraction`（跪姿 <1）、`targetHeightRatio`（默认 0.88 眼线）可调。
- `{"kind":"relational","relation":"OTS","near":"A","far":"B","side":"left","focalLength":50}`
  过肩。`backM`（默认 0.75）、`sideM`（默认 0.45）可调；`side` 相对模版动作轴线判定，保证双边 OTS 同侧。
- `{"kind":"relational","relation":"REV","mirrorOf":"A 近景"}`
  沿动作轴做轴向镜像（翻转轴向分量、保留侧向分量），自动同侧；roll 自动取反成对荷兰角；`focalLength` 可覆盖。
- `{"kind":"explicit","offset":{"x":0,"z":-3},"heightM":1.2,"lookAt":{"midpointOf":["A","B"],"heightRatio":0.6},"focalLength":35}`
  显式落位（offset 为模版本地坐标，随 origin/heading 变换）；`lookAt` 也支持 `{"role":"A","heightRatio":0.88}`。
- 所有机位可加 `rollDeg`（±45°）做荷兰角。

## 11 个内置模版（《天尊》T 编号）

| id | 名称 | 类别 | 人数 | 机位 | 关键参数 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| dialogue-reverse-2p | 双人对话·内反打 | dialogue | 2 | 4 | 间距 1.1m，MCU 50mm×2（REV 成对）+ OTS×2 | T1 |
| dialogue-ots-2p | 双人对话·外反打过肩 | dialogue | 2 | 3 | 间距 1.0m，OTS 50mm×2 + 35mm 双人 master | T2 |
| dialogue-2shot-2p | 双人中景同框 | dialogue | 2 | 2 | 并排 90° 斜对，2S 中景 35mm + 24mm 备用 | T3 |
| emotion-cu-1p | 单人特写·情绪反应 | emotion | 1 | 2 | CU 85mm 与眼平齐 + MCU 50mm 备用 | T4 |
| power-lowangle-1p | 威压·仰拍近景 | confrontation | 1 | 2 | 机高 1.15-1.2m 上仰，35/50mm，akimbo | T5 |
| submission-highangle-1p | 臣服·俯拍 | confrontation | 1 | 2 | 机高 1.9-2.2m 下俯，kneelBoth，35/24mm | T6 |
| pushin-2p | 情绪加压·缓推 | emotion | 2 | 4 | dolly 3.0m→1.2m 起止双机位×2（REV 成对），moves 记 dolly-in | T7 |
| follow-1p | 跟随移动·跟拍 | movement | 1 | 3 | 背后 1.6-2.0m、高 1.2-1.5m，35mm，walk | T8 |
| establishing-wide | 开场·俯拍全景缓降 | establishing | 2 | 2 | 高 4.0m 16mm + 落幅 1.9m 24mm，moves 记 crane-down | T9 |
| confront-triangle-3p | 三方对峙·三角站位 | confrontation | 3 | 4 | 两两 1.75-1.8m，master 35mm + OTS×2 + MCU | T10 |
| action-fastcut-2p | 打戏·近景快切 | action | 2 | 4 | fight 对峙，MCU 35mm 手持 + ±6° 荷兰角 + 24mm 环绕×2 | T11 |

T5 与 T6 可在同一场景两次 apply 组合成对峙权力轴（一方仰拍、一方俯拍）。

## API 契约

路由由导演台总插件 `registerDirectorRoutes`（`src/modules/director/routes.ts`）自带注册，
不再依赖中央路由与公开白名单。**全部接口要求登录**（AUTH-04 无匿名接口）：
请求头 `Authorization: Bearer <session-token>`，未登录或 token 失效一律 401 `unauthorized`。
错误统一返回 `{ok:false,error:{code,message,retryable,details}}`（全局错误处理器）。

> 注意：模版与场景 JSON 是导演台的 camelCase 数据契约，本组接口**不做**仓库其它接口的
> snake_case 转换，原样返回。

### GET /api/v1/director/templates

模版摘要列表。

```json
{ "ok": true, "data": { "templates": [
  { "id": "dialogue-reverse-2p", "name": "双人对话·内反打", "category": "dialogue",
    "tags": ["正反打", "近景", "对话"], "characterCount": 2, "mood": ["neutral", "tense"],
    "cameraCount": 4, "dataSource": "tianzun-master-table:T1" }
] } }
```

### GET /api/v1/director/templates/:id

完整模版 JSON（同 `assets/director/templates/<id>.json` 内容）。未知 id → 404。

### POST /api/v1/director/templates/:id/apply

实例化为导演台场景 JSON。

请求体（全部可选）：

```jsonc
{
  "origin": { "x": 2, "z": -1, "headingDeg": 30 },  // 部分字段可省，缺省用模版 origin
  "headingDeg": 30,                                  // 顶层 headingDeg 优先于 origin.headingDeg
  "roleAssignments": {
    "A": { "name": "天尊" },
    "B": { "name": "对手" }
  }
}
```

响应 200：

```jsonc
{
  "ok": true,
  "data": {
    "schemaVersion": 1,
    "templateId": "dialogue-reverse-2p",
    "templateName": "双人对话·内反打",
    "category": "dialogue",
    "applied": { "origin": { "x": 2, "z": -1, "headingDeg": 30 }, "roles": { "A": { "name": "天尊", "…": "…" } } },
    "objects": [
      { "id": "mannequin-A", "role": "A", "name": "天尊", "type": "mannequin",
        "bodyType": "male", "color": "#4A82E1", "height": 1.7,
        "pose": { "preset": "stand" }, "joints": null,
        "transform": { "position": { "x": 1.5237, "y": 0, "z": -0.725 },
                       "rotation": { "x": 0, "y": 120, "z": 0 },
                       "scale": { "x": 1, "y": 1, "z": 1 } } }
    ],
    "cameras": [
      { "id": "camera-1", "name": "A 近景", "type": "camera", "focalLength": 50,
        "target": { "x": 1.5237, "y": 1.496, "z": -0.725 },
        "transform": { "position": { "x": 3.7421, "y": 1.5, "z": -2.3967 } },
        "meta": { "kind": "relational", "relation": "single", "side": "left",
                  "shotSize": "MCU", "subjectRoles": ["A"] } }
    ],
    "axis": { "fromRole": "A", "toRole": "B", "from": { "x": 1.5237, "z": -0.725 }, "to": { "x": 2.4763, "z": -1.275 } },
    "moves": [ /* 模版有 moves 时透传 */ ],
    "promptHints": { "zh": "…", "en": "…" }
  }
}
```

错误码：

- 400 `invalid_request`：请求体字段类型不合法（zod）
- 401 `unauthorized`：未登录或 session 失效
- 404 `not_found`：模版 id 不存在
- 422 `template_apply_failed`：实例化校验失败——角色指派引用了不存在的 role、间距约束不满足、
  机位越轴/压线、角色未被任何机位覆盖、拍摄距离或机高超出合理范围、机位穿模

### agent 调用示例

```bash
TOKEN=<登录后签发的 session token>

# 1. 发现模版
curl -s -H "authorization: Bearer $TOKEN" localhost:3000/api/v1/director/templates \
  | jq '.data.templates[] | {id, name, characterCount}'

# 2. 取完整模版（拿 promptHints、默认参数）
curl -s -H "authorization: Bearer $TOKEN" localhost:3000/api/v1/director/templates/dialogue-reverse-2p

# 3. 实例化：落位到场景原点 (2,-1)，整体旋转 30°，指派角色
curl -s -X POST -H "authorization: Bearer $TOKEN" localhost:3000/api/v1/director/templates/dialogue-reverse-2p/apply \
  -H 'content-type: application/json' \
  -d '{"origin":{"x":2,"z":-1},"headingDeg":30,
       "roleAssignments":{"A":{"name":"天尊"},"B":{"name":"对手"}}}' \
| jq '.data.cameras[] | {name, position: .transform.position, target, focalLength}'
```

返回的 `objects`/`cameras` 可直接写入导演台场景（mannequin/camera 契约），
`promptHints.zh/en` 可拼接进 Seedance 等生视频提示词。

## 实例化数学（instantiate.ts）

世界坐标：y 向上、右手系、米制；模版本地坐标经 origin 平移 + headingDeg 绕 +Y 旋转：
`x' = x·cosθ + z·sinθ`，`z' = -x·sinθ + z·cosθ`（+90° 把 +x 转到 -z）。
朝向输出为角度制偏航（0 = +z，90 = +x），`faceTo` 由本地坐标方向角求得。

- **single**：沿「subject 朝向反方向（视线反向）+ side 侧偏」退距，注视眼线（默认 0.88×身高）。
  距离由景别反推：`vfov = 2·atan(18/focalLength)`（9:16 竖屏按传感器长边近似垂直视场），
  `距离 = (visibleFraction × height) / (2·tan(vfov/2) × fillFraction)`，
  fillFraction 表：EWS/WS/FS/MS/MCU/CU/ECU = 0.25/0.4/0.55/0.7/0.85/1.0/1.2（《天尊》拟合值）。
  side 侧偏角默认 6°（left 正、right 负）。
- **OTS**：近肩角色沿两人连线后退 0.75m（`backM`），再沿动作轴线 side 侧法向侧移 0.45m（`sideM`）；
  机高 0.92×near.height，注视 0.88×far.height。side 相对模版 `axisOfAction` 判定，双边 OTS 天然同侧。
- **REV**：关于两轴线角色中点做**轴向镜像**——只翻转平行于动作轴的分量，保留侧向分量，
  因此镜像机位仍在轴线同侧（不是点镜像，点镜像会越轴）；roll 自动取反。
- **explicit**：offset 经 origin/heading 变换；lookAt 支持单角色（heightRatio×身高）或两角色中点。

实例化自动校验（失败抛 422）：

1. `constraints.spacing` 全部满足；
2. `keepSide=true` 时所有机位（含 explicit）位于动作轴线同侧，relational 机位实际侧与声明 side 一致，压线即错；
3. 每个角色至少被一个机位覆盖（single=subject；OTS=near+far；REV=镜像对端角色；explicit=lookAt 角色）；
4. 机位—目标水平距离 ∈ [0.3, 30]m，机高 ∈ [0.05, 10]m，机位与非被摄角色水平距离 ≥ 0.25m（防穿模）。

## 已知边界

- **moves 只静态表达**：推镜/跟拍/环绕/缓降等运镜意图记录在模版 `moves` 字段（type +
  fromCamera/toCamera + note），一期只生成「起点」「终点」两个静态机位，没有时间线/关键帧；
  动作序列（出拳→格挡）与时间线属二期。
- **景别—距离公式是拟合近似**：vfov 按 `2·atan(18/focal)` 简化（未建模具体 CMOS 与 9:16 裁切），
  竖屏景别 fillFraction 为《天尊》统计经验值；对构图敏感时可用 `distanceM` 直接锁定距离。
- **joints 固定为 null**：实例化只输出 pose 预设 id，关节级姿态由导演台前端按 preset 展开。
- **角色碰撞检查较粗**：仅机位—角色防穿模（0.25m），未做角色—角色体积碰撞与遮挡分析。
- **rev 仅支持沿动作轴镜像**，不支持任意平面镜像；OTS/single 的 side 语义相对动作轴/主体朝向，
  无轴模版（1p 为主）不做 keepSide 校验。
- **模版本地编辑**：新增/修改模版只需改 `assets/director/templates/*.json`，registry 启动加载、
  fail fast；进程内缓存，改文件需重启生效（测试可用 `createTemplateRegistry(dir)` 指向临时目录）。
