/** WebLLM model metadata helpers for model pickers and labels. */

import { isQwen3ThinkingModel } from "./reasoning-content.js";

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
