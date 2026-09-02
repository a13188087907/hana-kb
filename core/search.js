import { getLibraryFeatures, checkIndexFingerprint } from "./db.js";

const DEFAULT_TOP_K = 15;
const DEFAULT_DISTANCE_THRESHOLD = 0.7;
const RRF_K = 60;
const GRAPH_ENTITY_LIMIT = 5;
const GRAPH_SIMILARITY_THRESHOLD = 0.55;
const GRAPH_APPEND_LIMIT = 5;
const MMR_ALPHA = 0.15;
const MMR_TRIGGER_SHARE = 0.8;

// 文档级折扣多样性重排（实验验证：α=0.15 + 80% 触发保护，三套语料零变差）
function mmrDiverse(rows, K, alpha = MMR_ALPHA, triggerShare = MMR_TRIGGER_SHARE) {
  if (rows.length <= K) return rows;
  const head = rows.slice(0, K);
  const perDoc = new Map();
  for (const row of head) perDoc.set(row.documentId, (perDoc.get(row.documentId) || 0) + 1);
  const maxShare = perDoc.size ? Math.max(...perDoc.values()) / K : 0;
  if (maxShare > triggerShare) return head;
  const selected = [];
  const counts = new Map();
  const pool = [...rows];
  while (selected.length < K && pool.length) {
    let bestIdx = -1, bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const row = pool[i];
      const sim = 1 - (row.distance ?? 0);
      const dup = counts.get(row.documentId) || 0;
      // 同文档前两块免折扣：对比型查询需要同文档的多个语义单元同时召回（实测 c01 类查询被折扣压制）
      const score = sim / (1 + alpha * Math.max(0, dup - 1));
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    const picked = pool[bestIdx];
    selected.push(picked);
    pool.splice(bestIdx, 1);
    counts.set(picked.documentId, (counts.get(picked.documentId) || 0) + 1);
  }
  return selected;
}

export { mmrDiverse };

export class SearchService {
  constructor({ manager, embeddingClient }) {
    this.manager = manager;
    this.embeddingClient = embeddingClient;
  }

  async search(libraryId, query, options = {}) {
    const text = String(query ?? "").trim();
    if (!text) throw new Error("query is required");
    const db = this.manager.open(libraryId).db;
    const config = readSearchConfig(db);
    const features = getLibraryFeatures(db);
    const topK = clampInteger(options.topK ?? config.topK ?? DEFAULT_TOP_K, 1, 1000);
    const distanceThreshold = resolveDistanceThreshold(options, config);
    const [vector] = await this.embeddingClient.embed([text]);
    if (!vector) throw new Error("query embedding is empty");
    // 索引指纹核对：换过 embedding 模型时阻止返回不可比的向量结果
    const fpError = checkIndexFingerprint(db, this.embeddingClient.config(), vector.length);
    if (fpError) throw new Error(fpError);

    let vectorRows = vectorSearch(db, vector, distanceThreshold, topK * 3);
    if (features.mmrEnabled) {
      vectorRows = mmrDiverse(vectorRows, topK);
    }
    const vectorIds = vectorRows.map((row) => row.id);
    const routes = [{ name: "vector", ids: vectorIds }];
    let bm25Rows = [];
    if (features.bm25Enabled) {
      bm25Rows = bm25Search(db, text, topK * 3);
      routes.push({ name: "bm25", ids: bm25Rows.map((row) => row.id) });
    }
    const nonEmptyRoutes = routes.filter((route) => route.ids.length);
    const mainIds = rrfFuse(nonEmptyRoutes.map((route) => route.ids), topK);
    const rowById = new Map([...vectorRows, ...bm25Rows].map((row) => [row.id, row]));
    const routeById = new Map();
    for (const route of routes) for (const [index, id] of route.ids.entries()) {
      const existing = routeById.get(id) ?? [];
      existing.push({ name: route.name, rank: index + 1 });
      routeById.set(id, existing);
    }
    const main = mainIds.map((id) => {
      const row = rowById.get(id) ?? loadChunkRow(db, id);
      return decorate(row, routeById.get(id) ?? [], id);
    });

    if (!features.graphEnabled) return main;
    const graph = graphSearch(db, vector);
    const mainSet = new Set(mainIds);
    const appendIds = graph.ids.filter((id) => !mainSet.has(id)).slice(0, GRAPH_APPEND_LIMIT);
    const appended = appendIds.map((id) => ({ ...decorate(loadChunkRow(db, id), [{ name: "graph", rank: graph.ids.indexOf(id) + 1 }], id), source: "graph", graphEntities: graph.hitEntities }));
    return [...main, ...appended];
  }
}

export function rrfFuse(layers, limit = Infinity, rrfK = RRF_K) {
  const routes = (layers ?? []).filter((layer) => Array.isArray(layer) && layer.length);
  if (routes.length === 0) return [];
  if (routes.length === 1) return routes[0].slice(0, limit);
  const scores = new Map();
  for (const route of routes) {
    const seen = new Set();
    route.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (rrfK + index + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0])).slice(0, limit).map(([id]) => id);
}

function vectorSearch(db, vector, distanceThreshold, limit) {
  return db.prepare(`
    SELECT * FROM (
      SELECT c.id, c.document_id AS documentId, d.name AS documentName,
             c.text, c.title_path AS titlePath,
             c.start_offset AS startOffset, c.end_offset AS endOffset,
             vec_distance_cosine(v.embedding, ?) AS distance
      FROM vec_index v
      JOIN chunks c ON c.id = v.chunk_id
      JOIN documents d ON d.id = c.document_id
    )
    WHERE distance <= ?
    ORDER BY distance ASC, id ASC
    LIMIT ?
  `).all(float32Blob(vector), distanceThreshold, limit);
}

function bm25Search(db, query, limit) {
  const safeQuery = String(query).replace(/["']/g, " ").trim();
  if (!safeQuery) return [];
  try {
    return db.prepare(`
      SELECT c.id, c.document_id AS documentId, d.name AS documentName,
             c.text, c.title_path AS titlePath,
             c.start_offset AS startOffset, c.end_offset AS endOffset,
             bm25(fts_chunks) AS bm25Score
      FROM fts_chunks
      JOIN chunks c ON c.id = fts_chunks.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE fts_chunks MATCH ?
      ORDER BY bm25(fts_chunks) ASC, c.id ASC
      LIMIT ?
    `).all(safeQuery, limit);
  } catch {
    return [];
  }
}

function graphSearch(db, queryVector) {
  const entities = db.prepare("SELECT id, name, embedding FROM entities WHERE embedding IS NOT NULL").all();
  const scored = entities.map((entity) => ({ ...entity, similarity: cosineSimilarity(queryVector, fromFloat32Blob(entity.embedding)) }))
    .sort((a, b) => b.similarity - a.similarity || a.id - b.id);
  const hitEntities = scored.slice(0, GRAPH_ENTITY_LIMIT).filter((entity) => entity.similarity >= GRAPH_SIMILARITY_THRESHOLD);
  if (!hitEntities.length) return { ids: [], hitEntities: [] };
  const expanded = new Set(hitEntities.map((entity) => entity.id));
  const neighbor = db.prepare(`SELECT target_entity_id AS id FROM relations WHERE source_entity_id=? UNION SELECT source_entity_id AS id FROM relations WHERE target_entity_id=?`);
  for (const entity of hitEntities) for (const row of neighbor.all(entity.id, entity.id)) expanded.add(row.id);
  const count = new Map();
  const expandedIds = [...expanded];
  if (expandedIds.length) {
    // 批量 IN 查询，避免每实体一次 SQL 的 N+1
    const rows = db.prepare(`SELECT chunk_id FROM chunk_entities WHERE entity_id IN (${expandedIds.map(() => "?").join(",")})`).all(...expandedIds);
    for (const row of rows) count.set(row.chunk_id, (count.get(row.chunk_id) ?? 0) + 1);
  }
  const ids = [...count.entries()].sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0])).map(([id]) => id);
  return { ids, hitEntities: hitEntities.map((entity) => entity.name) };
}

function decorate(row, routeHits, id) {
  if (!row) return { id, source: routeHits.length ? routeHits[0].name : "vector" };
  const names = routeHits.map((hit) => hit.name);
  const source = names.length > 1 ? "rrf" : (names[0] ?? "vector");
  return {
    id: row.id,
    documentId: row.documentId,
    documentName: row.documentName,
    text: row.text,
    titlePath: row.titlePath,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    distance: row.distance,
    similarity: row.distance == null ? undefined : 1 - row.distance,
    source,
    sources: names,
  };
}

function loadChunkRow(db, id) {
  return db.prepare(`SELECT c.id, c.document_id AS documentId, d.name AS documentName, c.text, c.title_path AS titlePath, c.start_offset AS startOffset, c.end_offset AS endOffset FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.id=?`).get(id);
}

export function float32Blob(vector) {
  if (!Array.isArray(vector)) throw new Error("embedding vector must be an array");
  return Buffer.from(new Float32Array(vector).buffer);
}

function fromFloat32Blob(buffer) {
  return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
}

function cosineSimilarity(a, b) {
  if (!a?.length || a.length !== b.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    na += a[index] ** 2;
    nb += b[index] ** 2;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : -1;
}

function readSearchConfig(db) {
  const row = db.prepare("SELECT value FROM config WHERE key='search'").get();
  if (!row) return {};
  try { return JSON.parse(row.value); } catch { return {}; }
}

function resolveDistanceThreshold(options, config) {
  if (options.distanceThreshold != null) return Number(options.distanceThreshold);
  if (options.similarityThreshold != null) return 1 - Number(options.similarityThreshold);
  if (config.distanceThreshold != null) return Number(config.distanceThreshold);
  if (config.similarityThreshold != null) return 1 - Number(config.similarityThreshold);
  return DEFAULT_DISTANCE_THRESHOLD;
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`topK must be an integer between ${min} and ${max}`);
  return number;
}

function compareIds(left, right) {
  return Number(left) - Number(right);
}
