import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".md" && ext !== ".txt") {
    throw new Error(`unsupported file format: ${ext || "none"}`);
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
    format: ext.slice(1),
    text,
  };
}

export function normalizeText(text) {
  return String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}
