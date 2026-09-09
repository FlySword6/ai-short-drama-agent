import assert from "node:assert/strict";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
  buildPinnedHttpsRequestOptions,
  downloadMediaBytes,
  inlineDownloadedMedia,
  type MediaHostLookup,
  type PinnedMediaRequest,
} from "../../src/modules/generation/mediaDownload.js";

const publicLookup: MediaHostLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("downloadMediaBytes", () => {
  it("downloads media bytes with normalized metadata", async () => {
    const result = await downloadMediaBytes("https://media.example.com/result.mp4", {
      lookupImpl: publicLookup,
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "3" },
      }),
    });
    assert.deepEqual([...result.content], [1, 2, 3]);
    assert.equal(result.byteLength, 3);
    assert.equal(result.contentType, "video/mp4");
    assert.equal(result.extension, "mp4");
  });

  it("accepts and names audio MIME types", async () => {
    const result = await downloadMediaBytes("https://media.example.com/result.mp3", {
      lookupImpl: publicLookup,
      fetchImpl: async () => new Response(new Uint8Array([1, 2]), {
        status: 200, headers: { "content-type": "audio/mpeg" },
      }),
    });
    assert.equal(result.contentType, "audio/mpeg");
    assert.equal(result.extension, "mp3");
  });

  it("enforces the byte limit while streaming", async () => {
    await assert.rejects(
      () => downloadMediaBytes("https://media.example.com/result.mp4", {
        maxBytes: 2,
        lookupImpl: publicLookup,
        fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
      }),
      /byte limit/,
    );
  });

  it("keeps the caller abort signal active while reading the response body", async () => {
    const controller = new AbortController();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        bodyController = streamController;
        streamController.enqueue(new Uint8Array([1]));
        setTimeout(() => controller.abort(), 5);
      },
    });
    await assert.rejects(
      () => downloadMediaBytes("https://media.example.com/result.mp4", {
        signal: controller.signal,
        timeoutMs: 100,
        lookupImpl: publicLookup,
        fetchImpl: async (_input, init) => {
          init?.signal?.addEventListener("abort", () => bodyController?.error(new Error("aborted")), {
            once: true,
          });
          return new Response(stream, { headers: { "content-type": "video/mp4" } });
        },
      }),
    );
  });

  it("rejects non-HTTPS media URLs before fetch", async () => {
    await assert.rejects(() => downloadMediaBytes("http://example.com/result.mp4"), /HTTPS/);
    await assert.rejects(() => downloadMediaBytes("https://[::1]/result.mp4"), /private host/);
    await assert.rejects(() => downloadMediaBytes("https://192.0.2.1/result.mp4"), /private host/);
    await assert.rejects(() => downloadMediaBytes("https://user:secret@example.com/result.mp4"), /credentials/);
    await assert.rejects(() => downloadMediaBytes("https://example.com:8443/result.mp4"), /standard HTTPS port/);
  });

  it("does not start a pre-cancelled download", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(
      () => downloadMediaBytes("https://media.example.com/result.mp4", {
        signal: controller.signal,
        lookupImpl: publicLookup,
        fetchImpl: async () => {
          calls += 1;
          return new Response();
        },
      }),
      /cancelled/,
    );
    assert.equal(calls, 0);
  });

  it("validates every redirect target before a second request", async () => {
    const requested: string[] = [];
    await assert.rejects(
      () => downloadMediaBytes("https://media.example.com/result.mp4", {
        lookupImpl: async (hostname) => hostname === "media.example.com"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }],
        fetchImpl: async (input, init) => {
          assert.equal(init?.redirect, "manual");
          requested.push(input.toString());
          return new Response(null, {
            status: 302,
            headers: { location: "https://internal.example.test/metadata" },
          });
        },
      }),
      /private or reserved host/,
    );
    assert.deepEqual(requested, ["https://media.example.com/result.mp4"]);
  });

  it("rejects mixed public and private DNS answers before connecting", async () => {
    let fetchCalls = 0;
    await assert.rejects(
      () => downloadMediaBytes("https://media.example.com/result.mp4", {
        lookupImpl: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response();
        },
      }),
      /private or reserved host/,
    );
    assert.equal(fetchCalls, 0);
  });

  it("rejects IPv4 and IPv6 special-use DNS answers", async () => {
    for (const [address, family] of [
      ["100.64.0.1", 4],
      ["198.18.0.1", 4],
      ["203.0.113.10", 4],
      ["::1", 6],
      ["fe80::1", 6],
      ["fd00::1", 6],
      ["2001:db8::1", 6],
      ["2001::1", 6],
      ["2002:0a00:0001::1", 6],
      ["3fff::1", 6],
      ["::ffff:127.0.0.1", 6],
    ] as const) {
      let fetchCalls = 0;
      await assert.rejects(
        () => downloadMediaBytes("https://media.example.com/result.mp4", {
          lookupImpl: async () => [{ address, family }],
          fetchImpl: async () => {
            fetchCalls += 1;
            return new Response();
          },
        }),
        /private or reserved host/,
        address,
      );
      assert.equal(fetchCalls, 0, address);
    }
    await assert.rejects(
      () => downloadMediaBytes("https://[3fff::1]/result.mp4"),
      /private host/,
    );
  });

  it("allows only the reviewed TOS provider host through a TLS-pinned benchmark fake IP", async () => {
    const target = { address: "198.18.0.7", family: 4 as const };
    let requested = false;
    const result = await downloadMediaBytes(
      "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/result.mp4",
      {
        lookupImpl: async () => [target],
        requestImpl: async (url, actualTarget) => {
          requested = true;
          assert.equal(url.hostname, "ark-acg-cn-beijing.tos-cn-beijing.volces.com");
          assert.deepEqual(actualTarget, target);
          return incomingResponse(
            200,
            { "content-type": "video/mp4" },
            [Buffer.from([1, 2, 3])],
          );
        },
      },
    );
    assert.equal(requested, true);
    assert.equal(result.byteLength, 3);
  });

  it("allows the exact reviewed MiniMax OSS media host through the same TLS-pinned fake IP", async () => {
    const target = { address: "198.19.0.9", family: 4 as const };
    const result = await downloadMediaBytes(
      "https://algeng-video-infer.oss-cn-shanghai.aliyuncs.com/result.mp4",
      {
        lookupImpl: async () => [target],
        requestImpl: async (url, actualTarget) => {
          assert.equal(url.hostname, "algeng-video-infer.oss-cn-shanghai.aliyuncs.com");
          assert.deepEqual(actualTarget, target);
          return incomingResponse(
            200,
            { "content-type": "video/mp4" },
            [Buffer.from([4, 5, 6])],
          );
        },
      },
    );
    assert.equal(result.byteLength, 3);
  });

  it("allows our own asset bucket through the same TLS-pinned fake IP", async () => {
    const target = { address: "198.18.0.11", family: 4 as const };
    let requested = false;
    const result = await downloadMediaBytes(
      "https://drama-asset.tos-cn-beijing.volces.com/projects/p1/shots/s1/video/0.mp4",
      {
        lookupImpl: async () => [target],
        requestImpl: async (url, actualTarget) => {
          requested = true;
          assert.equal(url.hostname, "drama-asset.tos-cn-beijing.volces.com");
          assert.deepEqual(actualTarget, target);
          return incomingResponse(
            200,
            { "content-type": "video/mp4" },
            [Buffer.from([7, 8, 9])],
          );
        },
      },
    );
    assert.equal(requested, true);
    assert.equal(result.byteLength, 3);
  });

  it("keeps RFC1918 and deceptive fake-IP provider hosts blocked", async () => {
    for (const [url, address] of [
      ["https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/result.mp4", "10.0.0.7"],
      ["https://ark-acg-cn-beijing.tos-cn-beijing.volces.com.evil.test/result.mp4", "198.18.0.7"],
      ["https://tos-cn-beijing.volces.com/result.mp4", "198.18.0.7"],
      ["https://other-bucket.tos-cn-beijing.volces.com/result.mp4", "198.18.0.7"],
      ["https://algeng-video-infer.oss-cn-shanghai.aliyuncs.com.evil.test/result.mp4", "198.18.0.7"],
      ["https://other-bucket.oss-cn-shanghai.aliyuncs.com/result.mp4", "198.18.0.7"],
      ["https://drama-asset.tos-cn-beijing.volces.com/result.mp4", "10.0.0.7"],
      ["https://drama-asset.tos-cn-beijing.volces.com.evil.test/result.mp4", "198.18.0.7"],
      ["https://drama-asset.tos-cn-shanghai.volces.com/result.mp4", "198.18.0.7"],
      ["https://evil-drama-asset.tos-cn-beijing.volces.com/result.mp4", "198.18.0.7"],
    ] as const) {
      let calls = 0;
      await assert.rejects(
        () => downloadMediaBytes(url, {
          lookupImpl: async () => [{ address, family: 4 }],
          requestImpl: async () => {
            calls += 1;
            return incomingResponse(200, { "content-type": "video/mp4" });
          },
        }),
        /private or reserved host/,
      );
      assert.equal(calls, 0);
    }
  });

  it("accepts a global-unicast IPv6 DNS answer", async () => {
    const result = await downloadMediaBytes("https://media.example.com/result.mp4", {
      lookupImpl: async () => [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }],
      fetchImpl: async () => new Response(new Uint8Array([3]), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      }),
    });
    assert.equal(result.byteLength, 1);

    const outsideDocumentationPrefix = await downloadMediaBytes(
      "https://[3fff:1000::1]/result.mp4",
      {
        fetchImpl: async () => new Response(new Uint8Array([4]), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
      },
    );
    assert.equal(outsideDocumentationPrefix.byteLength, 1);
  });

  it("follows a bounded public redirect manually", async () => {
    const requested: string[] = [];
    const result = await downloadMediaBytes("https://media.example.com/start", {
      lookupImpl: publicLookup,
      fetchImpl: async (input, init) => {
        assert.equal(init?.redirect, "manual");
        requested.push(input.toString());
        return requested.length === 1
          ? new Response(null, { status: 307, headers: { location: "/final.mp3" } })
          : new Response(new Uint8Array([7]), {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
          });
      },
    });
    assert.deepEqual(requested, [
      "https://media.example.com/start",
      "https://media.example.com/final.mp3",
    ]);
    assert.equal(result.extension, "mp3");
  });

  it("rejects a transport that follows redirects behind the validator", async () => {
    await assert.rejects(
      () => downloadMediaBytes("https://media.example.com/result.mp4", {
        lookupImpl: publicLookup,
        fetchImpl: async () => Object.defineProperties(
          new Response(new Uint8Array([1]), {
            status: 200,
            headers: { "content-type": "video/mp4" },
          }),
          {
            redirected: { value: true },
            url: { value: "https://other.example.com/result.mp4" },
          },
        ),
      }),
      /unexpected redirect/,
    );
  });

  it("applies the download deadline while DNS is still pending", async () => {
    const startedAt = Date.now();
    await assert.rejects(
      () => downloadMediaBytes("https://media.example.com/result.mp4", {
        timeoutMs: 15,
        lookupImpl: async () => new Promise<never>(() => undefined),
        fetchImpl: async () => {
          throw new Error("fetch must not start");
        },
      }),
      /cancelled/,
    );
    assert.ok(Date.now() - startedAt < 250, "DNS wait must not outlive the download deadline");
  });

  it("honors caller cancellation while DNS is pending", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(
      () => downloadMediaBytes("https://media.example.com/result.mp4", {
        signal: controller.signal,
        timeoutMs: 500,
        lookupImpl: async (_hostname, signal) => {
          assert.equal(signal?.aborted, false);
          return new Promise<never>(() => undefined);
        },
        fetchImpl: async () => {
          throw new Error("fetch must not start");
        },
      }),
      /cancelled/,
    );
  });

  it("pins the production socket to the checked IP while preserving Host and SNI", () => {
    const controller = new AbortController();
    const options = buildPinnedHttpsRequestOptions(
      new URL("https://media.example.com/final.mp4?signature=opaque"),
      { address: "93.184.216.34", family: 4 },
      controller.signal,
    );
    assert.equal(options.hostname, "93.184.216.34");
    assert.equal(options.family, 4);
    assert.equal(options.port, 443);
    assert.equal(options.path, "/final.mp4?signature=opaque");
    assert.equal(options.servername, "media.example.com");
    assert.equal((options.headers as Record<string, string>).host, "media.example.com");
    assert.equal(options.agent, false);
    assert.equal(options.signal, controller.signal);

    const ipv6Literal = buildPinnedHttpsRequestOptions(
      new URL("https://[2606:2800:220:1:248:1893:25c8:1946]/final.mp4"),
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      controller.signal,
    );
    assert.equal(ipv6Literal.hostname, "2606:2800:220:1:248:1893:25c8:1946");
    assert.equal(ipv6Literal.servername, undefined);
    assert.equal(
      (ipv6Literal.headers as Record<string, string>).host,
      "[2606:2800:220:1:248:1893:25c8:1946]",
    );
  });

  it("falls back across the already validated DNS address set without resolving again", async () => {
    const attempted: MediaHostAddress[] = [];
    let lookupCalls = 0;
    const requestImpl: PinnedMediaRequest = async (_url, target) => {
      attempted.push(target);
      if (target.family === 6) throw new Error("test IPv6 route unavailable");
      return incomingResponse(200, { "content-type": "video/mp4" }, [Buffer.from([8, 9])]);
    };
    const result = await downloadMediaBytes("https://media.example.com/result.mp4", {
      lookupImpl: async () => {
        lookupCalls += 1;
        return [
          { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
          { address: "93.184.216.34", family: 4 },
        ];
      },
      requestImpl,
    });
    assert.equal(lookupCalls, 1);
    assert.deepEqual(attempted, [
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      { address: "93.184.216.34", family: 4 },
    ]);
    assert.deepEqual([...result.content], [8, 9]);
  });

  it("starts a fallback address before a blackholed first connection consumes the deadline", async () => {
    const attempted: MediaHostAddress[] = [];
    const ipv6Addresses = Array.from({ length: 9 }, (_, index) => ({
      address: `2606:2800:220:1:248:1893:25c8:${(0x1900 + index).toString(16)}`,
      family: 6 as const,
    }));
    const result = await downloadMediaBytes("https://media.example.com/result.mp4", {
      timeoutMs: 90,
      lookupImpl: async () => [
        ...ipv6Addresses,
        { address: "93.184.216.34", family: 4 },
      ],
      requestImpl: async (_url, target, signal) => {
        attempted.push(target);
        if (target.family === 4) {
          return incomingResponse(200, { "content-type": "video/mp4" }, [Buffer.from([5])]);
        }
        return new Promise<IncomingMessage>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("blackhole cancelled")), {
            once: true,
          });
        });
      },
    });
    assert.deepEqual(attempted, [
      ipv6Addresses[0],
      { address: "93.184.216.34", family: 4 },
    ]);
    assert.deepEqual([...result.content], [5]);
  });

  it("revalidates a production redirect before requesting its target", async () => {
    let requestCalls = 0;
    const requestImpl: PinnedMediaRequest = async () => {
      requestCalls += 1;
      return incomingResponse(302, {
        location: "https://internal.example.test/metadata",
      });
    };
    await assert.rejects(
      () => downloadMediaBytes("https://media.example.com/start", {
        lookupImpl: async (hostname) => hostname === "media.example.com"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "169.254.169.254", family: 4 }],
        requestImpl,
      }),
      /private or reserved host/,
    );
    assert.equal(requestCalls, 1);
  });

  it("enforces streaming byte limits on the production request path", async () => {
    await assert.rejects(
      () => downloadMediaBytes("https://media.example.com/result.mp4", {
        maxBytes: 2,
        lookupImpl: publicLookup,
        requestImpl: async () => incomingResponse(
          200,
          { "content-type": "video/mp4" },
          [Buffer.from([1]), Buffer.from([2, 3])],
        ),
      }),
      /byte limit/,
    );
  });

  it("keeps the parent deadline attached after the winning response headers arrive", async () => {
    let winnerSignal: AbortSignal | undefined;
    const startedAt = Date.now();
    await assert.rejects(
      () => downloadMediaBytes("https://media.example.com/result.mp4", {
        timeoutMs: 15,
        lookupImpl: publicLookup,
        requestImpl: async (_url, _target, signal) => {
          winnerSignal = signal;
          let sent = false;
          const response = new Readable({
            read() {
              if (sent) return;
              sent = true;
              this.push(Buffer.from([1]));
            },
          }) as unknown as IncomingMessage;
          response.statusCode = 200;
          response.headers = { "content-type": "video/mp4" };
          signal.addEventListener("abort", () => response.destroy(new Error("winner body aborted")), {
            once: true,
          });
          return response;
        },
      }),
      /aborted/,
    );
    assert.equal(winnerSignal?.aborted, true);
    assert.ok(Date.now() - startedAt < 250, "response body must not outlive the parent deadline");
  });

  it("aborts a pending production socket request at the common deadline", async () => {
    const startedAt = Date.now();
    await assert.rejects(
      () => downloadMediaBytes("https://media.example.com/result.mp4", {
        timeoutMs: 15,
        lookupImpl: publicLookup,
        requestImpl: async (_url, _target, signal) => new Promise<IncomingMessage>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("socket aborted")), { once: true });
        }),
      }),
      /cancelled/,
    );
    assert.ok(Date.now() - startedAt < 250, "socket wait must not outlive the download deadline");
  });
});

describe("inlineDownloadedMedia", () => {
  it("converts provider inline base64 audio into the downloaded shape", () => {
    const result = inlineDownloadedMedia({
      contentBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      contentType: " Audio/MPEG ",
    });
    assert.deepEqual([...result.content], [1, 2, 3, 4]);
    assert.equal(result.byteLength, 4);
    assert.equal(result.contentType, "audio/mpeg");
    assert.equal(result.extension, "mp3");
  });

  it("names raw PCM audio without a URL fallback", () => {
    const result = inlineDownloadedMedia({
      contentBase64: Buffer.from([9]).toString("base64"),
      contentType: "audio/pcm",
    });
    assert.equal(result.extension, "pcm");
  });

  it("rejects empty inline content", () => {
    assert.throws(
      () => inlineDownloadedMedia({ contentBase64: "", contentType: "audio/mpeg" }),
      /empty/,
    );
  });

  it("rejects malformed or non-canonical base64 before decoding", () => {
    for (const contentBase64 of ["%%%%", "YQ", "YQ==trailing", "YW Jj"]) {
      assert.throws(
        () => inlineDownloadedMedia({ contentBase64, contentType: "image/png" }),
        /canonical base64/,
      );
    }
  });

  it("enforces the decoded inline byte limit before persistence", () => {
    assert.throws(
      () => inlineDownloadedMedia({
        contentBase64: Buffer.from([1, 2, 3]).toString("base64"),
        contentType: "image/png",
      }, { maxBytes: 2 }),
      /byte limit/,
    );
  });

  it("rejects non-media content types", () => {
    assert.throws(
      () => inlineDownloadedMedia({
        contentBase64: Buffer.from("hi").toString("base64"),
        contentType: "text/plain",
      }),
      /Unsupported media content type/,
    );
  });
});

type MediaHostAddress = Awaited<ReturnType<MediaHostLookup>>[number];

function incomingResponse(
  statusCode: number,
  headers: IncomingHttpHeaders,
  chunks: Buffer[] = [],
): IncomingMessage {
  const response = Readable.from(chunks) as unknown as IncomingMessage;
  response.statusCode = statusCode;
  response.headers = headers;
  return response;
}
