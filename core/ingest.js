import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chunkText } from "./chunker.js";
import { CONVERTIBLE_EXTS } from "./converter.js";
import { getLibraryConfig, getLibraryFeatures } from "./db.js";
import { parseFile } from "./parser.js";
import { fetchUrlToMarkdown } from "./web-fetch.js";

const SUPPORTED = new Set([".md", ".markdown", ".txt", ...CONVERTIBLE_EXTS]);

export class IngestService {
  constructor({ manager, embeddingClient, graphBuilder, concurrency = 4, chunkOptions = {}, hooks = {} }) {
    this.manager = manager;
    this.embeddingClient = embeddingClient;
    this.graphBuilder = graphBuilder;
    this.concurrency = Math.max(1, Number(concurrency) || 4);
    this.chunkOptions = chunkOptions;
    this.hooks = hooks;
  }

  async ingest(libraryId, inputs, options = {}) {
    const files = collectFiles(inputs);
    return this.processMany(libraryId, files, options);
  }

  // 先登记全部文件（即时出现在文档列表，状态 pending），再后台逐个处理
  async registerMany(libraryId, files, options = {}) {
    const db = this.manager.open(libraryId).db;
    const registered = [];
    for (const input of files) {
      const filePath = path.resolve(input);
      try {
        const buffer = fs.readFileSync(filePath);
        const stat = fs.statSync(filePath);
        const contentHash = sha256(buffer);
        const name = path.basename(filePath);
        const row = db.prepare("SELECT * FROM documents WHERE path=?").get(filePath);
        if (!options.force && row?.content_hash === contentHash && row.status === "done") {
          registered.push({ path: filePath, status: "skipped", chunks: row.chunk_count });
          continue;
        }
        if (row) {
          db.prepare(`
            UPDATE documents
            SET name=?, content_hash=?, size=?, status='pending', error_message=NULL,
                graph_status='pending', graph_error=NULL, updated_at=CURRENT_TIMESTAMP
            WHERE id=?
          `).run(name, contentHash, stat.size, row.id);
        } else {
          db.prepare(`
            INSERT INTO documents (path, name, content_hash, size, status, error_message, graph_status)
            VALUES (?, ?, ?, ?, 'pending', NULL, 'pending')
          `).run(filePath, name, contentHash, stat.size);
        }
        registered.push({ path: filePath, status: "pending" });
      } catch (error) {
        registered.push({ path: filePath, status: "failed", error: error.message });
      }
    }
    return registered;
  }

  async reingest(libraryId, inputPath) {
    return this.processMany(libraryId, [inputPath], { force: true });
  }

  // 网页抓取并落盘为 md 文件（frontmatter 记录来源 URL，供溯源与去重）。
  // 同步返回抓取成败；后续入库走 registerMany/processMany 现有管道。
  async fetchAndStoreUrl(libraryId, url) {
    const { markdown, title, url: finalUrl } = await fetchUrlToMarkdown(url);
    const dir = path.join(this.manager.dataDir, "web-pages", libraryId);
    fs.mkdirSync(dir, { recursive: true });
    const hash = crypto.createHash("sha256").update(finalUrl).digest("hex").slice(0, 8);
    const slug = title.replace(/[\\/:*?"<>|\r\n]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || "page";
    const filePath = path.join(dir, `${slug}-${hash}.md`);
    fs.writeFileSync(filePath, markdown, "utf8");
    return { filePath, title, url: finalUrl };
  }

  // 工具层一站式：抓取 → 落盘 → 入库（等待完成）
  async ingestUrl(libraryId, url, options = {}) {
    const { filePath, title, url: finalUrl } = await this.fetchAndStoreUrl(libraryId, url);
    const results = await this.processMany(libraryId, [filePath], options);
    return { title, url: finalUrl, ...results[0] };
  }

  async resume(libraryId) {
    const db = this.manager.open(libraryId).db;
    const rows = db.prepare("SELECT path FROM documents WHERE status='pending' ORDER BY id").all();
    return this.processMany(libraryId, rows.map((row) => row.path).filter((filePath) => fs.existsSync(filePath)));
  }

  async processMany(libraryId, files, options = {}) {
    const results = new Array(files.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= files.length) return;
        results[index] = await this.processDocument(libraryId, files[index], options);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, files.length) }, worker));
    return results;
  }

  async processDocument(libraryId, inputPath, { force = false } = {}) {
    const filePath = path.resolve(inputPath);
    const db = this.manager.open(libraryId).db;
    let row;
    let contentHash;
    let size;
    try {
      const buffer = fs.readFileSync(filePath);
      const stat = fs.statSync(filePath);
      contentHash = sha256(buffer);
      size = stat.size;
      row = db.prepare("SELECT * FROM documents WHERE path=?").get(filePath);
    } catch (error) {
      return { path: filePath, status: "failed", error: error.message };
    }

    if (!force && row?.content_hash === contentHash && row.status === "done") {
      return { path: filePath, status: "skipped", chunks: row.chunk_count };
    }

    const name = path.basename(filePath);
    if (!row) {
      const result = db.prepare(`
        INSERT INTO documents (path, name, content_hash, size, status, error_message, graph_status)
        VALUES (?, ?, ?, ?, 'pending', NULL, 'pending')
      `).run(filePath, name, contentHash, size);
      row = { id: Number(result.lastInsertRowid) };
    } else {
      db.prepare(`
        UPDATE documents
        SET name=?, content_hash=?, size=?, normalized_text='', status='pending', error_message=NULL,
            graph_status='pending', graph_error=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(name, contentHash, size, row.id);
    }
    db.prepare("UPDATE documents SET status='processing', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);

    try {
      const parsed = await parseFile(filePath);
      if (!parsed.text.trim()) {
        throw new Error(parsed.warnings?.[0] ?? "文件无正文内容");
      }
      const libraryConfig = getLibraryConfig(db);
      const chunks = chunkText(parsed, {
        ...this.chunkOptions,
        target: libraryConfig.chunkTargetLength,
        hardStep: Math.max(1, libraryConfig.chunkTargetLength - libraryConfig.chunkOverlap),
      });
      const vectors = await this.embeddingClient.embed(chunks.map((chunk) => chunk.text));
      if (vectors.length !== chunks.length) throw new Error(`embedding count mismatch: ${vectors.length} != ${chunks.length}`);
      await this.hooks.beforeCommit?.({ libraryId, filePath, documentId: row.id, chunks, vectors });

      const write = db.transaction(() => {
        deleteDocumentArtifacts(db, row.id);
        const insertChunk = db.prepare(`
          INSERT INTO chunks (document_id, ordinal, text, title_path, start_offset, end_offset)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        const insertVector = db.prepare("INSERT INTO vec_index (chunk_id, embedding) VALUES (?, ?)");
        const insertFts = db.prepare("INSERT INTO fts_chunks (rowid, content, chunk_id) VALUES (?, ?, ?)");
        chunks.forEach((chunk, index) => {
          const inserted = insertChunk.run(row.id, index, chunk.text, chunk.titlePath, chunk.startOffset, chunk.endOffset);
          const chunkId = Number(inserted.lastInsertRowid);
          insertVector.run(chunkId, float32Blob(vectors[index]));
          insertFts.run(chunkId, chunk.text, chunkId);
        });
        db.prepare(`
          UPDATE documents
          SET normalized_text=?, status='done', error_message=NULL, chunk_count=?, graph_status=?, graph_error=NULL, updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(parsed.text, chunks.length, getLibraryFeatures(db).graphEnabled ? "pending" : "done", row.id);
      });
      write();

      if (getLibraryFeatures(db).graphEnabled && this.graphBuilder) {
        // 不阻塞入库：图谱由后台串行队列独立处理，文件状态已就绪
        void this.graphBuilder.buildDocument(libraryId, row.id).catch((error) => {
          try {
            db.prepare("UPDATE documents SET graph_status='failed', graph_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
              .run(String(error?.stack || error?.message || error).slice(0, 1000), row.id);
          } catch { /* db 可能已关 */ }
        });
      }
      return { path: filePath, status: "done", chunks: chunks.length };
    } catch (error) {
      if (error?.simulateCrash) throw error;
      db.prepare("UPDATE documents SET status='failed', error_message=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(String(error?.stack || error?.message || error), row.id);
      return { path: filePath, status: "failed", error: error.message };
    }
  }

  deleteDocument(libraryId, inputPath) {
    const filePath = path.resolve(inputPath);
    const db = this.manager.open(libraryId).db;
    const row = db.prepare("SELECT id FROM documents WHERE path=?").get(filePath);
    if (!row) return false;
    db.transaction(() => {
      deleteDocumentArtifacts(db, row.id);
      db.prepare("DELETE FROM documents WHERE id=?").run(row.id);
      db.prepare("DELETE FROM entities WHERE NOT EXISTS (SELECT 1 FROM chunk_entities ce WHERE ce.entity_id=entities.id) AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.source_entity_id=entities.id OR r.target_entity_id=entities.id)").run();
    })();
    return true;
  }
}

function deleteDocumentArtifacts(db, documentId) {
  db.prepare("DELETE FROM relations WHERE source_chunk_id IN (SELECT id FROM chunks WHERE document_id=?)").run(documentId);
  db.prepare("DELETE FROM chunk_entities WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id=?)").run(documentId);
  db.prepare("DELETE FROM vec_index WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id=?)").run(documentId);
  db.prepare("DELETE FROM fts_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id=?)").run(documentId);
  db.prepare("DELETE FROM chunks WHERE document_id=?").run(documentId);
  db.prepare("DELETE FROM entities WHERE NOT EXISTS (SELECT 1 FROM chunk_entities ce WHERE ce.entity_id=entities.id) AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.source_entity_id=entities.id OR r.target_entity_id=entities.id)").run();
}

// 敏感路径黑名单：防提示注入把凭据文件入库存外传
const SENSITIVE_NAME = /\.env|id_rsa|id_ed25519|credential|password|passwd|secret|private[_-]?key|access[_-]?token|keychain|wallet|钥匙串|密码|口令|密钥|凭据/i;
const SENSITIVE_DIR = /\\.ssh(\\|$)|\\.gnupg(\\|$)|Credentials(\\|$)|\\.aws(\\|$)|\\.kube(\\|$)/i;

function isSensitivePath(filePath) {
  if (SENSITIVE_NAME.test(path.basename(filePath))) return true;
  if (SENSITIVE_DIR.test(filePath)) return true;
  return false;
}

export function collectFiles(inputs) {
  const files = new Set();
  for (const input of inputs ?? []) {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) throw new Error(`input not found: ${input}`);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) walk(resolved, files);
    else if (stat.isFile() && SUPPORTED.has(path.extname(resolved).toLowerCase())) files.add(resolved);
  }
  return [...files].filter((file) => !isSensitivePath(file)).sort();
}

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(child, files);
    else if (entry.isFile() && SUPPORTED.has(path.extname(child).toLowerCase())) files.add(path.resolve(child));
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function float32Blob(vector) {
  if (!Array.isArray(vector)) throw new Error("embedding vector must be an array");
  return Buffer.from(new Float32Array(vector).buffer);
}
