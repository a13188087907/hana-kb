import { getRuntime, textResult } from "./common.js";

export const name = "kb-add-url";
export const description = "添加网页到知识库：抓取 URL 正文转为 Markdown 入库，frontmatter 记录来源链接。覆盖公众号/博客/新闻等静态网页；JS 动态渲染页面可能提取失败。";
export const parameters = {
  type: "object",
  properties: {
    libraryId: { type: "string" },
    url: { type: "string", description: "要入库的网页链接（http/https）" },
  },
  required: ["libraryId", "url"],
};
export const sessionPermission = { kind: "external_side_effect", describeSideEffect: () => ({ kind: "external_api", summary: "抓取指定网页，调用外部 embedding 服务，写入知识库 SQLite（消耗 API 额度）" }) };

export async function execute(input) {
  const runtime = getRuntime();
  const libraryId = String(input?.libraryId ?? "").trim();
  const url = String(input?.url ?? "").trim();
  if (!libraryId) throw new Error("libraryId is required");
  if (!url) throw new Error("url is required");
  const result = await runtime.ingest.ingestUrl(libraryId, url);
  if (result.status === "failed") {
    return textResult(`网页入库失败：${result.error}`, { libraryId, url, status: "failed", error: result.error });
  }
  const summary = `已入库《${result.title}》：${result.chunks} 个片段（来源 ${result.url}）`;
  return textResult(summary, { libraryId, url: result.url, title: result.title, status: result.status, chunks: result.chunks });
}
