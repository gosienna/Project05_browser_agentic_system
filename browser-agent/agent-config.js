// Shared step-limit config for every ReAct-style loop in the extension
// (browser automation in agent.js, and the system editor in editor-loop.js).
// A single source of truth avoids two hardcoded MAX_STEPS constants drifting
// out of sync.

export const DEFAULT_MAX_STEPS = 14;
const MIN_MAX_STEPS = 1;
const MAX_MAX_STEPS = 100;

export const DEFAULT_MAX_TOKENS = 1024;
const MIN_MAX_TOKENS = 64;
const MAX_MAX_TOKENS = 131072;

export const DEFAULT_DIALOGUE_MAX_TOOL_ROUNDS = 5;
const MIN_DIALOGUE_MAX_TOOL_ROUNDS = 1;
const MAX_DIALOGUE_MAX_TOOL_ROUNDS = 30;

/** Read the user-configured step limit from global settings, with fallback/clamping. */
export function getMaxSteps(settings) {
  const n = Number(settings?.maxSteps);
  if (!Number.isFinite(n)) return DEFAULT_MAX_STEPS;
  return Math.min(MAX_MAX_STEPS, Math.max(MIN_MAX_STEPS, Math.floor(n)));
}

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

/** Read the user-configured Dialogue tool-loop limit, with fallback/clamping. */
export function getDialogueMaxToolRounds(settings) {
  const n = Number(settings?.dialogueMaxToolRounds);
  if (!Number.isFinite(n)) return DEFAULT_DIALOGUE_MAX_TOOL_ROUNDS;
  return Math.min(
    MAX_DIALOGUE_MAX_TOOL_ROUNDS,
    Math.max(MIN_DIALOGUE_MAX_TOOL_ROUNDS, Math.floor(n))
  );
}
