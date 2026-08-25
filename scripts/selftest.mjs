import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GraphBuildService } from "../core/graph-build.js";
import { getLibraryFeatures, setLibraryFeatures } from "../core/db.js";
import { EmbeddingClient } from "../core/embedding.js";
import { IngestService } from "../core/ingest.js";
import { LibraryManager } from "../core/library-manager.js";
import { SearchService } from "../core/search.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_API_CONFIG = path.resolve(ROOT, "../../2026-08-23-检索对比实验/config.local.json");
const DEFAULT_CORPUS = path.resolve(ROOT, "../../2026-08-23-检索对比实验/corpus");

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: npm run selftest -- --corpus <dir> --api-config <file> --data-dir <dir> --library <id> [--graph] [--bm25]");
  process.exit(0);
}

const corpus = path.resolve(args.corpus ?? DEFAULT_CORPUS);
const apiConfigPath = path.resolve(args["api-config"] ?? DEFAULT_API_CONFIG);
const dataDir = path.resolve(args["data-dir"] ?? path.join(path.dirname(ROOT), ".selftest-data"));
const libraryId = args.library ?? "selftest";
const graphEnabled = args.graph === true || args.graph === "true";
const bm25Enabled = args.bm25 === true || args.bm25 === "true";
if (!fs.existsSync(corpus)) fail(`corpus not found: ${corpus}`);
if (!fs.existsSync(apiConfigPath)) fail(`api config not found: ${apiConfigPath}`);

const apiConfig = JSON.parse(fs.readFileSync(apiConfigPath, "utf8"));
const apiKey = String(apiConfig.siliconflow_key ?? apiConfig.embedding?.apiKey ?? "").trim();
if (!apiKey) fail("siliconflow key not found in api config");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
  embedding: { apiKey, baseUrl: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3" },
  llm: { apiKey, baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
}, null, 2));

let manager = new LibraryManager({ dataDir });
const handle = manager.create(libraryId);
setLibraryFeatures(handle.db, { graphEnabled: false, bm25Enabled });
const embeddingClient = new EmbeddingClient({ dataDir });
const graphBuilder = new GraphBuildService({ manager, embeddingClient, dataDir });
const ingest = new IngestService({ manager, embeddingClient, concurrency: 4 });
const search = new SearchService({ manager, embeddingClient });
const started = Date.now();
const initial = await ingest.ingest(libraryId, [corpus]);
const initialStats = stats(manager, libraryId);
console.log(`INITIAL documents=${initialStats.documents} done=${initialStats.done} failed=${initialStats.failed} chunks=${initialStats.chunks} results=${initial.length} elapsed_ms=${Date.now() - started}`);

const query = "压力测试 trigger 不准怎么办";
const vectorHits = await search.search(libraryId, query, { topK: 15, similarityThreshold: 0.2 });
console.log(`SEARCH_OFF query=${JSON.stringify(query)} hits=${vectorHits.length} sources=${vectorHits.map((hit) => hit.source).join(",")}`);
for (const hit of vectorHits.slice(0, 3)) console.log(`HIT source=${hit.source} similarity=${hit.similarity == null ? "BM25" : hit.similarity.toFixed(4)} document=${hit.documentName} title=${hit.titlePath || ""} offset=${hit.startOffset}-${hit.endOffset}`);

let graphBuild = null;
if (graphEnabled) {
  setLibraryFeatures(manager.open(libraryId).db, { graphEnabled: true });
  graphBuild = await graphBuilder.build(libraryId);
  const graphHits = await search.search(libraryId, query, { topK: 15, similarityThreshold: 0.2 });
  console.log(`GRAPH_BUILD processed=${graphBuild.processed} failed=${graphBuild.failed} stats=${JSON.stringify(graphBuild.stats)}`);
  console.log(`SEARCH_ON hits=${graphHits.length} sources=${graphHits.map((hit) => hit.source).join(",")} vectorMainUnchanged=${sameIds(vectorHits.slice(0, 15), graphHits.filter((hit) => hit.source !== "graph").slice(0, 15))}`);
}

const sample = fs.readdirSync(corpus).filter((name) => name.endsWith(".md")).sort()[0];
const samplePath = path.join(corpus, sample);
const sameHash = await ingest.ingest(libraryId, [samplePath]);
console.log(`SAME_HASH path=${sample} status=${sameHash[0]?.status} chunks=${sameHash[0]?.chunks ?? 0}`);
const deleted = ingest.deleteDocument(libraryId, samplePath);
console.log(`DELETE path=${sample} deleted=${deleted} after=${JSON.stringify(stats(manager, libraryId))}`);
const reingested = await ingest.ingest(libraryId, [samplePath]);
console.log(`REINGEST_SAME_CONTENT_AFTER_DELETE path=${sample} status=${reingested[0]?.status} chunks=${reingested[0]?.chunks ?? 0}`);

const mutationPath = path.join(dataDir, "mutation.md");
fs.copyFileSync(samplePath, mutationPath);
await ingest.ingest(libraryId, [mutationPath]);
fs.appendFileSync(mutationPath, `\n\nM2 mutation marker ${crypto.randomUUID()}`);
const mutated = await ingest.ingest(libraryId, [mutationPath]);
console.log(`REINGEST_CHANGED_CONTENT path=mutation.md status=${mutated[0]?.status} chunks=${mutated[0]?.chunks ?? 0}`);

const interruptPath = path.join(dataDir, "interrupt.md");
fs.copyFileSync(samplePath, interruptPath);
const crashing = new IngestService({ manager, embeddingClient, concurrency: 4, hooks: {
  beforeCommit: async () => { const error = new Error("simulated interruption"); error.simulateCrash = true; throw error; },
} });
try { await crashing.processDocument(libraryId, interruptPath); } catch (error) { console.log(`INTERRUPT simulated=true error=${error.message}`); }
const beforeRestart = manager.open(libraryId).db.prepare("SELECT status FROM documents WHERE path=?").get(path.resolve(interruptPath));
console.log(`INTERRUPT_STATE status=${beforeRestart?.status ?? "missing"}`);
await manager.closeAll();
manager = new LibraryManager({ dataDir });
manager.open(libraryId);
const resumed = new IngestService({ manager, embeddingClient, concurrency: 4 });
const resumedResult = await resumed.resume(libraryId);
console.log(`RESUME results=${JSON.stringify(resumedResult)} stats=${JSON.stringify(stats(manager, libraryId))}`);
console.log(`FEATURES ${JSON.stringify(getLibraryFeatures(manager.open(libraryId).db))}`);
if (graphBuild) console.log(`GRAPH_STATS ${JSON.stringify(graphBuilder.stats(libraryId))}`);
await manager.closeAll();
console.log(`REOPEN_CLOSE ok=true file=${path.join(dataDir, "kb", `${libraryId}.sqlite`)}`);

function stats(currentManager, id) {
  const db = currentManager.open(id).db;
  return {
    documents: db.prepare("SELECT COUNT(*) AS count FROM documents").get().count,
    done: db.prepare("SELECT COUNT(*) AS count FROM documents WHERE status='done'").get().count,
    failed: db.prepare("SELECT COUNT(*) AS count FROM documents WHERE status='failed'").get().count,
    processing: db.prepare("SELECT COUNT(*) AS count FROM documents WHERE status='processing'").get().count,
    pending: db.prepare("SELECT COUNT(*) AS count FROM documents WHERE status='pending'").get().count,
    chunks: db.prepare("SELECT COUNT(*) AS count FROM chunks").get().count,
    vectors: db.prepare("SELECT COUNT(*) AS count FROM vec_index").get().count,
  };
}

function sameIds(left, right) {
  return JSON.stringify(left.map((item) => item.id)) === JSON.stringify(right.map((item) => item.id));
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help") result.help = true;
    else if (item.startsWith("--")) result[item.slice(2)] = argv[index + 1]?.startsWith("--") ? true : argv[++index];
  }
  return result;
}

function fail(message) {
  console.error(`SELFTEST ERROR: ${message}`);
  process.exit(2);
}
