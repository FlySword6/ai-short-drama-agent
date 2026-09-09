# TypeScript 后端运行说明

当前生产入口使用 Node.js + TypeScript 编译产物，项目运行时只依赖 Node.js。

## 本地开发

```powershell
npm install
npm run dev
```

前端单独开发：

```powershell
npm run dev --workspace frontend/shortdrama-rag-demo
```

## 检查与构建

```powershell
npm run typecheck
npm test
npm run build
npm start
```

生产构建会先把 `frontend/shortdrama-rag-demo/src/app.ts` 编译到前端 `dist`，再把 `src/server.ts` 编译到根目录 `dist/server.js`。

## Docker

```powershell
docker build -t shortdrama-agent-ts .
docker run --rm -p 8000:8000 --env-file .env shortdrama-agent-ts
```

启动后访问：

- `GET http://127.0.0.1:8000/api/v1/health`
- `http://127.0.0.1:8000/docs`
- `http://127.0.0.1:8000/`

外部 PostgreSQL、TOS、Ark/Doubao 和 Milvus 仍使用原 `.env` 变量名；本地健康检查不需要建立数据库连接，入库和语义检索请求才会按需连接外部服务。
