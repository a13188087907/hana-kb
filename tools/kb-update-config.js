import { getRuntime, textResult } from "./common.js";

export const name = "kb-update-config";
export const description = "修改知识库检索和切块参数；修改分段参数后会提示需要重建。";
export const parameters = {
  type: "object",
  properties: {
    libraryId: { type: "string" },
    topK: { type: "integer", minimum: 1, maximum: 1000 },
    similarityThreshold: { type: "number", minimum: -1, maximum: 1 },
    chunkTargetLength: { type: "integer", minimum: 50, maximum: 10000, description: "兼容旧契约；切块目标字符数" },
    chunkOverlap: { type: "integer", minimum: 0, maximum: 9999, description: "兼容旧契约；硬切重叠字符数" },
    targetLength: { type: "integer", minimum: 50, maximum: 10000, description: "切块目标字符数" },
    overlap: { type: "integer", minimum: 0, maximum: 9999, description: "硬切重叠字符数" },
    search: { type: "object", properties: { topK: { type: "integer", minimum: 1, maximum: 1000 }, similarityThreshold: { type: "number", minimum: -1, maximum: 1 } } },
    chunking: { type: "object", properties: { targetLength: { type: "integer", minimum: 50, maximum: 10000 }, overlap: { type: "integer", minimum: 0, maximum: 9999 } } },
    graphEnabled: { type: "boolean" },
    bm25Enabled: { type: "boolean" },
  },
  required: ["libraryId"],
};
export const sessionPermission = { kind: "plugin_output", describeSideEffect: () => ({ kind: "plugin_data_write", summary: "更新本地知识库参数" }) };

export async function execute(input) {
  const libraryId = String(input?.libraryId ?? "").trim();
  if (!libraryId) throw new Error("libraryId is required");
  const result = getRuntime().manager.updateConfig(libraryId, input);
  return textResult(`知识库 ${libraryId} 参数已更新${result.requiresRebuild ? "；分段参数变化，需要重建库" : ""}`, { libraryId, ...result });
}
