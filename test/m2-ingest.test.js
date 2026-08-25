import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { IngestService } from "../core/ingest.js";
import { LibraryManager } from "../core/library-manager.js";
import { makeTempDir, removeDir } from "./helpers.js";

test("ingest synchronizes the FTS5 candidate index", async () => {
  const dataDir = makeTempDir();
  const sourceDir = makeTempDir();
  try {
    const file = path.join(sourceDir, "fts.md");
    fs.writeFileSync(file, "trigram 检索内容".repeat(20));
    const manager = new LibraryManager({ dataDir });
    manager.create("fts");
    const service = new IngestService({ manager, embeddingClient: { embed: async (texts) => texts.map(() => [1, 0]) } });
    await service.ingest("fts", [file]);
    const db = manager.open("fts").db;
    const row = db.prepare("SELECT c.text FROM fts_chunks f JOIN chunks c ON c.id=f.chunk_id WHERE fts_chunks MATCH ? LIMIT 1").get("trigram");
    assert.equal(row.text.includes("trigram"), true);
    await manager.closeAll();
  } finally {
    removeDir(dataDir);
    removeDir(sourceDir);
  }
});
