/** S57 起邮箱自注册始终开放（合同：不以旧开关或邀请名单限制注册）；只有显式 "false" 才收起注册入口。 */
export function registrationEnabled(): boolean {
  if (import.meta.env?.VITE_ENABLE_REGISTRATION === "false") return false;
  return true;
}
