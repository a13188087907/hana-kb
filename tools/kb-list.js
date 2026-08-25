import { getRuntime, textResult } from "./common.js";

export const name = "kb-list";
export const description = "列出本地知识库及文档状态统计。";
export const parameters = { type: "object", properties: {}, additionalProperties: false };
export const sessionPermission = { readOnly: true };

export async function execute() {
  const libraries = getRuntime().manager.list();
  const text = libraries.length
    ? libraries.map((item) => `- ${item.displayName ?? item.id} [${item.id}]: documents=${item.documents}, done=${item.done ?? 0}, failed=${item.failed ?? 0}, graph=${item.graphEnabled ? "on" : "off"}, bm25=${item.bm25Enabled ? "on" : "off"}`).join("\n")
    : "暂无知识库";
  return textResult(text, { libraries });
}
