// Curated embedding model lists for RAG (remote API providers).

export const DEFAULT_OPENAI_EMBED_MODEL = "text-embedding-3-small";
export const DEFAULT_GEMINI_EMBED_MODEL = "text-embedding-004";
export const DEFAULT_NVIDIA_EMBED_MODEL = "nvidia/nv-embed-v1";
export const DEFAULT_OPENAI_COMPATIBLE_EMBED_MODEL = "text-embedding-3-small";

/** @type {Array<{id:string, label:string}>} */
export const OPENAI_EMBED_MODELS = [
  { id: "text-embedding-3-small", label: "text-embedding-3-small" },
  { id: "text-embedding-3-large", label: "text-embedding-3-large" },
  { id: "text-embedding-ada-002", label: "text-embedding-ada-002" },
];

/** @type {Array<{id:string, label:string}>} */
export const GEMINI_EMBED_MODELS = [
  { id: "text-embedding-004", label: "text-embedding-004" },
  { id: "gemini-embedding-001", label: "gemini-embedding-001" },
];

/** @type {Array<{id:string, label:string}>} */
export const NVIDIA_EMBED_MODELS = [
  { id: "nvidia/nv-embed-v1", label: "NV-Embed-v1" },
  { id: "nvidia/nv-embedqa-e5-v5", label: "NV-EmbedQA E5 v5" },
];

export function listOpenAiEmbedModels() {
  return OPENAI_EMBED_MODELS;
}

export function listGeminiEmbedModels() {
  return GEMINI_EMBED_MODELS;
}

export function listNvidiaEmbedModels() {
  return NVIDIA_EMBED_MODELS;
}
