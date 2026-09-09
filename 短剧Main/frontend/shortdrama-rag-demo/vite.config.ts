import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// 前端请求走同源相对路径（生产由 app 容器同源伺服）。dev server 本身
// 没有后端，把 /api 代理到本机后端。端口约定（2026-08-03 治理）：
//   8000 = 本机唯一正式 API（容器栈 / dist 生产态后端，.env.example PORT 同口径）；
//   8080 = 历史 tsx watch 后端默认，已退役，不再作为代理默认值；
// 需要指向其它后端（如测试环境、自起 8080 watch）时显式设 SHORTDRAMA_DEV_API。
const devApiTarget = process.env.SHORTDRAMA_DEV_API ?? "http://localhost:8000";

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // 局域网可访问：DC 用手机/其他机器走查 5173 需要,不只 localhost
    host: "0.0.0.0",
    port: 5175,
    proxy: {
      "/api": { target: devApiTarget, changeOrigin: true },
      // TOS 桶未配 CORS：dev 下 fetch/canvas 读像素走同源代理（见 asset-media.ts mediaFetchUrl）
      "/tos-public": {
        target: "https://drama-asset.tos-cn-beijing.volces.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tos-public/, ""),
      },
    },
  },
});
