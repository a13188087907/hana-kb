import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";
import { CONVERTIBLE_EXTS, convertToMarkdown } from "./converter.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".md" && ext !== ".txt" && ext !== ".markdown") {
    if (!CONVERTIBLE_EXTS.has(ext)) throw new Error(`unsupported file format: ${ext || "none"}`);
    const { markdown, warnings } = await convertToMarkdown(filePath);
    return {
      filePath,
      name: path.basename(filePath),
      format: "md", // 转换产物统一是 md 结构（标题/表格），走 markdownUnits 切块
      text: normalizeText(markdown),
      warnings,
    };
  }
  const buffer = fs.readFileSync(filePath);
  let text;
  try {
    text = UTF8.decode(buffer);
  } catch {
    text = iconv.decode(buffer, "gbk");
  }
  text = normalizeText(text);
  return {
    filePath,
    name: path.basename(filePath),
    format: ext === ".txt" ? "txt" : "md",
    text,
  };
}

export function normalizeText(text) {
  return String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}
