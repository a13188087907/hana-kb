import { getLlmConfig } from "./config.js";
import { classifyEntity } from "./entity-cleaner.js";
import { getLibraryConfig } from "./db.js";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";

// Louvain 社区检测：输入节点与去重边，返回 Map<nodeId, communityIndex>
function detectCommunities(nodes, edges) {
  const result = new Map();
  if (!nodes.length) return result;
  try {
    const g = new Graph({ type: "undirected", multi: false });
    for (const n of nodes) g.addNode(String(n.id));
    for (const e of edges) {
      const s = String(e.source), t = String(e.target);
      if (s !== t && g.hasNode(s) && g.hasNode(t) && !g.hasEdge(s, t)) g.addEdge(s, t, { weight: Number(e.weight) || 1 });
    }
    const assign = louvain(g, { getEdgeWeight: "weight" });
    for (const n of nodes) {
      const c = assign[String(n.id)];
      result.set(n.id, Number.isFinite(c) ? c : 0);
    }
  } catch { /* 社区检测失败不阻塞图谱返回 */ }
  return result;
}

const DEFAULT_LLM_MODEL = "deepseek-v4-flash";
const GRAPH_SEARCH_LIMIT = 20;
const GRAPH_NODE_LIMIT = 81;
const GRAPH_EDGE_LIMIT = 160;
const GRAPH_CHUNK_LIMIT = 100;
const GRAPH_SUMMARY_LENGTH = 240;
const EXTRACTION_PROMPT = `从以下文本片段中提取实体和关系，输出严格 JSON，不要输出其他内容。
格式：{"entities":[{"name":"实体名","type":"concept/tool/role/process/document/method","aliases":["变体"]}],"relations":[{"subject":"实体名","predicate":"关系短语","object":"实体名"}]}
实体标准（严格遵守）：
- 实体必须是专有名词、制度/文件/规范名称、专业术语、工具、角色、流程或可独立指代的领域概念，能在多处上下文中有意义地引用
- 不抽日常普通名词（如“客人”“夜班”“桌子”“被子”）、临时描述（如“某次事故”“几个人”）、情感或状态词
- 实体名是短语而非整句：不超过 15 字，不含“及各种”“以及”“等等”这类连接词；不要截取半个句子当实体
- 制度全名、标准编号（如 NU-SOP-02-003）可以完整保留
规则：实体最多 8 个；关系最多 6 条，只抽文本明确支持的关系；subject/object 必须出现在 entities 的 name 中；别名没有则输出空数组。
文本：`;

export class GraphBuildService {
  constructor({ manager, embeddingClient, dataDir, fetchImpl = globalThis.fetch, chat, concurrency = 4, retryDelayMs = 500, requestTimeoutMs = 60000, sleep = delay } = {}) {
    this.manager = manager;
    this.embeddingClient = embeddingClient;
    this.dataDir = dataDir;
    this.fetchImpl = fetchImpl;
    this.chatImpl = chat;
    this.concurrency = Math.max(1, Number(concurrency) || 4);
    this.retryDelayMs = retryDelayMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.sleep = sleep;
    this.queues = new Map();
  }

  async build(libraryId, { documentId, retryFailed = true } = {}) {
    const run = () => this._build(libraryId, { documentId, retryFailed });
    const previous = this.queues.get(libraryId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    const queued = current.finally(() => {
      if (this.queues.get(libraryId) === queued) this.queues.delete(libraryId);
    });
    this.queues.set(libraryId, queued);
    return current;
  }

  async buildDocument(libraryId, documentId) {
    return this.build(libraryId, { documentId });
  }

  isRunning(libraryId) {
    return this.queues.has(libraryId);
  }

  fullGraph(db) {
    const MAX_NODES = 5000, MAX_EDGES = 8000;
    // degree 与 edges 都按去重实体对计算：A-B 之间无论有几条关系记录，图上都是一条连线
    const nodes = db.prepare(`
      SELECT e.id, e.name, e.type,
        (SELECT COUNT(*) FROM (
          SELECT DISTINCT CASE WHEN source_entity_id=e.id THEN target_entity_id ELSE source_entity_id END AS nb
          FROM relations r WHERE r.source_entity_id=e.id OR r.target_entity_id=e.id
        )) AS degree
      FROM entities e
      ORDER BY degree DESC, e.id
      LIMIT ?
    `).all(MAX_NODES).map((row) => ({ id: row.id, name: row.name, type: row.type, degree: Number(row.degree) }));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = db.prepare(`
      SELECT source, target, COUNT(*) AS weight FROM (
        SELECT CASE WHEN source_entity_id < target_entity_id THEN source_entity_id ELSE target_entity_id END AS source,
               CASE WHEN source_entity_id < target_entity_id THEN target_entity_id ELSE source_entity_id END AS target
        FROM relations
      )
      GROUP BY source, target
      ORDER BY weight DESC, source, target
      LIMIT ?
    `).all(MAX_EDGES)
      .map((row) => ({ source: row.source, target: row.target, weight: Number(row.weight) || 1 }))
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    const communities = detectCommunities(nodes, edges);
    for (const n of nodes) n.community = communities.get(n.id) ?? 0;
    const truncated = nodes.length >= MAX_NODES || edges.length >= MAX_EDGES;
    return { mode: "full", center: null, nodes, edges, chunkSummaries: [], truncated };
  }

  stats(libraryId) {
    return graphStats(this.manager.open(libraryId).db);
  }

  localGraph(libraryId, queryOptions = {}) {
    const options = typeof queryOptions === "string" ? { entity: queryOptions } : (queryOptions || {});
    const db = this.manager.open(libraryId).db;
    if (options.mode === "full") {
      return this.fullGraph(db);
    }
    if (options.entityId == null) {
      const query = String(options.entityQuery ?? options.entity ?? "").trim();
      if (!query) throw new Error("entity or entityId is required");
      const pattern = `%${query.toLowerCase()}%`;
      const candidates = db.prepare(`
        SELECT id, name, type, aliases_json AS aliases
        FROM entities
        WHERE lower(name) LIKE ? OR lower(aliases_json) LIKE ?
        ORDER BY CASE WHEN lower(name)=? THEN 0 ELSE 1 END, name
        LIMIT ?
      `).all(pattern, pattern, query.toLowerCase(), GRAPH_SEARCH_LIMIT).map(parseEntityRow);
      return { query, candidates, center: null, nodes: [], edges: [], chunkSummaries: [] };
    }

    const id = Number(options.entityId);
    if (!Number.isInteger(id) || id < 1) throw new Error("entityId must be a positive integer");
    const center = db.prepare("SELECT id, name, type FROM entities WHERE id=?").get(id);
    if (!center) throw new Error("entity not found");
    const relations = db.prepare(`
      SELECT r.id, r.source_entity_id AS source, r.target_entity_id AS target,
             r.relation AS label, r.source_chunk_id AS chunkId
      FROM relations r
      WHERE r.source_entity_id=? OR r.target_entity_id=?
      ORDER BY r.id
      LIMIT ?
    `).all(id, id, GRAPH_EDGE_LIMIT);
    const neighborIds = [];
    const seen = new Set([id]);
    for (const row of relations) {
      for (const neighborId of [row.source, row.target]) {
        if (!seen.has(neighborId) && neighborIds.length < GRAPH_NODE_LIMIT - 1) {
          seen.add(neighborId);
          neighborIds.push(neighborId);
        }
      }
    }
    const ids = [id, ...neighborIds];
    const placeholders = ids.map(() => "?").join(",");
    const entities = db.prepare(`
      SELECT e.id, e.name, e.type,
        (SELECT COUNT(*) FROM (
          SELECT DISTINCT CASE WHEN source_entity_id=e.id THEN target_entity_id ELSE source_entity_id END AS nb
          FROM relations r WHERE r.source_entity_id=e.id OR r.target_entity_id=e.id
        )) AS degree
      FROM entities e WHERE e.id IN (${placeholders})
    `).all(...ids).map((row) => ({ id: row.id, name: row.name, type: row.type, degree: Number(row.degree) }));
    const allowed = new Set(ids);
    const edges = relations.filter((row) => allowed.has(row.source) && allowed.has(row.target)).slice(0, GRAPH_EDGE_LIMIT)
      .map((row) => ({
        id: row.id,
        source: row.source,
        target: row.target,
        label: String(row.label ?? "").slice(0, 120),
        chunkId: row.chunkId,
      }));
    const chunkRows = db.prepare(`
      SELECT ce.entity_id AS entityId, c.id, c.document_id AS documentId, d.name AS documentName,
             c.text, c.title_path AS titlePath, c.start_offset AS startOffset, c.end_offset AS endOffset
      FROM chunk_entities ce
      JOIN chunks c ON c.id=ce.chunk_id
      JOIN documents d ON d.id=c.document_id
      WHERE ce.entity_id IN (${placeholders})
      ORDER BY c.id
      LIMIT ?
    `).all(...ids, GRAPH_CHUNK_LIMIT);
    const relationChunkIds = [...new Set(edges.map((edge) => edge.chunkId).filter(Boolean))];
    const extraChunkRows = relationChunkIds.length
      ? db.prepare(`
          SELECT c.id, c.document_id AS documentId, d.name AS documentName,
                 c.text, c.title_path AS titlePath, c.start_offset AS startOffset, c.end_offset AS endOffset
          FROM chunks c JOIN documents d ON d.id=c.document_id
          WHERE c.id IN (${relationChunkIds.map(() => "?").join(",")})
        `).all(...relationChunkIds)
      : [];
    const summaries = summarizeChunks([...extraChunkRows, ...chunkRows]);
    const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
    const summariesByEntity = new Map();
    for (const row of chunkRows) {
      const current = summariesByEntity.get(row.entityId) ?? [];
      const summary = summaryById.get(row.id);
      if (summary && !current.some((item) => item.id === summary.id)) current.push(summary);
      summariesByEntity.set(row.entityId, current);
    }
    const nodes = entities.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type || "concept",
      degree: edges.filter((edge) => edge.source === row.id || edge.target === row.id).length,
      chunkSummaries: summariesByEntity.get(row.id) ?? [],
    }));
    const withEdgeSummaries = edges.map((edge) => ({ ...edge, chunkSummary: edge.chunkId ? summaryById.get(edge.chunkId) ?? null : null }));
    return {
      query: center.name,
      candidates: [],
      center: nodes.find((node) => node.id === id),
      nodes,
      edges: withEdgeSummaries,
      chunkSummaries: summaries,
    };
  }

  async _build(libraryId, { documentId, retryFailed }) {
    const db = this.manager.open(libraryId).db;
    // 清理上次中断遗留的 processing 行（进程崩溃/请求挂起时不会回写终态）
    db.prepare("DELETE FROM graph_extract WHERE status='processing'").run();
    const filters = ["d.status='done'"];
    const params = [];
    if (documentId != null) {
      filters.push("c.document_id=?");
      params.push(Number(documentId));
    }
    const statusFilter = retryFailed ? "(g.status IS NULL OR g.status!='ok')" : "g.status IS NULL";
    const chunks = db.prepare(`
      SELECT c.id, c.text, c.document_id AS documentId
      FROM chunks c JOIN documents d ON d.id=c.document_id
      LEFT JOIN graph_extract g ON g.chunk_id=c.id
      WHERE ${filters.join(" AND ")} AND ${statusFilter}
      ORDER BY c.id
    `).all(...params);
    let processed = 0;
    let failed = 0;
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= chunks.length) return;
        const result = await this._extractChunk(db, chunks[index]);
        processed += 1;
        if (!result.ok) failed += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, chunks.length) }, worker));
    if (chunks.length) await this._materialize(db);
    this._updateDocumentGraphStatuses(db, documentId);
    return { processed, failed, stats: graphStats(db) };
  }

  async _extractChunk(db, chunk) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      db.prepare(`INSERT INTO graph_extract (chunk_id, status, result, attempts, error_message, updated_at)
        VALUES (?, 'processing', NULL, ?, NULL, CURRENT_TIMESTAMP)
        ON CONFLICT(chunk_id) DO UPDATE SET status='processing', attempts=?, error_message=NULL, updated_at=CURRENT_TIMESTAMP`)
        .run(chunk.id, attempt, attempt);
      try {
        const raw = await this.chat(chunk.text);
        const parsed = parseExtraction(raw);
        if (!parsed) throw new Error("LLM returned invalid graph JSON");
        db.prepare("UPDATE graph_extract SET status='ok', result=?, attempts=?, error_message=NULL, updated_at=CURRENT_TIMESTAMP WHERE chunk_id=?")
          .run(JSON.stringify(parsed), attempt, chunk.id);
        return { ok: true };
      } catch (error) {
        lastError = error;
        if (attempt < 3) await this.sleep(this.retryDelayMs * (2 ** (attempt - 1)));
      }
    }
    db.prepare("UPDATE graph_extract SET status='failed', result=NULL, attempts=3, error_message=?, updated_at=CURRENT_TIMESTAMP WHERE chunk_id=?")
      .run(String(lastError?.stack || lastError?.message || lastError).slice(0, 1000), chunk.id);
    return { ok: false, error: lastError };
  }

  async chat(text) {
    if (this.chatImpl) return this.chatImpl(text);
    const config = readLlmConfig(this.dataDir);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          messages: [{ role: "user", content: EXTRACTION_PROMPT + text }],
          max_tokens: 1000,
          thinking: { type: "disabled" },
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`LLM API ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("LLM response content is empty");
      return content;
    } catch (error) {
      const message = String(error?.message || error || "");
      if (message.includes("not declared in manifest")) {
        const host = message.match(/host "([^"]+)"/)?.[1] || "该服务商";
        throw new Error(`LLM 服务商（${host}）不在插件网络白名单内，请在全局设置里更换服务商`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async _materialize(db) {
    const rows = db.prepare("SELECT chunk_id, result FROM graph_extract WHERE status='ok' ORDER BY chunk_id").all();
    const rawEntities = new Map();
    const rawRelations = [];
    for (const row of rows) {
      const extraction = parseExtraction(row.result);
      if (!extraction) continue;
      for (const item of extraction.entities) {
        const name = String(item.name ?? "").trim();
        const norm = normalizeEntityName(name);
        if (!norm || norm.length > 120) continue;
        if (!rawEntities.has(norm)) rawEntities.set(norm, { names: new Set(), aliases: new Set(), types: new Set(), chunks: new Set() });
        const record = rawEntities.get(norm);
        record.names.add(name);
        if (item.type) record.types.add(String(item.type).trim());
        for (const alias of Array.isArray(item.aliases) ? item.aliases : []) {
          if (String(alias).trim()) record.aliases.add(String(alias).trim());
        }
        record.chunks.add(row.chunk_id);
      }
      for (const relation of extraction.relations) {
        const source = normalizeEntityName(relation.subject);
        const target = normalizeEntityName(relation.object);
        if (source && target && relation.predicate) rawRelations.push({ source, target, predicate: String(relation.predicate).trim(), chunkId: row.chunk_id });
      }
    }
    if (!rawEntities.size) {
      db.transaction(() => {
        db.exec("DELETE FROM relations; DELETE FROM chunk_entities; DELETE FROM entities;");
      })();
      return;
    }

    const parent = new Map([...rawEntities.keys()].map((name) => [name, name]));
    const find = (name) => {
      let root = name;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(name) !== name) {
        const next = parent.get(name);
        parent.set(name, root);
        name = next;
      }
      return root;
    };
    const union = (left, right) => {
      const a = find(left);
      const b = find(right);
      if (a !== b) parent.set(b, a);
    };
    const aliasOwners = new Map();
    for (const [name, record] of rawEntities) {
      for (const alias of record.aliases) {
        const aliasNorm = normalizeEntityName(alias);
        if (aliasNorm && rawEntities.has(aliasNorm)) {
          union(name, aliasNorm);
        } else if (aliasNorm && !aliasOwners.has(aliasNorm)) {
          aliasOwners.set(aliasNorm, name);
        } else if (aliasNorm) {
          union(name, aliasOwners.get(aliasNorm));
        }
      }
    }
    const groups = new Map();
    for (const name of rawEntities.keys()) {
      const root = find(name);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(name);
    }

    const entityRows = [];
    for (const [root, members] of groups) {
      const names = new Set();
      const aliases = new Set();
      const types = new Set();
      const chunks = new Set();
      for (const member of members) {
        const record = rawEntities.get(member);
        record.names.forEach((value) => names.add(value));
        record.aliases.forEach((value) => aliases.add(value));
        record.types.forEach((value) => types.add(value));
        record.chunks.forEach((value) => chunks.add(value));
      }
      const displayName = [...names][0];
      aliases.delete(displayName);
      entityRows.push({ root, members, name: displayName, type: [...types][0] ?? "concept", aliases: [...aliases], chunks, embeddingText: [displayName, ...aliases].join(" ") });
    }
    // 实体清洗在 embed 之前（refine-loop 迭代规则）：drop 不写入不 embed；weak 写入实体（可精确匹配）但不建边
    const libGeneric = getLibraryConfig(db).genericEntities ?? [];
    const titlePathOf = (chunkIds) => {
      const q = db.prepare("SELECT title_path AS p FROM chunks WHERE id=?");
      return [...chunkIds].map((cid) => q.get(cid)?.p ?? "").filter(Boolean);
    };
    const entityAction = new Map();
    const keptRows = [];
    for (const row of entityRows) {
      const r = classifyEntity(row.name, { titlePaths: titlePathOf(row.chunks), libraryGenericWords: libGeneric });
      entityAction.set(row.root, r.action);
      if (r.action !== "drop") keptRows.push(row);
    }
    const embeddings = await this.embeddingClient.embed(keptRows.map((row) => row.embeddingText));
    if (embeddings.length !== keptRows.length) throw new Error("entity embedding count mismatch");

    db.transaction(() => {
      db.exec("DELETE FROM relations; DELETE FROM chunk_entities; DELETE FROM entities;");
      const insertEntity = db.prepare("INSERT INTO entities (name, type, aliases_json, embedding) VALUES (?, ?, ?, ?)");
      const insertChunkEntity = db.prepare("INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id) VALUES (?, ?)");
      const entityIds = new Map();
      keptRows.forEach((row, index) => {
        const id = Number(insertEntity.run(row.name, row.type, JSON.stringify(row.aliases), float32Blob(embeddings[index])).lastInsertRowid);
        entityIds.set(row.root, id);
        for (const member of row.members) entityIds.set(member, id);
        for (const chunkId of row.chunks) insertChunkEntity.run(chunkId, id);
      });
      const insertRelation = db.prepare("INSERT INTO relations (source_entity_id, relation, target_entity_id, source_chunk_id) VALUES (?, ?, ?, ?)");
      for (const relation of rawRelations) {
        const sourceId = entityIds.get(find(relation.source));
        const targetId = entityIds.get(find(relation.target));
        // weak 实体不建边（泛化枢纽拆掉），drop 已不在 entityIds
        if (!sourceId || !targetId || sourceId === targetId) continue;
        if (entityAction.get(find(relation.source)) === "weak" || entityAction.get(find(relation.target)) === "weak") continue;
        insertRelation.run(sourceId, relation.predicate, targetId, relation.chunkId);
      }
    })();
  }

  _updateDocumentGraphStatuses(db, documentId) {
    const rows = db.prepare(`SELECT d.id,
      SUM(CASE WHEN c.id IS NOT NULL AND g.status='ok' THEN 1 ELSE 0 END) AS ok_count,
      SUM(CASE WHEN c.id IS NOT NULL AND (g.status IS NULL OR g.status!='ok') THEN 1 ELSE 0 END) AS missing_count
      FROM documents d LEFT JOIN chunks c ON c.document_id=d.id LEFT JOIN graph_extract g ON g.chunk_id=c.id
      WHERE d.status='done' ${documentId == null ? "" : "AND d.id=?"} GROUP BY d.id`).all(...(documentId == null ? [] : [Number(documentId)]));
    const update = db.prepare("UPDATE documents SET graph_status=?, graph_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?");
    db.transaction(() => {
      for (const row of rows) update.run(Number(row.missing_count) ? "failed" : "done", Number(row.missing_count) ? "graph has uncovered chunks" : null, row.id);
    })();
  }
}

function summarizeChunks(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  }).slice(0, GRAPH_CHUNK_LIMIT).map((row) => ({
    id: row.id,
    documentId: row.documentId,
    documentName: row.documentName,
    titlePath: row.titlePath || "",
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    text: String(row.text ?? ""),
    summary: String(row.text ?? "").slice(0, GRAPH_SUMMARY_LENGTH),
  }));
}

function parseEntityRow(row) {
  let aliases = [];
  try { aliases = JSON.parse(row.aliases || "[]"); } catch { aliases = []; }
  return { id: row.id, name: row.name, type: row.type || "concept", aliases: Array.isArray(aliases) ? aliases : [] };
}

export function normalizeEntityName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

export function parseExtraction(value) {
  if (value && typeof value === "object") return validateExtraction(value);
  if (typeof value !== "string") return null;
  try { return validateExtraction(JSON.parse(value)); } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return validateExtraction(JSON.parse(match[0])); } catch { return null; }
  }
}

export function graphStats(db) {
  const entities = Number(db.prepare("SELECT COUNT(*) AS count FROM entities").get().count);
  const relations = Number(db.prepare("SELECT COUNT(*) AS count FROM relations").get().count);
  // 去重连线数：A-B 之间多条关系记录只算一条（与全景图绘制的边数一致）
  let uniqueEdges = relations;
  try {
    uniqueEdges = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT MIN(source_entity_id, target_entity_id) AS s, MAX(source_entity_id, target_entity_id) AS t
        FROM relations
        GROUP BY s, t
      )
    `).get().count);
  } catch { uniqueEdges = relations; }
  const isolatedEntities = Number(db.prepare(`SELECT COUNT(*) AS count FROM entities e WHERE NOT EXISTS (SELECT 1 FROM relations r WHERE r.source_entity_id=e.id OR r.target_entity_id=e.id)`).get().count);
  const uncoveredChunks = Number(db.prepare(`SELECT COUNT(*) AS count FROM chunks c JOIN documents d ON d.id=c.document_id LEFT JOIN graph_extract g ON g.chunk_id=c.id WHERE d.status='done' AND (g.status IS NULL OR g.status!='ok')`).get().count);
  let processingChunks = 0;
  try {
    processingChunks = Number(db.prepare("SELECT COUNT(*) AS count FROM graph_extract WHERE status='processing'").get().count);
  } catch { processingChunks = 0; }
  return {
    entities,
    relations,
    uniqueEdges,
    averageDegree: entities ? (relations * 2) / entities : 0,
    isolatedEntities,
    isolatedRatio: entities ? isolatedEntities / entities : 0,
    processingChunks,
    uncoveredChunks,
  };
}

function validateExtraction(value) {
  if (!value || !Array.isArray(value.entities) || !Array.isArray(value.relations)) return null;
  const entities = value.entities
    .filter((item) => item && String(item.name ?? "").trim())
    .map((item) => ({
      name: cleanEntityName(String(item.name)),
      type: String(item.type ?? "concept").trim() || "concept",
      aliases: Array.isArray(item.aliases) ? item.aliases.map((alias) => String(alias).trim()).filter(Boolean).slice(0, 12) : [],
    }))
    .filter((item) => isMeaningfulEntity(item.name))
    .slice(0, 8);
  const names = new Set(entities.map((item) => normalizeEntityName(item.name)));
  const relations = value.relations.filter((item) => {
    const source = normalizeEntityName(item?.subject);
    const target = normalizeEntityName(item?.object);
    return source && target && names.has(source) && names.has(target) && String(item?.predicate ?? "").trim();
  }).slice(0, 6).map((item) => ({ subject: String(item.subject).trim(), predicate: String(item.predicate).trim(), object: String(item.object).trim() }));
  return { entities, relations };
}

const ENTITY_CONNECTORS = ["及各种", "以及", "等等", "什么的", "比如", "例如", "包括", "还有", "以及各种"];
const ENTITY_CODE_PATTERN = /《|》|NU-|T\/|GB\s|WS\s|Q\/|〔|（\d|[A-Z]{2,}[\/-]\d/i;

// 清洗：去掉外层标点、截断过长的句子式抽取
function cleanEntityName(raw) {
  let name = String(raw).trim().replace(/^["''【\[（(]+|["''】\]）)]+$/g, "");
  name = name.replace(/[。，；：!！?？]+$/, "");
  return name.trim();
}

// 判定是否有意义：过滤 LLM 把日常词/句子片段当实体的噪声
function isMeaningfulEntity(name) {
  if (!name || name.length < 2) return false;
  if (ENTITY_CONNECTORS.some((c) => name.includes(c))) return false;
  // 纯数字、日期、时间、纯标点
  if (/^[\d\s.\-:：年月日时分秒\/号]+$/.test(name)) return false;
  const hasCode = ENTITY_CODE_PATTERN.test(name);
  // 普通实体上限 30 字；含编号/书名号特征的（制度名、标准名）上限 60
  const maxLen = hasCode ? 60 : 30;
  if (name.length > maxLen) return false;
  // 超长且不含编号/书名号特征：多半是把一句话当实体
  if (name.length > 18 && !hasCode) return false;
  return true;
}

function readLlmConfig(dataDir) {
  return getLlmConfig(dataDir);
}

function float32Blob(vector) {
  if (!Array.isArray(vector)) throw new Error("embedding vector must be an array");
  return Buffer.from(new Float32Array(vector).buffer);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
