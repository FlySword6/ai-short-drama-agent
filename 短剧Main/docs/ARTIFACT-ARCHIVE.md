# 验收资料私有归档

2026-08-10 起，产品仓 HEAD 只保留代码、合同和构建/运行时确实读取的资源。
历史验收截图、录屏、旧原型、退役脚本与 design QA 证据迁入专用私有 TOS。

## 查找资料

完整索引是 [`artifact-archive-manifest.json`](artifact-archive-manifest.json)。
每项记录：

- `sourcePath`：迁移前产品仓路径；
- `destination.objectKey`：稳定 TOS object key；
- `classification`：敏感或内部资料分类；
- `sha256` / `bytes` / `mediaType`：完整性信息；
- `access`：仅认证读取或临时签名访问。

目标桶为 `shortdrama-private-archive-2100701382`。桶和对象均禁止公共 ACL，
manifest 不记录永久 URL。需要查看时，用已授权身份下载 object key；需要临时分享时，
可执行：

```bash
tosutil presign "tos://shortdrama-private-archive-2100701382/<object-key>" -vp=300
```

生成的 URL 只有短期效力，不得提交到 Git、文档或回执。

## 保留例外

- `docs/validation/v0.1.1-kimi-director-handoff.md`：资产导入脚本直接读取。
- `frontend/shortdrama-rag-demo/public/fonts/*.woff2`：前端运行时字体。
- `frontend/shortdrama-rag-demo/public/demo-media/`：前端离线演示运行时读取。

其他例外必须通过仓库体积门禁白名单，写明路径、上限和运行时理由。
