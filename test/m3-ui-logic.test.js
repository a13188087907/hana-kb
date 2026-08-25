import test from "node:test";
import assert from "node:assert/strict";
import {
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
} from "../assets/panel-logic.js";

test("renders status with stable double-coded labels", () => {
  assert.equal(statusLabel("done"), "就绪");
  assert.equal(statusLabel("processing"), "处理中");
  assert.equal(statusLabel("failed"), "失败");
  assert.equal(statusLabel("unknown"), "unknown");
});

test("maps document extensions to compact file type labels", () => {
  assert.equal(fileTypeLabel("notes.md"), "Markdown");
  assert.equal(fileTypeLabel("D:\\docs\\plain.TXT"), "纯文本");
  assert.equal(fileTypeLabel("README"), "文件");
});

test("builds explicit file and directory picker options", () => {
  assert.deepEqual(resourcePickOptions("file"), { mode: "file", multiple: true });
  assert.deepEqual(resourcePickOptions("directory"), { mode: "directory", multiple: false });
});

test("detects resource picker capability and extracts a path from host results", () => {
  assert.equal(isResourcePickerAvailable({ resources: { pick: async () => [] } }), true);
  assert.equal(isResourcePickerAvailable({ resources: {} }), false);
  assert.equal(pickedResourcePath({ resources: [{ path: "D:/docs" }] }), "D:/docs");
  assert.equal(pickedResourcePath([{ resource: { path: "D:/notes.md" } }]), "D:/notes.md");
  assert.deepEqual(pickedResourcePaths({ resources: [{ path: "D:/a.md" }, { path: "D:/b.md" }] }), ["D:/a.md", "D:/b.md"]);
  assert.equal(pickedResourcePath("D:/single.md"), "D:/single.md");
  assert.equal(pickedResourcePath({}), "");
});

test("updates document selection without mutating the original set", () => {
  const original = new Set(["a"]);
  assert.deepEqual([...toggleSelectedPath(original, "b", true)], ["a", "b"]);
  assert.deepEqual([...toggleSelectedPath(original, "a", false)], []);
  assert.deepEqual([...original], ["a"]);
  assert.deepEqual([...selectionAfterToggleAll(original, ["a", "b"], true)], ["a", "b"]);
  assert.deepEqual([...selectionAfterToggleAll(new Set(["a", "b"]), ["a", "b"], false)], []);
});

test("adds the token to API asset URLs without losing an existing query", () => {
  assert.equal(tokenizedUrl("/api/plugins/hana-kb", "api/libraries", "abc"), "/api/plugins/hana-kb/api/libraries?token=abc");
  assert.equal(tokenizedUrl("/api/plugins/hana-kb", "api/search?mode=test", "a b"), "/api/plugins/hana-kb/api/search?mode=test&token=a%20b");
});

test("clips local graph to center plus one-hop nodes and bounded edges", () => {
  const graph = {
    center: { id: 1 },
    nodes: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    edges: [{ source: 1, target: 2 }, { source: 2, target: 3 }, { source: 3, target: 4 }],
  };
  const clipped = clipLocalGraph(graph, { maxNodes: 3, maxEdges: 2 });
  assert.deepEqual(clipped.nodes.map((node) => node.id), [1, 2, 3]);
  assert.deepEqual(clipped.edges.map((edge) => [edge.source, edge.target]), [[1, 2], [2, 3]]);
});

test("builds a bounded neighbor expansion request without allowing a full graph query", () => {
  assert.equal(graphEntityRequest("kb", 42), "api/libraries/kb/graph-data?entityId=42");
  assert.equal(graphEntityRequest("kb", "实体 A"), "api/libraries/kb/graph-data?entityId=%E5%AE%9E%E4%BD%93%20A");
});

test("toggles expanded result ids without mutating the original set", () => {
  const original = new Set(["a"]);
  const next = toggleExpanded(original, "b");
  assert.deepEqual([...original], ["a"]);
  assert.deepEqual([...next], ["a", "b"]);
  assert.deepEqual([...toggleExpanded(next, "a")], ["b"]);
});
