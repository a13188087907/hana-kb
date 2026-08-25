import fs from "node:fs";
import path from "node:path";

export const DEFAULT_EMBEDDING_CONFIG = Object.freeze({
  baseUrl: "https://api.siliconflow.cn/v1",
  model: "BAAI/bge-m3",
});
export const DEFAULT_LLM_CONFIG = Object.freeze({
  baseUrl: "https://api.siliconflow.cn/v1",
  model: "deepseek-ai/DeepSeek-V3",
});
const MASKED_SHORT_KEY = "********";

export function readPluginConfig(dataDir) {
  const configPath = path.join(dataDir, "config.json");
  try {
    const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config root must be an object");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`plugin config missing or invalid: ${configPath}: ${error.message}`);
  }
}

export function savePluginConfig(dataDir, patch = {}) {
  const current = readPluginConfig(dataDir);
  const next = { ...current };
  for (const name of ["embedding", "llm"]) {
    if (!patch[name] || typeof patch[name] !== "object" || Array.isArray(patch[name])) continue;
    const rawPrevious = current[name] && typeof current[name] === "object" && !Array.isArray(current[name])
      ? current[name]
      : name === "embedding" ? current : {};
    const previous = resolveProviderConfig(current, name);
    const incoming = { ...patch[name] };
    if (Object.hasOwn(incoming, "apiKey") && isMaskedApiKey(incoming.apiKey)) incoming.apiKey = previous.apiKey || "";
    const merged = { ...previous, ...incoming };
    if (name === "llm") merged.sameAsEmbedding = Boolean(merged.sameAsEmbedding);
    validateProviderConfig(merged, name);
    next[name] = compactProviderConfig(merged, name, rawPrevious, incoming);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function getConfigForUi(dataDir) {
  const config = readPluginConfig(dataDir);
  const embedding = resolveProviderConfig(config, "embedding");
  const llm = resolveProviderConfig(config, "llm");
  const llmApiKey = llm.sameAsEmbedding ? embedding.apiKey : llm.apiKey;
  return {
    embedding: publicProviderConfig(embedding),
    llm: { ...publicProviderConfig({ ...llm, apiKey: llmApiKey }), sameAsEmbedding: Boolean(llm.sameAsEmbedding) },
  };
}

export function getEmbeddingConfig(dataDir) {
  const config = readPluginConfig(dataDir);
  const embedding = resolveProviderConfig(config, "embedding");
  validateProviderConfig(embedding, "embedding");
  if (!embedding.apiKey) throw new Error("请先在设置里配置 embedding：缺少 apiKey");
  return embedding;
}

export function getLlmConfig(dataDir) {
  const config = readPluginConfig(dataDir);
  const embedding = resolveProviderConfig(config, "embedding");
  const llm = resolveProviderConfig(config, "llm");
  const rawLlm = config.llm && typeof config.llm === "object" && !Array.isArray(config.llm) ? config.llm : {};
  const rawLlmKey = String(rawLlm.apiKey ?? rawLlm.api_key ?? "").trim();
  const resolved = {
    ...llm,
    apiKey: llm.sameAsEmbedding || !rawLlmKey ? embedding.apiKey : rawLlmKey,
    baseUrl: String(rawLlm.baseUrl ?? rawLlm.base_url ?? embedding.baseUrl).replace(/\/+$/, ""),
  };
  validateProviderConfig(resolved, "llm");
  if (!resolved.apiKey) throw new Error("请先在设置里配置 embedding 或 LLM API key");
  return resolved;
}

export function maskApiKey(value) {
  const key = String(value ?? "");
  if (!key) return "";
  if (key.length <= 8) return MASKED_SHORT_KEY;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function isMaskedApiKey(value) {
  const key = String(value ?? "");
  return key === MASKED_SHORT_KEY || /^.{4}….{4}$/u.test(key);
}

export function validateProviderConfig(config, name) {
  if (config.baseUrl != null && config.baseUrl !== "") {
    let parsed;
    try { parsed = new URL(String(config.baseUrl)); } catch { throw new Error(`${name}.baseUrl must be a valid http(s) URL`); }
    if (!/^https?:$/i.test(parsed.protocol)) throw new Error(`${name}.baseUrl must be a valid http(s) URL`);
  }
  if (config.model != null && !String(config.model).trim()) throw new Error(`${name}.model is required`);
  return true;
}

function resolveProviderConfig(root, name) {
  const source = root[name] && typeof root[name] === "object" && !Array.isArray(root[name])
    ? root[name]
    : name === "embedding" ? root : {};
  const defaults = name === "embedding" ? DEFAULT_EMBEDDING_CONFIG : DEFAULT_LLM_CONFIG;
  return {
    ...defaults,
    ...source,
    apiKey: String(source.apiKey ?? source.api_key ?? "").trim(),
    baseUrl: String(source.baseUrl ?? source.base_url ?? defaults.baseUrl).replace(/\/+$/, ""),
    model: String(source.model ?? defaults.model).trim(),
    ...(name === "llm" ? { sameAsEmbedding: Boolean(source.sameAsEmbedding) } : {}),
  };
}

function publicProviderConfig(config) {
  return {
    apiKey: maskApiKey(config.apiKey),
    apiKeyConfigured: Boolean(config.apiKey),
    configured: Boolean(config.apiKey && config.baseUrl && config.model),
    baseUrl: config.baseUrl,
    model: config.model,
  };
}

function compactProviderConfig(config, name, previous = {}, incoming = {}) {
  const result = {};
  for (const key of ["apiKey", "baseUrl", "model"]) {
    if (Object.hasOwn(previous, key) || Object.hasOwn(incoming, key)) result[key] = config[key];
  }
  if (name === "llm" && (Object.hasOwn(previous, "sameAsEmbedding") || Object.hasOwn(incoming, "sameAsEmbedding"))) {
    result.sameAsEmbedding = Boolean(config.sameAsEmbedding);
  }
  return result;
}
