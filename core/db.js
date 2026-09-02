import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const LIBRARY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_FEATURES = Object.freeze({ graphEnabled: false, bm25Enabled: false, mmrEnabled: false });
const LIBRARY_METADATA_KEY = "libraryMetadata";
const DEFAULT_LIBRARY_CONFIG = Object.freeze({
  topK: 15,
  similarityThreshold: 0.5,
  chunkTargetLength: 400,
  chunkOverlap: 50,
});

export function normalizeLibraryDisplayName(value) {
  const name = String(value ?? "").normalize("NFKC").trim();
  if (!name) throw new Error("library name is required");
  if (/[\u0000-\u001F\u007F]/u.test(name)) throw new Error("library name contains unsupported control characters");
  return name;
}

export function safeLibraryId(value) {
  const displayName = normalizeLibraryDisplayName(value);
  if (LIBRARY_ID.test(displayName)) return displayName;
  const digest = crypto.createHash("sha256").update(displayName, "utf8").digest("hex").slice(0, 16);
  return `kb-${digest}`;
}

export function getLibraryDisplayName(db, fallback = "") {
  const metadata = readConfigJson(db, LIBRARY_METADATA_KEY);
  return typeof metadata.displayName === "string" && metadata.displayName ? metadata.displayName : fallback;
}

export function setLibraryDisplayName(db, displayName) {
  const name = normalizeLibraryDisplayName(displayName);
  db.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(LIBRARY_METADATA_KEY, JSON.stringify({ displayName: name }));
  return name;
}

export function libraryPath(dataDir, libraryId) {
  return path.join(dataDir, "kb", `${safeLibraryId(libraryId)}.sqlite`);
}

export function openDatabase(dataDir, libraryId) {
  const id = safeLibraryId(libraryId);
  const filePath = libraryPath(dataDir, id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    sqliteVec.load(db);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.exec(SCHEMA_SQL);
    migrateFts(db);
    ensureColumn(db, "documents", "graph_status", "TEXT NOT NULL DEFAULT 'pending'");
    ensureColumn(db, "documents", "graph_error", "TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_documents_graph_status ON documents(graph_status)");
    ensureFeatureDefaults(db);
    db.prepare("UPDATE documents SET status='pending', updated_at=CURRENT_TIMESTAMP WHERE status='processing'").run();
    db.prepare("UPDATE documents SET graph_status='pending', updated_at=CURRENT_TIMESTAMP WHERE graph_status='processing'").run();
    return { db, filePath, libraryId: id };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function getLibraryFeatures(db) {
  const row = db.prepare("SELECT value FROM config WHERE key='features'").get();
  if (!row) return { ...DEFAULT_FEATURES };
  try {
    const value = JSON.parse(row.value);
    return {
      graphEnabled: Boolean(value.graphEnabled),
      bm25Enabled: Boolean(value.bm25Enabled),
      mmrEnabled: Boolean(value.mmrEnabled),
    };
  } catch {
    return { ...DEFAULT_FEATURES };
  }
}

export function setLibraryFeatures(db, features = {}) {
  const next = { ...getLibraryFeatures(db), ...features };
  db.prepare("INSERT INTO config (key, value) VALUES ('features', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ graphEnabled: Boolean(next.graphEnabled), bm25Enabled: Boolean(next.bm25Enabled), mmrEnabled: Boolean(next.mmrEnabled) }));
  return getLibraryFeatures(db);
}

export function getLibraryManagementState(db) {
  const state = readConfigJson(db, "management");
  return { requiresRebuild: Boolean(state.requiresRebuild) };
}

export function markLibraryRebuildComplete(db) {
  db.prepare("INSERT INTO config (key, value) VALUES ('management', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ requiresRebuild: false }));
  return getLibraryManagementState(db);
}

export function getLibraryConfig(db) {
  const search = readConfigJson(db, "search");
  const chunking = readConfigJson(db, "chunking");
  const graph = readConfigJson(db, "graph");
  const features = getLibraryFeatures(db);
  const chunkTargetLength = normalizeInteger(chunking.chunkTargetLength, DEFAULT_LIBRARY_CONFIG.chunkTargetLength, 50, 10000);
  return {
    topK: normalizeInteger(search.topK, DEFAULT_LIBRARY_CONFIG.topK, 1, 1000),
    similarityThreshold: normalizeNumber(search.similarityThreshold, DEFAULT_LIBRARY_CONFIG.similarityThreshold, -1, 1),
    chunkTargetLength,
    chunkOverlap: normalizeInteger(chunking.chunkOverlap, Math.min(DEFAULT_LIBRARY_CONFIG.chunkOverlap, chunkTargetLength - 1), 0, chunkTargetLength - 1),
    chunkingCustomized: Object.keys(chunking).length > 0, // 用户是否显式配置过分块（默认走 chunker 内置喘息空间）
    // 库级泛化词表：领域相关的泛化指代（如医疗库的"护士/患者"），降级不建边
    genericEntities: Array.isArray(graph.genericEntities) ? graph.genericEntities.map((x) => String(x).trim()).filter(Boolean) : [],
    ...features,
  };
}

export function setLibraryConfig(db, patch = {}) {
  const current = getLibraryConfig(db);
  const searchPatch = patch.search && typeof patch.search === "object" ? patch.search : {};
  const chunkingPatch = patch.chunking && typeof patch.chunking === "object" ? patch.chunking : {};
  const normalizedPatch = {
    ...patch,
    topK: patch.topK ?? searchPatch.topK,
    similarityThreshold: patch.similarityThreshold ?? searchPatch.similarityThreshold,
    chunkTargetLength: patch.chunkTargetLength ?? patch.targetLength ?? chunkingPatch.chunkTargetLength ?? chunkingPatch.targetLength,
    chunkOverlap: patch.chunkOverlap ?? patch.overlap ?? chunkingPatch.chunkOverlap ?? chunkingPatch.overlap,
  };
  const next = {
    ...current,
    ...pickDefined(normalizedPatch, ["topK", "similarityThreshold", "chunkTargetLength", "chunkOverlap"]),
  };
  next.topK = normalizeInteger(next.topK, current.topK, 1, 1000);
  next.similarityThreshold = normalizeNumber(next.similarityThreshold, current.similarityThreshold, -1, 1);
  next.chunkTargetLength = normalizeInteger(next.chunkTargetLength, current.chunkTargetLength, 50, 10000);
  next.chunkOverlap = normalizeInteger(next.chunkOverlap, Math.min(current.chunkOverlap, next.chunkTargetLength - 1), 0, next.chunkTargetLength - 1);
  if (normalizedPatch.graphEnabled != null || normalizedPatch.bm25Enabled != null || normalizedPatch.mmrEnabled != null) {
    setLibraryFeatures(db, {
      graphEnabled: normalizedPatch.graphEnabled == null ? current.graphEnabled : Boolean(normalizedPatch.graphEnabled),
      bm25Enabled: normalizedPatch.bm25Enabled == null ? current.bm25Enabled : Boolean(normalizedPatch.bm25Enabled),
      mmrEnabled: normalizedPatch.mmrEnabled == null ? current.mmrEnabled : Boolean(normalizedPatch.mmrEnabled),
    });
  }
  const requiresRebuild = getLibraryManagementState(db).requiresRebuild
    || next.chunkTargetLength !== current.chunkTargetLength
    || next.chunkOverlap !== current.chunkOverlap;
  db.prepare("INSERT INTO config (key, value) VALUES ('management', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ requiresRebuild }));
  db.prepare("INSERT INTO config (key, value) VALUES ('search', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ topK: next.topK, similarityThreshold: next.similarityThreshold }));
  db.prepare("INSERT INTO config (key, value) VALUES ('chunking', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ chunkTargetLength: next.chunkTargetLength, chunkOverlap: next.chunkOverlap }));
  if (patch.genericEntities !== undefined) {
    const graphPatch = patch.graph && typeof patch.graph === "object" ? patch.graph : {};
    const list = Array.isArray(patch.genericEntities) ? patch.genericEntities : (Array.isArray(graphPatch.genericEntities) ? graphPatch.genericEntities : []);
    db.prepare("INSERT INTO config (key, value) VALUES ('graph', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({ ...readConfigJson(db, "graph"), genericEntities: list.map((x) => String(x).trim()).filter(Boolean) }));
  }
  return {
    config: getLibraryConfig(db),
    requiresRebuild,
  };
}

function readConfigJson(db, key) {
  const row = db.prepare("SELECT value FROM config WHERE key=?").get(key);
  if (!row) return {};
  try { return JSON.parse(row.value) ?? {}; } catch { return {}; }
}

function pickDefined(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] != null).map((key) => [key, source[key]]));
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

function normalizeNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return fallback;
  return number;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  normalized_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('pending','processing','done','failed')) DEFAULT 'pending',
  error_message TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  graph_status TEXT NOT NULL DEFAULT 'pending',
  graph_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  title_path TEXT NOT NULL DEFAULT '',
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  UNIQUE(document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
CREATE TABLE IF NOT EXISTS vec_index (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  embedding BLOB
);
CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY,
  source_entity_id INTEGER REFERENCES entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  target_entity_id INTEGER REFERENCES entities(id) ON DELETE CASCADE,
  source_chunk_id INTEGER REFERENCES chunks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);
CREATE TABLE IF NOT EXISTS chunk_entities (
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY(chunk_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_chunk_entities_entity ON chunk_entities(entity_id);
CREATE TABLE IF NOT EXISTS graph_extract (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('processing','ok','failed')),
  result TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function migrateFts(db) {
  const current = db.prepare("SELECT type, sql FROM sqlite_master WHERE name='fts_chunks'").get();
  if (current?.sql && /using\s+fts5/i.test(current.sql)) return;
  const legacyRows = current ? db.prepare("SELECT chunk_id, content FROM fts_chunks").all() : [];
  if (current) db.exec("DROP TABLE fts_chunks");
  db.exec("CREATE VIRTUAL TABLE fts_chunks USING fts5(content, chunk_id UNINDEXED, tokenize='trigram')");
  const insert = db.prepare("INSERT INTO fts_chunks (rowid, content, chunk_id) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (const row of legacyRows) insert.run(row.chunk_id, row.content, row.chunk_id);
  })();
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function ensureFeatureDefaults(db) {
  db.prepare("INSERT OR IGNORE INTO config (key, value) VALUES ('features', ?)").run(JSON.stringify(DEFAULT_FEATURES));
}
