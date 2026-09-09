# 生成

先查 `generation models` 和 `generation capability-tiers --media-type image|video|audio`。`generation estimate` 接受简单成本预览或带项目/镜头归属的正式估价；只有正式估价会进入后续确认与提交。绝不跳过估价、人工审阅、确认和提交四个阶段；命令成功只说明本阶段成功，不表示媒体已经交付。

项目生成默认策略也在本组：`generation default-get --project-id ...` 回读（它来自 `/generation-defaults`，按 `media_kind` 分开存，不算参考测试）。需要人工直接维护时，先从 `generation models` 的服务端返回选择一个受支持的 `model_key`，再按 `generation default-update --help` 提供媒体类型、模式、模型键、默认策略记录版本和可选参数。正常动线是抽卡工作台里挑好结果后用 `reference-test set-default` 写入，`default-update` 是手工直改。
