import assert from "node:assert/strict";
import test from "node:test";
import { escapeLikePattern, USER_DIRECTORY_RESULT_LIMIT } from "./repository.js";

test("用户目录把 LIKE 元字符按普通搜索文字处理，并保持固定的小结果上限", () => {
  assert.equal(escapeLikePattern("刘_美%术\\组"), "刘\\_美\\%术\\\\组");
  assert.equal(USER_DIRECTORY_RESULT_LIMIT, 20);
});
