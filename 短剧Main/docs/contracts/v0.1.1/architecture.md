# V0.1.1 统一架构合同

## 目标

V0.1.1 使用模块化单体快速上线：一个代码仓、一个 Node 应用进程、一个 RDS PostgreSQL
正式事实库、一个 VKE/VCI 应用工作负载。模块之间有清楚合同，但暂不拆微服务。

## 运行结构

```text
浏览器
  -> HTTPS ALB Ingress
  -> ClusterIP Service
  -> VCI Pod（shortdrama-prod）
       -> KMS initContainer（IRSA -> 内存 secret volume）
       -> React + Vite 静态前端 + Fastify API
            -> 业务模块
            -> Pi Agent Core（调用同一组应用工具）
            -> Drizzle -> RDS PostgreSQL 私网地址（正式事实）
            -> TOS（媒体文件）
            -> Milvus（可重建语义索引）
            -> 模型供应商适配层
```

## 生产部署边界

- 正式生产清单真源是 `deploy/k8s/`：namespace 固定 `shortdrama-prod`，应用使用一个 VCI
  `Deployment`、一个 `ClusterIP Service` 和 HTTPS ALB `Ingress`，入口不直暴露 Pod 或公网 IP。
- PostgreSQL 使用与 VKE 私网互通的云 RDS；VKE 内不创建 PostgreSQL、PVC、StatefulSet 或
  Caddy。RDS 是正式事实库，TLS 固定 `verify-full`。
- KMS initContainer 通过 VKE IRSA/OIDC 读取凭据 `shortdrama/prod/runtime`，将五项必需 secret
  写入 0600 的内存 `emptyDir`；应用容器只读挂载，不使用长期 AK/SK 或 Kubernetes Secret。
- Docker Compose、仓内 `db` 和 Caddy 只保留给本地开发与 dev/test 兼容验证；它们不能用于
  生产部署、生产回滚或 VKE 上线验收。
- 生产发布、回滚和证据门禁以 `docs/deploy/pipeline-guide.md`、`deploy/k8s/README.md` 与
  `deploy/k8s/verify-rendered.sh` 为准。

## 模块

- `auth`：账号、会话、角色、项目成员和动作权限。
- `projects`：项目、成员、责任分工和项目设置。
- `assets`：上传、解析、正式入库、版本、媒体和语义检索。
- `director`：3D 场景、镜头、对象绑定、快照与资产引用。
- `storyboard`：分镜的创建、导入、顺序和生产状态。
- `generation`：统一模型能力、人工提交、任务、版本、成本和重试入口。
- `assistant`：Pi 会话、工具调用、记忆和建议；不另建业务事实。
- `delivery`：主版本、连播、交付清单和人工判定。
- `dashboard`：后台统计；不是一线人员的主要工作入口。

## 依赖方向

```text
HTTP/UI -> application service -> domain rule -> port
                                           -> repository/integration adapter
```

业务模块不能依赖具体模型 SDK。Pi 工具与页面调用同一 application service，不能绕过权限、预算、幂等和审计。

## 正式事实与投影

- PostgreSQL：所有可追责状态和关系。
- TOS：媒体二进制；数据库保存对象标识、哈希、状态和权限信息。
- Milvus：从 PostgreSQL 派生的向量索引。删除后可重建，不允许成为唯一数据源。
- Pi 记忆：通过稳定接口保存，项目知识、用户偏好和短期会话分开；不能覆盖产品正式事实。

## 明确不做

- 不拆微服务，不引入消息中间件集群。
- 不把旧仓数据库或认证方式并入生产。
- 不把供应商原始响应直接传给页面。
- 不为了未来规模提前建设多运行时、多调度器或第二套 Agent 框架。

### 例外条款(Fable 裁决,2026-07-27;同日按 DC 口径修订)

- **S53 pi-web 观察通道**:ECS 上**既有**的开发用 Pi 实例(济平部署,非本产品运行时,
  不在 V0.1.1 部署边界内)允许加账密+IP 白名单(其服务端口仅放行
  `114.240.48.242/32` 与 `23.224.141.167/32`)后暴露 web 页,供 DC 查看 skills/插件
  与监控 agent 效果。硬边界:不新装第二套运行时、不接产品数据库/产品密钥、不承载
  业务流量;该实例若被并入产品流程,本例外即失效,须重新裁决。
