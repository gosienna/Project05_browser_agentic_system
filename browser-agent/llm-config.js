// Shared LLM inference limits (max tokens, wllama n_ctx) — used by all providers/modes.

export const DEFAULT_MAX_TOKENS = 1024;
const MIN_MAX_TOKENS = 64;
const MAX_MAX_TOKENS = 131072;

/** llama.cpp n_ctx for wllama (KV cache allocated at load). */
export const DEFAULT_WLLAMA_CONTEXT_LIMIT = 16384;
export const MIN_WLLAMA_CONTEXT_LIMIT = 1024;
export const MAX_WLLAMA_CONTEXT_LIMIT = 131072;

/** Clamp a numeric max-tokens value to the allowed range. */
export function resolveMaxTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.floor(n)));
}

/** Read max generated tokens per LLM reply from user settings, with fallback/clamping. */
export function getMaxTokens(settings) {
  return resolveMaxTokens(settings?.maxTokens);
}

/** Clamp wllama n_ctx to the allowed range. */
export function resolveWllamaContextLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WLLAMA_CONTEXT_LIMIT;
  return Math.min(MAX_WLLAMA_CONTEXT_LIMIT, Math.max(MIN_WLLAMA_CONTEXT_LIMIT, Math.floor(n)));
}

/** Read llama.cpp n_ctx for wllama from settings (default 16K). */
export function getWllamaContextLimit(settings) {
  return resolveWllamaContextLimit(settings?.wllamaContextLimit);
}
