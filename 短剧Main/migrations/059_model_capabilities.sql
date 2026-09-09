-- 模型容量登记表。2026-08-07 产品拍板「查并存表」:输出上限必须来自模型
-- 自己的能力,不再写死在代码里。
--
-- 为什么 token 列一律 integer 而不是照抄供应商字符串:
-- 火山方舟 `arkcli models get <name>` 的 limits 返回的是带单位字符串
-- ("1024k"、"384k")。如果原样落库,网关、剧本拆解、适配器三处读取点各自
-- 解析一遍,换算口径必然分叉(1k 是 1000 还是 1024?)。统一在写入侧换算,
-- 库里只存已定口径的整数:1k = 1024,1024k = 1048576、384k = 393216。
--
-- 为什么唯一键落在 callable_model_id 而不是 model_name:
-- 调用时用的 ID 是「模型名-版本号」拼起来的(deepseek-v4-flash-ga +
-- primary_version 260731 → deepseek-v4-flash-ga-260731)。同一模型名会同时
-- 存在多个版本,新版本上线时旧版本仍被历史请求引用,不能被挤掉。
--
-- 本表只记录能力与限流参数,不含凭证、密钥、endpoint、供应商原始响应。

CREATE TABLE IF NOT EXISTS {{schema}}.model_capabilities (
  id uuid PRIMARY KEY,
  model_name varchar(128) NOT NULL,
  model_version varchar(64) NOT NULL,
  callable_model_id varchar(255) NOT NULL,
  provider varchar(32) NOT NULL,
  context_window_tokens integer,
  max_input_tokens integer,
  max_output_tokens integer NOT NULL,
  max_reasoning_tokens integer,
  rate_limit_rpm integer,
  rate_limit_tpm integer,
  data_source varchar(16) NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_capabilities_callable_model_id_key UNIQUE (callable_model_id),
  CONSTRAINT model_capabilities_name_version_key UNIQUE (model_name, model_version),
  CONSTRAINT model_capabilities_model_name_nonblank_check
    CHECK (char_length(btrim(model_name)) > 0),
  CONSTRAINT model_capabilities_model_version_nonblank_check
    CHECK (char_length(btrim(model_version)) > 0),
  CONSTRAINT model_capabilities_callable_model_id_nonblank_check
    CHECK (char_length(btrim(callable_model_id)) > 0),
  CONSTRAINT model_capabilities_provider_check
    CHECK (provider IN ('ark', 'minimax', 'col')),
  -- data_source 是这张表的可信度标签:provider_api 来自供应商接口查询,
  -- manual 是人工登记(供应商不返回容量时的兜底),两者不可混淆。
  CONSTRAINT model_capabilities_data_source_check
    CHECK (data_source IN ('provider_api', 'manual')),
  -- 输出上限是这张表存在的理由,0 或负数会让调用方拿到一个假的「能力」。
  CONSTRAINT model_capabilities_positive_tokens_check
    CHECK (
      max_output_tokens > 0
      AND (context_window_tokens IS NULL OR context_window_tokens > 0)
      AND (max_input_tokens IS NULL OR max_input_tokens > 0)
      AND (max_reasoning_tokens IS NULL OR max_reasoning_tokens > 0)
      AND (rate_limit_rpm IS NULL OR rate_limit_rpm > 0)
      AND (rate_limit_tpm IS NULL OR rate_limit_tpm > 0)
    )
);

-- 网关每次调用都按 callable_model_id 查上限,这条索引由唯一约束提供;
-- 运维按模型名看历史版本,单独给一条。
CREATE INDEX IF NOT EXISTS model_capabilities_model_name_idx
  ON {{schema}}.model_capabilities (model_name);

-- 种子:2026-08-07 从 arkcli models get 实测取回的两个模型。
-- 为什么迁移里就要带种子:同步器是手动/定时运维脚本,不在服务启动路径上跑。
-- 表建好而没有任何行,所有调用都会走保守兜底,这张表等于没上线。
INSERT INTO {{schema}}.model_capabilities (
  id, model_name, model_version, callable_model_id, provider,
  context_window_tokens, max_input_tokens, max_output_tokens, max_reasoning_tokens,
  rate_limit_rpm, rate_limit_tpm, data_source, synced_at, created_at, updated_at
) VALUES
  (
    '85000000-0000-4000-8000-000000000001',
    'deepseek-v4-flash-ga',
    '260731',
    'deepseek-v4-flash-ga-260731',
    'ark',
    1048576,
    1048576,
    393216,
    393216,
    500,
    1000000,
    'provider_api',
    '2026-08-07T00:00:00Z',
    now(),
    now()
  ),
  (
    '85000000-0000-4000-8000-000000000002',
    'doubao-seed-2-1-pro',
    '260628',
    'doubao-seed-2-1-pro-260628',
    'ark',
    262144,
    262144,
    262144,
    262144,
    500,
    1000000,
    'provider_api',
    '2026-08-07T00:00:00Z',
    now(),
    now()
  )
ON CONFLICT (callable_model_id) DO NOTHING;
