import { getEmbeddingConfig } from "./config.js";

export class EmbeddingClient {
  constructor({ dataDir, fetchImpl = globalThis.fetch, retryDelayMs = 250, maxRetries = 3, sleep = delay, maxConcurrent = 8 } = {}) {
    this.dataDir = dataDir;
    this.fetchImpl = fetchImpl;
    this.retryDelayMs = retryDelayMs;
    this.maxRetries = maxRetries;
    this.sleep = sleep;
    this.maxConcurrent = maxConcurrent;
    this.queue = [];
    this.active = 0;
    this.cachedConfig = null;
  }

  config() {
    return getEmbeddingConfig(this.dataDir);
  }

  userFacingNetworkError(error) {
    const message = String(error?.message || error || "");
    if (message.includes("not declared in manifest")) {
      const host = message.match(/host "([^"]+)"/)?.[1] || "该服务商";
      return `当前配置的服务商（${host}）不在插件网络白名单内，请换成白名单内的服务商（硅基流动、DeepSeek、智谱、OpenAI 或本地 Ollama）`;
    }
    if (message.includes("fetch failed") || message.includes("ENOTFOUND")) {
      return "无法连接到 embedding 服务，请检查网络和 Base URL 配置";
    }
    return message;
  }

  async embed(texts) {
    if (!Array.isArray(texts)) throw new TypeError("embedding input must be an array");
    if (texts.length === 0) return [];
    const config = this.config();
    // 切成批，进入全局并发队列（跨文档合批，最多 maxConcurrent 个请求在飞）
    const jobs = [];
    for (let offset = 0; offset < texts.length; offset += 16) {
      jobs.push(this.enqueue(texts.slice(offset, offset + 16), config));
    }
    return (await Promise.all(jobs)).flat();
  }

  enqueue(batch, config) {
    return new Promise((resolve, reject) => {
      this.queue.push({ batch, config, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      this.requestBatch(job.batch, job.config)
        .then(job.resolve, job.reject)
        .finally(() => { this.active -= 1; this.pump(); });
    }
  }

  async requestBatch(input, config) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${config.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: config.model, input }),
        });
        if (!response.ok) {
          throw new Error(`embedding API ${response.status}: ${(await response.text()).slice(0, 300)}`);
        }
        const payload = await response.json();
        if (!Array.isArray(payload.data) || payload.data.length !== input.length) {
          throw new Error("embedding API returned an unexpected vector count");
        }
        return payload.data
          .slice()
          .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
          .map((item) => item.embedding);
      } catch (error) {
        lastError = error;
        if (attempt === this.maxRetries) break;
        await this.sleep(this.retryDelayMs * (2 ** attempt));
      }
    }
    throw this.userFacingNetworkError(lastError);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
