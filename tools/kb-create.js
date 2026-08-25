import { getLibraryDisplayName, getLibraryFeatures, setLibraryFeatures } from "../core/db.js";
import { getRuntime, textResult } from "./common.js";

export const name = "kb-create";
export const description = "创建一个独立 SQLite 知识库。";
export const parameters = {
  type: "object",
  properties: {
    displayName: { type: "string", description: "知识库显示名，支持中文等字符" },
    libraryId: { type: "string", description: "兼容旧调用的库名参数；新调用优先使用 displayName" },
    graphEnabled: { type: "boolean", description: "是否开启图谱" },
    bm25Enabled: { type: "boolean", description: "是否开启 BM25 候选路，默认关闭" },
  },
  required: [],
};
export const sessionPermission = { kind: "plugin_output", describeSideEffect: () => ({ kind: "plugin_data_write", summary: "创建一个本地知识库文件" }) };

export async function execute(input) {
  const runtime = getRuntime();
  const displayName = String(input?.displayName ?? input?.libraryId ?? "").trim();
  const handle = runtime.manager.create(displayName);
  const features = setLibraryFeatures(handle.db, { graphEnabled: Boolean(input?.graphEnabled), bm25Enabled: Boolean(input?.bm25Enabled) });
  return textResult(`知识库 ${getLibraryDisplayName(handle.db, displayName)} 已创建`, { libraryId: handle.libraryId, displayName: getLibraryDisplayName(handle.db, displayName), features: getLibraryFeatures(handle.db) });
}
