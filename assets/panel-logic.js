const STATUS_LABELS = Object.freeze({ pending: "等待", processing: "处理中", done: "就绪", failed: "失败" });
const FILE_TYPE_LABELS = Object.freeze({ md: "Markdown", markdown: "Markdown", txt: "纯文本" });

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || "未知";
}

export function fileTypeLabel(path) {
  const extension = String(path ?? "").split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  return FILE_TYPE_LABELS[extension] || "文件";
}

export function isResourcePickerAvailable(host = globalThis.hana) {
  return typeof host?.resources?.pick === "function";
}

export function pickedResourcePaths(picked) {
  const items = Array.isArray(picked) ? picked : Array.isArray(picked?.resources) ? picked.resources : [picked];
  return items.map((item) => String(item?.path || item?.resource?.path || (typeof item === "string" ? item : ""))).filter(Boolean);
}

export function pickedResourcePath(picked) {
  return pickedResourcePaths(picked)[0] || "";
}

export function resourcePickOptions(mode) {
  return { mode: mode === "directory" ? "directory" : "file", multiple: mode !== "directory" };
}

export function toggleSelectedPath(selected, path, checked) {
  const next = new Set(selected);
  if (checked) next.add(String(path));
  else next.delete(String(path));
  return next;
}

export function selectionAfterToggleAll(selected, paths, checked) {
  const next = new Set(selected);
  for (const path of paths) {
    if (checked) next.add(String(path));
    else next.delete(String(path));
  }
  return next;
}

export function tokenizedUrl(apiBase, route, token) {
  const cleanBase = String(apiBase).replace(/\/$/, "");
  const cleanRoute = String(route).replace(/^\//, "");
  const query = token ? `${cleanRoute.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : "";
  return `${cleanBase}/${cleanRoute}${query}`;
}

export function clipLocalGraph(data, { maxNodes = 81, maxEdges = 160 } = {}) {
  const centerId = data?.center?.id;
  const allNodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const allEdges = Array.isArray(data?.edges) ? data.edges : [];
  const nodeMap = new Map(allNodes.map((node) => [node.id, node]));
  const selected = [];
  if (centerId != null && nodeMap.has(centerId)) selected.push(nodeMap.get(centerId));
  for (const edge of allEdges) {
    for (const id of [edge.source, edge.target]) {
      if (selected.length >= maxNodes || selected.some((node) => node.id === id) || !nodeMap.has(id)) continue;
      selected.push(nodeMap.get(id));
    }
    if (selected.length >= maxNodes) break;
  }
  if (!selected.length) selected.push(...allNodes.slice(0, maxNodes));
  const allowed = new Set(selected.map((node) => node.id));
  return {
    ...data,
    nodes: selected,
    edges: allEdges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)).slice(0, maxEdges),
  };
}

export function graphEntityRequest(libraryId, entityId) {
  return `api/libraries/${encodeURIComponent(String(libraryId))}/graph-data?entityId=${encodeURIComponent(String(entityId))}`;
}

export function toggleExpanded(expanded, id) {
  const next = new Set(expanded);
  if (next.has(String(id))) next.delete(String(id));
  else next.add(String(id));
  return next;
}

globalThis.hanaKbPanelLogic = {
  clipLocalGraph,
  fileTypeLabel,
  graphEntityRequest,
  isResourcePickerAvailable,
  pickedResourcePath,
  pickedResourcePaths,
  resourcePickOptions,
  selectionAfterToggleAll,
  statusLabel,
  toggleExpanded,
  toggleSelectedPath,
  tokenizedUrl,
};
