import { getRuntime } from "../core/runtime.js";

export { getRuntime };

export function textResult(text, details = {}) {
  return { content: [{ type: "text", text: String(text) }], details };
}

export function requireLibraryId(input) {
  const libraryId = String(input?.libraryId ?? "").trim();
  if (!libraryId) throw new Error("libraryId is required");
  return libraryId;
}
