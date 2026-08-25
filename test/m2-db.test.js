import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { makeTempDir, removeDir } from "./helpers.js";
import { openDatabase, getLibraryFeatures, setLibraryFeatures } from "../core/db.js";

test("creates trigram FTS5 and feature defaults without changing vector storage", () => {
  const dataDir = makeTempDir();
  try {
    const { db } = openDatabase(dataDir, "m2-db");
    const fts = db.prepare("SELECT type, sql FROM sqlite_master WHERE name='fts_chunks'").get();
    assert.equal(fts.type, "table");
    assert.match(fts.sql, /VIRTUAL TABLE/i);
    assert.match(fts.sql, /fts5/i);
    assert.match(fts.sql, /trigram/i);
    assert.deepEqual(getLibraryFeatures(db), { graphEnabled: false, bm25Enabled: false, mmrEnabled: false });
    setLibraryFeatures(db, { graphEnabled: true, bm25Enabled: true });
    assert.deepEqual(getLibraryFeatures(db), { graphEnabled: true, bm25Enabled: true, mmrEnabled: false });
    assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='vec_index'").get().sql.includes("VIRTUAL"), false);
    db.close();
  } finally {
    removeDir(dataDir);
  }
});

test("migrates an M1 ordinary fts table and keeps its rows", () => {
  const dataDir = makeTempDir();
  try {
    const first = openDatabase(dataDir, "legacy");
    first.db.close();
    const raw = new Database(`${dataDir}/kb/legacy.sqlite`);
    raw.exec("DROP TABLE fts_chunks; CREATE TABLE fts_chunks (chunk_id INTEGER PRIMARY KEY, content TEXT NOT NULL);");
    raw.prepare("INSERT INTO fts_chunks (chunk_id, content) VALUES (?, ?)").run(7, "旧内容");
    raw.close();
    const { db } = openDatabase(dataDir, "legacy");
    assert.equal(db.prepare("SELECT content FROM fts_chunks WHERE rowid=?").get(7).content, "旧内容");
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='fts_chunks'").get().sql, /fts5/i);
    db.close();
  } finally {
    removeDir(dataDir);
  }
});
