import { getRuntime, textResult } from "./common.js";
import { cleanLibraryEntities } from "../core/entity-cleaner.js";
import { getLibraryConfig } from "../core/db.js";

export const name = "kb-graph-clean";
export const description = "清洗知识库图谱实体：删除编号/元数据人名/边界崩坏/表格碎片类垃圾实体，泛化枢纽词降级拆边。纯数据库操作，不动文档与向量，立即生效。";
export const parameters = {
  type: "object",
  properties: {
    libraryId: { type: "string" },
  },
  required: ["libraryId"],
};
export const sessionPermission = { level: "write", risk: "destructive", irreversible: true };

export async function execute(input) {
  const libraryId = String(input?.libraryId ?? "").trim();
  if (!libraryId) throw new Error("libraryId is required");
  const runtime = getRuntime();
  const db = runtime.manager.open(libraryId).db;
  const config = getLibraryConfig(db);
  const before = {
    entities: db.prepare("SELECT COUNT(*) c FROM entities").get().c,
    relations: db.prepare("SELECT COUNT(*) c FROM relations").get().c,
  };
  const result = cleanLibraryEntities(db, { libraryGenericWords: config.genericEntities ?? [] });
  const after = {
    entities: db.prepare("SELECT COUNT(*) c FROM entities").get().c,
    relations: db.prepare("SELECT COUNT(*) c FROM relations").get().c,
  };
  const lines = [
    `清洗完成：实体 ${before.entities} → ${after.entities}（删除 ${result.dropped}，降级拆边 ${result.weakened}）`,
    `关系边 ${before.relations} → ${after.relations}`,
    result.weakened > 0 ? "降级的泛化枢纽保留在实体表供精确匹配，但不再参与建边与社区检测。" : "",
  ].filter(Boolean);
  return textResult(lines.join("\n"), { libraryId, ...result, before, after });
}
