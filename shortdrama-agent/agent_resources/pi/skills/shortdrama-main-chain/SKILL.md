---
name: shortdrama-main-chain
version: 0.3.0
description: Pi-compatible Main API tools for free short-drama candidate and prep work.
---

# 短剧主链 Pi Skill

只通过 Main `/api/v1` 调用本包声明的 `shortdrama_*` 工具。本包不保存资产目录、
项目记录、任务记录或任何生产凭据。

使用规则：

- 每个新凭据先调用 `shortdrama_capabilities`。预检失败就停止。
- 名称解析只接受唯一精确匹配。零匹配或同名时如实返回候选，不猜 ID。
- 项目、集、场和镜头导航优先使用明确 ID；缺少 Main 字段时标记未知。
- `shortdrama_script_paste`、`shortdrama_script_breakdown` 和
  `shortdrama_script_breakdown_resume` 只写候选层，不执行确认转正。
- 登记资产前先调用 `shortdrama_asset_registration_schema`；登记结果仍是候选任务。
- `shortdrama_project_asset_add` 只建项目备料引用，不创建控制包。
- 本包没有审核、设主版本、确认转正或付费提交工具；需要这些动作时交还人类。
- 每次调用保留 receipt；Main 没给出的 request ID、费用或撤销信息保持 `unknown`。
