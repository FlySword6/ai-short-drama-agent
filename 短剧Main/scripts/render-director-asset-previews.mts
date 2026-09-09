import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import {
  assertDirectorPreviewGlbHasNoExternalUris,
  buildDirectorPreviewRenderJobs,
  canReuseDirectorPreview,
  isDirectorPreviewRequestAllowed,
  validateDirectorPreviewDescriptions,
  type DirectorPreviewCacheEntry,
  type DirectorPreviewDescriptionManifest,
  type DirectorPreviewRenderJob,
} from "../src/modules/assets/directorPreviewRenderer.js";
import {
  DIRECTOR_ASSET_BUCKET,
  validateDirectorManifest,
  type DirectorManifest,
} from "../src/modules/assets/directorManifestImport.js";
import type { DirectorPreviewManifestEntry } from "../src/modules/assets/directorPreviewImport.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifestPath = path.join(workspaceRoot, "assets/director/manifest.json");
const rendererHtmlPath = path.join(workspaceRoot, "scripts/assets/director-preview-renderer.html");
const descriptionsPath = insideWorkspace(readOption("--descriptions") ?? "assets/director/descriptions.zh.json");
const outputPath = insideWorkspace(readOption("--output") ?? "assets/director/preview-manifest.json");
const render = process.argv.includes("--render");
const force = process.argv.includes("--force");

async function main(): Promise<void> {
  if (process.argv.includes("--smoke")) {
    await runRendererSmoke();
    return;
  }
  const [sourceText, descriptionsText] = await Promise.all([
    readFile(sourceManifestPath, "utf8"),
    readFile(descriptionsPath, "utf8"),
  ]);
  const source: unknown = JSON.parse(sourceText);
  const descriptions: unknown = JSON.parse(descriptionsText);
  validateDirectorManifest(source);
  validateDirectorPreviewDescriptions(descriptions, source);
  const jobs = buildDirectorPreviewRenderJobs(
    source,
    descriptions as DirectorPreviewDescriptionManifest,
  );
  await verifySources(jobs);

  if (!render) {
    process.stdout.write(JSON.stringify({
      mode: "check",
      sourceCount: jobs.length,
      descriptionCount: jobs.length,
      sourceHashesVerified: jobs.length,
      writes: 0,
      note: "No browser, TOS, database, or paid provider was called. Add --render to create local PNGs.",
    }, null, 2) + "\n");
    return;
  }

  const dependencies = await resolveRendererDependencies();
  const html = await readFile(rendererHtmlPath);
  const previousPreviews = force ? new Map<string, DirectorPreviewCacheEntry>() : await readPreviousPreviews(outputPath);
  const server = await startRendererServer(
    html,
    dependencies,
    path.join(workspaceRoot, "runtime/director-assets"),
  );
  let browser: Browser | undefined;
  try {
    browser = await launchRendererBrowser();
    const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
    await protectRendererPage(page, server.port);
    const previews: DirectorPreviewManifestEntry[] = [];
    for (const [index, job] of jobs.entries()) {
      const output = path.join(workspaceRoot, job.localFile);
      await mkdir(path.dirname(output), { recursive: true });
      const existing = !force ? await inspectExistingPng(output) : null;
      const rendered = existing && canReuseDirectorPreview(job, existing.sha256, previousPreviews.get(job.sourceTosKey))
        ? existing
        : await renderOne(page, server.port, job, output);
      previews.push({
        sourceTosKey: job.sourceTosKey,
        sourceSha256: job.sourceSha256,
        localFile: job.localFile,
        storageKey: job.storageKey,
        outputSha256: rendered.sha256,
        width: rendered.width,
        height: rendered.height,
        descriptionZh: job.descriptionZh,
        sourceSummary: job.sourceSummary,
      });
      if ((index + 1) % 25 === 0 || index + 1 === jobs.length) {
        process.stdout.write(`[director-preview] ${index + 1}/${jobs.length}\n`);
      }
    }
    await writeJsonAtomically(outputPath, {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      storageBucket: DIRECTOR_ASSET_BUCKET,
      previews,
    });
    process.stdout.write(JSON.stringify({
      mode: "render",
      previewCount: previews.length,
      output: path.relative(workspaceRoot, outputPath),
      tosUploads: 0,
      databaseWrites: 0,
      paidCalls: 0,
    }, null, 2) + "\n");
  } finally {
    await browser?.close();
    await server.close();
  }
}

async function verifySources(jobs: DirectorPreviewRenderJob[]): Promise<void> {
  for (const job of jobs) {
    const source = path.join(workspaceRoot, job.sourceFile);
    const content = await readFile(source);
    assertDirectorPreviewGlbHasNoExternalUris(content);
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== job.sourceSha256) {
      throw new Error(`Director GLB hash drift: ${job.sourceTosKey}`);
    }
  }
}

async function protectRendererPage(page: Page, port: number): Promise<void> {
  await page.route("**/*", async (route) => {
    if (isDirectorPreviewRequestAllowed(route.request().url(), port)) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });
}

async function readPreviousPreviews(filePath: string): Promise<Map<string, DirectorPreviewCacheEntry>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.previews)) return new Map();
    const entries = parsed.previews.flatMap((value): DirectorPreviewCacheEntry[] => {
      if (!isRecord(value)
        || typeof value.sourceTosKey !== "string"
        || typeof value.sourceSha256 !== "string"
        || typeof value.outputSha256 !== "string") return [];
      return [{
        sourceTosKey: value.sourceTosKey,
        sourceSha256: value.sourceSha256,
        outputSha256: value.outputSha256,
      }];
    });
    return new Map(entries.map((entry) => [entry.sourceTosKey, entry]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}

async function renderOne(
  page: Page,
  port: number,
  job: DirectorPreviewRenderJob,
  output: string,
): Promise<{ width: number; height: number; sha256: string }> {
  const diagnostics: string[] = [];
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === "error") diagnostics.push(`console:${message.text().slice(0, 300)}`);
  };
  const onPageError = (error: Error) => diagnostics.push(`page:${error.message.slice(0, 300)}`);
  const onResponse = (response: { status(): number; url(): string }) => {
    if (response.status() >= 400) {
      diagnostics.push(`response:${response.status()}:${new URL(response.url()).pathname.slice(0, 300)}`);
    }
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("response", onResponse);
  const assetPath = `/asset/${job.sourceFile.slice("runtime/director-assets/".length).split("/").map(encodeURIComponent).join("/")}`;
  try {
    await page.goto(`http://127.0.0.1:${port}/render?asset=${encodeURIComponent(assetPath)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => window.renderResult != null || typeof window.renderError === "string", null, {
      timeout: 30_000,
    });
    const state = await page.evaluate(() => ({
      result: window.renderResult,
      error: window.renderError,
    }));
    if (state.error || !state.result) {
      throw new Error(`Director preview render failed for ${job.sourceTosKey}: ${state.error ?? "missing result"}`);
    }
    await page.locator("#preview").screenshot({ path: output, type: "png" });
    const inspected = await inspectExistingPng(output);
    if (!inspected) throw new Error(`Director preview PNG validation failed: ${job.localFile}`);
    return inspected;
  } catch (error) {
    const detail = diagnostics.length ? ` (${diagnostics.join("; ")})` : "";
    throw new Error(`${error instanceof Error ? error.message : "Director preview render failed"}${detail}`);
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("response", onResponse);
  }
}

async function inspectExistingPng(filePath: string): Promise<{ width: number; height: number; sha256: string } | null> {
  try {
    const metadata = await sharp(filePath).metadata();
    if (metadata.format !== "png" || metadata.width !== 512 || metadata.height !== 512) return null;
    return { width: metadata.width, height: metadata.height, sha256: await sha256File(filePath) };
  } catch {
    return null;
  }
}

async function startRendererServer(
  html: Buffer,
  dependencies: { threeBuild: string; threeExamples: string },
  assetRoot: string,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/render") return send(response, 200, "text/html; charset=utf-8", html);
      if (url.pathname.startsWith("/vendor/examples/jsm/")) {
        const relative = decodeURIComponent(url.pathname.slice("/vendor/examples/jsm/".length));
        const file = contained(dependencies.threeExamples, relative);
        return streamFile(response, file, "text/javascript; charset=utf-8");
      }
      if (url.pathname.startsWith("/vendor/")) {
        const relative = decodeURIComponent(url.pathname.slice("/vendor/".length));
        const file = contained(dependencies.threeBuild, relative);
        return streamFile(response, file, "text/javascript; charset=utf-8");
      }
      if (url.pathname.startsWith("/asset/")) {
        const relative = decodeURIComponent(url.pathname.slice("/asset/".length));
        const file = contained(assetRoot, relative);
        return streamFile(response, file, "model/gltf-binary");
      }
      return send(response, 404, "text/plain; charset=utf-8", Buffer.from("not found"));
    })().catch(() => send(response, 404, "text/plain; charset=utf-8", Buffer.from("not found")));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Renderer server did not expose a port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    ),
  };
}

async function runRendererSmoke(): Promise<void> {
  const smokeRoot = await mkdtemp(path.join(tmpdir(), "director-preview-smoke-"));
  const output = path.join(smokeRoot, "triangle.png");
  let server: Awaited<ReturnType<typeof startRendererServer>> | undefined;
  let browser: Browser | undefined;
  try {
    await writeFile(path.join(smokeRoot, "triangle.glb"), minimalTriangleGlb(), { flag: "wx" });
    const [dependencies, html] = await Promise.all([
      resolveRendererDependencies(),
      readFile(rendererHtmlPath),
    ]);
    server = await startRendererServer(html, dependencies, smokeRoot);
    browser = await launchRendererBrowser();
    const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
    await protectRendererPage(page, server.port);
    const job: DirectorPreviewRenderJob = {
      sourceTosKey: "director-assets/v1/smoke/triangle.glb",
      sourceSha256: "0".repeat(64),
      sourceFile: "runtime/director-assets/triangle.glb",
      localFile: "runtime/director-previews/triangle.png",
      storageKey: "director-assets/v1/previews/smoke/triangle.png",
      descriptionZh: "离屏渲染执行器自检三角形",
      sourceSummary: "本地程序生成的零云调用自检对象",
    };
    const result = await renderOne(page, server.port, job, output);
    process.stdout.write(JSON.stringify({
      mode: "smoke",
      width: result.width,
      height: result.height,
      pngSha256: result.sha256,
      tosCalls: 0,
      databaseWrites: 0,
      paidCalls: 0,
    }, null, 2) + "\n");
  } finally {
    await browser?.close();
    await server?.close();
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

function minimalTriangleGlb(): Buffer {
  const binary = Buffer.alloc(44);
  const positions = [-1, -1, 0, 1, -1, 0, 0, 1, 0];
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => binary.writeUInt16LE(value, 36 + index * 2));
  const document = {
    asset: { version: "2.0", generator: "shortdrama-director-preview-smoke" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: 42 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
  };
  const json = Buffer.from(JSON.stringify(document));
  const jsonPadding = (4 - (json.length % 4)) % 4;
  const paddedJson = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
  const totalLength = 12 + 8 + paddedJson.length + 8 + binary.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, paddedJson, binaryHeader, binary]);
}

async function resolveRendererDependencies(): Promise<{ threeBuild: string; threeExamples: string }> {
  const candidates = [
    path.join(workspaceRoot, "node_modules/three"),
    path.join(workspaceRoot, "frontend/shortdrama-rag-demo/node_modules/three"),
  ];
  for (const candidate of candidates) {
    const build = path.join(candidate, "build");
    const modulePath = path.join(build, "three.module.js");
    const examples = path.join(candidate, "examples/jsm");
    try {
      await Promise.all([access(modulePath), access(examples)]);
      return { threeBuild: build, threeExamples: examples };
    } catch {
      // Try the next npm-workspace layout.
    }
  }
  throw new Error("Three.js workspace dependency is missing; run npm install before rendering");
}

async function launchRendererBrowser(): Promise<Browser> {
  const candidates = [
    process.env.DIRECTOR_PREVIEW_CHROMIUM_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((value): value is string => Boolean(value?.trim()));
  for (const executablePath of candidates) {
    try {
      await access(executablePath);
      return await chromium.launch({
        executablePath,
        headless: true,
        args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
      });
    } catch {
      // Try the next system browser, then Playwright's managed browser.
    }
  }
  return chromium.launch({
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
}

async function streamFile(
  response: Parameters<typeof send>[0],
  filePath: string,
  contentType: string,
): Promise<void> {
  const file = await stat(filePath);
  if (!file.isFile()) throw new Error("Renderer path is not a file");
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": file.size,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  createReadStream(filePath).pipe(response);
}

function send(
  response: import("node:http").ServerResponse,
  status: number,
  contentType: string,
  content: Buffer,
): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": content.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(content);
}

function contained(root: string, relative: string): string {
  if (!relative || relative.includes("\0")) throw new Error("invalid renderer path");
  const resolved = path.resolve(root, relative);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error("renderer path escaped root");
  return resolved;
}

function insideWorkspace(value: string): string {
  return contained(workspaceRoot, value);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, filePath);
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

declare global {
  interface Window {
    renderResult: { width: number; height: number; radius: number; triangles: number } | null;
    renderError: string | null;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Director preview render failed"}\n`);
  process.exitCode = 1;
});
