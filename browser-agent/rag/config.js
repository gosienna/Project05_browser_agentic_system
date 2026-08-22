// RAG defaults and settings helpers (no worker imports).

import {
  DEFAULT_GEMINI_EMBED_MODEL,
  DEFAULT_NVIDIA_EMBED_MODEL,
  DEFAULT_OPENAI_COMPATIBLE_EMBED_MODEL,
  DEFAULT_OPENAI_EMBED_MODEL,
} from "./embed-models.js";

export const DEFAULT_ONNX_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_WEBLLM_EMBED_MODEL = "snowflake-arctic-embed-s-q0f32-MLC-b4";
export const DEFAULT_OLLAMA_EMBED_MODEL = "nomic-embed-text";
export const EMBED_BATCH_SIZE = 12;
/** Pause between remote embed batches to avoid provider rate limits (e.g. NVIDIA NIM 429). */
export const REMOTE_EMBED_BATCH_DELAY_MS = 1500;

export function embedBatchSizeForProvider(provider) {
  if (provider === "nvidia-nim") return 4;
  if (isRemoteEmbedProvider(provider)) return 8;
  return EMBED_BATCH_SIZE;
}

export const DEFAULT_CHUNK_SIZE = 800;
export const DEFAULT_CHUNK_OVERLAP = 120;

const LOCAL_EMBED_PROVIDERS = new Set(["onnx", "webllm", "ollama"]);
const REMOTE_EMBED_PROVIDERS = new Set(["openai", "gemini", "nvidia-nim", "openai-compatible"]);

function chatProviderForEmbed(settings) {
  const chat = settings?.provider || "onnx";
  if (chat === "anthropic") return "onnx";
  return chat;
}

export function resolveEmbedProvider(settings) {
  const explicit = settings?.ragEmbedProvider;
  if (explicit && explicit !== "auto") return explicit;
  return chatProviderForEmbed(settings);
}

export function resolveEmbedModel(settings, provider) {
  const p = provider || resolveEmbedProvider(settings);
  if (p === "webllm") return settings?.ragWebllmEmbedModel || DEFAULT_WEBLLM_EMBED_MODEL;
  if (p === "ollama") return settings?.ragOllamaEmbedModel || DEFAULT_OLLAMA_EMBED_MODEL;
  if (p === "openai") return settings?.ragOpenaiEmbedModel || DEFAULT_OPENAI_EMBED_MODEL;
  if (p === "gemini") return settings?.ragGeminiEmbedModel || DEFAULT_GEMINI_EMBED_MODEL;
  if (p === "nvidia-nim") return settings?.ragNvidiaEmbedModel || DEFAULT_NVIDIA_EMBED_MODEL;
  if (p === "openai-compatible") {
    return settings?.ragOpenaiCompatibleEmbedModel || DEFAULT_OPENAI_COMPATIBLE_EMBED_MODEL;
  }
  return settings?.ragOnnxEmbedModel || DEFAULT_ONNX_EMBED_MODEL;
}

export function isLocalEmbedProvider(provider) {
  return LOCAL_EMBED_PROVIDERS.has(provider);
}

export function isRemoteEmbedProvider(provider) {
  return REMOTE_EMBED_PROVIDERS.has(provider);
}

export function normalizeEmbedModelId(model) {
  return String(model || "").split(":")[0];
}

export function embedModelsMatch(stored, current) {
  if (!stored || !current) return stored === current;
  if (stored === current) return true;
  return normalizeEmbedModelId(stored) === normalizeEmbedModelId(current);
}

export function embedFingerprint(settings) {
  const provider = resolveEmbedProvider(settings);
  const model = resolveEmbedModel(settings, provider);
  return { embedProvider: provider, embedModel: model };
}

export function chunkSettingsFrom(settings, overrides = {}) {
  return {
    chunkSize: overrides.chunkSize ?? settings?.ragChunkSize ?? DEFAULT_CHUNK_SIZE,
    chunkOverlap: overrides.chunkOverlap ?? settings?.ragChunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
  };
}

export function prefixForEmbed(text, role, modelId) {
  if (!/bge|e5/i.test(modelId || "")) return text;
  return `${role === "query" ? "query: " : "passage: "}${text}`;
}
