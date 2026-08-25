import { getLibraryFeatures, setLibraryFeatures } from "../core/db.js";
import { getRuntime, textResult } from "./common.js";

export const name = "kb-graph-build";
export const description = "为知识库构建或续跑实体关系图谱；默认开启图谱并补建存量文档。";
export const parameters = {
  type: "object",
  properties: {
    libraryId: { type: "string" },
    enabled: { type: "boolean", description: "false 仅关闭图谱检索，数据保留；默认开启并构建" },
    retryFailed: { type: "boolean", description: "是否重试此前失败的 chunk，默认 true" },
    bm25Enabled: { type: "boolean", description: "可选：同时设置 BM25 候选路开关" },
  },
  required: ["libraryId"],
};
export const sessionPermission = { kind: "plugin_output", describeSideEffect: () => ({ kind: "plugin_data_write", summary: "更新图谱开关并写入实体、关系和 chunk 倒排" }) };

export async function execute(input) {
  const runtime = getRuntime();
  const libraryId = String(input?.libraryId ?? "").trim();
  if (!libraryId) throw new Error("libraryId is required");
  const db = runtime.manager.open(libraryId).db;
  const enabled = input?.enabled !== false;
  const featurePatch = { graphEnabled: enabled };
  if (input?.bm25Enabled != null) featurePatch.bm25Enabled = Boolean(input.bm25Enabled);
  setLibraryFeatures(db, featurePatch);
  if (!enabled) {
    const features = getLibraryFeatures(db);
    return textResult(`知识库 ${libraryId} 已关闭图谱检索，图谱数据保留`, { libraryId, features, stats: runtime.graphBuilder.stats(libraryId) });
  }
  const result = await runtime.graphBuilder.build(libraryId, { retryFailed: input?.retryFailed !== false });
  return textResult(`图谱构建完成：processed=${result.processed}, failed=${result.failed}, entities=${result.stats.entities}, relations=${result.stats.relations}`, { libraryId, result, features: getLibraryFeatures(db) });
}
