import fs from "node:fs";
import { EmbeddingClient } from "./core/embedding.js";
import { GraphBuildService } from "./core/graph-build.js";
import { IngestService } from "./core/ingest.js";
import { LibraryManager } from "./core/library-manager.js";
import { SearchService } from "./core/search.js";
import { clearRuntime, setRuntime } from "./core/runtime.js";

export default class HanaKnowledgeBasePlugin {
  async onload() {
    const { dataDir, log } = this.ctx;
    fs.mkdirSync(dataDir, { recursive: true });
    const networkFetch = this.ctx.network?.fetch?.bind(this.ctx.network) ?? globalThis.fetch;
    const manager = new LibraryManager({ dataDir });
    const embeddingClient = new EmbeddingClient({ dataDir, fetchImpl: networkFetch });
    const graphBuilder = new GraphBuildService({ manager, embeddingClient, dataDir, fetchImpl: networkFetch, concurrency: 6 });
    const ingest = new IngestService({ manager, embeddingClient, graphBuilder, concurrency: 8 });
    const search = new SearchService({ manager, embeddingClient });
    const runtime = { dataDir, manager, embeddingClient, graphBuilder, ingest, search, log };
    setRuntime(runtime);
    this.register(async () => {
      await manager.closeAll();
      clearRuntime();
    });
    log?.info?.("[hana-kb] plugin loaded");
  }
}
