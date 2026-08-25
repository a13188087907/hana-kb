import { getRuntime, requireLibraryId, textResult } from "./common.js";

export const name = "kb-graph-data";
export const description = "搜索实体或读取指定实体的一跳局部图；不会返回全图。";
export const parameters = {
  type: "object",
  properties: {
    libraryId: { type: "string" },
    entity: { type: "string", description: "实体名称搜索词" },
    entityId: { type: "integer", minimum: 1, description: "指定实体 ID，返回一跳局部图" },
  },
  required: ["libraryId"],
};
export const sessionPermission = { readOnly: true };

export async function execute(input) {
  const libraryId = requireLibraryId(input);
  if (input?.entityId == null && !String(input?.entity ?? "").trim()) throw new Error("entity or entityId is required");
  const data = getRuntime().graphBuilder.localGraph(libraryId, { entity: input?.entity, entityId: input?.entityId });
  const text = data.center
    ? `${data.center.name}: ${data.nodes.length} nodes, ${data.edges.length} edges`
    : data.candidates.map((item) => `${item.id}: ${item.name} (${item.type})`).join("\n") || "没有找到实体";
  return textResult(text, { libraryId, ...data });
}
