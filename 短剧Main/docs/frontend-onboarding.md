# 前端新人上手指南（中文短剧 RAG 平台）

> 写给刚接手本项目的前端工程师。读完这一份，你能把项目跑起来、找到自己要改的页面，并完全理解一次“点按钮 → 看到结果”中间前后端发生了什么。
>
> 本文档基于仓库实际代码编写，关键结论都标注了源文件位置，可自行核对。
> 最后更新：2026-08-04。

---

## 0. 一句话理解这个项目

这是「中文在线 AI 短剧平台」的**全栈 TypeScript 单体应用**：一个 Node（Fastify）后端 + 一个 React（Vite）前端，前后端在同一个 Node 进程里对外提供服务。核心能力是：把短剧的**人设/场景资产**入库、用**自然语言做语义检索**、在**项目→集→分镜**的流水线里**生图/生视频/生音频**，并用一个 **3D 导演台**做镜头编排。

技术栈一句话：**Fastify + Drizzle + PostgreSQL**（后端）／**React 19 + Vite + Tailwind v4 + Zustand + Three.js**（前端），外加火山引擎全家桶（方舟 Ark / 豆包 / TOS 对象存储 / Milvus 向量库）。

---

## 1. 技术栈总览

### 前端（`frontend/shortdrama-rag-demo/`）
| 关注点 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | **React 19** + **TypeScript 5** | 见 `frontend/shortdrama-rag-demo/package.json` |
| 构建 | **Vite 7** | dev server 默认 **5173**，见 `vite.config.ts` |
| 样式 | **Tailwind CSS v4**（`@tailwindcss/vite` 插件） | 设计 token 在 `src/styles/tokens.css`、`ui-base.css` |
| 组件库 | **Radix UI**（dialog/dropdown/popover/tabs/tooltip）+ `@phosphor-icons/react` | 无头组件 + 图标 |
| 3D | **three.js + @react-three/fiber + @react-three/drei** | 3D 导演台（director） |
| 状态 | **Zustand** | 轻量全局状态 |
| 图表 | **ECharts** | 成本/消耗图表 |
| 动画 | **GSAP** | |

### 后端（`src/`）
| 关注点 | 选型 | 说明 |
| --- | --- | --- |
| Web 框架 | **Fastify 5** | `src/app.ts` 创建实例 |
| 语言 | **TypeScript 5**（NodeNext，strict） | `tsconfig.json` |
| 运行 | **Node.js 22.19**（`tsx` 跑 dev，`dist/server.js` 跑 prod） | `package.json` engines |
| 校验 | **Zod 4** | 每个 route 入口用 `parseRequest` |
| 数据库 | **PostgreSQL 14** + **Drizzle ORM** | `src/db/` |
| 向量库 | **Milvus**（可重建投影，**PostgreSQL 是正式事实**，Milvus 不可用时走 PG 降级） | `src/integrations/milvusVectorStore.ts` |
| 对象存储 | **火山 TOS** | `src/integrations/tosStorage.ts` |
| 模型 | **火山方舟 Ark / 豆包**（LLM、Embedding、Vision、生图、生视频、TTS） | `src/integrations/` |
| 文档 | **Swagger / OpenAPI** | 在线页 `/docs` |
| Agent | **Pi Agent Core**（嵌入同进程，不拆第二套运行时） | AI 助手 |

### 部署
- **本地/dev/test**：Docker Compose（`compose.yaml`：app + postgres + caddy）。
- **正式生产**：火山 VKE/VCI 的单 `Deployment` + 私网 RDS PostgreSQL，不用仓内 Compose（见 `AGENTS.md` §2）。

---

## 2. 仓库目录结构（前端视角，只看你需要知道的）

```
zhongwen-shortdrama-main/
├── src/                          # 后端全部代码（TypeScript）
│   ├── server.ts                 # ★ 生产入口：启动自检 → 连库探测 → createApp → listen(8000)
│   ├── app.ts                    # ★ Fastify 应用工厂：注册插件/鉴权/路由/前端静态托管
│   ├── config/env.ts             # 环境变量集中读取（对齐 .env.example）
│   ├── http/
│   │   ├── routes.ts             # ★ 所有模块路由的挂载总表（看这里找接口在哪个模块）
│   │   ├── authenticate.ts       # ★ Bearer Token 鉴权 hook（preHandler）
│   │   ├── response.ts           # ★ 成功信封 success() + 递归转 snake_case
│   │   └── errorResponse.ts      # ★ 错误信封统一格式
│   ├── modules/                  # ★★ 按业务域拆的模块（每个模块自带 routes/service/repository/types）
│   │   ├── auth/  assets/  production/  generation/  storyboard/  director/
│   │   ├── assistant/  reviews/  delivery/  dashboard/  trash/  audio/
│   │   ├── admin/  operations/  account-credits/  ai/  ...
│   ├── services/  repositories/  integrations/  db/  domain/
├── frontend/shortdrama-rag-demo/ # ★★ 前端全部代码（独立 npm workspace）
│   ├── index.html                # 入口 HTML（挂 #root，加载 app.tsx）
│   ├── vite.config.ts            # ★ dev proxy：/api → localhost:8000
│   ├── package.json              # 前端独立依赖
│   └── src/
│       ├── app.tsx               # ★ 前端根组件（视图切换 / 全局布局在这里）
│       ├── api.ts                # ★★ ApiClient：封装所有后端调用（2342 行，是前端→后端的唯一大门）
│       ├── auth-token.ts         # ★ token 存取（sessionStorage）
│       ├── types.ts              # 前端领域类型（camelCase）
│       ├── operations.ts  review-delivery.ts  release-plan.ts ...  # 各功能域的响应归一 mapper
│       ├── agent-stream.ts       # AI 助手 SSE 流解析
│       ├── components/           # ★★ UI 组件（director/ 子目录是 3D 导演台）
│       │   ├── app-rail.tsx      #   侧边导航栏
│       │   ├── command-palette.tsx # ⌘K 命令面板
│       │   ├── director/         #   3D 导演台（Three.js）
│       │   └── ...
│       └── styles/               # tokens.css / ui-base.css
├── migrations/                   # 数据库迁移（SQL，按编号顺序）
├── scripts/                      # dev-up / dev-reset / 迁移 / e2e 等脚本
├── docs/                         # 合同/设计/提案文档（本文件就在这里）
├── compose.yaml                  # 容器栈（app+db+caddy，本地/dev/test）
├── docker-compose.dev.yml        # 只起本地 PG14（开发用）
├── Dockerfile                    # 多阶段构建：build(前端+tsc) → runtime(node dist/server.js)
├── .env.example                  # ★ 环境变量模板（字段和 src/config/env.ts 逐项对齐）
├── package.json                  # ★ 根 package.json（workspaces 含前端）
├── AGENTS.md                     # ★★ 开发强制规则（开工必读）
├── API.md                        # 资产入库/检索接口契约
└── README.md                     # 项目总览
```

> 标 ★ 的是你日常最常打交道的文件。

---

## 3. 怎么启动（最关键，务必看懂）

### 3.1 前置依赖
- **Node.js ≥ 22.19**（必须，`package.json` engines 卡死）
- **npm**（随 Node）
- **Docker Desktop**（用来跑本地 PostgreSQL；应用本身不放进容器跑，方便热重载）
- 一份 `.env`（没有的话脚本会自动从 `.env.example` 复制）

### 3.2 两条命令把环境起到“能登录”

在**仓库根目录**执行：

```powershell
npm install         # 安装依赖（根 + 前端 workspace 一起装）
npm run dev:up      # 一条命令：起本地 PG14 → 跑迁移 → 建 Day-0 管理员 → 播种演示数据
```

`npm run dev:up`（`scripts/dev-up.mts`）做了 4 件事，**幂等、可反复执行**：
1. 用 `docker-compose.dev.yml` 起一个本地 **PostgreSQL 14**（含 `pg_trgm` 扩展，端口默认 5432）；
2. 跑数据库迁移 `001 → 最新`；
3. 建 Day-0 管理员（用户名取 `.env` 的 `ADMIN_USERNAMES` 第一个，默认 `admin`；密码取 `DEV_ADMIN_PASSWORD`）；
4. 播种最小演示数据。

> ⚠️ 它有护栏：检测到数据库指向**云端 RDS**会直接拒绝，不会误连生产。
> **Milvus 故意不起**——dev 下语义检索自动走 **PostgreSQL 降级路径**，向量检索照样能跑。
> 想推倒重来：`npm run dev:reset`。

如果你 `dev:up` 时报 “请先在 .env 配置 DEV_ADMIN_PASSWORD”，说明 `.env` 里这项是空的，去 `.env` 填一个 ≥8 位密码再跑。

### 3.3 启动应用（后端，端口 8000）

```powershell
npm run dev        # 实际执行：tsx scripts/dev-guard.mts && tsx watch src/server.ts
```

- `tsx watch` 会**热重载**后端代码。
- 启动时 `src/server.ts` 会做 **fail-fast 自检**：数据库配置不全 / 连不上 / 认证失败 → 直接退出，不会“假装健康”。
- 成功后监听 `http://127.0.0.1:8000`（`HOST`/`PORT` 来自 `.env`，默认 `127.0.0.1:8000`）。

### 3.4 ★ 前端怎么起？两种开发模式

这是新人最容易卡的地方。项目有**两种**前端开发姿势，按你的任务选：

**模式 A —— 只看效果 / 改后端（够用，无前端热重载）**
- 只要 `npm run dev` 起了后端 8000；
- 先 `npm run build:frontend` 把前端构建成静态产物（输出到 `frontend/shortdrama-rag-demo/dist`）；
- 浏览器开 **`http://localhost:8000`** —— 后端 Fastify 会**同源伺服**前端 `dist`（见 `src/app.ts` 第 86–103 行的 `@fastify/static` + SPA fallback）。
- 缺点：改前端代码后要重新 `build:frontend` 才能看到变化。

**模式 B —— 做前端开发（推荐，有 Vite 热重载）**
开**两个终端**：
```powershell
# 终端 1：后端 API（8000）
npm run dev

# 终端 2：前端 Vite dev server（5173）
cd frontend/shortdrama-rag-demo
npm run dev        # vite，默认 5173，host 0.0.0.0（局域网/手机可访问）
```
浏览器开 **`http://localhost:5173`**。

> 为什么这样？看 `frontend/shortdrama-rag-demo/vite.config.ts`：
> - 前端所有请求走**同源相对路径** `/api/v1/...`（生产时由后端容器同源伺服）；
> - dev 下 Vite 把 **`/api` 代理到 `http://localhost:8000`**（可用 `SHORTDRAMA_DEV_API` 环境变量改目标）；
> - 还把 **`/tos-public` 代理到 TOS 桶**（绕开 TOS 未配 CORS 时的跨域读像素问题）。
>
> 所以在 5173 调前端、请求自动转发给 8000 后端，**改前端代码秒级热更新**，改后端代码由终端 1 的 `tsx watch` 重启。

### 3.5 登录
- 地址：`http://localhost:8000`（模式 A）或 `http://localhost:5173`（模式 B）
- 账号：`admin`（或 `.env` 里 `ADMIN_USERNAMES` 的第一个）
- 密码：`.env` 里的 `DEV_ADMIN_PASSWORD`
- 登录成功后会拿到一个 Bearer Token，前端存进 `sessionStorage`（见第 4 节）。

### 3.6 常用脚本速查（根 `package.json`）
| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 起/热重载后端（8000） |
| `npm run dev:up` | 一键起本地 PG + 迁移 + 建管理员 + 播种 |
| `npm run dev:down` | 停本地 PG |
| `npm run dev:reset` | 清空本地 PG 数据卷重来 |
| `npm run dev:seed` | 重新播种演示数据 |
| `npm run build` | 构建前端 + `tsc` 编译后端到 `dist/` |
| `npm run build:frontend` | 只构建前端 |
| `npm run db:migrate` | 跑数据库迁移（需先 `build`） |
| `npm run typecheck` | 类型检查（前后端都查） |
| `npm run check:architecture` | 架构门禁（`prebuild`/`pretypecheck` 会自动跑） |
| `npm test` | 全量测试套件 |
| `npm start` | 生产运行 `node dist/server.js` |

---

## 4. ★★ 前后端到底怎么交互（核心章节）

这一节回答：你在浏览器点了一个按钮，数据是怎么跑到后端、又怎么回来的。

### 4.1 端口与代理关系

```
开发（模式 B）：
  浏览器 ──http://localhost:5173──> Vite dev server ──/api 代理──> Fastify(8000) ──> PostgreSQL
                                   └─/tos-public 代理──> TOS 桶

开发（模式 A）/ 生产：
  浏览器 ──http://localhost:8000──> Fastify(8000)
                                    ├─ /api/v1/*  → 业务接口
                                    ├─ /docs      → Swagger UI
                                    └─ /*         → 前端 dist 静态文件（SPA fallback 到 index.html）
```

生产还有一层 Caddy 反向代理（`deploy/Caddyfile`）：外部 `:80` → 容器内 `app:8000`，并加安全头、对 `/assets/*` 静态资源设长缓存。

### 4.2 所有请求都经过同一个门：`ApiClient`

前端**所有**后端调用都走 `frontend/shortdrama-rag-demo/src/api.ts` 里的 `ApiClient` 类。它的核心方法 `request<T>()`（`api.ts` 第 689 行）做这几件事：

```ts
const API_PREFIX = "/api/v1";

async request<T>(path, init) {
  const headers = new Headers(init.headers);
  const token = this.getToken();                       // 从 sessionStorage 读
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (有 body 且非 FormData) headers.set("Content-Type", "application/json");

  const response = await fetch(`${API_PREFIX}${path}`, { ...init, headers });
  // ↑ 注意：相对路径！dev 下被 Vite 代理到 8000，prod 下同源直连

  if (!response.ok) throw await parseFailure(response); // 错误信封 → ApiClientError
  if (response.status === 204) return undefined;
  const body = await response.json();
  // 后端统一用 { ok: true, data } 信封，这里拆出 data：
  if (body.ok === true) return body.data;
  return body;
}
```

要点：
- **前缀统一 `/api/v1`**，后端所有业务接口都挂在这个前缀下（见 `src/http/routes.ts`）。
- **用相对路径**，因此 dev/prod 都不需要在前端配置后端地址——dev 靠 Vite proxy，prod 靠同源。
- **Token 自动带**：`Authorization: Bearer <token>`。
- **JSON 自动加 `Content-Type: application/json`**；`FormData`（文件上传）不加，让浏览器自己设 boundary。

### 4.3 Token 与鉴权流程

**Token 存哪**：`sessionStorage`，key = `shortdrama_v01_token`（`frontend/shortdrama-rag-demo/src/auth-token.ts`）。
> 注意是 `sessionStorage`（关标签页即失效），不是 `localStorage`，也不是 Cookie。

**鉴权流程**（后端 `src/http/authenticate.ts`）：
1. 后端注册了一个全局 **`preHandler` 钩子**，对**所有** `/api/v1/*` 请求生效。
2. 钩子先排除：`OPTIONS` 预检、以及一组**公开路由**（无需登录就能访问）：
   - `GET /api/v1/health`、`GET /api/v1/ready`（健康/就绪探针）
   - `POST /api/v1/auth/register`（注册）
   - `POST /api/v1/auth/email-verification-codes`（取验证码）
   - `POST /api/v1/auth/login`（登录）
   - `POST /api/v1/auth/cli/login`（CLI 登录）
3. 其余请求**必须带** `Authorization: Bearer <token>`，否则抛 `401 Unauthorized`。
4. 钩子用 `AuthService` 校验 token、载入用户，挂到 `request.authUser` 上，后续 handler 用 `requireCurrentUser(request)` 取当前用户。

**前端的 401 处理**（`api.ts` `handleUnauthorized`）：
- 收到 `401` 且不是登录/注册接口本身 → 清掉 `sessionStorage` 里的 token；
- 派发一个浏览器事件 `shortdrama:unauthorized`；
- App 层监听这个事件，把页面跳回**登录页**。
- 所以 token 一过期，用户会自动被弹回登录页。

**登录拿 token**：`ApiClient.login(username, password)` → `POST /api/v1/auth/login` → 返回 `{ token, expires_at, user }`，前端 `setToken(token)` 存起来。会话有效期默认 7 天（`.env` 的 `SESSION_TTL_HOURS=168`）。

### 4.4 响应数据约定（最容易踩坑的地方 ★）

**成功响应**统一是这样一个信封（后端 `src/http/response.ts`）：
```ts
success(data) => { ok: true, data: toSnakeCaseJson(data) }
```
两个关键点：
1. 外层永远是 `{ ok: true, data: ... }`，前端 `request()` 会自动拆掉外层，组件拿到的就是 `data`。
2. **`data` 里的所有 key 都被递归转成了 `snake_case`**（`toSnakeCaseJson` 把 `displayName` → `display_name`）。这是后端给前端的“冻结契约”——wire 上**永远是 snake_case**。

**而前端的 TypeScript 类型（`types.ts`）是 `camelCase`**。中间靠 `api.ts` 里大量 `xxxFromUnknown` 映射函数做归一，例如：
```ts
export function assetFromUnknown(value: unknown): Asset {
  // 同时读 snake 和 camel 两种 key，输出统一的 camelCase Asset
  display_name: optionalString(firstValue(value, "display_name", "displayName")),
  ...
}
```
> 👉 **给你改前端时的硬规则**：消费后端数据时，**不要直接 `res.foo_bar`**，要么走 `api.ts` 里已有的 `xxxFromUnknown` mapper，要么新增一个。组件层只认 camelCase 类型。wire 是 snake，前端类型是 camel，mapper 是唯一的桥。

**错误响应**统一是（后端 `src/http/errorResponse.ts`）：
```json
{ "ok": false, "error": { "code": "forbidden", "message": "这个账号没有所需权限。", "retryable": false, "details": null } }
```
- 后端对框架自带的 4xx 错误**不信任原始 message**（可能泄露 HTTP 码/路径/字段名），会替换成固定中文提示，按状态码映射 `code`：
  - `401 unauthorized` / `403 forbidden` / `404 not_found` / `409 conflict` / `413 payload_too_large` / `415 unsupported_media_type` / `422 unprocessable_entity` / `429 too_many_requests` 等。
- 业务自己抛的 `AppError` 保留原始 `code/message/details`（如 `scene_version_conflict`、`deliverable_not_ready`）。
- 前端 `parseFailure()` 把它包成 **`ApiClientError`**（带 `status`/`code`/`retryable`/`details`）抛出，组件用 `try/catch` 接。

### 4.5 文件上传

走 `multipart/form-data`。后端 `src/app.ts` 注册了 `@fastify/multipart`，限制 **单文件 ≤ 100MB、最多 1 个文件**。

前端示例（`api.ts` `uploadAsset`）：
```ts
const form = new FormData();
form.append("file", file);
if (sourceProjectName) form.append("source_project_name", sourceProjectName);
const result = await this.request("/asset-ingest/upload", { method: "POST", body: form });
// FormData 不手动设 Content-Type，浏览器自动加 boundary
```

**图片上传是异步队列**：`POST /api/v1/asset-upload-tasks` 提交后立即返回 `202`（任务 id），真正的“视觉识别 + 上 TOS + 写库 + 同步向量”在后台 worker（`AssetUploadWorker`）里跑，完成/失败通过**站内提醒**（`/asset-upload-notifications`）推送，关窗不丢任务。

### 4.6 AI 助手：SSE 流式响应

AI 助手（`/agent/sessions/...`）用 **Server-Sent Events** 流式返回，前端 `streamAgentMessage()`（`api.ts` 第 1819 行）用 `fetch` + `response.body.getReader()` 手动读 `text/event-stream`，逐帧解析（`agent-stream.ts` 的 `mapAgentStreamFrame`），边收边渲染消息。这不是普通 JSON 请求，是长连接流。

### 4.7 一次完整交互的时序（以“语义检索资产”为例）

```
[浏览器] 用户在资产中心输入“古装女主”，点搜索
   │
   │  React 组件调用 api.semanticSearch("古装女主", 20)
   ▼
[api.ts] request("/asset-search/semantic", POST, body={query,limit})
   │   - 从 sessionStorage 读 token，加 Authorization 头
   │   - fetch("/api/v1/asset-search/semantic", ...)  ← 相对路径
   ▼
[Vite dev proxy]  /api → http://localhost:8000   （生产直连同源，无此层）
   ▼
[Fastify 8000]  preHandler 鉴权钩子
   │   - 校验 Bearer token → 载入 authUser
   │   - 放行到 modules/assets/routes.ts 的 handler
   ▼
[handler]  parseRequest(zodSchema, body) 校验入参 → 调 service
   ▼
[service]  Query Understanding(LLM) → embedding → Milvus/PG 召回 → 融合排序
   ▼
[handler]  return success({ items, count, mode })   ← 自动转 snake_case + 包 {ok,data}
   ▼
[api.ts]  收到 { ok:true, data:{items,count,mode} }，拆出 data
   │   - 用 assetFromUnknown 把每条 item 归一成 camelCase Asset
   ▼
[React]  setState，渲染资产卡片列表
```

---

## 5. 后端 API 全景（按功能域）

后端所有路由在 `src/http/routes.ts` 里集中**注册**（`registerRoutes` 按固定顺序 `await` 每个模块的 `register*Routes`）。注意本项目**不用** `app.register(routes, { prefix })` 这种前缀挂载——每条路由在各自模块的 `routes.ts` 里写**完整** `/api/v1/...` 路径。`src/modules/` 下共 **41 个模块**（其中 `media-provenance`、`project-access`、`seedance-lineage`、`seedance-self-produced-trust` 是纯领域服务，无独立路由）。每个域自带 `routes.ts`（路由+Zod 校验）、`service.ts`（业务）、`repository.ts`（DB）。下面按前端 `api.ts` 实际调用的端点归纳成功能域：

| 功能域 | 代表端点（都在 `/api/v1` 下） | 干什么 |
| --- | --- | --- |
| **鉴权** `auth` | `POST /auth/login`、`POST /auth/register`、`GET /auth/me`、`POST /auth/logout` | 登录/注册/当前用户，公开 |
| **项目** `production` | `GET/POST /projects`、`/projects/:id`、`PATCH /projects/:id` | 短剧项目 CRUD（“流水线”顶层） |
| **集 / 场景 / 分镜** | `/projects/:id/episodes`、`/episodes/:id/{scenes,shots,production-status,playback}` | 集→场→分镜结构 + 生产状态 |
| **分镜** | `POST /projects/:id/storyboard-imports/preview`、`/storyboard-imports/:id/confirm` | 分镜 Excel 解析导入 |
| **资产入库** `assets` | `POST /asset-ingest/{upload,excel/upload,json/assets}` | Excel/图片/JSON 三种入库 |
| **资产检索** | `POST /asset-search`、`POST /asset-search/semantic` | 混合检索 / 纯语义检索 |
| **资产管理** | `GET/PATCH/DELETE /assets/:id`、`/assets/:id/{versions,media}`、`POST /assets/import-personal` | 资产详情、版本、媒体、转个人 |
| **图片异步上传** `asset-uploads` | `POST /asset-upload-tasks`、`GET /asset-upload-notifications` | 提交(202)+站内提醒 |
| **项目资产引用** `project-assets` | `/projects/:id/assets` | 把资产加入项目 |
| **生成任务** `generation` | `POST /generations/estimate`、`/generations`、`/generation-quotes/:id/confirm`、`/generations/:id/retry`、`/generations/{in-flight,failed}` | 估价→确认→提交，生图/视频/音频 |
| **批量生成** | `POST /generations/batch-estimate`、`/generations/batch-confirm`、`/generation-batches/:id/submit` | 批量估价/确认/提交 |
| **生成默认策略** | `/projects/:id/generation-defaults` | 项目级默认模型/参数 |
| **能力档** `capability-tiers` | `GET /generation/capability-tiers` | 模型能力档（image/video） |
| **音频** `audio` | （见 `modules/audio/routes.ts`） | TTS 语音合成 |
| **AI 网关** `ai` | `POST /ai/{prompt-draft,prompt-translate}`、`GET /ai/prompt-models` | 起草/翻译提示词（不建付费任务） |
| **AI 助手** `assistant` | `POST /agent/sessions`、`POST /agent/sessions/:id/messages`(SSE)、`GET /projects/:id/ai-audit-logs` | 对话式助手 + 审计日志 |
| **资产审核** `reviews` | `/projects/:id/reviews/submit`、`/reviews/assets/:id/decision`、`/projects/:id/review-policies` | 资产提审/裁决/策略 |
| **产物审核** | `/projects/:id/media-reviews`、`/media-reviews/decisions` | 生成产物（图/视频）审核 |
| **交付** `delivery` | `GET/POST /episodes/:id/deliver{ies,ables}`、`/media/:id/download` | 集交付落账/清单/下载 |
| **参考测试** `referenceTests` | `/projects/:id/reference-tests` | 模型效果参考测试 |
| **导演台** `director` | （见 `modules/director/routes.ts`） | 3D 镜头编排后端 |
| **仪表盘** `dashboard` | `GET /dashboard/summary` | 首页汇总 |
| **回收站** `trash` | `GET /trash`、`POST /trash/:kind/:id/restore` | 软删恢复（保留期 `.env` `TRASH_RETENTION_DAYS`） |
| **运营底座** `operations` | `GET /me/capabilities`、`/users/directory`、`/projects/:id/members` | 能力显隐/用户目录/成员 |
| **账户积分** `account-credits` | `GET /account-credits/me` | 余额与日额度 |
| **选题雷达** `topic-radar` | `GET /topic-radar/hot` | 红果榜单（只读、按调用计费） |
| **词表** `vocabulary` | `GET/POST /vocabulary/genres`、`/vocabulary/reference-lanes` | 创作建议词表 |
| **剧本拆解** `script-breakdown` | （见模块） | 剧本结构化拆解 |
| **配置项** `config-entries` | `GET /config-entries?kind=...` | 版本计划/命令面板等内容入库 |
| **命令面板** `command-palette` | `GET /command-palette/search?q=...` | ⌘K 跨域搜索 |
| **后台-管理** `admin/*` | `/admin/{costs,teams,user-groups,users,models,invite-tiers,invite-codes,config-entries,config-status}` | 管理员运营后台 |
| **后台-成本** | `/admin/costs?group_by=`、`/projects/:id/costs`、`/projects/:id/consumption/records` | 成本/消耗明细 |
| **后台-模型** | `GET /admin/models` | 模型槽位配置 |
| **配置状态** `config-status` | `GET /admin/config-status` | 模型/网关是否配置就绪 |
| **TOS 公开代理** `tos-public` | `/tos-public/...` | dev 下绕 TOS CORS 的图片代理 |
| **CLI 兼容** `cli-compat` | （`CLI_COMPAT_MODE=deprecated`，默认进弃用期） | 旧 CLI 兼容路由 |
| **对象上下文** `object-context` | （见模块） | 对象级上下文 |
| **备戏台** `prep` | （见 `modules/prep/routes.ts`） | 场景备戏 |

> 想知道某个端点的**完整入参/出参**：在线打开 `http://localhost:8000/docs`（Swagger UI，由 `@fastify/swagger-ui` 提供），或看对应模块的 `routes.ts` 里的 Zod schema。

---

## 6. 前端架构与页面组织

### 6.1 入口链
`index.html` → 加载 `src/styles/tokens.css` + `ui-base.css` + `src/app.tsx` → 挂到 `#root`。

### 6.2 路由机制：自实现，不用 react-router
全仓**不使用** react-router 或任何客户端路由库。极简路由全部在 `src/routing.ts`（约 165 行）：

- `navigate(path, { replace })` —— 包装 `history.pushState/replaceState`，再 `dispatchEvent(new PopStateEvent("popstate"))` 触发重渲。
- `routePath()` —— 返回 `pathname + search`。
- `projectIdFromPath / episodeIdFromPath / shotIdFromPath` —— 正则抽路径参数。
- `loginPathFor / safeRedirectTarget` —— 登录回跳；`safeRedirectTarget` 拒绝 `//` 与协议头防外链。
- `rememberProjectLocation / recallProjectLocation` —— localStorage 记忆项目内上次位置（`ProjectRootRedirect` 用）。
- `hasVisitedProject / markProjectVisited` —— 首访轻引导判定。

`app.tsx` 的 `App()`：用 `useState(routePath())` 存当前路径，`useEffect` 监听 `popstate` 更新；无 token 且不在公开页时跳 `/login?redirect=...`，401 全局事件 `shortdrama:unauthorized` 同样回登录。**页面选择**在 `renderRoute(pathname, runtime)`（`app.tsx` 521 行起）用一串 `pathname.match(...)` 正则匹配，命中不到返回 `NotFoundPage`。

### 6.3 页面清单（`src/pages/`，约 24 个文件）

**全域页（无 projectId）**
| 路径 | 组件 | 说明 |
| --- | --- | --- |
| `/`、`/projects` | `ProjectsPage` | 项目列表 |
| `/assets` | `AssetCenterPage`（`?scope=common\|personal`） | 资产中心 |
| `/assets/prep` | `PrepStagePage` | 备戏台 |
| `/dashboard` | `DashboardPage` | 仪表盘 |
| `/queue` | `QueuePage` | 队列/任务 |
| `/admin` | `AdminConsolePage` | 后台管理 |
| `/cli` | `CliDownloadPage` | CLI 下载 |
| `/settings` | `SettingsPage` | 设置 |
| `/trash` | `TrashPage`（`?kind=project\|asset`） | 回收站 |
| `/topics` | `TopicsPage` | 选题雷达 |
| `/landing`、`/`（未登录） | `LandingPage` | 落地页 |
| `/login` | `LoginPage` | 登录 |

**项目内页（`/projects/:id/...`）**
| 路径 | 组件 | 说明 |
| --- | --- | --- |
| `/projects/:id` | `ProjectRootRedirect` | 恢复上次位置，否则落生产页 |
| `/projects/:id/director` | `DirectorWorkspace` | 3D 导演台（**React.lazy 分包**，three/R3F 仅此处加载） |
| `/projects/:id/costs` | `ProjectCostsPage` | 项目消耗 |
| `/projects/:id/script-breakdown` | `ScriptBreakdownPage` | 剧本拆解 |
| `/projects/:id/requirement-breakdowns/:runId` | `BreakdownRunPage` | 拆解运行详情 |
| `/projects/:id/storyboards/:epId/scenes/:sceneId` | `SegmentWorkbenchPage` | 场级/段落工作台（full-bleed 全屏） |
| `/projects/:id/production` | `ProductionViewPage` | 集视图，生产域主入口 |
| `/projects/:id/assets` | `ProjectAssetsPage` | 项目资产 |
| `/projects/:id/assets/:assetId` | `AssetDetailPage` | 资产详情 |

**退役/重定向（IA 重构兼容层，在 `app.tsx`）**：`/projects/:id/storyboards` → 生产页（深链参数随乘）；`/projects/:id/storyboards/:ep/shots/:shot` → 解析 `shot.scene_id` 跳场级工作台；`/projects/:id/reference-tests` → `/assets?tab=tests`；`/projects/:id/material-agent` → `/assets?tab=ingest`。

### 6.4 壳层组件（构成主框架，非路由页）
- **`AppRail`**（`components/app-rail.tsx`）—— 全站左侧 **72px** 导航（品牌 / 四项主入口 / 队列 / AI / 命令面板 / 积分 / 头像）。
- **`ProjectHeader`**（`app.tsx`）—— 项目内 **48px** 二级条，页签 = 剧本 \| 资产 \| 生产 \| 消耗。
- **`ProductionStepper`**（`production-stepper.tsx`）—— 分镜生产步骤条（只在项目内 `/storyboards` 路径渲染）。
- **`AssistantPanel`**（`app.tsx`）—— 右侧 **340px**「Pi」AI 工作区。
- **`CommandPalette`**（`components/command-palette.tsx`）—— ⌘K / Ctrl+K 命令面板。
- **`GenerationAttemptNotificationDock`**（`app.tsx`）—— 右下角任务提醒（生成 + 上传）。
- **`ProjectSettingsDrawer`**（`components/project-settings.tsx`）—— 项目设置抽屉。

### 6.5 3D 导演台（`components/director/`，规模最大的单域）
容器 `DirectorShell.tsx` / `DirectorWorkspace.tsx`；画布 `StageCanvas.tsx` + `scene/`（人偶、几何体、相机控制、人群阵列等）；UI 面板 `ui/`；状态/持久化 `store.ts` / `persistence.ts` / `runtime.ts`；导出 `export/`（截图、运镜录制、网格导出、深度图、缩略图）；命令系统 `commands/`（executor）。**仅在 `/projects/:id/director` 路由按需加载**（`React.lazy`），把 three/R3F 整条依赖隔离在该路由之外。

### 6.6 前端↔后端通信文件清单
中央 HTTP 客户端是 `src/api.ts`（单一 `ApiClient` 单例，管 token、`{ok,data}` 信封、401 联动）。除它之外，真正发后端请求的独立文件只有 4 个：

| 文件 | 负责 |
| --- | --- |
| `src/api.ts` | **总闸**，`ApiClient` 封装所有 REST 调用 + token + 错误 + 信封拆包 |
| `src/components/director/api.ts` | 3D 导演台端点薄封装，**复用全局 `api` 单例**：场景版本读写（乐观锁，409 冲突）、截图 PNG 入资产（multipart，201）、模板列表/实例化、命令批量校验 |
| `src/telemetry.ts` | 埋点 `track()` → `POST /api/v1/events`。**故意用裸 `fetch` 不走 `api.request`**——埋点 401/失败静默，不踢用户下线；`generation_result` 终态按 `request_id` 去重 |
| `src/voice-catalog.ts` | `api.request("/audio/voices")` 取音色词表 |
| `src/agent-stream.ts` | **不直接发请求**，是 Pi 助手 SSE 流的「归一化器」，被 `api.ts` 的 `streamAgentMessage` 逐帧调用，把新旧 runtime 流帧统一映射成 `AgentStreamEvent` |
| `src/auth-token.ts` | token 的 `sessionStorage` 存取 |
| `src/operations.ts` / `review-delivery.ts` / `release-plan.ts` / `command-palette.ts` / `generation-quotes.ts` 等 | 各功能域的响应归一（snake→camel mapper），不发请求 |

> 个别页面组件里也有零星 `api.request(...)` 就近直调（如 `pages/project-pages.tsx` 的 `PATCH /assets/:id`、`DELETE /shots/:id`；`pages/global-pages.tsx` 的 `PUT /projects/:id`），但都走 `api.ts` 这个中央单例，不算独立通信模块。

### 6.7 状态管理
用 **Zustand** 做全局/跨组件状态；组件局部状态用 React hooks。没有 Redux。

---

## 7. 数据模型速览（PostgreSQL，schema = `app`）

核心实体关系（结构库是真实数据源，Milvus 只是检索投影）：

```
users / sessions                      账号与会话
   │
asset_source_projects ── 项目资产来源
   │
asset_entities（主体资产：角色/场景）
   ├── asset_media（资产的多媒体版本：图/视频）
   └── asset_variants（资产变体）
        └── asset_media

projects（短剧项目）─ 流水线
   ├── project_members / teams / user_groups
   ├── episodes（集）
   │    ├── scenes（场）
   │    │    └── shots（分镜：剧本/提示词/拆解元素）
   │    │         └── shot_media（分镜媒体版本）
   │    └── deliveries（集交付记录）
   ├── project_assets（项目引用的资产）
   ├── generation_requests（生成任务）─ 生图/视频/音频
   │    └── generation_quotes / generation_batches（估价/批量授权）
   ├── review_policies / media_reviews（审核策略与产物审核）
   └── reference_tests（参考测试）

account_credits / invite_codes        账户积分与邀请码
trash_items                           回收站（按 TRASH_RETENTION_DAYS 保留）
config_entries                        版本计划/命令面板等配置内容入库
```

- **schema 固定 `app`**（`.env` 的 `POSTGRES_SCHEMA=app`）。**千万别填 `common`**——那是团队旧系统的活数据 schema。
- 迁移在 `migrations/`（编号 SQL），dev 下 `dev:up` 自动跑，生产单独授权跑 `npm run db:migrate`。
- 启动时**不会自动迁移**（迁移是需授权的发布动作，避免重启变成未评审的 schema 写入）。

---

## 8. 外部服务与降级

| 服务 | dev 不配会怎样 |
| --- | --- |
| PostgreSQL | **必须**，没它启动直接 fail-fast 退出 |
| Milvus | 语义检索**自动走 PostgreSQL 降级**，应用照跑 |
| TOS 对象存储 | 媒体读写不可用，但应用照常启动，生成 worker 自动暂停 |
| Ark/豆包 API Key | 生成与 AI 能力全关，应用照常跑；要联调填自己的 key |
| 生图/视频/音频 | 付费动作，`.env` `ALLOW_PAID_GENERATION=false`（dev 永远关），必须真人显式触发 |

> 所以新前端在 dev 环境**只要起了 PG**，绝大多数页面就能渲染、检索就能用，不依赖云资源。

---

## 9. 构建与部署（了解全貌）

### 多阶段 Dockerfile
1. `node-bootstrap`：从 nodejs.org 下载 Node 22.19（校验 SHA256，不依赖 Docker Hub）。
2. `build`：`npm ci` → `npm run build:frontend`（Vite 构建前端到 `frontend/shortdrama-rag-demo/dist`）→ `tsc` 编译后端到 `dist/`。
3. `runtime`：`npm ci --omit=dev`，拷贝 `dist/`、`frontend/.../dist/`、`migrations/`、`assets/`，以非 root 用户 `shortdrama` 跑 `node dist/server.js`，暴露 8000。

### 生产运行形态
单进程：Fastify 同时伺服 **API（/api/v1）+ Swagger（/docs）+ 前端静态文件（SPA）**，外面套 Caddy（`deploy/Caddyfile`）做 `:80 → app:8000` 反代 + 安全头 + 静态资源长缓存。

### 三个 compose 文件区别
- `docker-compose.dev.yml`：只起**本地 PG14**（开发用，`npm run dev:up` 用它）。
- `compose.yaml`：完整容器栈 app+db+caddy（本地/dev/test 兼容验证，**不是生产**）。
- 生产用 VKE/VCI + 私网 RDS，不用仓内 compose。

---

## 10. 开发规范与门禁（务必遵守）

来自 `AGENTS.md`（开工必读的强制规则）：

1. **每次提交前至少跑**：
   ```powershell
   npm run check:architecture   # 架构门禁（prebuild/pretypecheck 会自动触发）
   npm run typecheck            # 前后端类型检查
   npm test                     # 测试
   npm run build                # 构建
   ```
2. **分层边界**（后端）：HTTP 层只做校验/协议转换，不写业务/SQL；业务在 `services`/`modules`；DB 在 `repositories`；外部模型/TOS/Milvus 在 `integrations`。
3. **前端不能直连**模型供应商、数据库、TOS 密钥接口——统一调本仓 API。
4. **付费红线**：生图/视频/音频必须由人**明确点击一次**才创建一次任务；Pi/助手可以准备提示词，但不能自动提交/重试/批量扩张。
5. **密钥**只进 `.env`（已 gitignore）或部署平台密钥管理，**禁止**进代码/文档/截图/日志/git。
6. **`.env` 不提交**，仓库只提交 `.env.example`（里面一个真值都不许有）。
7. **界面改动必须真栈渲染走通**（5173 dev + 8000 API），不能用“组件存在”代替“用户能完成任务”。
8. **分支**：`main`=生产、`test`=测试站、`dev`=日常集成。提交信息用 `type(scope): summary`。

---

## 11. 常见问题排错

| 现象 | 排查 |
| --- | --- |
| `npm run dev` 启动报“数据库配置不完整/连接探测失败” | 检查 `.env` 的 `POSTGRES_*`；确认 `dev:up` 起了 PG；`POSTGRES_HOST` 必须 `localhost`，`POSTGRES_SCHEMA` 必须 `app` |
| 浏览器 5173 打开白屏 / 接口 404 | 终端 1 的后端 8000 没起；或改了 `vite.config.ts` 的 proxy 目标 |
| 所有接口 401 | token 过期/丢失，`sessionStorage` 被清；重新登录 |
| 跨域读 TOS 图片报错 | dev 下走 `/tos-public` 代理；生产需 TOS 桶配 CORS 或用签名 URL |
| 改了前端代码没生效 | 模式 A 下需重新 `build:frontend`；改用模式 B（vite 5173）有热重载 |
| `npm run build` 卡在 `check:architecture` | 架构门禁失败，**不许绕过**；按报错修实现或先改合同（见 `AGENTS.md` §7） |
| 生成任务点了没反应 | dev 下 `ALLOW_PAID_GENERATION=false`，付费能力是关的；属正常 |
| 语义检索结果差 | 检查是否走了 PG 降级（响应 `mode=structured_fallback`）；旧脏数据建议清 Milvus 重同步 |

---

## 12. 进阶阅读

- **`AGENTS.md`** —— 开发强制规则（真源优先级、技术栈、架构边界、付费红线、门禁），最重要的文件。
- **`README.md`** —— 项目总览与能力清单。
- **`API.md`** —— 资产入库/检索接口契约。
- **`CONTRIBUTING.md`** —— 开发流程与提交要求。
- **`docs/contracts/v0.2.0/README.md`** —— 产品/架构/数据/模型/测试协作合同（进阶必读）。
- **`CONTEXT.md`** —— 领域术语词汇表（画布/流水线等）。
- **在线 Swagger** —— `http://localhost:8000/docs`（启动后可见，接口入参出参最权威）。

---

### TL;DR 给赶时间的你
1. `npm install` → `npm run dev:up` →（前端开发再开一个终端）`cd frontend/shortdrama-rag-demo && npm run dev`。
2. 后端 8000 / 前端 5173，登录 `admin` + `.env` 里的 `DEV_ADMIN_PASSWORD`。
3. 所有后端调用走 `frontend/shortdrama-rag-demo/src/api.ts` 的 `ApiClient`，相对路径 `/api/v1/...`，带 `Bearer token`（存 sessionStorage）。
4. 后端响应统一 `{ok:true,data}`（data 全 snake_case）／错误 `{ok:false,error:{code,message,...}}`；前端用 mapper 把 snake 归一成 camel。
5. 改完跑 `npm run typecheck && npm run build`；提交信息 `type(scope): summary`；别碰付费生成、别提交 `.env`。
