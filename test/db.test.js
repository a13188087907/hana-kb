import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, removeDir, tableNames } from "./helpers.js";
import { openDatabase } from "../core/db.js";
import { LibraryManager } from "../core/library-manager.js";

test("opens an M1 library with the stable eight-table schema", () => {
  const dataDir = makeTempDir();
  try {
    const { db, filePath } = openDatabase(dataDir, "demo");
    const names = tableNames(db);
    for (const name of ["chunk_entities", "chunks", "config", "documents", "entities", "fts_chunks", "graph_extract", "relations", "vec_index"]) {
      assert.equal(names.includes(name), true, `missing table ${name}`);
    }
    const ftsColumns = db.prepare("PRAGMA table_info(fts_chunks)").all().map((row) => row.name);
    assert.deepEqual(ftsColumns, ["content", "chunk_id"]);
    const vecColumns = db.prepare("PRAGMA table_info(vec_index)").all();
    assert.deepEqual(vecColumns.map((row) => row.name), ["chunk_id", "embedding"]);
    assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='vec_index'").get().sql.includes("VIRTUAL"), false);
    assert.equal(path.basename(filePath), "demo.sqlite");
    db.close();
  } finally {
    removeDir(dataDir);
  }
});

test("startup recovery changes processing documents back to pending", () => {
  const dataDir = makeTempDir();
  try {
    const first = openDatabase(dataDir, "recovery");
    first.db.prepare("INSERT INTO documents (path, name, content_hash, size, normalized_text, status) VALUES (?, ?, ?, ?, ?, 'processing')")
      .run("C:/doc.md", "doc.md", "hash", 3, "abc");
    first.db.close();

    const second = openDatabase(dataDir, "recovery");
    assert.equal(second.db.prepare("SELECT status FROM documents WHERE path=?").get("C:/doc.md").status, "pending");
    second.db.close();
  } finally {
    removeDir(dataDir);
  }
});

test("library manager closes all handles so the database file can be renamed", async () => {
  const dataDir = makeTempDir();
  try {
    const manager = new LibraryManager({ dataDir });
    manager.create("rename-me");
    await manager.closeAll();
    const source = path.join(dataDir, "kb", "rename-me.sqlite");
    const target = path.join(dataDir, "kb", "renamed.sqlite");
    fs.renameSync(source, target);
    assert.equal(fs.existsSync(target), true);
  } finally {
    removeDir(dataDir);
  }
});
