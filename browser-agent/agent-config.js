// Shared step-limit config for every ReAct-style loop in the extension
// (browser automation in agent.js, and the Level 1 / Level 2 system editors
// in editor-loop.js). A single source of truth avoids two hardcoded
// MAX_STEPS constants drifting out of sync.

export const DEFAULT_MAX_STEPS = 14;
const MIN_MAX_STEPS = 1;
const MAX_MAX_STEPS = 100;

/** Read the user-configured step limit from global settings, with fallback/clamping. */
export function getMaxSteps(settings) {
  const n = Number(settings?.maxSteps);
  if (!Number.isFinite(n)) return DEFAULT_MAX_STEPS;
  return Math.min(MAX_MAX_STEPS, Math.max(MIN_MAX_STEPS, Math.floor(n)));
}
