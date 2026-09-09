import type { AuthenticatedUser } from "../../http/authenticate.js";
import { ForbiddenError } from "../../shared/errors.js";
import { canReadGlobalCosts, isAdministrator } from "./types.js";

/**
 * Runtime authorization is database-backed after migration 016. The optional
 * second parameter exists only as a source-compatible Day-0 bootstrap bridge
 * for old route registration code; it is intentionally ignored.
 */
export function requireAdministrator(
  user: AuthenticatedUser,
  _legacyBootstrapUsernames?: readonly string[],
): void {
  if (!isAdministrator(user.role)) {
    throw new ForbiddenError("修改设置没成：只有管理员可以操作，请联系管理员处理。");
  }
}

/** Operator and admin may read/export global costs, but only admin may mutate. */
export function requireGlobalCostReader(user: AuthenticatedUser): void {
  if (!canReadGlobalCosts(user.role)) {
    throw new ForbiddenError("查看成本没成：当前账号没有权限，请联系管理员处理。");
  }
}
