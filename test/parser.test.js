import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, removeDir } from "./helpers.js";
import { parseFile } from "../core/parser.js";


test("parses markdown as normalized UTF-8 text and removes BOM", () => {
  const dir = makeTempDir();
  try {
    const file = path.join(dir, "note.md");
    fs.writeFileSync(file, Buffer.from("\ufeff# 标题\r\n\r\n正文", "utf8"));
    const parsed = parseFile(file);
    assert.equal(parsed.format, "md");
    assert.equal(parsed.text, "# 标题\n\n正文");
  } finally {
    removeDir(dir);
  }
});

test("decodes GBK txt into the normalized text", () => {
  const dir = makeTempDir();
  try {
    const file = path.join(dir, "制度.txt");
    fs.writeFileSync(file, Buffer.from("连续上班时长不得超过规定", "utf8"));
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.from("连续上班时长不得超过规定", "binary"));
    // GBK bytes are supplied explicitly so the test does not depend on the host locale.
    fs.writeFileSync(file, Buffer.from([0xC1, 0xAC, 0xD0, 0xF8, 0xC9, 0xCF, 0xB0, 0xE0, 0xCA, 0xB1, 0xB3, 0xA4, 0xB2, 0xBB, 0xB5, 0xC3, 0xB3, 0xAC, 0xB9, 0xFD, 0xB9, 0xE6, 0xB6, 0xA8]));
    const parsed = parseFile(file);
    assert.equal(parsed.format, "txt");
    assert.equal(parsed.text, "连续上班时长不得超过规定");
    assert.notEqual(original.length, 0);
  } finally {
    removeDir(dir);
  }
});

test("rejects unsupported file extensions", () => {
  const dir = makeTempDir();
  try {
    const file = path.join(dir, "note.pdf");
    fs.writeFileSync(file, "not supported");
    assert.throws(() => parseFile(file), /unsupported file format/);
  } finally {
    removeDir(dir);
  }
});
