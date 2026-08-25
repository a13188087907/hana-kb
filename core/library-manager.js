import fs from "node:fs";
import path from "node:path";
import { getLibraryConfig, getLibraryDisplayName, getLibraryFeatures, getLibraryManagementState, markLibraryRebuildComplete, normalizeLibraryDisplayName, openDatabase, libraryPath, safeLibraryId, setLibraryConfig, setLibraryDisplayName } from "./db.js";
import { graphStats } from "./graph-build.js";

// 霸榜文档占比：块数 ≥ topK×0.8 的文档比例（实验验证：≥50% 时建议开启 MMR，零帮倒忙）
function computeMmrSignal(db) {
  try {
    const config = getLibraryConfig(db);
    const topK = Number(config.topK) || 15;
    const threshold = Math.ceil(topK * 0.8);
    const total = Number(db.prepare("SELECT COUNT(*) AS c FROM documents WHERE status='done'").get().c);
    if (!total) return { dominantRatio: 0, recommend: false };
    const dominant = Number(db.prepare(`
      SELECT COUNT(*) AS c FROM (
        SELECT document_id, COUNT(*) AS n FROM chunks
        WHERE document_id IN (SELECT id FROM documents WHERE status='done')
        GROUP BY document_id HAVING n >= ?
      )
    `).get(threshold).c);
    const dominantRatio = dominant / total;
    return { dominantRatio: Number(dominantRatio.toFixed(3)), recommend: dominantRatio >= 0.5 };
  } catch {
    return { dominantRatio: 0, recommend: false };
  }
}

// SQLite CURRENT_TIMESTAMP 是 UTC，转成本地时间字符串
function utcToLocal(value) {
  if (!value) return value;
  const normalized = String(value).replace(" ", "T") + "Z";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export class LibraryManager {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.handles = new Map();
    fs.mkdirSync(path.join(dataDir, "kb"), { recursive: true });
  }

  create(displayName) {
    const name = normalizeLibraryDisplayName(displayName);
    const id = safeLibraryId(name);
    const handle = this.open(id);
    if (!getLibraryDisplayName(handle.db)) setLibraryDisplayName(handle.db, name);
    return handle;
  }

  open(libraryId) {
    const id = safeLibraryId(libraryId);
    const existing = this.handles.get(id);
    if (existing) return existing;
    const handle = openDatabase(this.dataDir, id);
    this.handles.set(id, handle);
    return handle;
  }

  list() {
    const dir = path.join(this.dataDir, "kb");
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".sqlite"))
      .map((name) => name.slice(0, -7))
      .sort()
      .map((id) => {
        const handle = this.open(id);
        const row = handle.db.prepare(`
          SELECT COUNT(*) AS documents,
                 SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
                 SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) AS processing,
                 SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
                 SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
          FROM documents
        `).get();
        return {
          id,
          displayName: getLibraryDisplayName(handle.db, id),
          ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value || 0)])),
          ...getLibraryFeatures(handle.db),
          config: getLibraryConfig(handle.db),
          management: getLibraryManagementState(handle.db),
          requiresRebuild: getLibraryManagementState(handle.db).requiresRebuild,
          graphStats: graphStats(handle.db),
          mmrSignal: computeMmrSignal(handle.db),
        };
      });
  }

  getConfig(libraryId) {
    return getLibraryConfig(this.open(libraryId).db);
  }

  mmrSignal(libraryId) {
    return computeMmrSignal(this.open(libraryId).db);
  }

  updateConfig(libraryId, patch) {
    return setLibraryConfig(this.open(libraryId).db, patch);
  }

  markRebuildComplete(libraryId) {
    return markLibraryRebuildComplete(this.open(libraryId).db);
  }

  listDocumentPaths(libraryId) {
    return this.open(libraryId).db.prepare("SELECT path FROM documents ORDER BY id").all().map((row) => row.path);
  }

  listDocuments(libraryId, { page = 1, pageSize = 25 } = {}) {
    const safePage = integerInRange(page, 1, 100000, "page");
    const safePageSize = integerInRange(pageSize, 1, 100, "pageSize");
    const db = this.open(libraryId).db;
    const total = Number(db.prepare("SELECT COUNT(*) AS count FROM documents").get().count);
    const counts = db.prepare("SELECT status, COUNT(*) AS count FROM documents GROUP BY status").all();
    const countMap = { pending: 0, processing: 0, done: 0, failed: 0 };
    for (const row of counts) countMap[row.status] = Number(row.count);
    const graphCounts = db.prepare("SELECT graph_status, COUNT(*) AS count FROM documents WHERE status='done' GROUP BY graph_status").all();
    const graphCountMap = { done: 0, processing: 0, pending: 0, failed: 0 };
    for (const row of graphCounts) graphCountMap[row.graph_status] = Number(row.count);
    const documents = db.prepare(`
      SELECT id, path, name, status, chunk_count AS chunkCount, updated_at AS updatedAt,
             error_message AS error, graph_status AS graphStatus, graph_error AS graphError
      FROM documents
      ORDER BY updated_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(safePageSize, (safePage - 1) * safePageSize).map((row) => ({ ...row, updatedAt: utcToLocal(row.updatedAt) }));
    return {
      documents,
      page: safePage,
      pageSize: safePageSize,
      total,
      pages: Math.ceil(total / safePageSize),
      counts: countMap,
      graphCounts: graphCountMap,
    };
  }

  delete(libraryId) {
    const id = safeLibraryId(libraryId);
    const filePath = libraryPath(this.dataDir, id);
    const existed = fs.existsSync(filePath);
    const handle = this.handles.get(id);
    if (handle) {
      handle.db.close();
      this.handles.delete(id);
    }
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(filePath + suffix, { force: true });
    return existed;
  }

  async closeAll() {
    for (const [id, handle] of this.handles) {
      handle.db.close();
      this.handles.delete(id);
    }
  }
}

function integerInRange(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return number;
}
