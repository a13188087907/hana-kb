import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, removeDir } from "./helpers.js";
import { EmbeddingClient } from "../core/embedding.js";

function response(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; }, async text() { return JSON.stringify(body); } };
}

test("reads embedding settings from plugin dataDir and batches at most 16 inputs", async () => {
  const dataDir = makeTempDir();
  const calls = [];
  try {
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ embedding: {
      apiKey: "test-only-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
    }}));
    const client = new EmbeddingClient({ dataDir, fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      return response({ data: body.input.map((_, index) => ({ index, embedding: [index, 1] })) });
    }});
    const result = await client.embed(Array.from({ length: 17 }, (_, index) => `text-${index}`));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.body.input.length), [16, 1]);
    assert.equal(calls[0].url, "https://example.test/v1/embeddings");
    assert.equal(calls[0].init.headers.Authorization, "Bearer test-only-key");
    assert.equal(result.length, 17);
  } finally {
    removeDir(dataDir);
  }
});

test("retries failed embedding requests three times with injectable backoff", async () => {
  const dataDir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ embedding: { apiKey: "test-only-key" } }));
    let attempts = 0;
    const client = new EmbeddingClient({
      dataDir,
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 4) return response({ error: "temporary" }, false, 503);
        return response({ data: [{ index: 0, embedding: [1, 2] }] });
      },
    });
    assert.deepEqual(await client.embed(["one"]), [[1, 2]]);
    assert.equal(attempts, 4);
  } finally {
    removeDir(dataDir);
  }
});

test("throws after the initial request plus three retries", async () => {
  const dataDir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ embedding: { apiKey: "test-only-key" } }));
    let attempts = 0;
    const client = new EmbeddingClient({
      dataDir,
      retryDelayMs: 0,
      fetchImpl: async () => { attempts += 1; return response({ error: "down" }, false, 500); },
    });
    await assert.rejects(() => client.embed(["one"]), /embedding API 500/);
    assert.equal(attempts, 4);
  } finally {
    removeDir(dataDir);
  }
});
