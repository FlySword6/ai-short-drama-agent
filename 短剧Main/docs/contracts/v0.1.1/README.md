# V0.1.1 开发合同索引

本目录保存必须与代码同版本交付的执行合同。完整产品讨论、原型和长期路线在 `zhongwen-shortdrama-context` 仓库；实现代理不需要加载全部历史，只需读取本索引和任务相关文件。

## 必读顺序

1. 仓库根目录 `AGENTS.md`：不可绕过的开发边界。
2. `PRODUCT.md`：V0.1.1 用户价值、范围和行为原则。
3. `architecture.md`：统一技术栈、模块边界和部署形态。
4. 按任务选择：
   - 配置、密钥或发布：`config-and-secrets.md`
   - 数据、接口或企业微信登录：`api-and-data.md`
   - 模型、Pi 或生成：`model-and-paid-task.md`
   - 页面：`DESIGN.md` 与 `../v0.1/design-system.md`
   - 测试和交付：`testing-and-acceptance.md`
   - 多代理协作：`branching-and-handoffs.md`

## 外部真源

以下文件位于 context 仓，是当前有效的导航和跨仓依据；实现前按 `docs/index.md` 的加载分层选择，不得把旧路径或全仓扫描当作启动真源：

- `docs/index.md`：context 加载分层与任务路由。
- `CONTEXT.md`、`CONTEXT-MAP.md`：词汇、现行口径与权威来源导航。
- `docs/specs/spec-ai-shortdrama-production-platform-prd-v1-2026-07-06.md`：当前产品 PRD；其中企业微信切片按下方 2026-08-20 裁决更新。
- `docs/contracts/zhongwen-shortdrama-data-contract-v1.md`：跨仓数据合同。
- `docs/specs/spec-architecture.md`：context 架构总览；代码实现仍以本仓合同为准。

## 变更规则

- 需求变更原则上先更新 context 仓的 PRD/决策，再同步本目录。若当前产品权威明确批准、且当前任务只授权修改本仓，必须在本目录点名被替代的 context 条款和生效范围；该旧条款自裁决起不再是活动真源，context 同步作为同一工作项的文档对账，不得反向否定已批准合同。
- 技术实现不能反向修改产品含义。
- 供应商模型 ID 可以在适配层更新，但产品能力、手动付费边界和正式事实来源不得静默变化。
- 合同变更与实现变更分开提交，便于判断是规则改变还是代码偏离。

### 2026-08-20 企业微信登录裁决

2026-08-20 已批准 v0.4.0 增加单企业企业微信内部成员登录。context 仓 `docs/specs/spec-prd.md` 中“v1 不实现 Feishu/WeCom SSO”的条款在本产品切片上立即退役，不再是活动真源；详细产品、API/数据、密钥与测试合同以本目录和 `PRODUCT.md` 为准。context 同步列入企业微信工作项 W0，并在最终接受前完成，但它是文档对账，不是再次审批。

## 正式生产部署真源

2026-07-21 批准的新版五项目标已取代单 ECS/Compose 生产部署目标。V0.1.1 正式生产固定为
VKE `shortdrama-prod` + VCI `Deployment` + HTTPS ALB `Ingress` + 私网 RDS PostgreSQL +
KMS/IRSA initContainer。部署细节以 `architecture.md`、`config-and-secrets.md`、
`deploy/k8s/README.md` 和 `docs/deploy/pipeline-guide.md` 为准；Docker Compose 只用于本地开发
和 dev/test，不得作为生产真源或上线证据。

## 被替代的旧口径

`docs/contracts/v0.1/api.md`、`data-model.md` 和 `runtime.md` 仍用于解释当前 V0.1 代码，但其中“小龙虾”、强制逐次报价确认、旧 11 步旅程、旧模型范围和 ECS/Compose 生产部署不再定义 V0.1.1 产品。新实现以本目录为准；兼容旧接口或 Compose dev/test 时必须把兼容层与正式生产合同分开。
