import { readFileSync, writeFileSync } from "node:fs";
function patch(path, fn) {
  let c = readFileSync(path, "utf8");
  const hadCRLF = c.includes("\r\n");
  let n = c.replace(/\r\n/g, "\n");
  n = fn(n);
  if (hadCRLF) n = n.replace(/\n/g, "\r\n");
  writeFileSync(path, n, "utf8");
  console.log("patched:", path);
}
patch("src/types.ts", (n) => {
  n = n.replace('export interface AssetSearchPage extends ListData<Asset> {\n  page: number;\n  pageSize: number;\n  hasMore: boolean;\n}','export interface AssetSearchPage extends ListData<Asset> {\n  page: number;\n  pageSize: number;\n  hasMore: boolean;\n}\n\n/** POST /asset-search/visual */\nexport interface VisualSearchPage extends AssetSearchPage {\n  fallbackMode: string | null;\n}');
  return n;
});
console.log("done");
