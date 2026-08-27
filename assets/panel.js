const panelLogic = globalThis.hanaKbPanelLogic || {};
const clipLocalGraph = panelLogic.clipLocalGraph || ((data) => data);
const fileTypeLabel = panelLogic.fileTypeLabel || (() => "文件");
const graphEntityRequest = panelLogic.graphEntityRequest || ((libraryId, entityId) => `api/libraries/${encodeURIComponent(String(libraryId))}/graph-data?entityId=${encodeURIComponent(String(entityId))}`);
const isResourcePickerAvailable = panelLogic.isResourcePickerAvailable || ((host) => typeof host?.resources?.pick === "function");
const resourcePickOptions = panelLogic.resourcePickOptions || ((mode) => ({ mode: mode === "directory" ? "directory" : "file", multiple: mode !== "directory" }));
const pickedResourcePaths = panelLogic.pickedResourcePaths || ((picked) => {
  const items = Array.isArray(picked) ? picked : Array.isArray(picked?.resources) ? picked.resources : [picked];
  return items.map((item) => String(item?.path || item?.resource?.path || (typeof item === "string" ? item : ""))).filter(Boolean);
});
const selectionAfterToggleAll = panelLogic.selectionAfterToggleAll || ((selected, paths, checked) => {
  const next = new Set(selected);
  for (const path of paths) checked ? next.add(String(path)) : next.delete(String(path));
  return next;
});
const statusLabel = panelLogic.statusLabel || ((status) => status || "未知");
const toggleExpanded = panelLogic.toggleExpanded || ((expanded, id) => new Set(expanded).add(String(id)));
const toggleSelectedPath = panelLogic.toggleSelectedPath || ((selected, path, checked) => selectionAfterToggleAll(selected, [path], checked));
const tokenizedUrl = panelLogic.tokenizedUrl || ((base, route, authToken) => `${base}/${String(route).replace(/^\//, "")}${authToken ? `?token=${encodeURIComponent(authToken)}` : ""}`);
const app = document.querySelector("#app");
const token = new URLSearchParams(location.search).get("token") || "";
const apiBase = location.pathname.replace(/\/webui\/?$/, "");
const state = {
  libraries: [],
  libraryId: "",
  documents: null,
  documentPage: 1,
  view: "documents",
  selectedPaths: new Set(),
  menuLibraryId: "",
  modal: "",
  drawer: "",
  pickerMenu: false,
  confirm: null,
  searchResults: [],
  searchQuery: "",
  graphPoll: null,
  searchTopK: 15,
  searchThreshold: 0.5,
  expandedResults: new Set(),
  graph: null,
  graphCandidates: [],
  fullGraph: null,
  graphMode: "full",
  expandedChunks: new Set(),
  message: "",
  statusPoll: null,
  ingestBusy: false,
  globalConfig: null,
  viewDoc: null,
  previewFile: null,
  urlModal: false,
  urlBusy: false,
};

function hanaFetch(route, init) {
  return fetch(tokenizedUrl(apiBase, route, token), init);
}

async function request(route, init) {
  const response = await hanaFetch(route, init);
  const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || !data.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char]));
}

function selectedLibrary() {
  return state.libraries.find((item) => item.id === state.libraryId) || null;
}

function libraryLabel(library) {
  return library?.displayName || library?.id || "";
}

function setMessage(message) {
  state.message = message || "";
}

function sourceLabel(source) {
  return ({ vector: "向量", bm25: "BM25", rrf: "向量 + BM25", graph: "图谱追加" }[source] || source || "向量");
}

function statusHtml(status, detail = "") {
  return `<span class="status status-${escapeHtml(status)}"><i aria-hidden="true"></i><span>${escapeHtml(statusLabel(status))}</span>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</span>`;
}

function iconSvg(name) {
  if (name === "flask") return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6M10 3v6.5L5.4 17a2.5 2.5 0 0 0 2 4h9.2a2.5 2.5 0 0 0 2-4L14 9.5V3M7.2 16h9.6"/></svg>`;
  if (name === "settings") return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z"/><path d="m19 13.4 1.4 1.1-1.7 3-1.7-.7a7.8 7.8 0 0 1-2 1.2l-.3 1.8h-3.4L11 18a7.8 7.8 0 0 1-2-1.2l-1.7.7-1.7-3L7 13.4a7.7 7.7 0 0 1 0-2.4L5.6 9.9l1.7-3 1.7.7a7.8 7.8 0 0 1 2-1.2l.3-1.8h3.4l.3 1.8a7.8 7.8 0 0 1 2 1.2l1.7-.7 1.7 3-1.4 1.1a7.7 7.7 0 0 1 0 2.4Z"/></svg>`;
  return "";
}

async function loadLibraries() {
  const data = await request("api/libraries");
  state.libraries = data.libraries || [];
  if (!state.libraryId && state.libraries[0]) state.libraryId = state.libraries[0].id;
  if (state.libraryId && !state.libraries.some((item) => item.id === state.libraryId)) state.libraryId = state.libraries[0]?.id || "";
  return state.libraries;
}

async function loadDocuments(page = state.documentPage) {
  if (!state.libraryId) return;
  const data = await request(`api/libraries/${encodeURIComponent(state.libraryId)}/documents?page=${page}&pageSize=25`);
  state.documents = data;
  state.documentPage = data.page;
  const visiblePaths = (data.documents || []).map((item) => item.path);
  state.selectedPaths = new Set([...state.selectedPaths].filter((path) => visiblePaths.includes(path)));
}

function documentsOnPage() {
  return state.documents?.documents || [];
}

function shouldPollDocuments() {
  const counts = state.documents?.counts || {};
  return Boolean(counts.pending || counts.processing);
}

function latestUpdatedAt() {
  return documentsOnPage().map((item) => item.updatedAt).filter(Boolean).sort().at(-1) || "";
}

function libraryUpdatedLabel() {
  const updatedAt = latestUpdatedAt();
  return updatedAt ? `更新于 ${updatedAt}` : "尚未导入文档";
}

function sidebarHtml() {
  const rows = state.libraries.length
    ? state.libraries.map((item) => `<div class="library-row ${item.id === state.libraryId ? "selected" : ""}">
        <button class="library-select" data-action="open-library" data-library-id="${escapeHtml(item.id)}"><span class="library-mark"></span><span class="library-copy"><strong>${escapeHtml(libraryLabel(item))}</strong><small>${Number(item.documents || 0)} 个文件 · ${Number(item.done || 0)} 就绪</small></span></button>
        <button class="more-button" aria-label="${escapeHtml(libraryLabel(item))} 更多操作" data-action="toggle-menu" data-library-id="${escapeHtml(item.id)}">···</button>
        ${state.menuLibraryId === item.id ? `<div class="library-menu"><button data-action="open-settings" data-library-id="${escapeHtml(item.id)}">库设置</button><button class="danger-text" data-action="delete-library" data-library-id="${escapeHtml(item.id)}">删除知识库</button></div>` : ""}
      </div>`).join("")
    : `<p class="sidebar-empty">还没有知识库</p>`;
  return `<aside class="sidebar"><div class="brand"><span class="brand-rule"></span><div><p class="eyebrow">HANA / KNOWLEDGE</p><strong>知识库</strong></div></div><button class="create-button" data-action="open-create">＋ <span>新建知识库</span></button><button class="global-settings-button" data-action="open-global-settings">${iconSvg("settings")} <span>全局设置</span></button><div class="library-list"><p class="sidebar-label">我的知识库 <span>${state.libraries.length}</span></p>${rows}</div><div class="sidebar-foot">本地索引 · 向量 / BM25 / 图谱</div></aside>`;
}

function renderTabs() {
  return `<div class="content-tabs" role="tablist"><button class="content-tab ${state.view === "documents" ? "active" : ""}" data-action="view-tab" data-view="documents" role="tab" aria-selected="${state.view === "documents"}">文件 <span>${Number(selectedLibrary()?.documents || 0)}</span></button><button class="content-tab ${state.view === "graph" ? "active" : ""}" data-action="view-tab" data-view="graph" role="tab" aria-selected="${state.view === "graph"}">图谱</button></div>`;
}

function renderHeader() {
  const library = selectedLibrary();
  return `<header class="workspace-header"><div><p class="eyebrow">CURRENT LIBRARY</p><h1>${escapeHtml(libraryLabel(library))}</h1><p class="updated-line">${escapeHtml(libraryUpdatedLabel())}</p></div><div class="header-actions"><button class="outline-button icon-button" data-action="open-search" title="召回测试">${iconSvg("flask")}<span>召回测试</span></button><button class="outline-button icon-button settings-trigger" data-action="open-settings" data-library-id="${escapeHtml(library.id)}" title="库设置">${iconSvg("settings")}<span>库设置</span></button></div></header>`;
}

const DOT_COLORS = { done: "#4E7162", processing: "#4A7A94", pending: "#9A7132", failed: "#9D5F4D" };
const DOT_LABELS = { done: "就绪", processing: "处理中", pending: "等待", failed: "失败" };

function dotHtml(status, extra) {
  const color = DOT_COLORS[status] || "#8F867B";
  const label = DOT_LABELS[status] || status;
  const title = extra ? `${label} · ${extra}` : label;
  return `<i class="status-dot" style="background:${color}" title="${escapeHtml(title)}"></i>`;
}

function legendDot(status, count) {
  const color = DOT_COLORS[status] || "#8F867B";
  return `<span class="legend-item" title="${DOT_LABELS[status] || status}"><i class="status-dot" style="background:${color}"></i>${Number(count) || 0}</span>`;
}

function fileRow(item) {
  const checked = state.selectedPaths.has(item.path);
  const graphOn = Boolean(selectedLibrary()?.config?.graphEnabled);
  const vecExtra = item.error || (item.status === "processing" ? "入库中" : "");
  return `<tr class="document-row ${checked ? "checked" : ""}"><td class="check-cell"><input type="checkbox" data-action="select-document" data-path="${escapeHtml(item.path)}" ${checked ? "checked" : ""} aria-label="选择 ${escapeHtml(item.name)}"></td><td><div class="file-name"><span class="file-icon file-${escapeHtml(String(item.name).split(".").pop()?.toLowerCase() || "generic")}">${escapeHtml(String(item.name).split(".").pop()?.toUpperCase().slice(0, 3) || "FILE")}</span><div><strong>${escapeHtml(item.name)}</strong><small class="path-text" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</small></div></div></td><td class="type-cell">${escapeHtml(fileTypeLabel(item.name))}</td><td class="dot-cell">${dotHtml(item.status, vecExtra)}</td>${graphOn ? `<td class="dot-cell">${dotHtml(item.graphStatus)}</td>` : ""}<td class="updated-cell">${escapeHtml(item.updatedAt || "—")}</td><td class="action-cell"><button data-action="view-document" data-path="${escapeHtml(item.path)}">内容</button><button data-action="reingest-document" data-path="${escapeHtml(item.path)}">重新入库</button><button class="danger-text" data-action="delete-document" data-path="${escapeHtml(item.path)}">删除</button></td></tr>`;
}

function graphProgressLine() {
  const stats = selectedLibrary()?.graphStats || {};
  const graphOn = Boolean(selectedLibrary()?.config?.graphEnabled);
  if (!graphOn) return "";
  const processing = Number(stats.processingChunks || 0);
  const uncovered = Number(stats.uncoveredChunks || 0);
  if (processing > 0) return `<span class="graph-progress-line">图谱构建中：剩余 ${processing} 段</span>`;
  if (uncovered > 0) return `<span class="graph-progress-line">图谱待构建：${uncovered} 段</span>`;
  return "";
}

function documentsView() {
  const library = selectedLibrary();
  const documents = documentsOnPage();
  const counts = state.documents?.counts || {};
  const g = state.documents?.graphCounts || { done: 0, processing: 0, pending: 0, failed: 0 };
  const graphOn = Boolean(library?.config?.graphEnabled);
  const pagePaths = documents.map((item) => item.path);
  const allChecked = pagePaths.length > 0 && pagePaths.every((path) => state.selectedPaths.has(path));
  const rows = documents.length ? documents.map(fileRow).join("") : `<tr><td colspan="${graphOn ? 8 : 7}" class="empty-row">这个库还没有文件。点击右上角“添加数据源”开始。</td></tr>`;
  const legendContent = `<span class="legend-group"><span class="legend-label">向量</span>${legendDot("done", counts.done)}${legendDot("processing", counts.processing)}${legendDot("pending", counts.pending)}${legendDot("failed", counts.failed)}</span>${graphOn ? `<span class="legend-group"><span class="legend-label">图谱</span>${legendDot("done", g.done)}${legendDot("processing", g.processing)}${legendDot("pending", g.pending)}${legendDot("failed", g.failed)}</span>${graphProgressLine()}` : ""}`;
  return `<section class="documents-view"><div class="legend-row">${legendContent}<div class="toolbar-actions add-source-actions"><button class="outline-button" data-action="refresh-documents">刷新</button><button class="primary-button" data-action="add-source">＋ 添加数据源</button></div></div>${state.selectedPaths.size ? `<div class="selection-bar"><span>已选择 <strong>${state.selectedPaths.size}</strong> 项</span><button class="danger-text" data-action="bulk-delete">批量删除</button><button class="plain-button" data-action="clear-selection">清除选择</button></div>` : ""}<div class="document-table-wrap"><table class="document-table"><thead><tr><th class="check-cell"><input id="select-all" type="checkbox" ${allChecked ? "checked" : ""} ${pagePaths.length ? "" : "disabled"} aria-label="全选当前页"></th><th class="name-cell">名称</th><th class="type-cell">类型</th><th class="dot-cell">向量</th>${graphOn ? "<th class=\"dot-cell\">图谱</th>" : ""}<th class="updated-cell">更新时间</th><th class="action-cell">操作</th></tr></thead><tbody>${rows}</tbody></table></div><div class="pagination"><span>第 ${state.documents?.page || 1} / ${state.documents?.pages || 1} 页 · 共 ${state.documents?.total || 0} 项</span><span><button class="plain-button" data-action="documents-page" data-page="${Math.max(1, (state.documentPage || 1) - 1)}" ${state.documentPage <= 1 ? "disabled" : ""}>上一页</button><button class="plain-button" data-action="documents-page" data-page="${Math.min(state.documents?.pages || 1, (state.documentPage || 1) + 1)}" ${state.documentPage >= (state.documents?.pages || 1) ? "disabled" : ""}>下一页</button></span></div></section>`;
}

function graphMount() {
  return `<canvas class="full-graph-canvas" aria-label="图谱视图"></canvas>`;
}

let graphEngine = null;

function initGraphEngine() {
  const canvas = app.querySelector(".full-graph-canvas");
  if (!canvas) return;
  const data = state.graphMode === "local" && state.graph?.nodes?.length ? state.graph : state.fullGraph;
  if (!data?.nodes?.length) return;
  if (graphEngine) graphEngine.destroy();
  const centerId = state.graphMode === "local" ? state.graph?.center?.id : null;
  graphEngine = createForceGraphEngine(canvas, data, {
    centerId,
    onNodeClick: (id) => { loadGraphEntity(String(id)); },
  });
}

function createForceGraphEngine(canvas, data, handlers) {
  const centerId = handlers?.centerId ?? null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => {
    const w = Math.max(320, canvas.parentElement?.getBoundingClientRect().width || 800);
    const h = 560;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
  };
  resize();
  const ctx = canvas.getContext("2d");
  if (!ctx) return { destroy() {} };

  const nodes = (data.nodes || []).map((n) => ({
    id: n.id, name: n.name, degree: Number(n.degree) || 1,
    x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
  }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const links = (data.edges || []).map((e) => {
    const s = nodeById.get(e.source), t = nodeById.get(e.target);
    return s && t ? { source: s, target: t } : null;
  }).filter(Boolean);
  const neighborsOf = new Map(nodes.map((n) => [n.id, new Set()]));
  for (const l of links) { neighborsOf.get(l.source.id).add(l.target.id); neighborsOf.get(l.target.id).add(l.source.id); }
  // 确定性螺旋初始布局（即使模拟不收敛也保证可看的图）；局部视图时中心节点置中
  nodes.forEach((n, i) => {
    if (n.id === centerId) { n.x = 0; n.y = 0; return; }
    const centerIndex = nodes.findIndex((x) => x.id === centerId);
    const idx = centerId == null ? i : (i > centerIndex ? i - 1 : i);
    const t = idx / Math.max(1, nodes.length);
    const radius = 90 + Math.sqrt(t) * 340;
    const angle = idx * 2.39996;
    n.x = Math.cos(angle) * radius;
    n.y = Math.sin(angle) * radius;
  });

  const view = { x: 0, y: 0, k: 1 };
  let alpha = 1, alphaMin = 0.05;
  const cell = 60;
  const REPULSE_DIST = 70;
  let grid = new Map();
  // 节点半径：对数绝对值映射 + 上限（不除以 maxDegree，避免长尾 hub 压扁所有节点；log2 压缩长尾）
  const nodeRadius = (degree) => Math.min(14, 1.8 + Math.log2(Number(degree) + 1) * 1.1);

  function rebuildGrid() {
    grid = new Map();
    for (const n of nodes) {
      const key = Math.floor(n.x / cell) + "," + Math.floor(n.y / cell);
      const bucket = grid.get(key);
      if (bucket) bucket.push(n); else grid.set(key, [n]);
    }
  }

  function tick() {
    rebuildGrid();
    const REPULSE = 700;
    for (const n of nodes) {
      if (n.fx != null) continue;
      const cx = Math.floor(n.x / cell), cy = Math.floor(n.y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(gx + "," + gy);
        if (!bucket) continue;
        for (const m of bucket) {
          if (m === n) continue;
          const dx = n.x - m.x, dy = n.y - m.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= REPULSE_DIST * REPULSE_DIST || d2 < 1) continue;
          const d = Math.sqrt(d2);
          const f = REPULSE / d2;
          n.vx += (dx / d) * f; n.vy += (dy / d) * f;
        }
      }
    }
    for (const l of links) {
      const dx = l.target.x - l.source.x, dy = l.target.y - l.source.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const f = (d - 30) * 0.028;
      const ux = dx / d, uy = dy / d;
      if (l.source.fx == null) { l.source.vx += ux * f; l.source.vy += uy * f; }
      if (l.target.fx == null) { l.target.vx -= ux * f; l.target.vy -= uy * f; }
    }
    for (const n of nodes) {
      if (n.fx != null) continue;
      n.vx -= n.x * 0.0008; n.vy -= n.y * 0.0008;
    }
    // 积分 + 钳制，防止发散（阻尼对齐 d3 velocityDecay 0.4 语义：速度每帧保留 60%）
    const MAX_SPEED = 26, MAX_POS = 3600;
    for (const n of nodes) {
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.6; n.vy *= 0.6;
      const sp = Math.hypot(n.vx, n.vy);
      if (sp > MAX_SPEED) { n.vx = (n.vx / sp) * MAX_SPEED; n.vy = (n.vy / sp) * MAX_SPEED; }
      n.x += n.vx * alpha; n.y += n.vy * alpha;
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || Math.hypot(n.x, n.y) > MAX_POS) {
        const a2 = Math.random() * Math.PI * 2;
        n.x = Math.cos(a2) * 200; n.y = Math.sin(a2) * 200; n.vx = 0; n.vy = 0;
      }
    }
    alpha = Math.max(alphaMin, alpha * 0.92);
  }

  let hoverNode = null;
  function draw() {
    const w = canvas.width / dpr, h = canvas.height / dpr;
    // 每帧重置变换：canvas.width 赋值会清空 transform，不能依赖初始 scale
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + view.x, h / 2 + view.y);
    ctx.scale(view.k, view.k);
    const hoverId = hoverNode ? hoverNode.id : null;
    ctx.lineWidth = 0.55 / view.k;
    // 批量绘制连线：分组一次 stroke
    const dimLines = [], litLines = [];
    for (const l of links) {
      if (hoverId != null && l.source.id !== hoverId && l.target.id !== hoverId) dimLines.push(l);
      else litLines.push(l);
    }
    if (dimLines.length) {
      ctx.strokeStyle = "rgba(74,122,148,0.07)";
      ctx.beginPath();
      for (const l of dimLines) { ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y); }
      ctx.stroke();
    }
    if (litLines.length) {
      ctx.strokeStyle = "rgba(74,122,148,0.45)";
      ctx.beginPath();
      for (const l of litLines) { ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y); }
      ctx.stroke();
    }
    // 批量绘制节点：三组（淡出/正常/悬停）各一次 fill
    const dimNodes = [], normalNodes = [], hotNodes = [];
    for (const n of nodes) {
      const neighbor = hoverId != null && hoverId !== n.id && neighborsOf.get(hoverId)?.has(n.id);
      if (n.id === hoverId) hotNodes.push(n);
      else if (hoverId != null && !neighbor) dimNodes.push(n);
      else normalNodes.push(n);
    }
    const paintNodes = (list, color) => {
      if (!list.length) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const n of list) {
      const r = nodeRadius(n.degree) / Math.min(view.k, 1.7);
        ctx.moveTo(n.x + r, n.y);
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    };
    paintNodes(dimNodes, "rgba(74,122,148,0.16)");
    paintNodes(normalNodes, "#4A7A94");
    paintNodes(hotNodes, "#9D5F4D");
    // 局部视图：中心节点用印章色描边突出
    if (centerId != null) {
      const center = nodeById.get(centerId);
      if (center) {
        const rr = nodeRadius(center.degree) / Math.min(view.k, 1.7) + 2.5 / Math.min(view.k, 1.7);
        ctx.strokeStyle = "#9D5F4D";
        ctx.lineWidth = 2 / Math.min(view.k, 1.7);
        ctx.beginPath();
        ctx.arc(center.x, center.y, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
    if (hoverNode) {
      ctx.fillStyle = "rgba(38,35,31,0.92)";
      const suffix = " · " + hoverNode.degree + " 条连线";
      ctx.font = "12px 'Inter','PingFang SC','Microsoft YaHei',sans-serif";
      // 截断名字而不是截断后缀，保证数字的含义永远可见
      let namePart = hoverNode.name;
      while (namePart.length > 2 && ctx.measureText(namePart + "…" + suffix).width + 16 > canvas.width / dpr - 24) {
        namePart = namePart.slice(0, -1);
      }
      const display = (namePart === hoverNode.name ? namePart : namePart + "…") + suffix;
      const tw = Math.min(ctx.measureText(display).width + 16, canvas.width / dpr - 24);
      ctx.fillRect(10, canvas.height / dpr - 34, tw, 24);
      ctx.fillStyle = "#FFFEFB";
      ctx.fillText(display, 18, canvas.height / dpr - 18);
    }
  }

  let raf = null, batch = 0;
  function fitView() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;
    const w = canvas.width / dpr, h = canvas.height / dpr;
    const pad = 48;
    const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
    view.k = Math.min(1.2, Math.max(0.04, Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY)));
    view.x = -((minX + maxX) / 2) * view.k;
    view.y = -((minY + maxY) / 2) * view.k;
  }
  function loop() {
    for (let i = 0; i < 4; i++) { tick(); }
    if (alpha <= alphaMin) {
      fitView();
      draw();
      raf = null;
      return;
    }
    draw();
    batch += 1;
    raf = batch % 6 === 0 ? setTimeout(loop, 0) : requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  let dragNode = null, dragMoved = false, dragStart = { x: 0, y: 0 };
  const toWorld = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - r.width / 2 - view.x) / view.k, y: (e.clientY - r.top - r.height / 2 - view.y) / view.k };
  };
  const findNode = (p) => {
    let best = null, bestD = 34 / view.k;
    for (const n of nodes) {
      const dx = n.x - p.x, dy = n.y - p.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  };
  canvas.style.cursor = "grab";
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => {
    const p = toWorld(e);
    dragMoved = false;
    dragNode = findNode(p);
    dragStart = dragNode ? p : { x: e.clientX - view.x, y: e.clientY - view.y };
    canvas.style.cursor = "grabbing";
    try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragNode) {
      const p = toWorld(e);
    if (!dragMoved && Math.hypot(p.x - dragStart.x, p.y - dragStart.y) < 3 / view.k) return;
      dragMoved = true;
      dragNode.fx = p.x; dragNode.fy = p.y;
      if (alpha < 0.18) alpha = 0.18;
      if (!raf) raf = requestAnimationFrame(loop);
    } else if (canvas.hasPointerCapture(e.pointerId)) {
      view.x = e.clientX - dragStart.x; view.y = e.clientY - dragStart.y;
      draw();
    } else {
      hoverNode = findNode(toWorld(e));
      canvas.style.cursor = hoverNode ? "pointer" : "grab";
      draw();
    }
  });
  const endPointer = () => {
    if (dragNode) {
      const id = dragNode.id;
      if (!dragMoved) handlers.onNodeClick(id);
      dragNode.fx = null; dragNode.fy = null; dragNode = null;
    }
    canvas.style.cursor = "grab";
    draw();
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left - r.width / 2, py = e.clientY - r.top - r.height / 2;
    const nk = Math.min(4, Math.max(0.1, view.k * (e.deltaY > 0 ? 0.88 : 1.14)));
    view.x = px - (px - view.x) * (nk / view.k);
    view.y = py - (py - view.y) * (nk / view.k);
    view.k = nk;
    draw();
  }, { passive: false });
  canvas.addEventListener("dblclick", () => { view.x = 0; view.y = 0; view.k = 1; draw(); });
  const observer = new ResizeObserver(() => { resize(); draw(); });
  if (canvas.parentElement) observer.observe(canvas.parentElement);

  return {
    destroy() {
      if (raf) { cancelAnimationFrame(raf); clearTimeout(raf); }
      raf = null;
      observer.disconnect();
      canvas.replaceWith(canvas.cloneNode());
    },
  };
}

function graphStatusBar(stats, library) {
  const graphOn = Boolean(library?.config?.graphEnabled);
  const processing = Number(stats.processingChunks || 0);
  const uncovered = Number(stats.uncoveredChunks || 0);
  const entities = Number(stats.entities || 0);
  const relations = Number(stats.uniqueEdges ?? stats.relations ?? 0);
  let buildBadge;
  if (!graphOn) buildBadge = statusHtml("pending", "图谱未开启");
  else if (processing > 0) buildBadge = statusHtml("processing", `构建中·剩${processing}`);
  else if (uncovered > 0) buildBadge = statusHtml("pending", `待建·${uncovered}`);
  else buildBadge = statusHtml("done", "构建完成");
  return `<div class="graph-status-bar">${buildBadge}<span class="graph-stat"><strong>${entities}</strong> 实体</span><span class="graph-stat"><strong>${relations}</strong> 连线</span><span class="graph-stat"><strong>${(Number(stats.isolatedRatio || 0) * 100).toFixed(1)}%</strong> 孤立</span><span class="graph-stat mono">平均度 ${Number(stats.averageDegree || 0).toFixed(2)}</span>${state.graphMode === "local" ? `<button class="plain-button" data-action="graph-back-full">返回全景</button>` : ""}</div>`;
}

const CHUNK_PREVIEW_LENGTH = 240;

function chunkCardHtml(chunk) {
  const text = String(chunk.text || chunk.summary || "");
  const expanded = state.expandedChunks.has(String(chunk.id));
  const truncated = text.length > CHUNK_PREVIEW_LENGTH;
  const body = expanded || !truncated ? text : text.slice(0, CHUNK_PREVIEW_LENGTH) + "…";
  return `<article class="chunk-card" data-action="toggle-chunk" data-chunk-id="${escapeHtml(chunk.id)}"><strong>${escapeHtml(chunk.documentName)}</strong><span>${escapeHtml(chunk.titlePath || "无标题")} · offset ${Number(chunk.startOffset || 0)}–${Number(chunk.endOffset || 0)}</span><p class="chunk-text">${escapeHtml(body)}</p>${truncated ? `<span class="result-hint">${expanded ? "点击收起" : "点击展开全文"}</span>` : ""}</article>`;
}

function graphView() {
  const library = selectedLibrary();
  const stats = library?.graphStats || {};
  const candidateHtml = state.graphCandidates.length ? `<div class="candidate-list">${state.graphCandidates.map((item) => `<button data-action="load-graph-entity" data-entity-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.type || "concept")}</small></button>`).join("")}</div>` : "";
  const graphContent = state.graphMode === "local" && state.graph?.center
    ? `<div class="graph-meta"><span>中心：<strong>${escapeHtml(state.graph.center.name)}</strong></span><span class="mono">${state.graph.nodes.length} nodes / ${state.graph.edges.length} edges</span><span class="hint">点击邻居节点直接跳到它的连线视角；拖动节点、滚轮缩放、双击复位</span></div>${graphMount()}${state.graph.chunkSummaries?.length ? `<section class="chunk-summaries"><p class="eyebrow">RELATED CHUNKS</p>${state.graph.chunkSummaries.slice(0, 12).map(chunkCardHtml).join("")}</section>` : ""}`
    : (state.fullGraph?.nodes?.length
      ? `<div class="graph-meta"><span class="hint">全景视图：悬停节点高亮其连线，拖动节点可整理布局，点击进入局部展开；滚轮缩放、拖拽平移、双击复位</span>${state.fullGraph.truncated ? `<span class="mono">（超上限截断展示）</span>` : ""}</div>${graphMount()}`
      : `<div class="graph-empty">${state.fullGraph ? "图谱还没有实体。" : "图谱数据加载中…"}</div>`);
  return `<section class="graph-view">${graphStatusBar(stats, library)}<form id="graph-search-form" class="graph-search"><label>搜索实体<input name="entity" required placeholder="输入实体名，查看它的一跳关系"></label><button class="primary-button" type="submit">搜索实体</button><button class="outline-button" type="button" data-action="rebuild-graph">补建图谱</button></form>${candidateHtml}<div class="graph-stage">${graphContent}</div></section>`;
}

function renderSearchDrawer() {
  if (state.drawer !== "search") return "";
  const options = state.libraries.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === state.libraryId ? "selected" : ""}>${escapeHtml(libraryLabel(item))}</option>`).join("");
  const results = state.searchResults.map((item, index) => {
    const expanded = state.expandedResults.has(String(item.id));
    return `<article class="result ${expanded ? "expanded" : ""}" data-action="toggle-result" data-result-id="${escapeHtml(item.id)}"><div class="result-head"><span class="rank">${String(index + 1).padStart(2, "0")}</span><span class="source source-${escapeHtml(item.source)}">${escapeHtml(sourceLabel(item.source))}</span><span class="mono score">${item.similarity == null ? "BM25" : Number(item.similarity).toFixed(4)}</span></div><div class="result-origin">${escapeHtml(item.documentName)} <span>/</span> ${escapeHtml(item.titlePath || "无标题")} <span>/</span> offset ${Number(item.startOffset || 0)}–${Number(item.endOffset || 0)}</div><div class="result-text">${escapeHtml(item.text)}</div><div class="result-hint">${expanded ? "点击收起" : "点击展开全文"}</div></article>`;
  }).join("");
  return `<div class="drawer-backdrop" data-action="close-drawer"><aside class="search-drawer" role="dialog" aria-modal="true" aria-label="召回测试"><div class="drawer-header"><div><p class="eyebrow">RETRIEVAL TEST</p><h2>召回测试</h2></div><button class="close-button" data-action="close-drawer" aria-label="关闭">×</button></div><form id="search-form" class="drawer-form"><label>知识库<select name="libraryId">${options}</select></label><label>问题<input name="query" required value="${escapeHtml(state.searchQuery)}" placeholder="输入问题，观察实际命中片段"></label><div class="control-grid"><label>topK<div class="range-line"><input name="topK" type="range" min="1" max="50" value="${state.searchTopK}"><output>${state.searchTopK}</output></div></label><label>相似度阈值<input name="similarityThreshold" type="number" min="-1" max="1" step="0.01" value="${state.searchThreshold}"></label></div><button class="primary-button" type="submit">开始检索</button></form><div class="drawer-results"><div class="result-count"><span>结果</span><span class="mono">${state.searchResults.length} hits</span></div>${results || `<div class="empty-row">输入问题开始测试检索。</div>`}</div></aside></div>`;
}

function renderCreateModal() {
  if (state.modal !== "create") return "";
  return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="create-title"><div class="modal-header"><div><p class="eyebrow">NEW LIBRARY</p><h2 id="create-title">新建知识库</h2></div><button class="close-button" data-action="close-modal" aria-label="关闭">×</button></div><form id="create-library" class="modal-form"><label>库名<input name="displayName" required placeholder="例如 工作制度库 或 work-rules"><small>支持中文、空格等显示名；内部会自动生成安全 ID。</small></label><div class="modal-actions"><button class="outline-button" type="button" data-action="close-modal">取消</button><button class="primary-button" type="submit">创建知识库</button></div></form></section></div>`;
}

function graphHealthHtml(stats, library) {
  const graphOn = Boolean(library?.config?.graphEnabled);
  const processing = Number(stats.processingChunks || 0);
  const uncovered = Number(stats.uncoveredChunks || 0);
  let statusLine;
  if (!graphOn) statusLine = `<p class="hint">图谱未开启，开启后可进行实体关系构建</p>`;
  else if (processing > 0) statusLine = `<p class="hint graph-busy">图谱构建中，正在抽取…（当前批次剩余 ${processing} 段）</p>`;
  else if (uncovered > 0) statusLine = `<p class="hint">${uncovered} 个片段未抽取图谱，点击下方“补建图谱”开始构建</p>`;
  else statusLine = `<p class="hint">图谱已完整构建</p>`;
  return `<section class="health-summary"><div class="health-heading"><p class="eyebrow">GRAPH HEALTH</p><div class="health-actions"><button class="outline-button" data-action="rebuild-library">重建索引</button>${graphOn ? `<button class="outline-button" data-action="rebuild-graph" data-library-id="${escapeHtml(library?.id || "")}">补建图谱</button>` : ""}</div></div><div class="health-grid"><span><strong>${Number(stats.entities || 0)}</strong><small>实体</small></span><span><strong>${Number(stats.relations || 0)}</strong><small>关系</small></span><span><strong>${Number(stats.averageDegree || 0).toFixed(2)}</strong><small>平均度</small></span><span><strong>${(Number(stats.isolatedRatio || 0) * 100).toFixed(1)}%</strong><small>孤立率</small></span></div>${statusLine}</section>`;
}

function mmrHintHtml(library) {
  const signal = library?.mmrSignal;
  if (!signal) return "";
  const ratio = Math.round(Number(signal.dominantRatio || 0) * 100);
  if (signal.recommend) return `多样性重排建议开启：该库 ${ratio}% 的文档块数较多，多主题问题时容易被单篇文档霸榜（已实测验证）。`;
  return `多样性重排无需开启：该库文档结构均衡（${ratio}%），开启反而可能稀释单一文档的答案。`;
}

function renderSettingsModal() {
  if (state.modal !== "settings") return "";
  const library = selectedLibrary();
  const config = library?.config || {};
  const stats = library?.graphStats || {};
  return `<div class="modal-backdrop" data-action="close-modal"><section class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div class="modal-header"><div><p class="eyebrow">LIBRARY SETTINGS</p><h2 id="settings-title">${escapeHtml(libraryLabel(library))} 设置</h2></div><button class="close-button" data-action="close-modal" aria-label="关闭">×</button></div><form id="settings-form" class="modal-form" data-library-id="${escapeHtml(library?.id || "")}"><div class="settings-grid"><label>topK<input name="topK" type="number" min="1" max="1000" value="${config.topK ?? 15}"></label><label>相似度阈值<input name="similarityThreshold" type="number" min="-1" max="1" step="0.01" value="${config.similarityThreshold ?? 0.5}"></label><label>分段字符<input name="chunkTargetLength" type="number" min="50" max="10000" value="${config.chunkTargetLength ?? 400}"></label><label>重叠字符<input name="chunkOverlap" type="number" min="0" max="9999" value="${config.chunkOverlap ?? 50}"></label></div><div class="switch-list"><label class="check-line"><input name="graphEnabled" type="checkbox" ${config.graphEnabled ? "checked" : ""}> 开启图谱检索</label><label class="check-line"><input name="bm25Enabled" type="checkbox" ${config.bm25Enabled ? "checked" : ""}> 开启 BM25 融合</label><label class="check-line"><input name="mmrEnabled" type="checkbox" ${config.mmrEnabled ? "checked" : ""}> 开启多样性重排</label><p class="hint">${mmrHintHtml(library)}</p></div><div class="modal-actions"><button class="outline-button" type="button" data-action="close-modal">取消</button><button class="primary-button" type="submit">保存设置</button></div></form>${graphHealthHtml(stats, library)}<div class="danger-zone"><div><strong>删除知识库</strong><p>库文件、文档索引和图谱数据都会被删除。</p></div><button class="danger-button" data-action="delete-library" data-library-id="${escapeHtml(library?.id || "")}">删除</button></div></section></div>`;
}

function renderGlobalSettingsModal() {
  if (state.modal !== "global-settings") return "";
  const embedding = state.globalConfig?.embedding || { apiKey: "", baseUrl: "", model: "" };
  const llm = state.globalConfig?.llm || { apiKey: "", baseUrl: "", model: "", sameAsEmbedding: false };
  const embeddingKeyPlaceholder = embedding.apiKey ? `已配置 ${embedding.apiKey}，输入新值则替换` : "输入 embedding API key";
  const llmKeyPlaceholder = llm.apiKey ? `已配置 ${llm.apiKey}，输入新值则替换` : "输入 LLM API key";
  return `<div class="modal-backdrop" data-action="close-modal"><section class="modal settings-modal" id="settings-config" role="dialog" aria-modal="true" aria-labelledby="global-settings-title"><div class="modal-header"><div><p class="eyebrow">PLUGIN SETTINGS</p><h2 id="global-settings-title">全局设置</h2></div><button class="close-button" data-action="close-modal" aria-label="关闭">×</button></div><form id="global-settings-form" class="modal-form"><p class="hint">推荐：embedding 用硅基流动的 <code>BAAI/bge-m3</code>，LLM 用 DeepSeek 官方的 <code>deepseek-v4-flash</code>。API key 只保存在本机插件数据目录。</p><p class="settings-section-title">Embedding</p><label>API Key<input name="embeddingApiKey" type="password" autocomplete="new-password" placeholder="${escapeHtml(embeddingKeyPlaceholder)}"></label><div class="settings-grid"><label>Base URL<input name="embeddingBaseUrl" value="${escapeHtml(embedding.baseUrl)}" placeholder="https://api.siliconflow.cn/v1" required></label><label>Model<input name="embeddingModel" value="${escapeHtml(embedding.model)}" placeholder="BAAI/bge-m3" required></label></div><p class="settings-section-title">LLM 抽取（图谱）</p><label class="check-line"><input name="llmSameAsEmbedding" type="checkbox" ${llm.sameAsEmbedding ? "checked" : ""}> 与 embedding 使用相同 API Key</label><label>API Key<input name="llmApiKey" type="password" autocomplete="new-password" placeholder="${escapeHtml(llmKeyPlaceholder)}"></label><div class="settings-grid"><label>Base URL<input name="llmBaseUrl" value="${escapeHtml(llm.baseUrl)}" placeholder="https://api.deepseek.com/v1" required></label><label>Model<input name="llmModel" value="${escapeHtml(llm.model)}" placeholder="deepseek-v4-flash" required></label></div><div class="modal-actions"><button class="outline-button" type="button" data-action="close-modal">取消</button><button class="primary-button" type="submit">保存全局设置</button></div></form></section></div>`;
}

function shellHtml() {
  const library = selectedLibrary();
  const main = library ? `${renderHeader()}${renderTabs()}${state.message ? `<div class="notice">${escapeHtml(state.message)}</div>` : ""}${state.view === "graph" ? graphView() : documentsView()}` : `<section class="blank-state"><p class="eyebrow">START HERE</p><h1>建立你的第一个知识库</h1><p>从左侧新建知识库，然后添加文件或目录。</p><button class="primary-button" data-action="open-create">新建知识库</button></section>`;
  return `<div class="shell">${sidebarHtml()}<main class="workspace">${main}</main>${renderSearchDrawer()}${renderCreateModal()}${renderSettingsModal()}${renderGlobalSettingsModal()}${renderConfirmModal()}${renderPickerMenu()}${renderViewDocModal()}${renderPreviewModal()}${renderUrlModal()}</div>`;
}

function renderViewDocModal() {
  if (!state.viewDoc) return "";
  const d = state.viewDoc;
  const body = d.loading
    ? `<p class="hint">正在读取内容…</p>`
    : d.error
      ? `<p class="hint">${escapeHtml(d.error)}</p>`
      : `<pre class="doc-content">${escapeHtml(d.content || "（无内容）")}</pre>`;
  return `<div class="modal-backdrop" data-action="close-view-doc"><section class="modal doc-modal" role="dialog" aria-modal="true"><div class="modal-header"><div><p class="eyebrow">DOCUMENT CONTENT</p><h2>${escapeHtml(d.name)}</h2></div><button class="close-button" data-action="close-view-doc" aria-label="关闭">×</button></div>${body}<div class="modal-actions"><button class="outline-button" data-action="close-view-doc">关闭</button></div></section></div>`;
}

function renderPreviewModal() {
  if (!state.previewFile) return "";
  const p = state.previewFile;
  const body = p.loading
    ? `<p class="hint">正在转换…</p>`
    : p.error
      ? `<p class="hint">${escapeHtml(p.error)}</p>`
      : `${p.warnings.length ? `<p class="hint">${escapeHtml(p.warnings.join("；"))}</p>` : ""}<pre class="doc-content">${escapeHtml(p.markdown || "（转换结果为空）")}</pre>${p.truncated ? `<p class="hint">内容过长，仅预览前 20000 字符</p>` : ""}`;
  return `<div class="modal-backdrop" data-action="preview-cancel"><section class="modal doc-modal" role="dialog" aria-modal="true"><div class="modal-header"><div><p class="eyebrow">CONVERT PREVIEW</p><h2>${escapeHtml(p.name)}</h2></div><button class="close-button" data-action="preview-cancel" aria-label="关闭">×</button></div>${body}<div class="modal-actions"><button class="outline-button" data-action="preview-cancel">取消</button>${!p.loading && !p.error && p.markdown ? `<button class="primary-button" data-action="preview-confirm">确认入库</button>` : ""}</div></section></div>`;
}

function renderUrlModal() {
  if (!state.urlModal) return "";
  return `<div class="modal-backdrop" data-action="close-url-modal"><section class="modal confirm-modal" role="dialog" aria-modal="true"><p class="confirm-text">添加网页到知识库</p><form id="add-url-form" class="modal-form"><label>网页链接<input name="url" type="url" placeholder="https://…" required></label><p class="hint">抓取正文转为 Markdown 入库，来源链接会记录在文档头部。适合公众号、博客、新闻等静态网页。</p><div class="modal-actions"><button class="outline-button" type="button" data-action="close-url-modal">取消</button><button class="primary-button" type="submit" ${state.urlBusy ? "disabled" : ""}>${state.urlBusy ? "抓取中…" : "抓取并入库"}</button></div></form></section></div>`;
}

function renderConfirmModal() {
  if (!state.confirm) return "";
  return `<div class="modal-backdrop"><section class="modal confirm-modal" role="alertdialog" aria-modal="true"><p class="confirm-text">${escapeHtml(state.confirm.message)}</p><div class="modal-actions"><button class="outline-button" data-action="confirm-cancel">取消</button><button class="danger-button" data-action="confirm-ok">确认删除</button></div></section></div>`;
}

function renderPickerMenu() {
  if (!state.pickerMenu) return "";
  return `<div class="modal-backdrop" data-action="picker-cancel"><section class="modal source-modal" role="dialog" aria-modal="true"><div class="modal-header"><div><p class="eyebrow">ADD SOURCE</p><h2>选择数据源类型</h2></div><button class="close-button" data-action="picker-cancel" aria-label="关闭">×</button></div><div class="source-options"><button class="source-option" data-action="picker-file"><strong>选择文件</strong><small>可多选。支持 md · txt · docx · doc · xlsx · xls · pptx · ppt · epub · rtf · odt</small></button><button class="source-option" data-action="picker-directory"><strong>选择文件夹</strong><small>整个文件夹批量入库，格式同上</small></button><button class="source-option" data-action="picker-url"><strong>添加网页</strong><small>粘贴链接，抓取正文入库。支持公众号、博客、新闻、文档站等</small></button></div></section></div>`;
}

let fileInput = null;
let dirInput = null;

function ensurePickers() {
  if (fileInput) return;
  fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.accept = ".md,.markdown,.txt,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.epub,.rtf,.odt";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);
  fileInput.addEventListener("change", () => { const files = [...fileInput.files]; fileInput.value = ""; if (files.length) handlePickedFiles(files); });
  dirInput = document.createElement("input");
  dirInput.type = "file";
  dirInput.setAttribute("webkitdirectory", "");
  dirInput.style.display = "none";
  document.body.appendChild(dirInput);
  dirInput.addEventListener("change", () => { const files = [...dirInput.files].filter((f) => /\.(md|markdown|txt|docx|doc|xlsx|xls|pptx|ppt|epub|rtf|odt)$/i.test(f.name)); dirInput.value = ""; if (files.length) handlePickedFiles(files); });
}

const CONVERTIBLE_RE = /\.(docx|doc|xlsx|xls|pptx|ppt|epub|rtf|odt)$/i;

async function handlePickedFiles(files) {
  const paths = files.map((f) => f.path || "").filter((p) => p && (p.includes("\\") || p.includes("/")));
  // 单个可转换格式文件（本地路径可用）→ 先弹转换预览，确认后再入库；批量与 md/txt 直接入
  if (paths.length === files.length && files.length === 1 && CONVERTIBLE_RE.test(files[0].name)) {
    state.previewFile = { path: paths[0], name: files[0].name, loading: true, markdown: "", warnings: [], truncated: false, error: "" };
    render();
    try {
      const res = await request("api/preview-convert", { method: "POST", body: JSON.stringify({ path: paths[0] }) });
      state.previewFile = { ...state.previewFile, loading: false, markdown: res.markdown || "", warnings: res.warnings || [], truncated: Boolean(res.truncated), error: "" };
    } catch (error) {
      state.previewFile = { ...state.previewFile, loading: false, error: friendlyError(error) };
    }
    render();
    return;
  }
  if (paths.length === files.length) {
    await ingest(null, paths);
    return;
  }
  const fd = new FormData();
  for (const f of files) fd.append("files", f, f.webkitRelativePath || f.name);
  state.ingestBusy = true;
  setMessage(`已选择 ${files.length} 个文件，正在上传入库`);
  render();
  try {
    await request(`api/libraries/${encodeURIComponent(state.libraryId)}/ingest-upload`, { method: "POST", body: fd });
    setMessage("已提交入库，表格会持续刷新处理状态");
    await loadDocuments(state.documentPage);
  } catch (error) { setMessage(friendlyError(error)); }
  finally { state.ingestBusy = false; render(); }
}

function render() {
  if (!app) return;
  app.innerHTML = shellHtml();
  bindEvents();
}

async function refresh() {
  try {
    await loadLibraries();
    if (state.libraryId) await loadDocuments(state.documentPage).catch(() => { state.documents = null; });
    render();
  } catch (error) {
    setMessage(error.message);
    render();
  }
}

async function openLibrary(libraryId) {
  state.libraryId = libraryId;
  state.view = "documents";
  state.documentPage = 1;
  state.documents = null;
  state.selectedPaths.clear();
  state.menuLibraryId = "";
  state.drawer = "";
  state.modal = "";
  state.fullGraph = null;
  state.graph = null;
  state.graphCandidates = [];
  state.graphMode = "full";
  setMessage("");
  try { await loadDocuments(1); } catch (error) { setMessage(error.message); }
  render();
}

function openCreate() {
  state.menuLibraryId = "";
  state.modal = "create";
  render();
}

function openSettings(libraryId = state.libraryId) {
  state.libraryId = libraryId;
  state.menuLibraryId = "";
  state.modal = "settings";
  render();
}

async function openGlobalSettings() {
  state.menuLibraryId = "";
  state.modal = "global-settings";
  state.globalConfig = null;
  render();
  try {
    const data = await request("api/config");
    state.globalConfig = data.config;
  } catch (error) {
    setMessage(error.message);
  }
  render();
}

async function createLibrary(event) {
  event.preventDefault();
  const displayName = String(new FormData(event.currentTarget).get("displayName") || "").trim();
  if (!displayName) return;
  try {
    const data = await request("api/libraries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName }) });
    state.libraryId = data.library?.id || displayName;
    state.view = "documents";
    state.modal = "";
    state.documents = null;
    setMessage(`知识库 ${displayName} 已创建`);
    await loadLibraries();
    await loadDocuments(1);
    render();
  } catch (error) { setMessage(error.message); render(); }
}

function askConfirm(message, action) {
  state.confirm = { message, action };
  render();
}

async function deleteLibrary(libraryId) {
  const label = libraryLabel(state.libraries.find((item) => item.id === libraryId)) || libraryId;
  askConfirm(`确认删除知识库「${label}」？库文件、文档索引和图谱数据都会被删除。`, async () => {
    try {
      await request(`api/libraries/${encodeURIComponent(libraryId)}`, { method: "DELETE" });
      state.modal = "";
      state.menuLibraryId = "";
      state.libraryId = "";
      state.documents = null;
      setMessage(`知识库 ${label} 已删除`);
      await loadLibraries();
      if (state.libraries[0]) await openLibrary(state.libraries[0].id);
      else render();
    } catch (error) { setMessage(error.message); render(); }
  });
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  for (const key of ["topK", "chunkTargetLength", "chunkOverlap"]) body[key] = Number(body[key]);
  body.similarityThreshold = Number(body.similarityThreshold);
  body.graphEnabled = form.elements.graphEnabled.checked;
  body.bm25Enabled = form.elements.bm25Enabled.checked;
  body.mmrEnabled = form.elements.mmrEnabled.checked;
  try {
    const data = await request(`api/libraries/${encodeURIComponent(form.dataset.libraryId)}/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await loadLibraries();
    state.modal = "";
    setMessage(data.requiresRebuild ? "设置已保存；分段参数已变化，请重建索引" : "设置已保存");
    render();
  } catch (error) { setMessage(error.message); render(); }
}

async function saveGlobalSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = {
    embedding: {
      baseUrl: String(form.elements.embeddingBaseUrl.value || "").trim(),
      model: String(form.elements.embeddingModel.value || "").trim(),
    },
    llm: {
      sameAsEmbedding: form.elements.llmSameAsEmbedding.checked,
      baseUrl: String(form.elements.llmBaseUrl.value || "").trim(),
      model: String(form.elements.llmModel.value || "").trim(),
    },
  };
  const embeddingKey = String(form.elements.embeddingApiKey?.value || "").trim();
  const llmKey = String(form.elements.llmApiKey?.value || "").trim();
  if (embeddingKey) body.embedding.apiKey = embeddingKey;
  if (llmKey) body.llm.apiKey = llmKey;
  try {
    const data = await request("api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    state.globalConfig = data.config;
    state.modal = "";
    setMessage("全局 embedding / LLM 设置已保存");
    render();
  } catch (error) { setMessage(error.message); render(); }
}

function friendlyError(error) {
  const message = String(error?.message || error || "请求失败");
  return /embedding|api key|config/i.test(message) ? "请先在设置里配置 embedding" : message;
}

async function rebuildLibrary() {
  const library = selectedLibrary();
  if (!library) return;
  try {
    await request(`api/libraries/${encodeURIComponent(library.id)}/rebuild`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ graph: Boolean(library.config?.graphEnabled) }) });
    await loadLibraries();
    state.modal = "";
    setMessage("索引重建完成");
    render();
  } catch (error) { setMessage(error.message); render(); }
}

async function ingest(event, pathsOverride) {
  event?.preventDefault();
  const paths = pathsOverride || String(new FormData(event.currentTarget).get("paths") || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (!paths.length) { setMessage("请输入至少一个文件或目录路径"); render(); return; }
  state.ingestBusy = true;
  setMessage(`已提交 ${paths.length} 个路径，正在入库`);
  render();
  try {
    await request(`api/libraries/${encodeURIComponent(state.libraryId)}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths }) });
    state.selectedPaths.clear();
    await loadDocuments(state.documentPage);
    setMessage("已提交入库，表格会持续刷新处理状态");
  } catch (error) { setMessage(friendlyError(error)); }
  finally { state.ingestBusy = false; render(); }
}

async function reingest(path) {
  try {
    await request(`api/libraries/${encodeURIComponent(state.libraryId)}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: [path], force: true }) });
    setMessage("已重新加入入库队列");
    await loadDocuments(state.documentPage);
    render();
  } catch (error) { setMessage(error.message); render(); }
}

async function deleteDocument(path) {
  askConfirm(`确认删除文档「${path}」？`, async () => {
    try {
      await request(`api/libraries/${encodeURIComponent(state.libraryId)}/documents`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
      state.selectedPaths.delete(path);
      setMessage("文档已删除");
      await loadDocuments(state.documentPage);
      render();
    } catch (error) { setMessage(error.message); render(); }
  });
}

async function bulkDelete() {
  const paths = [...state.selectedPaths];
  if (!paths.length) return;
  askConfirm(`确认删除已选择的 ${paths.length} 个文档？`, async () => {
    try {
      await request(`api/libraries/${encodeURIComponent(state.libraryId)}/documents`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths }) });
      state.selectedPaths.clear();
      setMessage(`已删除 ${paths.length} 个文档`);
      await loadDocuments(state.documentPage);
      render();
    } catch (error) { setMessage(error.message); render(); }
  });
}

async function search(event) {
  event.preventDefault();
  const form = event.currentTarget;
  state.libraryId = form.elements.libraryId.value;
  state.searchQuery = form.elements.query.value.trim();
  state.searchTopK = Number(form.elements.topK.value);
  state.searchThreshold = Number(form.elements.similarityThreshold.value);
  if (!state.searchQuery) return;
  try {
    const data = await request("api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ libraryId: state.libraryId, query: state.searchQuery, topK: state.searchTopK, similarityThreshold: state.searchThreshold }) });
    state.searchResults = data.results || [];
    state.expandedResults.clear();
    setMessage("");
    render();
  } catch (error) { setMessage(error.message); render(); }
}

async function searchGraph(event) {
  event.preventDefault();
  const query = String(new FormData(event.currentTarget).get("entity") || "").trim();
  if (!query) return;
  try {
    const data = await request(`api/libraries/${encodeURIComponent(state.libraryId)}/graph-data?entity=${encodeURIComponent(query)}`);
    state.graphCandidates = data.candidates || [];
    state.graph = null;
    setMessage(state.graphCandidates.length ? "请选择一个实体查看一跳邻居" : "没有找到实体");
    render();
  } catch (error) { setMessage(error.message); render(); }
}

async function loadGraphEntity(entityId) {
  try {
    state.graph = await request(graphEntityRequest(state.libraryId, entityId));
    state.graphCandidates = [];
    state.graphMode = "local";
    setMessage("");
    render();
  } catch (error) { setMessage(error.message); render(); }
}

async function loadFullGraph() {
  if (state.fullGraph) return;
  try {
    const data = await request(`api/libraries/${encodeURIComponent(state.libraryId)}/graph-data?mode=full`);
    state.fullGraph = data;
    render();
  } catch (error) { setMessage(error.message); render(); }
}

async function rebuildGraph() {
  try {
    const data = await request(`api/libraries/${encodeURIComponent(state.libraryId)}/graph/rebuild`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ retryFailed: true }) });
    if (data.status === "running") { setMessage("图谱构建已在进行中，无需重复启动"); render(); return; }
    setMessage("图谱构建已启动，正在后台抽取…");
    state.fullGraph = null;
    await loadLibraries();
    render();
    pollGraphProgress();
  } catch (error) { setMessage(error.message); render(); }
}

async function pollGraphProgress() {
  if (state.graphPoll) return;
  state.graphPoll = setInterval(async () => {
    try {
      await loadLibraries();
      const stats = selectedLibrary()?.graphStats || {};
      if (state.modal === "settings" || state.view === "graph") render();
      if (!(Number(stats.processingChunks || 0) > 0)) {
        clearInterval(state.graphPoll);
        state.graphPoll = null;
        if (state.modal === "settings" || state.view === "graph") {
          const uncovered = Number(stats.uncoveredChunks || 0);
          setMessage(uncovered > 0 ? `图谱构建结束，仍有 ${uncovered} 段未成功（可再次补建）` : "图谱构建完成");
          render();
        }
      }
    } catch (error) { clearInterval(state.graphPoll); state.graphPoll = null; }
  }, 4000);
}

function bindEvents() {
  if (state.statusPoll) clearInterval(state.statusPoll);
  state.statusPoll = shouldPollDocuments() && state.libraryId ? setInterval(async () => {
    try { await loadDocuments(state.documentPage); render(); } catch (error) { setMessage(error.message); }
  }, 3000) : null;
  app.querySelectorAll('[data-action="open-library"]').forEach((button) => button.addEventListener("click", () => openLibrary(button.dataset.libraryId)));
  app.querySelectorAll('[data-action="toggle-menu"]').forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); state.menuLibraryId = state.menuLibraryId === button.dataset.libraryId ? "" : button.dataset.libraryId; render(); }));
  app.querySelectorAll('[data-action="open-create"]').forEach((button) => button.addEventListener("click", openCreate));
  app.querySelectorAll('[data-action="open-settings"]').forEach((button) => button.addEventListener("click", () => openSettings(button.dataset.libraryId)));
  app.querySelectorAll('[data-action="delete-library"]').forEach((button) => button.addEventListener("click", () => deleteLibrary(button.dataset.libraryId)));
  app.querySelectorAll('[data-action="close-modal"]').forEach((button) => button.addEventListener("click", (event) => { if (event.target === event.currentTarget || event.currentTarget.classList.contains("close-button")) { state.modal = ""; render(); } }));
  app.querySelectorAll('[data-action="close-drawer"]').forEach((button) => button.addEventListener("click", (event) => { if (event.target === event.currentTarget || event.currentTarget.classList.contains("close-button")) { state.drawer = ""; render(); } }));
  app.querySelectorAll('[data-action="view-tab"]').forEach((button) => button.addEventListener("click", async () => { state.view = button.dataset.view; setMessage(""); render(); if (state.view === "graph" && !state.fullGraph) await loadFullGraph(); }));
  app.querySelector('[data-action="open-search"]')?.addEventListener("click", () => { state.drawer = "search"; state.modal = ""; render(); });
  app.querySelector('[data-action="open-global-settings"]')?.addEventListener("click", openGlobalSettings);
  app.querySelector('[data-action="add-source"]')?.addEventListener("click", () => {
    state.pickerMenu = true;
    render();
  });
  app.querySelectorAll('[data-action="picker-cancel"]').forEach((el) => el.addEventListener("click", (event) => { if (event.target === event.currentTarget || el.classList.contains("close-button")) { state.pickerMenu = false; render(); } }));
  app.querySelector('[data-action="picker-file"]')?.addEventListener("click", () => { state.pickerMenu = false; ensurePickers(); fileInput.click(); });
  app.querySelector('[data-action="picker-directory"]')?.addEventListener("click", () => { state.pickerMenu = false; ensurePickers(); dirInput.click(); });
  app.querySelector('[data-action="picker-url"]')?.addEventListener("click", () => { state.pickerMenu = false; state.urlModal = true; render(); });
  app.querySelector('[data-action="confirm-ok"]')?.addEventListener("click", async () => { const action = state.confirm?.action; state.confirm = null; if (action) await action(); else render(); });
  app.querySelector('[data-action="confirm-cancel"]')?.addEventListener("click", () => { state.confirm = null; render(); });
  app.querySelector('#create-library')?.addEventListener("submit", createLibrary);
  app.querySelector('#settings-form')?.addEventListener("submit", saveSettings);
  app.querySelector('#global-settings-form')?.addEventListener("submit", saveGlobalSettings);
  app.querySelector('[data-action="rebuild-library"]')?.addEventListener("click", rebuildLibrary);
  app.querySelector('#ingest-form')?.addEventListener("submit", ingest);
  app.querySelector('[data-action="refresh-documents"]')?.addEventListener("click", refresh);
  app.querySelector('#select-all')?.addEventListener("change", (event) => { state.selectedPaths = selectionAfterToggleAll(state.selectedPaths, documentsOnPage().map((item) => item.path), event.currentTarget.checked); render(); });
  app.querySelectorAll('[data-action="select-document"]').forEach((checkbox) => checkbox.addEventListener("change", (event) => { state.selectedPaths = toggleSelectedPath(state.selectedPaths, checkbox.dataset.path, event.currentTarget.checked); render(); }));
  app.querySelector('[data-action="bulk-delete"]')?.addEventListener("click", bulkDelete);
  app.querySelector('[data-action="clear-selection"]')?.addEventListener("click", () => { state.selectedPaths.clear(); render(); });
  app.querySelectorAll('[data-action="reingest-document"]').forEach((button) => button.addEventListener("click", () => reingest(button.dataset.path)));
  app.querySelectorAll('[data-action="view-document"]').forEach((button) => button.addEventListener("click", async () => {
    const path = button.dataset.path;
    state.viewDoc = { name: path.split(/[\\/]/).pop(), loading: true, content: "", error: "" };
    render();
    try {
      const res = await request(`api/libraries/${encodeURIComponent(state.libraryId)}/document-content?path=${encodeURIComponent(path)}`);
      state.viewDoc = { name: res.name, loading: false, content: res.content, error: "" };
    } catch (error) {
      state.viewDoc = { ...state.viewDoc, loading: false, error: friendlyError(error) };
    }
    render();
  }));
  app.querySelectorAll('[data-action="close-view-doc"]').forEach((el) => el.addEventListener("click", (event) => { if (event.target === event.currentTarget || el.classList.contains("close-button")) { state.viewDoc = null; render(); } }));
  app.querySelectorAll('[data-action="preview-cancel"]').forEach((el) => el.addEventListener("click", (event) => { if (event.target === event.currentTarget || el.classList.contains("close-button")) { state.previewFile = null; render(); } }));
  app.querySelector('[data-action="preview-confirm"]')?.addEventListener("click", async () => {
    const path = state.previewFile?.path;
    state.previewFile = null;
    if (path) await ingest(null, [path]);
  });
  app.querySelectorAll('[data-action="close-url-modal"]').forEach((el) => el.addEventListener("click", (event) => { if (event.target === event.currentTarget || el.tagName === "BUTTON") { state.urlModal = false; state.urlBusy = false; render(); } }));
  app.querySelector('#add-url-form')?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = new FormData(event.currentTarget).get("url");
    if (!url) return;
    state.urlBusy = true;
    render();
    try {
      const res = await request(`api/libraries/${encodeURIComponent(state.libraryId)}/add-url`, { method: "POST", body: JSON.stringify({ url }) });
      state.urlModal = false;
      setMessage(`已抓取《${res.title}》，入库中`);
      await loadDocuments(state.documentPage);
    } catch (error) { setMessage(friendlyError(error)); }
    finally { state.urlBusy = false; render(); }
  });
  app.querySelectorAll('[data-action="delete-document"]').forEach((button) => button.addEventListener("click", () => deleteDocument(button.dataset.path)));
  app.querySelectorAll('[data-action="documents-page"]').forEach((button) => button.addEventListener("click", async () => { await loadDocuments(Number(button.dataset.page)); render(); }));
  app.querySelector('#search-form')?.addEventListener("submit", search);
  app.querySelector('#search-form input[name="topK"]')?.addEventListener("input", (event) => { event.currentTarget.nextElementSibling.value = event.currentTarget.value; });
  app.querySelectorAll('[data-action="toggle-result"]').forEach((result) => result.addEventListener("click", () => { state.expandedResults = toggleExpanded(state.expandedResults, result.dataset.resultId); render(); }));
  app.querySelector('#graph-search-form')?.addEventListener("submit", searchGraph);
  app.querySelectorAll('[data-action="load-graph-entity"]').forEach((button) => button.addEventListener("click", () => loadGraphEntity(button.dataset.entityId)));
  app.querySelectorAll('[data-action="toggle-chunk"]').forEach((card) => card.addEventListener("click", () => { state.expandedChunks = toggleExpanded(state.expandedChunks, card.dataset.chunkId); render(); }));
  app.querySelector('[data-action="graph-back-full"]')?.addEventListener("click", () => { state.graphMode = "full"; state.graph = null; state.graphCandidates = []; render(); });
  app.querySelector('[data-action="rebuild-graph"]')?.addEventListener("click", rebuildGraph);
  app.querySelectorAll(".graph-node").forEach((node) => node.addEventListener("click", () => loadGraphEntity(node.dataset.entityId)));
  initGraphEngine();
}

loadLibraries().then(async () => {
  if (state.libraryId) await loadDocuments(1).catch(() => { state.documents = null; });
  render();
}).catch((error) => { setMessage(error.message); render(); });
