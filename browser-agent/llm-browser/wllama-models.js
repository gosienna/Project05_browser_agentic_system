/** Curated wllama GGUF registry + tool-gating helpers. */

/** Model id format: `repo::file.gguf` (optional custom HF entries use the same shape). */
export const WLLAMA_MODEL_SEP = "::";

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   repo: string,
 *   file: string,
 *   mmprojFile?: string,
 *   approxSizeMB: number,
 *   tier: string,
 *   contextWindow: number,
 *   supportsTools?: boolean,
 *   supportsVision?: boolean,
 *   supportsAudio?: boolean,
 *   inputs?: string[],
 *   quant?: string,
 * }} WllamaRegistryEntry
 */

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
  {
    id: "Qwen/Qwen3-14B-GGUF::Qwen3-14B-Q4_K_M.gguf",
    label: "Qwen3 14B (Q4_K_M)",
    repo: "Qwen/Qwen3-14B-GGUF",
    file: "Qwen3-14B-Q4_K_M.gguf",
    approxSizeMB: 9000,
    tier: "max",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF::Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf",
    label: "Qwen3 30B-A3B Instruct 2507 (Q4_K_M)",
    repo: "unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF",
    file: "Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf",
    approxSizeMB: 18600,
    tier: "max",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/Qwen3-32B-GGUF::Qwen3-32B-Q4_K_M.gguf",
    label: "Qwen3 32B (Q4_K_M)",
    repo: "unsloth/Qwen3-32B-GGUF",
    file: "Qwen3-32B-Q4_K_M.gguf",
    approxSizeMB: 19800,
    tier: "max",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  // Gemma 4 12B — text GGUF only (no mmproj in ggml-org). E2B/E4B/26B/31B are VLMs below.
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
  // Image + text → text (smallest). Sizes include matching mmproj.
  {
    id: "ggml-org/SmolVLM-256M-Instruct-GGUF::SmolVLM-256M-Instruct-Q8_0.gguf",
    label: "SmolVLM 256M Instruct (Q8_0)",
    repo: "ggml-org/SmolVLM-256M-Instruct-GGUF",
    file: "SmolVLM-256M-Instruct-Q8_0.gguf",
    mmprojFile: "mmproj-SmolVLM-256M-Instruct-Q8_0.gguf",
    approxSizeMB: 280,
    tier: "fast",
    contextWindow: 8192,
    supportsTools: false,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q8_0",
  },
  {
    id: "LiquidAI/LFM2.5-VL-450M-GGUF::LFM2.5-VL-450M-Q4_0.gguf",
    label: "LFM2.5-VL 450M (Q4_0)",
    repo: "LiquidAI/LFM2.5-VL-450M-GGUF",
    file: "LFM2.5-VL-450M-Q4_0.gguf",
    mmprojFile: "mmproj-LFM2.5-VL-450m-Q8_0.gguf",
    approxSizeMB: 320,
    tier: "fast",
    contextWindow: 8192,
    supportsTools: false,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q4_0",
  },
  {
    id: "ggml-org/SmolVLM-500M-Instruct-GGUF::SmolVLM-500M-Instruct-Q8_0.gguf",
    label: "SmolVLM 500M Instruct (Q8_0)",
    repo: "ggml-org/SmolVLM-500M-Instruct-GGUF",
    file: "SmolVLM-500M-Instruct-Q8_0.gguf",
    mmprojFile: "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf",
    approxSizeMB: 550,
    tier: "fast",
    contextWindow: 8192,
    supportsTools: false,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q8_0",
  },
  {
    id: "ggml-org/InternVL3-1B-Instruct-GGUF::InternVL3-1B-Instruct-Q8_0.gguf",
    label: "InternVL3 1B Instruct (Q8_0)",
    repo: "ggml-org/InternVL3-1B-Instruct-GGUF",
    file: "InternVL3-1B-Instruct-Q8_0.gguf",
    mmprojFile: "mmproj-InternVL3-1B-Instruct-Q8_0.gguf",
    approxSizeMB: 1010,
    tier: "default",
    contextWindow: 8192,
    supportsTools: false,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q8_0",
  },
  {
    id: "ggml-org/InternVL3-8B-Instruct-GGUF::InternVL3-8B-Instruct-Q4_K_M.gguf",
    label: "InternVL3 8B Instruct (Q4_K_M)",
    repo: "ggml-org/InternVL3-8B-Instruct-GGUF",
    file: "InternVL3-8B-Instruct-Q4_K_M.gguf",
    mmprojFile: "mmproj-InternVL3-8B-Instruct-Q8_0.gguf",
    approxSizeMB: 5040,
    tier: "max",
    contextWindow: 8192,
    supportsTools: false,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q4_K_M",
  },
  // Stronger VLMs — still browser-possible with WebGPU. Gemma 4 E2B/E4B also take audio.
  {
    id: "ggml-org/Qwen2-VL-2B-Instruct-GGUF::Qwen2-VL-2B-Instruct-Q4_K_M.gguf",
    label: "Qwen2-VL 2B Instruct (Q4_K_M)",
    repo: "ggml-org/Qwen2-VL-2B-Instruct-GGUF",
    file: "Qwen2-VL-2B-Instruct-Q4_K_M.gguf",
    mmprojFile: "mmproj-Qwen2-VL-2B-Instruct-Q8_0.gguf",
    approxSizeMB: 1700,
    tier: "default",
    contextWindow: 8192,
    supportsTools: true,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q4_K_M",
  },
  {
    id: "ggml-org/Qwen2.5-VL-3B-Instruct-GGUF::Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
    label: "Qwen2.5-VL 3B Instruct (Q4_K_M)",
    repo: "ggml-org/Qwen2.5-VL-3B-Instruct-GGUF",
    file: "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
    mmprojFile: "mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf",
    approxSizeMB: 2770,
    tier: "default",
    contextWindow: 8192,
    supportsTools: true,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q4_K_M",
  },
  {
    id: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF::Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf",
    label: "Qwen2.5-VL 7B Instruct (Q4_K_M)",
    repo: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
    file: "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf",
    mmprojFile: "mmproj-Qwen2.5-VL-7B-Instruct-Q8_0.gguf",
    approxSizeMB: 5540,
    tier: "max",
    contextWindow: 8192,
    supportsTools: true,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q4_K_M",
  },
  {
    id: "ggml-org/gemma-4-E2B-it-GGUF::gemma-4-E2B-it-Q4_0.gguf",
    label: "Gemma 4 E2B Instruct (Q4_0)",
    repo: "ggml-org/gemma-4-E2B-it-GGUF",
    file: "gemma-4-E2B-it-Q4_0.gguf",
    mmprojFile: "mmproj-gemma-4-E2B-it-Q8_0.gguf",
    approxSizeMB: 3400,
    tier: "fast",
    contextWindow: 8192,
    supportsTools: true,
    supportsVision: true,
    supportsAudio: true,
    inputs: ["text", "image", "audio"],
    quant: "Q4_0",
  },
  {
    id: "mradermacher/Holo2-4B-GGUF::Holo2-4B.Q4_K_M.gguf",
    label: "Holo2 4B (Q4_K_M)",
    repo: "mradermacher/Holo2-4B-GGUF",
    file: "Holo2-4B.Q4_K_M.gguf",
    mmprojFile: "Holo2-4B.mmproj-Q8_0.gguf",
    approxSizeMB: 3400,
    tier: "default",
    contextWindow: 8192,
    supportsTools: true,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q4_K_M",
  },
  {
    id: "ggml-org/moondream2-20250414-GGUF::moondream2-text-model-f16_ct-vicuna.gguf",
    label: "Moondream2 (F16)",
    repo: "ggml-org/moondream2-20250414-GGUF",
    file: "moondream2-text-model-f16_ct-vicuna.gguf",
    mmprojFile: "moondream2-mmproj-f16-20250414.gguf",
    approxSizeMB: 3750,
    tier: "default",
    contextWindow: 8192,
    supportsTools: false,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "F16",
  },
  {
    id: "ggml-org/gemma-4-E4B-it-GGUF::gemma-4-E4B-it-Q4_0.gguf",
    label: "Gemma 4 E4B Instruct (Q4_0)",
    repo: "ggml-org/gemma-4-E4B-it-GGUF",
    file: "gemma-4-E4B-it-Q4_0.gguf",
    mmprojFile: "mmproj-gemma-4-E4B-it-Q8_0.gguf",
    approxSizeMB: 5150,
    tier: "default",
    contextWindow: 8192,
    supportsTools: true,
    supportsVision: true,
    supportsAudio: true,
    inputs: ["text", "image", "audio"],
    quant: "Q4_0",
  },
  {
    id: "ggml-org/gemma-4-26B-A4B-it-GGUF::gemma-4-26B-A4B-it-Q4_0.gguf",
    label: "Gemma 4 26B-A4B Instruct (Q4_0)",
    repo: "ggml-org/gemma-4-26B-A4B-it-GGUF",
    file: "gemma-4-26B-A4B-it-Q4_0.gguf",
    mmprojFile: "mmproj-gemma-4-26B-A4B-it-Q8_0.gguf",
    approxSizeMB: 15420,
    tier: "max",
    contextWindow: 8192,
    supportsTools: true,
    supportsVision: true,
    supportsAudio: true,
    inputs: ["text", "image", "audio"],
    quant: "Q4_0",
  },
  {
    id: "ggml-org/gemma-4-31B-it-GGUF::gemma-4-31B-it-Q4_0.gguf",
    label: "Gemma 4 31B Instruct (Q4_0)",
    repo: "ggml-org/gemma-4-31B-it-GGUF",
    file: "gemma-4-31B-it-Q4_0.gguf",
    mmprojFile: "mmproj-gemma-4-31B-it-Q8_0.gguf",
    approxSizeMB: 18800,
    tier: "max",
    contextWindow: 8192,
    supportsTools: true,
    supportsVision: true,
    supportsAudio: true,
    inputs: ["text", "image", "audio"],
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

export function isWllamaVisionModel(modelId) {
  const entry = typeof modelId === "object" && modelId ? modelId : resolveWllamaModelEntry(modelId);
  return Boolean(entry?.mmprojFile || entry?.supportsVision);
}

/** Human-readable input → output summary. */
export function formatWllamaIoLabel(entry = {}) {
  const inputs =
    Array.isArray(entry.inputs) && entry.inputs.length
      ? entry.inputs
      : isWllamaVisionModel(entry)
        ? entry.supportsAudio
          ? ["text", "image", "audio"]
          : ["text", "image"]
        : ["text"];
  return `${inputs.join("+")}→text`;
}

export function formatWllamaPickerLabel(entry = {}) {
  const name = entry.label || entry.id || "model";
  const parts = [];
  if (entry.quant) parts.push(entry.quant);
  if (entry.supportsTools) parts.push("tools");
  parts.push(formatWllamaIoLabel(entry));
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
  parts.push(formatWllamaIoLabel(entry));
  return parts.filter(Boolean).join(" · ");
}
