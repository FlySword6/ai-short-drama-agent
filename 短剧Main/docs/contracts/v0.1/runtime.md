# V0.1 运行合同

状态：冻结第一版。

## 单体边界

同一个 Node 进程承担：

1. Fastify API。
2. Vite 构建后的网页静态文件。
3. Pi Agent 会话和流式输出。
4. 数据库驱动的生成任务轮询。

外部依赖保持为 PostgreSQL、TOS、Milvus 和方舟。V0.1 不增加消息队列和独立微服务。

## 启动和任务恢复

- 应用启动完成后扫描 `pending/running` 任务。
- `pending` 且没有 `provider_task_id`：检查付费预留和幂等记录后再提交。
- `running` 且有 `provider_task_id`：继续查询同一远端任务，不能重新提交。
- `provider_succeeded/persisting`：继续完成媒体转存。
- `submitting` 且没有远端任务号：标记 `SUBMISSION_OUTCOME_UNKNOWN`，禁止自动再次付费提交。
- 查询使用数据库租约和 `FOR UPDATE SKIP LOCKED` 领取到期尝试，避免并行重复处理。
- 正常关闭时停止领取新任务；已经落库的任务由下次启动恢复。

## 方舟和媒体持久化

- 方舟是 V0.1 默认生成提供方。
- 图片生成固定使用 `doubao-seedream-5-0-260128`，参数为 `2K`、1 张、不加水印、不连续生图。为兼容已冻结的网页和 CLI 调用，`ratio=16:9`、`resolution=2K` 和 `size=2K` 视为同一组参数，统一变成方舟的 `size=2K`。其他比例、非 `2K` 分辨率、随机种子或其他参数在调用方舟前拒绝。
- 视频生成固定使用 `doubao-seedance-2-0-fast-260128`，参数为 `720p`、`9:16`、4 秒、不加水印，且不接受输入视频。分辨率、比例、时长或随机种子不符合时，在调用方舟前拒绝。
- 多图参考默认标记为 `reference_image`，最多 9 张。只有明确标记的素材才作为 `first_frame` 或 `last_frame`，不猜测首尾帧。参考音频标记为 `reference_audio`，最多 3 段，且不能单独使用。
- 图片返回的 `usage.generated_images`、`usage.output_tokens`、`usage.total_tokens`，以及视频返回的 `usage.completion_tokens`、`usage.total_tokens` 保存在提供方结果快照中。
- 即使 HTTP 状态是 200，只要图片返回的 `data[].error` 有错误，仍按已知失败处理，不把它当成成功。
- 图片和视频返回的临时 URL 不能作为最终媒体地址。
- 成功流程固定为：读取远端结果 -> 下载字节 -> 上传 TOS -> 写 `media_results` -> 写费用记录 -> 任务改为 `succeeded`。
- TOS 路径固定为：

```text
projects/{project_id}/shots/{shot_id}/{media_kind}/{task_id}/{result_index}.{ext}
```

- 下载、连播和交付清单只读 TOS 永久地址。

## 付费闸门

- `ALLOW_PAID_GENERATION=false` 是默认值。
- `PAID_GENERATION_BUDGET_FEN=0` 是默认值；本次真实验收的绝对上限为 `500000`（5000 元），任何运行配置都不得超过它。
- 实际可用额度取 `PAID_GENERATION_BUDGET_FEN` 和 `PAID_GENERATION_REVIEW_THRESHOLD_FEN` 中较小的值。每一步只设置足够完成下一次最低成本验收的额度；如果确需使用更高区间，两个值都要显式调整，但都不得超过 500000。
- 提交前计算“已预留金额 + 本次预估金额”。超过预算直接返回 `402 BUDGET_EXCEEDED`，不调用方舟。
- 5000 元只是总上限，不是应花金额或自动放行额度。先做一次最低成本真实图片验收，确认结果已转存 TOS 且可访问后，再决定是否做一次 4 秒视频；每次调用仍需新报价和明确确认。
- 如果缺少可追溯单价或无法估算费用，拒绝付费提交。

## 登录和权限

- token 只在登录响应返回明文，数据库只存 SHA-256 哈希。
- 密码使用 Node `crypto.scrypt` 加随机 salt，不新增外部认证服务。
- 所有业务路由通过统一 Fastify `preHandler` 读取当前用户。
- 健康检查、Swagger 文档、注册和登录是仅有的公开路径。
- 资产检索、项目、任务、下载和小龙虾工具都在服务端执行所有权检查。

## Docker

- 构建阶段编译前端和后端。
- 运行阶段只包含生产依赖、编译产物和必要运行目录。
- 配置通过运行时环境变量提供，不把 `.env` 放进镜像。
- 容器对外只开放一个端口，默认 `8000`。
- 健康检查调用 `/api/v1/health`。

## 预估费用

- 单价来自 `unit_prices`，必须保存来源、计费单位和生效时间。
- 每次生成尝试保存模型、参数、数量、单价快照、预估金额和真实费用可用状态。
- 看板只聚合 `generation_attempts.estimated_cost_fen`。
- 页面固定显示“预估费用，非云平台实际账单”。
- V0.1 图片固定使用 `doubao-seedream-5-0-260128`。按 2026-07-15 官方公开价和当前账号控制面取较高值，保守冻结为 22 分/张，计费单位为 `image`；1 张报价 22 分。
- 图片模型、接入点映射或官方价格变化时，必须先重新核价并更新单价。旧报价返回 `quote_stale`，不得按旧价格提交。
- V0.1 视频费用只适用于上述无输入视频的固定参数。方舟公式预估为 86,400 token，按 37 元/百万 token 约为 319.68 分；系统向上冻结为 80 分/秒，4 秒报价 320 分。
- 视频单价低于 80 分/秒、计费单位不是 `second`，或生成参数离开冻结值时，服务端拒绝产生报价和付费任务。
- 报价快照同时保存合同版本、固定参数、方舟单价和估算 token，便于事后核对。
- 参数和数量在创建报价前就完成规范化和校验；同一份合同还会在计费和方舟提交边界再检查一次。因此不支持的参数不会先产生可确认报价，再等 Worker 提交时失败。

## 一次性报价和提交

- 每次付费提交都必须使用未过期的一次性 `generation_quote_id`。报价绑定当前用户、`web/assistant/cli` 来源、`submit/retry` 操作、完整规范化输入和当时的价格快照。
- 网页只有在用户点击确认按钮后才提交。助手页面只回传报价 ID；服务端从报价单的冻结快照恢复模型、提示词、参数、引用素材、项目和分镜，不让浏览器或新的模型轮次改写付费输入。
- 网页和 CLI 再次传入输入时，服务端仍以冻结快照为准并严格比对；输入变化时拒绝提交。
- `web`、`assistant` 和 `cli` 报价不能串用。来源不一致时返回 `409 GENERATION_QUOTE_SOURCE_MISMATCH`，不消费报价、不创建任务。
- 同一报价只绑定一个 attempt，并使用稳定幂等键。重复点击或重复请求返回第一次绑定的 attempt，不重复排队、不重复预留费用。

## 付费提交和 Worker 就绪条件

网页、助手和 CLI 在创建 `pending` attempt 前，以及应用启动付费生成 Worker 前，都必须确认下列值已经配置：

- `ARK_API_KEY`
- `TOS_BUCKET`
- `TOS_ENDPOINT` 或 `TOS_SDK_ENDPOINT`
- `TOS_ACCESS_KEY`
- `TOS_SECRET_KEY`
- `TOS_PUBLIC_BASE_URL`

`TOS_PUBLIC_BASE_URL` 必须明确填写，不再以上传接口地址代替。这能避免生成成功后写入一个使用者无法访问的媒体地址。

付费开关关闭时返回 `403 paid_generation_disabled`。Ark、TOS 或公网地址配置不完整时返回 `503 generation_service_unavailable`。两种情况都不能创建 `pending` attempt；补齐配置后也不会自动执行之前被拒绝的请求，调用方必须重新提交有效报价。

这个闸门只检查提交前配置是否齐全，不证明凭据有效、网络可达或 TOS 公网地址能被验收设备访问；这些仍属于最低成本真实验收范围。

## 并行修改边界

以下文件由主集成分支单一写者维护：

- `migrations/`
- `src/db/schema.ts`
- `src/config/env.ts`
- `src/app.ts`
- 根 `package.json` 和 `package-lock.json`
- 路由总入口

各功能模块使用独立路由、仓储和服务文件。子分支不得自行改变已经冻结的字段名、状态值或错误格式；确需修改时先在主集成分支更新合同。
