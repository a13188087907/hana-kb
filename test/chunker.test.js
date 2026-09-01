import test from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../core/chunker.js";

const paragraph = (char, length) => char.repeat(length);

test("accumulates paragraphs near 400 without overlap", () => {
  const text = `${paragraph("甲", 180)}\n\n${paragraph("乙", 180)}\n\n${paragraph("丙", 80)}`;
  const chunks = chunkText({ text, format: "txt" }, { target: 400, hardStep: 350, minLength: 30 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, `${paragraph("甲", 180)}\n\n${paragraph("乙", 180)}`);
  assert.ok(chunks[0].endOffset <= chunks[1].startOffset);
  assert.equal(text.slice(chunks[0].startOffset, chunks[0].endOffset), chunks[0].text);
});

test("hard cuts long paragraphs by 350 step with overlap", () => {
  const text = paragraph("长", 900);
  const chunks = chunkText({ text, format: "txt" }, { target: 400, hardStep: 350, minLength: 30 });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].text.length, 400);
  assert.equal(chunks[1].startOffset, 350);
  assert.equal(chunks[1].text.slice(0, 50), chunks[0].text.slice(-50));
  assert.equal(chunks[2].startOffset, 700);
});

test("drops short fragments and keeps markdown title paths, code blocks, and tables", () => {
  const text = [
    "# 一级",
    "",
    "## 二级",
    "",
    paragraph("段", 45),
    "",
    "```js",
    "const value = 1;",
    "```",
    "",
    "| 列1 | 列2 |",
    "| --- | --- |",
    "| 值1 | 值2 |",
  ].join("\n");
  const chunks = chunkText({ text, format: "md" }, { target: 400, hardStep: 350, minLength: 30 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].titlePath, "一级 > 二级");
  // 标题路径 prepend 进块文本（embedding 语义增强，offset 仍指向原文）
  assert.ok(chunks[0].text.startsWith("一级 > 二级 > "));
  assert.equal(chunks[0].text.includes("```js\nconst value = 1;\n```") , true);
  assert.equal(chunks[0].text.includes("| 列1 | 列2 |"), true);
  assert.equal(text.slice(chunks[0].startOffset, chunks[0].endOffset), chunks[0].text.slice("一级 > 二级 > ".length));
});


test("前言块不混入标题行，小数不误判为条款", () => {
  const text = ["前言段落，介绍文档背景信息，长度凑够三十个字符以上以便成块。", "", "# 第一章 总则", "", "1.5倍杠杆属于风险提示，不是条款编号，这句话也需要足够长度。", "", "## 第一节 范围", "", "本节内容正文，需要超过三十个字符才会被保留下来，继续补充一点内容。"].join("\n");
  const chunks = chunkText({ text, format: "md" }, { minLength: 30 });
  // 前言块不含 "第一章" 标题行
  const preface = chunks[0];
  assert.ok(!preface.text.includes("第一章"));
  // "1.5倍" 不被识别为条款链（不产生以 "1.5" 为路径的块）
  assert.ok(!chunks.some((c) => /(^|>) ?1\.5( >|$)/.test(c.titlePath || "")));
});
