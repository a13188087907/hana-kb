import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GraphBuildService, normalizeEntityName, parseExtraction, graphStats } from "../core/graph-build.js";
import { setLibraryFeatures } from "../core/db.js";
import { LibraryManager } from "../core/library-manager.js";
import { makeTempDir, removeDir } from "./helpers.js";

test("normalizes names and parses fenced JSON without vector pair comparisons", () => {
  assert.equal(normalizeEntityName("  Deep  Seek "), "deepseek");
  assert.deepEqual(parseExtraction("```json\n{\"entities\":[],\"relations\":[]}\n```"), { entities: [], relations: [] });
});

test("builds graph with alias merge, retries failed chunks, and resumes successes", async () => {
  const dataDir = makeTempDir();
  try {
    const manager = new LibraryManager({ dataDir });
    const { db } = manager.create("graph-build");
    setLibraryFeatures(db, { graphEnabled: true, bm25Enabled: false });
    const documentId = Number(db.prepare("INSERT INTO documents (path, name, content_hash, size, normalized_text, status) VALUES (?, ?, ?, ?, ?, 'done')").run("C:/doc.md", "doc.md", "h", 0, "").lastInsertRowid);
    const insertChunk = db.prepare("INSERT INTO chunks (document_id, ordinal, text, title_path, start_offset, end_offset) VALUES (?, ?, ?, '', 0, 3)");
    insertChunk.run(documentId, 0, "第一段");
    insertChunk.run(documentId, 1, "第二段");
    let chatCalls = 0;
    let embedCalls = 0;
    const graph = new GraphBuildService({
      manager,
      embeddingClient: { embed: async (texts) => { embedCalls += texts.length; return texts.map(() => [1, 0]); } },
      chat: async (text) => {
        chatCalls += 1;
        if (text.includes("第二段")) throw new Error("temporary");
        return JSON.stringify({ entities: [{ name: "Deep Seek", type: "tool", aliases: ["DS"] }, { name: "DS", type: "tool", aliases: [] }], relations: [{ subject: "Deep Seek", predicate: "简称", object: "DS" }] });
      },
      retryDelayMs: 0,
      sleep: async () => {},
    });
    const first = await graph.build("graph-build");
    assert.equal(first.processed, 2);
    assert.equal(chatCalls, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entities").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM relations").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunk_entities").get().n, 1);
    assert.equal(db.prepare("SELECT status FROM graph_extract WHERE chunk_id=1").get().status, "ok");
    assert.equal(db.prepare("SELECT status FROM graph_extract WHERE chunk_id=2").get().status, "failed");
    const second = await graph.build("graph-build");
    assert.equal(second.processed, 1);
    assert.equal(embedCalls, 2);
    const stats = graphStats(db);
    assert.equal(stats.entities, 1);
    assert.equal(stats.relations, 0);
    assert.equal(stats.uncoveredChunks, 1);
    await manager.closeAll();
  } finally {
    removeDir(dataDir);
  }
});
