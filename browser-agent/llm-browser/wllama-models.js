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
 *   contextWindow: number, // native / designed max tokens (not runtime n_ctx)
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
    contextWindow: 131072,
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
    contextWindow: 32768,
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
    contextWindow: 131072,
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
    contextWindow: 32768,
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
    contextWindow: 32768,
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
    contextWindow: 32768,
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
    contextWindow: 262144,
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
    contextWindow: 32768,
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
    contextWindow: 32768,
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
    contextWindow: 262144,
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
    contextWindow: 32768,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  // Qwen3.8 — dense 27B (coding / agents). Prefer Q8 on high-RAM Macs.
  {
    id: "ggml-org/Qwen3.8-27B-GGUF::Qwen3.8-27B-Q4_K_M.gguf",
    label: "Qwen3.8 27B (Q4_K_M)",
    repo: "ggml-org/Qwen3.8-27B-GGUF",
    file: "Qwen3.8-27B-Q4_K_M.gguf",
    approxSizeMB: 19000,
    tier: "max",
    contextWindow: 262144,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "ggml-org/Qwen3.8-27B-GGUF::Qwen3.8-27B-Q8_0.gguf",
    label: "Qwen3.8 27B (Q8_0)",
    repo: "ggml-org/Qwen3.8-27B-GGUF",
    file: "Qwen3.8-27B-Q8_0.gguf",
    approxSizeMB: 28600,
    tier: "max",
    contextWindow: 262144,
    supportsTools: true,
    quant: "Q8_0",
  },
  // Qwen3.5-122B-A10B MoE — workstation-scale (sharded). Q8 (~130GB) exceeds 128GB unified memory.
  {
    id: "unsloth/Qwen3.5-122B-A10B-GGUF::Q4_K_M/Qwen3.5-122B-A10B-Q4_K_M-00001-of-00003.gguf",
    label: "Qwen3.5 122B-A10B (Q4_K_M)",
    repo: "unsloth/Qwen3.5-122B-A10B-GGUF",
    file: "Q4_K_M/Qwen3.5-122B-A10B-Q4_K_M-00001-of-00003.gguf",
    approxSizeMB: 76500,
    tier: "max",
    contextWindow: 262144,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/Qwen3.5-122B-A10B-GGUF::Q5_K_M/Qwen3.5-122B-A10B-Q5_K_M-00001-of-00003.gguf",
    label: "Qwen3.5 122B-A10B (Q5_K_M)",
    repo: "unsloth/Qwen3.5-122B-A10B-GGUF",
    file: "Q5_K_M/Qwen3.5-122B-A10B-Q5_K_M-00001-of-00003.gguf",
    approxSizeMB: 91500,
    tier: "max",
    contextWindow: 262144,
    supportsTools: true,
    quant: "Q5_K_M",
  },
  // GLM-4.x — text GGUFs under ~30GB (Q4_K_M). Needs llama.cpp with glm4 / glm4moe support.
  {
    id: "unsloth/GLM-4.7-Flash-GGUF::GLM-4.7-Flash-Q4_K_M.gguf",
    label: "GLM-4.7-Flash (Q4_K_M)",
    repo: "unsloth/GLM-4.7-Flash-GGUF",
    file: "GLM-4.7-Flash-Q4_K_M.gguf",
    approxSizeMB: 18300,
    tier: "max",
    contextWindow: 202752,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/GLM-4-32B-0414-GGUF::GLM-4-32B-0414-Q4_K_M.gguf",
    label: "GLM-4-32B-0414 (Q4_K_M)",
    repo: "unsloth/GLM-4-32B-0414-GGUF",
    file: "GLM-4-32B-0414-Q4_K_M.gguf",
    approxSizeMB: 19700,
    tier: "max",
    contextWindow: 32768,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  // OpenAI gpt-oss — MoE with native MXFP4 experts. Needs llama.cpp gpt-oss support.
  {
    id: "unsloth/gpt-oss-20b-GGUF::gpt-oss-20b-Q4_K_M.gguf",
    label: "gpt-oss-20b (Q4_K_M)",
    repo: "unsloth/gpt-oss-20b-GGUF",
    file: "gpt-oss-20b-Q4_K_M.gguf",
    approxSizeMB: 11600,
    tier: "max",
    contextWindow: 131072,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/gpt-oss-120b-GGUF::Q4_K_M/gpt-oss-120b-Q4_K_M-00001-of-00002.gguf",
    label: "gpt-oss-120b (Q4_K_M)",
    repo: "unsloth/gpt-oss-120b-GGUF",
    file: "Q4_K_M/gpt-oss-120b-Q4_K_M-00001-of-00002.gguf",
    approxSizeMB: 62800,
    tier: "max",
    contextWindow: 131072,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/gpt-oss-120b-GGUF::Q8_0/gpt-oss-120b-Q8_0-00001-of-00002.gguf",
    label: "gpt-oss-120b (Q8_0)",
    repo: "unsloth/gpt-oss-120b-GGUF",
    file: "Q8_0/gpt-oss-120b-Q8_0-00001-of-00002.gguf",
    approxSizeMB: 63400,
    tier: "max",
    contextWindow: 131072,
    supportsTools: true,
    quant: "Q8_0",
  },
  // Moonshot Moonlight — 16B-A3B MoE (Kimi-family precursor). Needs deepseek2/MLA MoE support.
  {
    id: "gabriellarson/Moonlight-16B-A3B-Instruct-GGUF::Moonlight-16B-A3B-Instruct-Q4_K_M.gguf",
    label: "Moonlight-16B-A3B Instruct (Q4_K_M)",
    repo: "gabriellarson/Moonlight-16B-A3B-Instruct-GGUF",
    file: "Moonlight-16B-A3B-Instruct-Q4_K_M.gguf",
    approxSizeMB: 10500,
    tier: "max",
    contextWindow: 8192,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  // NVIDIA Nemotron-3 Nano — hybrid Mamba-MoE. Needs llama.cpp nemotron_h / nemotron_h_moe.
  {
    id: "unsloth/NVIDIA-Nemotron-3-Nano-4B-GGUF::NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf",
    label: "Nemotron-3-Nano-4B (Q4_K_M)",
    repo: "unsloth/NVIDIA-Nemotron-3-Nano-4B-GGUF",
    file: "NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf",
    approxSizeMB: 2900,
    tier: "default",
    contextWindow: 262144,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/Nemotron-3-Nano-30B-A3B-GGUF::Nemotron-3-Nano-30B-A3B-Q4_K_M.gguf",
    label: "Nemotron-3-Nano-30B-A3B (Q4_K_M)",
    repo: "unsloth/Nemotron-3-Nano-30B-A3B-GGUF",
    file: "Nemotron-3-Nano-30B-A3B-Q4_K_M.gguf",
    approxSizeMB: 24600,
    tier: "max",
    contextWindow: 262144,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  // 30–50 GB tier — workstation / high-RAM local GGUFs (Q4–Q8).
  {
    id: "bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF::moonshotai_Kimi-Linear-48B-A3B-Instruct-Q4_K_M.gguf",
    label: "Kimi-Linear-48B-A3B Instruct (Q4_K_M)",
    repo: "bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF",
    file: "moonshotai_Kimi-Linear-48B-A3B-Instruct-Q4_K_M.gguf",
    approxSizeMB: 30100,
    tier: "max",
    contextWindow: 1048576,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF::moonshotai_Kimi-Linear-48B-A3B-Instruct-Q5_K_M.gguf",
    label: "Kimi-Linear-48B-A3B Instruct (Q5_K_M)",
    repo: "bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF",
    file: "moonshotai_Kimi-Linear-48B-A3B-Instruct-Q5_K_M.gguf",
    approxSizeMB: 35100,
    tier: "max",
    contextWindow: 1048576,
    supportsTools: true,
    quant: "Q5_K_M",
  },
  {
    id: "bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF::moonshotai_Kimi-Linear-48B-A3B-Instruct-Q8_0/moonshotai_Kimi-Linear-48B-A3B-Instruct-Q8_0-00001-of-00002.gguf",
    label: "Kimi-Linear-48B-A3B Instruct (Q8_0)",
    repo: "bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF",
    file: "moonshotai_Kimi-Linear-48B-A3B-Instruct-Q8_0/moonshotai_Kimi-Linear-48B-A3B-Instruct-Q8_0-00001-of-00002.gguf",
    approxSizeMB: 52200,
    tier: "max",
    contextWindow: 1048576,
    supportsTools: true,
    quant: "Q8_0",
  },
  {
    id: "second-state/Mixtral-8x7B-Instruct-v0.1-GGUF::Mixtral-8x7B-Instruct-v0.1-Q5_K_M.gguf",
    label: "Mixtral 8x7B Instruct (Q5_K_M)",
    repo: "second-state/Mixtral-8x7B-Instruct-v0.1-GGUF",
    file: "Mixtral-8x7B-Instruct-v0.1-Q5_K_M.gguf",
    approxSizeMB: 31700,
    tier: "max",
    contextWindow: 32768,
    supportsTools: true,
    quant: "Q5_K_M",
  },
  {
    id: "unsloth/Nemotron-3-Nano-30B-A3B-GGUF::Nemotron-3-Nano-30B-A3B-Q6_K.gguf",
    label: "Nemotron-3-Nano-30B-A3B (Q6_K)",
    repo: "unsloth/Nemotron-3-Nano-30B-A3B-GGUF",
    file: "Nemotron-3-Nano-30B-A3B-Q6_K.gguf",
    approxSizeMB: 32000,
    tier: "max",
    contextWindow: 262144,
    supportsTools: true,
    quant: "Q6_K",
  },
  {
    id: "DhruvalLabs/QwQ-32B-GGUF::QwQ-32B-Q8_0.gguf",
    label: "QwQ-32B (Q8_0)",
    repo: "DhruvalLabs/QwQ-32B-GGUF",
    file: "QwQ-32B-Q8_0.gguf",
    approxSizeMB: 33200,
    tier: "max",
    contextWindow: 32768,
    supportsTools: true,
    quant: "Q8_0",
  },
  {
    id: "unsloth/Qwen3-32B-GGUF::Qwen3-32B-Q8_0.gguf",
    label: "Qwen3 32B (Q8_0)",
    repo: "unsloth/Qwen3-32B-GGUF",
    file: "Qwen3-32B-Q8_0.gguf",
    approxSizeMB: 34800,
    tier: "max",
    contextWindow: 32768,
    supportsTools: true,
    quant: "Q8_0",
  },
  {
    id: "second-state/Mixtral-8x7B-Instruct-v0.1-GGUF::Mixtral-8x7B-Instruct-v0.1-Q6_K.gguf",
    label: "Mixtral 8x7B Instruct (Q6_K)",
    repo: "second-state/Mixtral-8x7B-Instruct-v0.1-GGUF",
    file: "Mixtral-8x7B-Instruct-v0.1-Q6_K.gguf",
    approxSizeMB: 36600,
    tier: "max",
    contextWindow: 32768,
    supportsTools: true,
    quant: "Q6_K",
  },
  {
    id: "bartowski/Qwen2.5-72B-Instruct-GGUF::Qwen2.5-72B-Instruct-Q3_K_M.gguf",
    label: "Qwen2.5 72B Instruct (Q3_K_M)",
    repo: "bartowski/Qwen2.5-72B-Instruct-GGUF",
    file: "Qwen2.5-72B-Instruct-Q3_K_M.gguf",
    approxSizeMB: 36000,
    tier: "max",
    contextWindow: 32768,
    supportsTools: true,
    quant: "Q3_K_M",
  },
  {
    id: "mradermacher/Kimi-Dev-72B-GGUF::Kimi-Dev-72B.Q4_K_M.gguf",
    label: "Kimi-Dev-72B (Q4_K_M)",
    repo: "mradermacher/Kimi-Dev-72B-GGUF",
    file: "Kimi-Dev-72B.Q4_K_M.gguf",
    approxSizeMB: 45200,
    tier: "max",
    contextWindow: 131072,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/Llama-3.3-70B-Instruct-GGUF::Llama-3.3-70B-Instruct-Q4_K_M.gguf",
    label: "Llama 3.3 70B Instruct (Q4_K_M)",
    repo: "unsloth/Llama-3.3-70B-Instruct-GGUF",
    file: "Llama-3.3-70B-Instruct-Q4_K_M.gguf",
    approxSizeMB: 42500,
    tier: "max",
    contextWindow: 131072,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/Llama-3.3-70B-Instruct-GGUF::Llama-3.3-70B-Instruct-Q8_0/Llama-3.3-70B-Instruct-Q8_0-00001-of-00002.gguf",
    label: "Llama 3.3 70B Instruct (Q8_0)",
    repo: "unsloth/Llama-3.3-70B-Instruct-GGUF",
    file: "Llama-3.3-70B-Instruct-Q8_0/Llama-3.3-70B-Instruct-Q8_0-00001-of-00002.gguf",
    approxSizeMB: 75000,
    tier: "max",
    contextWindow: 131072,
    supportsTools: true,
    quant: "Q8_0",
  },
  {
    id: "bartowski/Qwen2.5-72B-Instruct-GGUF::Qwen2.5-72B-Instruct-Q4_K_M.gguf",
    label: "Qwen2.5 72B Instruct (Q4_K_M)",
    repo: "bartowski/Qwen2.5-72B-Instruct-GGUF",
    file: "Qwen2.5-72B-Instruct-Q4_K_M.gguf",
    approxSizeMB: 45200,
    tier: "max",
    contextWindow: 32768,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "second-state/Mixtral-8x7B-Instruct-v0.1-GGUF::Mixtral-8x7B-Instruct-v0.1-Q8_0.gguf",
    label: "Mixtral 8x7B Instruct (Q8_0)",
    repo: "second-state/Mixtral-8x7B-Instruct-v0.1-GGUF",
    file: "Mixtral-8x7B-Instruct-v0.1-Q8_0.gguf",
    approxSizeMB: 47300,
    tier: "max",
    contextWindow: 32768,
    supportsTools: true,
    quant: "Q8_0",
  },
  // Gemma 4 12B — text GGUF only (no mmproj in ggml-org). E2B/E4B/26B/31B are VLMs below.
  {
    id: "ggml-org/gemma-4-12B-it-GGUF::gemma-4-12B-it-Q4_0.gguf",
    label: "Gemma 4 12B Instruct (Q4_0)",
    repo: "ggml-org/gemma-4-12B-it-GGUF",
    file: "gemma-4-12B-it-Q4_0.gguf",
    approxSizeMB: 6890,
    tier: "max",
    contextWindow: 262144,
    supportsTools: true,
    quant: "Q4_0",
  },
  // Google MedGemma — medical Gemma 3 (Health AI Developer Foundations license).
  {
    id: "unsloth/medgemma-1.5-4b-it-GGUF::medgemma-1.5-4b-it-Q4_K_M.gguf",
    label: "MedGemma 1.5 4B Instruct (Q4_K_M)",
    repo: "unsloth/medgemma-1.5-4b-it-GGUF",
    file: "medgemma-1.5-4b-it-Q4_K_M.gguf",
    mmprojFile: "mmproj-F16.gguf",
    approxSizeMB: 3340,
    tier: "default",
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/medgemma-4b-it-GGUF::medgemma-4b-it-Q4_K_M.gguf",
    label: "MedGemma 4B Instruct (Q4_K_M)",
    repo: "unsloth/medgemma-4b-it-GGUF",
    file: "medgemma-4b-it-Q4_K_M.gguf",
    mmprojFile: "mmproj-F16.gguf",
    approxSizeMB: 3340,
    tier: "default",
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/medgemma-4b-it-GGUF::medgemma-4b-it-Q8_0.gguf",
    label: "MedGemma 4B Instruct (Q8_0)",
    repo: "unsloth/medgemma-4b-it-GGUF",
    file: "medgemma-4b-it-Q8_0.gguf",
    mmprojFile: "mmproj-F16.gguf",
    approxSizeMB: 4980,
    tier: "default",
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q8_0",
  },
  {
    id: "unsloth/medgemma-27b-text-it-GGUF::medgemma-27b-text-it-Q4_K_M.gguf",
    label: "MedGemma 27B Text Instruct (Q4_K_M)",
    repo: "unsloth/medgemma-27b-text-it-GGUF",
    file: "medgemma-27b-text-it-Q4_K_M.gguf",
    approxSizeMB: 16500,
    tier: "max",
    contextWindow: 131072,
    supportsTools: true,
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/medgemma-27b-text-it-GGUF::medgemma-27b-text-it-Q8_0.gguf",
    label: "MedGemma 27B Text Instruct (Q8_0)",
    repo: "unsloth/medgemma-27b-text-it-GGUF",
    file: "medgemma-27b-text-it-Q8_0.gguf",
    approxSizeMB: 28700,
    tier: "max",
    contextWindow: 131072,
    supportsTools: true,
    quant: "Q8_0",
  },
  {
    id: "unsloth/medgemma-27b-it-GGUF::medgemma-27b-it-Q4_K_M.gguf",
    label: "MedGemma 27B Instruct (Q4_K_M)",
    repo: "unsloth/medgemma-27b-it-GGUF",
    file: "medgemma-27b-it-Q4_K_M.gguf",
    mmprojFile: "mmproj-F16.gguf",
    approxSizeMB: 17400,
    tier: "max",
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q4_K_M",
  },
  {
    id: "unsloth/medgemma-27b-it-GGUF::medgemma-27b-it-Q8_0.gguf",
    label: "MedGemma 27B Instruct (Q8_0)",
    repo: "unsloth/medgemma-27b-it-GGUF",
    file: "medgemma-27b-it-Q8_0.gguf",
    mmprojFile: "mmproj-F16.gguf",
    approxSizeMB: 29600,
    tier: "max",
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q8_0",
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
    contextWindow: 128000,
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
    contextWindow: 32768,
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
    contextWindow: 32768,
    supportsTools: false,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q4_K_M",
  },
  // Moonshot Kimi-VL — 16B-A3B thinking VLM. Size includes mmproj-Q8_0.
  {
    id: "ggml-org/Kimi-VL-A3B-Thinking-2506-GGUF::Kimi-VL-A3B-Thinking-2506-Q4_K_M.gguf",
    label: "Kimi-VL-A3B Thinking 2506 (Q4_K_M)",
    repo: "ggml-org/Kimi-VL-A3B-Thinking-2506-GGUF",
    file: "Kimi-VL-A3B-Thinking-2506-Q4_K_M.gguf",
    mmprojFile: "mmproj-Kimi-VL-A3B-Thinking-2506-Q8_0.gguf",
    approxSizeMB: 11200,
    tier: "max",
    contextWindow: 131072,
    supportsTools: false,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q4_K_M",
  },
  {
    id: "ggml-org/Kimi-VL-A3B-Thinking-2506-GGUF::Kimi-VL-A3B-Thinking-2506-Q8_0.gguf",
    label: "Kimi-VL-A3B Thinking 2506 (Q8_0)",
    repo: "ggml-org/Kimi-VL-A3B-Thinking-2506-GGUF",
    file: "Kimi-VL-A3B-Thinking-2506-Q8_0.gguf",
    mmprojFile: "mmproj-Kimi-VL-A3B-Thinking-2506-Q8_0.gguf",
    approxSizeMB: 17600,
    tier: "max",
    contextWindow: 131072,
    supportsTools: false,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "Q8_0",
  },
  // NVIDIA Nemotron-3 Nano Omni — multimodal reasoning MoE. Size includes mmproj-F16.
  {
    id: "unsloth/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-GGUF::NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_M.gguf",
    label: "Nemotron-3-Nano-Omni-30B-A3B Reasoning (UD-Q4_K_M)",
    repo: "unsloth/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-GGUF",
    file: "NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_M.gguf",
    mmprojFile: "mmproj-F16.gguf",
    approxSizeMB: 25500,
    tier: "max",
    contextWindow: 262144,
    supportsTools: true,
    supportsVision: true,
    inputs: ["text", "image"],
    quant: "UD-Q4_K_M",
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
    contextWindow: 32768,
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
    contextWindow: 128000,
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
    contextWindow: 128000,
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
    contextWindow: 131072,
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
    contextWindow: 262144,
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
    contextWindow: 2048,
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
    contextWindow: 131072,
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
    contextWindow: 262144,
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
    contextWindow: 262144,
    supportsTools: true,
    supportsVision: true,
    supportsAudio: true,
    inputs: ["text", "image", "audio"],
    quant: "Q4_0",
  },
  {
    id: "ggml-org/gemma-4-31B-it-GGUF::gemma-4-31B-it-Q8_0.gguf",
    label: "Gemma 4 31B Instruct (Q8_0)",
    repo: "ggml-org/gemma-4-31B-it-GGUF",
    file: "gemma-4-31B-it-Q8_0.gguf",
    mmprojFile: "mmproj-gemma-4-31B-it-Q8_0.gguf",
    approxSizeMB: 31900,
    tier: "max",
    contextWindow: 262144,
    supportsTools: true,
    supportsVision: true,
    supportsAudio: true,
    inputs: ["text", "image", "audio"],
    quant: "Q8_0",
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

/** Format the model's designed max context for picker/settings labels (not runtime n_ctx). */
export function formatWllamaContextWindowLabel(contextWindow) {
  const n = Number(contextWindow);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? m.toFixed(0) : m.toFixed(m % 1 === 0 ? 0 : 1)}M ctx`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return `${k.toFixed(n >= 10000 ? 0 : 1)}K ctx`;
  }
  return `${n} ctx`;
}

export function formatWllamaRegistryMeta(entry = {}, { sizeLabel } = {}) {
  const parts = [];
  if (entry.tier) parts.push(entry.tier);
  if (entry.contextWindow) {
    parts.push(formatWllamaContextWindowLabel(entry.contextWindow));
  }
  if (entry.approxSizeMB != null && entry.approxSizeMB > 0 && sizeLabel) {
    parts.push(sizeLabel(entry.approxSizeMB));
  }
  if (entry.supportsTools) parts.push("tools");
  parts.push(formatWllamaIoLabel(entry));
  return parts.filter(Boolean).join(" · ");
}

/** @typedef {"catalog"|"size-desc"|"size-asc"|"family"} WllamaModelSortMode */

export const WLLAMA_MODEL_SORT_MODES = [
  { id: "catalog", label: "Catalog order" },
  { id: "size-desc", label: "Size: largest → smallest" },
  { id: "size-asc", label: "Size: smallest → largest" },
  { id: "family", label: "Group by family" },
];

export const DEFAULT_WLLAMA_MODEL_SORT = "catalog";

const WLLAMA_FAMILY_ORDER = [
  "llama",
  "qwen",
  "kimi",
  "gemma",
  "medgemma",
  "glm",
  "gpt-oss",
  "nemotron",
  "mistral",
  "internvl",
  "liquid",
  "smolvlm",
  "holo",
  "moondream",
  "other",
];

const WLLAMA_FAMILY_LABELS = {
  llama: "Llama",
  qwen: "Qwen",
  kimi: "Kimi / Moonshot",
  gemma: "Gemma",
  medgemma: "MedGemma",
  glm: "GLM",
  "gpt-oss": "gpt-oss",
  nemotron: "Nemotron",
  mistral: "Mistral / Mixtral",
  internvl: "InternVL",
  liquid: "Liquid",
  smolvlm: "SmolVLM",
  holo: "Holo",
  moondream: "Moondream",
  other: "Other",
};

/** Infer model family from label / repo / id for grouping. */
export function inferWllamaModelFamily(entry = {}) {
  const hay = `${entry.label || ""} ${entry.repo || ""} ${entry.id || ""}`.toLowerCase();
  if (/medgemma/.test(hay)) return "medgemma";
  if (/kimi|moonshot|moonlight/.test(hay)) return "kimi";
  if (/llama/.test(hay)) return "llama";
  if (/qwen|qwq/.test(hay)) return "qwen";
  if (/gemma/.test(hay)) return "gemma";
  if (/\bglm\b/.test(hay)) return "glm";
  if (/gpt-oss|gpt_oss/.test(hay)) return "gpt-oss";
  if (/nemotron/.test(hay)) return "nemotron";
  if (/mixtral|mistral/.test(hay)) return "mistral";
  if (/internvl/.test(hay)) return "internvl";
  if (/\blfm\b|liquid/.test(hay)) return "liquid";
  if (/smolvlm/.test(hay)) return "smolvlm";
  if (/holo2|holo-/.test(hay)) return "holo";
  if (/moondream/.test(hay)) return "moondream";
  return "other";
}

export function formatWllamaFamilyLabel(familyId) {
  return WLLAMA_FAMILY_LABELS[familyId] || familyId || "Other";
}

function sizeOf(entry) {
  const n = Number(entry?.approxSizeMB);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function compareByLabel(a, b) {
  return String(a.label || a.id || "").localeCompare(String(b.label || b.id || ""), undefined, {
    sensitivity: "base",
  });
}

/**
 * Sort a wllama registry list. Returns a new array.
 * @param {object[]} models
 * @param {WllamaModelSortMode} [mode]
 */
export function sortWllamaModels(models, mode = DEFAULT_WLLAMA_MODEL_SORT) {
  const list = Array.isArray(models) ? models.slice() : [];
  if (mode === "size-desc") {
    return list.sort((a, b) => sizeOf(b) - sizeOf(a) || compareByLabel(a, b));
  }
  if (mode === "size-asc") {
    return list.sort((a, b) => sizeOf(a) - sizeOf(b) || compareByLabel(a, b));
  }
  if (mode === "family") {
    const familyRank = new Map(WLLAMA_FAMILY_ORDER.map((id, i) => [id, i]));
    return list.sort((a, b) => {
      const fa = inferWllamaModelFamily(a);
      const fb = inferWllamaModelFamily(b);
      const ra = familyRank.has(fa) ? familyRank.get(fa) : familyRank.get("other");
      const rb = familyRank.has(fb) ? familyRank.get(fb) : familyRank.get("other");
      if (ra !== rb) return ra - rb;
      return sizeOf(b) - sizeOf(a) || compareByLabel(a, b);
    });
  }
  return list;
}

/**
 * Group sorted models into family sections (for family sort mode UI).
 * @param {object[]} models already sorted (preferably with mode "family")
 */
export function groupWllamaModelsByFamily(models) {
  const groups = [];
  let current = null;
  for (const m of models || []) {
    const family = inferWllamaModelFamily(m);
    if (!current || current.family !== family) {
      current = { family, label: formatWllamaFamilyLabel(family), models: [] };
      groups.push(current);
    }
    current.models.push(m);
  }
  return groups;
}
