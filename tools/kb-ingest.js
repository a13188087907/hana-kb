import { getRuntime, textResult } from "./common.js";

export const name = "kb-ingest";
export const description = "将一个或多个 Markdown/txt 文件或目录异步入库，支持同 hash 跳过和断点续跑。";
export const parameters = {
  type: "object",
  properties: {
    libraryId: { type: "string" },
    paths: { type: "array", items: { type: "string" }, description: "本地文件或目录路径" },
    resume: { type: "boolean", description: "只继续 documents 表中的 pending 文档" },
  },
  required: ["libraryId"],
};
export const sessionPermission = { kind: "external_side_effect", describeSideEffect: () => ({ kind: "external_api", summary: "读取指定本地文件，调用外部 embedding 服务，写入知识库 SQLite（消耗 API 额度）" }) };

export async function execute(input) {
  const runtime = getRuntime();
  const libraryId = String(input?.libraryId ?? "").trim();
  if (!libraryId) throw new Error("libraryId is required");
  const result = input?.resume
    ? await runtime.ingest.resume(libraryId)
    : await runtime.ingest.ingest(libraryId, Array.isArray(input?.paths) ? input.paths : []);
  const summary = result.map((item) => `${item.status}: ${item.path}${item.chunks != null ? ` (${item.chunks} chunks)` : item.error ? ` — ${item.error}` : ""}`).join("\n") || "没有可处理的 md/txt 文件";
  return textResult(summary, { libraryId, results: result });
}
