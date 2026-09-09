import assert from "node:assert/strict";
import test from "node:test";
import { encodeArkQueryComponent, sha256Hex, signArkV4Request } from "./volcSignatureV4.js";

// Vectors 1-2 are ported from origin/dev's backend/test/seedance-asset-signature.spec.ts
// so the ported signing chain is cross-checked against an independently recorded output,
// not just self-consistency.

test("Ark V4 签名匹配固定的 CreateAsset 签名向量", () => {
  const body = JSON.stringify({
    GroupId: "group-1",
    URL: "https://example.com/a.png",
    AssetType: "Image",
    ProjectName: "default",
  });

  const result = signArkV4Request({
    action: "CreateAsset",
    body,
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret-example",
    endpoint: "https://ark.cn-beijing.volcengineapi.com/",
    now: new Date("2026-07-21T08:09:10.000Z"),
  });

  assert.equal(
    result.signature,
    "96848176832d0d6371710724bb8d116e6e21f1204bd1677a5d38947658f899a7",
  );
  assert.equal(
    result.url,
    "https://ark.cn-beijing.volcengineapi.com/?Action=CreateAsset&Version=2024-01-01",
  );
  assert.ok(result.canonicalRequest.includes("content-type;host;x-content-sha256;x-date"));
});

test("Ark V4 签名按规范头顺序携带 STS 临时令牌", () => {
  const result = signArkV4Request({
    action: "GetAsset",
    body: "{}",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret-example",
    securityToken: "temporary-token",
    endpoint: "https://ark.cn-beijing.volcengineapi.com/",
    now: new Date("2026-07-21T08:09:10.000Z"),
  });

  assert.equal(result.headers["X-Security-Token"], "temporary-token");
  assert.ok(
    result.headers.Authorization?.includes(
      "SignedHeaders=content-type;host;x-content-sha256;x-date;x-security-token",
    ),
  );
  assert.ok(
    result.canonicalRequest.includes("x-date:20260721T080910Z\nx-security-token:temporary-token"),
  );
});

test("Ark V4 签名对相同输入稳定，对不同请求体/时间敏感", () => {
  const options = {
    action: "CreateAsset",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret-example",
    endpoint: "https://ark.cn-beijing.volcengineapi.com/",
    now: new Date("2026-07-21T08:09:10.000Z"),
  };

  const first = signArkV4Request({ ...options, body: '{"a":1}' });
  const second = signArkV4Request({ ...options, body: '{"a":1}' });
  assert.equal(first.signature, second.signature, "same input must produce the same signature");

  const differentBody = signArkV4Request({ ...options, body: '{"a":2}' });
  assert.notEqual(first.signature, differentBody.signature, "changed body must change the signature");

  const differentTime = signArkV4Request({
    ...options,
    body: '{"a":1}',
    now: new Date("2026-07-21T08:09:11.000Z"),
  });
  assert.notEqual(first.signature, differentTime.signature, "changed timestamp must change the signature");
});

test("encodeArkQueryComponent 按 RFC3986 规则转义 encodeURIComponent 遗留的保留字符", () => {
  assert.equal(encodeArkQueryComponent("a b!'()*c"), "a%20b%21%27%28%29%2Ac");
});

test("sha256Hex 对空字符串返回已知的 SHA-256 摘要", () => {
  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});
