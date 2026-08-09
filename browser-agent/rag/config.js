// RAG defaults and settings helpers (no worker imports).

export const DEFAULT_ONNX_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_WEBLLM_EMBED_MODEL = "snowflake-arctic-embed-s-q0f32-MLC-b4";
export const DEFAULT_OLLAMA_EMBED_MODEL = "nomic-embed-text";
export const EMBED_BATCH_SIZE = 12;

export const DEFAULT_CHUNK_SIZE = 800;
export const DEFAULT_CHUNK_OVERLAP = 120;

export function resolveEmbedProvider(settings) {
  const explicit = settings?.ragEmbedProvider;
  if (explicit && explicit !== "auto") return explicit;
  const chat = settings?.provider || "onnx";
  if (chat === "onnx" || chat === "webllm" || chat === "ollama") return chat;
  return "onnx";
}

export function resolveEmbedModel(settings, provider) {
  const p = provider || resolveEmbedProvider(settings);
  if (p === "webllm") return settings?.ragWebllmEmbedModel || DEFAULT_WEBLLM_EMBED_MODEL;
  if (p === "ollama") return settings?.ragOllamaEmbedModel || DEFAULT_OLLAMA_EMBED_MODEL;
  return settings?.ragOnnxEmbedModel || DEFAULT_ONNX_EMBED_MODEL;
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
