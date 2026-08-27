import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import { makeTempDir, removeDir } from "./helpers.js";
import { convertToMarkdown, promoteBoldHeadings } from "../core/converter.js";
import { chunkText } from "../core/chunker.js";

test("promoteBoldHeadings 提升编号加粗段落为标题", () => {
  const input = "**1．目的**\n\n规范人员管理。\n\n**3. 制度内容**\n\n条目。";
  const out = promoteBoldHeadings(input);
  assert.ok(out.includes("## 1．目的"));
  assert.ok(out.includes("## 3.制度内容"));
  assert.ok(out.includes("规范人员管理。"));
});

test("promoteBoldHeadings 不提升句子结尾的加粗段落", () => {
  const input = "**这不是标题，而是一句完整的加粗强调。**";
  const out = promoteBoldHeadings(input);
  assert.ok(!out.includes("##"));
});

test("promoteBoldHeadings 支持中文编号", () => {
  const out = promoteBoldHeadings("**第三章 总则**");
  assert.ok(out.includes("## 第三章总则"));
});

test("convertToMarkdown xlsx：空尾列裁剪、列N 还原、显示格式保留", async () => {
  const dir = makeTempDir();
  try {
    const wb = XLSX.utils.book_new();
    // 第二列表头为空（SheetJS 会命名为 列2 之类）；第四列全空（应被裁掉）
    const rows = [
      ["项目", "", "收入", ""],
      ["一般检查", 2024, 1234.5, ""],
      ["影像检查", 2025, 5678.9, ""],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "收入表");
    const file = path.join(dir, "t.xlsx");
    XLSX.writeFile(wb, file);
    const { markdown, warnings } = await convertToMarkdown(file);
    assert.equal(warnings.length, 0);
    assert.ok(markdown.includes("# 收入表"));
    const headerLine = markdown.split("\n").find((l) => l.startsWith("|"));
    assert.equal(headerLine, "| 项目 |  | 收入 |"); // 空表头还原为空，尾列裁掉
    assert.ok(markdown.includes("| 一般检查 | 2024 | 1234.5 |"));
  } finally {
    removeDir(dir);
  }
});

test("convertToMarkdown 空 xlsx 返回空 + warning", async () => {
  const dir = makeTempDir();
  try {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "空表");
    const file = path.join(dir, "empty.xlsx");
    XLSX.writeFile(wb, file);
    const { markdown, warnings } = await convertToMarkdown(file);
    assert.equal(markdown, "");
    assert.ok(warnings.length > 0);
  } finally {
    removeDir(dir);
  }
});

test("chunkText 长表格续块前置表头", () => {
  const header = "| 项目 | 子项 | 价格 |\n| --- | --- | --- |";
  const rows = Array.from({ length: 60 }, (_, i) => `| 项目${i} | 子项${i} | ${100 + i}元 |`);
  const md = `# 价格表\n\n${header}\n${rows.join("\n")}`;
  const chunks = chunkText({ format: "md", text: md }, { target: 200, hardStep: 150, minLength: 10 });
  const tableChunks = chunks.filter((c) => c.text.includes("| 项目"));
  assert.ok(tableChunks.length > 1, "长表格应被切成多块");
  for (const c of tableChunks) {
    assert.ok(c.text.includes("| 项目 | 子项 | 价格 |"), "每个表格块都应含表头");
    assert.ok(c.text.includes("| --- | --- | --- |"), "每个表格块都应含分隔行");
  }
  // 偏移量指向数据行原文区间，不含 prepend 的表头
  for (const c of tableChunks) {
    const slice = md.slice(c.startOffset, c.endOffset);
    assert.ok(slice.startsWith("|"), "offset 区间应是原文表格行");
  }
});

test("chunkText 短表格保持单块且带表头", () => {
  const md = `# 小表\n\n| A | B |\n| --- | --- |\n| 1 | 2 |`;
  const chunks = chunkText({ format: "md", text: md }, { target: 400, hardStep: 350, minLength: 10 });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.includes("| A | B |"));
});
