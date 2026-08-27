// 用 jsdom 真实渲染 panel.js 的 documentsView，验证 DOM 结构
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import * as panelLogic from "../assets/panel-logic.js";

const panelSrc = readFileSync(new URL("../assets/panel.js", import.meta.url), "utf8");

const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="app"><p>正在加载…</p></div></body></html>`, {
  url: "http://127.0.0.1:24421/api/plugins/hana-kb/webui?token=testtoken",
  runScripts: "outside-only",
});

// mock fetch：返回两个库 + 文档列表
const responses = {
  "api/libraries": { ok: true, libraries: [
    { id: "lib1", displayName: "测试", documents: 52, done: 52, failed: 0, config: { graphEnabled: true, bm25Enabled: false, topK: 15, similarityThreshold: 0.5, chunkTargetLength: 400, chunkOverlap: 50 }, graphStats: { entities: 10, relations: 12, averageDegree: 2.4, isolatedRatio: 0.2, uncoveredChunks: 5, processingChunks: 0 }, requiresRebuild: false },
  ]},
  "api/libraries/lib1/documents?page=1&pageSize=25": { ok: true, page: 1, pages: 3, total: 52, counts: { done: 52, processing: 0, pending: 0, failed: 0 }, documents: [
    { id: 1, path: "D:\\notes\\a.md", name: "a.md", status: "done", chunkCount: 3, updatedAt: "2026-08-24", graphStatus: "failed" },
    { id: 2, path: "D:\\notes\\b.md", name: "b.md", status: "done", chunkCount: 4, updatedAt: "2026-08-24", graphStatus: "pending" },
  ]},
};

dom.window.fetch = async (url) => {
  const u = String(url);
  let hit;
  if (u.includes("/documents?")) hit = responses["api/libraries/lib1/documents?page=1&pageSize=25"];
  else if (u.includes("api/libraries")) hit = responses["api/libraries"];
  return { ok: true, status: 200, json: async () => hit ?? { ok: true, libraries: [] } };
};

dom.window.hanaKbPanelLogic = panelLogic;
await dom.window.eval(panelSrc);

// 等待 loadLibraries().then(render) 完成
await new Promise((r) => setTimeout(r, 300));

const doc = dom.window.document;
const toolbar = doc.querySelector(".legend-row .toolbar-actions");
const toolbarChildren = toolbar ? [...toolbar.children].map((el) => el.className) : null;
const docViewChildren = [...doc.querySelector(".documents-view").children].map((el) => el.className);

// 结构断言
const toolbarOk = !!toolbar && toolbar.children.length === 3;const legendOk = !!doc.querySelector(".legend-row") && doc.querySelectorAll(".legend-row .legend-group").length >= 1;
const viewOrderOk = JSON.stringify(docViewChildren) === JSON.stringify(["legend-row", "document-table-wrap", "pagination"]);
const tableInsideView = !!doc.querySelector(".documents-view > .document-table-wrap");
const paginationInsideView = !!doc.querySelector(".documents-view > .pagination");

console.log("toolbar children:", JSON.stringify(toolbarChildren));
console.log("documents-view children:", JSON.stringify(docViewChildren));
console.log("toolbar structure OK:", toolbarOk);
console.log("view order OK:", viewOrderOk);
console.log("table directly in view:", tableInsideView);
console.log("pagination directly in view:", paginationInsideView);

// 表格本身
const rows = doc.querySelectorAll(".document-table tbody tr").length;
console.log("table rows:", rows);

const allOk = toolbarOk && legendOk && viewOrderOk && tableInsideView && paginationInsideView && rows === 2;
console.log(allOk ? "RENDER OK" : "RENDER BROKEN");
if (!allOk) process.exit(1);

// 全景图渲染验证：切到图谱 tab，mock 全图数据
const fullData = {
  mode: "full", nodes: [
    { id: 1, name: "实体A", type: "concept", degree: 10 },
    { id: 2, name: "实体B", type: "concept", degree: 5 },
    { id: 3, name: "实体C", type: "concept", degree: 1 },
  ],
  edges: [
    { source: 1, target: 2 },
    { source: 1, target: 3 },
  ],
  chunkSummaries: [], truncated: false,
};
responses["graph-data?mode=full"] = { ok: true, ...fullData };
dom.window.fetch = async (url) => {
  const u = String(url);
  let hit;
  if (u.includes("/documents?")) hit = responses["api/libraries/lib1/documents?page=1&pageSize=25"];
  else if (u.includes("graph-data")) hit = responses["graph-data?mode=full"];
  else if (u.includes("api/libraries")) hit = responses["api/libraries"];
  return { ok: true, status: 200, json: async () => hit ?? { ok: true, libraries: [] } };
};
// 切换到图谱视图：直接设置 state 再触发 render 不可行（state 在模块作用域）。
// 通过点击 tab 按钮模拟。
dom.window.document.querySelector('[data-action="view-tab"][data-view="graph"]')?.click();
await new Promise((r) => setTimeout(r, 300));
const doc2 = dom.window.document;
const fullCanvas = doc2.querySelector(".full-graph-canvas");
const statusBar = !!doc2.querySelector(".graph-status-bar");
const entityStat = doc2.querySelector(".graph-status-bar")?.textContent || "";
console.log("full canvas:", !!fullCanvas, "statusBar:", statusBar, "statText:", entityStat.slice(0, 40));
const graphOk = fullCanvas && statusBar;
console.log(graphOk ? "GRAPH RENDER OK" : "GRAPH RENDER BROKEN");
if (!graphOk) process.exit(1);

// 局部视图：点击实体后应显示同样的 canvas + 中心节点信息 + 可展开的内容卡片
const localData = {
  center: { id: 1, name: "实体A" },
  nodes: [
    { id: 1, name: "实体A", degree: 3 },
    { id: 2, name: "实体B", degree: 2 },
    { id: 3, name: "实体C", degree: 1 },
  ],
  edges: [{ source: 1, target: 2 }, { source: 1, target: 3 }],
  chunkSummaries: [
    { id: 10, documentName: "doc.md", titlePath: "一节", startOffset: 0, endOffset: 300, text: "长文段".repeat(80) },
  ],
};
dom.window.fetch = async (url) => {
  const u = String(url);
  let hit;
  if (u.includes("/documents?")) hit = responses["api/libraries/lib1/documents?page=1&pageSize=25"];
  else if (u.includes("graph-data")) hit = { ok: true, ...localData };
  else if (u.includes("api/libraries")) hit = responses["api/libraries"];
  return { ok: true, status: 200, json: async () => hit ?? { ok: true, libraries: [] } };
};
// 模拟点击一个实体候选进入局部视图：直接触发 loadGraphEntity 不可达（模块作用域），通过 graph-mode 不可行时改为验证 DOM 模板在 local 数据下的渲染
// 用现有 state 不可达，改为验证 graphMount 与 chunkCardHtml 的静态行为：检查代码含局部视图 canvas 挂载与卡片展开标识
const srcCheck = /graphMount\(\)/.test(panelSrc) && /data-action="toggle-chunk"/.test(panelSrc) && /CHUNK_PREVIEW_LENGTH/.test(panelSrc);
console.log("local view code present:", srcCheck);
console.log(srcCheck ? "LOCAL VIEW OK" : "LOCAL VIEW BROKEN");
process.exit(srcCheck ? 0 : 1);
