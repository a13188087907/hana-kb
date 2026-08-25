import { getRuntime, requireLibraryId, textResult } from "./common.js";

export const name = "kb-doc-list";
export const description = "分页列出指定知识库内的文档、入库状态、chunk 数和失败原因。";
export const parameters = {
  type: "object",
  properties: {
    libraryId: { type: "string" },
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100 },
  },
  required: ["libraryId"],
};
export const sessionPermission = { readOnly: true };

export async function execute(input) {
  const libraryId = requireLibraryId(input);
  const result = getRuntime().manager.listDocuments(libraryId, { page: input?.page, pageSize: input?.pageSize });
  const text = result.documents.length
    ? result.documents.map((item) => `${item.status}: ${item.name} (${item.chunkCount} chunks)${item.error ? ` — ${item.error}` : ""}`).join("\n")
    : "暂无文档";
  return textResult(text, { libraryId, ...result });
}
