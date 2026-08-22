// Curated NVIDIA NIM chat models (integrate.api.nvidia.com/v1).

export const DEFAULT_NVIDIA_NIM_MODEL = "z-ai/glm-5.2";

/** @type {Array<{id:string, label:string}>} */
export const NVIDIA_NIM_MODELS = [
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
  { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra 550B" },
  { id: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1", label: "Nemotron Nano VL 8B (vision)" },
  { id: "nvidia/nemotron-3-nano-30b-a3b", label: "Nemotron 3 Nano 30B" },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", label: "Nemotron 3 Nano Omni 30B (reasoning)" },
  { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct" },
  { id: "meta/llama-3.1-8b-instruct", label: "Llama 3.1 8B Instruct" },
  { id: "minimaxai/minimax-m3", label: "MiniMax M3" },
  { id: "z-ai/glm-5.2", label: "GLM 5.2" },
  { id: "qwen/qwen3-next-80b-a3b-instruct", label: "Qwen3 Next 80B Instruct" },
  { id: "google/gemma-4-31b-it", label: "Gemma 4 31B IT" },
  { id: "mistralai/mistral-nemotron", label: "Mistral Nemotron" },
];

export function listNvidiaNimModels() {
  return NVIDIA_NIM_MODELS;
}

export function findNvidiaNimModel(modelId) {
  return NVIDIA_NIM_MODELS.find((m) => m.id === modelId);
}

export function nvidiaNimModelLabel(modelId) {
  return findNvidiaNimModel(modelId)?.label || modelId?.split("/").pop() || modelId;
}
