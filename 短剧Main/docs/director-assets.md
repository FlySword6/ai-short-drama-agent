# 3D 导演台资产管线（director-assets）

浏览器 3D 导演台（previs 工具）所需的人体/家具/街道/道具 GLB 资产的收录、分发与本地服务方案。

## 方案总览

- **火山云 TOS 是大文件唯一分发源**：所有 GLB 上传至 TOS bucket，key 前缀 `director-assets/v1/`。
- **Git 仓库只放代码与清单**：`assets/director/manifest.json`（含每个文件的 sha256/size/tosKey）+ `scripts/` 下的三个脚本。GLB 本体一律不进 git（`runtime/` 已被 `.gitignore` 覆盖）。
- **容器启动时后台拉取**：Dockerfile 的 CMD 先后台执行 `node scripts/fetch-director-assets.mjs`（日志写入 `/app/runtime/director-assets-fetch.log`），再 `exec node dist/server.js`。拉取不阻塞服务启动与 HEALTHCHECK 的 start-period；资产随拉随可用。
- **本地开发**：`src/app.ts` 把 `runtime/director-assets/` 静态挂载到 `/director-assets/` 前缀（目录不存在时自动创建，不会崩），前端直接取 `/director-assets/<source>/<category>/<file>.glb`。

## 目录与 tosKey 约定

本地暂存目录（git 不跟踪）：

```
runtime/director-assets/{source}/{category}/{id}.glb
```

TOS key：

```
director-assets/v1/{source}/{category}/{filename}.glb
```

即本地路径 = tosKey 去掉 `director-assets/v1/` 前缀。manifest 中每条资产同时记录 `file`（本地相对路径）与 `tosKey`。

当前来源与分类：

| source | category | 内容 |
| --- | --- | --- |
| kenney | furniture / city-roads / city-commercial / city-suburban / vehicle | Kenney CC0 kit 内的 GLB |
| quaternius | furniture / interior / street / vehicle / food / human | Quaternius CC0 包（OBJ 转 GLB），human 即 Background Posed Humans 过渡人体 |
| polyhaven | furniture / door / window / lamp / plant / prop / street | Poly Haven 写实 PBR 模型（1K 贴图，自包含 GLB） |

## 脚本用法

### 抓取与暂存（一次性，可复跑）

```bash
node scripts/stage-director-assets.mjs                    # 全量
node scripts/stage-director-assets.mjs --source=polyhaven # 只抓某一来源
node scripts/stage-director-assets.mjs --force            # 忽略已存在文件，强制重抓
node scripts/stage-director-assets.mjs --manifest-only    # 只按暂存区重建 manifest
```

行为：

- Kenney：抓取 kit 页面上的免登录直链 zip，解包后只取 `Models/` 下的 `.glb`。
- Quaternius：官网各包页面现均跳转公开的 Google Drive 文件夹（已无 zip 直链），脚本从对应 Drive 文件夹拉取 OBJ(+MTL)，用 `obj2gltf` 转成 GLB（纯色材质，无贴图）。
- Poly Haven：走公开 API（`api.polyhaven.com/files/{slug}`）下载 1K gltf 与贴图，用 `@gltf-transform/cli copy` 打包成自包含 GLB（贴图内嵌）。
- 转换器（obj2gltf / gltf-transform）首次运行时由 npm 安装到 `runtime/director-assets/.tools/`（gitignored），之后复用。
- 每个产物校验 GLB 魔数 `glTF`；最后重建 `assets/director/manifest.json`（含 sha256、size、`schemaVersion`、`generatedAt`）。

### 上传到 TOS（需要凭据）

```bash
# .env 需配齐：TOS_BUCKET / TOS_ENDPOINT（或 TOS_SDK_ENDPOINT）/ TOS_REGION /
#             TOS_ACCESS_KEY / TOS_SECRET_KEY
node scripts/upload-director-assets.mjs           # 幂等：headObject 同 size 跳过
node scripts/upload-director-assets.mjs --force   # 强制覆盖
```

### 从 TOS 拉回（容器与本地通用，零依赖）

```bash
node scripts/fetch-director-assets.mjs                  # 按 manifest 下载缺失/损坏文件并校验 sha256
node scripts/fetch-director-assets.mjs --check          # 只校验不下载，缺/错时退出码非 0
node scripts/fetch-director-assets.mjs --base <url>     # 覆盖下载基址（默认 TOS_PUBLIC_BASE_URL）
```

下载基址优先级：`--base` > 环境变量 `TOS_PUBLIC_BASE_URL` > 本地 `.env` 同名项。已存在且 size+sha256 匹配 manifest 的文件会跳过。

### 3D 预览 PNG 渲染与导入

渲染前先提供精确 519 条、已审核的中文视觉描述清单
`assets/director/descriptions.zh.json`：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-04T00:00:00.000Z",
  "descriptions": [
    {
      "sourceTosKey": "director-assets/v1/…/asset.glb",
      "descriptionZh": "给中文用户看的真实视觉描述",
      "sourceSummary": "描述来源与审核摘要"
    }
  ]
}
```

默认只核对 519 个本地 GLB 的 SHA-256 与描述覆盖，不启动浏览器、不写文件：

```bash
npm run render:director-asset-previews
npm run render:director-asset-previews -- --smoke  # 内置最小 GLB，验证浏览器/Three.js/PNG
```

显式 `--render` 后，Playwright + Three.js 以同一相机、灯光、背景和 512×512 PNG 规格
离屏渲染。浏览器只允许请求本次 `127.0.0.1:<renderer-port>`，GLB JSON 中的外部 URI
会在启动浏览器前被拒绝。已有 PNG 只有在上一版 manifest 的 `sourceTosKey`、
`sourceSha256` 与实际 `outputSha256` 三者都匹配时才复用；源内容变化会自动重画，
`--force` 可无条件重画。它只写本地
`runtime/director-previews/` 和 `assets/director/preview-manifest.json`，不会上传 TOS、
连接数据库或调用付费模型：

```bash
npm run render:director-asset-previews -- --render
npm run render:director-asset-previews -- --render --force
```

执行器优先使用机器上的 Google Chrome/Chromium；也可用
`DIRECTOR_PREVIEW_CHROMIUM_EXECUTABLE` 指定 Chromium 可执行文件。都没有时才使用
Playwright 自己管理的浏览器。

离屏渲染器完成后，生成 `assets/director/preview-manifest.json`。它必须为
`schemaVersion: 1`，且精确包含 519 条 `previews`；每条都写明原 GLB 的
`sourceTosKey`/`sourceSha256`、本地 `localFile`、不可由原 key 反推的
`asset-renditions/v1/director/<digest>.png`、`outputSha256`、尺寸、中文
`descriptionZh` 与 `sourceSummary`。`storageBucket` 固定为 `drama-asset`。

```bash
npm run import:director-asset-previews
npm run import:director-asset-previews -- --apply
```

默认命令只读取 GLB manifest 和预览 manifest，并检查每个本地 PNG 与 TOS key 是否完整；
不会连数据库、更不会上传 TOS。`--apply` 还要求可用的 PostgreSQL 配置，会在同一事务内
确定性 upsert 与源 GLB ID+SHA 精确绑定的预览 `asset_media`，并回填
`visual_description_zh`。公开投影还会强制预览 PNG 与源 GLB 同资产、同业务变体，单靠
metadata 中的源 ID/SHA 不能跨资产借图。PNG 本身是待修理的图片源；
`thumbnail/detail` 两档 WebP 由统一资产媒体修理 worker 生成、独立上传，并从最终对象
回读复核格式、尺寸和 SHA 后才登记健康，不把 512 PNG 伪登记为两个健康变体。PNG 上传、
渲染和任何付费调用不属于本脚本。源 GLB hash 与原 manifest 不一致、缺中文描述、缺本地
PNG 或缺 TOS key 时，两种模式都会拦截。

## 如何重抓 / 增量收录

1. **加 Poly Haven 模型**：在 `scripts/stage-director-assets.mjs` 的 `POLYHAVEN_PICKS` 追加 `{slug, category, tags}`（slug 从 `https://api.polyhaven.com/assets?t=models` 挑），重跑 `--source=polyhaven`。
2. **加 Kenney kit**：在 `KENNEY_KITS` 追加 `{slug, category, tags}`，重跑 `--source=kenney`。
3. **加 Quaternius 包**：打开包页面拿到 Google Drive 文件夹 ID，进入其 OBJ 子文件夹，把该文件夹 ID 追加到 `QUATERNIUS_PACKS`，重跑 `--source=quaternius`。
4. 重跑后 manifest 自动重建；确认无误后执行 `upload-director-assets.mjs` 增量上传（同 size 已存在项自动跳过），容器下次启动即自动拉到新文件。

## 来源与许可证

三家均为 [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)，可商用、无需署名；manifest 逐条记录 `source` 与 `license` 备查。

- **Kenney**（kenney.nl）：Furniture Kit（140 件）、City Kit Roads（72）、City Kit Commercial（41）、City Kit Suburban（40）、Car Kit（50）。
- **Quaternius**（quaternius.com）：Ultimate Furniture、Ultimate Home Interior、Modular Streets、Cars、Ultimate Food、Background Posed Humans（男女各 10 个姿势，作过渡人体）。
- **Poly Haven**（polyhaven.com）：54 件写实 PBR 模型（沙发/扶手椅/桌椅/床/门窗/灯具/绿植/桶箱/路障/街道杂物），1K 贴图。

未收录：Khronos 样品、Sketchfab、three.js examples。

## 后续：MakeHuman 逼真人体管线（未做）

Background Posed Humans 是低多边形过渡方案。逼真人体计划走 MakeHuman（参数化人体）→ Blender 导出 GLB：

1. MakeHuman 生成人体基模（含骨骼/形态键）。
2. Blender 导入、整理材质、导出 GLB（需 Blender，本地与 CI 均未安装，本次未做）。
3. 产物按本管线暂存（`runtime/director-assets/makehuman/human/`）→ manifest → 上传 TOS。
