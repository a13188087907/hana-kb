import { getRuntime, textResult } from "./common.js";

export const name = "kb-rebuild-library";
export const description = "按当前 embedding 和切块参数重建知识库；可选重建图谱。";
export const parameters = {
  type: "object",
  properties: {
    libraryId: { type: "string" },
    paths: { type: "array", items: { type: "string" }, description: "指定文档路径；省略时重建库内已登记文件" },
    graph: { type: "boolean", description: "是否在入库后重建图谱" },
    retryFailed: { type: "boolean" },
  },
  required: ["libraryId"],
};
export const sessionPermission = { kind: "external_side_effect", describeSideEffect: () => ({ kind: "external_api", summary: "调用外部 embedding 服务重建索引，可选重建图谱（消耗 API 额度）" }) };

export async function execute(input) {
  const libraryId = String(input?.libraryId ?? "").trim();
  if (!libraryId) throw new Error("libraryId is required");
  const runtime = getRuntime();
  const paths = Array.isArray(input?.paths) && input.paths.length
    ? input.paths
    : runtime.manager.listDocumentPaths(libraryId);
  const results = await runtime.ingest.ingest(libraryId, paths, { force: true });
  let graph;
  if (input?.graph) graph = await runtime.graphBuilder.build(libraryId, { retryFailed: input?.retryFailed !== false });
  const complete = results.every((item) => item.status === "done" || item.status === "skipped") && (!graph || graph.failed === 0);
  if (complete) runtime.manager.markRebuildComplete(libraryId);
  return textResult(`知识库 ${libraryId} 重建完成：${results.length} 个文档${graph ? `，图谱处理 ${graph.processed} 个 chunk` : ""}`, { libraryId, results, graph, requiresRebuild: !complete });
}
