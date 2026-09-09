import { readFileSync, writeFileSync } from "node:fs";
let c = readFileSync("src/api.ts", "utf8");
const hadCRLF = c.includes("\r\n");
let n = c.replace(/\r\n/g, "\n");
n = n.replace("  AssetSearchPage,\n  AssetSearchResult,", "  AssetSearchPage,\n  VisualSearchPage,\n  AssetSearchResult,");
const marker = "  async uploadAsset(file: File, input: { sourceProjectName?: string; assetKindHint?: string } = {}): Promise<ListData<Asset>> {";
const method = [
 "  /**",
 "   * POST /api/v1/asset-search/visual",
 "   */",
 "  async assetVisualSearch(input: {",
 "    imageMediaId?: string;",
 "    file?: File;",
 "    query?: string;",
 "    alpha?: number;",
 "    scope?: \"personal\" | \"common\";",
 "    projectId?: string;",
 "    page?: number;",
 "    pageSize?: number;",
 "  }): Promise<VisualSearchPage> {",
 "    let raw: Record<string, unknown>;",
 "    if (input.file) {",
 "      const form = new FormData();",
 "      form.append(\"file\", input.file);",
 "      if (input.query) form.append(\"query\", input.query);",
 "      if (input.alpha !== undefined) form.append(\"alpha\", String(input.alpha));",
 "      if (input.scope) form.append(\"scope\", input.scope);",
 "      if (input.projectId) form.append(\"project_id\", input.projectId);",
 "      form.append(\"page\", String(input.page ?? 1));",
 "      form.append(\"page_size\", String(input.pageSize ?? 20));",
 "      raw = (await this.request(\"/asset-search/visual\", { method: \"POST\", body: form })) as Record<string, unknown>;",
 "    } else {",
 "      raw = (await this.request(\"/asset-search/visual\", {",
 "        method: \"POST\",",
 "        body: JSON.stringify({",
 "          image_media_id: input.imageMediaId,",
 "          ...(input.query ? { query: input.query } : {}),",
 "          ...(input.alpha !== undefined ? { alpha: input.alpha } : {}),",
 "          ...(input.scope ? { scope: input.scope } : {}),",
 "          ...(input.projectId ? { project_id: input.projectId } : {}),",
 "          page: input.page ?? 1,",
 "          page_size: input.pageSize ?? 20,",
 "        }),",
 "      })) as Record<string, unknown>;",
 "    }",
 "    const list = normaliseMappedList(raw, assetFromUnknown);",
 "    const record = isRecord(raw) ? raw : {};",
 "    const diagnostics = isRecord(record.diagnostics) ? record.diagnostics : {};",
 "    track(\"asset_visual_search\", { mode: input.file ? \"upload\" : \"library\", count: list.count, page: input.page ?? 1 });",
 "    return {",
 "      items: list.items,",
 "      count: list.count,",
 "      page: typeof record.page === \"number\" ? record.page : (input.page ?? 1),",
 "      pageSize: typeof record.page_size === \"number\" ? record.page_size : (input.pageSize ?? 20),",
 "      hasMore: record.has_more === true,",
 "      fallbackMode: typeof diagnostics.fallback_mode === \"string\" ? diagnostics.fallback_mode : null,",
 "    };",
 "  }",
 ""
].join("\n");
n = n.replace(marker, method + marker);
if (hadCRLF) n = n.replace(/\n/g, "\r\n");
writeFileSync("src/api.ts", n, "utf8");
console.log("api.ts patched");
