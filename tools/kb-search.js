import { getRuntime, textResult } from "./common.js";

// 相关性提示阈值：基于真实库实测分布（真实查询 top1 普遍 ≥0.56，无答案题误召 0.57-0.71 存在重叠），
// 只做提醒不做硬拒绝——最终措辞交给 Agent 判断。
// 注意：这是「向量相关性提示」而非概率置信度——BM25/图谱路没有可比分数，不同 embedding 模型分布不同，
// 分档仅基于向量 top1 相似度，不使用“置信度”措辞。
const CONFIDENCE_LOW = 0.45;
const CONFIDENCE_MID = 0.60;

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
  const top1 = results.find((r) => r.similarity != null)?.similarity ?? null;
  let notice = "";
  if (!results.length) {
    notice = "注意：未检索到任何内容。请明确告知用户该知识库中没有找到相关信息，不要编造答案。";
  } else if (top1 != null && top1 < CONFIDENCE_LOW) {
    notice = `注意：检索结果的向量相关性很低（最高相似度 ${top1.toFixed(2)}），该问题的答案很可能不在此知识库中。请明确告知用户未找到可靠内容，不要基于以下片段编造答案。`;
  } else if (top1 != null && top1 < CONFIDENCE_MID) {
    notice = `提示：检索结果的向量相关性偏低（最高相似度 ${top1.toFixed(2)}），回答时请向用户说明不确定性，不要过度发挥。`;
  }
  return textResult(notice ? `${notice}\n\n${text}` : text, { libraryId, query: input?.query, results, confidence: top1 == null ? "unknown" : top1 < CONFIDENCE_LOW ? "low" : top1 < CONFIDENCE_MID ? "medium" : "high" });
}

function sourceLabel(source) {
  return ({ vector: "向量", bm25: "BM25", rrf: "向量+BM25", graph: "图谱追加" })[source] || source || "向量";
}

