import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, removeDir } from "./helpers.js";
import { LibraryManager } from "../core/library-manager.js";
import { SearchService, float32Blob } from "../core/search.js";

test("searches ordinary BLOB vectors with cosine distance, topK, and threshold", async () => {
  const dataDir = makeTempDir();
  try {
    const manager = new LibraryManager({ dataDir });
    const { db } = manager.create("search");
    const documentId = Number(db.prepare("INSERT INTO documents (path, name, content_hash, size, normalized_text, status) VALUES (?, ?, ?, ?, ?, 'done')")
      .run("C:/rules.md", "rules.md", "hash", 10, "内容").lastInsertRowid);
    const insertChunk = db.prepare("INSERT INTO chunks (document_id, ordinal, text, title_path, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?)");
    const insertVector = db.prepare("INSERT INTO vec_index (chunk_id, embedding) VALUES (?, ?)");
    const candidates = [
      ["最相关", [1, 0]],
      ["次相关", [0.8, 0.6]],
      ["无关", [0, 1]],
    ];
    candidates.forEach(([text, vector], index) => {
      const chunkId = Number(insertChunk.run(documentId, index, text, "一级", index * 4, index * 4 + text.length).lastInsertRowid);
      insertVector.run(chunkId, float32Blob(vector));
    });
    const search = new SearchService({ manager, embeddingClient: { embed: async () => [[1, 0]] } });
    const result = await search.search("search", "问题", { topK: 2, distanceThreshold: 0.5 });
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((item) => item.text), ["最相关", "次相关"]);
    assert.ok(result[0].similarity > result[1].similarity);
    assert.equal(result[0].documentName, "rules.md");
    assert.equal(result[0].titlePath, "一级");
    assert.equal(result[0].startOffset, 0);
    await manager.closeAll();
  } finally {
    removeDir(dataDir);
  }
});

test("uses topK 15 by default", async () => {
  const dataDir = makeTempDir();
  try {
    const manager = new LibraryManager({ dataDir });
    const { db } = manager.create("topk");
    const docId = Number(db.prepare("INSERT INTO documents (path, name, content_hash, size, normalized_text, status) VALUES (?, ?, ?, ?, ?, 'done')")
      .run("C:/many.md", "many.md", "hash", 0, "").lastInsertRowid);
    const insertChunk = db.prepare("INSERT INTO chunks (document_id, ordinal, text, title_path, start_offset, end_offset) VALUES (?, ?, ?, '', 0, 1)");
    const insertVector = db.prepare("INSERT INTO vec_index (chunk_id, embedding) VALUES (?, ?)");
    for (let index = 0; index < 20; index += 1) {
      const chunkId = Number(insertChunk.run(docId, index, `chunk-${index}`).lastInsertRowid);
      insertVector.run(chunkId, float32Blob([1, 0]));
    }
    const search = new SearchService({ manager, embeddingClient: { embed: async () => [[1, 0]] } });
    assert.equal((await search.search("topk", "问题")).length, 15);
    await manager.closeAll();
  } finally {
    removeDir(dataDir);
  }
});
