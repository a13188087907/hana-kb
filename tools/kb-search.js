import { getRuntime, textResult } from "./common.js";

export const name = "kb-search";
export const description = "在指定知识库中做向量/BM25 融合检索，并按需追加图谱结果；返回带来源、文档、标题路径和偏移量的片段。";
export const parameters = {
  type: "object",
  properties: {
    libraryId: { type: "string" },
    query: { type: "string" },
    topK: { type: "integer", minimum: 1, maximum: 1000 },
    similarityThreshold: { type: "number", minimum: -1, maximum: 1, description: "相似度阈值；内部转换为 cosine distance 过滤" },
  },
  required: ["libraryId", "query"],
};
export const sessionPermission = { readOnly: true };

export async function execute(input) {
  const libraryId = String(input?.libraryId ?? "").trim();
  if (!libraryId) throw new Error("libraryId is required");
  const results = await getRuntime().search.search(libraryId, input?.query, {
    topK: input?.topK,
    similarityThreshold: input?.similarityThreshold,
  });
  const text = results.length
    ? results.map((item, index) => `${index + 1}. [来源:${sourceLabel(item.source)}] [${item.similarity == null ? "BM25" : item.similarity.toFixed(4)}] ${item.documentName} · ${item.titlePath || "(无标题)"} · offset ${item.startOffset}-${item.endOffset}\n${item.text}`).join("\n\n")
    : "没有命中相似度阈值内的片段";
  return textResult(text, { libraryId, query: input?.query, results });
}

function sourceLabel(source) {
  return ({ vector: "向量", bm25: "BM25", rrf: "向量+BM25", graph: "图谱追加" })[source] || source || "向量";
}
