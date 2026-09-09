/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 公开注册入口开关：默认关闭，账号由管理员创建；dev 环境自动放开便于联调。 */
  readonly VITE_ENABLE_REGISTRATION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
