// Shared step-limit config for every ReAct-style loop in the extension
// (browser automation in agent.js, and the Level 1 / Level 2 system editors
// in editor-loop.js). A single source of truth avoids two hardcoded
// MAX_STEPS constants drifting out of sync.

export const DEFAULT_MAX_STEPS = 14;
const MIN_MAX_STEPS = 1;
const MAX_MAX_STEPS = 100;

export const DEFAULT_MAX_TOKENS = 1024;
const MIN_MAX_TOKENS = 64;
const MAX_MAX_TOKENS = 131072;

/** Read the user-configured step limit from global settings, with fallback/clamping. */
export function getMaxSteps(settings) {
  const n = Number(settings?.maxSteps);
  if (!Number.isFinite(n)) return DEFAULT_MAX_STEPS;
  return Math.min(MAX_MAX_STEPS, Math.max(MIN_MAX_STEPS, Math.floor(n)));
}

/** Read max generated tokens per LLM reply, with fallback/clamping. */
export function getMaxTokens(settings) {
  const n = Number(settings?.maxTokens);
  if (!Number.isFinite(n)) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.floor(n)));
}
