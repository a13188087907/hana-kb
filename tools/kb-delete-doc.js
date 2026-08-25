import { getRuntime, textResult } from "./common.js";

export const name = "kb-delete-doc";
export const description = "从知识库中删除一个文档及其所有 chunk、向量和占位索引行。";
export const parameters = {
  type: "object",
  properties: { libraryId: { type: "string" }, path: { type: "string", description: "文档本地路径" } },
  required: ["libraryId", "path"],
};
export const sessionPermission = { kind: "plugin_output", describeSideEffect: () => ({ kind: "plugin_data_write", summary: "从本地知识库删除一个文档及其索引数据" }) };

export async function execute(input) {
  const libraryId = String(input?.libraryId ?? "").trim();
  const filePath = String(input?.path ?? "").trim();
  if (!libraryId || !filePath) throw new Error("libraryId and path are required");
  const deleted = getRuntime().ingest.deleteDocument(libraryId, filePath);
  return textResult(deleted ? `已删除 ${filePath}` : `未找到 ${filePath}`, { libraryId, path: filePath, deleted });
}
