import { getLibraryFeatures } from "../core/db.js";
import { getRuntime, textResult } from "./common.js";

export const name = "kb-graph-stats";
export const description = "查看知识库图谱质量：实体、关系、平均度、孤立实体比例和未覆盖 chunk。";
export const parameters = {
  type: "object",
  properties: { libraryId: { type: "string" } },
  required: ["libraryId"],
};
export const sessionPermission = { readOnly: true };

export async function execute(input) {
  const runtime = getRuntime();
  const libraryId = String(input?.libraryId ?? "").trim();
  if (!libraryId) throw new Error("libraryId is required");
  const stats = runtime.graphBuilder.stats(libraryId);
  const features = getLibraryFeatures(runtime.manager.open(libraryId).db);
  const text = `graph=${features.graphEnabled ? "on" : "off"} entities=${stats.entities} relations=${stats.relations} averageDegree=${stats.averageDegree.toFixed(3)} isolatedRatio=${(stats.isolatedRatio * 100).toFixed(1)}% uncoveredChunks=${stats.uncoveredChunks}`;
  return textResult(text, { libraryId, features, stats });
}
