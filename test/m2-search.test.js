import test from "node:test";
import assert from "node:assert/strict";
import { rrfFuse, SearchService, float32Blob } from "../core/search.js";
import { makeTempDir, removeDir } from "./helpers.js";
import { setLibraryFeatures } from "../core/db.js";
import { LibraryManager } from "../core/library-manager.js";

test("RRF keeps a single route in its original order and fuses N routes", () => {
  assert.deepEqual(rrfFuse([["a", "b", "c"]], 3), ["a", "b", "c"]);
  assert.deepEqual(rrfFuse([["a", "b"], ["b", "c"]], 3), ["b", "a", "c"]);
});

test("BM25 participates in RRF only when its library switch is enabled", async () => {
  const dataDir = makeTempDir();
  try {
    const manager = new LibraryManager({ dataDir });
    const { db } = manager.create("bm25-search");
    setLibraryFeatures(db, { graphEnabled: false, bm25Enabled: true });
    const docId = Number(db.prepare("INSERT INTO documents (path, name, content_hash, size, normalized_text, status) VALUES (?, ?, ?, ?, ?, 'done')").run("C:/bm25.md", "bm25.md", "h", 0, "").lastInsertRowid);
    const insertChunk = db.prepare("INSERT INTO chunks (document_id, ordinal, text, title_path, start_offset, end_offset) VALUES (?, ?, ?, '', 0, 1)");
    const insertVector = db.prepare("INSERT INTO vec_index (chunk_id, embedding) VALUES (?, ?)");
    const insertFts = db.prepare("INSERT INTO fts_chunks (rowid, content, chunk_id) VALUES (?, ?, ?)");
    [["alpha only", [1, 0]], ["beta only", [1, 0]]].forEach(([text, vector], index) => {
      const id = Number(insertChunk.run(docId, index, text).lastInsertRowid);
      insertVector.run(id, float32Blob(vector));
      insertFts.run(id, text, id);
    });
    const search = new SearchService({ manager, embeddingClient: { config: () => ({ baseUrl: "https://test.local", model: "test-model" }), embed: async () => [[1, 0]] } });
    const result = await search.search("bm25-search", "beta", { topK: 2, distanceThreshold: 1 });
    assert.equal(result[0].text, "beta only");
    assert.equal(result[0].source, "rrf");
    await manager.closeAll();
  } finally {
    removeDir(dataDir);
  }
});

test("graph results append after an unchanged vector main ranking", async () => {
  const dataDir = makeTempDir();
  try {
    const manager = new LibraryManager({ dataDir });
    const { db } = manager.create("graph-search");
    setLibraryFeatures(db, { graphEnabled: true, bm25Enabled: false });
    const docId = Number(db.prepare("INSERT INTO documents (path, name, content_hash, size, normalized_text, status) VALUES (?, ?, ?, ?, ?, 'done')").run("C:/graph.md", "graph.md", "h", 0, "").lastInsertRowid);
    const insertChunk = db.prepare("INSERT INTO chunks (document_id, ordinal, text, title_path, start_offset, end_offset) VALUES (?, ?, ?, '', ?, ?)");
    const insertVector = db.prepare("INSERT INTO vec_index (chunk_id, embedding) VALUES (?, ?)");
    const insertEntity = db.prepare("INSERT INTO entities (name, type, aliases_json, embedding) VALUES (?, 'concept', '[]', ?)");
    const entityA = Number(insertEntity.run("alpha", float32Blob([1, 0])).lastInsertRowid);
    const entityB = Number(insertEntity.run("beta", float32Blob([0.99, 0.01])).lastInsertRowid);
    const chunkIds = [];
    for (const [text, vector] of [["主排序一", [1, 0]], ["主排序二", [0.9, 0.1]], ["图谱追加", [0, 1]]]) {
      const id = Number(insertChunk.run(docId, chunkIds.length, text, chunkIds.length, chunkIds.length + text.length).lastInsertRowid);
      chunkIds.push(id);
      insertVector.run(id, float32Blob(vector));
    }
    db.prepare("INSERT INTO relations (source_entity_id, relation, target_entity_id, source_chunk_id) VALUES (?, '关联', ?, ?)").run(entityA, entityB, chunkIds[0]);
    db.prepare("INSERT INTO chunk_entities (chunk_id, entity_id) VALUES (?, ?)").run(chunkIds[2], entityA);
    const search = new SearchService({ manager, embeddingClient: { config: () => ({ baseUrl: "https://test.local", model: "test-model" }), embed: async () => [[1, 0]] } });
    const result = await search.search("graph-search", "问题", { topK: 2, distanceThreshold: 1 });
    assert.deepEqual(result.slice(0, 2).map((item) => item.text), ["主排序一", "主排序二"]);
    assert.equal(result[2].text, "图谱追加");
    assert.equal(result[2].source, "graph");
    await manager.closeAll();
  } finally {
    removeDir(dataDir);
  }
});
