import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import type { Asset, MediaVersion } from "./types";

const happyWindow = new Window({ url: "http://localhost/assets?scope=common" });
for (const key of Object.getOwnPropertyNames(happyWindow)) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] =
      (happyWindow as unknown as Record<string, unknown>)[key];
  }
}
(globalThis as Record<string, unknown>).window = happyWindow;
(globalThis as Record<string, unknown>).document = happyWindow.document;
(globalThis as Record<string, unknown>).Event = happyWindow.Event;
(globalThis as Record<string, unknown>).CustomEvent = happyWindow.CustomEvent;
(globalThis as Record<string, unknown>).MouseEvent = happyWindow.MouseEvent;
(globalThis as Record<string, unknown>).KeyboardEvent = happyWindow.KeyboardEvent;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
(globalThis as Record<string, unknown>).React = await import("react");
const { createRoot } = await import("react-dom/client");
const { AssetDetailMediaViewer } = await import("./components/asset-widgets");

const frontImageUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E";
const sideImageUrl = `${frontImageUrl}#side`;
const videoUrl = "data:video/mp4;base64,AA==";
const audioUrl = "data:audio/mpeg;base64,AA==";

const versions: MediaVersion[] = [
  {
    id: "media-one",
    media_kind: "image",
    title: "正面肖像",
    storage_url: frontImageUrl,
    is_primary: true,
  },
  {
    id: "media-two",
    media_kind: "image",
    title: "侧面肖像",
    storage_url: sideImageUrl,
  },
  {
    id: "media-model",
    media_kind: "model_3d",
    format: "glb",
    title: "角色素模",
    storage_url: "https://example.com/character.glb",
  },
  {
    id: "media-video",
    media_kind: " Video ",
    title: "动作参考",
    storage_url: " ",
    source_file_url: videoUrl,
  },
  {
    id: "media-audio",
    media_kind: "AUDIO",
    title: "声音参考",
    storage_url: audioUrl,
  },
];

test("资产详情弹窗：点击图片、3D、视频和音频版本会真实切换主预览并处理媒体失败", { timeout: 10_000 }, async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const asset: Asset = {
    id: "asset-multi-image",
    asset_kind: "character",
    name: "多图角色",
    scope: "common",
    status: "approved",
  };

  try {
    act(() => {
      root.render(createElement(AssetDetailMediaViewer, {
        asset,
        versions,
        loading: false,
        error: "",
        onRetry: () => {},
      }));
    });

    const frontButton = document.querySelector<HTMLButtonElement>('button[aria-label="预览正面肖像"]');
    const sideButton = document.querySelector<HTMLButtonElement>('button[aria-label="预览侧面肖像"]');
    const modelButton = document.querySelector<HTMLButtonElement>('button[aria-label="预览角色素模"]');
    const videoButton = document.querySelector<HTMLButtonElement>('button[aria-label="预览动作参考"]');
    const audioButton = document.querySelector<HTMLButtonElement>('button[aria-label="预览声音参考"]');
    assert.ok(frontButton, "缺正面肖像缩略图按钮");
    assert.ok(sideButton, "缺侧面肖像缩略图按钮");
    assert.ok(modelButton, "缺 3D 素模缩略图按钮");
    assert.ok(videoButton, "缺视频缩略图按钮");
    assert.ok(audioButton, "缺音频缩略图按钮");
    assert.equal(document.querySelector('[role="list"][aria-label="媒体版本列表"]')?.children.length, 5);

    act(() => frontButton.click());
    let mainPreview = document.querySelector<HTMLImageElement>('img[alt="正面肖像"]');
    assert.equal(mainPreview?.src, frontImageUrl);
    assert.equal(frontButton.getAttribute("aria-pressed"), "true");

    act(() => sideButton.click());
    mainPreview = document.querySelector<HTMLImageElement>('img[alt="侧面肖像"]');
    assert.equal(mainPreview?.src, sideImageUrl);
    assert.equal(sideButton.getAttribute("aria-pressed"), "true");
    assert.equal(frontButton.getAttribute("aria-pressed"), "false");

    act(() => modelButton.click());
    assert.ok(container.innerHTML.includes('aria-label="3D 素模：角色素模"'), "点击 GLB 后没有切到 3D 素模占位");
    const sideImages = [...container.getElementsByTagName("img")]
      .filter((image) => image.alt === "侧面肖像");
    assert.equal(sideImages.length, 1, "GLB 仍错误保留主预览图片（列表缩略图之外不应再有一张）");
    assert.equal(modelButton.getAttribute("aria-pressed"), "true");

    act(() => videoButton.click());
    const video = container.querySelector<HTMLVideoElement>('video[aria-label="预览视频：动作参考"]');
    assert.equal(video?.getAttribute("src"), videoUrl, "视频未跳过空白 storage_url 使用有效地址");
    assert.equal(videoButton.getAttribute("aria-pressed"), "true");

    act(() => video?.dispatchEvent(new Event("error")));
    assert.ok(container.innerHTML.includes('aria-label="视频：动作参考"'), "视频加载失败后未回到版本占位");

    act(() => audioButton.click());
    const audio = container.querySelector<HTMLAudioElement>('audio[aria-label="播放音频：声音参考"]');
    assert.equal(audio?.getAttribute("src"), audioUrl);
    assert.equal(audioButton.getAttribute("aria-pressed"), "true");
  } finally {
    act(() => root.unmount());
    container.remove();
    await happyWindow.happyDOM.close();
  }
});
