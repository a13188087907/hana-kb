// 多格式 → Markdown 统一转换层
// 选型依据（2026-08-25 实验，见 2026-08-25-格式转换实验/实验报告.md）：
// - xlsx/xls 用 SheetJS：anydoc 实测丢空表头列的数据、日期不格式化，数据完整性不能接受
// - pptx 自研解析：anydoc 无分页无标题，结构保真差距大，检索实测 3/3 命中的是自研方案
// - docx/doc/ppt/epub/rtf/odt 用 anydoc：表格提取完整、老格式免费覆盖、native 快
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

export const CONVERTIBLE_EXTS = new Set([".docx", ".doc", ".ppt", ".epub", ".rtf", ".odt", ".xlsx", ".xls", ".pptx", ".pdf"]);

const ANYDOC_EXTS = new Set([".docx", ".doc", ".ppt", ".epub", ".rtf", ".odt"]);
const XLSX_EXTS = new Set([".xlsx", ".xls"]);

export async function convertToMarkdown(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!CONVERTIBLE_EXTS.has(ext)) throw new Error(`unsupported file format: ${ext || "none"}`);
  let result;
  if (XLSX_EXTS.has(ext)) result = xlsxToMarkdown(filePath);
  else if (ext === ".pptx") result = await pptxToMarkdown(filePath);
  else result = await anydocToMarkdown(filePath, ext);
  if (!result.markdown.trim()) {
    result.warnings.push("文件无正文内容（可能是空文档或仅含样式/图片）");
    result.markdown = "";
  }
  return result;
}

// ---------- xlsx/xls：SheetJS ----------
// raw:false 取单元格显示文本（日期/千分位/百分比按原表格式），否则日期变序列号、浮点精度爆炸
function xlsxToMarkdown(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const parts = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: false });
    const clean = rows.filter((r) => r.some((c) => String(c).trim() !== ""));
    if (!clean.length) continue;
    let lastCol = 0;
    for (const r of clean) {
      for (let i = r.length - 1; i >= 0; i--) {
        if (String(r[i]).trim() !== "") { lastCol = Math.max(lastCol, i); break; }
      }
    }
    const clipped = clean.map((r) => r.slice(0, lastCol + 1));
    parts.push(`# ${name}\n`);
    const header = clipped[0].map((c) => {
      const h = String(c).replace(/\|/g, "\\|").trim();
      return /^列\d+$/.test(h) ? "" : h; // SheetJS 对空表头的自动命名“列N”还原为空
    });
    parts.push(`| ${header.join(" | ")} |`);
    parts.push(`| ${header.map(() => "---").join(" | ")} |`);
    for (const row of clipped.slice(1)) {
      const cells = header.map((_, i) => String(row[i] ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim());
      parts.push(`| ${cells.join(" | ")} |`);
    }
    parts.push("");
  }
  return { markdown: parts.join("\n"), warnings: [] };
}

// ---------- pptx：自研解析（zip + xml） ----------
// 真实 PPT 大量用手动文本框而非占位符，标题识别靠字号启发式而非占位符类型
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
const asArr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

function extractParagraphs(txBody) {
  const out = [];
  for (const p of asArr(txBody?.p)) {
    const runs = asArr(p.r).concat(asArr(p.fld));
    const text = runs.map((r) => r?.t ?? "").join("");
    const lvl = Number(p.pPr?.["@_lvl"] ?? 0);
    const sizes = runs.map((r) => Number(r?.rPr?.["@_sz"] ?? 0)).filter((n) => n > 0);
    const size = sizes.length ? Math.max(...sizes) : 0;
    const t = String(text).trim();
    if (t) out.push({ text: t, level: Number.isFinite(lvl) ? lvl : 0, size });
  }
  return out;
}

function shapeInfo(sp) {
  const off = sp?.spPr?.xfrm?.off;
  return {
    paras: extractParagraphs(sp?.txBody),
    y: Number(off?.["@_y"] ?? 0),
    x: Number(off?.["@_x"] ?? 0),
  };
}

function pptxTableToMd(tbl) {
  const rows = asArr(tbl?.tr).map((tr) =>
    asArr(tr?.tc).map((tc) => extractParagraphs(tc?.txBody).map((p) => p.text).join(" ").replace(/\|/g, "\\|"))
  );
  if (!rows.length) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
  const lines = [`| ${norm[0].join(" | ")} |`, `| ${norm[0].map(() => "---").join(" | ")} |`];
  for (const r of norm.slice(1)) lines.push(`| ${r.join(" | ")} |`);
  return lines;
}

async function pptxToMarkdown(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  const parts = [];
  for (let i = 0; i < slideNames.length; i++) {
    const xml = await zip.files[slideNames[i]].async("string");
    const doc = xmlParser.parse(xml);
    const spTree = doc?.sld?.cSld?.spTree;
    const shapes = asArr(spTree?.sp).map(shapeInfo).filter((s) => s.paras.length);
    const tables = asArr(spTree?.graphicFrame).filter((g) => g?.graphic?.graphicData?.tbl);
    if (!shapes.length && !tables.length) continue;
    parts.push(`## 幻灯片 ${i + 1}`);
    const maxSize = Math.max(0, ...shapes.flatMap((s) => s.paras.map((p) => p.size)));
    const titleCut = maxSize >= 2400 ? maxSize * 0.85 : Infinity; // ≥24pt 才有标题可言
    const rest = [];
    for (const s of shapes) {
      for (const p of s.paras) {
        if (p.size >= titleCut) parts.push(`### ${p.text}`);
        else rest.push({ ...p, y: s.y, x: s.x });
      }
    }
    rest.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const p of rest) parts.push(`${"  ".repeat(Math.min(p.level, 4))}- ${p.text}`);
    for (const g of tables) parts.push(...pptxTableToMd(g.graphic.graphicData.tbl));
    parts.push("");
  }
  return { markdown: parts.join("\n"), warnings: [] };
}

// ---------- docx/doc/ppt/epub/rtf/odt：anydoc ----------
let anydocModulePromise;
function loadAnydoc() {
  return (anydocModulePromise ??= import("@firecrawl/anydoc"));
}

async function anydocToMarkdown(filePath, ext) {
  let anydoc;
  try {
    anydoc = await loadAnydoc();
  } catch {
    throw new Error(`当前平台不支持 ${ext} 格式转换（anydoc 原生模块不可用）`);
  }
  const buffer = fs.readFileSync(filePath);
  let raw;
  try {
    raw = await anydoc.toMarkdownBytes(buffer);
  } catch (error) {
    // 扫描件：anydoc 明确报错（no extractable text / OCR is required），如实转换为用户可读错误
    if (/no extractable text|OCR is required/i.test(error?.message ?? "")) {
      throw new Error("该 PDF 是扫描件（图片型），没有可提取的文字层，需要 OCR 才能入库。当前版本暂不支持 OCR，请先用 OCR 工具转为文字型 PDF");
    }
    throw error;
  }
  let markdown = (typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")).trim();
  const warnings = [];
  if (ext === ".docx") markdown = promoteBoldHeadings(markdown);
  if (ext === ".pdf") markdown = cleanPdfText(markdown, warnings);
  return { markdown, warnings };
}

// PDF 提取后处理（anydoc 通道，2026-09-05 五份真实 PDF 实测选型）
// 1. 中文间空格清理：PDF 按字距切词，常把「以保障」拆成「以保 障」；只删中文字符之间的空格，保留中英文之间的
// 2. 碎片化版面检测：PPT 转 PDF 等复杂版面的文字按 z-order 提取导致乱序碎片（如「创 世 界」「伟 大 公 司」），
//    短行占比过高时警告「版面复杂，内容顺序可能混乱」，不静默修正（无法可靠修正）
function cleanPdfText(markdown, warnings) {
  const cleaned = markdown.replace(/(?<=[一-龥]) +(?=[一-龥])/g, "");
  const lines = cleaned.split("\n").filter((l) => l.trim());
  if (lines.length > 10) {
    const fragments = lines.filter((l) => l.trim().replace(/[#|*\-\s]/g, "").length <= 3).length;
    if (fragments / lines.length > 0.25) {
      warnings.push("版面复杂（可能为 PPT 转 PDF），文字顺序可能混乱，建议检查入库内容质量");
    }
  }
  return cleaned;
}

// 中文办公文档的“标题”常是手动加粗+手动编号而非 Word 标题样式，
// 启发式提升：独占一行的加粗段落，且以数字/中文编号开头 → 二级标题
const CN_HEADING = /^\*\*\s*((?:\d+|[一二三四五六七八九十]+|第.{1,4}[章条部分])[．.、：:\s])?([^*]{1,40})\*\*\s*$/;

export function promoteBoldHeadings(md) {
  return md.split("\n").map((line) => {
    const m = line.match(CN_HEADING);
    if (!m) return line;
    const body = m[2].trim();
    if (body.length < 2 || /[。；，,；]$/.test(body)) return line; // 句子不是标题
    return `## ${(m[1] || "").trim()}${body}`.trim();
  }).join("\n");
}
