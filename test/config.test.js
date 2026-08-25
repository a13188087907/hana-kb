import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  getConfigForUi,
  getLlmConfig,
  maskApiKey,
  readPluginConfig,
  savePluginConfig,
} from "../core/config.js";
import { makeTempDir, removeDir } from "./helpers.js";

test("reads and writes embedding and llm settings in dataDir config.json", () => {
  const dataDir = makeTempDir();
  try {
    savePluginConfig(dataDir, {
      embedding: { apiKey: "embed-secret-1234", baseUrl: "https://embed.test/v1", model: "embed-model" },
      llm: { sameAsEmbedding: true, baseUrl: "https://llm.test/v1", model: "llm-model" },
    });
    assert.deepEqual(readPluginConfig(dataDir), {
      embedding: { apiKey: "embed-secret-1234", baseUrl: "https://embed.test/v1", model: "embed-model" },
      llm: { sameAsEmbedding: true, baseUrl: "https://llm.test/v1", model: "llm-model" },
    });
    assert.equal(fs.existsSync(path.join(dataDir, "config.json")), true);
  } finally {
    removeDir(dataDir);
  }
});

test("masks api keys without exposing the secret", () => {
  assert.equal(maskApiKey("abcd-secret-wxyz"), "abcd…wxyz");
  assert.equal(maskApiKey("short"), "********");
  assert.equal(maskApiKey(""), "");
});

test("returns masked settings and preserves the existing key when the masked value is submitted", () => {
  const dataDir = makeTempDir();
  try {
    savePluginConfig(dataDir, {
      embedding: { apiKey: "abcd-secret-wxyz", baseUrl: "https://example.test/v1", model: "embed" },
    });
    const visible = getConfigForUi(dataDir);
    assert.equal(visible.embedding.apiKey, "abcd…wxyz");
    assert.equal(visible.embedding.configured, true);
    savePluginConfig(dataDir, {
      embedding: { apiKey: visible.embedding.apiKey, model: "embed-2" },
    });
    assert.equal(readPluginConfig(dataDir).embedding.apiKey, "abcd-secret-wxyz");
    assert.equal(readPluginConfig(dataDir).embedding.model, "embed-2");
  } finally {
    removeDir(dataDir);
  }
});

test("keeps legacy llm fallback to embedding key and base URL", () => {
  const dataDir = makeTempDir();
  try {
    savePluginConfig(dataDir, { embedding: { apiKey: "embed-secret", baseUrl: "https://embed.test/v1" }, llm: { apiKey: "", model: "llm" } });
    assert.equal(getLlmConfig(dataDir).apiKey, "embed-secret");
    assert.equal(getLlmConfig(dataDir).baseUrl, "https://embed.test/v1");
  } finally {
    removeDir(dataDir);
  }
});

test("rejects an invalid provider base URL", () => {
  const dataDir = makeTempDir();
  try {
    assert.throws(() => savePluginConfig(dataDir, { embedding: { baseUrl: "not-a-url" } }), /baseUrl/);
  } finally {
    removeDir(dataDir);
  }
});
