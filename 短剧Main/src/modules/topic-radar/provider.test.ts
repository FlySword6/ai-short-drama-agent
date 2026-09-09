import assert from "node:assert/strict"; import test from "node:test";
import { FiftyTwoApiTopicRadarProvider } from "./provider.js";
test("52api provider 固定旧 hg_top 并分别读取目录与单页", async () => { const urls: URL[] = []; const provider = new FiftyTwoApiTopicRadarProvider({ enabled: true, apiKey: "test-key" }, { fetchImpl: async (input) => { const url = new URL(String(input)); urls.push(url); return Response.json(url.searchParams.get("type") === "top" ? { data: { list: [{ cell_id: "a", name: "榜", sub_list: [{ sub_cell_id: "b", name: "子榜" }] }] } } : { data: { list: [] } }); } }); const catalog = await provider.fetchRankings(); const page = await provider.fetchRankingPage({ rankingId: "a", subRankingId: "b", page: 2 }); assert.deepEqual(catalog.rankings, [{ id: "a", name: "榜", subRankings: [{ id: "b", name: "子榜" }] }]); assert.deepEqual(page.items, []); assert.deepEqual(urls.map((url) => [url.pathname, url.searchParams.get("type"), url.searchParams.get("cell_id"), url.searchParams.get("page")]), [["/api/hg_top", "top", null, null], ["/api/hg_top", "list", "a", "2"]]); });

test("真实目录字段 lists、sub_lists 和 sub_cell_name 会被归一化", async () => {
  const provider = new FiftyTwoApiTopicRadarProvider({ enabled: true, apiKey: "test-key" }, {
    fetchImpl: async () => Response.json({
      code: 200,
      data: {
        lists: [{
          cell_id: "ugc_rank_list_vote",
          cell_name: "热播榜",
          sub_lists: [{ sub_cell_id: "weekly", sub_cell_name: "周榜" }],
        }],
      },
    }),
  });

  assert.deepEqual((await provider.fetchRankings()).rankings, [{
    id: "ugc_rank_list_vote",
    name: "热播榜",
    subRankings: [{ id: "weekly", name: "周榜" }],
  }]);
});

test("目录只采用供应商明确给出的榜单日期", async () => {
  const withDate = new FiftyTwoApiTopicRadarProvider({ enabled: true, apiKey: "test-key" }, {
    fetchImpl: async () => Response.json({
      rank_date: "2026-07-20",
      data: { lists: [{ cell_id: "a", cell_name: "榜" }] },
    }),
  });
  const withoutDate = new FiftyTwoApiTopicRadarProvider({ enabled: true, apiKey: "test-key" }, {
    fetchImpl: async () => Response.json({
      data: { lists: [{ cell_id: "a", cell_name: "榜" }] },
    }),
  });

  assert.equal((await withDate.fetchRankings()).rankDate, "2026-07-20");
  assert.equal((await withoutDate.fetchRankings()).rankDate, null);
});

test("真实单页字段 lists 会被归一化且不会透传供应商结构", async () => {
  const provider = new FiftyTwoApiTopicRadarProvider({ enabled: true, apiKey: "test-key" }, {
    fetchImpl: async () => Response.json({
      code: 200,
      data: {
        type: "list",
        lists: [{
          id: "supplier-item-id",
          title: "短剧标题",
          score: "9876",
          play_num: "12345",
          copyright: "internal-only",
        }],
      },
    }),
  });

  const page = await provider.fetchRankingPage({ rankingId: "ugc_rank_list_vote", page: 1 });
  assert.deepEqual(page.items.map(({ rawItem: _rawItem, ...item }) => item), [{
    rank: 1,
    title: "短剧标题",
    heat: "9876",
    link: null,
  }]);
});

test("成功响应会深度脱敏对象键、URL 查询参数和字符串 assignment", async () => {
  const provider = new FiftyTwoApiTopicRadarProvider({ enabled: true, apiKey: "test-key" }, {
    fetchImpl: async () => Response.json({
      key: "echoed-key",
      nested: {
        authorization: "Bearer echoed-token",
        notice: "token=plain-text-token; key:another-key",
        url: "https://example.test/path?access_token=url-token&safe=value",
      },
      data: { list: [{ title: "剧", detail_url: "https://example.test/item?key=item-key" }] },
    }),
  });
  const result = await provider.fetchRankingPage({ rankingId: "ranking", page: 1 });
  const rawPayload = JSON.stringify(result.rawPayload);
  const rawItem = JSON.stringify(result.items[0]?.rawItem);

  assert.doesNotMatch(rawPayload, /echoed-key|echoed-token|plain-text-token|another-key|url-token|item-key/);
  assert.doesNotMatch(rawItem, /item-key/);
  assert.match(rawPayload, /\[REDACTED\]/);
  assert.match(result.items[0]?.link ?? "", /key=%5BREDACTED%5D/);
});

test("缺少可识别数组是上游结构错误，显式空数组仍是成功", async () => {
  const malformed = new FiftyTwoApiTopicRadarProvider({ enabled: true, apiKey: "test-key" }, {
    fetchImpl: async () => Response.json({ data: { unexpected: true } }),
  });
  await assert.rejects(malformed.fetchRankings(), /暂时读不出来/);
});

test("非空但没有可归一化条目的目录或页面是上游结构错误", async () => {
  const catalog = new FiftyTwoApiTopicRadarProvider({ enabled: true, apiKey: "test-key" }, {
    fetchImpl: async () => Response.json({ data: { list: [{ unknown: "value" }] } }),
  });
  await assert.rejects(catalog.fetchRankings(), /暂时读不出来/);
  const page = new FiftyTwoApiTopicRadarProvider({ enabled: true, apiKey: "test-key" }, {
    fetchImpl: async () => Response.json({ data: { list: [{ unknown: "value" }] } }),
  });
  await assert.rejects(page.fetchRankingPage({ rankingId: "a", page: 1 }), /暂时读不出来/);
});

test("字符串形式的供应商错误 code 也不会被误判为成功", async () => {
  const provider = new FiftyTwoApiTopicRadarProvider({ enabled: true, apiKey: "test-key" }, {
    fetchImpl: async () => Response.json({ code: "403", data: { list: [] } }, { status: 403 }),
  });
  await assert.rejects(provider.fetchRankings(), /暂时不可用/);
});

test("单页不静默截断供应商条目", async () => {
  const entries = Array.from({ length: 201 }, (_value, index) => ({ title: `剧${index + 1}` }));
  const provider = new FiftyTwoApiTopicRadarProvider({ enabled: true, apiKey: "test-key" }, {
    fetchImpl: async () => Response.json({ data: { list: entries } }),
  });
  assert.equal((await provider.fetchRankingPage({ rankingId: "a", page: 1 })).items.length, 201);
});

test("未配置时 provider 零请求", async () => {
  let calls = 0;
  const provider = new FiftyTwoApiTopicRadarProvider({ enabled: false, apiKey: "test-key" }, {
    fetchImpl: async () => { calls += 1; return Response.json({}); },
  });
  await assert.rejects(provider.fetchRankings(), /尚未配置/);
  assert.equal(calls, 0);
});
