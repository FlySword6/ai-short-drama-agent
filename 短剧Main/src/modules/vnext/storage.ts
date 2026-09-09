import { BadRequestError } from "../../shared/errors.js";

/**
 * vNext TOS namespace 合同：单桶多前缀，vNext 只拥有 `vnext/` 前缀，
 * 画布相关对象固定在 `vnext/projects/<project_uuid>/<object_uuid>_<sha256前16位>.<ext>`。
 * 与 Lite/完整版资产路径（`prod/asset/…` 等）互不重叠；任何拼路径的调用方
 * 必须先过 assertVnextStoragePath，禁止手工拼接。
 */
export const VNEXT_TOS_KEY_PREFIX = "vnext/";

const UUID_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const VNEXT_STORAGE_PATH = new RegExp(
  `^vnext/projects/${UUID_SEGMENT}/${UUID_SEGMENT}_[0-9a-f]{16}\\.[a-z0-9]{1,8}$`,
);

export function buildVnextStoragePath(input: {
  projectId: string;
  objectId: string;
  sha256: string;
  extension: string;
}): string {
  const key = `vnext/projects/${input.projectId.toLowerCase()}/${input.objectId.toLowerCase()}_${input.sha256
    .toLowerCase()
    .slice(0, 16)}.${input.extension.toLowerCase()}`;
  assertVnextStoragePath(key);
  return key;
}

export function isVnextStoragePath(key: string): boolean {
  return VNEXT_STORAGE_PATH.test(key);
}

export function assertVnextStoragePath(key: string): void {
  if (!VNEXT_STORAGE_PATH.test(key)) {
    throw new BadRequestError("非法的 vNext 存储路径：必须落在 vnext/projects/<project>/<object>_<sha256>.<ext> 合同内");
  }
}
