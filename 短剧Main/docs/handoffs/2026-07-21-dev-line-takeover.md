# dev 线接管交接书（Fable → Sol）

Dario 2026-07-21 裁决：**integration/v011 为唯一产品主干，我们接管所有项目**。原 dev 线
（正式团队 4 人的 NestJS 后端）停止作为平行实现，其功能资产按域吸收进 v011。本文档是
接管的执行依据。

## 一、dev 线勘察结论（Fable 已实读代码）

- 位置：origin/dev，`backend/` NestJS monorepo（client-api :3000 `/api` + admin-api :3001
  `/admin-api` + background-worker），TypeORM + class-validator + Swagger，JWT+refresh，
  organization 多租户雏形。分叉点 3776782，与 v011 合同互斥（camelCase、projectCode、
  一段式生成、无付费确认）。
- 硬伤：**210 个生产文件 0 测试**；无付费红线与预算护栏；生成任务无 worker 轮询（客户端
  手动 refresh）；前端为空目录。
- 真货（按吸收优先级）：
  1. **admin 域**（users 16 端点、models 目录+时间界定价规则、projects/三媒生成管理）；
  2. **剧本拆解 logic**（`libs/scripts/src/logics/script-breakdown.logic.ts`，405 行：
     LLM client + 结构化校验 + run 跟踪 + 事务落库 + 项目级提示词实体）；
  3. 多供应商 adapter 思想（apimart/newapi/seedream 注册表，降低方舟单一依赖）；
  4. audio 域（elevenlabs 语音克隆+音色库）；
  5. organization 多租户。

## 二、接管纪律（重要）

- **dev 代码是参考素材，不是基线**：不 cherry-pick、不引入 NestJS/TypeORM 依赖；按
  功能面在 v011 栈（Fastify + drizzle + zod）重写，v011 门禁纪律全额适用（测试与
  风险相称、架构门禁、镜像门禁）。
- 0 测试的代码不作行为真源：以实读代码 + 其 Swagger 注解为需求线索，行为拿不准的
  在回执里列为「待与 dev 团队确认」，不猜。
- dev 分支与其火山流水线的冻结/改指向是组织动作，由 Dario 通知 dev 团队与唐震宇，
  不在本接管包内。

## 三、分期

- **第一期（Sol 本 goal）**：admin 域 v011 版 + 剧本拆解移植评估（详见 goal 文本）。
- 第二期（v0.1.2）：多供应商 adapter 层；admin 前端（Kimi）。
- 第三期（排片表节奏）：audio 域（v0.2+）、organization 多租户（v1.0 多角色片场）。

## 四、验收责任

Fable 验收：功能面对照表（dev 端点 → v011 端点映射齐全）、门禁全绿、真栈实测
（本机 8080）、admin 权限边界（ADMIN_USERNAMES 语义不被破坏）。
