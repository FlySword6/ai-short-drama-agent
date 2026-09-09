// TOS bucket CORS 配置(Dario 2026-07-23 点名授权:上一轮"TOS CORS 等你的批"→本轮回复"批")
// 作用:只放行浏览器跨域只读(GET/HEAD),修复导演台 3D 模型加载(Kimi S3pro 回执 B5 根因)
// 可回滚:deleteBucketCORS 即恢复原状(原状=无 CORS 配置)
import { TosClient } from "@volcengine/tos-sdk";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const bucket = process.env.TOS_BUCKET || "drama-asset";
const client = new TosClient({
  accessKeyId: process.env.TOS_ACCESS_KEY,
  accessKeySecret: process.env.TOS_SECRET_KEY,
  region: process.env.TOS_REGION || "cn-beijing",
  endpoint: process.env.TOS_ENDPOINT || "tos-cn-beijing.volces.com",
});

await client.putBucketCORS({
  bucket,
  CORSRules: [
    {
      AllowedOrigins: ["http://localhost:5173", "http://localhost:8080", "http://101.126.6.208"],
      AllowedMethods: ["GET", "HEAD"],
      AllowedHeaders: ["*"],
      ExposeHeaders: ["ETag", "Content-Length", "Content-Type"],
      MaxAgeSeconds: 3600,
    },
  ],
});
const got = await client.getBucketCORS({ bucket });
console.log("CORS rules now:", JSON.stringify(got.data));
