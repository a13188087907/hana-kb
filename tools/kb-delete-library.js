import { getRuntime, textResult } from "./common.js";

export const name = "kb-delete-library";
export const description = "删除一个本地知识库及其 SQLite 文件。";
export const parameters = {
  type: "object",
  properties: { libraryId: { type: "string" } },
  required: ["libraryId"],
};
export const sessionPermission = { kind: "external_side_effect", describeSideEffect: () => ({ kind: "plugin_data_delete", summary: "删除一个本地知识库文件" }) };

export async function execute(input) {
  const libraryId = String(input?.libraryId ?? "").trim();
  if (!libraryId) throw new Error("libraryId is required");
  const deleted = getRuntime().manager.delete(libraryId);
  return textResult(deleted ? `知识库 ${libraryId} 已删除` : `未找到知识库 ${libraryId}`, { libraryId, deleted });
}
