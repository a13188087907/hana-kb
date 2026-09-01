import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getLibraryConfig, getLibraryManagementState, setLibraryConfig } from "../core/db.js";
import { GraphBuildService } from "../core/graph-build.js";
import { IngestService } from "../core/ingest.js";
import { LibraryManager } from "../core/library-manager.js";
import { makeTempDir, removeDir } from "./helpers.js";

test("persists management config and marks chunk changes for rebuild", () => {
  const dataDir = makeTempDir();
  try {
    const manager = new LibraryManager({ dataDir });
    const db = manager.create("config").db;
    assert.deepEqual(getLibraryConfig(db), {
      topK: 15,
      similarityThreshold: 0.5,
      chunkTargetLength: 400,
      chunkOverlap: 50,
      chunkingCustomized: false,
      graphEnabled: false,
      bm25Enabled: false,
      mmrEnabled: false,
    });
    assert.equal(setLibraryConfig(db, { topK: 9, similarityThreshold: 0.72 }).requiresRebuild, false);
    assert.equal(setLibraryConfig(db, { chunkTargetLength: 520, chunkOverlap: 80 }).requiresRebuild, true);
    assert.equal(getLibraryManagementState(db).requiresRebuild, true);
    assert.deepEqual(getLibraryConfig(db), {
      topK: 9,
      similarityThreshold: 0.72,
      chunkTargetLength: 520,
      chunkOverlap: 80,
      chunkingCustomized: true,
      graphEnabled: false,
      bm25Enabled: false,
      mmrEnabled: false,
    });
    manager.markRebuildComplete("config");
    assert.equal(getLibraryManagementState(db).requiresRebuild, false);
    manager.closeAll();
  } finally {
    removeDir(dataDir);
  }
});

test("paginates documents and returns live status counts", () => {
  const dataDir = makeTempDir();
  try {
    const manager = new LibraryManager({ dataDir });
    const db = manager.create("docs").db;
    const insert = db.prepare("INSERT INTO documents (path, name, content_hash, size, status, chunk_count, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("C:/a.md", "a.md", "a", 10, "done", 2, null);
    insert.run("C:/b.md", "b.md", "b", 20, "pending", 0, null);
    insert.run("C:/c.md", "c.md", "c", 30, "failed", 0, "parse failed");
    const page = manager.listDocuments("docs", { page: 1, pageSize: 2 });
    assert.equal(page.total, 3);
    assert.equal(page.pages, 2);
    assert.equal(page.documents.length, 2);
    assert.deepEqual(page.counts, { pending: 1, processing: 0, done: 1, failed: 1 });
    assert.equal(page.documents[1].status, "pending");
    manager.closeAll();
  } finally {
    removeDir(dataDir);
  }
});

test("uses the library chunk configuration when reingesting a document", async () => {
  const dataDir = makeTempDir();
  try {
    const filePath = path.join(dataDir, "configurable.md");
    fs.writeFileSync(filePath, `第一段 ${"长文本".repeat(45)}`);
    const manager = new LibraryManager({ dataDir });
    manager.create("chunking");
    manager.updateConfig("chunking", { chunkTargetLength: 80, chunkOverlap: 20 });
    const ingest = new IngestService({ manager, embeddingClient: { embed: async (texts) => texts.map(() => [1, 0]) } });
    const result = await ingest.ingest("chunking", [filePath]);
    assert.equal(result[0].status, "done");
    const rows = manager.open("chunking").db.prepare("SELECT text FROM chunks ORDER BY ordinal").all();
    assert.ok(rows.length > 1);
    assert.ok(rows.every((row) => row.text.length <= 80));
    manager.closeAll();
  } finally {
    removeDir(dataDir);
  }
});

test("returns one-hop chunk summaries and supports entityQuery alias", () => {
  const dataDir = makeTempDir();
  try {
    const manager = new LibraryManager({ dataDir });
    const db = manager.create("graph-summary").db;
    const entity = db.prepare("INSERT INTO entities (name, type, aliases_json) VALUES (?, ?, ?)");
    const center = Number(entity.run("中心实体", "concept", "[]").lastInsertRowid);
    const neighbor = Number(entity.run("邻居实体", "tool", "[]").lastInsertRowid);
    const document = Number(db.prepare("INSERT INTO documents (path, name, content_hash, status) VALUES (?, ?, ?, 'done')").run("C:/summary.md", "summary.md", "summary").lastInsertRowid);
    const chunk = Number(db.prepare("INSERT INTO chunks (document_id, ordinal, text, title_path, start_offset, end_offset) VALUES (?, 0, ?, ?, 0, 18)").run(document, "这是关联 chunk 摘要内容。", "章节 > 小节").lastInsertRowid);
    db.prepare("INSERT INTO chunk_entities (chunk_id, entity_id) VALUES (?, ?), (?, ?)").run(chunk, center, chunk, neighbor);
    db.prepare("INSERT INTO relations (source_entity_id, relation, target_entity_id, source_chunk_id) VALUES (?, ?, ?, ?)").run(center, "关联关系", neighbor, chunk);
    const local = new GraphBuildService({ manager }).localGraph("graph-summary", { entityQuery: "中心实体" });
    assert.equal(local.candidates.length, 1);
    const graph = new GraphBuildService({ manager }).localGraph("graph-summary", { entityId: center });
    assert.equal(graph.nodes.find((node) => node.id === center).chunkSummaries[0].text, "这是关联 chunk 摘要内容。");
    assert.equal(graph.edges[0].chunkSummary.titlePath, "章节 > 小节");
    assert.equal(graph.chunkSummaries[0].documentName, "summary.md");
    manager.closeAll();
  } finally {
    removeDir(dataDir);
  }
});

test("returns only one-hop graph data with bounded nodes and labeled edges", () => {
  const dataDir = makeTempDir();
  try {
    const manager = new LibraryManager({ dataDir });
    const db = manager.create("graph").db;
    const entity = db.prepare("INSERT INTO entities (name, type, aliases_json) VALUES (?, ?, ?)");
    const center = Number(entity.run("中心", "concept", "[]").lastInsertRowid);
    const neighbor = Number(entity.run("邻居", "tool", "[]").lastInsertRowid);
    const distant = Number(entity.run("远端", "role", "[]").lastInsertRowid);
    db.prepare("INSERT INTO relations (source_entity_id, relation, target_entity_id) VALUES (?, ?, ?)").run(center, "连接", neighbor);
    db.prepare("INSERT INTO relations (source_entity_id, relation, target_entity_id) VALUES (?, ?, ?)").run(neighbor, "继续", distant);
    const service = new GraphBuildService({ manager });
    const local = service.localGraph("graph", { entityId: center });
    assert.equal(local.center.id, center);
    assert.deepEqual(local.nodes.map((item) => item.name).sort(), ["中心", "邻居"]);
    assert.deepEqual(local.edges.map((item) => item.label), ["连接"]);
    assert.ok(local.nodes.length <= 81);
    assert.ok(local.edges.length <= 160);
    manager.closeAll();
  } finally {
    removeDir(dataDir);
  }
});
