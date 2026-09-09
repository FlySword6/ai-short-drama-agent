import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSET_MEDIA_DISPLAY_SPECS,
  buildAssetMediaDisplay,
  redactAssetStorageMetadata,
  type AssetMediaDisplayRenditionInput,
} from "./mediaDisplay.js";

const thumbnailPath = `asset-renditions/v1/ab/${"b".repeat(64)}.webp`;
const detailPath = `asset-renditions/v1/cd/${"c".repeat(64)}.webp`;

test("展示 URL 只使用独立、已核验的 rendition 对象，不再携带可删除的处理参数", () => {
  const display = buildAssetMediaDisplay({
    sourceSha256: "a".repeat(64),
    renditions: [
      rendition("thumbnail", thumbnailPath, 320, 180),
      rendition("detail", detailPath, 960, 540),
    ],
    displayBaseUrl: "https://cdn.example.com/media/",
    displayBucket: "drama-asset",
  });

  assert.deepEqual(display?.thumbnail, {
    kind: "thumbnail",
    url:
    `https://cdn.example.com/media/${thumbnailPath}`,
    processSpec: "image/resize,m_fill,w_320,h_180/format,webp",
    targetWidth: 320,
    targetHeight: 180,
    width: 320,
    height: 180,
    format: "webp",
  });
  assert.doesNotMatch(display?.thumbnail?.url ?? "", /x-tos-process|assets\/source/u);
  assert.equal(ASSET_MEDIA_DISPLAY_SPECS.thumbnail.processSpec, "image/resize,m_fill,w_320,h_180/format,webp");
});

test("详情变体接受边界内 WebP，且仅接受 HTTPS 展示基址", () => {
  assert.deepEqual(
    buildAssetMediaDisplay({
      sourceSha256: "a".repeat(64),
      renditions: [rendition("detail", detailPath, 1280, 700)],
      displayBaseUrl: "https://tos.example.com",
      displayBucket: "drama-asset",
    })?.detail,
    {
      kind: "detail",
      url: `https://tos.example.com/${detailPath}`,
      processSpec: "image/resize,m_lfit,w_1280,h_720/format,webp",
      targetWidth: 1280,
      targetHeight: 720,
      width: 1280,
      height: 700,
      format: "webp",
    },
  );
  assert.equal(
    buildAssetMediaDisplay({
      sourceSha256: "a".repeat(64),
      renditions: [rendition("detail", detailPath, 1280, 720)],
      displayBaseUrl: "http://localhost:9000",
    }),
    null,
  );
});

test("源对象路径、错误 bucket、旧 process 行和不完整健康事实都不会形成展示 URL", () => {
  const base = {
    sourceSha256: "a".repeat(64),
    displayBaseUrl: "https://cdn.example.com",
    displayBucket: "drama-asset",
  };
  assert.equal(buildAssetMediaDisplay({
    ...base,
    renditions: [rendition("thumbnail", "assets/private/source.webp", 320, 180)],
  }), null);
  assert.equal(buildAssetMediaDisplay({
    ...base,
    renditions: [{ ...rendition("thumbnail", thumbnailPath, 320, 180), storageBucket: "other" }],
  }), null);
  assert.equal(buildAssetMediaDisplay({
    ...base,
    renditions: [{ ...rendition("thumbnail", thumbnailPath, 320, 180), strategy: "tos_process" }],
  }), null);
  assert.equal(buildAssetMediaDisplay({
    ...base,
    renditions: [{ ...rendition("thumbnail", thumbnailPath, 319, 180) }],
  }), null);
  assert.equal(buildAssetMediaDisplay({
    ...base,
    renditions: [{ ...rendition("detail", detailPath, 1280, 720), checkedAt: null }],
  }), null);
  assert.equal(buildAssetMediaDisplay({
    ...base,
    renditions: [{ ...rendition("detail", detailPath, 1280, 720), sourceSha256: "c".repeat(64) }],
  }), null, "源图内容变化后，旧 healthy rendition 也必须 fail-closed");
});

test("rendition 公开路径拒绝点段、编码穿越与非应用生成的旧 key", () => {
  const base = {
    sourceSha256: "a".repeat(64),
    displayBaseUrl: "https://cdn.example.com/media/",
    displayBucket: "drama-asset",
  };
  for (const storagePath of [
    `asset-renditions/v1/../../${"b".repeat(64)}.webp`,
    `asset-renditions/v1/%2e%2e/${"b".repeat(64)}.webp`,
    `asset-renditions/v1/ab\\${"b".repeat(64)}.webp`,
    "asset-renditions/v1/detail.webp",
  ]) {
    assert.equal(buildAssetMediaDisplay({
      ...base,
      renditions: [rendition("detail", storagePath, 960, 540)],
    }), null, storagePath);
  }
});

test("公开 metadata 递归移除原对象定位字段但保留业务字段", () => {
  assert.deepEqual(redactAssetStorageMetadata({
    title: "雨夜角色",
    tosKey: "private/source.png",
    nested: {
      source_file_url: "https://private.example/source.png",
      visual_description_zh: "雨夜中的角色",
    },
    values: [{ storage_path: "private/a.png", label: "正面" }],
  }), {
    title: "雨夜角色",
    nested: { visual_description_zh: "雨夜中的角色" },
    values: [{ label: "正面" }],
  });
});

test("redactAssetStorageMetadata 不会因历史 JSON 的 url、file_path 或 object_uri 泄露 locator", () => {
  assert.deepEqual(redactAssetStorageMetadata({
    title: "雨夜角色",
    url: "https://private.example/original.png",
    file_path: "assets/private/original.png",
    object_uri: "tos://drama-asset/private/original.png",
  }), {
    title: "雨夜角色",
  });
});

test("redactAssetStorageMetadata 递归清理版本快照和嵌套数组中的历史 locator", () => {
  assert.deepEqual(redactAssetStorageMetadata({
    version_snapshots: [{
      version: 3,
      media: [{
        Source_File_URL: "https://private.example/v3.png",
        historical_reference: "https://private.example/also-not-a-display-url.png",
        inline_preview: "data:image/png;base64,private-bytes",
        archive_reference: "oss://private-bucket/v3.png",
        import_hint: "private/legacy/v3.png",
        notes: ["正面", "../legacy/v3.png", "雨夜中的角色"],
      }],
      nested: { render_location: "/var/private/render.webp" },
    }],
  }), {
    version_snapshots: [{
      version: 3,
      media: [{ notes: ["正面", "雨夜中的角色"] }],
      nested: {},
    }],
  });
});

test("redactAssetStorageMetadata 删除普通业务键下无扩展名的相对对象 key", () => {
  assert.deepEqual(redactAssetStorageMetadata({
    historical_reference: "tenant-42/opaque-object-7f3a",
    import_hint: "bucket-9\\hash-only-object",
    nested: {
      notes: [
        "正面",
        "tenant-42/opaque-object-7f3a",
        "雨夜中的角色",
        "bucket-9\\hash-only-object",
      ],
    },
  }), {
    nested: {
      notes: ["正面", "雨夜中的角色"],
    },
  });
});

test("redactAssetStorageMetadata 对大小写和分隔符 fail-closed，但保留普通业务标签", () => {
  assert.deepEqual(redactAssetStorageMetadata({
    OBJECT__URI: "tos://drama-asset/private/original.png",
    "Storage-Path": "private/original.png",
    downloadLocation: "s3://archive/private/original.png",
    profile: "角色设定",
    keyframe_label: "雨夜正面",
    visual_description_zh: "雨夜中的角色，服装带有蓝色反光",
    tags: ["角色", "正面", "夜景"],
  }), {
    profile: "角色设定",
    keyframe_label: "雨夜正面",
    visual_description_zh: "雨夜中的角色，服装带有蓝色反光",
    tags: ["角色", "正面", "夜景"],
  });
});

function rendition(
  renditionKind: "thumbnail" | "detail",
  storagePath: string,
  widthPx: number,
  heightPx: number,
): AssetMediaDisplayRenditionInput {
  return {
    renditionKind,
    strategy: "stored_object",
    status: "healthy",
    storageBucket: "drama-asset",
    storagePath,
    sourceSha256: "a".repeat(64),
    widthPx,
    heightPx,
    format: "webp",
    sha256: "b".repeat(64),
    checkedAt: new Date("2026-08-04T00:00:00.000Z"),
  };
}
