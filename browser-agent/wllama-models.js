/** Curated wllama GGUF registry + tool-gating helpers. */

/** Model id format: `repo::file.gguf` (optional custom HF entries use the same shape). */
export const WLLAMA_MODEL_SEP = "::";

/** @typedef {{ id: string, label: string, repo: string, file: string, approxSizeMB: number, tier: string, contextWindow: number, supportsTools?: boolean, quant?: string }} WllamaRegistryEntry */

/** @type {WllamaRegistryEntry[]} */
export const WLLAMA_MODEL_REGISTRY = [
  {
    id: "bartowski/Llama-3.2-1B-Instruct-GGUF::Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    label: "Llama 3.2 1B Instruct (Q4_K_M)",
    repo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
    file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    approxSizeMB: 800,
    tier: "fast",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "Qwen/Qwen2.5-1.5B-Instruct-GGUF::qwen2.5-1.5b-instruct-q4_k_m.gguf",
    label: "Qwen2.5 1.5B Instruct (Q4_K_M)",
    repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
    file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    approxSizeMB: 1000,
    tier: "default",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "bartowski/Llama-3.2-3B-Instruct-GGUF::Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    label: "Llama 3.2 3B Instruct (Q4_K_M)",
    repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    approxSizeMB: 2000,
    tier: "default",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "Qwen/Qwen2.5-3B-Instruct-GGUF::qwen2.5-3b-instruct-q4_k_m.gguf",
    label: "Qwen2.5 3B Instruct (Q4_K_M)",
    repo: "Qwen/Qwen2.5-3B-Instruct-GGUF",
    file: "qwen2.5-3b-instruct-q4_k_m.gguf",
    approxSizeMB: 2000,
    tier: "max",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  // Qwen3 — latest Qwen series (tool-capable chat templates). Prefer Instruct-2507 when published.
  {
    id: "unsloth/Qwen3-0.6B-GGUF::Qwen3-0.6B-Q4_K_M.gguf",
    label: "Qwen3 0.6B (Q4_K_M)",
    repo: "unsloth/Qwen3-0.6B-GGUF",
    file: "Qwen3-0.6B-Q4_K_M.gguf",
    approxSizeMB: 380,
    tier: "fast",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/Qwen3-1.7B-GGUF::Qwen3-1.7B-Q4_K_M.gguf",
    label: "Qwen3 1.7B (Q4_K_M)",
    repo: "unsloth/Qwen3-1.7B-GGUF",
    file: "Qwen3-1.7B-Q4_K_M.gguf",
    approxSizeMB: 1060,
    tier: "default",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/Qwen3-4B-Instruct-2507-GGUF::Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    label: "Qwen3 4B Instruct 2507 (Q4_K_M)",
    repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    approxSizeMB: 2380,
    tier: "default",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "Qwen/Qwen3-8B-GGUF::Qwen3-8B-Q4_K_M.gguf",
    label: "Qwen3 8B (Q4_K_M)",
    repo: "Qwen/Qwen3-8B-GGUF",
    file: "Qwen3-8B-Q4_K_M.gguf",
    approxSizeMB: 4800,
    tier: "max",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  // Gemma 4 (IT) — ggml-org Q4_0 (llama.cpp / wllama-friendly). Unsloth Q4_K_M mirrors
  // can hit cache/download glitches on multi-GB files from the extension worker.
  {
    id: "ggml-org/gemma-4-E2B-it-GGUF::gemma-4-E2B-it-Q4_0.gguf",
    label: "Gemma 4 E2B Instruct (Q4_0)",
    repo: "ggml-org/gemma-4-E2B-it-GGUF",
    file: "gemma-4-E2B-it-Q4_0.gguf",
    approxSizeMB: 2710,
    tier: "fast",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_0",
  },
  {
    id: "ggml-org/gemma-4-E4B-it-GGUF::gemma-4-E4B-it-Q4_0.gguf",
    label: "Gemma 4 E4B Instruct (Q4_0)",
    repo: "ggml-org/gemma-4-E4B-it-GGUF",
    file: "gemma-4-E4B-it-Q4_0.gguf",
    approxSizeMB: 4380,
    tier: "default",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_0",
  },
  {
    id: "ggml-org/gemma-4-12B-it-GGUF::gemma-4-12B-it-Q4_0.gguf",
    label: "Gemma 4 12B Instruct (Q4_0)",
    repo: "ggml-org/gemma-4-12B-it-GGUF",
    file: "gemma-4-12B-it-Q4_0.gguf",
    approxSizeMB: 6890,
    tier: "max",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_0",
  },
];

export const DEFAULT_WLLAMA_MODEL =
  WLLAMA_MODEL_REGISTRY.find((m) => m.tier === "default" && /Qwen3-1\.7B/i.test(m.id))?.id ||
  WLLAMA_MODEL_REGISTRY.find((m) => m.tier === "default" && /Qwen2\.5-1\.5B/i.test(m.id))?.id ||
  WLLAMA_MODEL_REGISTRY[0].id;

/** Parse `repo::file` or return null for malformed ids. */
export function parseWllamaModelId(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return null;
  const sep = id.indexOf(WLLAMA_MODEL_SEP);
  if (sep <= 0 || sep === id.length - WLLAMA_MODEL_SEP.length) return null;
  const repo = id.slice(0, sep).trim();
  const file = id.slice(sep + WLLAMA_MODEL_SEP.length).trim();
  if (!repo || !file || !/\.gguf$/i.test(file)) return null;
  return { repo, file };
}

export function encodeWllamaModelId(repo, file) {
  return `${String(repo || "").trim()}${WLLAMA_MODEL_SEP}${String(file || "").trim()}`;
}

export function findWllamaRegistryEntry(modelId) {
  return WLLAMA_MODEL_REGISTRY.find((m) => m.id === modelId) || null;
}

/** Curated entry, or a synthetic custom entry when id parses as repo::file. */
export function resolveWllamaModelEntry(modelId) {
  const known = findWllamaRegistryEntry(modelId);
  if (known) return known;
  const parsed = parseWllamaModelId(modelId);
  if (!parsed) return null;
  return {
    id: modelId,
    label: `${parsed.repo} / ${parsed.file}`,
    repo: parsed.repo,
    file: parsed.file,
    approxSizeMB: 0,
    tier: "custom",
    contextWindow: 4096,
    supportsTools: true,
    quant: "",
  };
}

export function isWllamaToolModel(modelId) {
  const entry = resolveWllamaModelEntry(modelId);
  if (!entry) return false;
  return entry.supportsTools !== false;
}

export function formatWllamaPickerLabel(entry = {}) {
  const name = entry.label || entry.id || "model";
  const parts = [];
  if (entry.quant) parts.push(entry.quant);
  if (entry.supportsTools) parts.push("tools");
  parts.push("text→text");
  return `${name} (${parts.join(" · ")})`;
}

export function formatWllamaRegistryMeta(entry = {}, { sizeLabel } = {}) {
  const parts = [];
  if (entry.tier) parts.push(entry.tier);
  if (entry.contextWindow) {
    const ctx =
      entry.contextWindow >= 1000
        ? `${(entry.contextWindow / 1000).toFixed(entry.contextWindow >= 10000 ? 0 : 1)}K ctx`
        : `${entry.contextWindow} ctx`;
    parts.push(ctx);
  }
  if (entry.approxSizeMB != null && entry.approxSizeMB > 0 && sizeLabel) {
    parts.push(sizeLabel(entry.approxSizeMB));
  }
  if (entry.supportsTools) parts.push("tools");
  parts.push("text→text");
  return parts.filter(Boolean).join(" · ");
}
