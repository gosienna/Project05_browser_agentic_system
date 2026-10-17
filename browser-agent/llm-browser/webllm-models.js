/** WebLLM model metadata helpers for model pickers and labels. */

import { isQwen3ThinkingModel } from "../reasoning-content.js";
import { isWllamaToolModel } from "./wllama-models.js";

/**
 * Chat models shown for the WebLLM provider (prebuilt catalog of @mlc-ai/web-llm 0.2.86).
 * Newest line in each series, one quant per size (q4f16_1, or q3 when that is the only
 * build), at most four, smallest → largest by VRAM, and nothing above 80 GB.
 *
 * MedGemma is not in the WebLLM wasm catalog. Qwen3-32B and Qwen3-30B-A3B weights
 * exist on huggingface.co/mlc-ai but have no prebuilt WebGPU library, so they cannot load.
 */
export const WEBLLM_MAX_VRAM_MB = 80 * 1024;

export const WEBLLM_CURATED_MODEL_IDS = [
  // DeepSeek — R1 distills are the only line shipped (2).
  "DeepSeek-R1-Distill-Llama-8B-q4f16_1-MLC",
  "DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC",
  // Gemma — Gemma 3 1B and Gemma 4 E2B are the current-generation builds.
  "gemma3-1b-it-q4f16_1-MLC",
  "gemma-4-E2B-it-q4f16_1-MLC",
  // Qwen 3.5 — four sizes, 0.8B through 9B.
  "Qwen3.5-0.8B-q4f16_1-MLC",
  "Qwen3.5-2B-q4f16_1-MLC",
  "Qwen3.5-4B-q4f16_1-MLC",
  "Qwen3.5-9B-q4f16_1-MLC",
  // Llama 3.x — 1B, 3B, 8B, 70B (70B is q3, ~30 GB).
  "Llama-3.2-1B-Instruct-q4f16_1-MLC",
  "Llama-3.2-3B-Instruct-q4f16_1-MLC",
  "Llama-3.1-8B-Instruct-q4f16_1-MLC",
  "Llama-3.1-70B-Instruct-q3f16_1-MLC",
  // Phi — Phi-4 mini (newest text) and Phi-3.5 vision (only VLM).
  "Phi-4-mini-instruct-q4f16_1-MLC",
  "Phi-3.5-vision-instruct-q4f16_1-MLC",
];

/** Hermes models with native OpenAI-style `tools` support in WebLLM. */
export const WEBLLM_FUNCTION_CALLING_MODEL_IDS = [
  "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
  "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
  "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
];

const toolModelIds = new Set(WEBLLM_FUNCTION_CALLING_MODEL_IDS);

export function isWebllmVisionModel(modelId) {
  return /vision|llava|VL-|Pixtral/i.test(modelId || "");
}

export function isWebllmThinkingModel(modelId) {
  if (isQwen3ThinkingModel(modelId)) return true;
  return /DeepSeek-R1|Reasoning/i.test(modelId || "");
}

export function isWebllmToolModel(modelId) {
  return toolModelIds.has(modelId);
}

/** Whether chat.completions should include OpenAI-style `tools` for this provider/model. */
export function supportsNativeChatTools(settings, modelId) {
  const provider = settings?.provider || "onnx";
  if (provider === "onnx") return false;
  if (provider === "webllm") {
    const id = modelId || settings?.webllmModel || "";
    return isWebllmToolModel(id);
  }
  if (provider === "wllama") {
    const id = modelId || settings?.wllamaModel || "";
    return isWllamaToolModel(id);
  }
  return true;
}

/** Drop `tools` when the active provider/model cannot use native function calling. */
export function stripUnsupportedNativeTools(request, settings) {
  if (!request?.tools?.length) return request;
  const provider = settings?.provider || "onnx";
  const modelId =
    request.model ||
    (provider === "webllm"
      ? settings?.webllmModel
      : provider === "wllama"
        ? settings?.wllamaModel
        : provider === "onnx"
          ? settings?.onnxModel
          : settings?.model);
  if (supportsNativeChatTools(settings, modelId)) return request;
  const { tools: _tools, ...rest } = request;
  return rest;
}

/** Human-readable input → output summary. */
export function formatWebllmIoLabel(entry = {}) {
  const modelId = entry.id || entry.model_id || "";
  const inputs = ["text"];
  if (entry.supportsVision || isWebllmVisionModel(modelId)) inputs.push("image");
  return `${inputs.join("+")}→text`;
}

/** Quant / tier / thinking / tools summary. */
export function formatWebllmTypeLabel(entry = {}) {
  const modelId = entry.id || entry.model_id || "";
  const parts = [];
  if (entry.quant) parts.push(entry.quant);
  else if (entry.tier) parts.push(entry.tier);
  if (entry.supportsThinking ?? isWebllmThinkingModel(modelId)) parts.push("thinking");
  if (entry.supportsTools ?? isWebllmToolModel(modelId)) parts.push("tools");
  return parts.join(" · ") || "chat";
}

/** Full dropdown label: `name (type · io)`. */
export function formatWebllmPickerLabel(entry = {}) {
  const name = entry.label || entry.id || "model";
  const type = formatWebllmTypeLabel(entry);
  const io = formatWebllmIoLabel(entry);
  return `${name} (${type} · ${io})`;
}

/** Settings registry secondary line: size, ctx, capabilities, I/O. */
export function formatWebllmRegistryMeta(entry = {}, { sizeLabel } = {}) {
  const modelId = entry.id || entry.model_id || "";
  const parts = [];
  if (entry.tier) parts.push(entry.tier);
  if (entry.contextWindow) {
    const ctx =
      entry.contextWindow >= 1000
        ? `${(entry.contextWindow / 1000).toFixed(entry.contextWindow >= 10000 ? 0 : 1)}K ctx`
        : `${entry.contextWindow} ctx`;
    parts.push(ctx);
  }
  if (entry.approxSizeMB != null && sizeLabel) parts.push(sizeLabel(entry.approxSizeMB));
  if (entry.supportsThinking ?? isWebllmThinkingModel(modelId)) parts.push("thinking");
  if (entry.supportsTools ?? isWebllmToolModel(modelId)) parts.push("tools");
  parts.push(formatWebllmIoLabel(entry));
  return parts.filter(Boolean).join(" · ");
}

/** Enrich a registry row with capability flags for UI and relay consumers. */
export function enrichWebllmRegistryEntry(entry, { functionCallingModelIds } = {}) {
  if (!entry?.id) return entry;
  const toolIds = functionCallingModelIds?.length
    ? new Set(functionCallingModelIds)
    : toolModelIds;
  return {
    ...entry,
    supportsThinking: isWebllmThinkingModel(entry.id),
    supportsTools: toolIds.has(entry.id),
    supportsVision: isWebllmVisionModel(entry.id),
    io: formatWebllmIoLabel(entry),
  };
}
