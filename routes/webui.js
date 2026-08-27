import fs from "node:fs";
import path from "node:path";
import { getConfigForUi, savePluginConfig } from "../core/config.js";
import { collectFiles } from "../core/ingest.js";
import { getRuntime } from "../core/runtime.js";

export default function registerWebuiRoutes(app, ctx) {
  app.get("/webui", (c) => c.html(renderShell(c, ctx)));

  app.get("/api/libraries", (c) => c.json({ ok: true, libraries: getRuntime().manager.list() }));

  app.get("/api/config", (c) => {
    try {
      return c.json({ ok: true, config: getConfigForUi(getRuntime().dataDir) });
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });

  app.put("/api/config", async (c) => {
    try {
      const body = await readJson(c);
      const runtime = getRuntime();
      savePluginConfig(runtime.dataDir, body);
      return c.json({ ok: true, config: getConfigForUi(runtime.dataDir) });
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });

  app.post("/api/libraries", async (c) => {
    try {
      const body = await c.req.json();
      const displayName = String(body?.displayName ?? body?.libraryId ?? "").trim();
      if (!displayName) return c.json({ ok: false, error: "displayName is required" }, 400);
      const runtime = getRuntime();
      const handle = runtime.manager.create(displayName);
      const updated = runtime.manager.updateConfig(handle.libraryId, body);
      return c.json({ ok: true, library: findLibrary(runtime.manager.list(), handle.libraryId), config: updated.config, requiresRebuild: updated.requiresRebuild });
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });

  app.delete("/api/libraries/:libraryId", (c) => {
    try {
      const libraryId = c.req.param("libraryId");
      const deleted = getRuntime().manager.delete(libraryId);
      return c.json({ ok: true, libraryId, deleted });
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });

  app.patch("/api/libraries/:libraryId/config", async (c) => {
    try {
      const body = await c.req.json();
      const runtime = getRuntime();
      const result = runtime.manager.updateConfig(c.req.param("libraryId"), body);
      return c.json({ ok: true, ...result });
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });

  app.get("/api/libraries/:libraryId/documents", (c) => {
    try {
      const result = getRuntime().manager.listDocuments(c.req.param("libraryId"), {
        page: c.req.query("page") || 1,
        pageSize: c.req.query("pageSize") || 25,
      });
      return c.json({ ok: true, ...result });
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });

  app.get("/api/libraries/:libraryId/document-content", (c) => {
    try {
      const { path: filePath } = c.req.query();
      if (!filePath) return c.json({ ok: false, error: "path is required" }, 400);
      const db = getRuntime().manager.open(c.req.param("libraryId")).db;
      const row = db.prepare("SELECT name, normalized_text, status FROM documents WHERE path=?").get(filePath);
      if (!row) return c.json({ ok: false, error: "document not found" }, 404);
      return c.json({ ok: true, name: row.name, content: row.normalized_text || "", status: row.status });
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });

  // 转换预览：不入库，只返回转换后的 markdown（截断防超爆）
  app.post("/api/preview-convert", async (c) => {
    try {
      const body = await readJson(c);
      if (!body?.path) return c.json({ ok: false, error: "path is required" }, 400);
      const { convertToMarkdown, CONVERTIBLE_EXTS } = await import("../core/converter.js");
      const ext = String(body.path).toLowerCase().match(/\.[^.\\/]*$/)?.[0] ?? "";
      if (!CONVERTIBLE_EXTS.has(ext)) return c.json({ ok: false, error: `该格式（${ext || "未知"}）无需预览，md/txt 所见即所得` }, 400);
      const { markdown, warnings } = await convertToMarkdown(body.path);
      const truncated = markdown.length > 20000;
      return c.json({ ok: true, markdown: truncated ? markdown.slice(0, 20000) : markdown, truncated, warnings });
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });

  // 网页入库：同步抓取（成败即时反馈），落盘后后台 embedding
  app.post("/api/libraries/:libraryId/add-url", async (c) => {
    try {
      const body = await readJson(c);
      if (!body?.url) return c.json({ ok: false, error: "url is required" }, 400);
      const runtime = getRuntime();
      const libraryId = c.req.param("libraryId");
      try { runtime.embeddingClient.config(); } catch (error) { return c.json({ ok: false, error: userFacingError(error) }, 400); }
      const { filePath, title } = await runtime.ingest.fetchAndStoreUrl(libraryId, body.url);
      const registered = runtime.ingest.registerMany(libraryId, [filePath], {});
      const job = runtime.ingest.processMany(libraryId, [filePath], {});
      void job.catch((error) => runtime.log?.error?.(`[hana-kb] url ingest failed: ${error.message}`));
      return c.json({ ok: true, title, path: filePath, registered }, 202);
    } catch (error) {
      return c.json({ ok: false, error: userFacingError(error) }, 400);
    }
  });

  const ingestRoute = async (c) => {
    try {
      const body = await readJson(c);
      const libraryId = c.req.param("libraryId");
      const runtime = getRuntime();
      if (!body?.resume && !Array.isArray(body?.paths)) return c.json({ ok: false, error: "paths or resume is required" }, 400);
      const files = body?.resume ? null : collectFiles(body.paths);
      if (files && !files.length) return c.json({ ok: false, error: "未找到可入库的文件（支持 md/txt/docx/doc/xlsx/xls/pptx/ppt/epub/rtf/odt）" }, 400);
      try { runtime.embeddingClient.config(); } catch (error) { return c.json({ ok: false, error: userFacingError(error) }, 400); }
      let registered = null;
      if (files) registered = runtime.ingest.registerMany(libraryId, files, { force: Boolean(body.force) });
      const job = body?.resume
        ? runtime.ingest.resume(libraryId)
        : runtime.ingest.processMany(libraryId, files, { force: Boolean(body.force) });
      void job.catch((error) => runtime.log?.error?.(`[hana-kb] background ingest failed: ${error.message}`));
      return c.json({ ok: true, libraryId, status: "processing", queued: files?.length ?? "pending", registered, documents: runtime.manager.listDocuments(libraryId) }, 202);
    } catch (error) {
      return c.json({ ok: false, error: userFacingError(error) }, 400);
    }
  };
  app.post("/api/libraries/:libraryId/documents/ingest", ingestRoute);
  app.post("/api/libraries/:libraryId/ingest", ingestRoute);

  app.post("/api/libraries/:libraryId/ingest-upload", async (c) => {
    try {
      const libraryId = c.req.param("libraryId");
      const runtime = getRuntime();
      const form = await c.req.formData();
      const files = [];
      for (const value of form.values()) {
        if (value && typeof value === "object" && typeof value.arrayBuffer === "function" && value.name) files.push(value);
      }
      if (!files.length) return c.json({ ok: false, error: "没有收到文件" }, 400);
      const uploadDir = path.join(runtime.dataDir, "uploads", libraryId);
      const saved = [];
      for (const file of files) {
        const rel = String(file.name).replace(/\\/g, "/").replace(/\.\./g, "").replace(/^\/+/, "");
        const target = path.join(uploadDir, rel);
        if (!path.resolve(target).startsWith(path.resolve(uploadDir))) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // 同名覆盖写入：路径稳定，重复上传同内容文件时 hash 相同可被跳过，不再无限增长
        fs.writeFileSync(target, Buffer.from(await file.arrayBuffer()));
        saved.push(target);
      }
      if (!saved.length) return c.json({ ok: false, error: "没有可入库的文件" }, 400);
      try { runtime.embeddingClient.config(); } catch (error) { return c.json({ ok: false, error: userFacingError(error) }, 400); }
      const registered = runtime.ingest.registerMany(libraryId, saved, {});
      const job = runtime.ingest.processMany(libraryId, saved, {});
      void job.catch((error) => runtime.log?.error?.(`[hana-kb] upload ingest failed: ${error.message}`));
      return c.json({ ok: true, libraryId, status: "processing", queued: saved.length, registered }, 202);
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });

  app.post("/api/libraries/:libraryId/rebuild", async (c) => {
    try {
      const body = await readJson(c);
      const runtime = getRuntime();
      const libraryId = c.req.param("libraryId");
      const results = await runtime.ingest.ingest(libraryId, runtime.manager.listDocumentPaths(libraryId), { force: true });
      const graph = body?.graph ? await runtime.graphBuilder.build(libraryId, { retryFailed: body?.retryFailed !== false }) : null;
      const complete = results.every((item) => item.status === "done" || item.status === "skipped") && (!graph || graph.failed === 0);
      if (complete) runtime.manager.markRebuildComplete(libraryId);
      return c.json({ ok: true, libraryId, results, graph, requiresRebuild: !complete });
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });

  app.delete("/api/libraries/:libraryId/documents", async (c) => {
    try {
      const body = await readJson(c);
      const paths = Array.isArray(body?.paths)
        ? body.paths.map((item) => String(item ?? "").trim()).filter(Boolean)
        : [String(body?.path ?? "").trim()].filter(Boolean);
      if (!paths.length) return c.json({ ok: false, error: "path or paths is required" }, 400);
      const deleted = paths.map((filePath) => ({ path: filePath, deleted: getRuntime().ingest.deleteDocument(c.req.param("libraryId"), filePath) }));
      return c.json({ ok: true, paths: deleted, path: deleted[0].path, deleted: deleted.length === 1 ? deleted[0].deleted : deleted.every((item) => item.deleted) });
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });

  app.post("/api/libraries/:libraryId/graph/rebuild", async (c) => {
    try {
      const body = await readJson(c);
      const runtime = getRuntime();
      const libraryId = c.req.param("libraryId");
      const running = runtime.graphBuilder.isRunning?.(libraryId);
      if (running) return c.json({ ok: true, libraryId, status: "running", stats: runtime.graphBuilder.stats(libraryId) });
      const job = runtime.graphBuilder.build(libraryId, { retryFailed: body?.retryFailed !== false });
      void job.catch((error) => runtime.log?.error?.(`[hana-kb] graph build failed: ${error.message}`));
      return c.json({ ok: true, libraryId, status: "processing", stats: runtime.graphBuilder.stats(libraryId) }, 202);
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });

  app.get("/api/libraries/:libraryId/graph-data", (c) => {
    try {
      const data = getRuntime().graphBuilder.localGraph(c.req.param("libraryId"), {
        mode: c.req.query("mode"),
        entity: c.req.query("entity"),
        entityId: c.req.query("entityId"),
      });
      return c.json({ ok: true, ...data });
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });

  app.post("/api/search", async (c) => {
    try {
      const body = await c.req.json();
      const libraryId = String(body?.libraryId ?? "").trim();
      if (!libraryId) return c.json({ ok: false, error: "libraryId is required" }, 400);
      const results = await getRuntime().search.search(libraryId, body?.query, {
        topK: body?.topK,
        similarityThreshold: body?.similarityThreshold,
      });
      return c.json({ ok: true, results });
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 400);
    }
  });
}

async function readJson(c) {
  try { return await c.req.json(); } catch { return {}; }
}

function findLibrary(libraries, libraryId) {
  return libraries.find((library) => library.id === libraryId) ?? null;
}

function userFacingError(error) {
  const message = String(error?.message || error || "请求失败");
  return /embedding|api key|config/i.test(message) ? "请先在设置里配置 embedding" : message;
}

function renderShell(c, ctx) {
  const hanaCss = c.req.query("hana-css") || "";
  const theme = c.req.query("hana-theme") || "inherit";
  const token = c.req.query("token") || "";
  const base = `/api/plugins/${ctx.pluginId}`;
  const auth = token ? `?token=${encodeURIComponent(token)}` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${hanaCss ? `<link rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
  <link rel="stylesheet" href="${base}/assets/panel.css${auth}">
</head>
<body data-hana-theme="${escapeAttr(theme)}">
  <main id="app"><p>正在加载知识库…</p></main>
  <script type="module" src="${base}/assets/panel-logic.js${auth}"></script>
  <script type="module" src="${base}/assets/panel.js${auth}"></script>
</body>
</html>`;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
