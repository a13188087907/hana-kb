// 中文结构感知分块器：结构树 + 递归装箱
// 设计：文档解析为结构树（标题/加粗编号标题/中文条款链/表格/代码/段落），
// 递归装箱——单元 ≤ max 整块保留；超长降级到子单元；叶子超长句子切→字符硬切（带 hardStep 重叠）；
// 同级条款兄弟合并装箱（target）；续块带标题路径+（续）锚点。
// 中文层级（GB/T 9704 公文序 + 实测变体）：第X章/节 > 一、 > 第X条 > （一） > 1. > （1） > ①；多级链 5.5.1.1 段数即深度。
// offset 契约：块文本去掉标题路径前缀 = text.slice(startOffset, endOffset)。

const DEFAULTS = Object.freeze({ target: 400, hardStep: 350, minLength: 30, max: 640 });

const CN_NUM = "一二三四五六七八九十百千零两";
const CLAUSE_RULES = [
  { re: new RegExp(`^第[${CN_NUM}\\d]+[章节篇]`), level: 1 },
  { re: new RegExp(`^[${CN_NUM}]+、`), level: 2 },
  { re: new RegExp(`^第[${CN_NUM}\\d]+条`), level: 3 },
  { re: new RegExp(`^[（(][${CN_NUM}]+[)）]`), level: 4 },
  { re: /^\d{1,3}(?:[.．]\d{1,3})+(?![.．\d])/, chain: true },
  { re: /^\d+[.．、](?!\d)/, level: 5 },
  { re: /^[（(]\d+[)）]/, level: 6 },
  { re: /^[①-⑳]/, level: 7 },
];
const BOLD_HEADING = /^\*\*([^*]+)\*\*\s*$/;
const MD_HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const TABLE_SEPARATOR = /^\|[\s\-:|]+\|$/;

function classifyLine(line) {
  const t = line.trim();
  if (!t) return null;
  const md = MD_HEADING.exec(t);
  if (md) return { level: md[1].length, label: md[2], kind: "heading", content: false };
  const bold = BOLD_HEADING.exec(t);
  if (bold && CLAUSE_RULES.some((r) => r.re.test(bold[1].trim()))) {
    return { level: 2, label: bold[1].trim(), kind: "heading", content: false };
  }
  for (const rule of CLAUSE_RULES) {
    const m = rule.re.exec(t);
    if (!m) continue;
    // 小数/版本号防误识别：编号后无间隔紧跟数量单位（1.5倍、2.0版）不当条款；有空格间隔的（5.1 年后复查）放行
    if (/^[倍折元年月日岁斤米升克℃°%版本]/.test(t.slice(m[0].length))) return null;
    if (rule.chain) return { level: m[0].split(/[.．]/).length + 1, label: m[0], kind: "clause", content: true };
    return { level: rule.level + 1, label: m[0], kind: "clause", content: true };
  }
  return null;
}

// 节点：{ level, label, kind, contentStart, end, children[] }
// content 语义：heading 行不入正文（contentStart 跳过标题行）；clause 行即正文（contentStart 含该行）
function parseStructure(text) {
  const root = { level: 0, label: "", kind: "root", contentStart: 0, end: text.length, children: [] };
  const stack = [root];
  let offset = 0;
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const start = offset;
    offset += raw.length + 1;
    const node = classifyLine(raw);
    if (node) {
      while (stack.length > 1 && stack[stack.length - 1].level >= node.level) stack.pop();
      const child = {
        ...node,
        lineStart: start, // 行起点（引言段上界用，避免前言块混入标题行）
        contentStart: node.content ? start : start + raw.length + 1,
        end: start + raw.length,
        children: [],
      };
      stack[stack.length - 1].children.push(child);
      stack.push(child);
      i += 1;
      continue;
    }
    // 代码块原子：并入当前节点区间
    if (/^(```|~~~)/.test(raw.trim())) {
      const fence = raw.trim().slice(0, 3);
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) { offset += lines[i].length + 1; i += 1; }
      if (i < lines.length) { offset += lines[i].length + 1; i += 1; }
      stack[stack.length - 1].end = offset - 1;
      continue;
    }
    if (raw.trim()) stack[stack.length - 1].end = start + raw.length;
    i += 1;
  }
  // 修正 end：节点入栈后父级 end 停更，后序遍历把 end 提升为子树最大 end
  const fixEnd = (n) => {
    for (const c of n.children) fixEnd(c);
    if (n.children.length) n.end = Math.max(n.end, n.children[n.children.length - 1].end);
  };
  fixEnd(root);
  return root;
}

function parsePlain(text) {
  // txt：空行分段的平级树
  const root = { level: 0, label: "", kind: "root", contentStart: 0, end: text.length, children: [] };
  const lines = text.split("\n");
  let offset = 0, segStart = -1, i = 0;
  const closeSeg = (end) => {
    if (segStart < 0) return;
    root.children.push({ level: 1, label: "", kind: "paragraph", contentStart: segStart, end, children: [] });
    segStart = -1;
  };
  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim()) { if (segStart < 0) segStart = offset; root.end = offset + raw.length; }
    else closeSeg(offset - 1);
    offset += raw.length + 1;
    i += 1;
  }
  closeSeg(text.length);
  return root;
}

function enrich(text, titlePath) {
  return titlePath ? `${titlePath} > ${text}` : text;
}

function pathOf(ancestors) {
  return ancestors.map((a) => a.label).filter(Boolean).join(" > ");
}

export function chunkText(parsed, options = {}) {
  const text = String(parsed?.text ?? "");
  // max 语义：显式配置 target 时视为硬上限（max=target，兼容旧行为）；默认配置给条款完整性留 1.6 倍喘息空间
  const max = options.max ?? (Object.hasOwn(options, "target") ? Number(options.target) : DEFAULTS.max);
  const config = { ...DEFAULTS, ...options, max };
  const root = parsed?.format === "md" ? parseStructure(text) : parsePlain(text);
  const chunks = [];

  const emit = (start, end, path, cont = false) => {
    const body = text.slice(start, end).trim();
    if (body.length < config.minLength) return;
    const p = path ? `${path}${cont ? "（续）" : ""}` : "";
    chunks.push({
      text: enrich(body, p),
      titlePath: p,
      startOffset: start + (text.slice(start, end).length - text.slice(start, end).trimStart().length),
      endOffset: start + (text.slice(start, end).trimEnd().length),
      ordinal: chunks.length,
    });
  };

  // 叶子超长：表格段表头前置切 / 文本按句切 / 单句超长字符硬切（hardStep 重叠）
  const splitOversize = (start, end, path) => {
    let cursor = start;
    let cont = false;
    const sliceText = text.slice(start, end);
    const rowLines = [];
    let roff = 0;
    for (const line of sliceText.split("\n")) {
      rowLines.push({ text: line, start: start + roff, end: start + roff + line.length });
      roff += line.length + 1;
    }
    let seg = []; // 累积普通文本行
    const flushSeg = () => {
      if (!seg.length) return;
      const sStart = seg[0].start, sEnd = seg[seg.length - 1].end;
      const content = text.slice(sStart, sEnd);
      const sentences = content.split(/(?<=[。；！？\n])/).filter((s) => s.length);
      let buf = "", bStart = sStart, bOff = sStart;
      const flushBuf = (hard) => {
        if (buf.trim().length >= config.minLength || hard) {
          if (buf.trim()) { emit(bStart, bStart + buf.length, path, cont); cont = true; }
        }
        buf = "";
      };
      for (const s of sentences) {
        if (s.length > config.max) {
          flushBuf(false);
          for (let o = 0; o < s.length; o += config.hardStep) {
            const hStart = bOff + o;
            emit(hStart, Math.min(hStart + config.target, bOff + s.length), path, cont || o > 0);
            cont = true;
          }
          continue;
        }
        if (buf && buf.length + s.length > config.max) { flushBuf(false); bStart = bOff; }
        buf += s;
        bOff += s.length;
      }
      flushBuf(false);
      seg = [];
    };
    let tableStart = -1;
    const flushTable = (ti) => {
      if (tableStart < 0) return;
      pushTableRows(rowLines.slice(tableStart, ti), path, (c) => { cont = c; }, cont);
      tableStart = -1;
    };
    for (let li = 0; li < rowLines.length; li++) {
      const isTable = isTableLine(rowLines[li].text);
      if (isTable && tableStart < 0) { flushSeg(); tableStart = li; }
      if (!isTable && tableStart >= 0) flushTable(li);
      if (!isTable) seg.push(rowLines[li]);
    }
    flushTable(rowLines.length);
    flushSeg();
  };

  // 表格段：首块含表头+数据行，续块前置表头（实验证实：孤立数据行丢失列语义）
  const pushTableRows = (rows, path, setCont, cont) => {
    if (rows.length < 3 || !TABLE_SEPARATOR.test(rows[1]?.text.trim() ?? "")) {
      // 非标准表格：按行累积到 max
      let buf = [], bufLen = 0;
      for (const r of rows) {
        if (bufLen && bufLen + r.text.length + 1 > config.max) {
          emit(buf[0].start, buf[buf.length - 1].end, path, cont); cont = true; buf = []; bufLen = 0;
        }
        buf.push(r); bufLen += r.text.length + 1;
      }
      if (buf.length) { emit(buf[0].start, buf[buf.length - 1].end, path, cont); cont = true; }
      setCont(cont);
      return;
    }
    const header = `${rows[0].text.trim()}\n${rows[1].text.trim()}`;
    let buf = [], bufLen = header.length + 1;
    // 首块与续块均拼接表头；offset 指向数据行原文区间（续块表头为复制文本，与 enrich 前缀同语义）
    const flushBlock = () => {
      if (!buf.length) return;
      const s = buf[0].start, e = buf[buf.length - 1].end;
      const body = `${header}\n${buf.map((r) => r.text.trim()).join("\n")}`;
      if (body.trim().length >= config.minLength) {
        chunks.push({ text: enrich(body, path ? `${path}${cont ? "（续）" : ""}` : ""), titlePath: path, startOffset: s, endOffset: e, ordinal: chunks.length });
      }
      cont = true; buf = []; bufLen = header.length + 1;
    };
    for (const r of rows.slice(2)) {
      if (buf.length && bufLen + r.text.length + 1 > config.max) flushBlock();
      buf.push(r); bufLen += r.text.length + 1;
    }
    flushBlock();
    setCont(true);
  };

  const pack = (node, ancestors) => {
    const path = pathOf([...ancestors, node]);
    const size = node.end - node.contentStart;
    // 整单元成块条件：大小合适，且不含标题类子节点（标题子结构意味着更细粒度可走，路径要深入到内容所在层）
    const hasHeadingChild = node.children.some((c) => c.kind === "heading");
    if (node !== root && size >= config.minLength && size <= config.max && !hasHeadingChild) {
      emit(node.contentStart, node.end, path);
      return;
    }
    // 超长：自身引言段（contentStart 到首 child 行起点）先行
    const firstChildStart = node.children.length ? node.children[0].lineStart : node.end;
    if (firstChildStart > node.contentStart) {
      const ownLen = firstChildStart - node.contentStart;
      if (ownLen <= config.max) emit(node.contentStart, firstChildStart, path);
      else splitOversize(node.contentStart, firstChildStart, path);
    }
    // 子单元：heading 各自递归；clause/paragraph 兄弟合并装箱到 target
    let buf = [], bufLen = 0;
    const flushBuf = () => {
      if (!buf.length) return;
      emit(buf[0].contentStart, buf[buf.length - 1].end, path);
      buf = []; bufLen = 0;
    };
    for (const child of node.children) {
      const cSize = child.end - child.contentStart;
      const mergeable = child.kind !== "heading";
      if (!mergeable || cSize > config.max) { flushBuf(); pack(child, [...ancestors, node]); continue; }
      if (bufLen && bufLen + cSize > config.target) flushBuf();
      buf.push(child); bufLen += cSize;
    }
    flushBuf();
  };

  pack(root, []);
  if (root.contentStart < root.end && !root.children.length) {
    // 整篇无结构：按超长/普通处理
    const size = root.end - root.contentStart;
    if (size <= config.max) emit(root.contentStart, root.end, "");
    else splitOversize(root.contentStart, root.end, "");
  }
  // 文档级兜底：整篇因过短被清空时保留全文一块
  if (chunks.length === 0 && text.trim().length > 0) {
    const trimmed = text.trim();
    const start = text.indexOf(trimmed);
    chunks.push({ text: trimmed, titlePath: "", startOffset: start, endOffset: start + trimmed.length, ordinal: 0 });
  }
  return chunks;
}

function isTableLine(line) {
  const value = line.trim();
  return value.startsWith("|") && value.includes("|", 1);
}

export { parseStructure, chunkText as default };
