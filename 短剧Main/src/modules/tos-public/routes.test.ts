import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerTosPublicProxyRoutes, resolveTosPublicSourceUrl } from "./routes.js";

function authenticatedApp() {
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: "user-1", username: "director", displayName: "导演" };
  });
  return app;
}

function proxyPath(sourceUrl = "https://bucket.example.test/generated/role.png"): string {
  return `/api/v1/media/tos-images?url=${encodeURIComponent(sourceUrl)}`;
}

test("TOS 同源代理只读取配置桶，并保留对象查询参数", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const app = authenticatedApp();
  await registerTosPublicProxyRoutes(app, {
    baseUrl: "https://bucket.example.test/assets",
    fetchImpl: (async (input, init) => {
      calls.push({ url: String(input), method: String(init?.method) });
      return new Response("image-bytes", {
        status: 200,
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=60",
          "x-upstream-secret": "must-not-leak",
        },
      });
    }) as typeof fetch,
  });

  const response = await app.inject({
    method: "GET",
    url: proxyPath("https://bucket.example.test/assets/generated/role.png?version=2"),
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.body, "image-bytes");
  assert.equal(response.headers["content-type"], "image/png");
  assert.equal(response.headers["cache-control"], "public, max-age=60");
  assert.equal(response.headers["x-upstream-secret"], undefined);
  assert.deepEqual(calls, [{
    url: "https://bucket.example.test/assets/generated/role.png?version=2",
    method: "GET",
  }]);
  await app.close();
});

test("TOS 同源代理不跟随重定向，也不把上游技术信息交给用户", async () => {
  const app = authenticatedApp();
  await registerTosPublicProxyRoutes(app, {
    baseUrl: "https://bucket.example.test",
    fetchImpl: (async () => new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example.test/private" },
    })) as typeof fetch,
  });

  const response = await app.inject({ method: "GET", url: proxyPath() });

  assert.equal(response.statusCode, 502);
  assert.match(response.body, /图片暂时无法读取，请稍后重试/);
  assert.doesNotMatch(response.body, /302|bucket|attacker|TOS|HTTP/i);
  await app.close();
});

test("TOS 同源代理拒绝越出配置桶路径", () => {
  assert.throws(
    () => resolveTosPublicSourceUrl(
      "https://bucket.example.test/assets",
      "https://bucket.example.test/private.png",
    ),
    /图片地址不正确/,
  );
  assert.throws(
    () => resolveTosPublicSourceUrl(
      "https://bucket.example.test/assets",
      "https://attacker.example.test/assets/role.png",
    ),
    /图片地址不正确/,
  );
});

test("TOS 同源代理未配置时给出业务提示", async () => {
  const app = authenticatedApp();
  await registerTosPublicProxyRoutes(app, { baseUrl: "" });

  const response = await app.inject({ method: "GET", url: proxyPath() });

  assert.equal(response.statusCode, 503);
  assert.match(response.body, /图片读取服务尚未配置，请联系管理员/);
  await app.close();
});

test("TOS 图片代理必须登录，不能成为匿名带宽入口", async () => {
  const app = Fastify();
  await registerTosPublicProxyRoutes(app, {
    baseUrl: "https://bucket.example.test",
    fetchImpl: (async () => new Response("must-not-run")) as typeof fetch,
  });

  const response = await app.inject({
    method: "GET",
    url: proxyPath(),
  });

  assert.equal(response.statusCode, 401);
  await app.close();
});

test("TOS 图片代理拒绝 SVG 和 HTML 主动内容", async () => {
  for (const contentType of ["image/svg+xml", "text/html"]) {
    const app = authenticatedApp();
    await registerTosPublicProxyRoutes(app, {
      baseUrl: "https://bucket.example.test",
      fetchImpl: (async () => new Response("<script>steal()</script>", {
        status: 200,
        headers: { "content-type": contentType },
      })) as typeof fetch,
    });

    const response = await app.inject({
      method: "GET",
      url: proxyPath("https://bucket.example.test/generated/unsafe"),
    });

    assert.equal(response.statusCode, 415, response.body);
    assert.match(response.body, /不是可读取的图片/);
    await app.close();
  }
});

test("TOS 图片代理保留 206 Range 状态和响应范围", async () => {
  const app = authenticatedApp();
  const receivedHeaders: HeadersInit[] = [];
  await registerTosPublicProxyRoutes(app, {
    baseUrl: "https://bucket.example.test",
    fetchImpl: (async (_input, init) => {
      receivedHeaders.push(init?.headers ?? {});
      return new Response("partial", {
        status: 206,
        headers: {
          "content-type": "image/png",
          "content-range": "bytes 0-6/20",
          "accept-ranges": "bytes",
        },
      });
    }) as typeof fetch,
  });

  const response = await app.inject({
    method: "GET",
    url: proxyPath(),
    headers: { range: "bytes=0-6", "if-range": "\"v1\"" },
  });

  assert.equal(response.statusCode, 206);
  assert.equal(response.headers["content-range"], "bytes 0-6/20");
  assert.deepEqual(receivedHeaders[0], { range: "bytes=0-6", "if-range": "\"v1\"" });
  await app.close();
});

test("TOS 图片代理保留 304 与 416，不伪装成上游故障", async () => {
  for (const status of [304, 416]) {
    const app = authenticatedApp();
    await registerTosPublicProxyRoutes(app, {
      baseUrl: "https://bucket.example.test",
      fetchImpl: (async () => new Response(null, {
        status,
        headers: status === 416 ? { "content-range": "bytes */20" } : { etag: "\"v1\"" },
      })) as typeof fetch,
    });

    const response = await app.inject({
      method: "GET",
      url: proxyPath(),
    });

    assert.equal(response.statusCode, status);
    await app.close();
  }
});

test("TOS 图片代理正确处理 HEAD 且限制超大对象", async () => {
  const app = authenticatedApp();
  await registerTosPublicProxyRoutes(app, {
    baseUrl: "https://bucket.example.test",
    fetchImpl: (async () => new Response(null, {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": String(13 * 1024 * 1024) },
    })) as typeof fetch,
  });

  const response = await app.inject({
    method: "HEAD",
    url: proxyPath("https://bucket.example.test/generated/large.jpg"),
  });

  assert.equal(response.statusCode, 413);
  await app.close();
});

test("TOS 图片代理在上游没有 Content-Length 时也会分块截断超大响应", async () => {
  let cancelled = false;
  const megabyte = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 13; index += 1) controller.enqueue(megabyte);
    },
    cancel() {
      cancelled = true;
    },
  });
  const app = authenticatedApp();
  await registerTosPublicProxyRoutes(app, {
    baseUrl: "https://bucket.example.test",
    fetchImpl: (async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "image/png" },
    })) as typeof fetch,
  });

  const response = await app.inject({
    method: "GET",
    url: proxyPath("https://bucket.example.test/generated/oversized.png"),
  });

  assert.equal(response.statusCode, 413, response.body);
  assert.equal(cancelled, true);
  await app.close();
});

test("TOS 图片代理限制同一用户的并发读取", async () => {
  let fetchCalls = 0;
  let releaseFetches!: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseFetches = resolve;
  });
  const app = authenticatedApp();
  await registerTosPublicProxyRoutes(app, {
    baseUrl: "https://bucket.example.test",
    fetchImpl: (async () => {
      fetchCalls += 1;
      await barrier;
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch,
  });

  const active = Array.from({ length: 4 }, (_, index) => app.inject({
    method: "GET",
    url: proxyPath(`https://bucket.example.test/generated/${index}.png`),
  }));
  while (fetchCalls < 4) await new Promise<void>((resolve) => setImmediate(resolve));

  const rejected = await app.inject({
    method: "GET",
    url: proxyPath("https://bucket.example.test/generated/fifth.png"),
  });
  assert.equal(rejected.statusCode, 429, rejected.body);
  assert.match(rejected.body, /正在读取的图片较多/);

  releaseFetches();
  const responses = await Promise.all(active);
  assert.deepEqual(responses.map((response) => response.statusCode), [200, 200, 200, 200]);
  await app.close();
});
