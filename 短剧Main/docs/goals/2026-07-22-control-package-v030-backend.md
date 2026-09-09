# Sol Goal：控制包实体 + 0.3.0 后端

> 状态：`active`
> Owner：DC
> 后端执行：Sol
> 合同、集成与最终验收：Fable
> 前端联调：Kimi
> 基线：`origin/integration/v011@a01cd1d`
> 分支：`feature/v030-control-package-backend`

本目标取代原 W9-D。数据库生产治理优先；治理已在独立分支交付到当前授权边界，
资产写入和 wrapper 切换仍受各自闸门限制，不阻塞本目标的本地开发。

## 1. 真源与不变量

- 控制包：`docs/contracts/v0.1.1/control-package-and-lanes.md`。
- 控制资产：`docs/contracts/v0.1.1/control-asset-typing.md`。
- 结构化剧本：`docs/contracts/v0.1.1/structured-script-ir.md`。
- `control_package` 是粗剪素材的六参考栏容器；`control_board` 是可被挂入栏位的多格图像控制资产。
- PostgreSQL 是唯一业务事实源；生成提交仍是估价 -> 人工一次确认 -> 创建任务。
- 快速通道（无控制包的直接文生视频）永久合法。
- 本分支不 push、不部署、不触发付费调用。

## 2. A 轨：控制包实体（P0）

1. migration `013`：`control_packages` + `control_package_refs`，shot 一对一，六 lane，
   引用 `asset_media` 或 `media_results` 二选一，人工 ready 记 who/when 且可撤销。
2. 深模块封装权限、幂等挂载、空包响应、ready 语义和 lane 投影。
3. 实现冻结的 GET / PUT ready / POST refs / DELETE ref 路径；推荐要素不入库。

验收：

- migration 重复执行安全，约束与索引可以由真 PostgreSQL 测试证明；
- 四个端点覆盖未登录、越权、空包、正常、幂等、非法 lane/引用、ready 撤销；
- 公共接线行留给 Fable，不抢写 `src/http/routes.ts` 或已结号的 migration。

## 3. B 轨：两条任务创建链

1. 单个粗剪素材：现有生成提交可选接受 `control_package_id`，有包则组参考，无包照常提交。
2. 本集 ready 批量：仅对人工标记 ready 的 shots 估价，一次人工确认后依序创建；
   返回逐项成功/失败，不把部分成功写成全成功。

验收：未确认不产生任务；幂等重放不重复预留费用；快速通道有回归测试。

## 4. C 轨：生成能力解冻与 EDIT

1. 时长/画幅/分辨率改为模型能力档，先配置 Seedance 2.0 已知档；2.5 只预留适配窗。
2. 多路 image/video 参考按 `slots` + `usage_mode` 分流组包，provider 屏蔽供应商差异。
3. EDIT 接收 `{ir, prose, slots}`，校验后冻结 base 及全部引用版本，继续走付费两段式。
4. 与 Kimi 对拍 EDIT 和 `usage_mode` 透传。

## 5. D 轨：生产能力

1. 火山大模型 TTS：先勘察开通/计费/认证，再实现队列 -> TOS -> 声音参考资产；
   声音复刻只出结论。
2. 视频模型分 `cheap` / `premium`；cheap 只用于低成本抽运镜/动作参考，产物登记为
   `motion` / `camera_storyboard` 并挂回 reference_video lane。
3. 勘察 LAS 宫格拆分/超分；不可用或性价比不合格则用后端 sharp。
4. 宫格产物静默入库：`role=camera_storyboard`，不打断前端心流。

任何新付费 provider 在本地合同测试后，仍需 DC 单次确认才能真调用。

## 6. E 轨：PostgreSQL 14 / 16 定策

以生产 14.17 和本地 14.23 的 001--012 真迁移证据为基础，对比 16 的运维成本、升级风险和
实际所需功能，交一页结论。没有硬依赖不为“新”而升级。

## 7. S3 专业化改版后端配套（A 轨完成后）

1. 消耗逐笔明细：项目版与全局版分页端点，复用现有生成/助手任务事实，按用户项目权限过滤；
   `points` 严格按 `1 积分 = 1 分钱`，不另造换算。
2. 生成参数能力盘点：确认图片张数/画幅与视频时长/画幅在 quote、confirm、任务和 provider
   四层的真实支持范围；估价必须随有效参数变化。支持与不支持都形成可复核合同输入。
3. 配置槽位状态：只返回 image/video/llm/vector 是否配置及可公开模型名；永不返回密钥、
   环境变量名或连接细节，普通用户至多看到 configured。
4. 就绪标记不另起实现，直接复用 A 轨 `ready_marked_by` / `ready_marked_at` 和控制包端点。

本节排在治理收官和 A 轨之后；不与 A 的 migration、模块目录或路由施工并发。

## 8. 检查点与停止条件

- A 完成：交 feature 提交 + migration/API 测试 + 回执给 Fable，再接 B。
- B 首次生成任务前：只做无付费合同验证，不真提交。
- C 更改 provider 前：保留现有快速通道和 2.0 回归测试。
- D 供应商价格/能力未由官方证据证实：停在勘察，不猜 ID、价格或开通状态。
- 任何云写、部署、push、付费调用：停下等待当次明确授权。

## 9. 每轨完成门

```text
npm run check:architecture
npm run typecheck
npm test
npm run build
git diff --check
gitleaks git --staged --redact --no-banner
```

回执必须包含：分支/提交、文件与行为变化、数据/API/配置变化、验证命令与结果、
未验项、人工复验步骤、远程/付费/部署声明。
