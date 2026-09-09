# Node 离线缓存

此目录默认不包含二进制文件。Docker 构建会从 Node 官方下载固定版本，并根据 `Dockerfile` 里的 SHA-256 校验值验证。

如果构建环境不能访问 `nodejs.org`，可以事先把与目标架构一致的官方压缩包放在此目录：

```text
node-v22.19.0-linux-arm64.tar.xz
node-v22.19.0-linux-x64.tar.xz
```

压缩包已被 Git 忽略，不会进入仓库。即使使用本地文件，构建仍会校验其内容。
