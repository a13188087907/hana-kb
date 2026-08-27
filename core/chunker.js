const DEFAULTS = Object.freeze({ target: 400, hardStep: 350, minLength: 30 });

function enrich(text, titlePath) {
  return titlePath ? `${titlePath} > ${text}` : text;
}

export function chunkText(parsed, options = {}) {
  const text = String(parsed?.text ?? "");
  const config = { ...DEFAULTS, ...options };
  const units = parsed?.format === "md" ? markdownUnits(text) : plainUnits(text);
  const chunks = [];
  let pending = null;

  const flush = () => {
    if (!pending) return;
    const chunkTextValue = text.slice(pending.start, pending.end);
    if (chunkTextValue.trim().length >= config.minLength) {
      chunks.push({
        text: enrich(chunkTextValue, pending.titlePath),
        titlePath: pending.titlePath,
        startOffset: pending.start,
        endOffset: pending.end,
        ordinal: chunks.length,
      });
    }
    pending = null;
  };

  for (const unit of units) {
    const value = text.slice(unit.start, unit.end);
    if (value.length > config.target) {
      flush();
      // 表格感知：续块前置表头行+分隔行，避免孤立数据行丢失列语义（实验证实：表头丢失后“次均单价”类查询无法命中孤立行）
      if (tryPushTableChunks(chunks, text, unit, config)) continue;
      for (let offset = 0; offset < value.length; offset += config.hardStep) {
        const start = unit.start + offset;
        const end = Math.min(start + config.target, unit.end);
        if (text.slice(start, end).trim().length >= config.minLength) {
          chunks.push({
            text: enrich(text.slice(start, end), unit.titlePath),
            titlePath: unit.titlePath,
            startOffset: start,
            endOffset: end,
            ordinal: chunks.length,
          });
        }
      }
      continue;
    }

    if (!pending) {
      pending = { ...unit };
      continue;
    }
    if (pending.titlePath !== unit.titlePath || unit.end - pending.start > config.target) {
      flush();
      pending = { ...unit };
    } else {
      pending.end = unit.end;
    }
  }
  flush();
  // 文档级兜底：整篇文档若因过短被清空，保留全文为一块（避免“入库成功但搜不到”的假象）
  if (chunks.length === 0 && text.trim().length > 0) {
    const trimmed = text.trim();
    const start = text.indexOf(trimmed);
    chunks.push({
      text: trimmed,
      titlePath: "",
      startOffset: start,
      endOffset: start + trimmed.length,
      ordinal: 0,
    });
  }
  return chunks;
}

function plainUnits(text) {
  return paragraphUnits(text, () => "");
}

function markdownUnits(text) {
  const lines = linesWithOffsets(text);
  const units = [];
  const headings = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.text.trim()) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line.text.trim());
    if (heading) {
      const level = heading[1].length;
      headings.length = level - 1;
      headings[level - 1] = heading[2];
      index += 1;
      continue;
    }

    if (/^(```|~~~)/.test(line.text.trim())) {
      const startIndex = index;
      const fence = line.text.trim().slice(0, 3);
      index += 1;
      while (index < lines.length && !lines[index].text.trim().startsWith(fence)) index += 1;
      if (index < lines.length) index += 1;
      units.push(makeUnit(text, lines[startIndex].start, lines[Math.max(startIndex, index - 1)].end, headings));
      continue;
    }

    if (isTableLine(line.text)) {
      const startIndex = index;
      while (index < lines.length && isTableLine(lines[index].text)) index += 1;
      units.push(makeUnit(text, lines[startIndex].start, lines[index - 1].end, headings));
      continue;
    }

    const startIndex = index;
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      const nextHeading = /^(#{1,6})\s+(.+?)\s*$/.test(next.text.trim());
      if (!next.text.trim() || nextHeading || /^(```|~~~)/.test(next.text.trim()) || isTableLine(next.text)) break;
      index += 1;
    }
    units.push(makeUnit(text, lines[startIndex].start, lines[index - 1].end, headings));
  }
  return units;
}

function paragraphUnits(text, titlePath) {
  const lines = linesWithOffsets(text);
  const units = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && !lines[index].text.trim()) index += 1;
    if (index >= lines.length) break;
    const startIndex = index;
    while (index < lines.length && lines[index].text.trim()) index += 1;
    units.push(makeUnit(text, lines[startIndex].start, lines[index - 1].end, titlePath()));
  }
  return units;
}

function makeUnit(text, start, end, headings) {
  const raw = text.slice(start, end);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  return {
    start: start + leading,
    end: end - trailing,
    titlePath: Array.isArray(headings) ? headings.filter(Boolean).join(" > ") : headings,
  };
}

function isTableLine(text) {
  const value = text.trim();
  return value.startsWith("|") && value.includes("|", 1);
}

const TABLE_SEPARATOR = /^\|[\s\-:|]+\|$/;

// 表格 unit 超限时按行切：首块含表头+数据行，续块前置表头再续数据行。
// 返回 false 表示不是标准 md 表格（回退硬滑窗）。
// 续块 prepend 的表头是复制文本，不计入 offset——offset 仍指向该块数据行在原文中的区间（与 enrich 的 titlePath prepend 同一语义）。
function tryPushTableChunks(chunks, text, unit, config) {
  const value = text.slice(unit.start, unit.end);
  const lines = [];
  let offset = 0;
  for (const line of value.split("\n")) {
    if (line.trim()) lines.push({ text: line, start: unit.start + offset, end: unit.start + offset + line.length });
    offset += line.length + 1;
  }
  if (lines.length < 3) return false;
  if (!TABLE_SEPARATOR.test(lines[1].text.trim())) return false;
  const headerText = `${lines[0].text.trim()}\n${lines[1].text.trim()}`;
  const dataLines = lines.slice(2);
  const headerCost = headerText.length + 1;

  let block = [];
  let blockLen = headerCost;
  const flushBlock = () => {
    if (!block.length) return;
    chunks.push({
      text: enrich(`${headerText}\n${block.map((l) => l.text.trim()).join("\n")}`, unit.titlePath),
      titlePath: unit.titlePath,
      startOffset: block[0].start,
      endOffset: block[block.length - 1].end,
      ordinal: chunks.length,
    });
    block = [];
    blockLen = headerCost;
  };
  for (const line of dataLines) {
    if (block.length && blockLen + line.text.length + 1 > config.target) flushBlock();
    block.push(line);
    blockLen += line.text.length + 1;
  }
  flushBlock();
  return true;
}

function linesWithOffsets(text) {
  const result = [];
  let start = 0;
  for (const line of text.split("\n")) {
    result.push({ text: line, start, end: start + line.length });
    start += line.length + 1;
  }
  return result;
}
